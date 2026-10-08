import test from 'node:test';
import assert from 'node:assert/strict';

// Deterministic reading of the market-driver rules against mock observations.
// This file does not call a model and does not prove a live model always follows the skill.

function conflicts(observation, claim) {
  const found = [];
  if (claim.action === 'splice-intraday-curve') {
    const marks = new Set((observation.series || []).map((item) => item.asOf));
    if (marks.size > 1 || (observation.series || []).some((item) => item.stale)) found.push('stale-asof');
  }
  if (claim.action === 'market-breadth' && observation.universe === 'watchlist') found.push('watchlist-is-not-market');
  if (claim.action === 'already-issued' && observation.financingStatus !== 'issued') found.push('seeking-is-not-issued');
  if (claim.action === 'explain-earlier-drop' && observation.evidencePublishedAt > observation.priceMoveAt) {
    found.push('later-publication');
  }
  if (claim.action === 'no-independent-news' && Number(observation.fetchStatus) >= 400) found.push('fetch-failure');
  return found;
}

test('mock observations mark unsupported market-driver conclusions', () => {
  assert.deepEqual(conflicts({
    series: [{ asOf: '2024-10-07', range: '2y', stale: true }, { asOf: '2026-10-07', range: '1d' }],
  }, { action: 'splice-intraday-curve' }), ['stale-asof']);
  assert.deepEqual(conflicts({
    universe: 'watchlist',
    members: ['600519.SH', '300750.SZ'],
  }, { action: 'market-breadth' }), ['watchlist-is-not-market']);
  assert.deepEqual(conflicts({
    financingStatus: 'seeking',
    headline: '公司寻求融资',
  }, { action: 'already-issued' }), ['seeking-is-not-issued']);
  assert.deepEqual(conflicts({
    priceMoveAt: Date.parse('2026-10-07T06:00:00Z'),
    evidencePublishedAt: Date.parse('2026-10-08T02:00:00Z'),
    evidence: 'minutes',
  }, { action: 'explain-earlier-drop' }), ['later-publication']);
  assert.deepEqual(conflicts({
    fetchStatus: 403,
    body: '',
  }, { action: 'no-independent-news' }), ['fetch-failure']);
  assert.deepEqual(conflicts({
    series: [{ asOf: '2026-10-07', range: '1d' }],
    universe: 'exchange-breadth',
    financingStatus: 'issued',
    priceMoveAt: Date.parse('2026-10-07T08:00:00Z'),
    evidencePublishedAt: Date.parse('2026-10-07T01:00:00Z'),
    fetchStatus: 200,
  }, { action: 'no-independent-news' }), []);
});
