// src/services/notificationService.ts
// Sub-Phase 3C — Admin notification dispatcher.
//
// Single public entry point: notifyAdmin(event, clientId, payload)
// Routes alerts to Telegram, WhatsApp, or both based on client.admin_channel_preference.
//
// Channel routing rules:
//   'telegram'  → Telegram only
//   'whatsapp'  → WhatsApp; falls back to Telegram if adapter is offline and Telegram is configured
//   'both'      → both channels concurrently (Promise.allSettled); one failure doesn't block the other
//
// Quota: notification_quota_used is incremented by 1 per notifyAdmin() call,
//        regardless of how many channels fired (quota tracks notification volume, not channel cost).
//
// Audit: every call writes one row to admin_notification_log (status: sent | failed | skipped).
//
// Backwards-compat shim: notifyAdminOfScreenshot() remains exported with its original signature
// so messageRouter.ts requires no changes.
//
// TODO (Phase 3C quota auto-reset): reset notification_quota_used when notification_quota_reset_at < NOW().

import { getSupabaseClient } from '../db/supabase';
import { getWhatsAppClient }  from '../whatsapp/manager';
import { logger }             from '../utils/logger';

// ── Public event types ────────────────────────────────────────────────────────

export type AdminNotifyEvent =
  | 'screenshot_received'
  | 'delivery_failure'
  | 'order_created';

export interface AdminNotifyPayload {
  orderId:        string;
  customerPhone?: string;       // E.164 phone string; optional on delivery_failure
  productName?:   string | null;
  agreedPrice?:   number;
  details?:       string;       // free-text detail line; used by delivery_failure
}

// ── Backwards-compat shim (messageRouter.ts uses this — do not change signature) ──

export interface OrderNotificationDetails {
  orderId:              string;
  customerPhone:        string;
  productId:            string | null;
  agreedPrice:          number;
  screenshotReceivedAt: string | null;
}

/**
 * Backwards-compatible shim kept so messageRouter.ts needs no changes.
 * Delegates to notifyAdmin('screenshot_received', ...).
 */
export async function notifyAdminOfScreenshot(
  clientId: string,
  order:    OrderNotificationDetails,
): Promise<void> {
  // Best-effort product name resolution (same as original implementation)
  const supabase = getSupabaseClient();
  let productName: string | null = null;
  if (order.productId) {
    const { data: product } = await supabase
      .from('products')
      .select('name')
      .eq('id',        order.productId)
      .eq('client_id', clientId)
      .maybeSingle();
    productName = (product as { name: string } | null)?.name ?? null;
  }

  await notifyAdmin('screenshot_received', clientId, {
    orderId:       order.orderId,
    customerPhone: order.customerPhone,
    productName,
    agreedPrice:   order.agreedPrice,
  });
}

// ── Internal types ────────────────────────────────────────────────────────────

interface ClientAlertSettings {
  admin_channel_preference:     string;   // 'telegram' | 'whatsapp' | 'both'
  admin_whatsapp_number:        string | null;
  wa_phone_number_id:           string | null;
  telegram_chat_id:             string | null;
  telegram_bot_token_secret_id: string | null;
  notification_quota_used:      number;
  notification_quota_reset_at:  string | null;
  notification_tier:            string;
}

export const TIER_LIMITS: Record<string, number> = {
  free: 30,
  standard: 180,
  pro: 300,
  ultra: 3000,
};

// ── Main dispatcher ───────────────────────────────────────────────────────────

/**
 * Send an admin alert for the given event.
 * Fire-and-forget safe — never throws; all errors are logged and written to audit log.
 */
