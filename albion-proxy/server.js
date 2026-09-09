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
const nodeFetch = require('node-fetch');
const fetch = (...args) => (global.fetch ? global.fetch(...args) : nodeFetch(...args));
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Sentry = require('@sentry/node');
const { rateLimit, MemoryStore } = require('express-rate-limit');
require('dotenv').config();

// ---------------------------------------------------------------------------
// SENTRY ERROR TRACKING (Production Hardening)
// ---------------------------------------------------------------------------
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 1.0
  });
  console.log('[SENTRY] Initialized error tracking.');
}

// ---------------------------------------------------------------------------
// RATE LIMIT STORE CONFIGURATION
// Supports MemoryStore for local development and RedisStore for production.
// ---------------------------------------------------------------------------
function getRateLimitStore() {
  if (process.env.RATE_LIMIT_STORE === 'redis') {
    try {
      const RedisStore = require('rate-limit-redis').default || require('rate-limit-redis');
      return new RedisStore();
    } catch (e) {
      console.warn('[RATE-LIMIT] Redis store requested but rate-limit-redis not available, falling back to MemoryStore');
      return new MemoryStore();
    }
  }
  return new MemoryStore();
}

// Global rate limit: 30 requests per minute per IP / UserID
const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    return req.user?.id || req.ip || req.headers['x-forwarded-for'] || 'anonymous';
  },
  handler: (req, res) => {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded: maximum 30 requests per minute. Please wait before retrying.',
      retry_after: 60
    });
  },
  store: getRateLimitStore()
});

// Stricter rate limit on /webhooks/paystack: 5 requests per minute
const paystackRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => req.ip || 'paystack-webhook',
  handler: (req, res) => {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'Paystack webhook rate limit exceeded: maximum 5 requests per minute.',
      retry_after: 60
    });
  },
  store: getRateLimitStore()
});

// Stricter rate limit on /webhooks/lemonsqueezy: 5 requests per minute
const lemonSqueezyRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => req.ip || 'lemonsqueezy-webhook',
  handler: (req, res) => {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'Lemon Squeezy webhook rate limit exceeded: maximum 5 requests per minute.',
      retry_after: 60
    });
  },
  store: getRateLimitStore()
});

const webhookRateLimiter = paystackRateLimiter;
const processedWebhookIds = new Set();


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
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_TEST_SECRET_KEY || '';
const LEMONSQUEEZY_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';
const LEMONSQUEEZY_API_KEY = process.env.LEMONSQUEEZY_API_KEY || '';
const LEMONSQUEEZY_STORE_ID = process.env.LEMONSQUEEZY_STORE_ID || '';

// --- Free Tier Cloud Providers (Stacked Failover) ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENROUTER_ENDPOINT = process.env.OPENROUTER_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const GROQ_ENDPOINT = process.env.GROQ_ENDPOINT || 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_FREE_MODEL = process.env.OPENROUTER_FREE_MODEL || 'deepseek/deepseek-r1:free';
const GROQ_FREE_MODEL = process.env.GROQ_FREE_MODEL || 'llama-3.1-8b-instant';

const DAILY_FREE_LIMIT_MESSAGE = 'Daily free cloud AI limit reached. Please upgrade to the Learner tier ($2) for premium cloud access.';

// ---------------------------------------------------------------------------
// SUPABASE CLIENT (service role — server-side only, never expose to client)
// ---------------------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---------------------------------------------------------------------------
// TIER CAPS — tokens per billing cycle (Retention-First Math)
// -1 indicates unlimited ($0 cloud free tier models).
// NEVER modify without explicit architectural approval.
// ---------------------------------------------------------------------------
const tierCaps = {
  free: {
    'openrouter-free': -1,
    'groq-free': -1
  },
  learner: {
    'deepseek-v4-flash': 2000000
  },
  starter: {
    'deepseek-v4-flash': 8000000,
    'qwen3.6-35b-a3b': 1500000,
    'deepseek-v4-pro': 500000,
    'glm-5.2': 150000
  },
  pro: {
    'deepseek-v4-flash': 12000000,
    'qwen3.6-35b-a3b': 3000000,
    'deepseek-v4-pro': 1000000,
    'glm-5.2': 250000
  }
};

