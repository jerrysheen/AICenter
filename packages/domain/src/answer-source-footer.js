export const ANSWER_SOURCE_FOOTER_LIMIT = 24;

const GROUPS = Object.freeze([
  { id: 'feed', label: '信息', types: ['content-item', 'post'] },
  { id: 'inspiration', label: '灵感', types: ['inspiration'] },
  { id: 'knowledge', label: '知识', types: ['knowledge-revision'] },
  { id: 'answer', label: '回答', types: ['ai-run'] },
  { id: 'web', label: '网页', types: ['web-result'] },
  { id: 'market', label: '持仓与市场', types: ['holdings-board', 'market-board'] },
]);

const TYPE_GROUP = new Map(GROUPS.flatMap((group) => group.types.map((type) => [type, group])));

function clipLabel(value, resourceType) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  return TYPE_GROUP.get(resourceType)?.label || resourceType;
}

function refKey(item) {
  const revision = item.resourceType === 'knowledge-revision' && item.revision ? `:${item.revision}` : '';
  return `${item.resourceType}:${item.resourceId}${revision}`;
}

function projectEvidenceNote(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const confidence = Number(evidence.confidence);
  const sufficiency = Number(evidence.sufficiency);
  const acceptedCount = Number(evidence.acceptedCount);
  const rejectedCount = Number(evidence.rejectedCount);
  if (![confidence, sufficiency, acceptedCount, rejectedCount].some((value) => Number.isFinite(value))) {
    return null;
  }
  return {
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
    sufficiency: Number.isFinite(sufficiency) ? Math.min(1, Math.max(0, sufficiency)) : null,
    acceptedCount: Number.isFinite(acceptedCount) ? acceptedCount : 0,
    rejectedCount: Number.isFinite(rejectedCount) ? rejectedCount : 0,
  };
}

export function projectAnswerSourceFooter(refs = [], { limit = ANSWER_SOURCE_FOOTER_LIMIT, evidence } = {}) {
  const cap = Math.max(0, Number.isInteger(limit) ? limit : ANSWER_SOURCE_FOOTER_LIMIT);
  const ranked = [];
  const index = new Map();
  for (const item of Array.isArray(refs) ? refs : []) {
    const resourceType = String(item?.resourceType || '');
    const resourceId = String(item?.resourceId || '').trim();
    const group = TYPE_GROUP.get(resourceType);
    if (!group || !resourceId) continue;
    const revision = Number.isInteger(item.revision) && item.revision > 0 ? item.revision : null;
    const origin = item.origin === 'selected' ? 'selected' : 'tool';
    const next = {
      resourceType,
      resourceId,
      revision,
      origin,
      label: clipLabel(item.label, resourceType),
      group: group.id,
      groupLabel: group.label,
      selected: origin === 'selected',
    };
    const key = refKey(next);
    if (index.has(key)) {
      const existing = index.get(key);
      if (existing.origin !== 'selected' && origin === 'selected') Object.assign(existing, next);
      continue;
    }
    index.set(key, next);
    ranked.push(next);
  }
  const items = ranked.slice(0, cap);
  return {
    groups: GROUPS
      .map((group) => ({
        id: group.id,
        label: group.label,
        items: items.filter((item) => item.group === group.id),
      }))
      .filter((group) => group.items.length),
    extraCount: Math.max(0, ranked.length - items.length),
    total: ranked.length,
    evidence: projectEvidenceNote(evidence),
  };
}
