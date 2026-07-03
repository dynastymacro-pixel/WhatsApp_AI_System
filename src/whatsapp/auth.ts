// src/whatsapp/auth.ts
// Custom Baileys authentication state backed by Supabase.
//
// Stores the Baileys auth state (creds + signal keys) in the clients table
// under wa_session_data, keyed by clientId. This enables:
//   1. Multi-tenant session isolation
//   2. Session persistence across Railway restarts (no QR re-scan)
//   3. Debounced writes (to avoid hammering DB on every key update)
//   4. Flush-on-SIGTERM so the latest keys are saved before process exits

import {
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { ClientRepository } from '../db/repositories/ClientRepository';
import { getSupabaseClient } from '../db/supabase';

const DEBOUNCE_MS = 500;

export interface SupabaseAuthStateResult {
  state: AuthenticationState;
  saveCreds: () => void;
  /** Call this immediately on SIGTERM/SIGINT to flush debounced writes. */
  flushSession: () => Promise<void>;
}

export async function useSupabaseAuthState(
  clientId: string,
): Promise<SupabaseAuthStateResult> {
  const clientRepo = new ClientRepository(getSupabaseClient());

  // ── Load existing session ──────────────────────────────────────────────────
  const client = await clientRepo.findById(clientId);
  let sessionData: Record<string, unknown> =
    (client?.wa_session_data as Record<string, unknown>) ?? {};

  // ── Deserialise creds ──────────────────────────────────────────────────────
  let creds: AuthenticationState['creds'];
  if (sessionData['creds']) {
    try {
      creds = JSON.parse(
        JSON.stringify(sessionData['creds']),
        BufferJSON.reviver,
      ) as AuthenticationState['creds'];
    } catch {
      console.warn('[Auth] Failed to parse stored creds, generating fresh ones.');
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
  }

  // ── Keys storage (in-memory, flushed to DB) ────────────────────────────────
  const keys: Record<string, Record<string, unknown>> = {};
  if (sessionData['keys']) {
    try {
      const rawKeys = JSON.parse(
        JSON.stringify(sessionData['keys']),
        BufferJSON.reviver,
      );
      Object.assign(keys, rawKeys);
    } catch {
      console.warn('[Auth] Failed to parse stored keys, starting fresh.');
    }
  }

  // ── Debounce flush ─────────────────────────────────────────────────────────
  let debounceTimer: NodeJS.Timeout | null = null;
  let pendingFlush = false;

  const writeToDb = async (): Promise<void> => {
    pendingFlush = false;
    const payload: Record<string, unknown> = {
      creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
      keys: JSON.parse(JSON.stringify(keys, BufferJSON.replacer)),
    };
    await clientRepo.updateSessionData(clientId, payload);
  };

  const scheduleSave = (): void => {
    pendingFlush = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      await writeToDb().catch((err) => {
        console.error('[Auth] Debounced session write failed:', err);
      });
    }, DEBOUNCE_MS);
  };

  const flushSession = async (): Promise<void> => {
    if (!pendingFlush) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    await writeToDb();
  };

  // ── Baileys AuthenticationState implementation ─────────────────────────────
  const state: AuthenticationState = {
    creds,
    keys: {
      get<T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): { [id: string]: SignalDataTypeMap[T] } {
        const keyMap = (keys[type] ?? {}) as { [id: string]: SignalDataTypeMap[T] };
        return ids.reduce(
          (acc, id) => {
            const val = keyMap[id];
            if (val !== undefined) acc[id] = val;
            return acc;
          },
          {} as { [id: string]: SignalDataTypeMap[T] },
        );
      },

      set(data: { [key in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[key] } }): void {
        for (const [type, typeData] of Object.entries(data)) {
          if (!keys[type]) keys[type] = {};
          for (const [id, value] of Object.entries(typeData ?? {})) {
            if (value !== null && value !== undefined) {
              keys[type][id] = value as unknown;
            } else {
              delete keys[type][id];
            }
          }
        }
        scheduleSave();
      },
    },
  };

  const saveCreds = (): void => {
    scheduleSave();
  };

  return { state, saveCreds, flushSession };
}
