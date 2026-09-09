/**
 * albion-status-bar.js
 * Albion Fuel Gauge & Real-Time Model Visibility (Phase 4 Final)
 *
 * Manages the native VS Code Status Bar item for real-time token consumption
 * and live model routing visibility. Intercepts custom proxy response headers.
 *
 * Rules:
 *   - Format: most-constrained paid model + Flash:
 *     $(dashboard) Albion: [Tier] | GLM: 45k/150k (30%) | Flash: 1.2M/8M
 *   - $(zap) icon next to model name while Premium Toggle is active.
 *   - When muse-glimmer is active: $(cloud-offline) Muse Glimmer (Free) with neutral background.
 *   - Warning yellow at >= 85% on any cap; error red when all caps exhausted.
 *   - Commands: albion.showBillingDetails, albion.openAccountPage.
 *   - The editor shows NO marketing, NO pricing tables, NO download buttons. Live usage data ONLY.
 */

'use strict';

let statusBarItem = null;

let currentBillingState = {
  tier: 'Learner',
  activeModel: 'deepseek-v4-flash',
  usedTokens: 0,
  capTokens: 2000000,
  usagePercent: 0,
  warning: null,
  isPremiumToggle: false,
  capsSummary: {},
  lastUpdated: null
};

// ---------------------------------------------------------------------------
// ROUTING MODES (Premium Toggle UX)
// Cycle: AUTO (Flash/Qwen) -> FORCE PRO -> FORCE GLM -> AUTO
// ---------------------------------------------------------------------------
const ROUTING_MODES = [
  { mode: 'AUTO', label: 'AUTO (Flash/Qwen)', forceModel: null },
  { mode: 'FORCE PRO', label: 'FORCE PRO', forceModel: 'deepseek-v4-pro' },
  { mode: 'FORCE GLM', label: 'FORCE GLM', forceModel: 'glm-5.2' }
];

let currentRoutingIndex = 0;

function getCurrentRoutingMode() {
  return ROUTING_MODES[currentRoutingIndex];
}

function getForcedModel() {
  return ROUTING_MODES[currentRoutingIndex].forceModel;
}

function getRoutingHeaders() {
  const model = getForcedModel();
  if (model) {
    return { 'X-Albion-Force-Model': model };
  }
  return {};
}

function cycleRoutingMode(vscode) {
  currentRoutingIndex = (currentRoutingIndex + 1) % ROUTING_MODES.length;
  const newMode = ROUTING_MODES[currentRoutingIndex];

  currentBillingState.isPremiumToggle = newMode.forceModel !== null;
  if (newMode.forceModel) {
    currentBillingState.activeModel = newMode.forceModel;
  } else {
    currentBillingState.activeModel = 'deepseek-v4-flash';
  }

  if (vscode) {
    renderStatusBar(vscode);
    if (vscode.window && typeof vscode.window.setStatusBarMessage === 'function') {
      vscode.window.setStatusBarMessage(
        `$(zap) Albion Routing: ${newMode.label}`,
        3000
      );
    }
  }

  return newMode;
}

function setRoutingMode(modeName, vscode) {
  const idx = ROUTING_MODES.findIndex(m => m.mode === modeName || m.label === modeName);
  if (idx !== -1) {
    currentRoutingIndex = idx;
    const newMode = ROUTING_MODES[currentRoutingIndex];
    currentBillingState.isPremiumToggle = newMode.forceModel !== null;
    if (newMode.forceModel) {
      currentBillingState.activeModel = newMode.forceModel;
    }
    if (vscode) {
      renderStatusBar(vscode);
    }
    return newMode;
  }
  return ROUTING_MODES[currentRoutingIndex];
}

/**
 * Formats large token numbers into compact human-readable strings (e.g. 45k, 1.2M, 8M).
 * @param {number} num
 * @returns {string}
 */
function formatTokens(num) {
  if (num === null || num === undefined || isNaN(num) || num === -1) return '0';
  const n = Number(num);
  if (n >= 1000000) {
    const formatted = (n / 1000000).toFixed(1);
    return formatted.endsWith('.0') ? `${(n / 1000000).toFixed(0)}M` : `${formatted}M`;
  }
  if (n >= 1000) {
    const formatted = (n / 1000).toFixed(0);
    return `${formatted}k`;
  }
  return n.toString();
}

/**
 * Maps model identifiers to short, readable abbreviations for the status bar.
 */
function getModelShortLabel(model) {
  if (!model) return 'Flash';
  const m = model.toLowerCase();
  if (m.includes('muse-glimmer')) return 'Muse Glimmer';
  if (m.includes('glm')) return 'GLM';
  if (m.includes('pro')) return 'Pro';
  if (m.includes('qwen')) return 'Qwen';
  if (m.includes('flash')) return 'Flash';
  return model;
}

function formatTierName(tier) {
  if (!tier) return 'Free';
  return tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
}

