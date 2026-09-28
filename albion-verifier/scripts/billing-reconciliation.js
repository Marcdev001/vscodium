'use strict';

const fs = require('fs');
const path = require('path');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node albion-verifier/scripts/billing-reconciliation.js [--month=YYYY-MM]');
  process.exit(0);
}

const { createClient } = require('@supabase/supabase-js');

const repoRoot = path.resolve(__dirname, '../..');
for (const envFile of ['.env.test', '.env']) {
  const envPath = path.join(repoRoot, envFile);
  if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath, quiet: true });
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.test / .env.');
  process.exit(1);
}

function getMonthRange(argument) {
  const monthArgument = argument?.startsWith('--month=') ? argument.slice(8) : null;
  const match = monthArgument?.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (monthArgument && !match) throw new Error('Month must use --month=YYYY-MM.');
  const now = new Date();
  const year = match ? Number(match[1]) : now.getUTCFullYear();
  const month = match ? Number(match[2]) - 1 : now.getUTCMonth();
  return {
    label: `${year}-${String(month + 1).padStart(2, '0')}`,
    start: new Date(Date.UTC(year, month, 1)).toISOString(),
    end: new Date(Date.UTC(year, month + 1, 1)).toISOString()
  };
}

async function fetchAll(query) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

function money(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

async function main() {
  const range = getMonthRange(process.argv[2]);
  const supabase = createClient(supabaseUrl, supabaseKey);
  const [usageRows, subscriptions, tiers] = await Promise.all([
    fetchAll(supabase.from('usage_logs')
      .select('user_id,model,prompt_tokens,completion_tokens,actual_cost,timestamp')
      .gte('timestamp', range.start)
      .lt('timestamp', range.end)
      .order('timestamp', { ascending: true })),
    fetchAll(supabase.from('subscriptions').select('user_id,tier,status')),
    fetchAll(supabase.from('subscription_tiers').select('name,price_usd,model_caps'))
  ]);

  const tierByName = new Map(tiers.map(tier => [tier.name, tier]));
  const subscriptionByUser = new Map(subscriptions
    .filter(subscription => subscription.status === 'active')
    .map(subscription => [subscription.user_id, subscription]));
  const userStats = new Map();
  for (const userId of subscriptionByUser.keys()) {
    userStats.set(userId, { cost: 0, modelTokens: new Map() });
  }
  let missingCostRows = 0;
  let totalCost = 0;
  let deepInfraCost = 0;
  const deepInfraModels = new Set([
    'deepseek-v4-flash', 'qwen3.6-35b-a3b', 'deepseek-v4-pro', 'glm-5.2'
  ]);

  for (const row of usageRows) {
    const cost = row.actual_cost == null ? null : Number(row.actual_cost);
    const user = userStats.get(row.user_id) || { cost: 0, modelTokens: new Map() };
    const tokenCount = Number(row.prompt_tokens || 0) + Number(row.completion_tokens || 0);
    user.modelTokens.set(row.model, (user.modelTokens.get(row.model) || 0) + tokenCount);
    if (cost == null || !Number.isFinite(cost)) {
      missingCostRows++;
    } else {
      user.cost += cost;
      totalCost += cost;
      if (deepInfraModels.has(row.model)) deepInfraCost += cost;
    }
    userStats.set(row.user_id, user);
  }

  let violations = 0;
  console.log(`\nAlbion billing reconciliation: ${range.label} (UTC)`);
  console.log('User ID | Tier | Revenue (USD) | COGS (USD) | Profit (USD) | Margin | Cap check');
  console.log('-'.repeat(112));

  for (const [userId, stats] of userStats) {
    const subscription = subscriptionByUser.get(userId);
    const tier = subscription?.tier || 'free';
    const plan = tierByName.get(tier);
    const revenue = Number(plan?.price_usd || 0);
    const caps = plan?.model_caps || {};
    const capProblems = [];

    if (!plan) capProblems.push(`unknown tier ${tier}`);
    for (const [model, used] of stats.modelTokens) {
      const cap = caps[model];
      if (cap == null) {
        capProblems.push(`${model}: no cap configured (${used} tokens)`);
      } else if (Number(cap) !== -1 && used > Number(cap)) {
        capProblems.push(`${model}: ${used}/${cap}`);
      }
    }

    const profit = revenue - stats.cost;
    const margin = revenue > 0 ? `${((profit / revenue) * 100).toFixed(1)}%` : 'n/a';
    const capStatus = capProblems.length ? `FAIL: ${capProblems.join('; ')}` : 'PASS';
    if (capProblems.length) violations++;
    console.log(`${userId} | ${tier} | ${money(revenue)} | ${money(stats.cost)} | ${money(profit)} | ${margin} | ${capStatus}`);
  }

  console.log('-'.repeat(112));
  console.log(`Monthly usage-log COGS: ${money(totalCost)}`);
  console.log(`DeepInfra model COGS estimate: ${money(deepInfraCost)} (cross-check matching DeepInfra dashboard period)`);
  console.log(`Rows with missing/invalid actual_cost: ${missingCostRows}`);
  console.log(`Cap violations or unknown plans: ${violations}`);
  console.log('Revenue uses subscription_tiers.price_usd; excludes payment fees, refunds, taxes, and infrastructure overhead.');

  if (violations || missingCostRows) process.exitCode = 1;
}

main().catch(error => {
  console.error(`Billing reconciliation failed: ${error.message}`);
  process.exitCode = 1;
});