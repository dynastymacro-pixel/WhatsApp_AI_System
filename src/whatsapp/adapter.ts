// src/whatsapp/adapter.ts
// BaileysAdapter — implements IWhatsAppAdapter using Baileys.
//
// This is the ONLY file in the codebase that imports from @whiskeysockets/baileys
// for sending messages. All other modules use IWhatsAppAdapter.
//
// QR code strategy (three layers, all active simultaneously):
//   1. ASCII art via qrcode-terminal → stdout (readable in a local terminal)
//   2. Raw QR string → logged via pino (searchable in Railway logs)
//   3. Browser-scannable image → GET /qr on QR_SERVER_PORT (reliable on Railway)
//
// Anti-ban measures:
//   1. Random typing delay (config.typingDelayMinMs – typingDelayMaxMs) before
//      every send, simulating human behaviour.
//   2. Daily conversation counter tracked (enforcement TBD Week 2).

import makeWASocket, {
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import { IWhatsAppAdapter, InboundMessage } from './types';
import { useSupabaseAuthState } from './auth';
import { setQrData, markPaired, resetPaired } from './qrServer';
import { config } from '../config';
import { logger } from '../utils/logger';

type InboundHandler = (msg: InboundMessage) => Promise<void>;

export class BaileysAdapter implements IWhatsAppAdapter {
  private sock: WASocket | null = null;
  private connected = false;
  private readonly clientId: string;
  private inboundHandlers: InboundHandler[] = [];
  private flushSession: (() => Promise<void>) | null = null;

  private healthCheckInterval: NodeJS.Timeout | null = null;
  private connectionPromise: Promise<void> | null = null;

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  /** Register a handler to be called when an inbound message arrives. */
  onInboundMessage(handler: InboundHandler): void {
    this.inboundHandlers.push(handler);
  }

  /** Returns the flushSession function for SIGTERM handling. */
  getFlushSession(): (() => Promise<void>) | null {
    // Clear health check interval on shutdown
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    return this.flushSession;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Sends a text message with a human-like typing delay and a 30s timeout.
   * NEVER call the underlying sock.sendMessage from outside this class.
   */
  async sendText(to: string, text: string): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error(
        `[BaileysAdapter] Cannot send message — not connected (clientId: ${this.clientId})`,
      );
    }

    // Anti-ban: random typing delay
    const delay = this.randomDelay(config.typingDelayMinMs, config.typingDelayMaxMs);
    await this.sleep(delay);

    const jid = this.toJid(to);

    // Explicit 30-second timeout for Baileys message delivery to prevent worker hangs
    const timeoutMs = 30000;
    const sendPromise = this.sock.sendMessage(jid, { text });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`[BaileysAdapter] sendMessage timed out after ${timeoutMs / 1000}s (clientId: ${this.clientId})`)),
        timeoutMs,
      ),
    );

    try {
      await Promise.race([sendPromise, timeoutPromise]);
    } catch (err: any) {
      // If it's our explicit timeout error, trigger a reconnect
      if (err.message?.includes('sendMessage timed out')) {
        logger.error(
          { err: err.message, clientId: this.clientId },
          '[BaileysAdapter] Message send timed out — marking disconnected and triggering reconnect',
        );
        this.disconnectAndReconnect();
      }
      throw err; // re-throw to propagate to BullMQ job handler
    }
  }

  /**
   * Proactively closes a dead socket and triggers a reconnect.
   * Leverages the existing socket lifecycle to prevent duplicate connect loops.
   */
  private disconnectAndReconnect(): void {
    if (!this.connected) return;

    logger.warn({ clientId: this.clientId }, '[WhatsApp] Triggering socket teardown and reconnection');
    this.connected = false;
    resetPaired();

    try {
      // end() cleanly terminates the WS and fires connection.update connection='close'
      this.sock?.end(new Error('Send timeout'));
    } catch (err: any) {
      logger.error({ err: err.message, clientId: this.clientId }, '[WhatsApp] Error ending socket; forcing reconnect');
      // If ending fails, invoke connect directly as fallback
      setTimeout(() => {
        this.connect().catch((e) => logger.error({ err: e.message }, '[WhatsApp] Fallback reconnect failed'));
      }, 5000);
    }
  }

  async connect(): Promise<void> {
    if (this.connectionPromise) {
      logger.info({ clientId: this.clientId }, '[WhatsApp] Connection already in progress — reusing promise');
      return this.connectionPromise;
    }

    this.connectionPromise = (async () => {
      // ── Connection Health logger (every 60s) ─────────────────────────────────
      if (!this.healthCheckInterval) {
        this.healthCheckInterval = setInterval(() => {
          logger.info(
            { clientId: this.clientId, connected: this.connected },
            `[WhatsApp] Healthcheck — Connection state: ${this.connected ? 'CONNECTED' : 'DISCONNECTED'}`,
          );
        }, 60000);
      }

      const { version } = await fetchLatestBaileysVersion();
      const { state, saveCreds, flushSession } = await useSupabaseAuthState(this.clientId);
      this.flushSession = flushSession;

      const baileysLogger = pino({ level: 'silent' }); // suppress Baileys internal noise

      const sock = makeWASocket({
        version,
        auth: state,
        logger: baileysLogger,
        printQRInTerminal: false, // we handle QR output ourselves (3 layers below)
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        keepAliveIntervalMs: 15000, // keep socket active / detect dead socket fast
      });

      this.sock = sock;

      // ── Auth state persistence ───────────────────────────────────────────────
      sock.ev.on('creds.update', saveCreds);

      // ── Connection & QR handling ─────────────────────────────────────────────
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          // ── Layer 1: ASCII art in stdout (works in local terminal) ───────────
          logger.info('[WhatsApp] Scan the QR code below (local terminal):');
          qrcodeTerminal.generate(qr, { small: true });

          // ── Layer 2: Raw QR string in structured log (searchable in Railway) ─
          logger.info(
            { qrRawString: qr },
            '[WhatsApp] Raw QR string logged — paste into https://www.qrserver.com if ASCII is unreadable',
          );

          // ── Layer 3: Browser image via /qr endpoint ──────────────────────────
          setQrData(qr);
          logger.info(
            { url: `http://localhost:${config.qrServerPort}/qr` },
            '[WhatsApp] Open /qr in your browser to scan a proper QR image',
          );
        }

        if (connection === 'open') {
          this.connected = true;
          markPaired();
          logger.info({ clientId: this.clientId }, '[WhatsApp] ✅ Connected');
        }

        if (connection === 'close') {
          this.connected = false;
          resetPaired();
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          logger.warn(
            { statusCode, shouldReconnect, clientId: this.clientId },
            '[WhatsApp] Connection closed',
          );

          if (shouldReconnect) {
            logger.info('[WhatsApp] Reconnecting in 5s...');
            setTimeout(() => {
              this.connect().catch((err: Error) => {
                logger.error({ err: err.message, clientId: this.clientId }, '[WhatsApp] Auto-reconnect failed');
              });
            }, 5000);
          } else {
            logger.error(
              '[WhatsApp] Logged out — clear wa_session_data in DB and restart to re-pair.',
            );
          }
        }
      });

      // ── Incoming messages ────────────────────────────────────────────────────
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return; // skip history sync bulk

        for (const msg of messages) {
          if (!msg.message || msg.key?.fromMe) continue; // skip our own sent messages

          const inbound = this.normaliseInbound(msg);
          if (!inbound) continue;

          for (const handler of this.inboundHandlers) {
            await handler(inbound).catch((err: Error) => {
              logger.error(
                { err: err.message, from: inbound.from },
                '[WhatsApp] Inbound handler error',
              );
            });
          }
        }
      });
    })();

    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private normaliseInbound(msg: proto.IWebMessageInfo): InboundMessage | null {
    // Guard: key must exist
    if (!msg.key) return null;

    // Bail out on status broadcasts
    let jid = msg.key.remoteJid ?? '';
    if (jid.endsWith('@broadcast') || jid === 'status@broadcast') return null;

    // Resolve LID (Linked Device ID) JIDs to the user's real phone JID (@s.whatsapp.net)
    if (jid.endsWith('@lid')) {
      const participantJid = msg.participant || msg.key.participant || '';
      if (participantJid.endsWith('@s.whatsapp.net')) {
        logger.info(
          { lidJid: jid, resolvedJid: participantJid },
          '[BaileysAdapter] Resolved real @s.whatsapp.net JID from participant metadata',
        );
        jid = participantJid;
      } else {
        logger.warn(
          { lidJid: jid, participant: participantJid },
          '[BaileysAdapter] Received JID from @lid but participant JID is not available or not @s.whatsapp.net',
        );
      }
    }

    const from = jid
      .replace('@s.whatsapp.net', '')
      .replace('@g.us', '')
      .replace('@lid', '');
    const waMessageId = msg.key.id ?? '';
    const timestampMs =
      typeof msg.messageTimestamp === 'number'
        ? msg.messageTimestamp * 1000
        : Date.now();

    if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
      return {
        waMessageId,
        from,
        contentType: 'text',
        text: msg.message.conversation ?? msg.message.extendedTextMessage?.text ?? '',
        timestampMs,
      };
    }

    if (msg.message?.imageMessage) {
      // TODO (Day 2+): Handle image messages (download media, run vision AI)
      logger.info({ from }, '[TODO] Image message received — not yet handled');
      return { waMessageId, from, contentType: 'image', text: '', timestampMs };
    }

    if (msg.message?.audioMessage) {
      // TODO (Day 2+): Handle voice notes (transcribe with Whisper)
      logger.info({ from }, '[TODO] Audio message received — not yet handled');
      return { waMessageId, from, contentType: 'audio', text: '', timestampMs };
    }

    // Any other message type — log and return for pipeline to record
    logger.info({ from }, '[TODO] Unknown message type received — not yet handled');
    return { waMessageId, from, contentType: 'unknown', text: '', timestampMs };
  }

  private toJid(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    return `${digits}@s.whatsapp.net`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private randomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
