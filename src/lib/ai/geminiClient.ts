// src/lib/ai/geminiClient.ts
// GeminiAIClient — implements IAIClient using Google's Gemini API.
//
// Uses responseMimeType:'application/json' to get structured output reliably.
// The JSON schema is enforced server-side by Gemini, giving us a typed
// AIStructuredReply without brittle text parsing.
//
// ONLY THIS FILE imports from @google/generative-ai.
// All other modules use IAIClient from client.ts.

import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} from '@google/generative-ai';
import {
  IAIClient,
  AICompletionRequest,
  AICompletionResponse,
  AIStructuredReply,
} from './client';
import { logger } from '../../utils/logger';

// Safety settings — disable blocks for commerce content (prices, sales)
// that Gemini sometimes over-blocks. Harassment/hate/danger stay blocked.
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

// JSON schema describing AIStructuredReply — Gemini enforces this shape.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    message:      { type: 'string',  description: 'The reply text to send to the customer.' },
    offeredPrice: { type: 'number',  description: 'Numeric price offered (omit if no price discussed).' },
    productId:    { type: 'string',  description: 'Supabase UUID of the product being discussed (omit if none).' },
    intent: {
      type: 'string',
      enum: ['greeting', 'product_inquiry', 'price_negotiation', 'order_intent', 'other'],
      description: 'Coarse intent classification of this reply.',
    },
  },
  required: ['message', 'intent'],
};

export class GeminiAIClient implements IAIClient {
  private readonly genAI: GoogleGenerativeAI;
  private readonly modelName: string;

  constructor(apiKey: string, modelName: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = modelName;
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      systemInstruction: request.systemPrompt,
      safetySettings: SAFETY_SETTINGS,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        temperature: 0.7,
        maxOutputTokens: 1024,
      },
    });

    // Build Gemini chat history from our provider-agnostic AIMessage[]
    // Gemini requires: role is 'user' | 'model' (not 'assistant')
    // History excludes the final user message — that's sent as the current turn.
    const history = request.messages.slice(0, -1).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const lastMessage = request.messages[request.messages.length - 1];
    if (!lastMessage) {
      throw new Error('[GeminiAIClient] No messages in request');
    }

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(lastMessage.content);
    const rawJson = result.response.text();
    const tokensUsed = result.response.usageMetadata?.totalTokenCount;

    let reply: AIStructuredReply;
    try {
      reply = JSON.parse(rawJson) as AIStructuredReply;
    } catch {
      // Gemini returned non-JSON despite responseMimeType — degrade gracefully
      logger.warn(
        { rawJson, clientId: request.clientId },
        '[GeminiAIClient] Failed to parse JSON response — falling back to plain text',
      );
      reply = { message: rawJson, intent: 'other' };
    }

    logger.debug(
      { intent: reply.intent, offeredPrice: reply.offeredPrice, clientId: request.clientId, tokensUsed },
      '[GeminiAIClient] Reply generated',
    );

    return { reply, rawJson, tokensUsed };
  }
}
