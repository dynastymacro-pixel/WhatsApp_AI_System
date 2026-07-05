-- ============================================================
-- ZapSell — Phase 4A Migration: Onboarding Trigger
-- ============================================================
-- Automatically provisions a new public.clients row and links it
-- to public.client_users when a new auth.users row is inserted.
-- Safe to re-run: uses CREATE OR REPLACE / DROP TRIGGER IF EXISTS.
-- Run in Supabase SQL Editor.
-- ============================================================

-- 1. Create trigger function
CREATE OR REPLACE FUNCTION public.handle_new_user_onboarding()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_business_name TEXT;
  v_client_id UUID;
  v_exists BOOLEAN;
BEGIN
  -- Check if client_users association already exists for this user_id (Idempotency)
  SELECT EXISTS (
    SELECT 1 FROM public.client_users WHERE user_id = NEW.id
  ) INTO v_exists;

  IF v_exists THEN
    RETURN NEW;
  END IF;

  -- Extract business name from raw user metadata
  v_business_name := NEW.raw_user_meta_data->>'business_name';
  
  -- Clean/trim business name
  v_business_name := trim(v_business_name);
  
  -- Fallback if empty/whitespace-only/null
  IF v_business_name IS NULL OR v_business_name = '' THEN
    v_business_name := 'My Business';
  END IF;

  -- Create new client record (schema defaults used for other columns)
  INSERT INTO public.clients (business_name)
  VALUES (v_business_name)
  RETURNING id INTO v_client_id;

  -- Create link row in client_users
  INSERT INTO public.client_users (user_id, client_id)
  VALUES (NEW.id, v_client_id);

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Hard-fail: raise exception to abort user registration transaction.
    -- This guarantees no orphaned auth.users are created without business accounts.
    RAISE EXCEPTION 'ZapSell onboarding trigger failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$ LANGUAGE plpgsql;

-- 2. Register the trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_onboarding();
