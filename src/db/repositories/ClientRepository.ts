// src/db/repositories/ClientRepository.ts
// Queries against `clients` table. Filtered by `id` (not client_id, since
// clients IS the tenant root). No multi-tenant filter needed here.

import { SupabaseClient } from '@supabase/supabase-js';
import { Client } from '../types';

export class ClientRepository {
  private readonly supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  async findById(id: string): Promise<Client | null> {
    const { data, error } = await this.supabase
      .from('clients')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`[DB] Failed to fetch client ${id}: ${error.message}`);
    return data as Client | null;
  }

  async updateSessionData(
    id: string,
    sessionData: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.supabase
      .from('clients')
      .update({ wa_session_data: sessionData })
      .eq('id', id);
    if (error) throw new Error(`[DB] Failed to update session data for client ${id}: ${error.message}`);
  }
}
