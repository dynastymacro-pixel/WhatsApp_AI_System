import { Queue } from 'bullmq';
import { createRedisConnection } from './client';

export interface DeliveryJobData {
  orderId: string;
  clientId: string;
}

export const DELIVERY_JOB_NAME = 'deliver-product' as const;
export const DELIVERY_QUEUE_NAME = 'product-delivery' as const;

let _deliveryQueue: Queue<DeliveryJobData> | null = null;

export function getDeliveryQueue(): Queue<DeliveryJobData> {
  if (!_deliveryQueue) {
    _deliveryQueue = new Queue<DeliveryJobData>(DELIVERY_QUEUE_NAME, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: 1, // Retries are handled manually inside the worker with custom exponential delays
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    });
    console.log(`[Queue] Product delivery queue initialised: "${DELIVERY_QUEUE_NAME}"`);
  }
  return _deliveryQueue;
}

export async function enqueueDeliveryJob(data: DeliveryJobData, delayMs = 0): Promise<void> {
  const queue = getDeliveryQueue();
  await queue.add(DELIVERY_JOB_NAME, data, {
    jobId: `delivery-${data.orderId}-${Date.now()}`,
    delay: delayMs,
  });
  console.log(`[Queue] Enqueued product delivery job for order ${data.orderId} (delay: ${delayMs}ms)`);
}
