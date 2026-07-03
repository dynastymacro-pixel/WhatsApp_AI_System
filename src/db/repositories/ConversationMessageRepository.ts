// src/db/repositories/ConversationMessageRepository.ts
// Manages the structured AI context history for each conversation.
// Separate from the raw `messages` table (WhatsApp transcript).
// Every query is scoped to client_id via BaseRepository.

import { BaseRepository } from './BaseRepository';
import { ConversationMessage, ConversationRole } from '../types';

export class ConversationMessageRepository extends BaseRepository {

  /**
   * Append a message to the conversation history.
   * client_id is injected automatically by tenantInsert.
   */
  async append(
    clientId: string,
    conversationId: string,
    role: ConversationRole,
    content: string,
  ): Promise<ConversationMessage> {
    return this.tenantInsert('conversation_messages', clientId, {
      conversation_id: conversationId,
      role,
      content,
    }) as Promise<ConversationMessage>;
  }

  /**
   * Load recent message history for a conversation, oldest-first.
   * Limit to last N messages to keep the AI context window manageable.
   * All rows are filtered by client_id (multi-tenant isolation).
   */
  async getHistory(
    clientId: string,
    conversationId: string,
    limit = 20,
  ): Promise<ConversationMessage[]> {
    // Supabase doesn't support LIMIT + ORDER in a single chained call that returns
    // oldest-first, so we fetch the last N rows ordered descending, then reverse.
    const { data, error } = await this.getTenantQuery('conversation_messages', clientId)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw new Error(`[DB] getHistory failed: ${error.message}`);
    return ((data ?? []) as ConversationMessage[]).reverse(); // restore chronological order
  }
}
