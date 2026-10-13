import { createUsageFetch } from './model-usage-fetch.js';
import { googleFetch, isGoogleConnectTimeout } from './google-fetch.js';
import { geminiQuotaCooldown, parseGeminiGenerateContent } from './gemini-grok-task.js';
import { resolveInvestorGeminiSlots } from './investor-jev-model.js';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function envText(env, ...keys) {
  for (const key of keys) {
    const value = text(env[key]);
    if (value) return value;
  }
  return '';
}

export function investorDiscussionModelId(env = process.env) {
  return text(env.AI_CENTER_INVESTOR_DIGEST_MODEL) || text(env.AI_CENTER_GEMINI_MODEL) || DEFAULT_MODEL;
}

export function investorSummaryModelList(env = process.env, primary = '') {
  const extras = String(env.AI_CENTER_INVESTOR_DIGEST_SUMMARY_MODELS || '').split(',').map((item) => item.trim()).filter(Boolean);
  const models = [];
  for (const id of [text(primary) || investorDiscussionModelId(env), ...extras]) {
    if (id && !models.includes(id)) models.push(id);
  }
  return models;
}

function summaryRetryCount(env) {
  const raw = env.AI_CENTER_INVESTOR_DIGEST_SUMMARY_RETRIES;
  if (raw === undefined || String(raw).trim() === '') return 3;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 6) return 3;
  return value;
}

function summaryRetryDelayMs(attempt) {
  return Math.min(8000, 1000 * (2 ** Math.max(0, attempt)));
}

function retryableSummaryStatus(error) {
  return error?.status === 500 || error?.status === 503 || error?.status === 429 || Boolean(error?.quota) || isGoogleConnectTimeout(error);
}

export function createGeminiInvestorSummarizer(options = {}) {
  const env = options.env || process.env;
  const primary = text(options.model) || investorDiscussionModelId(env);
  const models = options.models || investorSummaryModelList(env, primary);
  const explicitKey = options.apiKey !== undefined ? text(options.apiKey) : '';
  const slots = options.apiKey !== undefined
    ? (explicitKey ? [{ keyEnv: 'GEMINI_API_KEY', project: 'explicit', cooldownKey: 'explicit', apiKey: explicitKey }] : [])
    : (options.slots || resolveInvestorGeminiSlots(env));
  const repository = options.quotaRepository || null;
  const apiRoot = (text(options.apiRoot) || envText(env, 'AI_CENTER_GEMINI_API_ROOT') || DEFAULT_ROOT).replace(/\/$/, '');
  const fetchImpl = createUsageFetch(googleFetch(options.fetch || fetch, env), {
    provider: 'gemini',
    model: primary,
    observer: options.usageObserver,
    stage: options.usageStage || 'investor-discussion',
  });
  const timeoutMs = options.timeoutMs ?? 90_000;
  const retries = options.retries ?? summaryRetryCount(env);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const now = options.now || Date.now;
  const dayWindow = options.dayWindow || ((at) => ({ dayStart: at - 86_400_000, dayEnd: at }));
  const memory = options.quotaState || new Map();

  function cooling(keyEnv, modelId, at) {
    return (memory.get(`${keyEnv}\0${modelId}`) || 0) > at;
  }

  function release(ticket) {
    if (ticket?.id && repository?.release) repository.release(ticket);
  }

  function remember(ticket, modelId, quota) {
    if (!quota?.blockedUntil) return;
    const stamp = `${ticket.keyEnv}\0${modelId}`;
    const previous = memory.get(stamp) || 0;
    if (quota.blockedUntil > previous) memory.set(stamp, quota.blockedUntil);
    const key = ticket.cooldownKey || ticket.project;
    if (!repository) return;
    if (quota.reason === 'daily_quota' && repository.setCooldown) repository.setCooldown(key, modelId, quota.blockedUntil);
    else repository.cooldown?.(key, modelId, quota.blockedUntil);
  }

  async function pick(modelId, skipped) {
    const at = now();
    const available = slots.filter((slot) => !skipped.has(slot.keyEnv) && !cooling(slot.keyEnv, modelId, at));
    if (!available.length) return null;
    if (!repository?.reserve) return { ...available[0], id: '' };
    const window = dayWindow(at);
    const result = repository.reserve({
      slots: available,
      model: modelId,
      at,
      accountMode: true,
      balance: 'least-used',
      requestsPerHour: Number.POSITIVE_INFINITY,
      requestsPerMinute: 60,
      requestsPerDay: Number.POSITIVE_INFINITY,
      requestsPerKeyPerDay: Number.POSITIVE_INFINITY,
      minIntervalMs: 0,
      estimatedTokensPerMinute: 1_000_000,
      estimatedTokens: 4096,
      idleAfterMs: 0,
      dayStart: window.dayStart,
      dayEnd: window.dayEnd,
    });
    if (!result?.admitted) return null;
    return result;
  }

  async function call(ticket, modelId, system, prompt) {
    const apiKey = ticket.apiKey || text(env[ticket.keyEnv]);
    if (!apiKey) {
      const error = new Error('未配置 GEMINI_API_KEY');
      error.code = 'config';
      throw error;
    }
    const response = await fetchImpl(`${apiRoot}/models/${encodeURIComponent(modelId)}:generateContent`, {
      usageModel: modelId,
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      const detail = text(payload?.error?.message);
      const error = new Error(`Gemini 请求失败（${response.status}${detail ? `: ${detail}` : ''}）`);
      error.status = response.status;
      error.quota = geminiQuotaCooldown(response, payload, now());
      throw error;
    }
    const reply = parseGeminiGenerateContent(payload);
    if (!reply) throw new Error('Gemini 没有返回结果');
    return { text: reply, model: modelId };
  }

  return async function summarize({ system, prompt }) {
    if (!slots.length) {
      const error = new Error('未配置 GEMINI_API_KEY');
      error.code = 'config';
      throw error;
    }
    let lastError = null;
    for (const modelId of models) {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const skipped = new Set();
        let tried = false;
        while (true) {
          const ticket = await pick(modelId, skipped);
          if (!ticket) break;
          tried = true;
          try {
            const result = await call(ticket, modelId, system, prompt);
            release(ticket);
            return result;
          } catch (error) {
            release(ticket);
            if (error?.code === 'config') throw error;
            if (!retryableSummaryStatus(error)) throw error;
            lastError = error;
            if (error.quota || error.status === 429) {
              remember(ticket, modelId, error.quota || { reason: 'rate_limit', blockedUntil: now() + 60_000 });
            }
            skipped.add(ticket.keyEnv);
          }
        }
        if (!tried && !lastError) break;
        if (attempt < retries) await sleep(summaryRetryDelayMs(attempt));
      }
    }
    throw lastError || Object.assign(new Error('Gemini 请求失败'), { status: 503 });
  };
}
