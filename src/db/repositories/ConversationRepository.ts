// src/db/repositories/ConversationRepository.ts
// Manages conversation lifecycle per customer per client.
// Each customer has at most one active/negotiating conversation at a time.

import { BaseRepository } from './BaseRepository';
import { Conversation, ConversationStatus } from '../types';

export interface UpdateConversationInput {
  status?: ConversationStatus;
  current_product_id?: string | null;
  negotiation_rounds?: number;
  current_offer?: number | null;
}

export class ConversationRepository extends BaseRepository {

  /**
   * Find the active or negotiating conversation for a customer.
   * Returns null if no open conversation exists.
   */
  async findActive(clientId: string, customerId: string): Promise<Conversation | null> {
    const { data, error } = await this.getTenantQuery('conversations', clientId)
      .eq('customer_id', customerId)
      .in('status', ['active', 'negotiating'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`[DB] findActive conversation failed: ${error.message}`);
    return data as Conversation | null;
  }

  /**
   * Create a new conversation for a customer.
   * client_id is injected automatically by tenantInsert.
   */
  async create(clientId: string, customerId: string): Promise<Conversation> {
    return this.tenantInsert('conversations', clientId, {
      customer_id: customerId,
      status: 'active',
      negotiation_rounds: 0,
    }) as Promise<Conversation>;
  }

  /**
   * Find active conversation or create one if none exists.
   * Guarantees exactly one open conversation per customer.
   */
  async findOrCreate(clientId: string, customerId: string): Promise<Conversation> {
    const existing = await this.findActive(clientId, customerId);
    if (existing) return existing;
    return this.create(clientId, customerId);
  }

  /**
   * Update conversation fields (status, current_product_id, negotiation state).
   * Always scoped to client_id via tenantUpdate.
   */
  async update(
    clientId: string,
    conversationId: string,
    updates: UpdateConversationInput,
  ): Promise<Conversation> {
    return this.tenantUpdate(
      'conversations',
      clientId,
      { id: conversationId },
      { ...updates, updated_at: new Date().toISOString() },
    ) as Promise<Conversation>;
  }

  /** Increment negotiation_rounds by 1 and optionally record the current offer. */
  async recordNegotiationRound(
    clientId: string,
    conversationId: string,
    currentRounds: number,
    currentOffer?: number,
  ): Promise<Conversation> {
    return this.update(clientId, conversationId, {
      status: 'negotiating',
      negotiation_rounds: currentRounds + 1,
      ...(currentOffer !== undefined && { current_offer: currentOffer }),
    });
  }

  /** Mark a conversation as closed. */
  async close(clientId: string, conversationId: string): Promise<Conversation> {
    return this.update(clientId, conversationId, { status: 'closed' });
  }
}
