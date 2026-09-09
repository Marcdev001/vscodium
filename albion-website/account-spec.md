# Albion Developer Account Dashboard Specification

This document specifies the architecture, UI components, and API integration for the logged-in user dashboard (`https://albion.dev/account`).

---

## 1. Authentication & Security
- **Auth Provider**: Supabase Auth (Email + Magic Link / Password / GitHub OAuth).
- **Session Handling**: Client stores JWT in `localStorage` / HTTP-only cookie.
- **Data Isolation**: All dashboard queries use Row Level Security (RLS) tied to `auth.uid() = user_id`.

---

## 2. Core Dashboard Components

### A. Current Plan & Status Card
- Displays active subscription tier: `Free`, `Learner` ($2), `Starter` ($7), or `Pro` ($11).
- Shows current billing cycle period: `cycle_start` to `cycle_end` (30 days from cycle_start).
- Status indicator: `Active`, `Expiring`, or `Cancelled`.

### B. Per-Model Real-Time Usage Bars
Reads current cycle usage by querying `usage_logs` grouped by `model` and compares with `model_caps` from `subscription_tiers`:

| Model Identifier | Display Name | Visual Bar Color | Threshold Indicators |
|---|---|---|---|
| `deepseek-v4-flash` | DeepSeek V4 Flash | Blue (default) / Yellow (>=85%) / Red (100%) | [Used] / [Cap] tokens |
| `qwen3.6-35b-a3b` | Qwen 3.6 35B (UI/Vision) | Blue / Yellow / Red | [Used] / [Cap] tokens |
| `deepseek-v4-pro` | DeepSeek V4 Pro (Reasoning) | Purple (Premium) / Yellow / Red | [Used] / [Cap] tokens |
| `glm-5.2` | GLM 5.2 (Design/Frontend) | Purple (Premium) / Yellow / Red | [Used] / [Cap] tokens |
| `openrouter-free` / `groq-free` | OpenRouter / Groq ($0 Cloud Free) | Green (Unlimited) | 0 / Unlimited ($0 cloud tier) |

### C. Top-Up & Re-Subscription Controls (Strict Financial Rule)
- **Top-Up Button State**:
  - **DISABLED** client-side by default.
  - **ENABLED** client-side ONLY if `MAX(model_usage / model_cap) >= 0.85` for at least one model in the tier.
- **Server Enforcement**:
  - The client calls `POST /billing/topup-check` before initializing Paystack checkout.
  - If `max_utilization < 0.85`, backend returns `403 Top-up available when a model cap reaches 85% utilization`.
  - Tooltip on disabled button: *"Top-up unlocks when any model reaches 85% utilization to protect against premature billing."*

### D. Billing History & Receipts
Queries `public.billing_events` WHERE `user_id = auth.uid()`:
- Date & Timestamp
- Event Type (`charge.success`, `subscription.create`)
- Paystack Reference (`albion_ref_...`)
- Amount & Currency (`₦11,200.00 NGN` or `$7.00 USD`)
- Invoice / Receipt download link

---

## 3. Separation of Concerns
- **Dashboard Scope**: Account credentials, billing, invoices, plan changes, and top-ups.
- **Editor Scope**: Code editing, live status bar fuel gauge, MCP verifier, and conversation continuity.
- **Strict Constraint**: The account dashboard NEVER queries editor active buffer sessions; the editor NEVER loads payment forms.
