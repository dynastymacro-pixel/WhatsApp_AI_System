-- =============================================================================
-- ZapSell Migration — Phase 3F Quota Tiers (Run in Supabase SQL Editor)
-- =============================================================================

-- Add the new 'standard' value to the notification_tier_type enum in-place.
-- Safe, backwards-compatible, and committed immediately.
ALTER TYPE public.notification_tier_type ADD VALUE IF NOT EXISTS 'standard';
