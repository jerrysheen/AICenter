import { parseGeminiGenerateContent } from './gemini-grok-task.js';
import { readGemmaStream, resolveGemmaTranslationSlots } from './translate/gemma.js';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 120_000;
const LABEL_OUTPUT_TOKENS = 16384;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function investorAbModelId(env = process.env) {
  return text(env.AI_CENTER_INVESTOR_DIGEST_AB_MODEL)
    || text(env.AI_CENTER_INVESTOR_DIGEST_MODEL)
    || DEFAULT_MODEL;
}

export function isGemmaModel(model) {
  return /^gemma-/i.test(String(model || '').trim());
}

export function resolveInvestorAbApiKey(env, model) {
  const named = text(env.AI_CENTER_INVESTOR_DIGEST_AB_KEY_ENV);
  if (named) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(named)) throw new Error('AI_CENTER_INVESTOR_DIGEST_AB_KEY_ENV 无效');
    const apiKey = text(env[named]);
    if (!apiKey) throw new Error(`未配置 ${named}`);
    return { apiKey, keyEnv: named };
  }
  if (isGemmaModel(model)) {
    const slots = resolveGemmaTranslationSlots(env);
    if (!slots.length) throw new Error('未配置 Gemma 密钥');
    return { apiKey: text(env[slots[0].keyEnv]), keyEnv: slots[0].keyEnv };
  }
  const keyEnv = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AI_CENTER_GEMINI_API_KEY'].find((name) => text(env[name]));
  if (!keyEnv) throw new Error('未配置 GEMINI_API_KEY');
  return { apiKey: text(env[keyEnv]), keyEnv };
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Gemini often omits cachedContentTokenCount. The shared ledger helper then drops
// promptTokenCount, which made this experiment record 0 input tokens.
export function investorAbUsage(payload) {
  const usage = payload?.usageMetadata || {};
  const inputTokens = integer(usage.promptTokenCount);
  const outputTokens = integer(usage.candidatesTokenCount);
  const totalTokens = integer(usage.totalTokenCount) ?? (
    inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null
  );
  return { inputTokens, outputTokens, totalTokens };
}

export function createInvestorAbModel(options = {}) {
  const env = options.env || process.env;
  const model = text(options.model) || investorAbModelId(env);
  const gemma = isGemmaModel(model);
  const { apiKey } = options.apiKey !== undefined
    ? { apiKey: text(options.apiKey) }
    : resolveInvestorAbApiKey(env, model);
  const apiRoot = (text(options.apiRoot) || text(env.AI_CENTER_GEMINI_API_ROOT) || DEFAULT_ROOT).replace(/\/$/, '');
  const fetchImpl = options.fetch || fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!apiKey) throw new Error('未配置模型密钥');

  return {
    model,
    gemma,
    async complete({ system, prompt }) {
      const url = gemma
        ? `${apiRoot}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
        : `${apiRoot}/models/${encodeURIComponent(model)}:generateContent`;
      const body = gemma
        ? {
          contents: [{ role: 'user', parts: [{ text: `${system}\n\n${prompt}` }] }],
          generationConfig: {
            maxOutputTokens: LABEL_OUTPUT_TOKENS,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingLevel: 'minimal' },
          },
        }
        : {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: LABEL_OUTPUT_TOKENS, responseMimeType: 'application/json' },
        };
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(body),
      });
      if (gemma) {
        if (!response.ok) {
          const error = new Error(`Gemma 请求失败（${response.status}）`);
          error.code = 'transport';
          throw error;
        }
        const payload = await readGemmaStream(response);
        const candidate = payload.candidates?.[0];
        const reply = candidate?.content?.parts?.map((part) => part.text || '').join('').trim();
        const finishReason = candidate?.finishReason || '';
        if (finishReason === 'MAX_TOKENS') {
          if (!reply) {
            const error = new Error('输出被截断');
            error.code = 'truncated';
            throw error;
          }
          return { text: reply, model, usage: investorAbUsage(payload), finishReason, truncated: true };
        }
        if (finishReason !== 'STOP' || !reply) throw new Error('Gemma 打标签未完整结束');
        return { text: reply, model, usage: investorAbUsage(payload), finishReason, truncated: false };
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) {
        const error = new Error(`Gemini 请求失败（${response.status}）`);
        error.code = 'transport';
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
    },
  };
}
