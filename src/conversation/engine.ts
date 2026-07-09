// src/conversation/engine.ts
// ─────────────────────────────────────────────────────────────────────────────
// Conversation Engine — orchestrates the full AI reply pipeline.
//
// Flow for each inbound text message:
//   1. Load or create conversation for this customer
//   2. Append customer message to conversation_messages
//   3. Load recent history + full product catalog
//   4. Build system prompt (with negotiation state)
//   5. Call IAIClient.complete()
//   6. Apply negotiation guardrail (code-level price enforcement)
//   7. Update conversation state (status, rounds, current_offer, product focus)
//   8. Append AI reply to conversation_messages
//   9. Return the final reply text for the caller to enqueue
// ─────────────────────────────────────────────────────────────────────────────

import { getSupabaseClient } from '../db/supabase';
import {
  ConversationRepository,
  ConversationMessageRepository,
  ProductRepository,
  OrderRepository,
} from '../db/repositories';
import { ClientRepository } from '../db/repositories/ClientRepository';
import { aiClient, AICompletionRequest, AIMessage } from '../lib/ai/client';
import { applyNegotiationGuardrail } from './negotiationGuardrail';
import { buildSystemPrompt, CONVERSATION_HISTORY_LIMIT } from './constants';
import { Product, Conversation, ConversationMessage } from '../db/types';
import { notifyAdmin, TIER_CONVERSATION_LIMITS } from '../services/notificationService';
import { config } from '../config';
import { logger } from '../utils/logger';

// Singletons — one DB client for the engine
const supabase         = getSupabaseClient();
const convRepo         = new ConversationRepository(supabase);
const convMsgRepo      = new ConversationMessageRepository(supabase);
const productRepo      = new ProductRepository(supabase);
const clientRepo       = new ClientRepository(supabase);
const orderRepo        = new OrderRepository(supabase);

export interface EngineResult {
  replyText: string;
  conversationId: string;
}

/**
 * Process one inbound text message through the full AI conversation pipeline.
 * Returns the reply text to be sent back to the customer via BullMQ.
 *
 * @param customerPhone  Optional E.164 phone number (msg.from from messageRouter).
 *                       Threaded through to avoid a redundant DB lookup inside
 *                       notifyAdmin() when firing the order_created alert.
 */
