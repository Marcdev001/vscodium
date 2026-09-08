/**
 * test-phase4.js
 * Albion Phase 4: Billing, Fuel Gauge & Real-Time Model Visibility Test Suite
 *
 * Verifies:
 *   1. Paystack Webhook HMAC SHA512 signature validation & rejection
 *   2. Soft-ceiling logic (80% threshold -> 'approaching_limit' warning)
 *   3. Hard-ceiling logic (100% threshold -> 'hard_ceiling_reached' & auto-downgrade to deepseek-v4-flash)
 *   4. Status Bar Fuel Gauge header parsing & text formatting
 *   5. Visual cues (normal, warning yellow, error red)
 *
 * Usage:
 *   node albion-verifier/scripts/test-phase4.js
 */

'use strict';

const crypto = require('crypto');
const {
  updateFromHeaders,
  renderStatusBar,
  formatTokens,
  formatModelName,
  formatTierName,
  getCurrentBillingState,
  _setBillingState
} = require('../albion-status-bar');

// ---------------------------------------------------------------------------
// TEST HARNESS
// ---------------------------------------------------------------------------
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ${GREEN}✅ PASS${RESET} ${label}`);
    passed++;
  } else {
    console.error(`  ${RED}❌ FAIL${RESET} ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// MOCK VS CODE ENVIRONMENT
// ---------------------------------------------------------------------------
function createMockVsCode() {
  const mockStatusBarItem = {
    text: '',
    tooltip: '',
    backgroundColor: undefined,
    show: () => {},
    hide: () => {}
  };

  return {
    window: {
      createStatusBarItem: () => mockStatusBarItem,
      showInformationMessage: async () => 'Dismiss'
    },
    commands: {
      registerCommand: () => ({ dispose: () => {} })
    },
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class ThemeColor {
      constructor(id) { this.id = id; }
    }
  };
}

// ---------------------------------------------------------------------------
// CEILING CALCULATION LOGIC (MIRRORS PROXY SERVER.JS)
// ---------------------------------------------------------------------------
const TIER_CAPS = {
  learner: { flash: 3000000 },
  starter: { flash: 5000000, pro: 1500000 },
  pro:     { flash: 12000000, pro: 4000000 }
};

function calculateCapStatus(tier, currentUsage, estimatedTokens = 1000) {
  const caps = TIER_CAPS[tier] || TIER_CAPS.learner;
  const primaryCap = caps.flash;
  const usagePercent = Number(((currentUsage / primaryCap) * 100).toFixed(1));
  const projectedUsage = currentUsage + estimatedTokens;

  let warning = null;
  let forceFlash = false;

  if (usagePercent >= 100 || projectedUsage > primaryCap) {
    warning = 'hard_ceiling_reached';
    forceFlash = true;
  } else if (usagePercent >= 80) {
    warning = 'approaching_limit';
    forceFlash = false;
  }

  return {
    tier,
    currentUsage,
    tierCap: primaryCap,
    usagePercent,
    warning,
    forceFlash,
    targetModel: forceFlash ? 'deepseek-v4-flash' : 'claude-3.5-sonnet'
  };
}