const PREMIUM_TOGGLE_MODELS = new Set(['deepseek-v4-pro', 'glm-5.2']);
const FREE_TIER_MODELS = new Set(['openrouter-free', 'groq-free']);

// ---------------------------------------------------------------------------
// EXPRESS APP
// ---------------------------------------------------------------------------
const app = express();
app.use(helmet());
app.use(cors({
  origin: ALLOWED_ORIGINS,
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Albion-Force-Model'
  ],
  exposedHeaders: [
    'X-Albion-Usage-Percent',
    'X-Albion-Active-Model',
    'X-Albion-Tier',
    'X-Albion-Usage-Warning',
    'X-Albion-Current-Tokens',
    'X-Albion-Cap-Tokens',
    'X-Albion-Caps-Summary'
  ]
}));

// Capture raw body for webhook HMAC signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));


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
// CAP CHECK & INTELLIGENT ROUTER: checkCapBeforeRoute
// Enforces 4 routing rules in exact priority order:
//   a. Free tier -> always muse-glimmer. Never a paid model.
//   b. Paid tier with remaining caps -> intelligent router (flash/qwen auto; pro/glm ONLY via toggle)
//   c. Paid tier, ALL paid caps exhausted -> force muse-glimmer + all_caps_exhausted warning
//   d. Hard guard against paid model leaks
// ---------------------------------------------------------------------------
async function checkCapBeforeRoute(userId, { forceModel = null, hasImages = false, estimatedTokens = 1000 } = {}) {
  // 1. Get user's active subscription
  const { data: subscription, error: subError } = await supabase
    .from('subscriptions')
    .select('tier, cycle_start')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  let tier = 'free';
  if (!subError && subscription && subscription.tier && tierCaps[subscription.tier]) {
    tier = subscription.tier;
  }
  const cycleStart = subscription ? subscription.cycle_start : new Date(0).toISOString();

  // Rule a: Free tier ALWAYS routes to openrouter-free. Never a paid model.
  if (tier === 'free') {
    return {
      tier: 'free',
      targetModel: 'openrouter-free',
      isFreeTier: true,
      allCapsExhausted: false,
      warning: null,
      usagePercent: 0,
      currentUsage: 0,
      tierCap: -1,
      maxUtilization: 0,
      capsSummary: {
        'openrouter-free': { used: 0, cap: -1, percent: 0 },
        'groq-free': { used: 0, cap: -1, percent: 0 }
      }
    };
  }

  // 2. Fetch usage grouped by model for current cycle
  const currentTierCaps = tierCaps[tier] || tierCaps.learner;
  const modelUsage = {};

  try {
    const { data: logs, error: logsError } = await supabase
      .from('usage_logs')
      .select('model, prompt_tokens, completion_tokens')
      .eq('user_id', userId)
      .gte('timestamp', cycleStart);

    if (!logsError && Array.isArray(logs)) {
      for (const log of logs) {
        const m = log.model;
        const total = (log.prompt_tokens || 0) + (log.completion_tokens || 0);
        modelUsage[m] = (modelUsage[m] || 0) + total;
      }
    }
  } catch (err) {
    console.warn(`[CAP] Error fetching per-model usage for user ${userId}:`, err.message);
  }

  // Calculate caps summary and check exhaustion
  const capsSummary = {};
  let anyPaidRemaining = false;
  let maxUtilization = 0;
  let flashUsed = 0;
  let flashCap = currentTierCaps['deepseek-v4-flash'] || 1;

  for (const [m, cap] of Object.entries(currentTierCaps)) {
    if (cap === -1) continue; // Skip unlimited local models
    const used = modelUsage[m] || 0;
    const ratio = used / cap;
    if (ratio > maxUtilization) maxUtilization = ratio;
    capsSummary[m] = { used, cap, percent: Number((ratio * 100).toFixed(1)) };

    if (m === 'deepseek-v4-flash') {
      flashUsed = used;
      flashCap = cap;
    }

    if (used + estimatedTokens <= cap) {
      anyPaidRemaining = true;
    }
  }

  const allCapsExhausted = !anyPaidRemaining;
  const overallPercent = Number(((flashUsed / flashCap) * 100).toFixed(1));

  // Rule c: Paid tier, ALL paid caps exhausted -> force openrouter-free
  if (allCapsExhausted) {
    console.warn(`[CAP] User ${userId} (${tier}) exhausted all paid caps. Forcing free cloud tier (OpenRouter/Groq).`);
    return {
      tier,
      targetModel: 'openrouter-free',
      isFreeTier: false,
      allCapsExhausted: true,
      warning: 'all_caps_exhausted',
      usagePercent: 100,
      currentUsage: flashUsed,
      tierCap: flashCap,
      maxUtilization,
      capsSummary
    };
  }

  // Rule b: Paid tier with remaining caps
  let selectedModel = null;

  // Premium Toggle routing:
  // If client sends X-Albion-Force-Model (deepseek-v4-pro or glm-5.2) AND cap remains
  if (forceModel && PREMIUM_TOGGLE_MODELS.has(forceModel)) {
    const proCap = currentTierCaps[forceModel];
    const proUsed = modelUsage[forceModel] || 0;
    if (proCap && (proUsed + estimatedTokens <= proCap)) {
      selectedModel = forceModel;
    } else {
      console.warn(`[CAP] Forced model ${forceModel} cap exhausted (${proUsed}/${proCap}). Falling back to routine router.`);
    }
  }

  // Intelligent Router for ~95% of tasks:
  // STRICT RULE 3: Proxy is STRICTLY FORBIDDEN from auto-routing to Pro or GLM.
  if (!selectedModel) {
    if (hasImages && currentTierCaps['qwen3.6-35b-a3b']) {
      const qwenCap = currentTierCaps['qwen3.6-35b-a3b'];
      const qwenUsed = modelUsage['qwen3.6-35b-a3b'] || 0;
      if (qwenUsed + estimatedTokens <= qwenCap) {
        selectedModel = 'qwen3.6-35b-a3b';
      }
    }

    // Default to flash for routine text/code edits
    if (!selectedModel) {
      if (currentTierCaps['deepseek-v4-flash'] && (flashUsed + estimatedTokens <= flashCap)) {
        selectedModel = 'deepseek-v4-flash';
      } else {
        // Find any available non-premium paid model
        for (const [m, cap] of Object.entries(currentTierCaps)) {
          if (!PREMIUM_TOGGLE_MODELS.has(m) && ((modelUsage[m] || 0) + estimatedTokens <= cap)) {
            selectedModel = m;
            break;
          }
        }
      }
    }
  }

  // Fallback if no routine cloud model has quota:
  if (!selectedModel) {
    selectedModel = 'openrouter-free';
  }

  // Rule d: Hard guard against paid model leakage
  if (!FREE_TIER_MODELS.has(selectedModel) && allCapsExhausted) {
    selectedModel = 'openrouter-free';
    console.error('[CAP] Paid model blocked at exhausted caps.');
  }

  let warning = null;
  if (maxUtilization >= 1.0) {
    warning = 'hard_ceiling_reached';
  } else if (maxUtilization >= 0.85) {
    warning = 'approaching_limit';
  }

  return {
    tier,
    targetModel: selectedModel,
    isFreeTier: false,
    allCapsExhausted,
    warning,
    usagePercent: overallPercent,
    currentUsage: flashUsed,
    tierCap: flashCap,
    maxUtilization,
    capsSummary
  };
}

