// src/router/messageRouter.ts
// Message Router — the single decision point for what happens to each inbound message.
//
// Day 2 behaviour:
//   1. Find or create the customer record (multi-tenant, by phone + clientId)
//   2. Touch their last_seen timestamp
//   3. Log the inbound message to the raw `messages` table (Day 1 — unchanged)
//   4. If the message is text, run it through the AI conversation engine
//   5. Log the AI reply to the raw `messages` table as outbound
//   6. Enqueue the AI reply via BullMQ (same queue as Day 1)
//   7. Non-text messages are logged with a TODO note

import { CustomerRepository } from '../db/repositories/CustomerRepository';
import { MessageRepository } from '../db/repositories/MessageRepository';
import { ConversationRepository } from '../db/repositories/ConversationRepository';
import { ConversationMessageRepository } from '../db/repositories/ConversationMessageRepository';
import { OrderRepository } from '../db/repositories/OrderRepository';
import { getSupabaseClient } from '../db/supabase';
import { enqueueOutgoingMessage } from '../queue/client';
import { InboundMessage } from '../whatsapp/types';
import { processMessage } from '../conversation/engine';
import { notifyAdminOfScreenshot } from '../services/notificationService';
import { logger } from '../utils/logger';

const supabase      = getSupabaseClient();
const customerRepo  = new CustomerRepository(supabase);
const messageRepo   = new MessageRepository(supabase);
const convRepo      = new ConversationRepository(supabase);
const convMsgRepo   = new ConversationMessageRepository(supabase);
const orderRepo     = new OrderRepository(supabase);

