// src/webhooks/baileys.ts
// Baileys "webhook" receiver — bridges Baileys events into our message pipeline.
//
// This is where Baileys-specific event data ends. The routeInboundMessage()
// function below receives only typed InboundMessage objects — no Baileys imports.

import { BaileysAdapter } from '../whatsapp/adapter';
import { routeInboundMessage } from '../router/messageRouter';

/**
 * Registers the inbound message handler on a BaileysAdapter.
 * The adapter normalises raw Baileys events into InboundMessage before calling
 * this handler — the handler itself has zero Baileys dependencies.
 */
export function registerBaileysWebhook(
  adapter: BaileysAdapter,
  clientId: string,
): void {
  adapter.onInboundMessage(async (msg) => {
    console.log(
      `[Webhook] Inbound message received: type=${msg.contentType}, ` +
      `from=${msg.from}, waId=${msg.waMessageId}`,
    );
    await routeInboundMessage(clientId, msg);
  });

  console.log(`[Webhook] Baileys webhook registered (clientId: ${clientId})`);
}
