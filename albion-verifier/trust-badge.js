'use strict';

const TRUST_STATES = Object.freeze({
  VERIFIED: 'verified',
  SCAN_CLEAN: 'scan-clean',
  UNVERIFIED: 'unverified',
  FAILED: 'failed'
});

function normalizeFinding(finding) {
  if (!finding || typeof finding !== 'object') {
    return null;
  }

  const severity = String(finding.severity || 'info').toLowerCase();
  return {
    ...finding,
    severity,
    message: String(finding.message || 'Trust check warning').trim(),
  };
}

function summarizeTrustFindings(findings = []) {
  const normalized = Array.isArray(findings)
    ? findings.map(normalizeFinding).filter(Boolean)
    : [];

  const bySeverity = {
    critical: normalized.filter(item => item.severity === 'critical').length,
    high: normalized.filter(item => item.severity === 'high').length,
    medium: normalized.filter(item => item.severity === 'medium').length,
    low: normalized.filter(item => item.severity === 'low').length,
    info: normalized.filter(item => item.severity === 'info').length,
  };

  const summaryParts = [];
  if (normalized.length === 0) {
    summaryParts.push('No trust findings');
  } else {
    summaryParts.push(`${normalized.length} finding${normalized.length === 1 ? '' : 's'} detected`);
    if (bySeverity.critical > 0) summaryParts.push(`${bySeverity.critical} critical`);
    if (bySeverity.high > 0) summaryParts.push(`${bySeverity.high} high`);
  }

  return {
    total: normalized.length,
    bySeverity,
    criticalCount: bySeverity.critical,
    highCount: bySeverity.high,
    mediumCount: bySeverity.medium,
    lowCount: bySeverity.low,
    infoCount: bySeverity.info,
    summary: summaryParts.join(', '),
    hasBlockingIssue: normalized.some(item => item.severity === 'critical' || item.severity === 'high'),
  };
}

function classifyTrustEvidence({
  testsRun = 0,
  testsPassed = 0,
  testsFailed = 0,
  scanCompleted = false,
  scanFindings = []
} = {}) {
  const findings = Array.isArray(scanFindings) ? scanFindings : [];
  const trustSummary = summarizeTrustFindings(findings);
  const testCount = Number.isInteger(testsRun) && testsRun > 0 ? testsRun : 0;
  const passCount = Number.isInteger(testsPassed) && testsPassed >= 0 ? testsPassed : 0;
  const failCount = Number.isInteger(testsFailed) && testsFailed >= 0 ? testsFailed : 0;

  if (failCount > 0 || trustSummary.hasBlockingIssue) {
    return {
      state: TRUST_STATES.FAILED,
      testsRun: testCount,
      testsPassed: passCount,
      testsFailed: failCount,
      findings,
      summary: trustSummary.summary || 'Trust scan failed',
    };
  }

  if (testCount > 0 && passCount === testCount && failCount === 0) {
    return {
      state: TRUST_STATES.VERIFIED,
      testsRun: testCount,
      testsPassed: passCount,
      testsFailed: failCount,
      findings,
      summary: `All ${testCount} verification checks passed.`,
    };
  }

  if (testCount === 0 && scanCompleted && findings.length === 0) {
    return {
      state: TRUST_STATES.SCAN_CLEAN,
      testsRun: 0,
      testsPassed: 0,
      testsFailed: 0,
      findings,
      summary: 'Scan completed with zero findings.',
    };
  }

  return {
    state: TRUST_STATES.UNVERIFIED,
    testsRun: testCount,
    testsPassed: passCount,
    testsFailed: failCount,
    findings,
    summary: trustSummary.summary || 'Trust status is still unverified.',
  };
}

function getTrustBadgePresentation(evidence) {
  const result = evidence?.state ? evidence : classifyTrustEvidence(evidence);
  let summary = result.summary;

  if (!summary) {
    if (result.state === TRUST_STATES.VERIFIED) {
      summary = `All ${result.testsRun || 0} verification checks passed.`;
    } else if (result.state === TRUST_STATES.FAILED) {
      summary = result.testsFailed > 0
        ? `${result.testsFailed} failed verification checks remain.`
        : 'A blocking trust issue was detected.';
    } else if (result.state === TRUST_STATES.SCAN_CLEAN) {
      summary = 'Scan completed with zero findings.';
    } else {
      summary = summarizeTrustFindings(result.findings || []).summary || 'Trust status is still pending';
    }
  }

  switch (result.state) {
    case TRUST_STATES.VERIFIED:
      return {
        text: `$(shield) Albion: Verified (${result.testsRun} tests)`,
        color: 'statusBarItem.prominentBackground',
        state: result.state,
        summary,
      };
    case TRUST_STATES.SCAN_CLEAN:
      return {
        text: '$(shield) Albion: Scan-clean (no tests)',
        color: 'charts.blue',
        state: result.state,
        summary,
      };
    case TRUST_STATES.FAILED:
      return {
        text: result.testsFailed > 0 ? `$(shield) Albion: Failed (${result.testsFailed}/${result.testsRun})` : '$(shield) Albion: Blocked',
        color: 'statusBarItem.errorBackground',
        state: result.state,
        summary,
      };
    default:
      return {
        text: '$(shield) Albion: Unverified',
        color: 'statusBarItem.warningBackground',
        state: TRUST_STATES.UNVERIFIED,
        summary,
      };
  }
}

module.exports = { TRUST_STATES, classifyTrustEvidence, getTrustBadgePresentation, summarizeTrustFindings };