export async function routeInboundMessage(
  clientId: string,
  msg: InboundMessage,
): Promise<void> {

  // ── 1. Find or create customer ────────────────────────────────────────────
  const customer = await customerRepo.findOrCreate(clientId, msg.from);

  // ── 2. Touch last_seen ────────────────────────────────────────────────────
  await customerRepo.touchLastSeen(clientId, customer.id);

  // ── 3. Log inbound to raw messages table ─────────────────────────────────
  await messageRepo.logMessage({
    clientId,
    customerId:  customer.id,
    direction:   'inbound',
    contentType: msg.contentType,
    content:     msg.text || `[${msg.contentType}]`,
    waMessageId: msg.waMessageId,
  });

  logger.info(
    { from: msg.from, type: msg.contentType, customerId: customer.id, clientId },
    '[Router] Inbound message logged',
  );

  // ── 4. Route by content type ──────────────────────────────────────────────
  if (msg.contentType === 'image') {
    logger.info(
      { from: msg.from, type: msg.contentType },
      '[Router] Image message received — processing payment screenshot',
    );

    const replyText =
      "Thanks for sending that! We've received your screenshot. Our team will confirm your payment and get back to you shortly with your order details.";

    try {
      // A. Resolve or create active conversation
      const conversation = await convRepo.findOrCreate(clientId, customer.id);

      // B. Stamp screenshot_received_at on the pending order (no-op if no order exists yet)
      const stampedOrder = await orderRepo.markScreenshotReceived(clientId, conversation.id);

      // C. Fire-and-forget Telegram notification — must never block the customer reply.
      // .catch() logs unexpected errors that escape notifyAdminOfScreenshot's own try/catch.
      if (stampedOrder) {
        notifyAdminOfScreenshot(clientId, {
          orderId:              stampedOrder.id,
          customerPhone:        msg.from,
          productId:            stampedOrder.product_id,
          agreedPrice:          stampedOrder.agreed_price,
          screenshotReceivedAt: stampedOrder.screenshot_received_at,
        }).catch((err) => {
          logger.error({ err, clientId, orderId: stampedOrder.id },
            '[Router] notifyAdminOfScreenshot unhandled rejection');
        });
      }

      // D. Append customer image placeholder and AI reply to structured conversation history
      await convMsgRepo.append(clientId, conversation.id, 'customer', '[Customer sent an image]');
      await convMsgRepo.append(clientId, conversation.id, 'ai', replyText);

      // E. Log AI reply to raw messages table
      const outboundWaId = `ai_${Date.now()}_${customer.id.slice(0, 8)}`;
      await messageRepo.logMessage({
        clientId,
        customerId:  customer.id,
        direction:   'outbound',
        contentType: 'text',
        content:     replyText,
        waMessageId: outboundWaId,
      });

      // F. Enqueue AI reply via BullMQ
      await enqueueOutgoingMessage({
        clientId,
        to:                 msg.from,
        text:               replyText,
        customerId:         customer.id,
        replyToWaMessageId: msg.waMessageId,
      });

      logger.info(
        { to: msg.from, conversationId: conversation.id, clientId },
        '[Router] Image acknowledgment reply enqueued',
      );
    } catch (err) {
      const errorDetails = err as Error & { status?: number; statusCode?: number; statusText?: string; code?: string | number };
      logger.error(
        {
          err: errorDetails,
          message: errorDetails.message,
          stack: errorDetails.stack,
          status: errorDetails.status || errorDetails.statusCode,
          statusText: errorDetails.statusText,
          code: errorDetails.code,
          from: msg.from,
          clientId,
          customerId: customer.id
        },
        '[Router] Exception in image handler — sending fallback receipt reply',
      );

      const fallbackReply = "Thanks! We've received your image. Our team will verify it and get back to you shortly.";

      try {
        const outboundWaId = `ai_fallback_${Date.now()}_${customer.id.slice(0, 8)}`;
        await messageRepo.logMessage({
          clientId,
          customerId:  customer.id,
          direction:   'outbound',
          contentType: 'text',
          content:     fallbackReply,
          waMessageId: outboundWaId,
        });

        await enqueueOutgoingMessage({
          clientId,
          to:                 msg.from,
          text:               fallbackReply,
          customerId:         customer.id,
          replyToWaMessageId: msg.waMessageId,
        });

        logger.info(
          { to: msg.from, clientId, customerId: customer.id },
          '[Router] Fallback image acknowledgment reply enqueued successfully',
        );
      } catch (innerErr) {
        logger.error(
          { err: innerErr, clientId, customerId: customer.id, from: msg.from },
          '[Router] CRITICAL: Failed to send fallback receipt reply after image handler exception',
        );
      }
    }
    return;
  }

  if (msg.contentType !== 'text' || !msg.text.trim()) {
    logger.info(
      { type: msg.contentType, from: msg.from },
      '[Router] Non-text message — logged only, no AI reply (TODO Day 3+)',
    );
    return;
  }

  // ── 5. AI conversation engine ─────────────────────────────────────────────
  let replyText: string;
  let conversationId: string;

  try {
    const result = await processMessage(clientId, customer.id, msg.text.trim());
    replyText      = result.replyText;
    conversationId = result.conversationId;
  } catch (err) {
    // AI engine failed — log the error but don't crash the whole router.
    // Send a safe fallback so the customer gets a response.
    const errorDetails = err as Error & { status?: number; statusCode?: number; statusText?: string; code?: string | number };
    logger.error(
      { 
        err: errorDetails,
        message: errorDetails.message,
        stack: errorDetails.stack,
        status: errorDetails.status || errorDetails.statusCode,
        statusText: errorDetails.statusText,
        code: errorDetails.code,
        from: msg.from, 
        clientId 
      },
      '[Router] AI engine error — sending fallback reply',
    );
    replyText      = "I'm sorry, I'm having trouble right now. Please try again in a moment! 🙏";
    conversationId = 'unknown';
  }

  // ── 6. Log AI reply to raw messages table ─────────────────────────────────
  // Generate a synthetic wa_message_id for outbound AI replies (no real WA id yet).
  const outboundWaId = `ai_${Date.now()}_${customer.id.slice(0, 8)}`;
  await messageRepo.logMessage({
    clientId,
    customerId:  customer.id,
    direction:   'outbound',
    contentType: 'text',
    content:     replyText,
    waMessageId: outboundWaId,
  });

  // ── 7. Enqueue via BullMQ (same queue as Day 1) ───────────────────────────
  await enqueueOutgoingMessage({
    clientId,
    to:                 msg.from,
    text:               replyText,
    customerId:         customer.id,
    replyToWaMessageId: msg.waMessageId,
  });

  logger.info(
    { to: msg.from, conversationId, clientId },
    '[Router] AI reply enqueued',
  );
}