/**
 * Initializes the Status Bar item in VS Code.
 * @param {object} context - VSCode ExtensionContext
 * @param {object} vscode - The vscode module
 * @returns {object} The status bar item
 */
function initStatusBar(context, vscode) {
  if (statusBarItem) return statusBarItem;

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );

  statusBarItem.command = 'albion.showBillingDetails';
  renderStatusBar(vscode);
  statusBarItem.show();

  // Register command for breakdown dialog
  const detailsCmd = vscode.commands.registerCommand('albion.showBillingDetails', () => {
    showBillingDetailsModal(vscode);
  });

  // Register command to link out to website account page
  const accountCmd = vscode.commands.registerCommand('albion.openAccountPage', () => {
    vscode.env.openExternal(vscode.Uri.parse('https://albion.dev/account'));
  });

  // Register command for cycling routing mode (AUTO -> FORCE PRO -> FORCE GLM -> AUTO)
  const cycleCmd = vscode.commands.registerCommand('albion.cycleRoutingMode', () => {
    cycleRoutingMode(vscode);
  });

  // Register command to link out to website terms
  const termsCmd = vscode.commands.registerCommand('albion.openTerms', () => {
    vscode.env.openExternal(vscode.Uri.parse('https://albion.dev/terms'));
  });

  // Register command to link out to privacy policy
  const privacyCmd = vscode.commands.registerCommand('albion.openPrivacy', () => {
    vscode.env.openExternal(vscode.Uri.parse('https://albion.dev/privacy'));
  });

  // Register command to report a bug
  const reportBugCmd = vscode.commands.registerCommand('albion.reportBug', () => {
    vscode.env.openExternal(vscode.Uri.parse('https://github.com/Marcdev001/albion/issues'));
  });

  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(detailsCmd);
  context.subscriptions.push(accountCmd);
  context.subscriptions.push(cycleCmd);
  context.subscriptions.push(termsCmd);
  context.subscriptions.push(privacyCmd);
  context.subscriptions.push(reportBugCmd);

  return statusBarItem;
}

/**
 * Renders status bar text, colors, and tooltip based on current state.
 */
function renderStatusBar(vscode) {
  if (!statusBarItem) return;

  const {
    tier,
    activeModel,
    warning,
    isPremiumToggle,
    capsSummary
  } = currentBillingState;

  const tierStr = formatTierName(tier);

  // Case 1: Muse Glimmer is active (Free tier or exhausted cloud caps)
  if (activeModel.toLowerCase().includes('muse-glimmer') || tier === 'free') {
    statusBarItem.text = `$(cloud-offline) Muse Glimmer (Free)`;
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = [
      `Albion Local Mode: Muse Glimmer ($0 local model)`,
      `• Local free model — top up at your account page to unlock cloud models.`,
      `• Status: Active`,
      `Click for account details.`
    ].join('\n');
    return;
  }

  // Case 2: Cloud models active — Build most-constrained paid model + Flash format
  // Format: $(dashboard) Albion: [Tier] | GLM: 45k/150k (30%) | Flash: 1.2M/8M
  let mostConstrained = null;
  let flashSummary = capsSummary['deepseek-v4-flash'] || null;

  for (const [modelName, info] of Object.entries(capsSummary)) {
    if (modelName === 'deepseek-v4-flash' || modelName === 'muse-glimmer') continue;
    if (!mostConstrained || info.percent > mostConstrained.percent) {
      mostConstrained = { model: modelName, ...info };
    }
  }

  const parts = [`$(dashboard) Albion: ${tierStr}`];

  if (mostConstrained) {
    const label = getModelShortLabel(mostConstrained.model);
    const used = formatTokens(mostConstrained.used);
    const cap = formatTokens(mostConstrained.cap);
    parts.push(`${label}: ${used}/${cap} (${Math.round(mostConstrained.percent)}%)`);
  }

  if (flashSummary) {
    const used = formatTokens(flashSummary.used);
    const cap = formatTokens(flashSummary.cap);
    if (!mostConstrained) {
      parts.push(`Flash: ${used}/${cap} (${Math.round(flashSummary.percent)}%)`);
    } else {
      parts.push(`Flash: ${used}/${cap}`);
    }
  }

  // Append model name with $(zap) icon if Premium Toggle is active
  if (isPremiumToggle) {
    parts.push(`$(zap) ${getModelShortLabel(activeModel)}`);
  }

  statusBarItem.text = parts.join(' | ');

  // Visual cues:
  // Red/Error when all caps exhausted
  if (warning === 'all_caps_exhausted' || warning === 'hard_ceiling_reached') {
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBarItem.tooltip = [
      `⚠️ ALBION USAGE: CAPS EXHAUSTED`,
      `• Cloud caps reached for tier ${tierStr}.`,
      `• Falling back to local Muse Glimmer.`,
      `Click to manage your account.`
    ].join('\n');
  } else if (warning === 'approaching_limit') {
    // Yellow/Warning at >= 85% on any cap
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBarItem.tooltip = [
      `⚡ ALBION USAGE: 85%+ UTILIZATION REACHED`,
      `• Tier: ${tierStr}`,
      `• Active: ${getModelShortLabel(activeModel)}`,
      `• Top-up is now unlocked at your account dashboard.`,
      `Click for full usage breakdown.`
    ].join('\n');
  } else {
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = [
      `Albion AI Fuel Gauge`,
      `• Tier: ${tierStr}`,
      `• Active Model: ${getModelShortLabel(activeModel)}${isPremiumToggle ? ' (Premium Toggle)' : ''}`,
      `Click for live usage breakdown.`
    ].join('\n');
  }
}

