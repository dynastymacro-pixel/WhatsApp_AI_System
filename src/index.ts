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
import { startDeliveryWorker, stopDeliveryWorker } from './queue/deliveryWorker';
import { getSupabaseClient } from './db/supabase';
import { enqueueDeliveryJob } from './queue/deliveryQueue';
import { initWhatsAppClient, getAllAdapters } from './whatsapp/manager';
import { registerBaileysWebhook } from './webhooks/baileys';
import { startQrServer, stopQrServer } from './whatsapp/qrServer';

let pollingInterval: NodeJS.Timeout | null = null;

function startDeliveryListener() {
  logger.info('[DeliveryListener] Starting database polling loop...');
  pollingInterval = setInterval(async () => {
    try {
      const supabase = getSupabaseClient();
      
      // Atomically claim and lock the next pending order
      const { data: claimedOrder, error } = await supabase.rpc('claim_next_delivery_order');

      if (error) {
        logger.error({ err: error.message }, '[DeliveryListener] claim_next_delivery_order RPC failed');
        return;
      }

      if (claimedOrder && (claimedOrder as any[]).length > 0) {
        const order = (claimedOrder as any[])[0];
        logger.info({ orderId: order.id, clientId: order.client_id }, '[DeliveryListener] Locked next pending order for delivery');
        
        await enqueueDeliveryJob({
          orderId: order.id,
          clientId: order.client_id,
        });
      }
    } catch (err: any) {
      logger.error({ err: err.message }, '[DeliveryListener] Unexpected error in polling loop');
    }
  }, 3000); // Poll database every 3 seconds
}

function stopDeliveryListener() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    logger.info('[DeliveryListener] Polling loop stopped.');
  }
}

async function main(): Promise<void> {
  // ── Step 1: Start the QR pairing server ──────────────────────────────────
  // Serves GET /qr — a browser-scannable QR image. Essential for Railway
  // where ASCII QR codes in logs are often unreadable.
  startQrServer();

  // ── Step 2: Start the workers & listeners ────────────────────────────────
  startOutgoingWorker();
  startDeliveryWorker();
  startDeliveryListener();

  // ── Step 3: Connect WhatsApp for the default client ──────────────────────
  // Day 1: Single-tenant boot using DEFAULT_CLIENT_ID.
  // Multi-tenant: load all active clients from DB and call initWhatsAppClient()
  // for each one. That extension is straightforward — the manager supports it.
  const clientId = config.defaultClientId;
  logger.info({ clientId }, '[ZapSell] Initialising WhatsApp adapter...');

  const adapter = await initWhatsAppClient(clientId);

  // ── Step 4: Register the inbound message handler ──────────────────────────
  registerBaileysWebhook(adapter, clientId);

  logger.info('[ZapSell] ✅ Boot complete — waiting for WhatsApp connection...');
  logger.info('[ZapSell] Scan the QR code printed above to pair your WhatsApp account.');
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Flush all pending debounced session writes before exit.
// This prevents auth key loss on Railway container restarts / deployments.

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, '[ZapSell] Shutting down gracefully...');

  // Stop the database listener polling loop
  stopDeliveryListener();

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

  // Stop the BullMQ workers cleanly
  await stopOutgoingWorker();
  await stopDeliveryWorker();

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
