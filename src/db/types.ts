// src/db/types.ts
// TypeScript interfaces mirroring the Supabase database schema.
// Keep in sync with schema.sql.

// ── Enums ─────────────────────────────────────────────────────────────────────

export type AdminChannelPreference  = 'telegram' | 'whatsapp' | 'both';

// NOTE: bot_mode is BOOLEAN for now.
// Future migration target: 'manual' | 'scheduled_auto' | 'timeout_auto'
// Do NOT branch on bot_mode string values until the enum migration is complete.
export type BotMode = boolean;

export type MessageDirection       = 'inbound' | 'outbound';
export type StockStatus            = 'available' | 'out_of_stock';
export type DeliveryType           = 'digital_link' | 'manual' | 'inventory';
export type ConversationStatus     = 'active' | 'negotiating' | 'awaiting_payment' | 'closed';
export type ConversationRole       = 'customer' | 'ai' | 'system';
export type OrderApprovalStatus    = 'pending' | 'approved' | 'rejected' | 'superseded';
export type NotificationChannel    = 'dashboard' | 'telegram' | 'whatsapp';
export type NotificationTier       = 'free' | 'pro' | 'ultra';

// ── Entities ──────────────────────────────────────────────────────────────────

export interface Client {
  id: string;
  business_name: string;
  wa_phone_number_id: string | null;
  wa_session_data: Record<string, unknown> | null;
  telegram_chat_id: string | null;
  admin_whatsapp_number: string | null;
  admin_channel_preference: AdminChannelPreference;
  bot_mode: BotMode;
  payment_details: string | null;
  custom_instructions: string | null;          // supplementary tone/style notes for the bot
  // Phase 1: tier & notification settings (schema only — no logic yet)
  notification_tier: NotificationTier;
  notification_channel: NotificationChannel;
  telegram_bot_token_secret_id: string | null; // UUID ref to vault.secrets
  notification_quota_used: number;
  notification_quota_reset_at: string | null;
  created_at: string;
}

export interface Customer {
  id: string;
  client_id: string;
  phone_number: string;
  preferred_language: string | null;
  first_contact_at: string;
  last_message_at: string;
}

export interface Message {
  id: string;
  client_id: string;
  customer_id: string;
  direction: MessageDirection;
  content_type: string;
  content: string;
  wa_message_id: string;
  timestamp: string;
}

export interface Product {
  id: string;
  client_id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  min_price: number;
  stock_status: StockStatus;
  delivery_type: DeliveryType;
  delivery_content: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  client_id: string;
  customer_id: string;
  status: ConversationStatus;
  current_product_id: string | null;
  negotiation_rounds: number;
  current_offer: number | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  client_id: string;
  role: ConversationRole;
  content: string;
  created_at: string;
}

// ── Phase 1: Orders ───────────────────────────────────────────────────────────
// Durable record for each payment/approval cycle.
// Separate from conversations: conversations track dialogue state,
// orders track commercial/approval state.

export interface Order {
  id: string;
  client_id: string;
  customer_id: string;
  conversation_id: string;
  product_id: string | null;           // nullable: product deleted after order creation
  agreed_price: number;
  screenshot_received_at: string | null;
  approval_status: OrderApprovalStatus;
  approved_by: string | null;          // admin identifier (Telegram user, WA number, etc.)
  approved_at: string | null;
  notification_channel_used: NotificationChannel | null;
  delivery_status: 'not_applicable' | 'pending' | 'delivered' | 'failed';
  delivery_attempts: number;
  delivered_at: string | null;
  delivery_locked_at: string | null;
  delivery_item_id: string | null;
  created_at: string;
}

export interface ProductDeliveryItem {
  id: string;
  product_id: string;
  content_encrypted: string; // secret_name in Vault
  status: 'available' | 'reserved' | 'delivered';
  order_id: string | null;
  reserved_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

// ── Phase 3C: Admin Notification Log ──────────────────────────────────────────
// Append-only audit trail for every admin alert attempted.
// RLS: service_role only. Any dashboard read path must add client-scoped policy first.

export interface AdminNotificationLog {
  id:             string;
  client_id:      string;
  event_type:     'screenshot_received' | 'delivery_failure' | 'order_created';
  channel:        string;  // 'telegram' | 'whatsapp' | 'both' | 'telegram_fallback' | 'skipped'
  order_id:       string | null;
  payload:        Record<string, unknown> | null;
  status:         'sent' | 'failed' | 'skipped';
  failure_reason: string | null;
  sent_at:        string;
}
