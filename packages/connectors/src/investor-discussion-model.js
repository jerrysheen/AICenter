import { createUsageFetch } from './model-usage-fetch.js';
import { parseGeminiGenerateContent } from './gemini-grok-task.js';

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

export function createGeminiInvestorSummarizer(options = {}) {
  const env = options.env || process.env;
  const model = text(options.model) || investorDiscussionModelId(env);
  const apiKey = options.apiKey !== undefined
    ? text(options.apiKey)
    : envText(env, 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AI_CENTER_GEMINI_API_KEY');
  const apiRoot = (text(options.apiRoot) || envText(env, 'AI_CENTER_GEMINI_API_ROOT') || DEFAULT_ROOT).replace(/\/$/, '');
  const fetchImpl = createUsageFetch(options.fetch || fetch, {
    provider: 'gemini',
    model,
    observer: options.usageObserver,
    stage: options.usageStage || 'investor-discussion',
  });
  const timeoutMs = options.timeoutMs ?? 90_000;

  return async function summarize({ system, prompt }) {
    if (!apiKey) throw new Error('未配置 GEMINI_API_KEY');
    const response = await fetchImpl(`${apiRoot}/models/${encodeURIComponent(model)}:generateContent`, {
      usageModel: model,
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
      throw new Error(`Gemini 请求失败（${response.status}${detail ? `: ${detail}` : ''}）`);
    }
    const reply = parseGeminiGenerateContent(payload);
    if (!reply) throw new Error('Gemini 没有返回结果');
    return { text: reply, model };
  };
}