// ---------------------------------------------------------------------------
// STACKED CLOUD FREE TIER DISPATCH
// Attempt 1: OpenRouter Free API (deepseek/deepseek-r1:free or configured)
// Catch 429/503: Immediately failover to Attempt 2: Groq Free API (llama-3.1-8b-instant or configured)
// Catch Final Failure: Return 503 with exact upgrade message
// Strictly guarantees NEVER falling back to a paid model.
// ---------------------------------------------------------------------------
async function dispatchFreeTierChat(messages, metadata = {}) {
  // ATTEMPT 1: OpenRouter Free
  try {
    const orResponse = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://albion.dev',
        'X-Title': 'Albion Editor'
      },
      body: JSON.stringify({
        model: OPENROUTER_FREE_MODEL,
        messages
      })
    });

    if (orResponse.status === 429 || orResponse.status === 503 || !orResponse.ok) {
      const errText = await orResponse.text().catch(() => '');
      console.warn(`[FREE-TIER] OpenRouter returned HTTP ${orResponse.status}: ${errText}. Attempting Groq fallback...`);
    } else {
      const data = await orResponse.json();
      return { success: true, model: 'openrouter-free', data };
    }
  } catch (err) {
    console.warn(`[FREE-TIER] OpenRouter request failed: ${err.message}. Attempting Groq fallback...`);
  }

  // ATTEMPT 2: Groq Free Fallback
  try {
    const groqResponse = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_FREE_MODEL,
        messages
      })
    });

    if (groqResponse.status === 429 || groqResponse.status === 503 || !groqResponse.ok) {
      const errText = await groqResponse.text().catch(() => '');
      console.error(`[FREE-TIER] Groq returned HTTP ${groqResponse.status}: ${errText}. Both free tiers exhausted.`);
      return {
        success: false,
        status: 503,
        error: DAILY_FREE_LIMIT_MESSAGE
      };
    }

    const data = await groqResponse.json();
    return { success: true, model: 'groq-free', data };
  } catch (err) {
    console.error(`[FREE-TIER] Groq request failed: ${err.message}. Both free tiers exhausted.`);
    return {
      success: false,
      status: 503,
      error: DAILY_FREE_LIMIT_MESSAGE
    };
  }
}

