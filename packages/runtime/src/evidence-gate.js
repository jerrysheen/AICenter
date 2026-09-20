export const EVIDENCE_GATE_TOOLS = Object.freeze([
  'web.search',
  'knowledge.search',
  'feed.search',
  'feed.tag.search',
]);

export const EVIDENCE_GATE_THRESHOLDS = Object.freeze({
  relevance: 0.40,
  evidence: 0.25,
});

export const EVIDENCE_HIT_WEIGHTS = Object.freeze({
  relevance: 0.40,
  evidence: 0.40,
  quality: 0.20,
});

const GATED_TOOL_SET = new Set(EVIDENCE_GATE_TOOLS);

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function clip(value, max = 280) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function envFlag(value) {
  return text(value).toLowerCase();
}

export function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, number));
}

export function roundScore(value) {
  const score = clampScore(value);
  return score == null ? null : Math.round(score * 100) / 100;
}

function averageScores(values = []) {
  const scores = values.map(clampScore).filter((value) => value != null);
  if (!scores.length) return null;
  return roundScore(scores.reduce((sum, value) => sum + value, 0) / scores.length);
}

export function isEvidenceGateTool(toolId) {
  return GATED_TOOL_SET.has(String(toolId || ''));
}

export function resolveEvidenceGateMode(env = process.env, { disabled = false } = {}) {
  if (disabled) return 'off';
  const raw = envFlag(env.AI_CENTER_JEV_EVIDENCE_GATE);
  if (raw === 'off' || raw === '0') return 'off';
  if (raw === 'shadow') return 'shadow';
  return 'enforce';
}

function hostnameOf(url) {
  try {
    return new URL(String(url || '')).hostname || '';
  } catch {
    return '';
  }
}

function hitKey(prefix, index, dimension) {
  return `${prefix}_${index + 1}_${dimension}`;
}

export function extractRetrievalHits(toolId, data) {
  const id = String(toolId || '');
  const rows = id === 'web.search'
    ? (isRecord(data) && Array.isArray(data.results) ? data.results : [])
    : Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.results)
          ? data.results
          : [];
  return rows.map((item, index) => {
    const title = text(item?.title);
    const url = text(item?.url || item?.sourceUrl);
    const snippet = clip(item?.snippet || item?.summary || item?.body, 280);
    return {
      index,
      id: text(item?.id || item?.knowledgeId || url || `${index}`),
      knowledgeId: text(item?.knowledgeId),
      title,
      url,
      host: hostnameOf(url),
      snippet,
      publishedAt: item?.publishedAt ?? null,
    };
  });
}

export function hitConfidence(scores = {}) {
  const relevance = clampScore(scores.relevance);
  const evidence = clampScore(scores.evidence);
  const quality = clampScore(scores.quality);
  if (relevance == null && evidence == null && quality == null) return null;
  let weighted = 0;
  let total = 0;
  for (const [key, weight] of Object.entries(EVIDENCE_HIT_WEIGHTS)) {
    const value = clampScore(scores[key]);
    if (value == null) continue;
    weighted += value * weight;
    total += weight;
  }
  if (total <= 0) return null;
  return roundScore(weighted / total);
}

export function acceptEvidenceHit(scores = {}, thresholds = EVIDENCE_GATE_THRESHOLDS) {
  const relevance = clampScore(scores.relevance);
  const evidence = clampScore(scores.evidence);
  if (relevance == null || evidence == null) return false;
  return relevance >= thresholds.relevance && evidence >= thresholds.evidence;
}

export function buildEvidenceGateState({
  message = '',
  query = '',
  toolId = 'web.search',
  hits = [],
} = {}) {
  return {
    inquiry: clip(message, 800),
    search_query: clip(query, 400),
    tool: String(toolId || ''),
    results: (Array.isArray(hits) ? hits : []).map((hit) => ({
      id: hit.index + 1,
      title: clip(hit.title, 180),
      url: clip(hit.url, 240),
      host: clip(hit.host, 80),
      snippet: clip(hit.snippet, 280),
    })),
  };
}

export function buildEvidenceGateQuestions(hits = []) {
  const questions = {};
  for (const hit of hits) {
    const label = `result ${hit.index + 1} (${clip(hit.title || hit.host || hit.url, 80)})`;
    questions[hitKey('hit', hit.index, 'relevance')] = {
      type: 'noul',
      instructions: `Is ${label} about the current inquiry or search query? Judge topical relatedness only, not whether the source is prestigious.`,
      criteria: {
        true: 'The title or snippet is about the inquiry or the search query.',
        false: 'It is off-topic, a keyword collision, or unrelated residue.',
      },
    };
    questions[hitKey('hit', hit.index, 'evidence')] = {
      type: 'noul',
      instructions: `Does ${label} actually provide information that could support or refute the current inquiry? A related page that does not speak to the fact still scores no.`,
      criteria: {
        true: 'The snippet contains a fact, statement, date, product, or claim that bears on the inquiry.',
        false: 'It is only loosely related, navigational, or silent on the point being checked.',
      },
    };
    questions[hitKey('hit', hit.index, 'quality')] = {
      type: 'noul',
      instructions: `As a source, is ${label} worth relying on for this inquiry? Official pages and primary documents score higher than unverified second-hand notes.`,
      criteria: {
        true: 'The source looks independently checkable or reasonably authoritative for this kind of fact.',
        false: 'The source is residue, anonymous chatter, or not dependable for this inquiry.',
      },
    };
  }
  return questions;
}

