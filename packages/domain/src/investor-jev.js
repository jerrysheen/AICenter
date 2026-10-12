// Shared JEV labeling for the investor-discussion digest and the offline experiment.
// Question text, stance rules, weights and batch size come from a versioned JSON file.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_JEV_VERSION = 'v2';
export const DEFAULT_JEV_BATCH = 12;
export const DEFAULT_JEV_ATTEMPTS = 3;
export const DEFAULT_JEV_BACKOFF_MS = 2000;
export const DEFAULT_JEV_MAX_CALLS = 200;

const ENGAGEMENTS = new Set(['likes-else-replies', 'replies-else-likes', 'sum', 'likes', 'replies', 'none']);
const TRANSFORMS = new Set(['1+log1p', 'log1p', 'flat']);
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9]*$/;

let cachedDefault = null;

export function jevRepositoryRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

export function resolveJevQuestionPath(selector, repositoryRoot = jevRepositoryRoot()) {
  const text = String(selector || '').trim();
  const root = path.resolve(repositoryRoot);
  if (!text) return path.join(root, 'config', `jev-questions.${DEFAULT_JEV_VERSION}.json`);
  const version = text.match(/^(?:jev-questions\.)?(v\d+)(?:\.json)?$/i);
  if (version) return path.join(root, 'config', `jev-questions.${version[1].toLowerCase()}.json`);
  if (path.isAbsolute(text)) return text;
  const resolved = path.resolve(root, text);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('AI_CENTER_DIGEST_JEV_QUESTIONS 不能指向仓库外');
  }
  return resolved;
}

function fail(file, message) {
  const where = file ? `（${file}）` : '';
  throw new Error(`股民讨论题集无效${where}：${message}`);
}

function requireObject(value, file, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(file, `${name} 需要对象`);
  return value;
}

