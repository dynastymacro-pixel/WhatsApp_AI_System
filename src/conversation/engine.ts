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
} from '../db/repositories';
import { ClientRepository } from '../db/repositories/ClientRepository';
import { aiClient, AICompletionRequest, AIMessage } from '../lib/ai/client';
import { applyNegotiationGuardrail } from './negotiationGuardrail';
import { buildSystemPrompt, CONVERSATION_HISTORY_LIMIT } from './constants';
import { Product, Conversation, ConversationMessage } from '../db/types';
import { config } from '../config';
import { logger } from '../utils/logger';

// Singletons — one DB client for the engine
const supabase         = getSupabaseClient();
const convRepo         = new ConversationRepository(supabase);
const convMsgRepo      = new ConversationMessageRepository(supabase);
const productRepo      = new ProductRepository(supabase);
const clientRepo       = new ClientRepository(supabase);

export interface EngineResult {
  replyText: string;
  conversationId: string;
}

/**
 * Process one inbound text message through the full AI conversation pipeline.
 * Returns the reply text to be sent back to the customer via BullMQ.
 */
export async function processMessage(
  clientId: string,
  customerId: string,
  inboundText: string,
): Promise<EngineResult> {

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
  const roundsUsed     = conversation.negotiation_rounds;
  const isHoldingFirm  = roundsUsed >= config.maxNegotiationRounds;

  // ── 6. Build system prompt ────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(businessName, products, isHoldingFirm);

  const aiRequest: AICompletionRequest = {
    systemPrompt,
    messages: aiMessages,
    clientId,
  };

  // ── 7. Call the AI ────────────────────────────────────────────────────────
  const aiResponse = await aiClient.complete(aiRequest);

  // ── 8. Resolve the product being discussed ───────────────────────────────
  // Prefer the product the AI identified; fall back to the conversation's
  // tracked product; otherwise null.
  let activeProduct: Product | null = null;
  const productId = aiResponse.reply.productId ?? conversation.current_product_id;
  if (productId) {
    activeProduct = await productRepo.getById(clientId, productId);
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
  const isPriceNegotiation =
    finalReply.intent === 'price_negotiation' ||
    finalReply.offeredPrice !== undefined;

  await convRepo.update(clientId, conversation.id, {
    status: isPriceNegotiation ? 'negotiating' : conversation.status,
    ...(finalReply.productId && { current_product_id: finalReply.productId }),
    ...(isPriceNegotiation && {
      negotiation_rounds: roundsUsed + 1,
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
