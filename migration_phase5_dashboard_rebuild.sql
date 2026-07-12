-- migration_phase5_dashboard_rebuild.sql
-- Run this in your Supabase SQL editor to prepare the schema for the dashboard rebuild.

-- 1. Add fields to customers table
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS nickname text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- 2. Add fields to orders table
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS failure_reason text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_attempts integer DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS screenshot_received_at timestamptz;

-- 3. Add UPDATE policy for customers table (nickname editing support)
-- (Note: RLS is already enabled and public.customers already has the authenticated_select_own_customers SELECT policy)
DROP POLICY IF EXISTS "authenticated_update_own_customers" ON public.customers;
CREATE POLICY "authenticated_update_own_customers" ON public.customers
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.client_users cu
      WHERE cu.user_id   = auth.uid()
        AND cu.client_id = customers.client_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.client_users cu
      WHERE cu.user_id   = auth.uid()
        AND cu.client_id = customers.client_id
    )
  );

-- 4. Grants on customers and orders (narrowed for dashboard update actions)
GRANT UPDATE (nickname) ON public.customers TO authenticated;
GRANT UPDATE (notes) ON public.orders TO authenticated;
