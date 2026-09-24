export const DAILY_BRIEF_MAX_CANDIDATES = 120;
export const DAILY_BRIEF_MAX_INPUT_BYTES = 80 * 1024;

const STRUCTURAL_TYPES = Object.freeze([
  'strategy-transition',
  'strategy',
  'market',
  'official-release',
  'upcoming-event',
]);

function clip(value, max) {
  const text = String(value || '');
  return text.length > max ? text.slice(0, max) : text;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function sourceRef(type, id, at) {
  const refId = String(id || '').trim();
  if (!refId) return null;
  return { type, id: refId, at: Number.isInteger(at) ? at : null };
}

function modelView(candidate) {
  return {
    id: candidate.id,
    type: candidate.type,
    occurredAt: candidate.occurredAt,
    title: candidate.title,
    summary: candidate.summary,
    data: candidate.data,
  };
}

function newsCandidates(news = []) {
  return news.map((item) => ({
    id: `news:${item.id}`,
    type: 'news',
    occurredAt: Number.isInteger(item.eventAt) ? item.eventAt : 0,
    title: String(item.title || ''),
    summary: clip(item.summary, 240),
    sourceRefs: [sourceRef('content-item', item.id, item.eventAt)].filter(Boolean),
    data: {},
  }));
}

function releaseCandidates(releases = []) {
  return releases.map((release) => ({
    id: `official-release:${release.releaseId}`,
    type: 'official-release',
    occurredAt: Number.isInteger(release.publishedAt) ? release.publishedAt : 0,
    title: String(release.title || ''),
    summary: clip(`${release.authority || ''} ${release.documentType || ''}`, 240),
    sourceRefs: [sourceRef('official-release', release.releaseId, release.publishedAt)].filter(Boolean),
    data: {
      authority: String(release.authority || ''),
      title: String(release.title || ''),
      publishedAt: Number.isInteger(release.publishedAt) ? release.publishedAt : null,
      documentType: String(release.documentType || ''),
    },
  }));
}

function upcomingCandidates(events = []) {
  return events.map((event) => ({
    id: `upcoming-event:${event.eventId}`,
    type: 'upcoming-event',
    occurredAt: Number.isInteger(event.scheduledAt) ? event.scheduledAt : 0,
    title: String(event.title || ''),
    summary: clip(`${event.country || ''} ${event.authority || ''} ${event.eventType || ''}`, 240),
    sourceRefs: [sourceRef('scheduled-event', event.eventId, event.scheduledAt)].filter(Boolean),
    data: {
      country: String(event.country || ''),
      authority: String(event.authority || ''),
      title: String(event.title || ''),
      scheduledAt: Number.isInteger(event.scheduledAt) ? event.scheduledAt : null,
      eventType: String(event.eventType || ''),
    },
  }));
}

function marketCandidates(market = {}) {
  const rows = [];
  for (const board of ['cn', 'global']) {
    const indices = Array.isArray(market[board]?.indices) ? market[board].indices : [];
    for (const quote of indices) {
      const symbol = String(quote.symbol || '').trim();
      if (!symbol) continue;
      rows.push({
        id: `market:${board}:${symbol}`,
        type: 'market',
        occurredAt: Number.isInteger(quote.asOf) ? quote.asOf : 0,
        title: String(quote.name || symbol),
        summary: clip(`${symbol} changePct=${finiteOrNull(quote.changePct)}`, 240),
        sourceRefs: [sourceRef('market-snapshot', board, quote.asOf)].filter(Boolean),
        data: {
          symbol,
          name: String(quote.name || ''),
          changePct: finiteOrNull(quote.changePct),
          asOf: Number.isInteger(quote.asOf) ? quote.asOf : null,
        },
      });
    }
  }
  return rows;
}

function strategySnapshotRef(report) {
  const ref = (report?.sourceRefs || []).find((item) => item?.type === 'strategy-snapshot');
  if (!ref) return null;
  return sourceRef('strategy-snapshot', ref.id, ref.at);
}

function strategyCandidate(report) {
  const strategy = report?.content?.strategy;
  if (!strategy?.regime) return null;
  const factors = strategy.factors || {};
  return {
    id: `strategy:${strategy.strategyKey}`,
    type: 'strategy',
    occurredAt: Number.isInteger(strategy.asOf) ? strategy.asOf : 0,
    title: String(strategy.strategyKey || ''),
    summary: clip(String(strategy.regime || ''), 240),
    sourceRefs: [strategySnapshotRef(report)].filter(Boolean),
    data: {
      strategyKey: strategy.strategyKey,
      regime: strategy.regime,
      value: factors.value || null,
      pain: factors.pain || null,
      dataQuality: factors.dataQuality || null,
    },
  };
}

function transitionCandidate(current, previous) {
  const currentStrategy = current?.content?.strategy;
  const previousStrategy = previous?.content?.strategy;
  if (!currentStrategy?.regime || !previousStrategy?.regime) return null;
  if (previousStrategy.regime === 'UNKNOWN') return null;
  if (previousStrategy.regime === currentStrategy.regime) return null;
  return {
    id: `strategy-transition:${currentStrategy.strategyKey}`,
    type: 'strategy-transition',
    occurredAt: Number.isInteger(currentStrategy.asOf) ? currentStrategy.asOf : 0,
    title: `${previousStrategy.regime} → ${currentStrategy.regime}`,
    summary: clip(`${previousStrategy.strategyKey || currentStrategy.strategyKey} ${previousStrategy.regime} → ${currentStrategy.regime}`, 240),
    sourceRefs: [strategySnapshotRef(previous), strategySnapshotRef(current)].filter(Boolean),
    data: {
      strategyKey: currentStrategy.strategyKey,
      from: previousStrategy.regime,
      to: currentStrategy.regime,
    },
  };
}

function orderedCandidates(current, previous) {
  const content = current?.content || {};
  const built = [
    transitionCandidate(current, previous),
    strategyCandidate(current),
    ...marketCandidates(content.market),
    ...releaseCandidates(content.officialReleases),
    ...upcomingCandidates(content.upcoming),
  ].filter(Boolean);
  const groups = new Map(STRUCTURAL_TYPES.map((type) => [type, []]));
  for (const candidate of built) groups.get(candidate.type)?.push(candidate);
  const news = newsCandidates(content.news)
    .sort((left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id));
  return [...STRUCTURAL_TYPES.flatMap((type) => groups.get(type) || []), ...news];
}

function modelPayload(reportDate, ordered, included) {
  return {
    reportDate,
    candidateCount: ordered.length,
    includedCount: included.length,
    truncated: included.length < ordered.length,
    candidates: included.map(modelView),
  };
}

function fits(reportDate, ordered, included) {
  const payload = modelPayload(reportDate, ordered, included);
  return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= DAILY_BRIEF_MAX_INPUT_BYTES;
}

export function buildDailyBriefCandidates(current, previous = null) {
  const reportDate = String(current?.content?.reportDate || current?.reportDate || '');
  const ordered = orderedCandidates(current, previous);
  const included = [];
  for (const candidate of ordered) {
    if (included.length >= DAILY_BRIEF_MAX_CANDIDATES) break;
    const next = [...included, candidate];
    if (!fits(reportDate, ordered, next)) break;
    included.push(candidate);
  }
  return {
    candidateCount: ordered.length,
    includedCount: included.length,
    truncated: included.length < ordered.length,
    candidates: included,
    modelInput: modelPayload(reportDate, ordered, included),
  };
}
