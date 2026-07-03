// src/queue/worker.ts
// BullMQ Worker — processes outgoing WhatsApp message jobs.
//
// Pipeline per job:
//   1. Pull job data (clientId, to, text, customerId)
//   2. Get the WhatsApp adapter for this tenant
//   3. Call adapter.sendText() — which applies the anti-ban typing delay internally
//   4. Log the outbound message to the DB

import { Worker, Job } from 'bullmq';
import { config } from '../config';
import { createRedisConnection } from './client';
import { OutgoingMessageJobData, OUTGOING_MESSAGE_JOB } from './types';
import { getWhatsAppClient } from '../whatsapp/manager';
import { MessageRepository } from '../db/repositories/MessageRepository';
import { getSupabaseClient } from '../db/supabase';

let _worker: Worker | null = null;

export function startOutgoingWorker(): Worker {
  if (_worker) return _worker;

  const messageRepo = new MessageRepository(getSupabaseClient());

  _worker = new Worker<OutgoingMessageJobData>(
    config.outgoingQueueName,
    async (job: Job<OutgoingMessageJobData>) => {
      const { clientId, to, text, customerId } = job.data;

      if (job.name !== OUTGOING_MESSAGE_JOB) {
        throw new Error(`[Worker] Unknown job type: ${job.name}`);
      }

      console.log(`[Worker] Processing outgoing message to ${to} (clientId: ${clientId})`);

      // Get the tenant's WhatsApp adapter — never call Baileys directly
      const adapter = getWhatsAppClient(clientId);

      // Defensive guard: if disconnected, wait briefly for connection recovery
      if (!adapter.isConnected()) {
        console.log(`[Worker] Tenant WhatsApp adapter is disconnected — waiting up to 5s for reconnect...`);
        const maxWaitMs = 5000;
        const checkIntervalMs = 500;
        let elapsed = 0;
        while (!adapter.isConnected() && elapsed < maxWaitMs) {
          await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
          elapsed += checkIntervalMs;
        }
        if (adapter.isConnected()) {
          console.log(`[Worker] WhatsApp reconnected successfully after ${elapsed}ms — proceeding to send`);
        } else {
          console.log(`[Worker] WhatsApp failed to reconnect within ${maxWaitMs / 1000}s — proceeding to send (expecting failure)`);
        }
      }

      // Send — typing delay applied inside adapter.sendText()
      await adapter.sendText(to, text);

      // Generate a pseudo wa_message_id for outbound (Baileys returns the real
      // message ID from sendMessage, but we keep it simple here for Day 1)
      const waMessageId = `out-${clientId}-${Date.now()}`;

      // Log the outbound message to the DB (client_id injected by repository)
      await messageRepo.logMessage({
        clientId,
        customerId,
        direction: 'outbound',
        contentType: 'text',
        content: text,
        waMessageId,
      });

      console.log(`[Worker] ✅ Message sent and logged (to: ${to}, clientId: ${clientId})`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    },
  );

  _worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job?.id} completed successfully at queue level`);
  });

  _worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed:`, err.message);
  });

  _worker.on('error', (err) => {
    console.error('[Worker] Worker error:', err.message);
  });

  console.log(`[Worker] Outgoing message worker started on queue "${config.outgoingQueueName}"`);
  return _worker;
}

export async function stopOutgoingWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
    console.log('[Worker] Outgoing worker stopped.');
  }
}
