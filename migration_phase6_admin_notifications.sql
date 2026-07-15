-- =============================================================================
-- ZapSell Migration — Phase 6 Admin Notifications (Run in Supabase SQL Editor)
-- =============================================================================

-- 1. Add toggles for admin notifications to clients table
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS notify_on_approval_action BOOLEAN NOT NULL DEFAULT TRUE;

-- 2. Add notification flag to orders table to prevent duplicate dispatches
ALTER TABLE public.orders 
ADD COLUMN IF NOT EXISTS admin_action_notified BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Backfill existing approved/rejected orders to prevent spamming notifications on deployment
UPDATE public.orders
SET admin_action_notified = TRUE
WHERE approval_status IN ('approved', 'rejected');
