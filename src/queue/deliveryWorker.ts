import { Worker, Job } from 'bullmq';
import { getSupabaseClient } from '../db/supabase';
import { createRedisConnection } from './client';
import { DeliveryJobData, DELIVERY_JOB_NAME, DELIVERY_QUEUE_NAME, enqueueDeliveryJob } from './deliveryQueue';
import { getWhatsAppClient } from '../whatsapp/manager';
import { MessageRepository } from '../db/repositories/MessageRepository';
import { notifyAdmin } from '../services/notificationService';
import { logger } from '../utils/logger';

// Helper to classify transient connection/infrastructure issues
function isConnectionError(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || '');
  const code = String(err.code || '');

  return (
    msg.includes('[BaileysAdapter] Cannot send message — not connected') ||
    msg.includes('[WhatsAppManager] No adapter found') ||
    msg.includes('sendMessage timed out') ||
    msg.includes('connection lost') ||
    msg.includes('fetch failed') ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND'
  );
}

let _deliveryWorker: Worker | null = null;

export function startDeliveryWorker(): Worker {
  if (_deliveryWorker) return _deliveryWorker;

  const supabase = getSupabaseClient();
  const messageRepo = new MessageRepository(supabase);

  _deliveryWorker = new Worker<DeliveryJobData>(
    DELIVERY_QUEUE_NAME,
    async (job: Job<DeliveryJobData>) => {
      const { orderId, clientId } = job.data;

      if (job.name !== DELIVERY_JOB_NAME) {
        throw new Error(`[DeliveryWorker] Unknown job name: ${job.name}`);
      }

      logger.info({ orderId, clientId }, '[DeliveryWorker] Processing delivery job');

      // ── 1. Fetch order details with product and customer relations ──────────────────
      const { data: order, error: orderErr } = await supabase
        .from('orders')
        .select(`
          *,
          products ( name, delivery_type, delivery_content, stock_status ),
          customers ( phone_number )
        `)
        .eq('id', orderId)
        .single();

      if (orderErr || !order) {
        throw new Error(`[DeliveryWorker] Order not found: ${orderErr?.message}`);
      }

      // Idempotency check: if already delivered, do nothing
      if (order.delivery_status === 'delivered') {
        logger.info({ orderId }, '[DeliveryWorker] Order already delivered — skipping');
        return;
      }

      const product = order.products as any;
      const customer = order.customers as any;

      if (!product) {
        throw new Error(`[DeliveryWorker] Product not found on order ${orderId}`);
      }

      const deliveryType = product.delivery_type;
      logger.info({ orderId, deliveryType }, '[DeliveryWorker] Resolving delivery type');

      // ── 2. Handle manual delivery ──────────────────────────────────────────────────
      if (deliveryType === 'manual') {
        await supabase
          .from('orders')
          .update({ delivery_status: 'not_applicable' })
          .eq('id', orderId);
        logger.info({ orderId }, '[DeliveryWorker] Manual delivery — marked not_applicable');
        return;
      }

      let deliveryText = '';
      let deliveryItemId: string | null = order.delivery_item_id;

      // ── 3. Handle digital link delivery ─────────────────────────────────────────────
      if (deliveryType === 'digital_link') {
        deliveryText = product.delivery_content || '';
        if (!deliveryText) {
          throw new Error(`[DeliveryWorker] Product ${order.product_id} has empty delivery_content`);
        }
      }

      // ── 4. Handle inventory delivery ────────────────────────────────────────────────
      if (deliveryType === 'inventory') {
        // If we already have a claimed item on this order (e.g. from a previous try)
        if (deliveryItemId) {
          const { data: item, error: itemErr } = await supabase
            .from('product_delivery_items')
            .select('*')
            .eq('id', deliveryItemId)
            .single();

          if (itemErr || !item) {
            throw new Error(`[DeliveryWorker] Linked inventory item not found: ${itemErr?.message}`);
          }

          // Decrypt key
          const { data: decrypted, error: decErr } = await supabase.rpc('get_decrypted_secret', {
            secret_name: item.content_encrypted,
          });

          if (decErr || !decrypted) {
            throw new Error(`[DeliveryWorker] Decryption failed for existing item ${item.id}: ${decErr?.message}`);
          }
          deliveryText = String(decrypted);
        } else {
          // Claim a fresh item atomically
          const { data: claimedItems, error: claimErr } = await supabase.rpc('claim_delivery_item', {
            p_product_id: order.product_id,
            p_order_id: orderId,
          });

          if (claimErr) {
            throw new Error(`[DeliveryWorker] claim_delivery_item RPC failed: ${claimErr.message}`);
          }

          const claimedItem = claimedItems && (claimedItems as any[])[0];

          if (!claimedItem) {
            // Out of stock / empty pool — immediate failure
            logger.error({ orderId, productId: order.product_id }, '[DeliveryWorker] No inventory items available');
            
            await supabase
              .from('orders')
              .update({ delivery_status: 'failed' })
              .eq('id', orderId);

            // Alert admin via configured channel (Telegram / WhatsApp / both)
            await notifyAdmin('delivery_failure', clientId, {
              orderId,
              details: 'No inventory items available in stock.',
            });
            return;
          }

          deliveryItemId = claimedItem.id;

          // Update order with the claimed item ID
          await supabase
            .from('orders')
            .update({ delivery_item_id: deliveryItemId })
            .eq('id', orderId);

          // Decrypt key
          const { data: decrypted, error: decErr } = await supabase.rpc('get_decrypted_secret', {
            secret_name: claimedItem.content_encrypted,
          });

          if (decErr || !decrypted) {
            throw new Error(`[DeliveryWorker] Decryption failed for item ${claimedItem.id}: ${decErr?.message}`);
          }
          deliveryText = String(decrypted);
        }
      }

      // ── 5. Attempt sending the message via WhatsApp ──────────────────────────────────
      try {
        const attempts = order.delivery_attempts + 1;
        
        // Update status to pending, increment attempt counter, and refresh lock in DB
        await supabase
          .from('orders')
          .update({
            delivery_status: 'pending',
            delivery_attempts: attempts,
            delivery_locked_at: new Date().toISOString(),
          })
          .eq('id', orderId);

        logger.info({ orderId, to: customer.phone_number, attempt: attempts }, '[DeliveryWorker] Sending WhatsApp message...');

        const adapter = getWhatsAppClient(clientId);
        await adapter.sendText(customer.phone_number, deliveryText);

        // ── 6. On confirmed send success ────────────────────────────────────────────────
        const updatePayload: Record<string, any> = {
          delivery_status: 'delivered',
          delivered_at: new Date().toISOString(),
        };

        await supabase
          .from('orders')
          .update(updatePayload)
          .eq('id', orderId);

        if (deliveryType === 'inventory' && deliveryItemId) {
          await supabase
            .from('product_delivery_items')
            .update({
              status: 'delivered',
              delivered_at: new Date().toISOString(),
            })
            .eq('id', deliveryItemId);
        }

        // Log the outbound message to the messages table
        const pseudoWaMessageId = `delivery-${orderId}-${Date.now()}`;
        await messageRepo.logMessage({
          clientId,
          customerId: order.customer_id,
          direction: 'outbound',
          contentType: 'text',
          content: deliveryText,
          waMessageId: pseudoWaMessageId,
        });

        logger.info({ orderId }, '[DeliveryWorker] ✅ Delivery completed successfully');

        // ── 7. Check remaining available count and flip stock status if depleted ──────────
        if (deliveryType === 'inventory') {
          const { count, error: countErr } = await supabase
            .from('product_delivery_items')
            .select('*', { count: 'exact', head: true })
            .eq('product_id', order.product_id)
            .eq('status', 'available');

          if (!countErr && count === 0) {
            await supabase
              .from('products')
              .update({ stock_status: 'out_of_stock' })
              .eq('id', order.product_id);
            logger.info({ productId: order.product_id }, '[DeliveryWorker] Product stock status updated to out_of_stock');
          }
        }

      } catch (sendError: any) {
        logger.error({ orderId, error: sendError.message }, '[DeliveryWorker] WhatsApp send failure');

        if (isConnectionError(sendError)) {
          // --- Connection/Infrastructure Failure ---

          // Retrieve the earliest connection failure alert for this order to compute the 24h threshold
          const { data: firstAlert } = await supabase
            .from('admin_notification_log')
            .select('sent_at')
            .eq('order_id', orderId)
            .eq('event_type', 'delivery_failure')
            .order('sent_at', { ascending: true })
            .limit(1)
            .maybeSingle();

          const firstFailureTime = firstAlert ? new Date(firstAlert.sent_at).getTime() : 0;
          const isStuckTooLong = firstFailureTime > 0 && (Date.now() - firstFailureTime > 24 * 60 * 60 * 1000);

          if (isStuckTooLong) {
            logger.error(
              { orderId, firstFailureTime: firstAlert?.sent_at }, 
              '[DeliveryWorker] Connection offline for >24h. Releasing item and failing order.'
            );
            
            await supabase.rpc('release_delivery_item_on_failure', {
              p_order_id: orderId,
            });

            await notifyAdmin('delivery_failure', clientId, {
              orderId,
              details: `Session down for >24 hours since first failure. Delivery cancelled and inventory released.`,
            });
            return;
          }

          // Otherwise, retain inventory and delay retry by 5 minutes (setting lock to 3 minutes in the future)
          const retryLockTime = new Date(Date.now() + 3 * 60 * 1000).toISOString();
          
          await supabase
            .from('orders')
            .update({
              delivery_status: 'pending',
              delivery_attempts: order.delivery_attempts, // Restore original count
              delivery_locked_at: retryLockTime
            })
            .eq('id', orderId);

          logger.warn(
            { orderId, retryAt: retryLockTime },
            '[DeliveryWorker] Connection failure. Retaining inventory and delaying retry.'
          );

          // Alert admin but throttle to once every 20 minutes
          const { data: lastAlert } = await supabase
            .from('admin_notification_log')
            .select('sent_at')
            .eq('order_id', orderId)
            .eq('event_type', 'delivery_failure')
            .order('sent_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          const shouldAlert = !lastAlert || 
            (Date.now() - new Date(lastAlert.sent_at).getTime() > 20 * 60 * 1000);

          if (shouldAlert) {
            await notifyAdmin('delivery_failure', clientId, {
              orderId,
              details: `Bot disconnected — WhatsApp connection is offline. Order delivery is stuck. (Error: ${sendError.message})`,
            });
          }

        } else {
          // --- Content/Data Failure ---
          const currentAttempts = order.delivery_attempts + 1;

          if (currentAttempts < 4) {
            let delayMs = 10000;
            if (currentAttempts === 2) delayMs = 30000;
            if (currentAttempts === 3) delayMs = 90000;

            logger.info({ orderId, nextAttempt: currentAttempts + 1, delayMs }, '[DeliveryWorker] Scheduling retry');
            await enqueueDeliveryJob({ orderId, clientId }, delayMs);
          } else {
            // Exhausted attempts
            logger.error({ orderId }, '[DeliveryWorker] Delivery failed after 3 retries. Releasing item...');

            await supabase.rpc('release_delivery_item_on_failure', {
              p_order_id: orderId,
            });

            await notifyAdmin('delivery_failure', clientId, {
              orderId,
              details: `Delivery failed after 3 retries. WhatsApp error: ${sendError.message}`,
            });
          }
        }
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 2,
    }
  );

  _deliveryWorker.on('completed', (job) => {
    logger.info({ jobId: job?.id }, '[DeliveryWorker] Job completed successfully');
  });

  _deliveryWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, '[DeliveryWorker] Job failed');
  });

  logger.info(`[DeliveryWorker] Product delivery worker started on queue "${DELIVERY_QUEUE_NAME}"`);
  return _deliveryWorker;
}

// sendTelegramDeliveryAlert() removed in Sub-Phase 3C.
// Delivery failure alerts now route through notifyAdmin() in notificationService.ts,
// which handles Telegram, WhatsApp, and 'both' based on client.admin_channel_preference.

export async function stopDeliveryWorker(): Promise<void> {
  if (_deliveryWorker) {
    await _deliveryWorker.close();
    _deliveryWorker = null;
    logger.info('[DeliveryWorker] Stopped.');
  }
}