export function validateJevQuestionSet(raw, file = '') {
  const set = requireObject(raw, file, '题集');
  const version = String(set.version || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) fail(file, 'version 需要短标识，例如 v2');
  if (typeof set.system !== 'string' || !set.system.trim()) fail(file, 'system 需要非空的系统提示词');
  if (!Array.isArray(set.questions) || !set.questions.length) fail(file, 'questions 需要至少一个问题');
  const ids = [];
  const questions = set.questions.map((question, index) => {
    const row = requireObject(question, file, `questions[${index}]`);
    const id = String(row.id || '').trim();
    const text = String(row.text || '').trim();
    if (!QUESTION_ID.test(id)) fail(file, `questions[${index}].id 只能是字母开头的标识`);
    if (!text) fail(file, `questions[${index}].text 不能为空`);
    if (ids.includes(id)) fail(file, `问题 id 重复：${id}`);
    const line = `${id}：${text}`;
    if (!set.system.includes(line)) fail(file, `系统提示词缺少「${line}」`);
    ids.push(id);
    return { id, text };
  });

  const user = requireObject(set.user, file, 'user');
  const intro = String(user.intro || '').trim();
  if (!intro) fail(file, 'user.intro 不能为空');
  const bodyClip = integerField(user.bodyClip, file, 'user.bodyClip', 1, 2000);
  const parentClip = integerField(user.parentClip, file, 'user.parentClip', 1, 2000);

  const aggregation = requireObject(set.aggregation, file, 'aggregation');
  const stances = requireObject(aggregation.stances, file, 'aggregation.stances');
  for (const key of ['bull', 'bear', 'neutral', 'irrelevant']) {
    if (!String(stances[key] || '').trim()) fail(file, `aggregation.stances.${key} 不能为空`);
  }
  const stanceNames = new Set(['bull', 'bear', 'neutral', 'irrelevant'].map((key) => stances[key]));
  if (stanceNames.size !== 4) fail(file, 'aggregation.stances 的四个名字必须不同');
  const minDirectional = integerField(aggregation.minDirectional, file, 'aggregation.minDirectional', 0, 10000);
  const thresholds = {
    bullShare: unitField(aggregation.bullShare, file, 'aggregation.bullShare'),
    bearShare: unitField(aggregation.bearShare, file, 'aggregation.bearShare'),
    gap: unitField(aggregation.gap, file, 'aggregation.gap'),
    splitMin: unitField(aggregation.splitMin, file, 'aggregation.splitMin'),
  };
  for (const key of ['insufficientLabel', 'bull', 'bear', 'split', 'flat']) {
    if (!String(aggregation[key] || '').trim()) fail(file, `aggregation.${key} 不能为空`);
  }

  const stance = requireObject(set.stance, file, 'stance');
  if (!Array.isArray(stance.rules) || !stance.rules.length) fail(file, 'stance.rules 需要至少一条规则');
  const fallback = String(stance.fallback || '').trim();
  if (!stanceNames.has(fallback)) fail(file, 'stance.fallback 必须是 aggregation.stances 里的名字');
  const rules = stance.rules.map((rule, index) => readStanceRule(rule, index, ids, stanceNames, file));

  const weight = requireObject(set.weight, file, 'weight');
  if (!ENGAGEMENTS.has(weight.engagement)) fail(file, `weight.engagement 只能是 ${[...ENGAGEMENTS].join('、')}`);
  if (!TRANSFORMS.has(weight.transform)) fail(file, `weight.transform 只能是 ${[...TRANSFORMS].join('、')}`);
  if (!Array.isArray(weight.factors)) fail(file, 'weight.factors 需要数组');
  const factors = weight.factors.map((factor, index) => {
    const row = requireObject(factor, file, `weight.factors[${index}]`);
    const question = String(row.question || '').trim();
    if (!ids.includes(question)) fail(file, `weight.factors[${index}].question 不是题集里的问题`);
    return {
      question,
      whenTrue: factorField(row.whenTrue, file, `weight.factors[${index}].whenTrue`),
      whenFalse: factorField(row.whenFalse, file, `weight.factors[${index}].whenFalse`),
    };
  });

  const batch = requireObject(set.batch, file, 'batch');
  return Object.freeze({
    version,
    system: set.system,
    questions,
    user: Object.freeze({ intro, bodyClip, parentClip }),
    stance: Object.freeze({ rules, fallback }),
    weight: Object.freeze({
      engagement: weight.engagement,
      transform: weight.transform,
      factors,
    }),
    aggregation: Object.freeze({
      ...thresholds,
      minDirectional,
      insufficientLabel: String(aggregation.insufficientLabel),
      bull: String(aggregation.bull),
      bear: String(aggregation.bear),
      split: String(aggregation.split),
      flat: String(aggregation.flat),
      stances: Object.freeze({
        bull: String(stances.bull),
        bear: String(stances.bear),
        neutral: String(stances.neutral),
        irrelevant: String(stances.irrelevant),
      }),
    }),
    batch: Object.freeze({
      size: integerField(batch.size, file, 'batch.size', 1, 40),
      singleAttempts: integerField(batch.singleAttempts, file, 'batch.singleAttempts', 1, 6),
      backoffMs: integerField(batch.backoffMs, file, 'batch.backoffMs', 0, 60_000),
    }),
  });
}

function readStanceRule(rule, index, ids, stanceNames, file) {
  const row = requireObject(rule, file, `stance.rules[${index}]`);
  const stance = String(row.stance || '').trim();
  if (!stanceNames.has(stance)) fail(file, `stance.rules[${index}].stance 必须是 aggregation.stances 里的名字`);
  const when = requireObject(row.when, file, `stance.rules[${index}].when`);
  const entries = Object.entries(when);
  if (!entries.length) fail(file, `stance.rules[${index}].when 至少要写一个问题`);
  const normalized = {};
  for (const [key, value] of entries) {
    if (!ids.includes(key)) fail(file, `stance.rules[${index}] 使用了未知问题 ${key}`);
    if (typeof value !== 'boolean') fail(file, `stance.rules[${index}].when.${key} 只能是 true 或 false`);
    normalized[key] = value;
  }
  let maxChars = null;
  if (row.maxChars != null) maxChars = integerField(row.maxChars, file, `stance.rules[${index}].maxChars`, 0, 10_000);
  return Object.freeze({ when: Object.freeze(normalized), stance, maxChars });
}

function integerField(value, file, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(file, `${name} 需要 ${min} 到 ${max} 的整数`);
  return value;
}