export function parseEvidenceHitScores(answers = {}, hits = []) {
  return (Array.isArray(hits) ? hits : []).map((hit) => {
    const scores = {
      relevance: clampScore(answers[hitKey('hit', hit.index, 'relevance')]?.noul),
      evidence: clampScore(answers[hitKey('hit', hit.index, 'evidence')]?.noul),
      quality: clampScore(answers[hitKey('hit', hit.index, 'quality')]?.noul),
    };
    const confidence = hitConfidence(scores);
    const accepted = acceptEvidenceHit(scores);
    return {
      ...hit,
      ...scores,
      confidence,
      accepted,
      reason: accepted
        ? 'accepted'
        : scores.relevance == null || scores.evidence == null
          ? 'unscored'
          : scores.relevance < EVIDENCE_GATE_THRESHOLDS.relevance
            ? 'low-relevance'
            : 'low-evidence',
    };
  });
}

export function buildSufficiencyState({
  message = '',
  query = '',
  toolId = 'web.search',
  accepted = [],
} = {}) {
  return {
    inquiry: clip(message, 800),
    search_query: clip(query, 400),
    tool: String(toolId || ''),
    accepted_evidence: (Array.isArray(accepted) ? accepted : []).map((hit, index) => ({
      id: index + 1,
      title: clip(hit.title, 180),
      url: clip(hit.url, 240),
      host: clip(hit.host, 80),
      snippet: clip(hit.snippet, 280),
      relevance: hit.relevance ?? null,
      evidence: hit.evidence ?? null,
      quality: hit.quality ?? null,
    })),
  };
}

export function buildSufficiencyQuestions() {
  return {
    sufficiency: {
      type: 'noul',
      instructions: 'Looking only at the accepted evidence, is it already enough to support, refute, or clearly mark as unconfirmed the current inquiry? Do not ask for more search just to collect extra similar pages.',
      criteria: {
        true: 'A reasonable conclusion can be reached, or remaining uncertainty can be stated without another search.',
        false: 'A material fact is still missing, only weak secondary notes remain, or a contradiction is unresolved.',
      },
    },
  };
}

export function sufficiencyBand(score) {
  const value = clampScore(score);
  if (value == null) return 'unknown';
  if (value >= 0.75) return 'sufficient';
  if (value >= 0.45) return 'partial';
  return 'insufficient';
}

export function formatSufficiencyHint(score) {
  const band = sufficiencyBand(score);
  if (band === 'sufficient') {
    return 'Evidence appears sufficient. Further search is probably unnecessary unless you need to resolve a contradiction.';
  }
  if (band === 'partial') {
    return 'Evidence is partial. You may search once more for a stronger primary source, or mark the remaining uncertainty.';
  }
  if (band === 'insufficient') {
    return 'Evidence is insufficient for a firm conclusion. Search again for a primary source, or clearly mark this as unconfirmed.';
  }
  return '';
}

export function publicEvidenceGateSummary(decision = {}) {
  const accepted = Array.isArray(decision.accepted) ? decision.accepted : [];
  const rejected = Array.isArray(decision.rejected) ? decision.rejected : [];
  const sufficiency = clampScore(decision.sufficiency);
  return {
    mode: decision.mode || 'enforce',
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    rejectedHosts: [...new Set(rejected.map((hit) => hit.host).filter(Boolean))].slice(0, 8),
    confidence: decision.confidence ?? averageScores(accepted.map((hit) => hit.confidence)),
    sufficiency,
    sufficiencyBand: sufficiencyBand(sufficiency),
    hint: decision.hint || formatSufficiencyHint(sufficiency),
    note: 'Scores are 0-1. Relevance = about the query. Evidence = actually supports or refutes it. Quality = source trustworthiness. Do not treat rejected or low-evidence hits as facts.',
  };
}

function annotateHit(item, scored) {
  if (!scored) return item;
  return {
    ...item,
    evidence: {
      relevance: scored.relevance,
      evidence: scored.evidence,
      quality: scored.quality,
      confidence: scored.confidence,
      accepted: scored.accepted === true,
    },
  };
}

