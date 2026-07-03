// src/lib/ai/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// AI ABSTRACTION LAYER
//
// RULE: Any call to an AI provider MUST go through this module.
// Business logic MUST NEVER import an AI SDK directly.
//
// Interface design principles:
//   - IAIClient is intentionally provider-agnostic. The method signature
//     must not contain any Gemini-specific types.
//   - Adding a second provider (OpenAI, DeepSeek, Groq) requires only:
//     1. A new class implementing IAIClient
//     2. Updating the exported `aiClient` singleton
//     Business logic (conversation engine, router) touches zero lines.
//
// Structured reply:
//   The AI is asked to return JSON with a typed AIStructuredReply shape.
//   This lets the negotiation guardrail read `offeredPrice` as a number
//   rather than parsing it out of free-form text — far more reliable.
// ─────────────────────────────────────────────────────────────────────────────

import { GeminiAIClient } from './geminiClient';
import { config } from '../../config';

// ── Public types ──────────────────────────────────────────────────────────────

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AICompletionRequest {
  systemPrompt: string;
  messages: AIMessage[];   // full conversation history, chronological order
  clientId: string;        // for logging/tracing only, not sent to provider
}

/**
 * Structured reply returned by the AI.
 *
 * message      — the text to send to the customer (always present)
 * offeredPrice — numeric price if the AI is making/confirming a price offer.
 *                UNDEFINED if no price is being discussed in this turn.
 *                The negotiation guardrail reads this field — do not remove.
 * productId    — Supabase UUID of the product being discussed (if identified).
 * intent       — coarse intent bucket for routing/logging.
 */
export interface AIStructuredReply {
  message: string;
  offeredPrice?: number;
  productId?: string;
  intent: 'greeting' | 'product_inquiry' | 'price_negotiation' | 'order_intent' | 'other';
}

export interface AICompletionResponse {
  reply: AIStructuredReply;
  rawJson: string;          // the raw JSON string from the provider, for debugging
  tokensUsed?: number;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IAIClient {
  /**
   * Send a conversation to the AI and receive a structured reply.
   * Implementations MUST return a valid AICompletionResponse or throw.
   */
  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
}

// ── Singleton — swap the implementation here to change providers ──────────────

export const aiClient: IAIClient = new GeminiAIClient(
  config.geminiApiKey,
  config.geminiModel,
);