function unitField(value, file, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(file, `${name} 需要 0 到 1 的数字`);
  return value;
}

function factorField(value, file, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) fail(file, `${name} 需要 0 到 10 的数字`);
  return value;
}

export function loadJevQuestionSet({
  env = process.env,
  repositoryRoot = jevRepositoryRoot(),
  readFile = (file) => readFileSync(file, 'utf8'),
} = {}) {
  const selector = String(env.AI_CENTER_DIGEST_JEV_QUESTIONS || '').trim();
  const file = resolveJevQuestionPath(selector, repositoryRoot);
  let text = '';
  try {
    text = readFile(file);
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    if (!selector && missing) {
      throw new Error(`找不到默认题集 ${file}。`);
    }
    throw new Error(`AI_CENTER_DIGEST_JEV_QUESTIONS 找不到题集文件 ${file}。默认是 config/jev-questions.${DEFAULT_JEV_VERSION}.json。`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`AI_CENTER_DIGEST_JEV_QUESTIONS 不是合法 JSON（${file}）：${error.message}`);
  }
  return validateJevQuestionSet(parsed, file);
}

export function getDefaultJevQuestionSet() {
  if (!cachedDefault) cachedDefault = loadJevQuestionSet({ env: {} });
  return cachedDefault;
}

export function clipText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!Number.isInteger(max) || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function collapsedLength(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().length;
}

export function urlTail(url) {
  const clean = String(url || '').split(/[?#]/)[0].replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  return parts.at(-1) || '';
}

export function attachParentPosts(items) {
  const index = new Map();
  for (const item of items) {
    if (item.kind !== 'post') continue;
    for (const key of [item.sourceId, urlTail(item.url)].filter(Boolean)) {
      index.set(`${item.targetKey}\0${key}`, item);
    }
  }
  return items.map((item) => {
    if (item.kind !== 'comment') return { ...item, parentText: item.parentText || '' };
    const tail = urlTail(item.url);
    const parent = tail ? index.get(`${item.targetKey}\0${tail}`) : null;
    return { ...item, parentText: parent?.text || '' };
  });
}

export function materialsFromTarget(target, posts, comments) {
  const items = [];
  for (const post of posts || []) {
    items.push({
      id: `post:${target.key}:${post.id}`,
      sourceId: String(post.id),
      targetKey: target.key,
      targetName: target.name || target.key,
      kind: 'post',
      text: post.text || post.title || '',
      url: post.url || '',
      likeCount: Number(post.likeCount) || 0,
      replyCount: Number(post.replyCount) || 0,
    });
  }
  for (const comment of comments || []) {
    items.push({
      id: `comment:${target.key}:${comment.id}`,
      sourceId: String(comment.id),
      targetKey: target.key,
      targetName: target.name || target.key,
      kind: 'comment',
      text: comment.text || '',
      url: comment.url || '',
      likeCount: Number(comment.likeCount) || 0,
      replyCount: Number(comment.replyCount) || 0,
    });
  }
  return attachParentPosts(items);
}

export function buildJevUserPrompt(items, questionSet = getDefaultJevQuestionSet()) {
  const blocks = items.map((item) => {
    const lines = [
      `id: ${item.id}`,
      `本组标的: ${item.targetName || item.targetKey || ''}`,
      `类型: ${item.kind === 'comment' ? '评论' : '帖子'}`,
    ];
    if (item.kind === 'comment' && item.parentText) {
      lines.push(`原帖: ${clipText(item.parentText, questionSet.user.parentClip)}`);
    }
    lines.push(`原文: ${clipText(item.text, questionSet.user.bodyClip)}`);
    return lines.join('\n');
  });
  return `${questionSet.user.intro}\n\n${blocks.join('\n\n')}\n`;
}

export function engagementOf(item, weight = {}) {
  const likes = Math.max(0, Number(item?.likeCount) || 0);
  const replies = Math.max(0, Number(item?.replyCount) || 0);
  if (weight.engagement === 'replies-else-likes') return replies > 0 ? replies : likes;
  if (weight.engagement === 'sum') return likes + replies;
  if (weight.engagement === 'likes') return likes;
  if (weight.engagement === 'replies') return replies;
  if (weight.engagement === 'none') return 0;
  return likes > 0 ? likes : replies;
}

export function engagementWeight(item, questionSet = null) {
  const weight = questionSet?.weight || { engagement: 'likes-else-replies', transform: '1+log1p', factors: [] };
  const engagement = engagementOf(item, weight);
  if (weight.transform === 'log1p') return Math.log1p(engagement);
  if (weight.transform === 'flat') return 1;
  return 1 + Math.log1p(engagement);
}

export function jevItemWeight(item, label, questionSet) {
  let weight = engagementWeight(item, questionSet);
  for (const factor of questionSet.weight.factors || []) {
    weight *= label?.[factor.question] ? factor.whenTrue : factor.whenFalse;
  }
  return weight;
}

export function stanceFromAnswers(flags, text, questionSet) {
  for (const rule of questionSet.stance.rules) {
    if (rule.maxChars != null && collapsedLength(text) > rule.maxChars) continue;
    const matched = Object.entries(rule.when).every(([key, expected]) => flags?.[key] === expected);
    if (matched) return rule.stance;
  }
  return questionSet.stance.fallback;
}

export function stanceFromJev(flags, text = '', questionSet = getDefaultJevQuestionSet()) {
  return stanceFromAnswers(flags, text, questionSet);
}

export function parseModelJsonValue(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const objectAt = cleaned.indexOf('{');
  const arrayAt = cleaned.indexOf('[');
  let start = -1;
  let end = -1;
  if (objectAt >= 0 && (arrayAt < 0 || objectAt < arrayAt)) {
    start = objectAt;
    end = cleaned.lastIndexOf('}');
  } else if (arrayAt >= 0) {
    start = arrayAt;
    end = cleaned.lastIndexOf(']');
  }
  if (start < 0 || end <= start) {
    const error = new Error('模型没有返回 JSON');
    error.code = 'bad_json';
    throw error;
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    const error = new Error('模型返回的 JSON 无法解析');
    error.code = 'bad_json';
    throw error;
  }
}

export function resolveReturnedId(rawId, expectedIds, taken = new Map()) {
  const id = String(rawId || '').trim();
  if (!id) return '';
  const available = expectedIds.filter((item) => !taken.has(item));
  if (available.includes(id)) return id;
  const hits = available.filter((item) => item.endsWith(`:${id}`) || id.endsWith(`:${item}`));
  return hits.length === 1 ? hits[0] : '';
}

function rowsOf(value) {
  const rows = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(rows)) {
    const error = new Error('模型没有返回条目数组');
    error.code = 'bad_json';
    throw error;
  }
  return rows;
}

function indexRows(rows, expectedIds) {
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = resolveReturnedId(row.id, expectedIds, byId);
    if (!id || byId.has(id)) continue;
    byId.set(id, row);
  }
  return byId;
}

