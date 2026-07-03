-- ============================================================
-- ZapSell — Database Schema  (run once in your Supabase SQL editor)
-- ============================================================

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE admin_channel_pref AS ENUM ('telegram', 'whatsapp', 'both');
CREATE TYPE message_dir AS ENUM ('inbound', 'outbound');

-- NOTE: bot_mode is deliberately BOOLEAN for now.
-- In a later week it will be migrated to an enum
-- ('manual' | 'scheduled_auto' | 'timeout_auto')
-- per the three operating modes blueprint.
-- Do NOT add new code that branches on bot_mode values until that migration.

-- ── clients ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clients (
    id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name              TEXT        NOT NULL,
    wa_phone_number_id         TEXT,
    wa_session_data            JSONB,          -- serialised Baileys auth state
    telegram_chat_id           TEXT,
    admin_whatsapp_number      TEXT,
    admin_channel_preference   admin_channel_pref NOT NULL DEFAULT 'whatsapp',
    bot_mode                   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── customers ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customers (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    phone_number        TEXT        NOT NULL,
    preferred_language  TEXT,
    first_contact_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_customers_client_id ON customers(client_id);

-- ── messages ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    customer_id     UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    direction       message_dir NOT NULL,
    content_type    TEXT        NOT NULL,
    content         TEXT        NOT NULL,
    wa_message_id   TEXT        NOT NULL,
    UNIQUE (client_id, wa_message_id),   -- idempotent: deduplicates webhook replays
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_client_id    ON messages(client_id);
CREATE INDEX IF NOT EXISTS idx_messages_customer_id  ON messages(customer_id);