export async function notifyAdmin(
  event:    AdminNotifyEvent,
  clientId: string,
  payload:  AdminNotifyPayload,
): Promise<void> {
  const supabase = getSupabaseClient();

  try {
    // ── 1. Fetch client alert settings ───────────────────────────────────────
    const { data: client, error: clientErr } = await supabase
      .from('clients')
      .select(
        'admin_channel_preference, admin_whatsapp_number, wa_phone_number_id, ' +
        'telegram_chat_id, telegram_bot_token_secret_id, ' +
        'notification_quota_used, notification_quota_reset_at, notification_tier',
      )
      .eq('id', clientId)
      .single();

    if (clientErr || !client) {
      logger.warn({ clientId, err: clientErr?.message },
        '[Notify] Could not fetch client settings — skipping');
      return;
    }

    const c = client as unknown as ClientAlertSettings;

    // ── 1.5. Auto-Reset Logic ────────────────────────────────────────────────
    const now = new Date();
    const resetAt = c.notification_quota_reset_at ? new Date(c.notification_quota_reset_at) : null;
    if (!resetAt || resetAt < now) {
      const nextReset = new Date();
      nextReset.setMonth(nextReset.getMonth() + 1); // 1 month rolling reset

      const { error: resetErr } = await supabase
        .from('clients')
        .update({
          notification_quota_used: 0,
          notification_quota_reset_at: nextReset.toISOString(),
        })
        .eq('id', clientId);

      if (!resetErr) {
        c.notification_quota_used = 0;
        c.notification_quota_reset_at = nextReset.toISOString();
        logger.info({ clientId, nextReset: nextReset.toISOString() }, '[Notify] Monthly quota reset triggered successfully');
      } else {
        logger.error({ clientId, err: resetErr.message }, '[Notify] Failed to reset client notification quota');
      }
    }

    // ── 2. Quota gate ─────────────────────────────────────────────────────────
    const tier = c.notification_tier || 'free';
    const quotaLimit = TIER_LIMITS[tier] ?? TIER_LIMITS.free;

    if (c.notification_quota_used >= quotaLimit) {
      logger.warn(
        { clientId, used: c.notification_quota_used, limit: quotaLimit, tier },
        '[Notify] Monthly quota exceeded — skipping notification',
      );
      await writeAuditLog(supabase, clientId, event, 'skipped', payload.orderId, null,
        'skipped', 'quota_exceeded');
      return;
    }

    // Ultra Tier rolling 24h safety limit (100 notifications/day cap)
    if (tier === 'ultra') {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count, error: dailyCountErr } = await supabase
        .from('admin_notification_log')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', clientId)
        .eq('status', 'sent')
        .gte('sent_at', oneDayAgo);

      if (dailyCountErr) {
        logger.error({ clientId, err: dailyCountErr.message }, '[Notify] Failed to check daily rolling count for Ultra tier');
      } else if (count !== null && count >= 100) {
        logger.warn(
          { clientId, dailyCount: count },
          '[Notify] Daily safety limit of 100 alerts exceeded for Ultra tier — skipping notification',
        );
        await writeAuditLog(supabase, clientId, event, 'skipped', payload.orderId, null,
          'skipped', 'daily_limit_exceeded');
        return;
      }
    }

    // ── 3. Build message text ─────────────────────────────────────────────────
    const messageText = buildAlertText(event, payload);
    const pref        = c.admin_channel_preference ?? 'telegram';

    // ── 4. Fire channels ──────────────────────────────────────────────────────
    const channelsFired: string[] = [];
    const errors: string[] = [];
    let   overallStatus: 'sent' | 'failed' | 'skipped' = 'sent';
    let   failureReason: string | null = null;

    // Same-Number Detection (Self-Chat)
    let isSelfChat = false;
    if (c.admin_whatsapp_number) {
      const cleanAdmin = c.admin_whatsapp_number.replace(/\D/g, '');
      let cleanOwn: string | null = null;
      if (c.wa_phone_number_id) {
        cleanOwn = c.wa_phone_number_id.replace(/\D/g, '');
      } else {
        // Fallback: check active adapter in memory
        try {
          const adapter = getWhatsAppClient(clientId);
          if (adapter && adapter.isConnected()) {
            const ownJid = adapter.getOwnJid();
            if (ownJid) {
              cleanOwn = ownJid.split('@')[0].split(':')[0].replace(/\D/g, '');
            }
          }
        } catch {
          // No active adapter in memory
        }
      }
      if (cleanOwn && cleanOwn === cleanAdmin) {
        isSelfChat = true;
        logger.info({ clientId }, '[Notify] Same-number self-chat detected (bot number matches admin number)');
      }
    }

    // ── Telegram path ─────────────────────────────────────────────────────────
    if (pref === 'telegram' || pref === 'both') {
      try {
        await sendTelegramAlert(clientId, c, messageText);
        channelsFired.push('telegram');
      } catch (err: any) {
        logger.error({ clientId, event, err: err.message }, '[Notify] Telegram alert failed');
        errors.push(`telegram: ${err.message}`);
      }
    }

    // ── WhatsApp path (with Telegram fallback if adapter offline) ────────────
    if (pref === 'whatsapp' || pref === 'both') {
      if (!c.admin_whatsapp_number) {
        logger.warn({ clientId }, '[Notify] admin_whatsapp_number not set — skipping WA alert');
      } else {
        let waSent = false;
        try {
          await sendWhatsAppAlert(clientId, c.admin_whatsapp_number, messageText);
          channelsFired.push('whatsapp');
          waSent = true;
        } catch (waErr: any) {
          logger.warn(
            { clientId, event, err: waErr.message },
            '[Notify] WhatsApp alert failed — checking Telegram fallback',
          );
          errors.push(`whatsapp: ${waErr.message}`);

          // Fall back to Telegram if credentials are configured
          if (pref === 'whatsapp' && c.telegram_chat_id && c.telegram_bot_token_secret_id) {
            try {
              await sendTelegramAlert(clientId, c, messageText);
              channelsFired.push('telegram_fallback');
              waSent = true; // treat fallback success as overall success
            } catch (tgFallbackErr: any) {
              logger.error(
                { clientId, event, err: tgFallbackErr.message },
                '[Notify] Telegram fallback also failed',
              );
              errors.push(`telegram_fallback: ${tgFallbackErr.message}`);
            }
          }
        }

        // Forced Telegram fallback for Same-Number Self-Chats (only for WhatsApp preference,
        // since Telegram already ran for 'both')
        if (waSent && isSelfChat && pref === 'whatsapp') {
          if (c.telegram_chat_id && c.telegram_bot_token_secret_id) {
            try {
              await sendTelegramAlert(clientId, c, messageText);
              channelsFired.push('telegram_selfchat_fallback');
            } catch (tgSelfErr: any) {
              logger.error({ clientId, event, err: tgSelfErr.message }, '[Notify] Telegram self-chat fallback failed');
              errors.push(`telegram_selfchat_fallback: ${tgSelfErr.message}`);
            }
          } else {
            logger.warn({ clientId }, '[Notify] Same-number self-chat with no Telegram configured — push notifications will not work');
            errors.push('self_chat_no_push');
          }
        }
      }
    }

    if (channelsFired.length === 0) {
      overallStatus = 'failed';
      failureReason = errors.length > 0 ? errors.join(', ') : 'no_channel_configured';
    } else {
      overallStatus = 'sent';
      if (errors.length > 0) {
        failureReason = `partial_failure: ${errors.join(', ')}`;
      } else if (channelsFired.includes('whatsapp') && isSelfChat && pref === 'whatsapp' && !c.telegram_chat_id) {
        failureReason = 'self_chat_no_push';
      }
    }

    const channelLabel = channelsFired.join('+') || 'none';

    logger.info(
      { clientId, event, channels: channelLabel, status: overallStatus },
      '[Notify] Admin notification complete',
    );

    // ── 5. Increment quota (1 unit regardless of channel count) ───────────────
    if (overallStatus === 'sent') {
      const { error: quotaErr } = await supabase
        .from('clients')
        .update({ notification_quota_used: c.notification_quota_used + 1 })
        .eq('id', clientId);

      if (quotaErr) {
        logger.warn({ clientId, err: quotaErr.message },
          '[Notify] Failed to increment notification_quota_used');
      }
    }

    // ── 6. Write audit log ────────────────────────────────────────────────────
    await writeAuditLog(
      supabase, clientId, event, channelLabel,
      payload.orderId, payload,
      overallStatus, failureReason,
    );

  } catch (err) {
    // Outer catch: must never propagate into customer-facing flows
    logger.error({ clientId, event, err },
      '[Notify] Unexpected error in notifyAdmin — notification silently skipped');
  }
}