function unlabeled(id, reason) {
  return { id, scheme: 'jev', labeled: false, reason, stance: '', strength: null };
}

function asItems(itemsOrIds) {
  return (itemsOrIds || []).map((item) => (typeof item === 'string' ? { id: item, text: '' } : item));
}

export function parseJevBatch(text, itemsOrIds, questionSet = getDefaultJevQuestionSet()) {
  const items = asItems(itemsOrIds);
  const expectedIds = items.map((item) => item.id);
  const byId = indexRows(rowsOf(parseModelJsonValue(text)), expectedIds);
  return items.map((item) => {
    const row = byId.get(item.id);
    if (!row) return unlabeled(item.id, '缺失');
    const flags = {};
    for (const question of questionSet.questions) {
      if (typeof row[question.id] !== 'boolean') return unlabeled(item.id, '非法');
      flags[question.id] = row[question.id];
    }
    return {
      id: item.id,
      scheme: 'jev',
      labeled: true,
      reason: '',
      stance: stanceFromAnswers(flags, item.text, questionSet),
      strength: 1,
      ...flags,
      hasEvidence: flags.hasEvidence,
      unverifiedRumor: Boolean(flags.rumor),
    };
  });
}

function stanceKey(stance, questionSet) {
  const names = questionSet.aggregation.stances;
  if (stance === names.bull) return 'bull';
  if (stance === names.bear) return 'bear';
  if (stance === names.neutral) return 'neutral';
  if (stance === names.irrelevant) return 'irrelevant';
  return '';
}