/**
 * Intercepts response headers from /chat and updates the Status Bar.
 * @param {object} headers - HTTP response headers object or Map
 * @param {object} vscode - The vscode module
 */
function updateFromHeaders(headers, vscode) {
  if (!headers) return;

  const getHeader = (name) => {
    if (typeof headers.get === 'function') {
      return headers.get(name) || headers.get(name.toLowerCase());
    }
    return headers[name] || headers[name.toLowerCase()];
  };

  const usagePercentHeader = getHeader('X-Albion-Usage-Percent');
  const activeModelHeader = getHeader('X-Albion-Active-Model');
  const tierHeader = getHeader('X-Albion-Tier');
  const warningHeader = getHeader('X-Albion-Usage-Warning');
  const currentTokensHeader = getHeader('X-Albion-Current-Tokens');
  const capTokensHeader = getHeader('X-Albion-Cap-Tokens');
  const capsSummaryHeader = getHeader('X-Albion-Caps-Summary');

  if (usagePercentHeader !== undefined && usagePercentHeader !== null) {
    currentBillingState.usagePercent = parseFloat(usagePercentHeader) || 0;
  }
  if (activeModelHeader) {
    currentBillingState.activeModel = activeModelHeader;
    currentBillingState.isPremiumToggle = ['deepseek-v4-pro', 'glm-5.2'].some(
      m => activeModelHeader.toLowerCase().includes(m)
    );
  }
  if (tierHeader) {
    currentBillingState.tier = tierHeader;
  }
  if (warningHeader !== undefined) {
    currentBillingState.warning = warningHeader || null;
  }
  if (currentTokensHeader) {
    currentBillingState.usedTokens = parseInt(currentTokensHeader, 10) || 0;
  }
  if (capTokensHeader) {
    currentBillingState.capTokens = parseInt(capTokensHeader, 10) || 2000000;
  }
  if (capsSummaryHeader) {
    try {
      currentBillingState.capsSummary = typeof capsSummaryHeader === 'string'
        ? JSON.parse(capsSummaryHeader)
        : capsSummaryHeader;
    } catch (_) {
      currentBillingState.capsSummary = {};
    }
  }

  currentBillingState.lastUpdated = new Date();

  if (vscode) {
    renderStatusBar(vscode);
  }
}

/**
 * Shows live usage breakdown in VS Code without any marketing.
 */
async function showBillingDetailsModal(vscode) {
  const { tier, activeModel, capsSummary, warning } = currentBillingState;
  const tierStr = formatTierName(tier);

  const lines = [`Albion Live Usage (${tierStr} Tier):`];

  if (Object.keys(capsSummary).length > 0) {
    for (const [model, info] of Object.entries(capsSummary)) {
      const capStr = info.cap === -1 ? 'Unlimited' : info.cap.toLocaleString();
      lines.push(`• ${model}: ${info.used.toLocaleString()} / ${capStr} (${info.percent}%)`);
    }
  } else {
    lines.push(`• Current Model: ${activeModel}`);
  }

  if (warning === 'all_caps_exhausted') {
    lines.push('\n⚠️ All cloud caps exhausted. Routing to local Muse Glimmer.');
  } else if (warning === 'approaching_limit') {
    lines.push('\n⚡ At least one cap is ≥85%. Top-up unlocked at account page.');
  }

  const selection = await vscode.window.showInformationMessage(
    lines.join('\n'),
    'Open Account Page',
    'Dismiss'
  );

  if (selection === 'Open Account Page') {
    vscode.commands.executeCommand('albion.openAccountPage');
  }
}

module.exports = {
  initStatusBar,
  updateFromHeaders,
  renderStatusBar,
  formatTokens,
  getModelShortLabel,
  formatTierName,
  ROUTING_MODES,
  cycleRoutingMode,
  getCurrentRoutingMode,
  getForcedModel,
  getRoutingHeaders,
  setRoutingMode,
  getCurrentBillingState: () => ({ ...currentBillingState }),
  _setBillingState: (state) => { currentBillingState = { ...currentBillingState, ...state }; }
};
