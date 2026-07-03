// src/queue/types.ts
// BullMQ job payload types for the outgoing message queue.
// All queue jobs must use these types — never pass raw strings.

export const OUTGOING_MESSAGE_JOB = 'send-whatsapp-message' as const;

export interface OutgoingMessageJobData {
  /** The tenant this message belongs to */
  clientId: string;
  /** Recipient phone number (full international format, no +) */
  to: string;
  /** Text content to send */
  text: string;
  /** The wa_message_id of the inbound message this is replying to (for logging) */
  replyToWaMessageId?: string;
  /** customerId in our DB (used to log the outbound message) */
  customerId: string;
}
