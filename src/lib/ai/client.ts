// src/lib/ai/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// AI ABSTRACTION LAYER — SCAFFOLD (Day 1)
//
// RULE: Any call to an AI provider (OpenAI, Gemini, Anthropic, etc.) MUST go
// through this module. Business logic must NEVER import an AI SDK directly.
//
// This file is intentionally empty of logic on Day 1. The interface and
// placeholder are here so the import path is established from the start.
// ─────────────────────────────────────────────────────────────────────────────

export interface AICompletionRequest {
  systemPrompt: string;
  userMessage: string;
  clientId: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface AICompletionResponse {
  text: string;
  tokensUsed?: number;
}

export interface IAIClient {
  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
}

// TODO (Week 2+): Replace this stub with real provider implementations.
// Example: export const aiClient: IAIClient = new GeminiClient();
export const aiClient: IAIClient = {
  async complete(_request: AICompletionRequest): Promise<AICompletionResponse> {
    throw new Error('[AIClient] Not implemented yet — scaffold only.');
  },
};
