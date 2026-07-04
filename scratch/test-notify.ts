/**
 * scratch/test-notify.ts
 * ─────────────────────────────────────────────────────────────────
 * Phase 3B — Standalone Telegram notification end-to-end test.
 *
 * Tests the full path WITHOUT importing the service module (avoids
 * needing REDIS_URL, GEMINI_API_KEY, etc. in .env at test time):
 *   1. Fetch client's telegram_chat_id from Supabase
 *   2. Decrypt the bot token via public.get_decrypted_secret() RPC
 *   3. POST a test message to Telegram's sendMessage API
 *   4. Report HTTP status and Telegram API response
 *
 * HOW TO RUN (from repo root):
 *   npx tsx scratch/test-notify.ts
 *
 * PREREQUISITES:
 *   - .env must have SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEFAULT_CLIENT_ID
 *   - The client row must have telegram_chat_id set
 *   - The client must have a bot token stored in Vault
 *     (use the dashboard /settings page, or run create_secret manually)
 *   - notification_channel in clients does NOT need to be 'telegram' for this test
 *     (this script bypasses that gate intentionally)
 * ─────────────────────────────────────────────────────────────────
 */

import * as dotenv from 'dotenv';
import * as path   from 'path';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLIENT_ID                 = process.env.DEFAULT_CLIENT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('Missing DEFAULT_CLIENT_ID in .env');
  process.exit(1);
}

// Fake order details — nothing touches real DB tables beyond the client read
const FAKE_ORDER = {
  orderId:              'test-order-00000000',
  customerPhone:        '+92300000000',
  productName:          'Test Product (Phase 3B Notification Test)',
  agreedPrice:          4999,
  screenshotReceivedAt: new Date().toISOString(),
};

async function main() {
  console.log('━━━ ZapSell Telegram notification test ━━━\n');
  console.log(`  Client ID : ${CLIENT_ID}`);
  console.log(`  Supabase  : ${SUPABASE_URL}\n`);

  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── STEP 1: Fetch client's Telegram config ────────────────────────────────
  console.log('1. Fetching client Telegram config...');

  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('telegram_chat_id, telegram_bot_token_secret_id, notification_channel')
    .eq('id', CLIENT_ID)
    .single();

  if (clientErr || !client) {
    console.error('   ✗ FAILED:', clientErr?.message ?? 'no row returned');
    process.exit(1);
  }

  console.log(`   notification_channel         : ${client.notification_channel}`);
  console.log(`   telegram_chat_id             : ${client.telegram_chat_id ?? '(not set)'}`);
  console.log(`   telegram_bot_token_secret_id : ${client.telegram_bot_token_secret_id ?? '(not set)'}`);

  if (!client.telegram_chat_id) {
    console.error('\n   ✗ telegram_chat_id is not set. Configure it in the dashboard /settings page first.');
    process.exit(1);
  }
  if (!client.telegram_bot_token_secret_id) {
    console.error('\n   ✗ telegram_bot_token_secret_id is not set. Save a bot token in /settings first.');
    process.exit(1);
  }

  console.log('   ✓ config present\n');

  // ── STEP 2: Decrypt bot token ─────────────────────────────────────────────
  console.log('2. Decrypting bot token via get_decrypted_secret()...');

  const { data: botToken, error: decryptErr } = await supabase.rpc(
    'get_decrypted_secret',
    { secret_name: `telegram_token_${CLIENT_ID}` },
  );

  if (decryptErr || !botToken) {
    console.error('   ✗ FAILED:', decryptErr?.message ?? 'null token returned');
    console.error('\n   Ensure the secret was stored with name: telegram_token_' + CLIENT_ID);
    process.exit(1);
  }

  // Show only first 10 chars — never log the full token
  console.log(`   ✓ token decrypted (first 10 chars): ${String(botToken).slice(0, 10)}...\n`);

  // ── STEP 3: Send Telegram test message ────────────────────────────────────
  console.log('3. Sending test message to Telegram...');

  const receivedAt = new Date(FAKE_ORDER.screenshotReceivedAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const messageText = [
    '🧪 *\\[TEST\\] New Payment Screenshot Received*',
    '',
    `📦 *Product:* ${FAKE_ORDER.productName}`,
    `💰 *Price:*   PKR ${FAKE_ORDER.agreedPrice.toLocaleString()}`,
    `📞 *Customer:* ${FAKE_ORDER.customerPhone}`,
    `🕐 *Received:* ${receivedAt}`,
    '',
    '_This is a Phase 3B test message — no real order exists._',
  ].join('\n');

  const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const tgRes = await fetch(tgUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:    client.telegram_chat_id,
      text:       messageText,
      parse_mode: 'MarkdownV2',
    }),
  });

  const tgBody = await tgRes.json() as { ok: boolean; description?: string; result?: unknown };

  if (!tgRes.ok || !tgBody.ok) {
    console.error(`   ✗ Telegram API error (HTTP ${tgRes.status}):`, tgBody.description ?? JSON.stringify(tgBody));
    process.exit(1);
  }

  console.log(`   ✓ HTTP ${tgRes.status} — Telegram API returned ok: true`);
  console.log('\n━━━ Test complete. ━━━');
  console.log('Check your Telegram chat — you should see the [TEST] notification message.');
  console.log('Reply here to confirm you received it.\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
