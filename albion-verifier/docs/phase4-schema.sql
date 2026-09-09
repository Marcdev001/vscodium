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

-- 5. Subscription Tiers Table & Retention-First Seed Data
CREATE TABLE IF NOT EXISTS public.subscription_tiers (
  name TEXT PRIMARY KEY,
  price_ngn NUMERIC(10, 2) NOT NULL,
  price_usd NUMERIC(10, 2) NOT NULL,
  model_caps JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.subscription_tiers (name, price_ngn, price_usd, model_caps) VALUES
  ('free', 0, 0.00, '{"openrouter-free": -1, "groq-free": -1}'::jsonb),
  ('learner', 3200, 2.00, '{"deepseek-v4-flash": 2000000}'::jsonb),
  ('starter', 11200, 7.00, '{"deepseek-v4-flash": 8000000, "qwen3.6-35b-a3b": 1500000, "deepseek-v4-pro": 500000, "glm-5.2": 150000}'::jsonb),
  ('pro', 17600, 11.00, '{"deepseek-v4-flash": 12000000, "qwen3.6-35b-a3b": 3000000, "deepseek-v4-pro": 1000000, "glm-5.2": 250000}'::jsonb)
ON CONFLICT (name) DO UPDATE SET price_usd = EXCLUDED.price_usd, price_ngn = EXCLUDED.price_ngn, model_caps = EXCLUDED.model_caps;

-- 6. Model Pricing Table (Free tier models are $0)
CREATE TABLE IF NOT EXISTS public.model_pricing (
  model_name TEXT PRIMARY KEY,
  cost_per_1k_tokens NUMERIC(10, 6) DEFAULT 0,
  currency TEXT DEFAULT 'NGN',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.model_pricing (model_name, cost_per_1k_tokens, currency) VALUES
  ('openrouter-free', 0, 'NGN'),
  ('groq-free', 0, 'NGN'),
  ('deepseek-v4-flash', 0.00014, 'USD'),
  ('qwen3.6-35b-a3b', 0.00025, 'USD'),
  ('deepseek-v4-pro', 0.00219, 'USD'),
  ('glm-5.2', 0.00175, 'USD')
ON CONFLICT (model_name) DO UPDATE SET cost_per_1k_tokens = EXCLUDED.cost_per_1k_tokens, currency = EXCLUDED.currency;

