export const POLYMARKET_OUTCOME_MODEL = 'gemma-4-26b-a4b-it';

export const POLYMARKET_OUTCOME_GLOSSARY = [
  'Yes=是',
  'No=否',
  'No change=不变',
  'N bps increase=上升 N 个基点',
  'N bps decrease=下降 N 个基点',
  'N+ bps increase=上升 N 个基点以上',
  'N+ bps decrease=下降 N 个基点以上',
  'Above X%=高于 X%',
  'Below X%=低于 X%',
  'A%-B%=A%–B%',
  'Month D=M月D日',
  'Month D, YYYY=YYYY年M月D日',
  'by Month D=M月D日前',
].join('\n');

const MONTHS = new Map([
  ['january', 1], ['february', 2], ['march', 3], ['april', 4], ['may', 5], ['june', 6],
  ['july', 7], ['august', 8], ['september', 9], ['october', 10], ['november', 11], ['december', 12],
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['jun', 6], ['jul', 7], ['aug', 8],
  ['sep', 9], ['sept', 9], ['oct', 10], ['nov', 11], ['dec', 12],
]);

function clean(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function trimNum(value) {
  const number = String(value || '').replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(number)) return number;
  return number.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function bpsPhrase(amount, word, atLeast) {
  const direction = /^increase$/i.test(word) ? '上升' : '下降';
  return `${direction} ${trimNum(amount)} 个基点${atLeast ? '以上' : ''}`;
}

function monthNumber(name) {
  return MONTHS.get(String(name || '').toLowerCase()) || 0;
}

function formatDate(month, day, year) {
  const m = monthNumber(month);
  const d = Number(day);
  if (!m || !Number.isInteger(d) || d < 1 || d > 31) return '';
  if (year) return `${year}年${m}月${d}日`;
  return `${m}月${d}日`;
}

function zhAmount(raw, suffix) {
  const number = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(number)) return '';
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[String(suffix || '').toLowerCase()] || 1;
  const value = number * scale;
  if (value >= 1e8 && value % 1e8 === 0) return `${value / 1e8}亿`;
  if (value >= 1e4 && value % 1e4 === 0) return `${value / 1e4}万`;
  return '';
}

function ruleTranslate(source) {
  if (/^yes$/i.test(source)) return '是';
  if (/^no$/i.test(source)) return '否';
  if (/^no change$/i.test(source)) return '不变';

  let match = source.match(/^(\d+(?:\.\d+)?)\s*\+\s*bps\s+(increase|decrease)$/i);
  if (match) return bpsPhrase(match[1], match[2], true);
  match = source.match(/^(\d+(?:\.\d+)?)\s*bps\s+(increase|decrease)$/i);
  if (match) return bpsPhrase(match[1], match[2], false);

  match = source.match(/^(?:above|over)\s+(-?\d+(?:\.\d+)?)\s*%$/i);
  if (match) return `高于 ${trimNum(match[1])}%`;
  match = source.match(/^(?:below|under)\s+(-?\d+(?:\.\d+)?)\s*%$/i);
  if (match) return `低于 ${trimNum(match[1])}%`;

  match = source.match(/^between\s+(-?\d+(?:\.\d+)?)\s*%?\s+and\s+(-?\d+(?:\.\d+)?)\s*%$/i);
  if (match) return `${trimNum(match[1])}%–${trimNum(match[2])}%`;
  match = source.match(/^(-?\d+(?:\.\d+)?)\s*%?\s*(?:-|–|—|to)\s*(-?\d+(?:\.\d+)?)\s*%$/i);
  if (match) return `${trimNum(match[1])}%–${trimNum(match[2])}%`;

  match = source.match(/^(?:by|before)\s+([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/i);
  if (match) {
    const date = formatDate(match[1], match[2], match[3]);
    if (date) return `${date}前`;
  }
  match = source.match(/^(?:on\s+)?([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/i);
  if (match) {
    const date = formatDate(match[1], match[2], match[3]);
    if (date) return date;
  }
  match = source.match(/^end of\s+([A-Za-z]+)(?:\s+(\d{4}))?$/i);
  if (match && monthNumber(match[1])) {
    const year = match[2] ? `${match[2]}年` : '';
    return `${year}${monthNumber(match[1])}月底`;
  }

  match = source.match(/^\$?([\d,]+(?:\.\d+)?)([kmb])?\s*(?:-|–|—|to)\s*\$?([\d,]+(?:\.\d+)?)([kmb])?$/i);
  if (match) {
    const left = zhAmount(match[1], match[2]);
    const right = zhAmount(match[3], match[4]);
    if (left && right) return `${left}–${right}`;
  }
  return '';
}

export function translatePolymarketOutcome(label) {
  const source = clean(label);
  if (!source) return { text: '', covered: false, source: '' };
  const text = ruleTranslate(source);
  if (text) return { text, covered: true, source };
  return { text: source, covered: false, source };
}

export function polymarketOutcomeText(label) {
  const ruled = translatePolymarketOutcome(label);
  return ruled.covered ? ruled.text : ruled.source;
}

export async function translateUncoveredPolymarketOutcomes(labels, translateMany) {
  const result = new Map();
  const pending = [];
  const seen = new Set();
  for (const label of labels || []) {
    const source = clean(label);
    if (!source || seen.has(source)) continue;
    seen.add(source);
    const ruled = translatePolymarketOutcome(source);
    if (ruled.covered) {
      result.set(source, ruled.text);
      continue;
    }
    if (!/[A-Za-z]/.test(source)) {
      result.set(source, source);
      continue;
    }
    pending.push(source);
  }
  if (!pending.length || typeof translateMany !== 'function') return result;
  const response = await translateMany({
    items: pending.map((text, index) => ({ id: String(index + 1), text })),
    targetLang: 'zh',
    glossary: POLYMARKET_OUTCOME_GLOSSARY,
    model: POLYMARKET_OUTCOME_MODEL,
  });
  for (const row of response?.translations || []) {
    const source = pending[Number(row?.id) - 1];
    const text = String(row?.translatedText || '').trim();
    if (source && text) result.set(source, text);
  }
  return result;
}
