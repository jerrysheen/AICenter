import { googleFetch } from '../../connectors/src/google-fetch.js';
import { yieldEventLoop } from './event-loop.js';
import { resolveGoogleHourlyAdmissionModels } from '../../harness/src/llm-route.js';
import {
  alignFocusBatch,
  keywordFocus,
  parseFocusObject,
  xFocusBatchInstruction,
  xFocusInstruction,
} from './x-focus.js';

const CACHE_DATE = 'x-focus';
export const X_FOCUS_SCORE_RESERVE_MS = 15_000;
const SCORE_FLOOR_MS = 3_000;
const BATCH_CONCURRENCY = 3;
const MAX_ITEM_RETRIES = 5;

function text(value) {
  return String(value || '').trim();
}

export function xFocusKeyEnvs(env = process.env) {
  const names = String(env.AI_CENTER_GEMINI_KEY_ENVS || 'GEMINI_API_KEY,GEMINI_API_KEY2,GEMINI_API_KEY3,GEMINI_API_KEY4,GEMINI_API_KEY5')
    .split(',').map((item) => item.trim()).filter(Boolean);
  if (names.length > 5 || names.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) throw new Error('invalid Gemini key environment names');
  const seen = new Set();
  const keys = [];
  for (const name of names) {
    const key = text(env[name]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(name);
  }
  return keys;
}

function quotaError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.code === 'budget-deferred' || error.quotaExhausted === true || error.providerQuota === true) return true;
  if (Number(error.status) === 429) return true;
  return /RESOURCE_EXHAUSTED|\bquota\b|配额/i.test(String(error.message || ''));
}

function timeoutError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '');
  return error?.code === 'timeout' || name === 'AbortError' || name === 'TimeoutError' || /超时|timed out|\btimeout\b/i.test(message);
}

function hardModelError(error) {
  if (quotaError(error) || timeoutError(error)) return true;
  const status = Number(error?.status);
  if (status === 429 || status >= 500) return true;
  const code = String(error?.code || '');
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) return true;
  return /fetch failed|network|socket|ECONN|ENOTFOUND|getaddrinfo/i.test(String(error?.message || ''));
}

function answerText(result) {
  return result?.answer || result?.text || result?.output || '';
}

function combinedSignal(timeoutMs, signal) {
  const timer = AbortSignal.timeout(Math.max(1, timeoutMs));
  if (!signal) return timer;
  return AbortSignal.any([timer, signal]);
}