// ---------------------------------------------------------------------------
// ROUTE: POST /chat
// Accepts: { messages, model_preference, estimated_tokens, session_id }
// Flow: Auth → Cap & Routing Check → Route to LiteLLM → Log Usage → Respond
// ---------------------------------------------------------------------------
app.post('/chat', globalRateLimiter, authenticate, async (req, res) => {
  const userId = req.user.id;
  const { messages, model_preference, estimated_tokens, session_id, project_path } = req.body;

  // Input validation
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required and must not be empty' });
  }

  // Extract Premium Toggle header
  const forceModelHeader = req.headers['x-albion-force-model'] || null;

  // Detect image context in conversation
  const hasImages = messages.some(m => {
    if (Array.isArray(m.content)) {
      return m.content.some(c => c.type === 'image_url' || c.image_url);
    }
    return false;
  });

  try {
    // STEP 1: Pre-request cap & routing check — BEFORE any provider call
    const estimatedTokenCount = estimated_tokens || 1000;
    const capResult = await checkCapBeforeRoute(userId, {
      forceModel: forceModelHeader,
      hasImages,
      estimatedTokens: estimatedTokenCount
    });

    const targetModel = capResult.targetModel;

    // STEP 2: Fetch project_memory directly from Supabase (Zero Trust Client Body)
    // Enforces Master Build Plan Rule 5: Strict Context Ordering for prefix caching.
    let memoryBlock = '<project_memory></project_memory>';

    if (project_path && typeof project_path === 'string') {
      try {
        const { data: memData, error: memError } = await supabase
          .from('project_memory')
          .select('memory_content')
          .eq('user_id', userId)
          .eq('project_path', project_path)
          .single();

        if (!memError && memData && memData.memory_content) {
          const content = memData.memory_content.trim();
          memoryBlock = `<project_memory>\n${content}\n</project_memory>`;
        }
      } catch (memErr) {
        console.warn(`[CHAT] Failed to query project_memory for user ${userId}:`, memErr.message);
      }
    }

    // STEP 3: Inject memory context into ordered messages
    // [System Prompt] -> [<project_memory>] -> [History / User Message]
    let orderedMessages = [...messages];
    const hasSystemPrompt = orderedMessages.length > 0 && orderedMessages[0].role === 'system';

    if (hasSystemPrompt) {
      orderedMessages[0] = {
        role: 'system',
        content: `${orderedMessages[0].content}\n\n${memoryBlock}`
      };
    } else {
      orderedMessages.unshift({
        role: 'system',
        content: memoryBlock
      });
    }

    // Set custom transparency & fuel gauge response headers
    res.setHeader('X-Albion-Usage-Percent', capResult.usagePercent.toString());
    res.setHeader('X-Albion-Active-Model', targetModel);
    res.setHeader('X-Albion-Tier', capResult.tier);
    res.setHeader('X-Albion-Current-Tokens', capResult.currentUsage.toString());
    res.setHeader('X-Albion-Cap-Tokens', capResult.tierCap.toString());
    res.setHeader('X-Albion-Caps-Summary', JSON.stringify(capResult.capsSummary || {}));

    if (capResult.warning) {
      res.setHeader('X-Albion-Usage-Warning', capResult.warning);
    }

    // STEP 5: Route request
    // Free Tier OR All Caps Exhausted: Dispatch to Stacked Cloud Free Tier (OpenRouter -> Groq)
    // NEVER call LiteLLM or paid DeepInfra/Together models when caps are exhausted.
    if (capResult.isFreeTier || capResult.allCapsExhausted || FREE_TIER_MODELS.has(targetModel)) {
      const freeResult = await dispatchFreeTierChat(orderedMessages, {
        userId,
        project_path
      });

      if (!freeResult.success) {
        return res.status(503).json({
          error: freeResult.error || DAILY_FREE_LIMIT_MESSAGE
        });
      }

      // Update active model header with the specific free model that answered
      res.setHeader('X-Albion-Active-Model', freeResult.model);

      return res.json(freeResult.data);
    }

    // Paid Cloud Routing via LiteLLM (OpenAI-compatible)
    const providerResponse = await fetch(`${LITELLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LITELLM_MASTER_KEY}`
      },
      body: JSON.stringify({
        model: targetModel,
        messages: orderedMessages,
        timeout: 30000,
        metadata: {
          user_id: userId,
          tier: capResult.tier,
          usage_percent: capResult.usagePercent,
          session_id: session_id || null,
          project_path: project_path || null
        }
      })
    });

    // STEP 6: Parse response — throw on provider failure
    if (!providerResponse.ok) {
      const errorText = await providerResponse.text().catch(() => 'Unknown provider error');
      console.error(`[CHAT] Provider returned ${providerResponse.status} for model ${targetModel} (user ${userId}): ${errorText}`);

      throw new Error(`Provider returned HTTP ${providerResponse.status}`);
    }

    const data = await providerResponse.json();

    // STEP 7: Synchronously log usage BEFORE responding to client (paid models only)
    if (!FREE_TIER_MODELS.has(targetModel)) {
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
    }

    // STEP 8: Return provider response to Cline
    return res.json(data);

  } catch (err) {
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(err, {
        user: { id: userId },
        extra: { project_path }
      });
    }

    console.error(`[CHAT] Error for user ${userId}:`, err.message);

    if (typeof targetModel !== 'undefined' && FREE_TIER_MODELS.has(targetModel)) {
      return res.status(503).json({
        error: DAILY_FREE_LIMIT_MESSAGE
      });
    }

    return res.status(502).json({
      error: 'Provider unavailable. Retrying...',
      retry_after: 2000
    });
  }
});

