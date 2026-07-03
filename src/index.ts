// src/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// ZapSell — Entry Point
//
// Boot sequence:
//   1. Validate environment config (fast-fail on missing vars)
//   2. Initialise the outgoing BullMQ worker
//   3. Connect the WhatsApp adapter for the default client
//   4. Register the Baileys webhook handler
//   5. Register SIGTERM/SIGINT handlers for graceful shutdown
//      — flushes pending session writes before exit (prevents auth key loss
//        on Railway restarts)
// ─────────────────────────────────────────────────────────────────────────────

import { config } from './config';

// Config validation happens at import time — process exits here if required
// env vars are missing, before any connections are made.
import { logger } from './utils/logger';

logger.info({ env: config.nodeEnv }, '[ZapSell] Starting...');

import { startOutgoingWorker, stopOutgoingWorker } from './queue/worker';
import { initWhatsAppClient, getAllAdapters } from './whatsapp/manager';
import { registerBaileysWebhook } from './webhooks/baileys';
import { startQrServer, stopQrServer } from './whatsapp/qrServer';

async function main(): Promise<void> {
  // ── Step 1: Start the QR pairing server ──────────────────────────────────
  // Serves GET /qr — a browser-scannable QR image. Essential for Railway
  // where ASCII QR codes in logs are often unreadable.
  startQrServer();

  // ── Step 2: Start the outgoing message worker ────────────────────────────
  startOutgoingWorker();

  // ── Step 2: Connect WhatsApp for the default client ──────────────────────
  // Day 1: Single-tenant boot using DEFAULT_CLIENT_ID.
  // Multi-tenant: load all active clients from DB and call initWhatsAppClient()
  // for each one. That extension is straightforward — the manager supports it.
  const clientId = config.defaultClientId;
  logger.info({ clientId }, '[ZapSell] Initialising WhatsApp adapter...');

  const adapter = await initWhatsAppClient(clientId);

  // ── Step 3: Register the inbound message handler ──────────────────────────
  registerBaileysWebhook(adapter, clientId);

  logger.info('[ZapSell] ✅ Boot complete — waiting for WhatsApp connection...');
  logger.info('[ZapSell] Scan the QR code printed above to pair your WhatsApp account.');
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Flush all pending debounced session writes before exit.
// This prevents auth key loss on Railway container restarts / deployments.

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, '[ZapSell] Shutting down gracefully...');

  // Flush Baileys session data for all active adapters
  const adapters = getAllAdapters();
  logger.info({ count: adapters.length }, '[ZapSell] Flushing sessions...');

  await Promise.allSettled(
    adapters.map(async (adapter) => {
      const flush = adapter.getFlushSession();
      if (flush) {
        await flush().catch((err: Error) => {
          logger.error({ err: err.message }, '[ZapSell] Session flush error');
        });
      }
    }),
  );

  // Stop the BullMQ worker cleanly
  await stopOutgoingWorker();

  // Stop the QR server
  await stopQrServer();

  logger.info('[ZapSell] Shutdown complete. Goodbye.');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));

// Catch unhandled rejections to prevent silent failures
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[ZapSell] Unhandled Promise Rejection');
});

process.on('uncaughtException', (err: Error) => {
  logger.error({ err: err.message, stack: err.stack }, '[ZapSell] Uncaught Exception');
  void shutdown('uncaughtException');
});

main().catch((err: Error) => {
  logger.error({ err: err.message }, '[ZapSell] Fatal startup error');
  process.exit(1);
});