async function directGemini({ env, model, keyEnv, instruction, message, timeoutMs, fetchImpl, signal }) {
  const key = text(env[keyEnv]);
  if (!key) throw new Error('缺少 Gemini 密钥');
  const root = text(env.AI_CENTER_GEMINI_API_ROOT) || 'https://generativelanguage.googleapis.com/v1beta';
  const response = await fetchImpl(`${root.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instruction }] },
      contents: [{ role: 'user', parts: [{ text: message }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
    signal: combinedSignal(timeoutMs, signal),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Gemini ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const parts = body?.candidates?.[0]?.content?.parts || [];
  return { answer: parts.map((part) => part?.text || '').join('') };
}

export function createXFocusScorer({
  config,
  env = process.env,
  agentRuntime = null,
  cache = null,
  workspaceId = 'local',
  complete = null,
  fetchImpl = null,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  if (!config) throw new Error('x-focus 配置缺失');
  const googleHourly = text(env.AI_CENTER_HARNESS_HOURLY_PROVIDER) === 'google';
  const keyEnvs = xFocusKeyEnvs(env);
  // Hourly Grok/DeepSeek model ids must not be sent to Gemini. The Google
  // hourly route is the only place that already admits flash-lite models.
  const models = googleHourly ? resolveGoogleHourlyAdmissionModels(env) : ['gemini-3.1-flash-lite'];
  let keyCursor = 0;
  const http = fetchImpl || googleFetch(fetch, env);

  function readCache(tweetId) {
    const saved = cache?.read?.(workspaceId, tweetId, config.version);
    if (!saved) return null;
    const parsed = parseFocusObject(saved, config);
    return parsed ? { ...parsed, method: 'cache' } : null;
  }

  function writeCache(tweetId, value) {
    if (value?.method !== 'model') return;
    cache?.write?.(workspaceId, tweetId, config.version, {
      dirScores: value.dirScores,
      sensitive: value.sensitive,
      officialSpeech: value.officialSpeech,
      promotional: value.promotional === true,
      reason: value.reason,
    });
  }

  function scoreDeadline(deadlineAt) {
    const started = now();
    const cap = started + config.scoreTimeoutMs;
    const outer = Number.isFinite(Number(deadlineAt)) ? Number(deadlineAt) - X_FOCUS_SCORE_RESERVE_MS : cap;
    return Math.min(cap, outer);
  }

  async function callModel(instruction, message, timeoutMs, signal) {
    const keyList = keyEnvs.length ? keyEnvs : [''];
    const keyEnv = keyList[keyCursor % keyList.length];
    const model = models[0] || 'gemini-3.1-flash-lite';
    keyCursor = (keyCursor + 1) % keyList.length;
    const attempt = () => {
      if (complete) return complete({ instruction, message, timeoutMs, keyEnv, model, signal });
      if (googleHourly && agentRuntime?.run) {
        return agentRuntime.run({
          closedContext: true,
          closedTask: 'hourly-brief',
          webMode: 'off',
          workspaceId,
          allowedToolIds: [],
          timeoutMs,
          signal,
          usageStage: 'x-focus',
          taskInstruction: instruction,
          message,
        });
      }
      return directGemini({
        env, model, keyEnv, instruction, message, timeoutMs, fetchImpl: http, signal,
      });
    };
    return attempt();
  }

  async function scoreOne(card, scoreUntil, signal) {
    const cached = readCache(card.id);
    if (cached) return cached;
    const timeoutMs = scoreUntil - now();
    if (signal?.aborted || timeoutMs < SCORE_FLOOR_MS) return keywordFocus(card.text, config);
    try {
      const result = await callModel(xFocusInstruction(config), JSON.stringify({ text: String(card.text || '').slice(0, 4000) }), timeoutMs, signal);
      const parsed = parseFocusObject(parseLoose(answerText(result)), config);
      if (!parsed) return keywordFocus(card.text, config);
      writeCache(card.id, parsed);
      log('[worker] x-focus batch=1 fallback=1 outcome=ok');
      return parsed;
    } catch {
      return keywordFocus(card.text, config);
    }
  }

  async function scorePending(cards, scoreUntil, signal) {
    const pending = [];
    const out = new Array(cards.length);
    cards.forEach((card, index) => {
      const cached = readCache(card.id);
      if (cached) out[index] = cached;
      else pending.push(index);
    });
    const groups = [];
    for (let offset = 0; offset < pending.length; offset += config.batchSize) {
      groups.push(pending.slice(offset, offset + config.batchSize));
    }
    let fallbacksLeft = MAX_ITEM_RETRIES;
    let stop = false;
    const keywordGroup = (indexes) => {
      for (const index of indexes) out[index] = keywordFocus(cards[index].text, config);
    };
    async function runGroup(indexes) {
      const timeoutMs = scoreUntil - now();
      if (stop || signal?.aborted || timeoutMs < SCORE_FLOOR_MS) {
        keywordGroup(indexes);
        return;
      }
      const message = JSON.stringify(indexes.map((index, idx) => ({
        idx,
        text: String(cards[index].text || '').slice(0, 1500),
      })));
      let aligned = null;
      try {
        const result = await callModel(xFocusBatchInstruction(config), message, timeoutMs, signal);
        aligned = alignFocusBatch(answerText(result), indexes.length, config);
      } catch (error) {
        if (timeoutError(error) || signal?.aborted) stop = true;
        keywordGroup(indexes);
        log(`[worker] x-focus batch=${indexes.length} outcome=keyword reason=${hardModelError(error) ? 'model' : 'error'}`);
        return;
      }
      if (!aligned) {
        for (const index of indexes) {
          if (fallbacksLeft <= 0 || stop) {
            out[index] = keywordFocus(cards[index].text, config);
            continue;
          }
          fallbacksLeft -= 1;
          out[index] = await scoreOne(cards[index], scoreUntil, signal);
        }
        return;
      }
      for (let position = 0; position < indexes.length; position += 1) {
        const parsed = aligned.get(position);
        const index = indexes[position];
        if (parsed && !parsed.invalid) {
          writeCache(cards[index].id, parsed);
          out[index] = parsed;
          continue;
        }
        if (fallbacksLeft <= 0 || stop) {
          out[index] = keywordFocus(cards[index].text, config);
          continue;
        }
        fallbacksLeft -= 1;
        out[index] = await scoreOne(cards[index], scoreUntil, signal);
      }
      log(`[worker] x-focus batch=${indexes.length} fallback=0 outcome=ok`);
    }
    async function worker() {
      while (groups.length) {
        const indexes = groups.shift();
        if (!indexes) return;
        await runGroup(indexes);
        await yieldEventLoop();
      }
    }
    const workers = Math.min(BATCH_CONCURRENCY, groups.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return out;
  }

  return Object.freeze({
    async scoreCards(cards, { deadlineAt, signal } = {}) {
      if (!config.enabled) return null;
      const list = (cards || []).filter((card) => card?.id).slice(0, 50);
      if (!list.length) return { minScore: config.expandMin, maxExpand: config.maxExpand, byId: {} };
      const scoreUntil = scoreDeadline(deadlineAt);
      const byId = {};
      const applyKeyword = () => {
        for (const card of list) {
          if (!byId[card.id]) byId[card.id] = keywordFocus(card.text, config);
        }
      };
      if (signal?.aborted || scoreUntil - now() < SCORE_FLOOR_MS) {
        applyKeyword();
        log('[worker] x-focus outcome=keyword reason=budget');
        return { minScore: config.expandMin, maxExpand: config.maxExpand, byId };
      }
      try {
        const scores = await scorePending(list, scoreUntil, signal);
        list.forEach((card, index) => { byId[card.id] = scores[index] || keywordFocus(card.text, config); });
      } catch {
        applyKeyword();
        log('[worker] x-focus outcome=keyword reason=error');
      }
      return { minScore: config.expandMin, maxExpand: config.maxExpand, byId };
    },
  });
}

function parseLoose(value) {
  if (value && typeof value === 'object') return value;
  const source = String(value || '').trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const textValue = fenced ? fenced[1].trim() : source;
  try { return JSON.parse(textValue); } catch { /* slice */ }
  const start = textValue.indexOf('{');
  const end = textValue.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(textValue.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

export function createAnalysisFocusCache(reportRepository) {
  return {
    read(workspaceId, tweetId, version) {
      const row = reportRepository?.getAnalysisStage?.(workspaceId, CACHE_DATE, `tweet:${tweetId}`, version);
      return row?.status === 'completed' ? row.output : null;
    },
    write(workspaceId, tweetId, version, output) {
      reportRepository?.saveAnalysisStage?.(workspaceId, CACHE_DATE, `tweet:${tweetId}`, version, { tweetId }, output, 'completed');
    },
  };
}
