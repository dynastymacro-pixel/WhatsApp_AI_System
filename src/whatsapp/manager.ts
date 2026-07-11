// src/whatsapp/manager.ts
// WhatsAppManager — owns the adapter instances (one per client in multi-tenant).
// For Day 1 (single-tenant boot), it manages one adapter for DEFAULT_CLIENT_ID.

import { BaileysAdapter } from './adapter';
import { IWhatsAppAdapter } from './types';
import { logger } from '../utils/logger';

const adapters = new Map<string, BaileysAdapter>();

/**
 * Initialise and connect a WhatsApp adapter for the given clientId.
 * Idempotent — calling twice for the same clientId is a no-op.
 */
export async function initWhatsAppClient(clientId: string): Promise<BaileysAdapter> {
  if (adapters.has(clientId)) {
    return adapters.get(clientId)!;
  }

  const adapter = new BaileysAdapter(clientId, () => {
    logger.warn({ clientId }, '[WhatsAppManager] Removing dead client from adapters map due to max reconnect failures');
    adapters.delete(clientId);
  });
  adapters.set(clientId, adapter);
  await adapter.connect();
  return adapter;
}

/**
 * Cleanly closes and removes a WhatsApp adapter connection for a given clientId.
 * Prevents socket descriptor leaks and session overlapping during connection retries.
 */
export async function removeWhatsAppClient(clientId: string): Promise<void> {
  const adapter = adapters.get(clientId);
  if (adapter) {
    logger.info({ clientId }, '[WhatsAppManager] Cleaning up and closing existing WhatsApp connection');
    await adapter.close();
    adapters.delete(clientId);
    // 500ms sleep to allow OS to completely close the websocket TCP socket
    await new Promise((resolve) => setTimeout(resolve, 500));
    logger.info({ clientId }, '[WhatsAppManager] Existing WhatsApp connection successfully closed and removed');
  }
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
