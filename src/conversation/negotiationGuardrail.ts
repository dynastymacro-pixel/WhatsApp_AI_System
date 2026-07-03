// src/conversation/negotiationGuardrail.ts
// ─────────────────────────────────────────────────────────────────────────────
// CODE-LEVEL negotiation price enforcement.
//
// The AI cannot be trusted to self-enforce numeric lower bounds via prompting
// alone — LLMs are unreliable at strict numeric constraints. This module
// intercepts AI replies BEFORE they are sent and enforces min_price in code.
//
// Algorithm:
//   1. If AI reply contains no offeredPrice → pass through (not a price reply).
//   2. If offeredPrice >= product.min_price → pass through (within bounds).
//   3. If offeredPrice < product.min_price:
//      a. If negotiation_rounds < MAX → re-prompt AI with a correction notice.
//      b. If re-prompt also violates → use scripted fallback (hold firm reply).
//   4. If negotiation_rounds >= MAX_NEGOTIATION_ROUNDS → force hold-firm context.
// ─────────────────────────────────────────────────────────────────────────────

import { AICompletionResponse, AIStructuredReply, IAIClient, AICompletionRequest } from '../lib/ai/client';
import { Product } from '../db/types';
import { buildHoldFirmReply } from './constants';
import { logger } from '../utils/logger';

export interface GuardrailResult {
  reply: AIStructuredReply;
  wasIntercepted: boolean;   // true if the guardrail changed the reply
  interceptReason?: string;
}

/**
 * Run the negotiation guardrail on an AI reply.
 *
 * @param response      - Raw response from the AI client
 * @param product       - The product being discussed (null if none identified)
 * @param negotiationRounds - How many rounds have already occurred
 * @param maxRounds     - Config cap on rounds before holding firm
 * @param aiClient      - IAIClient reference for re-prompting
 * @param originalRequest - The original request (used for re-prompting)
 */
export async function applyNegotiationGuardrail(
  response: AICompletionResponse,
  product: Product | null,
  negotiationRounds: number,
  maxRounds: number,
  aiClient: IAIClient,
  originalRequest: AICompletionRequest,
): Promise<GuardrailResult> {
  const { reply } = response;

  // ── 1. No price in reply — nothing to check ──────────────────────────────
  if (reply.offeredPrice === undefined || reply.offeredPrice === null) {
    return { reply, wasIntercepted: false };
  }

  // ── 2. No product context — can't check floor ────────────────────────────
  if (!product) {
    return { reply, wasIntercepted: false };
  }

  const offeredPrice = reply.offeredPrice;
  const minPrice = product.min_price;

  // ── 3. Price is within bounds — pass through ─────────────────────────────
  if (offeredPrice >= minPrice) {
    logger.debug(
      { offeredPrice, minPrice, product: product.name },
      '[Guardrail] Price within bounds — passing through',
    );
    return { reply, wasIntercepted: false };
  }

  // ── 4. Price is BELOW floor — intercept ──────────────────────────────────
  logger.warn(
    { offeredPrice, minPrice, product: product.name, negotiationRounds },
    '[Guardrail] AI offered below-floor price — intercepting',
  );

  // ── 4a. Attempt a correction re-prompt ───────────────────────────────────
  const correctionNotice =
    `SYSTEM CORRECTION: Your previous reply offered ${product.currency} ${offeredPrice} for "${product.name}". ` +
    `This is below the minimum allowed price of ${product.currency} ${minPrice}. ` +
    `You MUST NOT offer any price below ${product.currency} ${minPrice}. ` +
    `Please revise your reply to hold at or above ${product.currency} ${minPrice}.`;

  const repromptRequest: AICompletionRequest = {
    ...originalRequest,
    messages: [
      ...originalRequest.messages,
      { role: 'assistant', content: reply.message },
      { role: 'user',      content: correctionNotice },
    ],
  };

  try {
    const repromptResponse = await aiClient.complete(repromptRequest);
    const repromptedReply  = repromptResponse.reply;

    // Check if re-prompt also violated the floor
    if (
      repromptedReply.offeredPrice !== undefined &&
      repromptedReply.offeredPrice < minPrice
    ) {
      // Re-prompt still violated — fall back to scripted response
      logger.warn(
        { offeredPrice: repromptedReply.offeredPrice, minPrice },
        '[Guardrail] Re-prompt also violated floor — using scripted fallback',
      );
      return {
        reply: {
          message: buildHoldFirmReply(product.name, minPrice, product.currency),
          intent: 'price_negotiation',
          offeredPrice: minPrice,
          productId: product.id,
        },
        wasIntercepted: true,
        interceptReason: 'below_floor_scripted_fallback',
      };
    }

    logger.info(
      { correctedPrice: repromptedReply.offeredPrice ?? 'none', product: product.name },
      '[Guardrail] Re-prompt succeeded — using corrected reply',
    );
    return {
      reply: repromptedReply,
      wasIntercepted: true,
      interceptReason: 'below_floor_reprompted',
    };

  } catch (err) {
    // Re-prompt itself failed — use scripted fallback
    logger.error(
      { err: (err as Error).message },
      '[Guardrail] Re-prompt threw — using scripted fallback',
    );
    return {
      reply: {
        message: buildHoldFirmReply(product.name, minPrice, product.currency),
        intent: 'price_negotiation',
        offeredPrice: minPrice,
        productId: product.id,
      },
      wasIntercepted: true,
      interceptReason: 'below_floor_reprompt_error',
    };
  }
}
