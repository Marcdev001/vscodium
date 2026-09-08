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
const crypto = require('crypto');
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
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';

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
app.use(cors({
  origin: ALLOWED_ORIGINS,
  exposedHeaders: [
    'X-Albion-Usage-Percent',
    'X-Albion-Active-Model',
    'X-Albion-Tier',
    'X-Albion-Usage-Warning',
    'X-Albion-Current-Tokens',
    'X-Albion-Cap-Tokens'
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
// CAP CHECK: checkCapBeforeRoute
// Queries Supabase for the user's subscription tier and current-cycle usage.
// Calculates usage percentage, 80% soft warning, and 100% hard ceiling auto-downgrade.
// CRITICAL: This MUST run BEFORE any request reaches a provider.
// ---------------------------------------------------------------------------
async function checkCapBeforeRoute(userId, estimatedTokens = 1000) {
  // 1. Get user's active subscription
  const { data: subscription, error: subError } = await supabase
    .from('subscriptions')
    .select('tier, cycle_start')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  const tier = (subscription && subscription.tier && tierCaps[subscription.tier])
    ? subscription.tier
    : 'learner';
  const cycleStart = subscription ? subscription.cycle_start : new Date(0).toISOString();

  // 2. Get current cycle usage via RPC
  let currentUsage = 0;
  try {
    const { data: usageData, error: usageError } = await supabase
      .rpc('get_current_cycle_usage', {
        p_user_id: userId,
        p_cycle_start: cycleStart
      });
    if (!usageError && typeof usageData === 'number') {
      currentUsage = usageData;
    }
  } catch (err) {
    console.warn(`[CAP] Usage RPC error for user ${userId}:`, err.message);
  }

  const caps = tierCaps[tier] || tierCaps.learner;
  const primaryCap = caps.flash;
  const usagePercent = Number(((currentUsage / primaryCap) * 100).toFixed(1));
  const projectedUsage = currentUsage + estimatedTokens;

  let warning = null;
  let forceFlash = false;

  // 100% Threshold: Auto-downgrade to flash, warning: hard_ceiling_reached
  if (usagePercent >= 100 || projectedUsage > primaryCap) {
    warning = 'hard_ceiling_reached';
    forceFlash = true;
  } else if (usagePercent >= 80) {
    // 80% Threshold: Warning: approaching_limit
    warning = 'approaching_limit';
    forceFlash = false;
  }

  return {
    tier,
    currentUsage,
    tierCap: primaryCap,
    usagePercent,
    warning,
    forceFlash
  };
}

// ---------------------------------------------------------------------------
// ROUTE: POST /chat
// Accepts: { messages, model_preference, estimated_tokens, session_id }
// Flow: Auth → Cap Check → Route to LiteLLM → Log Usage → Respond
// ---------------------------------------------------------------------------
app.post('/chat', authenticate, async (req, res) => {
  const userId = req.user.id;
  const { messages, model_preference, estimated_tokens, session_id, project_path } = req.body;

  // Input validation
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required and must not be empty' });
  }

  try {
    // STEP 1: Pre-request cap check — BEFORE any provider call
    const estimatedTokenCount = estimated_tokens || 1000;
    const capResult = await checkCapBeforeRoute(userId, estimatedTokenCount);

    // STEP 2: Fetch project_memory from Supabase (never trust client-supplied memory)
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

    // STEP 4: Determine target model (Strict Soft/Hard Ceiling enforcement)
    let targetModel;
    if (capResult.forceFlash) {
      targetModel = 'deepseek-v4-flash';
    } else {
      targetModel = model_preference || 'deepseek-v4-flash';
    }

    // Set custom transparency & fuel gauge response headers
    res.setHeader('X-Albion-Usage-Percent', capResult.usagePercent.toString());
    res.setHeader('X-Albion-Active-Model', targetModel);
    res.setHeader('X-Albion-Tier', capResult.tier);
    res.setHeader('X-Albion-Current-Tokens', capResult.currentUsage.toString());
    res.setHeader('X-Albion-Cap-Tokens', capResult.tierCap.toString());

    if (capResult.warning) {
      res.setHeader('X-Albion-Usage-Warning', capResult.warning);
    }

    // STEP 5: Route via direct HTTP POST to LiteLLM (OpenAI-compatible)
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
      console.error(`[CHAT] Provider returned ${providerResponse.status} for user ${userId}: ${errorText}`);
      throw new Error(`Provider returned HTTP ${providerResponse.status}`);
    }

    const data = await providerResponse.json();

    // STEP 7: Synchronously log usage BEFORE responding to client
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

    // STEP 8: Return provider response to Cline
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
// ROUTE: POST /webhooks/paystack
// Paystack webhook listener with HMAC SHA512 signature verification
// Handles: charge.success, subscription.create, subscription.disable
// ---------------------------------------------------------------------------
app.post('/webhooks/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];

  if (!signature || !PAYSTACK_SECRET_KEY) {
    console.warn('[WEBHOOK] Missing Paystack signature or secret key not configured');
    return res.status(401).json({ error: 'Missing or invalid signature' });
  }

  // Verify HMAC SHA512 signature
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
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
  console.log(`[WEBHOOK] Verified Paystack event: ${eventType} (ref: ${eventData.reference || 'n/a'})`);

  try {
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
      await supabase.from('billing_events').insert({
        user_id: targetUserId,
        event_type: eventType,
        paystack_reference: eventData.reference || null,
        amount: eventData.amount ? (eventData.amount / 100) : 0,
        currency: eventData.currency || 'NGN',
        status: 'success',
        raw_payload: event
      }).catch(err => {
        console.error('[WEBHOOK] Failed to log billing_event:', err.message);
      });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[WEBHOOK] Error processing event ${eventType}:`, err.message);
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
app.listen(PORT, () => {
  console.log(`Albion Proxy running on port ${PORT}`);
  console.log(`LiteLLM target: ${LITELLM_BASE_URL}`);
  console.log(`CORS origins: ${ALLOWED_ORIGINS}`);
});
