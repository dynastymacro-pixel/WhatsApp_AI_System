// src/lib/ai/openaiClient.ts
// OpenAIClient — implements IAIClient using the OpenAI API.
//
// Uses response_format type: 'json_schema' to get structured output reliably.
// The JSON schema is strictly enforced, ensuring we receive a valid
// AIStructuredReply without brittle regex parsing.
//
// ONLY THIS FILE imports from 'openai'.
// All other modules use IAIClient from client.ts.

import OpenAI from 'openai';
import {
  IAIClient,
  AICompletionRequest,
  AICompletionResponse,
  AIStructuredReply,
} from './client';
import { logger } from '../../utils/logger';

// JSON schema for OpenAI structured outputs.
// Since strict: true is active, all fields must be specified in the "required" list.
// Optional fields (offeredPrice, productId) are marked nullable using type: ["type", "null"].
const OPENAI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    message: { 
      type: 'string', 
      description: 'The reply text to send to the customer.' 
    },
    offeredPrice: { 
      type: ['number', 'null'], 
      description: 'Numeric price offered (null if no price is currently being quoted/offered/confirmed).' 
    },
    productId: { 
      type: ['string', 'null'], 
      description: 'Supabase UUID of the product being discussed (null if no product is being focused).' 
    },
    intent: {
      type: 'string',
      enum: ['greeting', 'product_inquiry', 'price_negotiation', 'order_intent', 'payment_confirmation', 'other'],
      description: 'Coarse intent classification of this reply.'
    }
  },
  required: ['message', 'offeredPrice', 'productId', 'intent'],
  additionalProperties: false
};

export class OpenAIClient implements IAIClient {
  private readonly client: OpenAI;
  private readonly modelName: string;

  constructor(apiKey: string, modelName: string) {
    this.client = new OpenAI({ apiKey });
    this.modelName = modelName;
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    // Map chronological message history to OpenAI Chat Completion message objects
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: request.systemPrompt },
      ...request.messages.map((m) => ({
        role: (m.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
        content: m.content,
      })),
    ];

    const response = await this.client.chat.completions.create({
      model: this.modelName,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'ai_structured_reply',
          strict: true,
          schema: OPENAI_RESPONSE_SCHEMA as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        },
      },
    });

    const rawJson = response.choices[0]?.message?.content;
    if (!rawJson) {
      throw new Error('[OpenAIClient] Empty response content from chat completion');
    }

    const tokensUsed = response.usage?.total_tokens;

    let reply: AIStructuredReply;
    try {
      const parsed = JSON.parse(rawJson);
      
      // Clean up nullable schema fields to match IAIClient's optional properties:
      // if offeredPrice or productId are null, delete/omit them so they are undefined.
      reply = {
        message: parsed.message,
        intent: parsed.intent,
        ...(parsed.offeredPrice !== null && { offeredPrice: parsed.offeredPrice }),
        ...(parsed.productId !== null && { productId: parsed.productId }),
      };
    } catch {
      logger.warn(
        { rawJson, clientId: request.clientId },
        '[OpenAIClient] Failed to parse JSON response — falling back to plain text',
      );
      reply = { message: rawJson, intent: 'other' };
    }

    logger.debug(
      { intent: reply.intent, offeredPrice: reply.offeredPrice, clientId: request.clientId, tokensUsed },
      '[OpenAIClient] Reply generated',
    );

    return { reply, rawJson, tokensUsed };
  }
}