function replaceRetrievalRows(toolId, data, rows) {
  const id = String(toolId || '');
  if (id === 'web.search' && isRecord(data)) {
    return { ...data, results: rows };
  }
  if (Array.isArray(data)) return rows;
  if (isRecord(data) && Array.isArray(data.items)) return { ...data, items: rows };
  if (isRecord(data) && Array.isArray(data.results)) return { ...data, results: rows };
  return data;
}

function rawRows(toolId, data) {
  const id = String(toolId || '');
  if (id === 'web.search') return Array.isArray(data?.results) ? data.results : [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

function acceptedRefKeys(hits = []) {
  const keys = new Set();
  for (const hit of hits) {
    for (const value of [hit.url, hit.id, hit.knowledgeId]) {
      if (value) keys.add(String(value));
    }
  }
  return keys;
}

export function filterEvidenceRefs(refs = [], accepted = []) {
  const keys = acceptedRefKeys(accepted);
  if (!keys.size) return [];
  return (Array.isArray(refs) ? refs : []).filter((item) => keys.has(String(item?.resourceId || '')));
}

export function applyEvidenceGateToToolResult({
  toolId,
  toolResult = {},
  decision = {},
  mode = 'enforce',
} = {}) {
  if (!decision || decision.status !== 'ok') return toolResult;
  const rows = rawRows(toolId, toolResult.data);
  const scored = Array.isArray(decision.hits) ? decision.hits : [];
  const keep = mode === 'enforce'
    ? scored.filter((hit) => hit.accepted).map((hit) => annotateHit(rows[hit.index] || {
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet,
      publishedAt: hit.publishedAt,
    }, hit))
    : rows.map((item, index) => annotateHit(item, scored[index]));
  const nextData = replaceRetrievalRows(toolId, toolResult.data, keep);
  const summary = publicEvidenceGateSummary(decision);
  const data = Array.isArray(nextData)
    ? nextData
    : isRecord(nextData)
      ? { ...nextData, evidenceGate: summary }
      : nextData;
  return {
    ...toolResult,
    data,
    refs: mode === 'enforce' ? filterEvidenceRefs(toolResult.refs, decision.accepted) : toolResult.refs,
    evidenceGate: summary,
  };
}

export function aggregateEvidenceGate(decisions = []) {
  const ok = (Array.isArray(decisions) ? decisions : []).filter((item) => item?.status === 'ok');
  if (!ok.length) return null;
  const accepted = ok.flatMap((item) => item.accepted || []);
  const rejectedCount = ok.reduce((sum, item) => sum + (Array.isArray(item.rejected) ? item.rejected.length : 0), 0);
  const confidence = accepted.length
    ? averageScores([
      averageScores(accepted.map((hit) => hit.confidence)),
      averageScores(ok.map((item) => item.sufficiency)),
    ].filter((value) => value != null))
    : roundScore((averageScores(ok.map((item) => item.sufficiency)) ?? 0) * 0.3);
  return {
    calls: ok.length,
    acceptedCount: accepted.length,
    rejectedCount,
    confidence,
    sufficiency: averageScores(ok.map((item) => item.sufficiency)),
    meanRelevance: averageScores(accepted.map((hit) => hit.relevance)),
    meanEvidence: averageScores(accepted.map((hit) => hit.evidence)),
    meanQuality: averageScores(accepted.map((hit) => hit.quality)),
  };
}

export function projectEvidenceGateAudit(summary = {}) {
  if (!summary || typeof summary !== 'object') return null;
  return {
    calls: Number(summary.calls) || 0,
    acceptedCount: Number(summary.acceptedCount) || 0,
    rejectedCount: Number(summary.rejectedCount) || 0,
    confidence: clampScore(summary.confidence),
    sufficiency: clampScore(summary.sufficiency),
    meanRelevance: clampScore(summary.meanRelevance),
    meanEvidence: clampScore(summary.meanEvidence),
    meanQuality: clampScore(summary.meanQuality),
  };
}

export function formatEvidenceScreeningNote(summary = {}) {
  if (!summary) return '';
  const parts = [];
  if (Number.isFinite(summary.acceptedCount) || Number.isFinite(summary.rejectedCount)) {
    parts.push(`accepted ${Number(summary.acceptedCount) || 0}, rejected ${Number(summary.rejectedCount) || 0}`);
  }
  if (Number.isFinite(Number(summary.confidence))) {
    parts.push(`confidence ${Number(summary.confidence).toFixed(2)}`);
  }
  if (Number.isFinite(Number(summary.sufficiency))) {
    parts.push(`sufficiency ${Number(summary.sufficiency).toFixed(2)}`);
  }
  if (summary.hint) parts.push(summary.hint);
  return parts.join('. ');
}