export function sentimentFromRules(shares = {}, rules = {}) {
  const bull = Number(shares.bull) || 0;
  const bear = Number(shares.bear) || 0;
  const neutral = Number(shares.neutral) || 0;
  const total = bull + bear + neutral;
  if (total <= 0) return rules.flat || '平淡';
  const bullShare = bull / total;
  const bearShare = bear / total;
  if (bullShare >= rules.bullShare && bullShare - bearShare >= rules.gap) return rules.bull || '偏多';
  if (bearShare >= rules.bearShare && bearShare - bullShare >= rules.gap) return rules.bear || '偏空';
  if (bullShare >= rules.splitMin && bearShare >= rules.splitMin) return rules.split || '分歧';
  return rules.flat || '平淡';
}

export function aggregateJev(items, labelsById, questionSet = getDefaultJevQuestionSet()) {
  const counts = { bull: 0, bear: 0, neutral: 0, irrelevant: 0, labeled: 0, unlabeled: 0 };
  const weights = { bull: 0, bear: 0, neutral: 0 };
  let directionalCount = 0;
  for (const item of items) {
    const label = labelsById?.get?.(item.id);
    if (!label?.labeled || !stanceKey(label.stance, questionSet)) {
      counts.unlabeled += 1;
      continue;
    }
    counts.labeled += 1;
    const key = stanceKey(label.stance, questionSet);
    counts[key] += 1;
    if (key === 'irrelevant') continue;
    if (key === 'bull' || key === 'bear') directionalCount += 1;
    weights[key] += jevItemWeight(item, label, questionSet);
  }
  const totalWeight = weights.bull + weights.bear + weights.neutral;
  const shares = {
    bull: totalWeight ? weights.bull / totalWeight : 0,
    bear: totalWeight ? weights.bear / totalWeight : 0,
    neutral: totalWeight ? weights.neutral / totalWeight : 0,
  };
  const net = totalWeight > 0 ? (weights.bull - weights.bear) / totalWeight : null;
  const rules = questionSet.aggregation;
  let label = '';
  if (items.length) {
    label = directionalCount < rules.minDirectional ? rules.insufficientLabel : sentimentFromRules(shares, rules);
  }
  return {
    empty: items.length === 0,
    shares,
    counts,
    weights,
    sampleSize: counts.bull + counts.bear + counts.neutral,
    total: items.length,
    directionalCount,
    labeled: counts.labeled,
    unlabeled: counts.unlabeled,
    label,
    sentiment: label,
    net,
  };
}

export function presentCrowd(aggregate, questionSet) {
  const names = questionSet.aggregation.stances;
  return {
    questionSet: questionSet.version,
    shares: aggregate.shares,
    counts: aggregate.counts,
    sampleSize: aggregate.sampleSize,
    total: aggregate.total,
    directionalCount: aggregate.directionalCount,
    minDirectional: questionSet.aggregation.minDirectional,
    label: aggregate.label,
    labels: { bull: names.bull, bear: names.bear, neutral: names.neutral },
  };
}

function chunkItems(items, size) {
  const out = [];
  const step = Math.max(1, size);
  for (let index = 0; index < items.length; index += step) out.push(items.slice(index, index + step));
  return out;
}

function addTokens(total, usage = {}) {
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
    const value = Number(usage?.[key]);
    if (Number.isFinite(value)) total[key] += value;
  }
}

function failureReason(error) {
  if (error?.code === 'truncated' || /截断/.test(String(error?.message || ''))) return '输出被截断';
  if (error?.code === 'bad_json' || /JSON/.test(String(error?.message || ''))) return 'JSON 非法';
  return String(error?.message || error || '批次失败');
}

