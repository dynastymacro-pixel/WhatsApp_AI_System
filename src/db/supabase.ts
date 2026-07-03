// src/db/supabase.ts
// Singleton Supabase client using the service-role key.
// This must ONLY be used server-side (never exposed to a browser).

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return _client;
}
