# Albion Architecture: Editor vs. Website Separation Matrix

This document defines the strict architectural boundary between the **Albion Desktop Editor** and the **Albion Web Platform**.

---

## 1. Architectural Boundary Matrix

| Capability / Feature | Albion Desktop Editor | Albion Web Platform |
|---|:---:|:---:|
| **Live Fuel Gauge** (Status Bar) | ✅ YES | ❌ NO |
| **Per-Model Utilization Indicator** | ✅ YES (Live via Headers) | ✅ YES (Historical & Cycle totals) |
| **Premium Toggle & `$(zap)` Indicator** | ✅ YES (Editor Command / Header) | ❌ NO |
| **Muse Glimmer Local Mode Indicator** | ✅ YES (`$(cloud-offline)`) | ❌ NO (Listed on roster) |
| **Real-time Session Restore & Auto-Save** | ✅ YES (`supabase-autosave.js`) | ❌ NO |
| **Deterministic Code Verifier (Fail-Safe)** | ✅ YES (`albion-verifier`) | ❌ NO |
| **Link-Out to Account Page** | ✅ YES (`albion.openAccountPage`) | N/A |
| **Marketing & Value Proposition** | ❌ **STRICTLY FORBIDDEN** | ✅ YES |
| **Pricing Tiers ($2 / $7 / $11 / Free)** | ❌ **STRICTLY FORBIDDEN** | ✅ YES (`pricing.html`) |
| **Payment / Paystack Checkout Forms** | ❌ **STRICTLY FORBIDDEN** | ✅ YES |
| **Top-Up Activation Button (>= 85%)** | ❌ **STRICTLY FORBIDDEN** | ✅ YES (`account.html`) |
| **Installer Binaries (.exe, .dmg, .deb)** | ❌ NO | ✅ YES |
| **Terms of Service & Privacy Policy** | ❌ NO | ✅ YES |

---

## 2. Non-Negotiable Rules

### Rule 1: Zero Marketing in the IDE
The editor binary must be a focused, distraction-free software development environment. It contains **no marketing banners, no upsell popups, no pricing tables, and no download buttons**. All status bar items display live, neutral technical telemetry only (`GLM: 45k/150k | Flash: 1.2M/8M`).

### Rule 2: Zero Live Session Bleed to Web
The web platform never accesses, previews, or queries active editor buffers, terminal sessions, or keystroke streams. Code inspection belongs exclusively on the developer's local machine.

### Rule 3: Single Gate for Financial Operations
All financial transactions (card input, Paystack checkouts, subscription cancellations, invoice downloads) occur exclusively on the HTTPS website under full browser security controls. The editor only receives the resulting tier entitlements via signed Supabase JWTs and proxy response headers.
