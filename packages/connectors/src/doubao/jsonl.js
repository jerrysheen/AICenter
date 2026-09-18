import { parseGeminiBatchTranslations } from '../translate/index.js';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function toJsonl(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => JSON.stringify(row))
    .join('\n');
}

export function parseJsonlRecords(raw) {
  const source = text(raw)
    .replace(/^```(?:jsonl|json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  if (!source) return [];
  const rows = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed);
    } catch {
      // Skip non-JSON chatter around the payload.
    }
  }
  return rows;
}

export function buildDoubaoTranslateJsonlPrompt(items, options = {}) {
  const targetLang = options.targetLang === 'en' ? 'en' : 'zh';
  const targetLabel = targetLang === 'en' ? 'English' : '简体中文';
  const payload = (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: text(item?.id),
      text: text(item?.text || item?.body),
    }))
    .filter((item) => item.id && item.text);
  const lines = toJsonl(payload);
  return [
    `你是财经信息翻译器。把下面 JSONL 每一行的 text 译成${targetLabel}，并做轻度清洗。`,
    '',
    '要求：',
    '1. 保持事实、数字、日期、金额、百分比、公司名、产品名和股票代码准确。',
    '2. 允许轻度清洗：去掉点赞/转发/导航等界面残渣、重复空白和明显无信息尾巴；不要总结，不要扩写，不要加评论。',
    '3. 已经通顺的中文保持原意，只清噪音。',
    '4. id 必须原样返回。',
    '5. 只输出 JSONL：一行一个 JSON 对象，不要 Markdown，不要解释，不要 JSON 数组。',
    '',
    '输出格式：',
    '{"id":"原始id","translated":"译文"}',
    '',
    '输入 JSONL：',
    lines,
  ].join('\n');
}

export function parseDoubaoTranslateJsonl(raw) {
  const translations = [];
  const seen = new Set();
  for (const row of parseJsonlRecords(raw)) {
    const id = text(row?.id);
    const translatedText = text(row?.translated || row?.translatedText);
    if (!id || !translatedText || seen.has(id)) continue;
    seen.add(id);
    translations.push({ id, translatedText });
  }
  if (translations.length) return translations;
  return parseGeminiBatchTranslations(raw);
}

export const DOUBAO_TRANSLATE_JSONL_SAMPLE = [
  { id: 'x:1', text: 'NVIDIA announced a capacity expansion for Blackwell GPUs in 2026.' },
  { id: 'x:2', text: 'SK하이닉스가 HBM 생산능력을 확대할 계획이라고 밝혔다.' },
  { id: 'x:3', text: 'Apple shares rose 2.4% after the company guided Q4 revenue above $94 billion.' },
];
