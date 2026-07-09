-- =============================================================================
-- ZapSell Migration — Phase 3G Conversation Quota (Run in Supabase SQL Editor)
-- =============================================================================

-- 1. Add conversation quota columns to clients table
ALTER TABLE public.clients 
  ADD COLUMN IF NOT EXISTS conversation_quota_used INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conversation_quota_reset_at TIMESTAMPTZ;

-- 2. Add quota block notification timestamp to customers table
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS quota_block_notified_at TIMESTAMPTZ;

-- 3. Create owner audit log table
CREATE TABLE IF NOT EXISTS public.owner_audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,                       -- 'update_tier' | 'adjust_credits'
  old_value     JSONB,
  new_value     JSONB,
  performed_by  TEXT NOT NULL,                       -- Email of the owner (zainjavid553@gmail.com)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Enable RLS and restrict read/write to service-role / owner only (FOR ALL and WITH CHECK)
ALTER TABLE public.owner_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role and owner access" ON public.owner_audit_log;

CREATE POLICY "service role and owner access"
  ON public.owner_audit_log
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
