/**
 * albion-status-bar.js
 * Albion Fuel Gauge & Real-Time Model Visibility (Phase 4)
 *
 * Manages the native VS Code Status Bar item for real-time token consumption
 * and live model routing visibility. Intercepts custom proxy response headers.
 *
 * Constraints:
 *   - Native VS Code API only (no webview hacking).
 *   - Zero trust: Displays only proxy-authorized usage & tier headers.
 *   - Visual cues: Normal (<80%), Warning yellow (>=80%), Error red (>=100%).
 */

'use strict';

let statusBarItem = null;
let currentBillingState = {
  tier: 'Learner',
  usedTokens: 0,
  capTokens: 3000000,
  usagePercent: 0,
  activeModel: 'DeepSeek-V4-Flash',
  warning: null,
  lastUpdated: null
};

/**
 * Formats large token numbers into human-readable strings (e.g. 450k, 1.5M, 12M).
 * @param {number} num
 * @returns {string}
 */
function formatTokens(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
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
 * Capitalizes string for display (e.g. 'starter' -> 'Starter', 'deepseek-v4-flash' -> 'DeepSeek-V4-Flash')
 */
function formatModelName(model) {
  if (!model) return 'DeepSeek-V4-Flash';
  if (model.toLowerCase().includes('deepseek')) return 'DeepSeek-V4-Flash';
  if (model.toLowerCase().includes('claude')) return 'Claude-3.5-Sonnet';
  if (model.toLowerCase().includes('gpt')) return 'GPT-4o';
  return model;
}

function formatTierName(tier) {
  if (!tier) return 'Learner';
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

  // Create on bottom right next to notifications (Alignment.Right, priority 100)
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );

  statusBarItem.command = 'albion.showBillingDetails';
  renderStatusBar(vscode);
  statusBarItem.show();

  // Register command for detailed billing breakdown
  const detailsCmd = vscode.commands.registerCommand('albion.showBillingDetails', () => {
    showBillingDetailsModal(vscode);
  });

  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(detailsCmd);

  return statusBarItem;
}

/**
 * Renders status bar text, colors, and tooltip based on current state.
 */
function renderStatusBar(vscode) {
  if (!statusBarItem) return;

  const { tier, usedTokens, capTokens, usagePercent, activeModel, warning } = currentBillingState;

  const usedStr = formatTokens(usedTokens);
  const capStr = formatTokens(capTokens);
  const modelStr = formatModelName(activeModel);
  const tierStr = formatTierName(tier);

  // Exact text format: $(dashboard) Albion: [Tier] | [Used]/[Cap] ([%]) | [Model]
  statusBarItem.text = `$(dashboard) Albion: ${tierStr} | ${usedStr}/${capStr} (${Math.round(usagePercent)}%) | ${modelStr}`;

  // Visual cues based on thresholds
  if (usagePercent >= 100 || warning === 'hard_ceiling_reached') {
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBarItem.tooltip = [
      `⚠️ ALBION USAGE: HARD CEILING REACHED (100%+)`,
      `• Tier: ${tierStr}`,
      `• Used: ${usedTokens.toLocaleString()} / ${capTokens.toLocaleString()} tokens (${usagePercent}%)`,
      `• Auto-Downgraded To: DeepSeek-V4-Flash (Free tier preserved)`,
      `Click for billing and upgrade options.`
    ].join('\n');
  } else if (usagePercent >= 80 || warning === 'approaching_limit') {
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBarItem.tooltip = [
      `⚡ ALBION USAGE: APPROACHING CEILING (80%+)`,
      `• Tier: ${tierStr}`,
      `• Used: ${usedTokens.toLocaleString()} / ${capTokens.toLocaleString()} tokens (${usagePercent}%)`,
      `• Model: ${modelStr}`,
      `Click to manage your plan.`
    ].join('\n');
  } else {
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = [
      `Albion AI Fuel Gauge`,
      `• Tier: ${tierStr}`,
      `• Used: ${usedTokens.toLocaleString()} / ${capTokens.toLocaleString()} tokens (${usagePercent}%)`,
      `• Active Model: ${modelStr}`,
      `Click for full usage breakdown.`
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

  if (usagePercentHeader !== undefined && usagePercentHeader !== null) {
    currentBillingState.usagePercent = parseFloat(usagePercentHeader) || 0;
  }
  if (activeModelHeader) {
    currentBillingState.activeModel = activeModelHeader;
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
    currentBillingState.capTokens = parseInt(capTokensHeader, 10) || 3000000;
  }

  currentBillingState.lastUpdated = new Date();

  if (vscode) {
    renderStatusBar(vscode);
  }
}

/**
 * Shows detailed breakdown in VS Code notification dialog.
 */
async function showBillingDetailsModal(vscode) {
  const { tier, usedTokens, capTokens, usagePercent, activeModel, warning } = currentBillingState;

  const tierStr = formatTierName(tier);
  const usedFormatted = usedTokens.toLocaleString();
  const capFormatted = capTokens.toLocaleString();

  let warningNotice = '';
  if (warning === 'hard_ceiling_reached') {
    warningNotice = ' ⚠️ Plan cap reached. AI requests are running on DeepSeek-V4-Flash.';
  } else if (warning === 'approaching_limit') {
    warningNotice = ' ⚡ You have used over 80% of your plan tokens.';
  }

  const message = `Albion Fuel Gauge: ${tierStr} Tier\n` +
    `Used: ${usedFormatted} / ${capFormatted} tokens (${usagePercent}%).` +
    ` Active Model: ${formatModelName(activeModel)}.${warningNotice}`;

  const selection = await vscode.window.showInformationMessage(
    message,
    'Manage Subscription',
    'Dismiss'
  );

  if (selection === 'Manage Subscription') {
    vscode.env.openExternal(vscode.Uri.parse('https://albion.dev/dashboard/billing'));
  }
}

module.exports = {
  initStatusBar,
  updateFromHeaders,
  renderStatusBar,
  formatTokens,
  formatModelName,
  formatTierName,
  getCurrentBillingState: () => ({ ...currentBillingState }),
  _setBillingState: (state) => { currentBillingState = { ...currentBillingState, ...state }; }
};
