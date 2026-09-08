-- ===========================================================================
-- Albion Phase 4: Billing & Fuel Gauge — Supabase SQL Schema Extension
--
-- Run these SQL statements in your Supabase SQL Editor.
-- Adds webhook audit logging for Paystack billing events and subscriptions.
-- ===========================================================================

-- 1. Create the billing_events table
CREATE TABLE IF NOT EXISTS public.billing_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  event_type TEXT NOT NULL, -- e.g., 'charge.success', 'subscription.create', 'subscription.disable'
  paystack_reference TEXT UNIQUE,
  amount NUMERIC(10, 2),
  currency TEXT DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'pending',
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create indexes for user querying and idempotency lookups
CREATE INDEX IF NOT EXISTS idx_billing_events_user ON public.billing_events(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_ref ON public.billing_events(paystack_reference);
CREATE INDEX IF NOT EXISTS idx_billing_events_type ON public.billing_events(event_type);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies: Service role backend only, users can view own billing history
DROP POLICY IF EXISTS "Users can view own billing events" ON public.billing_events;
CREATE POLICY "Users can view own billing events" 
  ON public.billing_events FOR SELECT 
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role manages billing events" ON public.billing_events;
CREATE POLICY "Service role manages billing events" 
  ON public.billing_events FOR ALL 
  USING (true)
  WITH CHECK (true);
