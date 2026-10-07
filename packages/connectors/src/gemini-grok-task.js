import { createHash } from 'node:crypto';
import { createElucidGrokAgentClient } from './elucid-grok-agent.js';
import { createUsageFetch } from './model-usage-fetch.js';

// Translation and tagging share quota knowledge in each Web/Worker process.
const sharedQuotaState = new Map();
const text = value => typeof value === 'string' ? value.trim() : '';
const envText = (...keys) => keys.map(key => text(process.env[key])).find(Boolean) || '';

export function parseGeminiGenerateContent(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map(part => text(part?.text)).join('').trim() : '';
}

export function nextGeminiDailyReset(at) {
  const formatter = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'});
  const today = formatter.format(at);
  let low = at, high = at + 27 * 3600000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (formatter.format(middle) === today) low = middle; else high = middle;
  }
  return high;
}

export function geminiQuotaCooldown(response, payload, at) {
  const error = payload?.error;
  if (response.status !== 429 && error?.status !== 'RESOURCE_EXHAUSTED' && error?.code !== 429) return null;
  const details = Array.isArray(error?.details) ? error.details : [];
  const violations = details.flatMap(detail => detail.violations || []);
  const evidence = [error?.message, ...violations.flatMap(v => [v.quotaId, v.quotaMetric, v.description])].filter(Boolean).join(' ');
  // A daily quota can also carry a short RetryInfo; the daily reset takes precedence.
  if (/per[_\s-]?day|daily/i.test(evidence)) return {reason:'daily_quota',blockedUntil:nextGeminiDailyReset(at)};
  const retryHeader = response.headers?.get?.('retry-after');
  const headerMs = retryHeader ? Number.isFinite(Number(retryHeader)) ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - at : 0;
  const infoMs = details.map(d => {
    const delay = d.retryDelay;
    if (typeof delay === 'string' && /^\d+(?:\.\d+)?s$/.test(delay)) return parseFloat(delay) * 1000;
    if (delay && typeof delay === 'object') return Number(delay.seconds || 0) * 1000 + Number(delay.nanos || 0) / 1e6;
    return 0;
  }).filter(Number.isFinite);
  const wait = Math.max(1000, Number.isFinite(headerMs) ? headerMs : 0, ...infoMs);
  return {reason:'rate_limit',blockedUntil:at + (wait === 1000 ? 60000 : Math.min(wait, 24 * 3600000))};
}

export function createGeminiGrokTaskRouter(options = {}) {
  const fetchImpl = createUsageFetch(options.fetch || fetch, { provider: 'gemini', model: options.geminiModel || envText('AI_CENTER_GEMINI_MODEL') || 'gemini-3.1-flash-lite', observer: options.usageObserver, stage: options.usageStage || 'feed-enrichment' });
  const apiKey = options.geminiApiKey !== undefined ? text(options.geminiApiKey) : envText('GEMINI_API_KEY','GOOGLE_API_KEY','AI_CENTER_GEMINI_API_KEY');
  const apiRoot = (text(options.geminiApiRoot) || envText('AI_CENTER_GEMINI_API_ROOT') || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const model = text(options.geminiModel) || envText('AI_CENTER_GEMINI_MODEL') || 'gemini-3.1-flash-lite';
  const elucidApiKey = options.elucidApiKey !== undefined ? text(options.elucidApiKey) : envText('ELUCID_GROK_API_KEY','AI_CENTER_GROK_API_KEY');
  const timeoutMs = options.timeoutMs ?? 90000;
  const now = options.now || Date.now;
  const quotas = options.quotaState || sharedQuotaState;
  const quotaKey = createHash('sha256').update(`${apiRoot}\n${model}\n${apiKey}`).digest('hex');
  const grok = createElucidGrokAgentClient({
    usageObserver: options.usageObserver, usageStage: options.usageStage || 'feed-enrichment',
    apiKey:elucidApiKey,apiRoot:options.elucidApiRoot,
    model:text(options.elucidModel) || envText('AI_CENTER_FEED_GROK_MODEL','AI_CENTER_ELUCID_GROK_MODEL') || 'grok-4.7',timeoutMs,
    ...(options.fetch ? {fetch:options.fetch} : {}),
  });

  async function generate({system, prompt}) {
    const cooling = quotas.get(quotaKey)?.blockedUntil > now();
    if (apiKey && !cooling) {
      const response = await fetchImpl(`${apiRoot}/models/${encodeURIComponent(model)}:generateContent`, {
        method:'POST',headers:{'x-goog-api-key':apiKey,'Content-Type':'application/json'},signal:AbortSignal.timeout(timeoutMs),
        body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:prompt}]}]}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) {
        const quota = geminiQuotaCooldown(response,payload,now());
        if (!quota) throw new Error(`Gemini 请求失败（${response.status}）`);
        const previous = quotas.get(quotaKey);
        if (!previous || quota.blockedUntil > previous.blockedUntil) quotas.set(quotaKey,quota);
      } else {
        const reply = parseGeminiGenerateContent(payload);
        if (!reply) throw new Error('Gemini 没有返回结果');
        // An older concurrent success must not clear a newer quota failure.
        return {text:reply,engine:'gemini'};
      }
    }
    if (!elucidApiKey) throw new Error(apiKey ? 'Gemini 配额受限，未配置 ELUCID_GROK_API_KEY，无法回退' : '未配置 GEMINI_API_KEY 或 ELUCID_GROK_API_KEY');
    const result = await grok.respond({systemInstruction:system,contents:[{role:'user',parts:[{text:prompt}]}],tools:[],signal:AbortSignal.timeout(timeoutMs)});
    if (!text(result.text) || result.toolCalls?.length) throw new Error('Elucid Grok 没有返回有效任务结果');
    return {text:result.text,engine:'elucid-grok'};
  }
  return Object.freeze({generate});
}
