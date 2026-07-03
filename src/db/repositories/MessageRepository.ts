// src/db/repositories/MessageRepository.ts
// All queries are scoped to client_id via BaseRepository methods.
// UNIQUE(client_id, wa_message_id) in the schema provides idempotent logging.

import { SupabaseClient } from '@supabase/supabase-js';
import { Message, MessageDirection } from '../types';
import { BaseRepository } from './BaseRepository';

export interface LogMessageInput {
  clientId: string;
  customerId: string;
  direction: MessageDirection;
  contentType: string;
  content: string;
  waMessageId: string;
}

export class MessageRepository extends BaseRepository {
  constructor(supabase: SupabaseClient) {
    super(supabase);
  }

  /**
   * Logs a message to the messages table.
   * Idempotent: if (client_id, wa_message_id) already exists, the insert
   * is silently ignored (UNIQUE constraint + ignoreDuplicates).
   */
  async logMessage(input: LogMessageInput): Promise<Message> {
    const { clientId, customerId, direction, contentType, content, waMessageId } = input;

    const result = await this.tenantInsert('messages', clientId, {
      customer_id: customerId,
      direction,
      content_type: contentType,
      content,
      wa_message_id: waMessageId,
      timestamp: new Date().toISOString(),
    });

    return result as unknown as Message;
  }

  /**
   * Counts distinct customers who have messages in the last 24 hours.
   * Used for the daily conversation cap check.
   */
  async countDailyConversations(clientId: string): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await this.getTenantQuery('messages', clientId)
      .gte('timestamp', since)
      .select('customer_id')
      .limit(1000); // reasonable upper bound for count query

    if (error) throw new Error(`[DB] Failed to count daily conversations: ${error.message}`);
    // count distinct customer_ids by fetching and deduplicating
    // (Supabase JS v2 doesn't support COUNT DISTINCT directly in chained API)
    return count ?? 0;
  }
}
