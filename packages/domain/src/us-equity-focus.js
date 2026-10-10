import { createHash } from 'node:crypto';

export const US_EQUITY_FOCUS_VERSION = 'us-equity-focus-v1';
export const DEFAULT_FOCUS_THRESHOLD = 0.5;

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function text(value) {
  return String(value || '').trim();
}

export function loadUsEquityFocus(source) {
  const raw = typeof source === 'string' ? JSON.parse(source) : source;
  if (!raw || raw.kind !== 'focus-questions' || !Array.isArray(raw.questions) || raw.questions.length < 1) {
    throw new Error('美股关注问题配置无效');
  }
  const ids = new Set();
  const questions = raw.questions.map((question) => {
    const id = text(question?.id);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id) || ids.has(id)) throw new Error(`关注问题 ID 无效或重复：${id}`);
    ids.add(id);
    if (question.type && question.type !== 'noul') throw new Error(`${id} 必须使用 noul`);
    const ask = text(question.ask);
    const yes = text(question.true);
    const no = text(question.false);
    if (!ask || !yes || !no || !text(question.name)) throw new Error(`${id} 缺少问题或判断标准`);
    return {
      id,
      name: text(question.name),
      ask,
      true: yes,
      false: no,
      version: text(question.version),
      history: Array.isArray(question.history) ? question.history : [],
    };
  });
  const threshold = Number(raw.threshold);
  return {
    kind: 'focus-questions',
    id: text(raw.id) || 'us_equity_daily',
    version: text(raw.version) || US_EQUITY_FOCUS_VERSION,
    threshold: Number.isFinite(threshold) && threshold > 0 && threshold < 1 ? threshold : DEFAULT_FOCUS_THRESHOLD,
    boundary: text(raw.boundary),
    questions,
  };
}

export function questionDefinitionHash(definition, question) {
  return hash({
    boundary: definition.boundary,
    id: question.id,
    ask: question.ask,
    true: question.true,
    false: question.false,
  });
}

export function focusTextHash(title, summary) {
  return hash({ title: text(title), summary: text(summary) });
}

export function buildFocusQuestions(definition, ids = null) {
  const wanted = ids ? new Set(ids) : null;
  const boundary = definition.boundary ? `${definition.boundary} ` : '';
  const questions = {};
  for (const question of definition.questions) {
    if (wanted && !wanted.has(question.id)) continue;
    questions[question.id] = {
      type: 'noul',
      instructions: `${boundary}${question.ask}`,
      criteria: { true: question.true, false: question.false },
    };
  }
  if (!Object.keys(questions).length) throw new Error('没有可评分的关注问题');
  return questions;
}

export function focusCacheKey({ textHash, questionId, definitionHash, model }) {
  return hash({ textHash, questionId, definitionHash, model: text(model) });
}

