// src/db/repositories/OrderRepository.ts
// All queries are scoped to client_id via BaseRepository methods.
//
// Public surface (5 methods):
//   createOrSync()          — main entry point for engine.ts; handles all edge cases
//   updateAgreedPrice()     — syncs agreed_price on an existing pending order
//   markScreenshotReceived()— stamps screenshot_received_at when image arrives
//   findPendingByConversation() — lookup used by image handler + internal logic
//   findPendingByCustomer() — admin dashboard: list all pending orders for a customer
//
// Private helpers:
//   create()    — raw insert; called only by createOrSync()
//   supersede() — marks an order as system-superseded; called only by createOrSync()

import { SupabaseClient } from '@supabase/supabase-js';
import { Order }          from '../types';
import { BaseRepository } from './BaseRepository';
import { logger }         from '../../utils/logger';

export interface CreateOrderInput {
  customerId:     string;
  conversationId: string;
  productId:      string | null;
  agreedPrice:    number;
}

export type OrderSyncAction =
  | 'created'
  | 'superseded_and_created'
  | 'price_synced'
  | 'no_change'
  | 'created_alongside_paid_order'; // existing order had screenshot — old row preserved

export interface OrderSyncResult {
  action: OrderSyncAction;
  order:  Order;
}

export class OrderRepository extends BaseRepository {
  constructor(supabase: SupabaseClient) {
    super(supabase);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Creates or syncs the pending order record for a conversation.
   * Encapsulates three possible outcomes:
   *
   *   • No existing pending order       → inserts a new pending row ('created')
   *   • Pending row, same product_id,
   *     price unchanged                 → no-op ('no_change')
   *   • Pending row, same product_id,
   *     price changed (re-negotiated)   → updates agreed_price ('price_synced')
   *   • Pending row, different product  → supersedes old row, inserts new one
   *                                       ('superseded_and_created')
   *
   * Called inside engine.ts at the order_intent / currentStatus !== 'awaiting_payment' gate.
   */
  async createOrSync(clientId: string, data: CreateOrderInput): Promise<OrderSyncResult> {
    const existing = await this.findPendingByConversation(clientId, data.conversationId);

    // No pending order for this conversation — create fresh
    if (!existing) {
      const order = await this.create(clientId, data);
      return { action: 'created', order };
    }

    // Same product — check whether the agreed price needs syncing
    if (existing.product_id === data.productId) {
      // Compare as numbers: DB returns NUMERIC as string in some drivers
      if (Number(existing.agreed_price) !== Number(data.agreedPrice)) {
        const order = await this.updateAgreedPrice(clientId, existing.id, data.agreedPrice);
        return { action: 'price_synced', order };
      }
      return { action: 'no_change', order: existing };
    }

    // Different product — gate on whether the existing order already has screenshot proof.
    // No screenshot → customer hasn't submitted payment; safe to supersede.
    // Screenshot present → a payment has been submitted for this order. NEVER discard that
    //   evidence. Insert a fresh pending row alongside; leave the paid order untouched.
    if (existing.screenshot_received_at === null) {
      await this.supersede(clientId, existing.id);
      const order = await this.create(clientId, data);
      return { action: 'superseded_and_created', order };
    } else {
      const order = await this.create(clientId, data);
      logger.info(
        {
          clientId,
          existingOrderId:      existing.id,
          existingProductId:    existing.product_id,
          existingScreenshotAt: existing.screenshot_received_at,
          newOrderId:           order.id,
          newProductId:         data.productId,
        },
        '[OrderRepository] createOrSync: existing order already has a screenshot — ' +
        'inserting new pending row alongside (paid order preserved, NOT superseded)',
      );
      return { action: 'created_alongside_paid_order', order };
    }
  }

  /**
   * Updates the agreed_price on an existing pending order.
   * Used when the customer re-negotiates the same product after a status reset,
   * so the admin sees the actual agreed amount rather than a stale figure.
   */
  async updateAgreedPrice(clientId: string, orderId: string, newPrice: number): Promise<Order> {
    const result = await this.tenantUpdate(
      'orders',
      clientId,
      { id: orderId },
      { agreed_price: newPrice },
    );
    return result as unknown as Order;
  }

  /**
   * Sets screenshot_received_at to NOW() on the pending order for a conversation.
   * Called in messageRouter.ts when an image message arrives.
   * No-ops with a warning log if no pending order exists (image before any order placed).
   * Returns the updated row, or null if no pending order was found.
   */
  async markScreenshotReceived(clientId: string, conversationId: string): Promise<Order | null> {
    const existing = await this.findPendingByConversation(clientId, conversationId);

    if (!existing) {
      logger.warn(
        { clientId, conversationId },
        '[OrderRepository] markScreenshotReceived: no pending order found — ' +
        'image received before any order was placed (no-op)',
      );
      return null;
    }

    const result = await this.tenantUpdate(
      'orders',
      clientId,
      { id: existing.id },
      { screenshot_received_at: new Date().toISOString() },
    );
    return result as unknown as Order;
  }

  /**
   * Returns the single pending order for a conversation, or null.
   * At most one pending order per conversation is maintained by createOrSync().
   */
  async findPendingByConversation(clientId: string, conversationId: string): Promise<Order | null> {
    const { data, error } = await this.getTenantQuery('orders', clientId)
      .eq('conversation_id', conversationId)
      .eq('approval_status', 'pending')
      .maybeSingle();
    if (error) throw new Error(`[DB] Failed to find pending order by conversation: ${error.message}`);
    return data as Order | null;
  }

  /**
   * Returns all pending orders for a customer across all conversations,
   * newest first. Used by the admin dashboard (Phase 3+).
   */
  async findPendingByCustomer(clientId: string, customerId: string): Promise<Order[]> {
    const { data, error } = await this.getTenantQuery('orders', clientId)
      .eq('customer_id', customerId)
      .eq('approval_status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw new Error(`[DB] Failed to find pending orders by customer: ${error.message}`);
    return (data ?? []) as Order[];
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Raw insert of a new pending order row.
   * Not called directly outside this class — use createOrSync() instead.
   */
  private async create(clientId: string, data: CreateOrderInput): Promise<Order> {
    const result = await this.tenantInsert('orders', clientId, {
      customer_id:     data.customerId,
      conversation_id: data.conversationId,
      product_id:      data.productId,
      agreed_price:    data.agreedPrice,
      approval_status: 'pending',
    });
    return result as unknown as Order;
  }

  /**
   * Marks an existing order as system-superseded.
   * Called when the customer switches products while a prior order is still pending.
   * The row is preserved for audit purposes; it will not appear as 'pending'.
   */
  private async supersede(clientId: string, orderId: string): Promise<void> {
    await this.tenantUpdate(
      'orders',
      clientId,
      { id: orderId },
      {
        approval_status: 'superseded',
        approved_by:     'system',
        approved_at:     new Date().toISOString(),
      },
    );
  }
}