// ---------------------------------------------------------------------------
// ROUTE: POST /billing/topup-check
// Top-Up Restriction (Requirement 4):
// A user may initiate a top-up/re-subscription ONLY if MAX(model_usage / model_cap) >= 0.85
// for any model in their tier. Otherwise returns 403.
// ---------------------------------------------------------------------------
app.post('/billing/topup-check', authenticate, async (req, res) => {
  const userId = req.user.id;

  try {
    const capStatus = await checkCapBeforeRoute(userId);

    if (capStatus.tier === 'free') {
      return res.json({
        eligible: true,
        tier: 'free',
        message: 'Free tier user eligible to upgrade to any paid tier.'
      });
    }

    const maxUtil = capStatus.maxUtilization || 0;
    const maxPercent = Number((maxUtil * 100).toFixed(1));

    if (maxUtil < 0.85) {
      return res.status(403).json({
        error: 'Top-up available when a model cap reaches 85% utilization',
        current_max_utilization: maxPercent,
        tier: capStatus.tier
      });
    }

    return res.json({
      eligible: true,
      current_max_utilization: maxPercent,
      tier: capStatus.tier,
      capsSummary: capStatus.capsSummary
    });
  } catch (err) {
    console.error(`[TOPUP-CHECK] Error for user ${userId}:`, err.message);
    return res.status(500).json({ error: 'Failed to verify top-up eligibility' });
  }
});

