-- migration_phase3c_notify_log.sql
-- Sub-Phase 3C: admin_notification_log table
-- Provides a durable, queryable audit trail for every admin alert sent (or failed).
-- Resolves the gap where "I never got notified" disputes were unresolvable from the DB.
--
-- Security note: payload JSONB stores only sanitised order metadata (phone, product name,
-- price, event type). It NEVER stores Telegram tokens, WhatsApp numbers, or Vault secrets.
-- RLS is restricted to service_role only. Any future dashboard read path MUST add a
-- client-scoped policy: USING (client_id = auth.uid()) before exposing this table.
--
-- Run this in a single Supabase SQL Editor tab.

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.admin_notification_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  event_type     TEXT        NOT NULL,   -- 'screenshot_received' | 'delivery_failure' | 'order_created'
  channel        TEXT        NOT NULL,   -- 'telegram' | 'whatsapp' | 'both' | 'telegram_fallback' | 'skipped'
  order_id       UUID        REFERENCES public.orders(id) ON DELETE SET NULL,
  payload        JSONB,                  -- sanitised snapshot: no credentials, no secrets
  status         TEXT        NOT NULL DEFAULT 'sent',  -- 'sent' | 'failed' | 'skipped'
  failure_reason TEXT,                   -- non-null only when status = 'failed'
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Index ─────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_admin_notification_log_client
  ON public.admin_notification_log (client_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_notification_log_order
  ON public.admin_notification_log (order_id)
  WHERE order_id IS NOT NULL;

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.admin_notification_log ENABLE ROW LEVEL SECURITY;

-- Service role only. No public or authenticated read.
-- FUTURE: before exposing via dashboard, add:
--   CREATE POLICY "client scoped read"
--     ON public.admin_notification_log FOR SELECT
--     USING (client_id = auth.uid());
CREATE POLICY "service_role_only"
  ON public.admin_notification_log
  USING (auth.role() = 'service_role');

-- ── Grant ─────────────────────────────────────────────────────────────────────

GRANT INSERT, SELECT ON public.admin_notification_log TO service_role;