export async function runJevLabeling({
  items,
  questionSet = getDefaultJevQuestionSet(),
  batchSize = questionSet.batch?.size || DEFAULT_JEV_BATCH,
  maxCalls = DEFAULT_JEV_MAX_CALLS,
  singleAttempts = questionSet.batch?.singleAttempts || DEFAULT_JEV_ATTEMPTS,
  backoffMs = questionSet.batch?.backoffMs ?? DEFAULT_JEV_BACKOFF_MS,
  complete,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now = Date.now,
}) {
  if (typeof complete !== 'function') throw new Error('打标签需要模型调用');
  const labelsById = new Map();
  const gaps = [];
  const usage = { calls: 0, splitRetries: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, failures: 0 };
  const started = now();
  let stopped = false;
  const queue = chunkItems(items, batchSize);

  function markGap(batch, reason) {
    const ids = batch.map((item) => item.id);
    gaps.push({ ids, reason });
    for (const id of ids) labelsById.set(id, unlabeled(id, reason));
  }

  async function callModel(batch) {
    if (usage.calls >= maxCalls) {
      stopped = true;
      return { limited: true };
    }
    usage.calls += 1;
    try {
      const result = await complete({
        system: questionSet.system,
        prompt: buildJevUserPrompt(batch, questionSet),
        scheme: 'jev',
        batch,
      });
      addTokens(usage, result?.usage);
      if (result?.truncated || result?.finishReason === 'MAX_TOKENS') {
        try {
          return { parsed: parseJevBatch(result?.text, batch, questionSet), truncated: true };
        } catch (error) {
          usage.failures += 1;
          error.code = error.code || 'truncated';
          return { error };
        }
      }
      return { parsed: parseJevBatch(result?.text, batch, questionSet), truncated: false };
    } catch (error) {
      if (error?.code === 'config') throw error;
      usage.failures += 1;
      return { error };
    }
  }

  function split(batch) {
    usage.splitRetries += 1;
    const mid = Math.ceil(batch.length / 2);
    queue.unshift(batch.slice(0, mid), batch.slice(mid));
  }

  async function labelSingleton(batch) {
    let lastReason = '批次失败';
    const attempts = Math.max(1, singleAttempts);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const outcome = await callModel(batch);
      if (outcome.limited) {
        markGap(batch, '调用次数达到上限');
        return;
      }
      if (outcome.parsed?.every((label) => label.labeled)) {
        for (const label of outcome.parsed) labelsById.set(label.id, label);
        return;
      }
      lastReason = outcome.error ? failureReason(outcome.error) : (outcome.parsed?.[0]?.reason || '批次失败');
      if (outcome.truncated) lastReason = '输出被截断';
      if (attempt < attempts && usage.calls < maxCalls) await sleep(backoffMs * attempt);
    }
    if (usage.calls >= maxCalls && lastReason !== '调用次数达到上限') stopped = true;
    markGap(batch, usage.calls >= maxCalls && lastReason !== 'JSON 非法' ? `${lastReason}；调用次数达到上限` : lastReason);
  }

  while (queue.length) {
    const batch = queue.shift();
    if (!batch?.length) continue;
    if (usage.calls >= maxCalls) {
      stopped = true;
      markGap(batch, '调用次数达到上限');
      continue;
    }
    if (batch.length === 1) {
      await labelSingleton(batch);
      continue;
    }
    const outcome = await callModel(batch);
    if (outcome.limited) {
      markGap(batch, '调用次数达到上限');
      continue;
    }
    if (!outcome.parsed) {
      if (usage.calls < maxCalls) split(batch);
      else {
        stopped = true;
        markGap(batch, `${failureReason(outcome.error)}；调用次数达到上限`);
      }
      continue;
    }
    const missing = [];
    for (const label of outcome.parsed) {
      labelsById.set(label.id, label);
      if (!label.labeled) missing.push(batch.find((item) => item.id === label.id));
    }
    const pending = missing.filter(Boolean);
    if (!pending.length) continue;
    if (usage.calls >= maxCalls) {
      stopped = true;
      markGap(pending, '调用次数达到上限');
      continue;
    }
    if (pending.length === 1) {
      await labelSingleton(pending);
      continue;
    }
    split(pending);
  }

  const labels = [...labelsById.values()];
  return {
    scheme: 'jev',
    maxCalls,
    labelsById,
    usage,
    gaps,
    stopped,
    durationMs: Math.max(0, now() - started),
    labeled: labels.filter((label) => label.labeled).length,
    unlabeled: labels.filter((label) => !label.labeled).length,
  };
}
