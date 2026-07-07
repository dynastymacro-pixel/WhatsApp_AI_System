-- ============================================================
-- ZapSell — Phase 3E Migration: WhatsApp QR Pairing Integration
-- ============================================================
-- Run this in the Supabase SQL Editor.
-- ============================================================

-- 1. Add connection status and pairing columns to clients
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS wa_qr_data TEXT;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS wa_qr_last_emitted_at TIMESTAMPTZ;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS wa_connection_requested_at TIMESTAMPTZ;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS wa_connection_status TEXT NOT NULL DEFAULT 'disconnected'
  CHECK (wa_connection_status IN ('disconnected', 'connecting_requested', 'connecting', 'connected'));

-- 2. Create atomic claim function using SKIP LOCKED
CREATE OR REPLACE FUNCTION public.claim_next_connection_request()
RETURNS TABLE (id UUID)
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.clients
  SET wa_connection_status = 'connecting'
  WHERE public.clients.id = (
    SELECT c.id FROM public.clients c
    WHERE c.wa_connection_status = 'connecting_requested'
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING public.clients.id;
END;
$$ LANGUAGE plpgsql;

-- 3. Grant execute permission
GRANT EXECUTE ON FUNCTION public.claim_next_connection_request() TO authenticated;
