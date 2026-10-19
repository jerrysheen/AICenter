// Bamboo research recall questions. TypeSafe still uses the free-text JSON
// judge. These helpers only build noul questions and map scores back to the
// fields the recall service already stores: tag matched, and one verdict.

export const RESEARCH_TAG_NOUL_VERSION = 'research-tag-noul-v1';
export const RESEARCH_RELEVANCE_NOUL_VERSION = 'research-relevance-noul-v1';
export const RESEARCH_TAG_QUESTION_CAP = 12;
export const RESEARCH_TAG_MATCH_AT = 0.60;
export const RESEARCH_DIRECT_AT = 0.60;
export const RESEARCH_VERIFIABLE_AT = 0.50;
export const RESEARCH_BACKGROUND_AT = 0.60;
export const RESEARCH_NEAR_DIRECT_AT = 0.40;
export const RESEARCH_INSUFFICIENT_CHARS = 40;

const CLIP = 800;

function fold(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function clip(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > CLIP ? `${text.slice(0, CLIP)}…` : text;
}

export function substantialResearchChars(item = {}) {
  return fold(`${item.title || ''}${item.text || ''}${item.body || ''}`).length;
}

function keywordHits(item, tag) {
  const blob = fold(`${item?.title || ''}\n${item?.text || ''}\n${item?.body || ''}`);
  let hits = 0;
  for (const term of [...(tag?.keywords || []), ...(tag?.aliases || [])]) {
    const folded = fold(term);
    if (folded && blob.includes(folded)) hits += 1;
  }
  return hits;
}

// At most 12 tag questions per item. The shipped catalogs are under that, so
// every referenced tag is asked. Larger sets keep the tags with a keyword or
// alias hit, then the strongest 12. The rest are left unmatched without a call.
export function selectResearchTags(tags = [], item = {}) {
  const list = (tags || []).filter((tag) => tag && tag.id);
  if (list.length <= RESEARCH_TAG_QUESTION_CAP) return { asked: list, skipped: [] };
  const ranked = list
    .map((tag) => ({ tag, hits: keywordHits(item, tag) }))
    .filter((row) => row.hits > 0)
    .sort((left, right) => right.hits - left.hits || String(left.tag.id).localeCompare(String(right.tag.id)));
  const asked = ranked.slice(0, RESEARCH_TAG_QUESTION_CAP).map((row) => row.tag);
  const askedIds = new Set(asked.map((tag) => tag.id));
  return { asked, skipped: list.filter((tag) => !askedIds.has(tag.id)) };
}

export function researchTagQuestion(tag) {
  return {
    type: 'noul',
    instructions: `这条材料是否符合研究标签「${clip(tag.name)}」。只根据材料本身判断，不写理由，不判断涨跌。`,
    criteria: {
      true: clip(`符合定义：${tag.definition} 计入：${tag.include}`),
      false: clip(`不符合，或命中排除：${tag.exclude}`),
    },
  };
}

export function researchItemState(item = {}) {
  return {
    title: clip(item.title),
    text: clip(item.text),
    body: clip(item.body),
  };
}

export function researchRelevanceQuestions() {
  return {
    direct_answer: {
      type: 'noul',
      instructions: '这条材料是否直接回答研究问题的目标？只看材料里写出的内容，不写理由。',
      criteria: {
        true: '材料直接给出问题所问的变化、条件或事实。',
        false: '材料没有回答这个问题，或只是提到相关名字。',
      },
    },
    related_context: {
      type: 'noul',
      instructions: '这条材料是否提供与研究问题相关、但不是直接答案的背景或旁证？',
      criteria: {
        true: '材料提供相关背景、上下文或旁证，读者仍不能把它当成对问题的直接回答。',
        false: '材料和问题无关，或它本身就是直接回答。',
      },
    },
    verifiable_fact: {
      type: 'noul',
      instructions: '这条材料是否提供可以核对的事实或数据，而不是口号、情绪或无法核对的判断？',
      criteria: {
        true: '有可核对的事件、数字、主体或明确条件。',
        false: '只有口号、情绪、传闻或无法核对的判断。',
      },
    },
  };
}

export function researchRelevanceState(question = {}, item = {}) {
  const subs = Array.isArray(question.subquestions) ? question.subquestions : [];
  return {
    objective: clip(question.objective),
    subquestions: subs.map((sub) => clip(sub.text)).filter(Boolean).slice(0, 12),
    evidence: clip(question.evidence),
    ...researchItemState(item),
  };
}

export function researchTagHits(answers = {}, threshold = RESEARCH_TAG_MATCH_AT) {
  const hits = [];
  for (const [id, answer] of Object.entries(answers || {})) {
    if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number') continue;
    if (answer.noul >= threshold) hits.push(id);
  }
  return hits;
}

export function researchVerdictFromScores(scores = {}, item = {}) {
  const direct = scores.direct_answer;
  const related = scores.related_context;
  const facts = scores.verifiable_fact;
  if (![direct, related, facts].every((value) => typeof value === 'number' && value >= 0 && value <= 1)) return '';
  if (direct >= RESEARCH_DIRECT_AT && facts >= RESEARCH_VERIFIABLE_AT) return 'direct';
  if (related >= RESEARCH_BACKGROUND_AT || direct >= RESEARCH_NEAR_DIRECT_AT) return 'background';
  if (substantialResearchChars(item) < RESEARCH_INSUFFICIENT_CHARS) return 'insufficient';
  return 'irrelevant';
}

// One tag call and one relevance call per usable member on the summary pass.
// A body pass adds the same pair only for members whose summary was insufficient.
// These calls stay on the research budget (default 400) and do not use the
// feed-admission daily counter.
export function estimateResearchBambooCalls({ members = 0, tagCount = 0, insufficientRate = 0 } = {}) {
  const count = Math.max(0, Number(members) || 0);
  const tagCall = tagCount > 0 ? 1 : 0;
  const perSummary = tagCall + 1;
  const rate = Math.min(1, Math.max(0, Number(insufficientRate) || 0));
  const summary = count * perSummary;
  const body = Math.round(count * rate) * perSummary;
  return { perSummary, summary, body, total: summary + body };
}