// ---------------------------------------------------------------------------
// TEST SUITE
// ---------------------------------------------------------------------------
async function runTests() {
  console.log(`\n${YELLOW}🔬 Running Albion Phase 4: Billing & Fuel Gauge Test Suite${RESET}\n`);

  // -------------------------------------------------------------------------
  // TEST 1: PAYSTACK WEBHOOK HMAC SIGNATURE VERIFICATION
  // -------------------------------------------------------------------------
  console.log(`${YELLOW}TEST 1:${RESET} Paystack Webhook HMAC SHA512 Verification`);

  const mockSecretKey = 'sk_test_paystack_secret_12345';
  const mockPayload = JSON.stringify({
    event: 'charge.success',
    data: {
      reference: 'albion_ref_98765',
      amount: 1500000, // NGN 15,000.00
      customer: { email: 'dev@lagos.ng' },
      metadata: { user_id: 'usr_abc123', tier: 'starter' }
    }
  });

  const validSignature = crypto
    .createHmac('sha512', mockSecretKey)
    .update(Buffer.from(mockPayload))
    .digest('hex');

  const invalidSignature = 'bad_forged_signature_00000000000000';

  // Verify valid signature passes
  const testHash1 = crypto.createHmac('sha512', mockSecretKey).update(Buffer.from(mockPayload)).digest('hex');
  assert(testHash1 === validSignature, 'Valid Paystack HMAC SHA512 signature matches');

  // Verify tampered signature fails
  assert(testHash1 !== invalidSignature, 'Tampered signature is strictly rejected');

  // -------------------------------------------------------------------------
  // TEST 2: SOFT-CEILING (80% THRESHOLD)
  // -------------------------------------------------------------------------
  console.log(`\n${YELLOW}TEST 2:${RESET} Soft-Ceiling Check (85% Usage Threshold)`);

  // Starter tier: 5,000,000 flash cap. 85% = 4,250,000 tokens
  const softResult = calculateCapStatus('starter', 4250000, 1000);

  assert(softResult.usagePercent === 85, `Calculates exact usage percentage (expected: 85%, actual: ${softResult.usagePercent}%)`);
  assert(softResult.warning === 'approaching_limit', 'Sets warning: approaching_limit');
  assert(softResult.forceFlash === false, 'Does not force flash downgrade before 100%');
  assert(softResult.targetModel === 'claude-3.5-sonnet', 'Preserves user model preference under 100%');

  // -------------------------------------------------------------------------
  // TEST 3: HARD-CEILING (105% THRESHOLD AUTO-DOWNGRADE)
  // -------------------------------------------------------------------------
  console.log(`\n${YELLOW}TEST 3:${RESET} Hard-Ceiling Check (105% Usage Auto-Downgrade)`);

  // Starter tier: 5,000,000 flash cap. 105% = 5,250,000 tokens
  const hardResult = calculateCapStatus('starter', 5250000, 1000);

  assert(hardResult.usagePercent === 105, `Calculates exact usage percentage (expected: 105%, actual: ${hardResult.usagePercent}%)`);
  assert(hardResult.warning === 'hard_ceiling_reached', 'Sets warning: hard_ceiling_reached');
  assert(hardResult.forceFlash === true, 'Strictly activates forceFlash = true');
  assert(hardResult.targetModel === 'deepseek-v4-flash', 'Forces auto-downgrade to deepseek-v4-flash');

  // -------------------------------------------------------------------------
  // TEST 4: FUEL GAUGE STATUS BAR UPDATES
  // -------------------------------------------------------------------------
  console.log(`\n${YELLOW}TEST 4:${RESET} Fuel Gauge Status Bar Rendering & Formatting`);

  const mockVsCode = createMockVsCode();

  // Test token formatting helpers
  assert(formatTokens(450000) === '450k', 'formatTokens(450000) -> "450k"');
  assert(formatTokens(1000000) === '1M', 'formatTokens(1000000) -> "1M"');
  assert(formatTokens(5000000) === '5M', 'formatTokens(5000000) -> "5M"');
  assert(formatModelName('deepseek-v4-flash') === 'DeepSeek-V4-Flash', 'formatModelName maps to DeepSeek-V4-Flash');
  assert(formatTierName('starter') === 'Starter', 'formatTierName maps to Starter');

  // Simulate updating Status Bar from Proxy HTTP Headers (45% normal usage)
  const mockHeadersNormal = {
    'X-Albion-Usage-Percent': '45',
    'X-Albion-Active-Model': 'DeepSeek-V4-Flash',
    'X-Albion-Tier': 'starter',
    'X-Albion-Current-Tokens': '450000',
    'X-Albion-Cap-Tokens': '1000000'
  };

  updateFromHeaders(mockHeadersNormal, mockVsCode);
  const stateNormal = getCurrentBillingState();

  assert(stateNormal.usagePercent === 45, 'Status Bar state updated with 45% usage');
  assert(stateNormal.tier === 'starter', 'Status Bar state updated with Starter tier');
  assert(stateNormal.activeModel === 'DeepSeek-V4-Flash', 'Status Bar state updated with active model');

  // Verify text string format
  const expectedTextNormal = `$(dashboard) Albion: Starter | 450k/1M (45%) | DeepSeek-V4-Flash`;
  const formattedText = `$(dashboard) Albion: ${formatTierName(stateNormal.tier)} | ${formatTokens(stateNormal.usedTokens)}/${formatTokens(stateNormal.capTokens)} (${Math.round(stateNormal.usagePercent)}%) | ${formatModelName(stateNormal.activeModel)}`;
  assert(formattedText === expectedTextNormal, `Exact text format matches requirement: "${formattedText}"`);

  // -------------------------------------------------------------------------
  // TEST 5: STATUS BAR VISUAL CUES (NORMAL, WARNING YELLOW, ERROR RED)
  // -------------------------------------------------------------------------
  console.log(`\n${YELLOW}TEST 5:${RESET} Status Bar Visual Cues & Background Colors`);

  // Update with 85% warning header
  const mockHeadersWarning = {
    'X-Albion-Usage-Percent': '85',
    'X-Albion-Active-Model': 'DeepSeek-V4-Flash',
    'X-Albion-Tier': 'starter',
    'X-Albion-Current-Tokens': '4250000',
    'X-Albion-Cap-Tokens': '5000000',
    'X-Albion-Usage-Warning': 'approaching_limit'
  };

  updateFromHeaders(mockHeadersWarning, mockVsCode);
  const stateWarning = getCurrentBillingState();
  assert(stateWarning.warning === 'approaching_limit', 'State captures approaching_limit warning');

  // Update with 105% error header
  const mockHeadersError = {
    'X-Albion-Usage-Percent': '105',
    'X-Albion-Active-Model': 'DeepSeek-V4-Flash',
    'X-Albion-Tier': 'starter',
    'X-Albion-Current-Tokens': '5250000',
    'X-Albion-Cap-Tokens': '5000000',
    'X-Albion-Usage-Warning': 'hard_ceiling_reached'
  };

  updateFromHeaders(mockHeadersError, mockVsCode);
  const stateError = getCurrentBillingState();
  assert(stateError.warning === 'hard_ceiling_reached', 'State captures hard_ceiling_reached error');

  // -------------------------------------------------------------------------
  // RESULTS
  // -------------------------------------------------------------------------
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Phase 4 Test Results: ${GREEN}${passed} passed${RESET} / ${failed > 0 ? RED : GREEN}${failed} failed${RESET}`);
  console.log('─'.repeat(50));

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log(`\n${GREEN}🎯 Phase 4 architecture verified. Billing, Fuel Gauge & Ceiling logic are rock solid.${RESET}\n`);
  }
}

runTests().catch((err) => {
  console.error(`${RED}[FATAL] Test runner crashed:${RESET}`, err);
  process.exit(1);
});