export async function processMessage(
  clientId:      string,
  customerId:    string,
  inboundText:   string,
  customerPhone?: string,
): Promise<EngineResult> {

  // ── 1. Quota check: only consume conversation quota on NEW conversations ────
  const activeConversation = await convRepo.findActive(clientId, customerId);
  if (!activeConversation) {
    const { data: client, error: clientErr } = await supabase
      .from('clients')
      .select('notification_tier, conversation_quota_used, conversation_quota_reset_at')
      .eq('id', clientId)
      .single();

    if (clientErr || !client) {
      logger.warn({ clientId, err: clientErr?.message },
        '[Engine] Could not fetch client for conversation quota check — processing message anyway');
    } else {
      const tier = client.notification_tier || 'free';
      const quotaLimit = TIER_CONVERSATION_LIMITS[tier] ?? TIER_CONVERSATION_LIMITS.free;

      // ── Auto-Reset Logic for Conversation Quota ──
      const now = new Date();
      const resetAt = client.conversation_quota_reset_at ? new Date(client.conversation_quota_reset_at) : null;
      let currentUsed = client.conversation_quota_used;

      if (!resetAt || resetAt < now) {
        const nextReset = new Date();
        nextReset.setMonth(nextReset.getMonth() + 1); // 1 month rolling reset

        const { error: resetErr } = await supabase
          .from('clients')
          .update({
            conversation_quota_used: 0,
            conversation_quota_reset_at: nextReset.toISOString(),
          })
          .eq('id', clientId);

        if (!resetErr) {
          currentUsed = 0;
        } else {
          logger.error({ clientId, err: resetErr.message }, '[Engine] Failed to reset conversation quota');
        }
      }

      // ── Atomic Quota Check & Increment ──
      // This update will only modify the row if conversation_quota_used is strictly less than quotaLimit.
      // This is 100% atomic at the database transaction layer.
      const { data: updatedClients, error: updateErr } = await supabase
        .from('clients')
        .update({ conversation_quota_used: currentUsed + 1 })
        .eq('id', clientId)
        .lt('conversation_quota_used', quotaLimit)
        .select('conversation_quota_used');

      if (updateErr || !updatedClients || updatedClients.length === 0) {
        logger.warn({ clientId, used: currentUsed, limit: quotaLimit, tier },
          '[Engine] Conversation quota exceeded — blocking new chat');

        // Fetch customer to see if we should send a capacity message (only once per 24 hours)
        const { data: customer } = await supabase
          .from('customers')
          .select('quota_block_notified_at')
          .eq('id', customerId)
          .single();

        const notifiedAt = customer?.quota_block_notified_at ? new Date(customer.quota_block_notified_at) : null;
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const capacityNotice = "We're currently at capacity and unable to start new automated assistant chats. Please contact support or try again later.";

        if (!notifiedAt || notifiedAt < oneDayAgo) {
          await supabase
            .from('customers')
            .update({ quota_block_notified_at: now.toISOString() })
            .eq('id', customerId);

          return {
            replyText: capacityNotice,
            conversationId: 'quota_blocked',
          };
        } else {
          // Silent block (returns empty replyText, telling router to do nothing)
          return {
            replyText: '',
            conversationId: 'quota_blocked_silent',
          };
        }
      }
    }
  }

  // ── 1. Load or create conversation ───────────────────────────────────────
  const conversation: Conversation = await convRepo.findOrCreate(clientId, customerId);

  // ── 2. Append customer message to history ────────────────────────────────
  await convMsgRepo.append(clientId, conversation.id, 'customer', inboundText);

  // ── 3. Load history + products + business name ───────────────────────────
  const [history, products, client] = await Promise.all([
    convMsgRepo.getHistory(clientId, conversation.id, CONVERSATION_HISTORY_LIMIT),
    productRepo.getAvailable(clientId),
    clientRepo.findById(clientId),
  ]);

  const businessName = client?.business_name ?? 'Our Store';

  // ── 4. Build AI message array from history ────────────────────────────────
  // Map conversation_messages roles to IAIClient roles:
  //   customer → user | ai → assistant | system → skipped (it's in the system prompt)
  const aiMessages: AIMessage[] = history
    .filter((m: ConversationMessage) => m.role !== 'system')
    .map((m: ConversationMessage) => ({
      role: m.role === 'customer' ? 'user' : 'assistant',
      content: m.content,
    }));

  // Guard: ensure there's at least one message (the one we just appended)
  if (aiMessages.length === 0) {
    aiMessages.push({ role: 'user', content: inboundText });
  }

  // ── 5. Determine negotiation state ───────────────────────────────────────
  let roundsUsed     = conversation.negotiation_rounds;
  let currentStatus  = conversation.status;

  // Reset Gate 1: Timeout Reset (24 Hours)
  const lastUpdate = new Date(conversation.updated_at).getTime();
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  if (currentStatus === 'awaiting_payment' && lastUpdate < oneDayAgo) {
    logger.info(
      { conversationId: conversation.id, lastUpdate: conversation.updated_at },
      '[Engine] 24h timeout elapsed while awaiting_payment — resetting status to active and negotiation rounds to 0',
    );
    currentStatus = 'active';
    roundsUsed = 0;
  }

  const isHoldingFirm  = roundsUsed >= config.maxNegotiationRounds;

  // ── 6. Build system prompt ────────────────────────────────────────────────
  const hasPaymentDetails = Boolean(client?.payment_details && client.payment_details.trim().length > 0);
  const systemPrompt = buildSystemPrompt(
    businessName,
    products,
    isHoldingFirm,
    hasPaymentDetails,
    client?.custom_instructions ?? null,
  );

  const aiRequest: AICompletionRequest = {
    systemPrompt,
    messages: aiMessages,
    clientId,
  };

  // ── 7. Call the AI ────────────────────────────────────────────────────────
  let aiResponse = await aiClient.complete(aiRequest);

  // ── 7.1. Order History Re-completion (Only when order_status_inquiry fires) ──
  if (aiResponse.reply.intent === 'order_status_inquiry') {
    logger.info(
      { conversationId: conversation.id, customerId },
      '[Engine] order_status_inquiry intent detected — performing DB order lookup and re-completing'
    );
    
    // Fetch actual database orders
    const actualOrders = await orderRepo.findAllByCustomer(clientId, customerId);
    const ordersContext = formatOrdersContext(actualOrders);

    // Re-build system prompt with real order history injected
    const updatedSystemPrompt = buildSystemPrompt(
      businessName,
      products,
      isHoldingFirm,
      hasPaymentDetails,
      client?.custom_instructions ?? null,
      ordersContext
    );

    aiRequest.systemPrompt = updatedSystemPrompt;
    
    // Re-call the LLM with database-backed constraints
    aiResponse = await aiClient.complete(aiRequest);
  }

  // ── 8. Resolve the product being discussed ───────────────────────────────
  // Prefer the product the AI identified; fall back to the conversation's
  // tracked product; otherwise null.
  let activeProduct: Product | null = null;
  const productId = aiResponse.reply.productId ?? conversation.current_product_id;
  if (productId) {
    activeProduct = await productRepo.getById(clientId, productId);
  }

  // Reset Gate 2: Product Change Reset
  // We compute the pre-guardrail price negotiation state so the guardrail in Step 9
  // receives the correct reset round count.
  const isPriceNegotiationPre = aiResponse.reply.intent === 'price_negotiation';

  if (
    productId &&
    conversation.current_product_id &&
    productId !== conversation.current_product_id &&
    (isPriceNegotiationPre || aiResponse.reply.intent === 'order_intent')
  ) {
    logger.info(
      {
        conversationId: conversation.id,
        oldProduct: conversation.current_product_id,
        newProduct: productId,
        intent: aiResponse.reply.intent,
      },
      '[Engine] Product focus changed to purchase/negotiation cycle — resetting status to active and rounds to 0',
    );
    currentStatus = 'active';
    roundsUsed = 0;
  }

  // ── 9. Apply negotiation guardrail ────────────────────────────────────────
  const guardrailResult = await applyNegotiationGuardrail(
    aiResponse,
    activeProduct,
    roundsUsed,
    config.maxNegotiationRounds,
    aiClient,
    aiRequest,
  );

  if (guardrailResult.wasIntercepted) {
    logger.info(
      { reason: guardrailResult.interceptReason, conversationId: conversation.id },
      '[Engine] Guardrail intercepted AI reply',
    );
  }

  const finalReply = guardrailResult.reply;

  // ── 10. Update conversation state ─────────────────────────────────────────
  let nextStatus = currentStatus;
  const isPriceNegotiation = finalReply.intent === 'price_negotiation';

  // Note: payment_confirmation is deliberately excluded from the append and status logic to avoid resending details.
  if (finalReply.intent === 'order_intent') {
    // ── Payment details append: always fires on order_intent ─────────────────
    // Unconditional — the customer sees real payment info every time they ask,
    // even if the conversation is already awaiting_payment (fixes Root Cause A).
    if (client?.payment_details && client.payment_details.trim().length > 0) {
      finalReply.message = `${finalReply.message}\n\n${client.payment_details}`;
    } else {
      logger.warn(
        { clientId, conversationId: conversation.id },
        '[Engine] Client has not configured payment_details. Falling back to default message.',
      );
      finalReply.message = `${finalReply.message}\n\nThank you! Our team will send the payment details shortly.`;
    }

    // ── Status transition: only set if not already awaiting_payment ──────────
    // Avoids a redundant status write when the customer re-expresses intent.
    if (currentStatus !== 'awaiting_payment') {
      nextStatus = 'awaiting_payment';
    }

    // ── Order DB write: always runs on order_intent ───────────────────────────
    // createOrSync() is idempotent — self-corrects via no-op / price-sync /
    // supersede. Running it unconditionally ensures an order row always exists
    // after order_intent, even if the conversation was already awaiting_payment
    // (e.g. stale conversation state, second payment attempt).
    const resolvedProductId = finalReply.productId ?? conversation.current_product_id ?? null;
    const agreedPrice       = finalReply.offeredPrice ?? conversation.current_offer ?? activeProduct?.price;

    if (agreedPrice == null) {
      logger.error(
        {
          clientId,
          conversationId:       conversation.id,
          customerId,
          productId:            resolvedProductId,
          offeredPrice:         finalReply.offeredPrice,
          currentOffer:         conversation.current_offer,
          activeProductPrice:   activeProduct?.price,
        },
        '[Engine] order_intent fired but agreed_price could not be resolved — ' +
        'order row NOT created. Check product price configuration.',
      );
    } else {
      const orderResult = await orderRepo.createOrSync(clientId, {
        customerId,
        conversationId: conversation.id,
        productId:      resolvedProductId,
        agreedPrice,
      });
      logger.info(
        {
          conversationId: conversation.id,
          action:         orderResult.action,
          orderId:        orderResult.order.id,
          agreedPrice,
          productId:      resolvedProductId,
        },
        '[Engine] Order record createOrSync complete',
      );

      // Fire order_created alert only on genuinely new order rows.
      // 'price_synced' and 'no_change' do not re-alert — admin already knows about this order.
      // Fire-and-forget: failure must never surface into the customer reply flow.
      if (
        orderResult.action === 'created' ||
        orderResult.action === 'superseded_and_created'
      ) {
        notifyAdmin('order_created', clientId, {
          orderId:       orderResult.order.id,
          customerPhone: customerPhone ?? undefined,
          productName:   activeProduct?.name ?? null,
          agreedPrice,
        }).catch((err: Error) =>
          logger.error(
            { err: err.message, orderId: orderResult.order.id },
            '[Engine] notifyAdmin order_created unhandled rejection',
          ),
        );
      }
    }
  } else if (isPriceNegotiation) {
    nextStatus = 'negotiating';
  }

  logger.info(
    {
      conversationId: conversation.id,
      intent: finalReply.intent,
      offeredPrice: finalReply.offeredPrice,
      previousStatus: currentStatus,
      nextStatus,
      isPriceNegotiation,
    },
    '[Engine] Conversation status transition',
  );

  await convRepo.update(clientId, conversation.id, {
    status: nextStatus,
    negotiation_rounds: isPriceNegotiation ? (roundsUsed + 1) : roundsUsed,
    ...(finalReply.productId && { current_product_id: finalReply.productId }),
    ...(isPriceNegotiation && {
      current_offer: finalReply.offeredPrice ?? conversation.current_offer,
    }),
  });

  // ── 11. Append AI reply to history ────────────────────────────────────────
  await convMsgRepo.append(clientId, conversation.id, 'ai', finalReply.message);

  logger.info(
    {
      conversationId: conversation.id,
      intent: finalReply.intent,
      rounds: roundsUsed + (isPriceNegotiation ? 1 : 0),
      wasIntercepted: guardrailResult.wasIntercepted,
    },
    '[Engine] Reply generated',
  );

  return {
    replyText: finalReply.message,
    conversationId: conversation.id,
  };
}

/**
 * Formats a list of customer orders for injection into the AI's system prompt.
 * Only outputs factual data retrieved from the database.
 */
function formatOrdersContext(orders: any[]): string {
  if (orders.length === 0) {
    return "The customer has not placed any orders yet.";
  }

  const lines = orders.map((o) => {
    const productName = o.products?.name ?? 'Unknown Product';
    const dateStr = new Date(o.created_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    return `- Product: ${productName} | Price: PKR ${Number(o.agreed_price).toLocaleString()} | Status: ${o.approval_status} | Date: ${dateStr}`;
  });

  return `Here is the customer's actual order history from our database:\n${lines.join('\n')}\n\nIMPORTANT RULE: You must ONLY report or discuss the orders listed above when answering the customer. If a product/order is not in the list, they have NOT ordered it. Do NOT make up any order history or rely on conversation memory/context to infer what they bought. Keep your answer brief and friendly.`;
}