// ---------------------------------------------------------------------------
// ROUTE: POST /webhooks/paystack
// Paystack webhook listener with HMAC SHA512 signature verification
// Handles: charge.success, subscription.create, subscription.disable
// ---------------------------------------------------------------------------
app.post('/webhooks/paystack', paystackRateLimiter, async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const secretKey = process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_TEST_SECRET_KEY || PAYSTACK_SECRET_KEY || '';

  if (!signature || !secretKey) {
    console.warn('[WEBHOOK] Missing Paystack signature or secret key not configured');
    return res.status(401).json({ error: 'Missing or invalid signature' });
  }

  // Verify HMAC SHA512 signature
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const hash = crypto
    .createHmac('sha512', secretKey)
    .update(rawBody)
    .digest('hex');

  if (hash !== signature) {
    console.error('[WEBHOOK] Invalid Paystack signature received');
    return res.status(401).json({ error: 'Signature mismatch' });
  }

  const event = req.body;
  if (!event || !event.event) {
    return res.status(400).json({ error: 'Invalid event payload' });
  }

  const eventType = event.event;
  const eventData = event.data || {};
  const paystackRef = eventData.reference || null;
  console.log(`[WEBHOOK] Verified Paystack event: ${eventType} (ref: ${paystackRef || 'n/a'})`);

  try {
    // Idempotency check: prevent double-processing if reference already recorded
    if (paystackRef) {
      if (processedWebhookIds.has(paystackRef)) {
        console.log(`[WEBHOOK] Event with reference ${paystackRef} already processed. Skipping.`);
        return res.status(200).json({ received: true, message: 'Already processed' });
      }
      try {
        const { data: existingEvent } = await supabase
          .from('billing_events')
          .select('id')
          .eq('paystack_reference', paystackRef)
          .maybeSingle();

        if (existingEvent) {
          processedWebhookIds.add(paystackRef);
          console.log(`[WEBHOOK] Event with reference ${paystackRef} already processed. Skipping.`);
          return res.status(200).json({ received: true, message: 'Already processed' });
        }
      } catch (e) { /* ignore if table not created yet */ }
      processedWebhookIds.add(paystackRef);
    }

    let targetUserId = eventData.metadata?.user_id || eventData.customer?.metadata?.user_id;

    // Resolve user by email if not found directly in metadata
    if (!targetUserId && eventData.customer?.email) {
      const { data: userData } = await supabase
        .from('users')
        .select('id')
        .eq('email', eventData.customer.email)
        .single();
      if (userData) targetUserId = userData.id;
    }

    // Process subscription events
    if (eventType === 'charge.success' || eventType === 'subscription.create') {
      const planTier = eventData.metadata?.tier || eventData.plan?.name?.toLowerCase() || 'starter';
      const resolvedTier = tierCaps[planTier] ? planTier : 'starter';

      if (targetUserId) {
        await supabase
          .from('subscriptions')
          .upsert({
            user_id: targetUserId,
            tier: resolvedTier,
            status: 'active',
            cycle_start: new Date().toISOString()
          }, {
            onConflict: 'user_id'
          });
        console.log(`[WEBHOOK] Activated subscription (${resolvedTier}) for user ${targetUserId}`);
      }
    } else if (eventType === 'subscription.disable') {
      if (targetUserId) {
        await supabase
          .from('subscriptions')
          .update({ status: 'cancelled' })
          .eq('user_id', targetUserId);
        console.log(`[WEBHOOK] Cancelled subscription for user ${targetUserId}`);
      }
    }

    // Log event to public.billing_events audit table
    if (targetUserId) {
      const eventInsert = {
        user_id: targetUserId,
        event_type: eventType,
        paystack_reference: paystackRef,
        amount: eventData.amount ? (eventData.amount / 100) : 0,
        currency: eventData.currency || 'NGN',
        provider: 'paystack',
        status: 'success',
        raw_payload: event
      };

      const { error: insertErr } = await supabase.from('billing_events').insert(eventInsert);
      if (insertErr) {
        // Fallback without provider column if schema migration not yet run
        if (insertErr.message && insertErr.message.includes('provider')) {
          delete eventInsert.provider;
          await supabase.from('billing_events').insert(eventInsert).catch(e => {
            console.error('[WEBHOOK] Failed to log fallback billing_event:', e.message);
          });
        } else {
          console.error('[WEBHOOK] Failed to log billing_event:', insertErr.message);
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[WEBHOOK] Error processing event ${eventType}:`, err.message);
    return res.status(500).json({ error: 'Webhook processing error' });
  }
});

// ---------------------------------------------------------------------------
// ROUTE: POST /webhooks/lemonsqueezy
// Lemon Squeezy webhook listener with HMAC SHA256 signature verification
// Handles: order_created, subscription_created, subscription_cancelled
// ---------------------------------------------------------------------------
app.post('/webhooks/lemonsqueezy', lemonSqueezyRateLimiter, async (req, res) => {
  const signature = req.headers['x-signature'];
  const secretKey = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || LEMONSQUEEZY_WEBHOOK_SECRET || '';

  if (!signature || !secretKey) {
    console.warn('[WEBHOOK-LS] Missing Lemon Squeezy signature or secret key not configured');
    return res.status(401).json({ error: 'Missing or invalid signature' });
  }

  // Verify HMAC SHA256 signature against raw body
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const hash = crypto
    .createHmac('sha256', secretKey)
    .update(rawBody)
    .digest('hex');

  if (hash !== signature) {
    console.error('[WEBHOOK-LS] Invalid Lemon Squeezy signature received');
    return res.status(401).json({ error: 'Signature mismatch' });
  }

  const payload = req.body;
  if (!payload) {
    return res.status(400).json({ error: 'Invalid event payload' });
  }

  const eventName = payload.meta?.event_name || payload.event || payload.type || '';
  const customData = payload.meta?.custom_data || {};
  const eventData = payload.data || {};
  const attributes = eventData.attributes || {};

  // Extract event_id for idempotency
  const eventId = String(
    payload.meta?.webhook_id ||
    payload.meta?.event_id ||
    eventData.id ||
    `ls_${Date.now()}`
  );

  console.log(`[WEBHOOK-LS] Verified Lemon Squeezy event: ${eventName} (event_id: ${eventId})`);

  try {
    // Idempotency check: prevent double-processing if event_id or reference already recorded
    if (eventId) {
      if (processedWebhookIds.has(eventId)) {
        console.log(`[WEBHOOK-LS] Event ${eventId} already processed. Skipping duplicate.`);
        return res.status(200).json({ received: true, message: 'Already processed' });
      }
      try {
        const { data: existing } = await supabase
          .from('billing_events')
          .select('id')
          .or(`event_id.eq.${eventId},paystack_reference.eq.${eventId}`)
          .maybeSingle();

        if (existing) {
          processedWebhookIds.add(eventId);
          console.log(`[WEBHOOK-LS] Event ${eventId} already processed. Skipping duplicate.`);
          return res.status(200).json({ received: true, message: 'Already processed' });
        }
      } catch (e) { /* ignore if table not created yet */ }
      processedWebhookIds.add(eventId);
    }

    // Resolve user: from custom_data.user_id, custom_data.userId, or attributes.user_email
    let targetUserId = customData.user_id || customData.userId || customData.customer_id;
    const userEmail = attributes.user_email || attributes.customer_email;

    if (!targetUserId && userEmail) {
      const { data: userData } = await supabase
        .from('users')
        .select('id')
        .eq('email', userEmail)
        .single();
      if (userData) targetUserId = userData.id;
    }

    // Resolve subscription tier:
    const rawTier = (
      customData.tier ||
      attributes.first_order_item?.variant_name ||
      attributes.variant_name ||
      attributes.product_name ||
      'starter'
    ).toLowerCase();

    let resolvedTier = 'starter';
    if (rawTier.includes('pro')) {
      resolvedTier = 'pro';
    } else if (rawTier.includes('learner')) {
      resolvedTier = 'learner';
    } else if (rawTier.includes('starter')) {
      resolvedTier = 'starter';
    } else if (tierCaps[rawTier]) {
      resolvedTier = rawTier;
    }

    // Process subscription events
    if (
      eventName === 'order_created' ||
      eventName === 'subscription_created' ||
      eventName === 'subscription_resumed'
    ) {
      if (targetUserId) {
        await supabase
          .from('subscriptions')
          .upsert({
            user_id: targetUserId,
            tier: resolvedTier,
            status: 'active',
            cycle_start: new Date().toISOString()
          }, {
            onConflict: 'user_id'
          });
        console.log(`[WEBHOOK-LS] Activated subscription (${resolvedTier}) for user ${targetUserId}`);
      }
    } else if (
      eventName === 'subscription_cancelled' ||
      eventName === 'subscription_expired'
    ) {
      if (targetUserId) {
        await supabase
          .from('subscriptions')
          .update({ status: 'cancelled' })
          .eq('user_id', targetUserId);
        console.log(`[WEBHOOK-LS] Cancelled subscription for user ${targetUserId}`);
      }
    }

    // Log event to public.billing_events audit table
    if (targetUserId) {
      const totalAmount = attributes.total_usd
        ? (attributes.total_usd / 100)
        : (attributes.total ? (attributes.total / 100) : 0);
      const currency = attributes.currency || 'USD';

      const billingInsert = {
        user_id: targetUserId,
        event_type: eventName,
        event_id: eventId,
        paystack_reference: eventId,
        provider: 'lemonsqueezy',
        amount: totalAmount,
        currency: currency,
        status: 'success',
        raw_payload: payload
      };

      const { error: insertErr } = await supabase.from('billing_events').insert(billingInsert);
      if (insertErr) {
        if (insertErr.message && (insertErr.message.includes('provider') || insertErr.message.includes('event_id'))) {
          // Fallback if provider or event_id columns are not yet present
          delete billingInsert.provider;
          delete billingInsert.event_id;
          await supabase.from('billing_events').insert(billingInsert).catch(e => {
            console.error('[WEBHOOK-LS] Failed to log fallback billing_event:', e.message);
          });
        } else {
          console.error('[WEBHOOK-LS] Failed to log billing_event:', insertErr.message);
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[WEBHOOK-LS] Error processing event ${eventName}:`, err.message);
    return res.status(500).json({ error: 'Webhook processing error' });
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
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Albion Proxy running on port ${PORT}`);
    console.log(`LiteLLM target: ${LITELLM_BASE_URL}`);
    console.log(`CORS origins: ${ALLOWED_ORIGINS}`);
  });
}

module.exports = {
  app,
  supabase,
  dispatchFreeTierChat,
  checkCapBeforeRoute,
  tierCaps,
  FREE_TIER_MODELS,
  DAILY_FREE_LIMIT_MESSAGE
};
