// src/db/types.ts
// TypeScript interfaces mirroring the Supabase database schema.
// Keep in sync with schema.sql.

export type AdminChannelPreference = 'telegram' | 'whatsapp' | 'both';

// NOTE: bot_mode is BOOLEAN for now.
// Future migration target: 'manual' | 'scheduled_auto' | 'timeout_auto'
// Do NOT branch on bot_mode string values until the enum migration is complete.
export type BotMode = boolean;

export type MessageDirection = 'inbound' | 'outbound';

export interface Client {
  id: string;
  business_name: string;
  wa_phone_number_id: string | null;
  wa_session_data: Record<string, unknown> | null;
  telegram_chat_id: string | null;
  admin_whatsapp_number: string | null;
  admin_channel_preference: AdminChannelPreference;
  bot_mode: BotMode;
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
