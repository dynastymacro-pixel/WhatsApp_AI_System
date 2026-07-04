// src/services/notificationService.ts
// Phase 3B — Telegram screenshot notification.
//
// Called fire-and-forget from messageRouter.ts after markScreenshotReceived()
// stamps the order. Any error here must never propagate into the customer-facing
// message flow — the outer try/catch guarantees that.
//
// Notification gate (all must pass to send):
//   1. notification_channel === 'telegram'
//   2. telegram_chat_id is not null
//   3. telegram_bot_token_secret_id is not null
//   4. notification_quota_used < PRO_QUOTA_LIMIT (100/month, Phase 3B default)
//
// TODO (Phase 3C): auto-reset quota when notification_quota_reset_at < NOW().

import { getSupabaseClient } from '../db/supabase';
import { logger }            from '../utils/logger';

export interface OrderNotificationDetails {
  orderId:              string;
  customerPhone:        string;   // msg.from in the router
  productId:            string | null;
  agreedPrice:          number;
  screenshotReceivedAt: string | null;
}

// Shape of the columns we SELECT from clients
interface ClientNotifySettings {
  notification_channel:          string;
  telegram_chat_id:              string | null;
  telegram_bot_token_secret_id:  string | null;
  notification_quota_used:       number;
  notification_quota_reset_at:   string | null;
}

const PRO_QUOTA_LIMIT = 100; // max Telegram notifications per month

export async function notifyAdminOfScreenshot(
  clientId: string,
  order:    OrderNotificationDetails,
): Promise<void> {
  const supabase = getSupabaseClient();

  try {
    // ── 1. Fetch the client's notification settings ───────────────────────
    const { data: client, error: clientErr } = await supabase
      .from('clients')
      .select(
        'notification_channel, telegram_chat_id, telegram_bot_token_secret_id, ' +
        'notification_quota_used, notification_quota_reset_at',
      )
      .eq('id', clientId)
      .single();

    if (clientErr || !client) {
      logger.warn({ clientId, err: clientErr?.message },
        '[Notify] Could not fetch client settings — skipping');
      return;
    }

    const c = client as unknown as ClientNotifySettings;

    // ── 2. Channel gate ───────────────────────────────────────────────────
    if (c.notification_channel !== 'telegram') {
      logger.info({ clientId, channel: c.notification_channel },
        '[Notify] notification_channel is not telegram — skipping');
      return;
    }
    if (!c.telegram_chat_id) {
      logger.info({ clientId }, '[Notify] telegram_chat_id not configured — skipping');
      return;
    }
    if (!c.telegram_bot_token_secret_id) {
      logger.info({ clientId }, '[Notify] telegram_bot_token_secret_id not set — skipping');
      return;
    }

    // ── 3. Quota gate ─────────────────────────────────────────────────────
    // TODO: reset quota if notification_quota_reset_at is in the past
    if (c.notification_quota_used >= PRO_QUOTA_LIMIT) {
      logger.warn(
        { clientId, used: c.notification_quota_used, limit: PRO_QUOTA_LIMIT },
        '[Notify] Monthly quota exceeded — skipping notification',
      );
      return;
    }

    // ── 4. Decrypt bot token via public.get_decrypted_secret() wrapper ────
    // Vault secret name convention: telegram_token_<clientId>
    const { data: botToken, error: decryptErr } = await supabase.rpc(
      'get_decrypted_secret',
      { secret_name: `telegram_token_${clientId}` },
    );

    if (decryptErr || !botToken) {
      logger.error({ clientId, err: decryptErr?.message },
        '[Notify] Failed to decrypt bot token — skipping notification');
      return;
    }

    // ── 5. Look up product name (best-effort — null if product deleted) ────
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

    // ── 6. Build and send the Telegram message ────────────────────────────
    const receivedAt = order.screenshotReceivedAt
      ? new Date(order.screenshotReceivedAt).toLocaleString('en-GB', {
          timeZone:     'Asia/Karachi',
          day:          '2-digit',
          month:        'short',
          year:         'numeric',
          hour:         '2-digit',
          minute:       '2-digit',
        })
      : 'Unknown';

    const messageText = [
      '🔔 *New Payment Screenshot Received*',
      '',
      `📦 *Product:* ${productName ?? '_(not found)_'}`,
      `💰 *Price:*   PKR ${Number(order.agreedPrice).toLocaleString()}`,
      `📞 *Customer:* ${order.customerPhone}`,
      `🕐 *Received:* ${receivedAt}`,
      '',
      '_Open the ZapSell dashboard to approve or reject._',
    ].join('\n');

    const tgApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const tgResponse = await fetch(tgApiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    c.telegram_chat_id,
        text:       messageText,
        parse_mode: 'Markdown',
      }),
    });

    if (!tgResponse.ok) {
      const body = await tgResponse.text();
      logger.error(
        { clientId, orderId: order.orderId, status: tgResponse.status, body },
        '[Notify] Telegram API error',
      );
      return;
    }

    logger.info(
      { clientId, orderId: order.orderId, chatId: c.telegram_chat_id },
      '[Notify] Telegram notification sent ✓',
    );

    // ── 7. Increment quota_used (best-effort — don't fail the notification) ─
    const { error: quotaErr } = await supabase
      .from('clients')
      .update({ notification_quota_used: c.notification_quota_used + 1 })
      .eq('id', clientId);

    if (quotaErr) {
      logger.warn({ clientId, err: quotaErr.message },
        '[Notify] Failed to increment notification_quota_used');
    }

  } catch (err) {
    // Any uncaught error here must never reach the customer-facing flow.
    logger.error({ clientId, orderId: order.orderId, err },
      '[Notify] Unexpected error — notification silently skipped');
  }
}
