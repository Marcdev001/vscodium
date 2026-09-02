/**
 * Albion Proxy - server.js
 * Secure gateway between Cline and AI providers.
 * Enforces auth, financial cap checks, and usage logging.
 *
 * Required Environment Variables:
 *   SUPABASE_URL          - Supabase project URL
 *   SUPABASE_SERVICE_KEY  - Supabase service role key (NOT anon key)
 *   LITELLM_BASE_URL      - LiteLLM proxy URL (default: http://localhost:4000)
 *   LITELLM_MASTER_KEY    - LiteLLM master API key
 *   PORT                  - Server port (default: 3000)
 *   ALLOWED_ORIGINS       - CORS origins (default: *)
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ---------------------------------------------------------------------------
// ENV VALIDATION
// ---------------------------------------------------------------------------
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required env var: ${key}`);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 3000;
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || 'http://localhost:4000';
const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY || '';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';

// ---------------------------------------------------------------------------
// SUPABASE CLIENT (service role — server-side only, never expose to client)
// ---------------------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---------------------------------------------------------------------------
// TIER CAPS — tokens per billing cycle
// This is the financial survival mechanism. NEVER modify without approval.
// ---------------------------------------------------------------------------
const tierCaps = {
  learner: { flash: 3000000 },
  starter: { flash: 5000000, pro: 1500000, glm: 1000000 },
  pro:     { flash: 12000000, pro: 4000000, glm: 3000000 }
};

// ---------------------------------------------------------------------------
// EXPRESS APP
// ---------------------------------------------------------------------------
const app = express();
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// ---------------------------------------------------------------------------
// MIDDLEWARE: authenticate
// Validates Supabase JWT from Authorization header.
// Attaches req.user on success. Returns 401 on any failure.
// ---------------------------------------------------------------------------
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = data.user;
    next();
  } catch (err) {
    console.error('[AUTH] Unexpected error:', err.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------------------------------------------------------------------------
// CAP CHECK: checkCapBeforeRoute
// Queries Supabase for the user's subscription tier and current-cycle usage.
// Returns the tier name if within cap, or 'flash_only' if over cap.
// CRITICAL: This MUST run BEFORE any request reaches a provider.
// ---------------------------------------------------------------------------
async function checkCapBeforeRoute(userId, estimatedTokens) {
  // 1. Get user's active subscription
  const { data: subscription, error: subError } = await supabase
    .from('subscriptions')
    .select('tier, cycle_start')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  if (subError || !subscription) {
    // No active subscription → treat as learner (most restrictive)
    console.warn(`[CAP] No active subscription for user ${userId}, defaulting to learner`);
    return 'flash_only';
  }

  const { tier, cycle_start } = subscription;

  // 2. Get current cycle usage via RPC
  const { data: usageData, error: usageError } = await supabase
    .rpc('get_current_cycle_usage', {
      p_user_id: userId,
      p_cycle_start: cycle_start
    });

  if (usageError) {
    console.error(`[CAP] Usage RPC failed for user ${userId}:`, usageError.message);
    // On RPC failure, enforce most restrictive cap as safety measure
    return 'flash_only';
  }

  const currentUsage = usageData || 0;
  const caps = tierCaps[tier];

  if (!caps) {
    console.warn(`[CAP] Unknown tier "${tier}" for user ${userId}, forcing flash_only`);
    return 'flash_only';
  }

  // 3. Check if projected usage exceeds the flash cap (primary limit)
  if (currentUsage + estimatedTokens > caps.flash) {
    console.warn(
      `[CAP] User ${userId} (${tier}) would exceed cap: ` +
      `${currentUsage} + ${estimatedTokens} > ${caps.flash}. Forcing flash_only.`
    );
    return 'flash_only';
  }

  return tier;
}

// ---------------------------------------------------------------------------
// ROUTE: POST /chat
// Accepts: { messages, model_preference, estimated_tokens, session_id }
// Flow: Auth → Cap Check → Route to LiteLLM → Log Usage → Respond
// ---------------------------------------------------------------------------
app.post('/chat', authenticate, async (req, res) => {
  const userId = req.user.id;
  const { messages, model_preference, estimated_tokens, session_id } = req.body;

  // Input validation
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required and must not be empty' });
  }

  try {
    // STEP 1: Pre-request cap check — BEFORE any provider call
    const estimatedTokenCount = estimated_tokens || 1000;
    const capResult = await checkCapBeforeRoute(userId, estimatedTokenCount);

    // STEP 2: Determine target model
    let targetModel;
    if (capResult === 'flash_only') {
      targetModel = 'deepseek-v4-flash';
    } else {
      targetModel = model_preference || 'deepseek-v4-flash';
    }

    // STEP 3: Route via direct HTTP POST to LiteLLM (OpenAI-compatible)
    const providerResponse = await fetch(`${LITELLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LITELLM_MASTER_KEY}`
      },
      body: JSON.stringify({
        model: targetModel,
        messages: messages,
        timeout: 30000,
        metadata: {
          user_id: userId,
          tier: capResult,
          session_id: session_id || null
        }
      })
    });

    // STEP 4: Parse response — throw on provider failure
    if (!providerResponse.ok) {
      const errorText = await providerResponse.text().catch(() => 'Unknown provider error');
      console.error(`[CHAT] Provider returned ${providerResponse.status} for user ${userId}: ${errorText}`);
      throw new Error(`Provider returned HTTP ${providerResponse.status}`);
    }

    const data = await providerResponse.json();

    // STEP 5: Synchronously log usage BEFORE responding to client
    const { error: logError } = await supabase.from('usage_logs').insert({
      user_id: userId,
      model: targetModel,
      prompt_tokens: data.usage?.prompt_tokens || 0,
      completion_tokens: data.usage?.completion_tokens || 0,
      actual_cost: data.metadata?.cost || 0,
      session_id: session_id || null,
      timestamp: new Date().toISOString()
    });

    if (logError) {
      // Log the error but don't fail the request — usage is already consumed
      console.error(`[USAGE] Failed to log usage for user ${userId}:`, logError.message);
    }

    // STEP 6: Return provider response to Cline
    return res.json(data);

  } catch (err) {
    // Catch-all: log with user ID, return safe 502
    console.error(`[CHAT] Error for user ${userId}:`, err.message);
    return res.status(502).json({
      error: 'Provider unavailable. Retrying...',
      retry_after: 2000
    });
  }
});

// ---------------------------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'albion-proxy', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// GLOBAL ERROR HANDLER
// Catches JSON parse errors, unhandled middleware errors, etc.
// NEVER expose stack traces or internal details to the client.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  // Handle malformed JSON body
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  // Catch-all for any other unhandled errors
  console.error('[SERVER] Unhandled error:', err.message);
  return res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Albion Proxy running on port ${PORT}`);
  console.log(`LiteLLM target: ${LITELLM_BASE_URL}`);
  console.log(`CORS origins: ${ALLOWED_ORIGINS}`);
});
