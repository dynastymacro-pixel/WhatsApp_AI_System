// src/whatsapp/manager.ts
// WhatsAppManager — owns the adapter instances (one per client in multi-tenant).
// For Day 1 (single-tenant boot), it manages one adapter for DEFAULT_CLIENT_ID.

import { BaileysAdapter } from './adapter';
import { IWhatsAppAdapter } from './types';

const adapters = new Map<string, BaileysAdapter>();

/**
 * Initialise and connect a WhatsApp adapter for the given clientId.
 * Idempotent — calling twice for the same clientId is a no-op.
 */
export async function initWhatsAppClient(clientId: string): Promise<BaileysAdapter> {
  if (adapters.has(clientId)) {
    return adapters.get(clientId)!;
  }

  const adapter = new BaileysAdapter(clientId);
  adapters.set(clientId, adapter);
  await adapter.connect();
  return adapter;
}

/**
 * Returns the adapter for a given clientId, or throws if not initialised.
 * Use this in queue workers and routers.
 */
export function getWhatsAppClient(clientId: string): IWhatsAppAdapter {
  const adapter = adapters.get(clientId);
  if (!adapter) {
    throw new Error(
      `[WhatsAppManager] No adapter found for clientId "${clientId}". ` +
      `Call initWhatsAppClient() during startup.`,
    );
  }
  return adapter;
}

/**
 * Returns all active adapters (used during shutdown to flush sessions).
 */
export function getAllAdapters(): BaileysAdapter[] {
  return Array.from(adapters.values());
}
