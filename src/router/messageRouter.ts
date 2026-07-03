// src/router/messageRouter.ts
// Message Router — the single decision point for what happens to each inbound message.
//
// Day 1 behaviour:
//   1. Find or create the customer record (multi-tenant, by phone + clientId)
//   2. Touch their last_seen timestamp
//   3. Log the inbound message to the DB
//   4. If the message is text, enqueue an echo reply via the outgoing queue
//   5. Non-text messages are already logged with a TODO note in the adapter

import { CustomerRepository } from '../db/repositories/CustomerRepository';
import { MessageRepository } from '../db/repositories/MessageRepository';
import { getSupabaseClient } from '../db/supabase';
import { enqueueOutgoingMessage } from '../queue/client';
import { InboundMessage } from '../whatsapp/types';

const customerRepo = new CustomerRepository(getSupabaseClient());
const messageRepo = new MessageRepository(getSupabaseClient());

export async function routeInboundMessage(
  clientId: string,
  msg: InboundMessage,
): Promise<void> {
  // ── 1. Find or create customer ────────────────────────────────────────────
  const customer = await customerRepo.findOrCreate(clientId, msg.from);

  // ── 2. Touch last_seen ────────────────────────────────────────────────────
  await customerRepo.touchLastSeen(clientId, customer.id);

  // ── 3. Log inbound message ────────────────────────────────────────────────
  await messageRepo.logMessage({
    clientId,
    customerId: customer.id,
    direction: 'inbound',
    contentType: msg.contentType,
    content: msg.text || `[${msg.contentType}]`,
    waMessageId: msg.waMessageId,
  });

  console.log(
    `[Router] Inbound ${msg.contentType} from ${msg.from} logged ` +
    `(customerId: ${customer.id}, clientId: ${clientId})`,
  );

  // ── 4. Route by content type ──────────────────────────────────────────────
  if (msg.contentType === 'text' && msg.text.trim()) {
    // Day 1: Echo the message back through the queue
    await enqueueOutgoingMessage({
      clientId,
      to: msg.from,
      text: `Received: ${msg.text}`,
      customerId: customer.id,
      replyToWaMessageId: msg.waMessageId,
    });

    console.log(`[Router] Echo reply enqueued for ${msg.from}`);
    return;
  }

  // Non-text: already logged above, no action today
  console.log(
    `[Router] Non-text message (${msg.contentType}) from ${msg.from} — ` +
    `no action taken (TODO: handle in future day)`,
  );
}
