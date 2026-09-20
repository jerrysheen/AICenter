import { parseGeminiGenerateContent } from './translate/index.js';

const DEFAULT_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const OUTPUT_HINT = `只返回 JSON 对象，不要解释。格式固定为：
{"items":[{"item_id":"原始id","tags":["catalog里的tag_id"]}]}`;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function envText(...keys) {
  for (const key of keys) {
    const value = text(process.env[key]);
    if (value) return value;
  }
  return '';
}

export function createGeminiTagPort(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const apiKey = options.apiKey !== undefined
    ? text(options.apiKey)
    : envText('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AI_CENTER_GEMINI_API_KEY');
  const apiRoot = (text(options.apiRoot) || envText('AI_CENTER_GEMINI_API_ROOT') || DEFAULT_ROOT).replace(/\/$/, '');
  const model = text(options.model) || envText('AI_CENTER_GEMINI_MODEL') || DEFAULT_MODEL;

  return Object.freeze({
    async tagBatch(input = {}) {
      if (!apiKey) throw new Error('未配置 GEMINI_API_KEY，无法标注');
      const system = [text(input.systemPrompt), OUTPUT_HINT].filter(Boolean).join('\n\n');
      const response = await fetchImpl(`${apiRoot}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{
            role: 'user',
            parts: [{ text: JSON.stringify(input.userPayload || {}) }],
          }],
        }),
      });
      if (!response.ok) {
        let detail = '';
        try {
          const errorPayload = await response.json();
          detail = text(errorPayload?.error?.message || errorPayload?.message);
        } catch {
          detail = '';
        }
        throw new Error(`Gemini 标注失败（${response.status}${detail ? `: ${detail}` : ''}）`);
      }
      const reply = parseGeminiGenerateContent(await response.json());
      if (!reply) throw new Error('Gemini 没有返回标注结果');
      return { reply_text: reply, model: 'gemini' };
    },
  });
}
