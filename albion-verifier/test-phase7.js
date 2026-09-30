'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRUST_STATES,
  classifyTrustEvidence,
  getTrustBadgePresentation,
  summarizeTrustFindings,
} = require('./trust-badge.js');

const {
  calculateCostRadar,
  getCostRadarPresentation,
} = require('./cost-radar.js');

test('classifyTrustEvidence marks severe findings as failed', () => {
  const decision = classifyTrustEvidence({
    testsRun: 12,
    testsPassed: 10,
    testsFailed: 2,
    scanCompleted: true,
    scanFindings: [{ severity: 'high', message: 'A critical dependency is stale' }],
  });

  assert.equal(decision.state, TRUST_STATES.FAILED);
  assert.equal(decision.testsFailed, 2);
  assert.equal(decision.findings.length, 1);
});

test('summarizeTrustFindings creates a readable summary', () => {
  const summary = summarizeTrustFindings([
    { severity: 'high', message: 'Missing access token' },
    { severity: 'low', message: 'Minor warning' },
  ]);

  assert.equal(summary.highCount, 1);
  assert.equal(summary.lowCount, 1);
  assert.match(summary.summary, /2.*findings/i);
  assert.match(summary.summary, /high/i);
});

test('getTrustBadgePresentation returns the expected verified badge text', () => {
  const badge = getTrustBadgePresentation({
    state: TRUST_STATES.VERIFIED,
    testsRun: 27,
    testsPassed: 27,
    testsFailed: 0,
    findings: [],
  });

  assert.equal(badge.state, TRUST_STATES.VERIFIED);
  assert.match(badge.text, /Verified/i);
  assert.match(badge.summary, /27/i);
});

test('calculateCostRadar warns when spend approaches the cap', () => {
  const radar = calculateCostRadar({
    budget: 100,
    spent: 86,
    utilization: 0.86,
  });

  assert.equal(radar.status, 'warning');
  assert.ok(radar.utilizationPercent >= 80);
  assert.match(radar.summary, /86/i);
});

test('getCostRadarPresentation renders a warning badge', () => {
  const badge = getCostRadarPresentation({
    status: 'warning',
    utilizationPercent: 92,
    summary: '92% of budget used',
  });

  assert.equal(badge.state, 'warning');
  assert.match(badge.text, /warning/i);
});
