import { createHash } from 'node:crypto';
import { parseGeminiGenerateContent, geminiQuotaCooldown } from './gemini-grok-task.js';
import { googleFetch, isGoogleConnectTimeout } from './google-fetch.js';
import { investorAbUsage } from './investor-digest-ab-model.js';
import { investorDiscussionModelId } from './investor-discussion-model.js';
import { createUsageFetch } from './model-usage-fetch.js';

const DEFAULT_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 120_000;
const LABEL_OUTPUT_TOKENS = 16384;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveInvestorGeminiSlots(env = process.env) {
  const names = String(env.AI_CENTER_GEMINI_KEY_ENVS || 'GEMINI_API_KEY,GEMINI_API_KEY2,GEMINI_API_KEY3,GEMINI_API_KEY4,GEMINI_API_KEY5')
    .split(',').map((item) => item.trim()).filter(Boolean);
  if (names.length > 5 || names.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    const error = new Error('Gemini 密钥变量名无效');
    error.code = 'config';
    throw error;
  }
  const seen = new Set();
  const slots = [];
  for (const keyEnv of names) {
    const apiKey = text(env[keyEnv]);
    if (!apiKey || seen.has(apiKey)) continue;
    seen.add(apiKey);
    const configured = text(env[`${keyEnv}_PROJECT`]);
    const keyIdentity = createHash('sha256').update(`gemini-key:${apiKey}`).digest('hex');
    const project = configured ? createHash('sha256').update(configured).digest('hex') : keyIdentity;
    slots.push({ keyEnv, project, cooldownKey: configured ? project : keyIdentity });
  }
  return slots;
}

function cooling(memory, keyEnv, at) {
  return (memory.get(keyEnv) || 0) > at;
}

export function createInvestorJevCompleter(options = {}) {
  const env = options.env || process.env;
  const model = text(options.model) || investorDiscussionModelId(env);
  const slots = options.slots || resolveInvestorGeminiSlots(env);
  const repository = options.quotaRepository || null;
  const apiRoot = (text(options.apiRoot) || text(env.AI_CENTER_GEMINI_API_ROOT) || DEFAULT_ROOT).replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now || Date.now;
  const dayWindow = options.dayWindow || ((at) => ({ dayStart: at - 86_400_000, dayEnd: at }));
  const memory = options.quotaState || new Map();
  const fetchImpl = createUsageFetch(googleFetch(options.fetch || fetch, env), {
    provider: 'gemini',
    model,
    observer: options.usageObserver,
    stage: options.usageStage || 'investor-discussion-jev',
  });
  if (!slots.length) {
    const error = new Error('未配置 GEMINI_API_KEY');
    error.code = 'config';
    throw error;
  }

  function release(ticket) {
    if (ticket?.id && repository?.release) repository.release(ticket);
  }

  function remember(ticket, quota) {
    if (!quota?.blockedUntil) return;
    const previous = memory.get(ticket.keyEnv) || 0;
    if (quota.blockedUntil > previous) memory.set(ticket.keyEnv, quota.blockedUntil);
    const key = ticket.cooldownKey || ticket.project;
    if (!repository) return;
    if (quota.reason === 'daily_quota' && repository.setCooldown) repository.setCooldown(key, model, quota.blockedUntil);
    else repository.cooldown?.(key, model, quota.blockedUntil);
  }

  async function pick(skipped) {
    const at = now();
    const available = slots.filter((slot) => !skipped.has(slot.keyEnv) && !cooling(memory, slot.keyEnv, at));
    if (!available.length) return null;
    if (!repository?.reserve) return { ...available[0], id: '' };
    const window = dayWindow(at);
    const result = repository.reserve({
      slots: available,
      model,
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

  async function call(ticket, system, prompt) {
    const apiKey = text(env[ticket.keyEnv]);
    if (!apiKey) {
      const error = new Error('未配置 GEMINI_API_KEY');
      error.code = 'config';
      throw error;
    }
    const response = await fetchImpl(`${apiRoot}/models/${encodeURIComponent(model)}:generateContent`, {
      usageModel: model,
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: LABEL_OUTPUT_TOKENS,
          responseMimeType: 'application/json',
        },
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      const quota = geminiQuotaCooldown(response, payload, now());
      const error = new Error(`Gemini 请求失败（${response.status}）`);
      error.code = 'transport';
      error.status = response.status;
      error.quota = quota;
      throw error;
    }
    const reply = parseGeminiGenerateContent(payload);
    const finishReason = payload?.candidates?.[0]?.finishReason || '';
    if (!reply && finishReason === 'MAX_TOKENS') {
      const error = new Error('输出被截断');
      error.code = 'truncated';
      throw error;
    }
    if (!reply) throw new Error('Gemini 没有返回结果');
    return {
      text: reply,
      model,
      usage: investorAbUsage(payload),
      finishReason,
      truncated: finishReason === 'MAX_TOKENS',
    };
  }

  return {
    model,
    async complete({ system, prompt }) {
      let lastError = null;
      const skipped = new Set();
      for (let index = 0; index < slots.length; index += 1) {
        const ticket = await pick(skipped);
        if (!ticket) break;
        try {
          const result = await call(ticket, system, prompt);
          release(ticket);
          return result;
        } catch (error) {
          release(ticket);
          if (error?.code === 'config') throw error;
          if (error?.quota || error?.status === 429 || isGoogleConnectTimeout(error)) {
            remember(ticket, error.quota || { reason: 'rate_limit', blockedUntil: now() + 60_000 });
            skipped.add(ticket.keyEnv);
            lastError = error;
            continue;
          }
          throw error;
        }
      }
      const error = lastError || new Error('Gemini 配额受限');
      error.code = error.code || 'transport';
      throw error;
    },
  };
}
