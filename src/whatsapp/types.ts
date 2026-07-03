// src/whatsapp/types.ts
// WhatsApp adapter interface and shared message types.
// Business logic must ONLY depend on these types — never on Baileys types directly.

export interface InboundMessage {
  /** Unique WhatsApp message ID (from the WA platform) */
  waMessageId: string;
  /** Sender's phone number in full international format, e.g. "2348012345678" */
  from: string;
  /** Content type of the message */
  contentType: 'text' | 'image' | 'audio' | 'video' | 'document' | 'unknown';
  /** Text content (populated for text messages; empty string for other types) */
  text: string;
  /** Epoch milliseconds of the message timestamp */
  timestampMs: number;
}

export interface OutboundMessage {
  /** Recipient phone number in full international format */
  to: string;
  /** Text to send */
  text: string;
}

/**
 * IWhatsAppAdapter — the only interface that queue workers, routers, and
 * handlers may use to interact with WhatsApp. Baileys is an implementation
 * detail hidden behind this interface.
 *
 * When migrating to the Meta Cloud API, implement this interface in a new
 * adapter class without touching any other part of the codebase.
 */
export interface IWhatsAppAdapter {
  /**
   * Sends a text message to the given recipient.
   * Anti-ban delay is applied inside the adapter before dispatching.
   */
  sendText(to: string, text: string): Promise<void>;

  /**
   * Indicates whether the adapter is currently connected and ready to send.
   */
  isConnected(): boolean;
}
