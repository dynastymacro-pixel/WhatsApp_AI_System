-- ============================================================
-- ZapSell — Phase 3D Migration: Automated Delivery & Inventory
-- ============================================================
-- Run this in the Supabase SQL Editor.
-- ============================================================

-- ── 1. Extend delivery_type enum (must run in its own step) ──────────────────
-- Note: Supabase supports running this safely.
ALTER TYPE public.delivery_type ADD VALUE IF NOT EXISTS 'inventory';

-- ── 2. Add delivery columns to products ──────────────────────────────────────
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS delivery_content TEXT;

-- ── 3. Create product_delivery_items table ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.product_delivery_items (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        UUID         NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  content_encrypted TEXT         NOT NULL, -- stores name of Vault secret (e.g. delivery_item_${id})
  status            TEXT         NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'delivered')),
  order_id          UUID         REFERENCES public.orders(id) ON DELETE SET NULL,
  reserved_at       TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Index for claiming queries
CREATE INDEX IF NOT EXISTS idx_delivery_items_claim 
  ON public.product_delivery_items(product_id, status);

-- Enable RLS (Service role key bypasses this)
ALTER TABLE public.product_delivery_items ENABLE ROW LEVEL SECURITY;

-- ── 4. Add delivery columns to orders ────────────────────────────────────────
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'not_applicable' 
  CHECK (delivery_status IN ('not_applicable', 'pending', 'delivered', 'failed'));

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_attempts INT NOT NULL DEFAULT 0;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_locked_at TIMESTAMPTZ;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_item_id UUID 
  REFERENCES public.product_delivery_items(id) ON DELETE SET NULL;

GRANT UPDATE (delivery_status, delivery_attempts, delivery_locked_at) ON public.orders TO authenticated;

-- ── 5. Create atomic claiming function ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_delivery_item(p_product_id UUID, p_order_id UUID)
RETURNS SETOF public.product_delivery_items
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.product_delivery_items
  SET status = 'reserved', order_id = p_order_id, reserved_at = NOW()
  WHERE id = (
    SELECT id FROM public.product_delivery_items
    WHERE product_id = p_product_id AND status = 'available'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql;

-- ── 6. Create atomic order locking function for polling ──────────────────────
CREATE OR REPLACE FUNCTION public.claim_next_delivery_order()
RETURNS TABLE (id UUID, client_id UUID)
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.orders
  SET delivery_locked_at = NOW()
  WHERE public.orders.id = (
    SELECT o.id FROM public.orders o
    WHERE o.delivery_status = 'pending'
      AND (o.delivery_locked_at IS NULL OR o.delivery_locked_at < NOW() - INTERVAL '2 minutes')
    ORDER BY o.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING public.orders.id, public.orders.client_id;
END;
$$ LANGUAGE plpgsql;

-- ── 7. Create parallel order delivery log for audits ─────────────────────────
CREATE TABLE IF NOT EXISTS public.order_delivery_log (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID         NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  old_status  TEXT,
  new_status  TEXT         NOT NULL,
  changed_by  TEXT         NOT NULL,
  changed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE public.order_delivery_log ENABLE ROW LEVEL SECURITY;

-- Grant SELECT to authenticated users for dashboard views
DROP POLICY IF EXISTS "authenticated_select_own_delivery_logs" ON public.order_delivery_log;
CREATE POLICY "authenticated_select_own_delivery_logs" ON public.order_delivery_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      JOIN public.client_users cu ON cu.client_id = o.client_id
      WHERE o.id = order_delivery_log.order_id
        AND cu.user_id = auth.uid()
    )
  );

GRANT SELECT ON public.order_delivery_log TO authenticated;

-- Trigger to audit delivery_status transitions automatically
CREATE OR REPLACE FUNCTION log_order_delivery_change() 
RETURNS TRIGGER 
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.delivery_status IS DISTINCT FROM NEW.delivery_status THEN
    INSERT INTO public.order_delivery_log (order_id, old_status, new_status, changed_by)
    VALUES (NEW.id, OLD.delivery_status, NEW.delivery_status, 'system');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_delivery_change ON public.orders;
CREATE TRIGGER trg_order_delivery_change
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION log_order_delivery_change();

-- ── 8. Create atomic order release function on delivery failure ──────────────
CREATE OR REPLACE FUNCTION public.release_delivery_item_on_failure(p_order_id UUID)
RETURNS VOID
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- 1. Release the locked item back to available status
  UPDATE public.product_delivery_items
  SET status = 'available', order_id = NULL, reserved_at = NULL
  WHERE order_id = p_order_id;

  -- 2. Mark the order as failed and sever the reference to the item ID
  UPDATE public.orders
  SET delivery_status = 'failed', delivery_item_id = NULL
  WHERE id = p_order_id;
END;
$$ LANGUAGE plpgsql;
