import { googleFetch } from '../../connectors/src/google-fetch.js';
import { resolveGoogleHourlyAdmissionModels } from '../../harness/src/llm-route.js';
import {
  alignFocusBatch,
  keywordFocus,
  parseFocusObject,
  xFocusBatchInstruction,
  xFocusInstruction,
} from './x-focus.js';

const CACHE_DATE = 'x-focus';

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

function answerText(result) {
  return result?.answer || result?.text || result?.output || '';
}

async function directGemini({ env, model, keyEnv, instruction, message, timeoutMs, fetchImpl }) {
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
    signal: AbortSignal.timeout(timeoutMs),
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
      reason: value.reason,
    });
  }

  async function callModel(instruction, message, timeoutMs) {
    const attempt = async (keyEnv, model) => {
      if (complete) return complete({ instruction, message, timeoutMs, keyEnv, model });
      if (googleHourly && agentRuntime?.run) {
        return agentRuntime.run({
          closedContext: true,
          closedTask: 'hourly-brief',
          webMode: 'off',
          workspaceId,
          allowedToolIds: [],
          timeoutMs,
          usageStage: 'x-focus',
          taskInstruction: instruction,
          message,
          ...(keyEnv ? { googleKeyEnv: keyEnv } : {}),
          ...(model ? { googleModel: model } : {}),
        });
      }
      return directGemini({
        env, model: model || models[0] || 'gemini-3.1-flash-lite', keyEnv, instruction, message, timeoutMs, fetchImpl: http,
      });
    };
    const pairs = [];
    const keyList = keyEnvs.length ? keyEnvs : [''];
    const modelList = models.length ? models : ['gemini-3.1-flash-lite'];
    for (let step = 0; step < keyList.length; step += 1) {
      const keyEnv = keyList[(keyCursor + step) % keyList.length];
      for (const model of modelList) pairs.push([keyEnv, model]);
    }
    let lastError = null;
    let nonQuota = 0;
    for (const [keyEnv, model] of pairs) {
      try {
        const result = await attempt(keyEnv, model);
        keyCursor = (keyList.indexOf(keyEnv) + 1) % keyList.length;
        return result;
      } catch (error) {
        lastError = error;
        if (timeoutError(error)) throw error;
        if (quotaError(error)) continue;
        nonQuota += 1;
        if (nonQuota >= 2) break;
      }
    }
    throw lastError || new Error('x-focus 没有可用模型');
  }

  async function scoreOne(card, timeoutMs, fallback) {
    const cached = readCache(card.id);
    if (cached) return cached;
    try {
      const result = await callModel(xFocusInstruction(config), JSON.stringify({ text: String(card.text || '').slice(0, 4000) }), timeoutMs);
      const parsed = parseFocusObject(parseLoose(answerText(result)), config);
      if (!parsed) return keywordFocus(card.text, config);
      writeCache(card.id, parsed);
      log(`[worker] x-focus batch=1 fallback=${fallback ? 1 : 0} outcome=ok`);
      return parsed;
    } catch (error) {
      if (timeoutError(error)) throw error;
      return keywordFocus(card.text, config);
    }
  }

  async function scoreBatch(cards, timeoutMs) {
    const pending = [];
    const out = new Array(cards.length);
    cards.forEach((card, index) => {
      const cached = readCache(card.id);
      if (cached) out[index] = cached;
      else pending.push(index);
    });
    for (let offset = 0; offset < pending.length; offset += config.batchSize) {
      const indexes = pending.slice(offset, offset + config.batchSize);
      const message = JSON.stringify(indexes.map((index, idx) => ({
        idx,
        text: String(cards[index].text || '').slice(0, 1500),
      })));
      let aligned = null;
      try {
        const result = await callModel(xFocusBatchInstruction(config), message, timeoutMs);
        aligned = alignFocusBatch(answerText(result), indexes.length, config);
      } catch (error) {
        if (timeoutError(error)) throw error;
        aligned = null;
      }
      if (!aligned) {
        for (const index of indexes) out[index] = await scoreOne(cards[index], timeoutMs, true);
        continue;
      }
      for (let position = 0; position < indexes.length; position += 1) {
        const parsed = aligned.get(position);
        if (!parsed || parsed.invalid) out[indexes[position]] = await scoreOne(cards[indexes[position]], timeoutMs, true);
        else {
          writeCache(cards[indexes[position]].id, parsed);
          out[indexes[position]] = parsed;
        }
      }
      log(`[worker] x-focus batch=${indexes.length} fallback=0 outcome=ok`);
    }
    return out;
  }

  return Object.freeze({
    async scoreCards(cards, { deadlineAt, signal } = {}) {
      if (!config.enabled) return null;
      const list = (cards || []).filter((card) => card?.id).slice(0, 50);
      if (!list.length) return { minScore: config.expandMin, maxExpand: config.maxExpand, byId: {} };
      const remaining = Number.isFinite(Number(deadlineAt)) ? Number(deadlineAt) - now() : config.scoreTimeoutMs;
      const budget = Math.min(config.scoreTimeoutMs, Math.max(0, remaining));
      const byId = {};
      const applyKeyword = () => {
        for (const card of list) {
          if (!byId[card.id]) byId[card.id] = keywordFocus(card.text, config);
        }
      };
      if (signal?.aborted || budget < 3_000) {
        applyKeyword();
        log('[worker] x-focus outcome=keyword reason=budget');
        return { minScore: config.expandMin, maxExpand: config.maxExpand, byId };
      }
      try {
        const scores = await scoreBatch(list, budget);
        list.forEach((card, index) => { byId[card.id] = scores[index] || keywordFocus(card.text, config); });
      } catch (error) {
        applyKeyword();
        log(`[worker] x-focus outcome=keyword reason=${timeoutError(error) ? 'timeout' : 'error'}`);
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
