// src/queue/client.ts
// BullMQ queue client — the single Queue instance for outgoing WhatsApp messages.
//
// RULE: Route handlers and business logic MUST use enqueueOutgoingMessage() to
// schedule sends. Never call the WhatsApp adapter directly from handlers.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { OutgoingMessageJobData, OUTGOING_MESSAGE_JOB } from './types';

// ── Redis connection ──────────────────────────────────────────────────────────
// Shared connection used by both Queue and Worker.
// enableReadyCheck: false and maxRetriesPerRequest: null are required by BullMQ.
export function createRedisConnection(): IORedis {
  return new IORedis(config.redisUrl, {
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => {
      const delay = Math.min(times * 200, 5000);
      console.warn(`[Redis] Reconnect attempt ${times}, waiting ${delay}ms...`);
      return delay;
    },
  });
}

// ── Queue singleton ───────────────────────────────────────────────────────────
let _queue: Queue<OutgoingMessageJobData> | null = null;

export function getOutgoingQueue(): Queue<OutgoingMessageJobData> {
  if (!_queue) {
    _queue = new Queue<OutgoingMessageJobData>(config.outgoingQueueName, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    });
    console.log(`[Queue] Outgoing queue initialised: "${config.outgoingQueueName}"`);
  }
  return _queue;
}

/**
 * Enqueues an outgoing WhatsApp message.
 * This is the ONLY way business logic should schedule outbound messages.
 */
export async function enqueueOutgoingMessage(
  data: OutgoingMessageJobData,
): Promise<void> {
  const queue = getOutgoingQueue();
  await queue.add(OUTGOING_MESSAGE_JOB, data, {
    jobId: `${data.clientId}-${Date.now()}-${data.to}`,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  });
  console.log(`[Queue] Enqueued outgoing message to ${data.to} (clientId: ${data.clientId})`);
}
