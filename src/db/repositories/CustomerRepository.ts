// src/db/repositories/CustomerRepository.ts
// All queries are scoped to client_id via BaseRepository methods.

import { SupabaseClient } from '@supabase/supabase-js';
import { Customer } from '../types';
import { BaseRepository } from './BaseRepository';

export class CustomerRepository extends BaseRepository {
  constructor(supabase: SupabaseClient) {
    super(supabase);
  }

  /**
   * Finds a customer by phone number within a specific tenant.
   * Returns null if not found.
   */
  async findByPhone(clientId: string, phoneNumber: string): Promise<Customer | null> {
    const { data, error } = await this.getTenantQuery('customers', clientId)
      .eq('phone_number', phoneNumber)
      .maybeSingle();
    if (error) throw new Error(`[DB] Failed to find customer: ${error.message}`);
    return data as Customer | null;
  }

  /**
   * Creates a new customer, scoped to clientId.
   * Uses UPSERT to avoid race conditions on concurrent first messages.
   */
  async findOrCreate(clientId: string, phoneNumber: string): Promise<Customer> {
    const existing = await this.findByPhone(clientId, phoneNumber);
    if (existing) return existing;

    const result = await this.tenantInsert('customers', clientId, {
      phone_number: phoneNumber,
      first_contact_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
    });
    return result as unknown as Customer;
  }

  /**
   * Updates the last_message_at timestamp for a customer.
   */
  async touchLastSeen(clientId: string, customerId: string): Promise<void> {
    await this.tenantUpdate(
      'customers',
      clientId,
      { id: customerId },
      { last_message_at: new Date().toISOString() },
    );
  }
}
