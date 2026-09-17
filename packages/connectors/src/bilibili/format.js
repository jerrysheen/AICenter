import { parseGeminiGenerateContent } from '../translate/index.js';

const GEMINI_DEFAULT_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_DEFAULT_MODEL = 'gemini-3.1-flash-lite';

export const TRANSCRIPT_FORMAT_SYSTEM = `你是字幕排版器，不是编辑，不是校对，不是摘要器。

任务：把自动字幕整理成易读的简体中文 Markdown。

硬性规则：
1. 不得删减、缩写、概括、合并掉任何论点、步骤、例子、对比、结论或限定条件。
2. 不得省略概念、机制、产品名、人名、机构名、型号、版本、数字、单位、日期、专利号或定量描述。
3. 不得改写原意，不得补充视频里没有的信息，不得评价对错。
4. 专有名词、型号、缩写、口误和听写结果必须原样保留。即使看起来像识别错误（例如 P2x view、阔直板），也禁止改成你认为“正确”的产品名。
5. 禁止出现「文中注」「按逻辑修正」「原文应为」「即某某型号」这类校对句。
6. 只允许做排版：断句、分段、加 Markdown 标题/小标题、列表、加粗关键术语。可以加空格和换行，不能换词。
7. 不要写“总结”“要点如下”这类压缩段。按讲解顺序完整展开。
8. 只输出 Markdown 正文，不要前言、后记、代码围栏。`;

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

export function unwrapMarkdownFence(value) {
  return text(value).replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
}

export function looksLikeMarkdown(value) {
  const source = String(value || '');
  return /(^|\n)#{1,3}\s+\S|(^|\n)[-*]\s+\S|(^|\n)\d+\.\s+\S/.test(source);
}

export function createTranscriptFormatService(options = {}) {
  const fetchImpl = options.fetch || fetch;

  function resolveConfig() {
    const apiKey = options.apiKey !== undefined
      ? text(options.apiKey)
      : envText('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AI_CENTER_GEMINI_API_KEY');
    const apiRoot = (options.apiRoot !== undefined
      ? text(options.apiRoot)
      : envText('AI_CENTER_GEMINI_API_ROOT') || GEMINI_DEFAULT_ROOT).replace(/\/$/, '');
    const model = options.model !== undefined
      ? text(options.model)
      : envText('AI_CENTER_GEMINI_MODEL') || GEMINI_DEFAULT_MODEL;
    return { apiKey, apiRoot, model };
  }

  return {
    async formatTranscript(sourceText, meta = {}) {
      const source = text(sourceText);
      if (!source) return { text: '', engine: 'passthrough' };
      const { apiKey, apiRoot, model } = resolveConfig();
      if (!apiKey) return { text: source, engine: 'passthrough' };

      const title = text(meta.title);
      const owner = text(meta.owner);
      const header = [title && `标题：${title}`, owner && `UP：${owner}`].filter(Boolean).join('\n');
      const response = await fetchImpl(`${apiRoot}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: TRANSCRIPT_FORMAT_SYSTEM }] },
          contents: [{
            role: 'user',
            parts: [{ text: `${header ? `${header}\n\n` : ''}请整理下面的字幕原文：\n\n${source}` }],
          }],
        }),
      });
      if (!response.ok) {
        let detail = '';
        try {
          const errorPayload = await response.json();
          detail = text(errorPayload?.error?.message);
        } catch {
          detail = '';
        }
        throw new Error(`Gemini 字幕整理失败（${response.status}${detail ? `: ${detail}` : ''}）`);
      }
      const formatted = unwrapMarkdownFence(parseGeminiGenerateContent(await response.json()));
      if (!formatted) throw new Error('Gemini 没有返回整理结果');
      return { text: formatted, engine: 'gemini' };
    },
  };
}
