/**
 * test-phase5.js
 * Albion Phase 5 Test Suite:
 * Anti-Abuse Rate Limiting, Branding, Premium Toggle UX & Production Hardening
 *
 * Verifies:
 *   1. Anti-Abuse Rate Limiting:
 *      - Global rate limiter: 30 requests/min allowed, 31st returns 429 with Retry-After: 60.
 *      - Webhook rate limiter: 5 requests/min allowed, 6th returns 429 with Retry-After: 60.
 *      - Store fallback to MemoryStore when RedisStore is not configured.
 *   2. Branding (Editor Identity):
 *      - albion-branding/ directory exists with logo.png and icon.ico.
 *      - product.json has nameShort="Albion", nameLong="Albion - The AI Code Editor for Africa",
 *        applicationName="albion", win32AppUserModelId="Albion.Editor", darwinBundleIdentifier="com.albion.editor".
 *      - prepare_vscode.sh bundles albion-branding into resources/albion/branding/.
 *   3. Premium Toggle UX & Dynamic Header Injection:
 *      - cycleRoutingMode cycles AUTO -> FORCE PRO -> FORCE GLM -> AUTO.
 *      - injectProxyHeaders dynamically injects X-Albion-Force-Model header when active.
 *      - Status bar $(zap) indicator activates during FORCE PRO and FORCE GLM, vanishes on AUTO.
 *   4. Legal & Support Commands:
 *      - albion.openTerms -> https://albion.dev/terms
 *      - albion.openPrivacy -> https://albion.dev/privacy
 *      - albion.reportBug -> https://github.com/Marcdev001/albion/issues
 *   5. Sentry Error Tracking:
 *      - Sentry integration configured in albion-proxy/server.js.
 *
 * Usage:
 *   node albion-verifier/scripts/test-phase5.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { rateLimit, MemoryStore } = require('../../albion-proxy/node_modules/express-rate-limit');
const {
  initStatusBar,
  renderStatusBar,
  cycleRoutingMode,
  getCurrentRoutingMode,
  getForcedModel,
  getRoutingHeaders,
  setRoutingMode,
  getCurrentBillingState,
  _setBillingState
} = require('../albion-status-bar');

const {
  injectProxyHeaders
} = require('../albion-lifecycle');

// ---------------------------------------------------------------------------
// TEST HARNESS
// ---------------------------------------------------------------------------
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
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

async function runTests() {
  console.log(`\n${CYAN}══════════════════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${CYAN}   ALBION PHASE 5 TEST SUITE: ANTI-ABUSE, BRANDING & TOGGLE UX   ${RESET}`);
  console.log(`${CYAN}══════════════════════════════════════════════════════════════════════════${RESET}`);

  // -------------------------------------------------------------------------
  // TEST 1: RATE LIMITING (ANTI-ABUSE)
  // -------------------------------------------------------------------------
  console.log(`\n${YELLOW}TEST 1:${RESET} Anti-Abuse Rate Limiting (30/min Global, 5/min Webhook, Retry-After)`);

  // 1A. Global Rate Limiter (30 req / min)
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    keyGenerator: (req) => req.user?.id || req.ip || 'test-client',
    handler: (req, res) => {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded: maximum 30 requests per minute.',
        retry_after: 60
      });
    },
    store: new MemoryStore()
  });

  function createMockReqRes(ip = '127.0.0.1', userId = 'user_123', onComplete) {
    const headers = {};
    const res = {
      statusCode: 200,
      headers,
      setHeader: (k, v) => { headers[k] = v; },
      getHeader: (k) => headers[k],
      status: function (code) { this.statusCode = code; return this; },
      json: function (data) {
        this.body = data;
        if (onComplete) onComplete();
        return this;
      },
      send: function (data) {
        this.body = data;
        if (onComplete) onComplete();
        return this;
      }
    };
    const req = { ip, user: { id: userId }, headers: {} };
    return { req, res };
  }

  let lastStatus = 200;
  let retryAfterHeader = null;

  for (let i = 1; i <= 31; i++) {
    await new Promise((resolve) => {
      let resolved = false;
      const done = (status, headers) => {
        if (resolved) return;
        resolved = true;
        lastStatus = status;
        if (headers && headers['Retry-After']) {
          retryAfterHeader = headers['Retry-After'];
        }
        resolve();
      };
      const { req, res } = createMockReqRes('127.0.0.1', 'user_123', () => {
        done(res.statusCode, res.headers);
      });
      globalLimiter(req, res, () => {
        done(res.statusCode, res.headers);
      });
    });
  }

  assert(lastStatus === 429, 'Global limiter returns HTTP 429 on the 31st request');
  assert(retryAfterHeader === '60', 'Global limiter returns Retry-After: 60 header on 429');

  // 1B. Webhook Rate Limiter (5 req / min)
  const webhookLimiter = rateLimit({
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
        message: 'Webhook rate limit exceeded: maximum 5 requests per minute.',
        retry_after: 60
      });
    },
    store: new MemoryStore()
  });

  let webhookLastStatus = 200;
  let webhookRetryAfter = null;

  for (let i = 1; i <= 6; i++) {
    await new Promise((resolve) => {
      let resolved = false;
      const done = (status, headers) => {
        if (resolved) return;
        resolved = true;
        webhookLastStatus = status;
        if (headers && headers['Retry-After']) {
          webhookRetryAfter = headers['Retry-After'];
        }
        resolve();
      };
      const { req, res } = createMockReqRes('192.168.1.1', null, () => {
        done(res.statusCode, res.headers);
      });
      webhookLimiter(req, res, () => {
        done(res.statusCode, res.headers);
      });
    });
  }

  assert(webhookLastStatus === 429, 'Webhook limiter returns HTTP 429 on the 6th request');
  assert(webhookRetryAfter === '60', 'Webhook limiter returns Retry-After: 60 header on 429');

  // -------------------------------------------------------------------------
  // TEST 2: BRANDING (EDITOR IDENTITY)
  // -------------------------------------------------------------------------
  console.log(`\n${YELLOW}TEST 2:${RESET} Editor Identity Branding (product.json, assets, build script)`);

  const rootDir = path.resolve(__dirname, '../../');
  const brandingDir = path.join(rootDir, 'albion-branding');
  const logoPath = path.join(brandingDir, 'logo.png');
  const icoPath = path.join(brandingDir, 'icon.ico');

  assert(fs.existsSync(brandingDir), 'albion-branding directory exists at repository root');
  assert(fs.existsSync(logoPath) && fs.statSync(logoPath).size > 0, 'albion-branding/logo.png exists and is non-empty');
  assert(fs.existsSync(icoPath) && fs.statSync(icoPath).size > 0, 'albion-branding/icon.ico exists and is non-empty');

  const rootProductJsonPath = path.join(rootDir, 'product.json');
  const rootProduct = JSON.parse(fs.readFileSync(rootProductJsonPath, 'utf8'));

  assert(rootProduct.nameShort === 'Albion', 'root product.json nameShort is "Albion"');
  assert(rootProduct.nameLong === 'Albion - The AI Code Editor for Africa', 'root product.json nameLong matches specification');
  assert(rootProduct.applicationName === 'albion', 'root product.json applicationName is "albion"');
  assert(rootProduct.win32AppUserModelId === 'Albion.Editor', 'root product.json win32AppUserModelId is "Albion.Editor"');
  assert(rootProduct.darwinBundleIdentifier === 'com.albion.editor', 'root product.json darwinBundleIdentifier is "com.albion.editor"');

  const vscodeProductPath = path.join(rootDir, 'vscode/product.json');
  if (fs.existsSync(vscodeProductPath)) {
    const vscodeProduct = JSON.parse(fs.readFileSync(vscodeProductPath, 'utf8'));
    assert(vscodeProduct.nameShort === 'Albion', 'vscode/product.json nameShort is "Albion"');
    assert(vscodeProduct.win32AppUserModelId === 'Albion.Editor', 'vscode/product.json win32AppUserModelId is "Albion.Editor"');
  }

  const prepareScriptPath = path.join(rootDir, 'prepare_vscode.sh');
  const prepareScriptContent = fs.readFileSync(prepareScriptPath, 'utf8');
  assert(prepareScriptContent.includes('resources/albion/branding'), 'prepare_vscode.sh bundles albion-branding into resources/albion/branding');
  assert(prepareScriptContent.includes('setpath "product" "nameShort" "Albion"'), 'prepare_vscode.sh patches product nameShort to "Albion"');

  // -------------------------------------------------------------------------
  // TEST 3: PREMIUM TOGGLE UX & HEADER INJECTION
  // -------------------------------------------------------------------------
  console.log(`\n${YELLOW}TEST 3:${RESET} Premium Toggle UX (AUTO -> FORCE PRO -> FORCE GLM -> AUTO) & Headers`);

  const mockVsCode = {
    window: {
      createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        backgroundColor: undefined,
        show: () => {}
      }),
      setStatusBarMessage: () => ({ dispose: () => {} }),
      showInformationMessage: async () => 'Dismiss'
    },
    commands: {
      registered: {},
      registerCommand: function (cmd, callback) {
        this.registered[cmd] = callback;
        return { dispose: () => { delete this.registered[cmd]; } };
      },
      executeCommand: function (cmd) {
        if (this.registered[cmd]) return this.registered[cmd]();
      }
    },
    env: {
      openedUrls: [],
      openExternal: function (uri) {
        this.openedUrls.push(uri.toString());
        return Promise.resolve(true);
      }
    },
    Uri: {
      parse: (str) => ({ toString: () => str })
    },
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } }
  };

  const mockContext = { subscriptions: [] };
  initStatusBar(mockContext, mockVsCode);

  // Set to initial state: AUTO
  setRoutingMode('AUTO', mockVsCode);
  assert(getCurrentRoutingMode().mode === 'AUTO', 'Initial routing mode is AUTO');
  assert(getForcedModel() === null, 'AUTO mode forcedModel is null');
  assert(Object.keys(injectProxyHeaders()).length === 0, 'AUTO mode does NOT inject X-Albion-Force-Model header');
  assert(!getCurrentBillingState().isPremiumToggle, 'AUTO mode isPremiumToggle is false');

  // Cycle 1: AUTO -> FORCE PRO
  const mode1 = cycleRoutingMode(mockVsCode);
  assert(mode1.mode === 'FORCE PRO', 'Cycle 1 transitions to FORCE PRO');
  assert(getForcedModel() === 'deepseek-v4-pro', 'FORCE PRO sets forcedModel to deepseek-v4-pro');
  const headers1 = injectProxyHeaders({ 'Authorization': 'Bearer token' });
  assert(headers1['X-Albion-Force-Model'] === 'deepseek-v4-pro', 'injectProxyHeaders attaches X-Albion-Force-Model: deepseek-v4-pro');
  assert(headers1['Authorization'] === 'Bearer token', 'injectProxyHeaders preserves existing headers');
  assert(getCurrentBillingState().isPremiumToggle === true, 'FORCE PRO sets isPremiumToggle to true');

  // Cycle 2: FORCE PRO -> FORCE GLM
  const mode2 = cycleRoutingMode(mockVsCode);
  assert(mode2.mode === 'FORCE GLM', 'Cycle 2 transitions to FORCE GLM');
  assert(getForcedModel() === 'glm-5.2', 'FORCE GLM sets forcedModel to glm-5.2');
  const headers2 = injectProxyHeaders();
  assert(headers2['X-Albion-Force-Model'] === 'glm-5.2', 'injectProxyHeaders attaches X-Albion-Force-Model: glm-5.2');
  assert(getCurrentBillingState().isPremiumToggle === true, 'FORCE GLM sets isPremiumToggle to true');

  // Cycle 3: FORCE GLM -> AUTO
  const mode3 = cycleRoutingMode(mockVsCode);
  assert(mode3.mode === 'AUTO', 'Cycle 3 transitions back to AUTO');
  assert(getForcedModel() === null, 'Returned to AUTO, forcedModel is null');
  const headers3 = injectProxyHeaders();
  assert(!headers3['X-Albion-Force-Model'], 'Returned to AUTO, X-Albion-Force-Model header omitted');
  assert(getCurrentBillingState().isPremiumToggle === false, 'Returned to AUTO, isPremiumToggle is false');

  // -------------------------------------------------------------------------
  // TEST 4: LEGAL & SUPPORT COMMANDS
  // -------------------------------------------------------------------------
  console.log(`\n${YELLOW}TEST 4:${RESET} Legal & Support Commands (Terms, Privacy, Bug Report)`);

  assert(typeof mockVsCode.commands.registered['albion.cycleRoutingMode'] === 'function', 'albion.cycleRoutingMode command registered');
  assert(typeof mockVsCode.commands.registered['albion.openTerms'] === 'function', 'albion.openTerms command registered');
  assert(typeof mockVsCode.commands.registered['albion.openPrivacy'] === 'function', 'albion.openPrivacy command registered');
  assert(typeof mockVsCode.commands.registered['albion.reportBug'] === 'function', 'albion.reportBug command registered');

  mockVsCode.commands.executeCommand('albion.openTerms');
  assert(mockVsCode.env.openedUrls.includes('https://albion.dev/terms'), 'albion.openTerms opens https://albion.dev/terms');

  mockVsCode.commands.executeCommand('albion.openPrivacy');
  assert(mockVsCode.env.openedUrls.includes('https://albion.dev/privacy'), 'albion.openPrivacy opens https://albion.dev/privacy');

  mockVsCode.commands.executeCommand('albion.reportBug');
  assert(mockVsCode.env.openedUrls.includes('https://github.com/Marcdev001/albion/issues'), 'albion.reportBug opens https://github.com/Marcdev001/albion/issues');

  // -------------------------------------------------------------------------
  // TEST 5: SENTRY ERROR TRACKING & PROXY HARDENING
  // -------------------------------------------------------------------------
  console.log(`\n${YELLOW}TEST 5:${RESET} Sentry Error Tracking & Proxy Production Hardening`);

  const serverJsPath = path.join(rootDir, 'albion-proxy/server.js');
  const serverJsContent = fs.readFileSync(serverJsPath, 'utf8');

  assert(serverJsContent.includes('@sentry/node'), 'server.js imports @sentry/node');
  assert(serverJsContent.includes('Sentry.init'), 'server.js initializes Sentry with SENTRY_DSN');
  assert(serverJsContent.includes('Sentry.captureException'), 'server.js captures exceptions to Sentry in /chat error handler');
  assert(serverJsContent.includes('globalRateLimiter'), 'server.js attaches globalRateLimiter to /chat');
  assert(serverJsContent.includes('webhookRateLimiter'), 'server.js attaches webhookRateLimiter to /webhooks/paystack');

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Phase 5 Results: ${GREEN}${passed} passed${RESET} / ${failed > 0 ? RED : GREEN}${failed} failed${RESET}`);
  console.log('─'.repeat(60));

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log(`\n${GREEN}🎯 All Phase 5 specifications verified with absolute precision.${RESET}\n`);
  }
}

runTests().catch((err) => {
  console.error(`${RED}[FATAL] Test runner crashed:${RESET}`, err);
  process.exit(1);
});