// ── Private channel senders ───────────────────────────────────────────────────

/**
 * Converts simple Markdown formatting (*bold*, _italic_, `code`) to Telegram-compatible HTML tags
 * and escapes special HTML entities (&, <, >) to prevent parse errors.
 */
function formatForTelegram(text: string): string {
  // First escape HTML special characters
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  // Replace Markdown-like symbols with HTML tags
  // Bold: *text* -> <b>text</b>
  html = html.replace(/\*(.*?)\*/g, '<b>$1</b>');
  // Italic: _text_ -> <i>text</i>
  html = html.replace(/_(.*?)_/g, '<i>$1</i>');
  // Code: `text` -> <code>text</code>
  html = html.replace(/`(.*?)`/g, '<code>$1</code>');
  
  return html;
}

/**
 * Sends an alert via Telegram bot using HTML parse mode for robust formatting.
 * Throws on failure — caller handles retry/fallback logic.
 */
async function sendTelegramAlert(
  clientId: string,
  c:        ClientAlertSettings,
  text:     string,
): Promise<void> {
  if (!c.telegram_chat_id) {
    throw new Error('telegram_chat_id not configured');
  }
  if (!c.telegram_bot_token_secret_id) {
    throw new Error('telegram_bot_token_secret_id not configured');
  }

  const supabase = getSupabaseClient();
  const { data: botToken, error: decErr } = await supabase.rpc('get_decrypted_secret', {
    secret_name: `telegram_token_${clientId}`,
  });

  if (decErr || !botToken) {
    throw new Error(`Failed to decrypt bot token: ${decErr?.message ?? 'empty result'}`);
  }

  const htmlText = formatForTelegram(text);

  const tgResponse = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    c.telegram_chat_id,
        text:       htmlText,
        parse_mode: 'HTML',
      }),
    },
  );

  if (!tgResponse.ok) {
    const body = await tgResponse.text();
    throw new Error(`Telegram API error ${tgResponse.status}: ${body}`);
  }
}

