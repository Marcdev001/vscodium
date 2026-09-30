'use strict';

const COST_RADAR_STATES = Object.freeze({
  HEALTHY: 'healthy',
  WARNING: 'warning',
  CRITICAL: 'critical',
  UNKNOWN: 'unknown',
});

function normalizeNumber(value, fallback = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function calculateCostRadar({
  budget = 0,
  spent = 0,
  remaining,
  utilization,
  cap,
  status,
} = {}) {
  const budgetValue = normalizeNumber(cap ?? budget, 0);
  const spentValue = normalizeNumber(spent, 0);
  const remainingValue = Number.isFinite(remaining)
    ? Number(remaining)
    : Math.max(budgetValue - spentValue, 0);
  const utilizationPercent = Number.isFinite(utilization)
    ? Math.max(0, Number(utilization) * 100)
    : budgetValue > 0
      ? (spentValue / budgetValue) * 100
      : 0;

  const normalizedStatus = status || (() => {
    if (budgetValue > 0 && spentValue >= budgetValue) return COST_RADAR_STATES.CRITICAL;
    if (utilizationPercent >= 90) return COST_RADAR_STATES.CRITICAL;
    if (utilizationPercent >= 80 || remainingValue <= budgetValue * 0.2) return COST_RADAR_STATES.WARNING;
    return COST_RADAR_STATES.HEALTHY;
  })();

  const summary = budgetValue > 0
    ? `${spentValue.toFixed(2)} / ${budgetValue.toFixed(2)} (${utilizationPercent.toFixed(0)}% used)`
    : `${spentValue.toFixed(2)} spent with no budget ceiling`;

  return {
    status: normalizedStatus,
    budget: budgetValue,
    spent: spentValue,
    remaining: remainingValue,
    utilizationPercent: Number(utilizationPercent.toFixed(1)),
    summary,
  };
}

function getCostRadarPresentation(data = {}) {
  const radar = data && (data.status || data.summary || data.budget !== undefined || data.spent !== undefined || Object.hasOwn(data, 'utilizationPercent'))
    ? calculateCostRadar(data)
    : { status: COST_RADAR_STATES.UNKNOWN, summary: 'Cost radar unavailable', budget: 0, spent: 0, remaining: 0, utilizationPercent: 0 };

  if (radar.status === COST_RADAR_STATES.CRITICAL) {
    return {
      text: '$(warning) Albion Cost Radar: critical',
      color: 'statusBarItem.errorBackground',
      state: radar.status,
      summary: radar.summary,
    };
  }

  if (radar.status === COST_RADAR_STATES.WARNING) {
    return {
      text: '$(pulse) Albion Cost Radar: warning',
      color: 'statusBarItem.warningBackground',
      state: radar.status,
      summary: radar.summary,
    };
  }

  if (radar.status === COST_RADAR_STATES.HEALTHY) {
    return {
      text: '$(check) Albion Cost Radar: healthy',
      color: 'statusBarItem.prominentBackground',
      state: radar.status,
      summary: radar.summary,
    };
  }

  return {
    text: '$(question) Albion Cost Radar: unknown',
    color: 'statusBarItem.warningBackground',
    state: COST_RADAR_STATES.UNKNOWN,
    summary: radar.summary,
  };
}

module.exports = {
  COST_RADAR_STATES,
  calculateCostRadar,
  getCostRadarPresentation,
};
