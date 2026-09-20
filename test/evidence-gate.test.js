import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptEvidenceHit,
  aggregateEvidenceGate,
  applyEvidenceGateToToolResult,
  extractRetrievalHits,
  filterEvidenceRefs,
  formatSufficiencyHint,
  hitConfidence,
  isEvidenceGateTool,
  parseEvidenceHitScores,
  publicEvidenceGateSummary,
  resolveEvidenceGateMode,
} from '../packages/runtime/src/evidence-gate.js';

test('web search hits keep title snippet and host without inventing evidence', () => {
  const hits = extractRetrievalHits('web.search', {
    results: [
      { title: 'Accelink Launches 3.2T NPO', url: 'https://www.accelink.com/npo', snippet: 'official launch' },
      { title: 'Monkeytype', url: 'https://monkeytype.com', snippet: 'A minimalistic typing test' },
    ],
  });
  assert.equal(hits[0].host, 'www.accelink.com');
  assert.equal(hits[1].host, 'monkeytype.com');
  assert.equal(isEvidenceGateTool('web.search'), true);
  assert.equal(isEvidenceGateTool('holdings.get'), false);
});

test('knowledge and feed list tools also project retrieval hits', () => {
  const knowledge = extractRetrievalHits('knowledge.search', [
    { knowledgeId: 'k1', title: 'NPO 框架', snippet: '硅光共封装' },
  ]);
  assert.equal(knowledge[0].knowledgeId, 'k1');
  const feed = extractRetrievalHits('feed.tag.search', {
    items: [{ id: 'c1', title: '展会笔记', summary: '光迅展台' }],
  });
  assert.equal(feed[0].id, 'c1');
});

test('Investing.com-like pages can be relevant but still fail the evidence threshold', () => {
  assert.equal(acceptEvidenceHit({ relevance: 0.97, evidence: 0.95, quality: 0.97 }), true);
  assert.equal(acceptEvidenceHit({ relevance: 0.91, evidence: 0.88, quality: 0.60 }), true);
  assert.equal(acceptEvidenceHit({ relevance: 0.42, evidence: 0.08, quality: 0.65 }), false);
  assert.equal(acceptEvidenceHit({ relevance: 0.01, evidence: 0.00, quality: 0.10 }), false);
  assert.equal(hitConfidence({ relevance: 0.97, evidence: 0.95, quality: 0.97 }) > 0.9, true);
});

test('enforce mode drops rejected hits and their source refs', () => {
  const hits = extractRetrievalHits('web.search', {
    results: [
      { title: 'CIOE', url: 'https://www.cioe.cn/npo', snippet: '3.2T NPO' },
      { title: 'Monkeytype', url: 'https://monkeytype.com', snippet: 'typing test' },
    ],
  });
  const scored = parseEvidenceHitScores({
    hit_1_relevance: { noul: 0.98 },
    hit_1_evidence: { noul: 0.91 },
    hit_1_quality: { noul: 0.96 },
    hit_2_relevance: { noul: 0.01 },
    hit_2_evidence: { noul: 0.00 },
    hit_2_quality: { noul: 0.10 },
  }, hits);
  const accepted = scored.filter((hit) => hit.accepted);
  const rejected = scored.filter((hit) => !hit.accepted);
  const observed = applyEvidenceGateToToolResult({
    toolId: 'web.search',
    toolResult: {
      data: {
        query: 'CIOE NPO',
        available: true,
        results: [
          { title: 'CIOE', url: 'https://www.cioe.cn/npo', snippet: '3.2T NPO' },
          { title: 'Monkeytype', url: 'https://monkeytype.com', snippet: 'typing test' },
        ],
      },
      refs: [
        { resourceType: 'web-result', resourceId: 'https://www.cioe.cn/npo', label: 'CIOE' },
        { resourceType: 'web-result', resourceId: 'https://monkeytype.com', label: 'Monkeytype' },
      ],
    },
    decision: { status: 'ok', mode: 'enforce', hits: scored, accepted, rejected, sufficiency: 0.88, confidence: 0.9 },
    mode: 'enforce',
  });
  assert.equal(observed.data.results.length, 1);
  assert.equal(observed.data.results[0].url, 'https://www.cioe.cn/npo');
  assert.equal(observed.data.results[0].evidence.accepted, true);
  assert.deepEqual(observed.refs.map((item) => item.resourceId), ['https://www.cioe.cn/npo']);
  assert.equal(observed.evidenceGate.rejectedCount, 1);
  assert.deepEqual(filterEvidenceRefs(observed.refs, accepted).map((item) => item.resourceId), ['https://www.cioe.cn/npo']);
});

test('sufficiency hint and run-level confidence stay advisory', () => {
  assert.match(formatSufficiencyHint(0.91), /unnecessary/);
  assert.match(formatSufficiencyHint(0.34), /unconfirmed/);
  const summary = publicEvidenceGateSummary({
    mode: 'enforce',
    accepted: [{ confidence: 0.9, host: 'cioe.cn' }],
    rejected: [{ host: 'monkeytype.com' }],
    sufficiency: 0.91,
    confidence: 0.88,
  });
  assert.equal(summary.acceptedCount, 1);
  assert.equal(summary.rejectedHosts[0], 'monkeytype.com');
  const aggregated = aggregateEvidenceGate([
    { status: 'ok', accepted: [{ confidence: 0.9, relevance: 0.95, evidence: 0.9, quality: 0.9 }], rejected: [{ host: 'x' }], sufficiency: 0.8 },
  ]);
  assert.equal(aggregated.acceptedCount, 1);
  assert.equal(aggregated.rejectedCount, 1);
  assert.equal(Number.isFinite(aggregated.confidence), true);
  assert.equal(resolveEvidenceGateMode({}), 'enforce');
  assert.equal(resolveEvidenceGateMode({ AI_CENTER_JEV_EVIDENCE_GATE: 'off' }), 'off');
});