/**
 * Sends an alert to the admin's own WhatsApp number via the Baileys adapter.
 * Throws on failure — caller handles retry/fallback logic.
 * Does NOT log to the messages table (no customer_id / conversation_id context).
 */
async function sendWhatsAppAlert(
  clientId:   string,
  adminPhone: string,
  text:       string,
): Promise<void> {
  const adapter = getWhatsAppClient(clientId);

  if (!adapter.isConnected()) {
    throw new Error('WhatsApp adapter not connected');
  }

  await adapter.sendText(adminPhone, text);
}

// ── Alert text builder ────────────────────────────────────────────────────────

/**
 * Builds the alert message text for a given event.
 * Returns Markdown-formatted text (works for both Telegram and WhatsApp plain text).
 */
function buildAlertText(event: AdminNotifyEvent, payload: AdminNotifyPayload): string {
  switch (event) {
    case 'screenshot_received': {
      return [
        '🔔 *New Payment Screenshot Received*',
        '',
        `📦 *Product:* ${payload.productName ?? '_(not found)_'}`,
        `💰 *Price:*   PKR ${Number(payload.agreedPrice ?? 0).toLocaleString()}`,
        `📞 *Customer:* ${payload.customerPhone ?? 'unknown'}`,
        '',
        '_Open the ZapSell dashboard to approve or reject._',
      ].join('\n');
    }

    case 'delivery_failure': {
      return [
        '🚨 *ZapSell Product Delivery Failure*',
        '',
        `*Order ID:* \`${payload.orderId}\``,
        `*Details:* ${payload.details ?? 'Unknown error'}`,
        '',
        '_Manual attention is required. Open the dashboard to retry._',
      ].join('\n');
    }

    case 'order_created': {
      return [
        '🆕 *New Order Received*',
        '',
        `📦 *Product:* ${payload.productName ?? '_(unknown)_'}`,
        `💰 *Price:*   PKR ${Number(payload.agreedPrice ?? 0).toLocaleString()}`,
        `📞 *Customer:* ${payload.customerPhone ?? 'unknown'}`,
        '',
        '_Open the ZapSell dashboard to review._',
      ].join('\n');
    }
  }
}

// ── Audit log writer ──────────────────────────────────────────────────────────

/**
 * Writes one row to admin_notification_log.
 * Best-effort — failure logged but never re-thrown.
 * payload JSONB stores only sanitised metadata (no credentials, no Vault secrets).
 */
async function writeAuditLog(
  supabase:      ReturnType<typeof getSupabaseClient>,
  clientId:      string,
  event:         AdminNotifyEvent,
  channel:       string,
  orderId:       string,
  payload:       AdminNotifyPayload | null,
  status:        'sent' | 'failed' | 'skipped',
  failureReason: string | null,
): Promise<void> {
  // Sanitise payload: include only non-sensitive fields
  const sanitisedPayload = payload ? {
    event_type:     event,
    customer_phone: payload.customerPhone ?? null,
    product_name:   payload.productName   ?? null,
    agreed_price:   payload.agreedPrice   ?? null,  // admin-visible; scoped per client_id
    // details field intentionally omitted — may contain raw error strings
  } : null;

  const { error } = await supabase
    .from('admin_notification_log')
    .insert({
      client_id:      clientId,
      event_type:     event,
      channel,
      order_id:       orderId,
      payload:        sanitisedPayload,
      status,
      failure_reason: failureReason,
    });

  if (error) {
    logger.warn({ clientId, event, err: error.message },
      '[Notify] Failed to write admin_notification_log row');
  }
}
