// src/config/index.ts
// Validates and exports all environment variables.
// Throws at startup if any required variable is missing — fast fail beats silent misconfiguration.

import dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[Config] Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function optionalInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`[Config] ${name} must be an integer, got: "${raw}"`);
  return parsed;
}

export const config = {
  // App
  port: optionalInt('PORT', 3000),
  nodeEnv: optional('NODE_ENV', 'development'),

  // Supabase
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),

  // Redis / BullMQ
  redisUrl: required('REDIS_URL'),

  // WhatsApp
  defaultClientId: required('DEFAULT_CLIENT_ID'),

  // Anti-ban
  typingDelayMinMs: optionalInt('TYPING_DELAY_MIN_MS', 1000),
  typingDelayMaxMs: optionalInt('TYPING_DELAY_MAX_MS', 3000),
  maxDailyConversations: optionalInt('MAX_DAILY_CONVERSATIONS', 200),

  // Queue
  outgoingQueueName: optional('OUTGOING_QUEUE_NAME', 'whatsapp-outgoing'),

  // QR pairing server
  qrServerPort: optionalInt('QR_SERVER_PORT', 3001),
} as const;

export type Config = typeof config;
