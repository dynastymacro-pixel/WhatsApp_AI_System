-- ============================================================
-- ZapSell — Database Schema  (run once in your Supabase SQL editor)
-- ============================================================

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE admin_channel_pref        AS ENUM ('telegram', 'whatsapp', 'both');
CREATE TYPE message_dir               AS ENUM ('inbound', 'outbound');
CREATE TYPE stock_status_type         AS ENUM ('available', 'out_of_stock');
CREATE TYPE delivery_type             AS ENUM ('digital_link', 'manual');
CREATE TYPE conversation_status       AS ENUM ('active', 'negotiating', 'awaiting_payment', 'closed');
CREATE TYPE conversation_role         AS ENUM ('customer', 'ai', 'system');
CREATE TYPE order_approval_status     AS ENUM ('pending', 'approved', 'rejected', 'superseded');
CREATE TYPE notification_channel_type AS ENUM ('dashboard', 'telegram', 'whatsapp');
CREATE TYPE notification_tier_type    AS ENUM ('free', 'pro', 'ultra');

-- NOTE: bot_mode is deliberately BOOLEAN for now.
-- In a later week it will be migrated to an enum
-- ('manual' | 'scheduled_auto' | 'timeout_auto')
-- per the three operating modes blueprint.
-- Do NOT add new code that branches on bot_mode values until that migration.

-- ── clients ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clients (
    id                             UUID                      PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name                  TEXT                      NOT NULL,
    wa_phone_number_id             TEXT,
    wa_session_data                JSONB,                    -- serialised Baileys auth state
    telegram_chat_id               TEXT,
    admin_whatsapp_number          TEXT,
    admin_channel_preference       admin_channel_pref        NOT NULL DEFAULT 'whatsapp',
    bot_mode                       BOOLEAN                   NOT NULL DEFAULT TRUE,
    payment_details                TEXT,
    -- Tier & notification settings (Phase 1: schema only, no logic yet)
    notification_tier              notification_tier_type    NOT NULL DEFAULT 'free',
    notification_channel           notification_channel_type NOT NULL DEFAULT 'dashboard',
    telegram_bot_token_secret_id   UUID,                     -- FK to vault.secrets (not raw token)
    notification_quota_used        INT                       NOT NULL DEFAULT 0,
    notification_quota_reset_at    TIMESTAMPTZ,
    created_at                     TIMESTAMPTZ               NOT NULL DEFAULT NOW()
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

-- ── messages (raw WhatsApp transcript — unchanged from Day 1) ─────────────────

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

-- ── products ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS products (
    id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID           NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name            TEXT           NOT NULL,
    description     TEXT           NOT NULL,
    price           NUMERIC(12,2)  NOT NULL,
    currency        TEXT           NOT NULL DEFAULT 'PKR',
    min_price       NUMERIC(12,2)  NOT NULL, -- negotiation floor — never go below this
    stock_status    stock_status_type NOT NULL DEFAULT 'available',
    delivery_type   delivery_type  NOT NULL DEFAULT 'manual',
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    CONSTRAINT min_price_lte_price CHECK (min_price <= price)
);

CREATE INDEX IF NOT EXISTS idx_products_client_id ON products(client_id);

-- ── conversations ─────────────────────────────────────────────────────────────
-- One active conversation per customer per client at a time.

CREATE TABLE IF NOT EXISTS conversations (
    id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           UUID                NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    customer_id         UUID                NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    status              conversation_status NOT NULL DEFAULT 'active',
    current_product_id  UUID                REFERENCES products(id) ON DELETE SET NULL,
    negotiation_rounds  INT                 NOT NULL DEFAULT 0,
    current_offer       NUMERIC(12,2),      -- last price offered by AI
    created_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_client_id   ON conversations(client_id);
CREATE INDEX IF NOT EXISTS idx_conversations_customer_id ON conversations(customer_id);

-- ── conversation_messages ─────────────────────────────────────────────────────
-- Structured AI context history — separate from the raw messages table.

CREATE TABLE IF NOT EXISTS conversation_messages (
    id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID                NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    client_id       UUID                NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    role            conversation_role   NOT NULL,
    content         TEXT                NOT NULL,
    created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_messages_conversation_id ON conversation_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_messages_client_id       ON conversation_messages(client_id);

-- ── orders ────────────────────────────────────────────────────────────────────
-- Durable record for each payment/approval cycle.
-- Separate from conversations — conversations track dialogue state,
-- orders track commercial/approval state.
-- Multiple simultaneous pending orders per customer are supported by design:
-- no UNIQUE constraint on (customer_id, approval_status).

CREATE TABLE IF NOT EXISTS orders (
    id                         UUID                      PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id                  UUID                      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    customer_id                UUID                      NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    conversation_id            UUID                      NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
    product_id                 UUID                      REFERENCES products(id) ON DELETE SET NULL,
    agreed_price               NUMERIC(12,2)             NOT NULL,
    screenshot_received_at     TIMESTAMPTZ,              -- set when image message arrives
    approval_status            order_approval_status     NOT NULL DEFAULT 'pending',
    approved_by                TEXT,                     -- admin identifier (Telegram user, WA number, etc.)
    approved_at                TIMESTAMPTZ,
    notification_channel_used  notification_channel_type,-- which channel notified the admin
    created_at                 TIMESTAMPTZ               NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_client_id        ON orders(client_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id      ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_conversation_id  ON orders(conversation_id);
CREATE INDEX IF NOT EXISTS idx_orders_approval_status  ON orders(client_id, approval_status);

-- RLS: service-role key bypasses this entirely — zero impact on existing backend.
-- Passthrough policy protects future non-service-role access (e.g. admin dashboard).
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_passthrough" ON orders
    USING (true)
    WITH CHECK (true);

-- ── Seed data — test products (safe to re-run, uses DO block) ─────────────────
-- Replace <YOUR_CLIENT_ID> with the UUID from your clients table.
-- Example:
--   DO $$
--   DECLARE cid UUID := '<YOUR_CLIENT_ID>';
--   BEGIN
--     INSERT INTO products (client_id, name, description, price, min_price, stock_status, delivery_type)
--     VALUES
--       (cid, 'Premium Logo Design', 'Professional logo in PNG, SVG, and AI formats', 5000, 3500, 'available', 'digital_link'),
--       (cid, 'Social Media Kit',    '30-day content calendar + 10 branded templates', 8000, 6000, 'available', 'digital_link'),
--       (cid, 'Brand Consultation',  '1-hour strategy call + written brand brief',      3000, 2500, 'available', 'manual');
--   END $$;
