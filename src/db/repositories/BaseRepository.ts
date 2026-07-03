// src/db/repositories/BaseRepository.ts
// ─────────────────────────────────────────────────────────────────────────────
// Multi-tenant isolation base class.
//
// RULE: Every query against multi-tenant tables (customers, messages) MUST go
// through the protected methods here. They guarantee client_id is always
// present in SELECT filters, INSERT payloads, and UPDATE filters.
//
// The ClientRepository is exempt — it queries by its own `id`.
// ─────────────────────────────────────────────────────────────────────────────

import { SupabaseClient } from '@supabase/supabase-js';

export abstract class BaseRepository {
  protected readonly supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  // ── SELECT ──────────────────────────────────────────────────────────────────

  /**
   * Returns a SELECT query builder pre-filtered by client_id.
   * All reads on multi-tenant tables must start here.
   */
  protected getTenantQuery(table: string, clientId: string) {
    this.assertClientId(clientId, 'SELECT', table);
    return this.supabase.from(table).select('*').eq('client_id', clientId);
  }

  // ── INSERT ──────────────────────────────────────────────────────────────────

  /**
   * Inserts a single row, automatically injecting client_id.
   * Callers must NOT add client_id to `data` themselves.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async tenantInsert(table: string, clientId: string, data: Record<string, any>): Promise<any> {
    this.assertClientId(clientId, 'INSERT', table);
    const { data: result, error } = await this.supabase
      .from(table)
      .insert({ ...data, client_id: clientId })
      .select()
      .single();
    if (error) throw new Error(`[DB] INSERT into ${table} failed: ${error.message}`);
    return result;
  }

  /**
   * Inserts a single row with UPSERT semantics (on conflict do update),
   * automatically injecting client_id.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async tenantUpsert(table: string, clientId: string, data: Record<string, any>, onConflict: string): Promise<any> {
    this.assertClientId(clientId, 'UPSERT', table);
    const { data: result, error } = await this.supabase
      .from(table)
      .upsert({ ...data, client_id: clientId }, { onConflict })
      .select()
      .single();
    if (error) throw new Error(`[DB] UPSERT into ${table} failed: ${error.message}`);
    return result;
  }

  // ── UPDATE ──────────────────────────────────────────────────────────────────

  /**
   * Updates rows matching `match` object, always scoped to client_id.
   * The client_id filter is applied in addition to `match` — callers cannot
   * accidentally update rows belonging to a different tenant.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async tenantUpdate(table: string, clientId: string, match: Record<string, any>, data: Record<string, any>): Promise<any> {
    this.assertClientId(clientId, 'UPDATE', table);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = this.supabase
      .from(table)
      .update(data)
      .eq('client_id', clientId);

    // Apply additional match conditions
    for (const [key, value] of Object.entries(match)) {
      query = query.eq(key, value);
    }

    const { data: result, error } = await query.select().single();
    if (error) throw new Error(`[DB] UPDATE on ${table} failed: ${error.message}`);
    return result;
  }

  // ── Guards ──────────────────────────────────────────────────────────────────

  private assertClientId(clientId: string, operation: string, table: string): void {
    if (!clientId || clientId.trim() === '') {
      throw new Error(
        `[MultiTenantViolation] ${operation} on "${table}" attempted without a clientId. ` +
        `This is a hard isolation rule — every query must be scoped to a tenant.`,
      );
    }
  }
}