function finiteScore(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseFocusAnswer(answer) {
  if (!answer || typeof answer !== 'object' || answer.type !== 'noul') {
    return { status: 'failed', score: null, errorCode: 'invalid-answer' };
  }
  const score = finiteScore(answer.noul);
  if (score === null) return { status: 'failed', score: null, errorCode: 'invalid-score' };
  return { status: 'success', score, errorCode: '' };
}

function usageOf(usage = {}) {
  const input = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens;
  const cost = usage.cost ?? usage.total_cost;
  return {
    inputTokens: Number.isFinite(Number(input)) ? Number(input) : null,
    outputTokens: Number.isFinite(Number(output)) ? Number(output) : null,
    cost: Number.isFinite(Number(cost)) ? Number(cost) : null,
  };
}

function failedRow(question, definition, model, errorCode, requestedAt) {
  return {
    questionId: question.id,
    name: question.name,
    definitionHash: questionDefinitionHash(definition, question),
    status: 'failed',
    score: null,
    cached: false,
    model: text(model),
    errorCode,
    requestedAt,
    usage: { inputTokens: null, outputTokens: null, cost: null },
  };
}

export function createUsEquityFocusEvaluator({
  client,
  model = '',
  definition,
  cache = null,
  now = () => Date.now(),
} = {}) {
  const loaded = definition?.questions ? definition : loadUsEquityFocus(definition);
  return Object.freeze({
    version: US_EQUITY_FOCUS_VERSION,
    definition: loaded,
    async evaluate({ title, summary, signal, questionIds = null } = {}) {
      const requestedAt = now();
      const textHash = focusTextHash(title, summary);
      const state = { title: text(title), summary: text(summary) };
      const selected = questionIds
        ? loaded.questions.filter((question) => questionIds.includes(question.id))
        : loaded.questions;
      if (!selected.length) throw new Error('没有可评分的关注问题');
      const pending = [];
      const rows = [];
      for (const question of selected) {
        const definitionHash = questionDefinitionHash(loaded, question);
        const key = focusCacheKey({ textHash, questionId: question.id, definitionHash, model });
        const saved = cache?.get?.(key);
        if (saved?.status === 'success' && finiteScore(saved.score) !== null && saved.definitionHash === definitionHash) {
          rows.push({ ...saved, questionId: question.id, name: question.name, cached: true, definitionHash });
        } else pending.push(question);
      }
      let response = null;
      let errorCode = '';
      let errorStatus = null;
      if (pending.length) {
        if (!client?.evaluate || client.available?.() === false) errorCode = 'jev-unavailable';
        else {
          try {
            response = await client.evaluate({
              state,
              questions: buildFocusQuestions(loaded, pending.map((question) => question.id)),
              signal,
              ...(model ? { model } : {}),
            });
          } catch (error) {
            errorCode = error?.code || 'jev-failed';
            errorStatus = Number.isInteger(error?.status) ? error.status : null;
          }
        }
      }
      const actualModel = response?.model || model;
      const usage = response ? usageOf(response.usage) : { inputTokens: null, outputTokens: null, cost: null };
      const elapsedMs = now() - requestedAt;
      for (const question of pending) {
        const definitionHash = questionDefinitionHash(loaded, question);
        const parsed = response ? parseFocusAnswer(response.answers?.[question.id]) : { status: 'failed', score: null, errorCode: errorCode || 'missing-response' };
        const row = {
          questionId: question.id,
          name: question.name,
          definitionHash,
          status: parsed.status,
          score: parsed.status === 'success' ? parsed.score : null,
          cached: false,
          model: text(actualModel),
          errorCode: parsed.errorCode,
          errorStatus: parsed.status === 'success' ? null : errorStatus,
          requestedAt,
          elapsedMs,
          usage,
        };
        if (row.status === 'success') {
          cache?.set?.(focusCacheKey({ textHash, questionId: question.id, definitionHash, model }), row);
        }
        rows.push(row);
      }
      const byId = Object.fromEntries(selected.map((question) => {
        const row = rows.find((item) => item.questionId === question.id) || failedRow(question, loaded, actualModel, 'missing-response', requestedAt);
        return [question.id, row];
      }));
      return {
        version: US_EQUITY_FOCUS_VERSION,
        textHash,
        model: text(actualModel),
        requestedAt,
        elapsedMs,
        errorCode,
        errorStatus,
        requestCount: pending.length ? 1 : 0,
        requestedQuestionIds: pending.map((question) => question.id),
        usage: pending.length ? usage : { inputTokens: null, outputTokens: null, cost: null },
        answers: byId,
      };
    },
  });
}

export function focusHit(row, threshold = DEFAULT_FOCUS_THRESHOLD) {
  return row?.status === 'success' && typeof row.score === 'number' && row.score >= threshold;
}

export function stratifySample(items, { limit = 150, seed = 'us-equity-focus-v1' } = {}) {
  const groups = new Map();
  for (const item of items) {
    const key = text(item?.stratum) || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const rank = (item) => hash([seed, item.id]);
  for (const list of groups.values()) {
    list.sort((a, b) => rank(a).localeCompare(rank(b)) || String(a.id).localeCompare(String(b.id)));
  }
  const names = [...groups.keys()].sort();
  const total = names.reduce((sum, name) => sum + groups.get(name).length, 0);
  const plans = names.map((name) => {
    const available = groups.get(name).length;
    const exact = total ? (Math.min(limit, total) * available) / total : 0;
    return { name, available, exact, take: Math.min(available, Math.floor(exact)) };
  });
  let left = Math.min(limit, total) - plans.reduce((sum, plan) => sum + plan.take, 0);
  const remainder = [...plans].sort((a, b) => (b.exact - b.take) - (a.exact - a.take) || a.name.localeCompare(b.name));
  for (const plan of remainder) {
    if (left <= 0) break;
    if (plan.take < plan.available) {
      plan.take += 1;
      left -= 1;
    }
  }
  const selected = [];
  const strata = plans.map((plan) => {
    const taken = groups.get(plan.name).slice(0, plan.take);
    selected.push(...taken);
    return { stratum: plan.name, available: plan.available, taken: taken.length };
  });
  selected.sort((a, b) => (a.eventAt || 0) - (b.eventAt || 0) || String(a.id).localeCompare(String(b.id)));
  return { selected, uncovered: total - selected.length, total, strata };
}
