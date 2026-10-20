import { createHash } from 'node:crypto';

// YouTube 播客正文默认走 Gemma 26B 翻译池（官方 endpoint）。
// 标题、摘要、关键句仍只用 Gemma 26B，不走 Gemini Flash。
// 豆包提示词只在显式选择豆包引擎时使用。这里的函数不调用任何模型。

export const ARTICLE_PART_MIN = 10_000;
export const ARTICLE_PART_MAX = 12_000;
const STAMP_GAP_SEC = 45;
const OVERLAP_MIN_CHARS = 8;

const ABBREVIATION = /(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|Inc|Ltd|No|Fig|Prof|Gen|Sen|Rep|Gov|U\.S|U\.K|e\.g|i\.e)$/i;

export function transcriptHash(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function normalizeClock(value) {
  const parts = String(value || '').split(':').map((item) => item.padStart(2, '0'));
  while (parts.length < 3) parts.unshift('00');
  return parts.slice(-3).join(':');
}

function clockSeconds(value) {
  const [hour, minute, second] = normalizeClock(value).split(':').map(Number);
  return hour * 3600 + minute * 60 + second;
}

function parseCaptionLine(line) {
  const match = String(line || '').match(/^\[(\d{1,2}:\d{2}:\d{2})(?:[.,]\d+)?\]\s*(.*)$/);
  if (!match) return null;
  return {
    time: normalizeClock(match[1]),
    text: decodeEntities(match[2]).replace(/\s+/g, ' ').trim(),
  };
}

function overlapChars(previous, next) {
  const prev = String(previous || '').replace(/\s+/g, ' ').trim();
  const nxt = String(next || '').replace(/\s+/g, ' ').trim();
  if (!prev || !nxt) return 0;
  const prevLower = prev.toLowerCase();
  const words = nxt.split(' ');
  for (let count = words.length; count >= 1; count -= 1) {
    const prefix = words.slice(0, count).join(' ');
    if (prefix.length < OVERLAP_MIN_CHARS) break;
    const start = prevLower.length - prefix.length;
    if (start < 0 || prevLower.slice(start) !== prefix.toLowerCase()) continue;
    if (start > 0 && prevLower[start - 1] !== ' ') continue;
    if (prefix.length >= 12 || count >= 2) return prefix.length;
  }
  return 0;
}

export function dedupeRollingCaptions(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  const cues = [];
  for (const line of lines) {
    const parsed = parseCaptionLine(line);
    if (parsed?.text) cues.push(parsed);
  }
  if (!cues.length) return decodeEntities(raw).replace(/\s+/g, ' ').trim();
  let spoken = '';
  let lastStamp = -1;
  const blocks = [];
  let block = '';
  for (const cue of cues) {
    const overlap = overlapChars(spoken, cue.text);
    const text = (overlap ? cue.text.slice(overlap) : cue.text).trim();
    if (!text) continue;
    const stamp = lastStamp < 0
      || clockSeconds(cue.time) - lastStamp >= STAMP_GAP_SEC
      || text.includes('>>');
    if (stamp) {
      if (block) blocks.push(block.trim());
      block = `[${cue.time}] ${text}`;
      lastStamp = clockSeconds(cue.time);
    } else {
      block += ` ${text}`;
    }
    spoken = `${spoken} ${text}`.trim();
    if (spoken.length > 800) spoken = spoken.slice(-800);
  }
  if (block) blocks.push(block.trim());
  return blocks.join('\n').trim();
}

function firstClock(text) {
  const match = String(text || '').match(/\[(\d{2}:\d{2}:\d{2})\]/);
  return match ? match[1] : '';
}

function isSentenceEnd(text, index) {
  const ch = text[index];
  if (!'.?!。！？'.includes(ch)) return false;
  const before = text.slice(Math.max(0, index - 6), index);
  const after = text.slice(index + 1);
  if (ch === '.' && ABBREVIATION.test(before)) return false;
  if (ch === '.' && /\d$/.test(before) && /^\d/.test(after)) return false;
  if (ch === '.' && text.slice(index - 2, index + 1) === '...') return true;
  return after === '' || /^[\s\n]/.test(after) || /^\s*>>/.test(after);
}

function cutPositions(text) {
  const positions = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith('>>', index) && (index === 0 || /\s/.test(text[index - 1]))) {
      if (index > 0) positions.push(index);
      continue;
    }
    if (!isSentenceEnd(text, index)) continue;
    let end = index + 1;
    while (end < text.length && /\s/.test(text[end])) end += 1;
    positions.push(end);
  }
  return positions;
}

function chooseCut(text, minChars, maxChars) {
  const windowEnd = Math.min(text.length, maxChars);
  let inWindow = -1;
  let beforeMax = -1;
  for (const pos of cutPositions(text)) {
    if (pos < 1 || pos > windowEnd) {
      if (pos > windowEnd) break;
      continue;
    }
    beforeMax = pos;
    if (pos >= minChars) inWindow = pos;
  }
  if (inWindow > 0) return inWindow;
  if (beforeMax >= Math.min(400, windowEnd)) return beforeMax;
  const clause = Math.max(text.lastIndexOf(', ', windowEnd), text.lastIndexOf('; ', windowEnd));
  if (clause > 400) return clause + 2;
  const space = text.lastIndexOf(' ', windowEnd);
  return space > 400 ? space : windowEnd;
}

export function splitTranscriptParts(text, { minChars = ARTICLE_PART_MIN, maxChars = ARTICLE_PART_MAX } = {}) {
  const source = String(text || '').trim();
  if (!source) return [];
  const min = Math.max(200, Number(minChars) || ARTICLE_PART_MIN);
  const max = Math.max(min, Number(maxChars) || ARTICLE_PART_MAX);
  if (source.length <= max) return [{ text: source, start: firstClock(source) }];
  const parts = [];
  let rest = source;
  while (rest.length > max) {
    const cut = chooseCut(rest, min, max);
    const piece = rest.slice(0, cut).trim();
    if (!piece) break;
    parts.push({ text: piece, start: firstClock(piece) });
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push({ text: rest, start: firstClock(rest) });
  return parts;
}

const FOLLOW_UP = /翻译|总结|解释|提供|标注|能否|请再|把第|将第|如何|哪些|什么|继续/;

function isFollowUpLine(line) {
  const value = String(line || '').trim();
  if (!value || value.length > 80) return false;
  if (/^#{1,3}\s/.test(value)) return false;
  if (/^[^：\n]{1,16}：/.test(value)) return false;
  if (!/[？?]\s*$/.test(value) && !/^(把第|将第|请|能否|如何)/.test(value)) return false;
  return FOLLOW_UP.test(value);
}

export function stripDoubaoReply(text) {
  let value = String(text || '').replace(/\r\n/g, '\n').trim();
  const marker = value.search(/本回答由\s*AI\s*生成/);
  if (marker >= 0) value = value.slice(0, marker).trim();
  const lines = value.split('\n');
  let removed = 0;
  while (lines.length && removed < 4) {
    const last = lines[lines.length - 1].trim();
    if (!last) {
      lines.pop();
      continue;
    }
    if (!isFollowUpLine(last)) break;
    lines.pop();
    removed += 1;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function articlePartPrompt({ index, total, text, previousTail = '', fresh = false }) {
  const part = Number(index) + 1;
  const count = Number(total) || part;
  const body = String(text || '').trim();
  if (fresh) {
    const tail = String(previousTail || '').trim().slice(-400);
    return `上一段文章的结尾是：\n${tail}\n\n请接着把下面这段字幕整理成简体中文文章，沿用上一段的格式：## 小标题（HH:MM:SS），发言人写成「名字：」，术语保留英文。不要写成摘要，不要写「本回答由AI生成」，不要推荐追问。这是第 ${part}/${count} 段。\n\n字幕：\n${body}`;
  }
  if (part === 1) {
    return `请把下面的英文播客字幕整理成简体中文文章，不要写成摘要。\n\n要求：\n- 按说话顺序写完整，保留论证、数字和例子。\n- 用 Markdown。小节标题写成 ## 小标题（HH:MM:SS），时间用这一小节开始的字幕时间。\n- 发言人单独成段，写成「名字：」。听不出名字时用「主持人：」或「嘉宾：」。\n- 公司、产品、股票代码和已经通用的英文术语保留英文，第一次出现时在中文后面用括号标出英文。\n- 口播广告可以缩短成一两句，但保留赞助方和股票代码。\n- 不要写「本回答由AI生成」，不要附上推荐追问。\n- 这是第 1/${count} 段。\n\n字幕：\n${body}`;
  }
  return `第 ${part}/${count} 段，沿用格式。\n\n字幕：\n${body}`;
}

export const GEMMA_TRANSLATE_SYSTEM = '你是翻译器。把英文播客字幕译成简体中文。不要总结，不要扩写，不要加评论。保留时间戳、说话人标记（>>）、人名、公司名、股票代码和数字。已经通用的英文术语保留英文。只输出译文。';

export const GEMMA_SECTION_SYSTEM = '把下面这段播客译文排成一个 Markdown 小节。只用一个 ## 小标题，小标题必须是这段的中文主题，不要只用时间。时间可以写在主题后面，例如 ## 利率路径（00:12:03），也可以不写时间。禁止写成 ## 00:00:00 这种只有时间的标题。没有时间就不要编。发言人写成「名字：」。听不出名字时用「主持人：」或「嘉宾：」。保留数字、公司名、股票代码和关键数据。不要写要点摘要，不要加评论。只输出这一节。';

export const GEMMA_SUMMARY_SYSTEM = '根据下面的小节，写这一集开头的要点摘要。用 Markdown，第一行是 ## 要点，下面 5 到 8 条列表。保留人名和关键数字。不要重写全文，不要加评论。';

export const GEMMA_ARTICLE_TITLE_SYSTEM = '根据下面这篇已经整理好的简体中文播客文章，写一个准确的中文标题。标题要具体点出这一集的话题和核心信息，不要标题党，不要用疑问句吊胃口，不要加引号、书名号或句号。建议 15 到 30 个字。只输出标题本身。';

export function articleTitleSource(body, maxChars = 6000) {
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  const chars = [...text];
  const limit = Math.max(400, Number(maxChars) || 6000);
  if (chars.length <= limit) return text;
  const headings = text.split('\n').map((line) => line.trim()).filter((line) => /^##\s+\S/.test(line));
  const headingBlock = headings.join('\n');
  const reserve = Math.min(1200, [...headingBlock].length);
  const head = chars.slice(0, Math.max(400, limit - reserve)).join('');
  if (!headingBlock) return head;
  return `${head}\n\n小节标题：\n${headingBlock}`;
}

export function normalizeArticleTitle(raw) {
  let text = String(raw || '').replace(/\r/g, '').trim();
  if (!text) return '';
  text = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
  text = text.replace(/^标题\s*[:：]\s*/, '');
  text = text.replace(/^#{1,6}\s*/, '');
  text = text.replace(/^["“「『《]+/, '').replace(/["”」』》]+$/u, '');
  text = text.replace(/[。！？!?…]+$/u, '').trim();
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || text === '要点' || text === '本节') return '';
  if (needsChineseTitle(text)) return '';
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  if (han < 8 || han > 40) return '';
  if ([...text].length > 48) return '';
  return text;
}

export function gemmaSummarySource(sections) {
  return (Array.isArray(sections) ? sections : []).map((section, index) => {
    const lines = String(section || '').trim().split('\n');
    const heading = lines.find((line) => /^##\s/.test(line.trim())) || `第 ${index + 1} 节`;
    const body = lines.filter((line) => line.trim() && !/^##\s/.test(line.trim())).join(' ').replace(/\s+/g, ' ').trim().slice(0, 180);
    return body ? `${heading.trim()}\n${body}` : heading.trim();
  }).filter(Boolean).join('\n\n');
}

export function joinGemmaArticle(summary, sections) {
  const opening = String(summary || '').trim();
  const body = (Array.isArray(sections) ? sections : []).map((item) => String(item || '').trim()).filter(Boolean).join('\n\n');
  if (!opening) return body;
  const head = opening.startsWith('## ') ? opening : `## 要点\n\n${opening}`;
  return body ? `${head}\n\n${body}`.trim() : head;
}

export function joinArticleParts(replies) {
  return (Array.isArray(replies) ? replies : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

export function continuedDoubaoChatUrl(value) {
  const url = String(value || '').trim();
  return /^https:\/\/www\.doubao\.com\/chat\/\d+/.test(url) ? url : '';
}

const CLOCK_ONLY_HEADING = /^##\s*[（(]?\d{1,2}:\d{2}(?::\d{2})?[)）]?\s*$/;

export function captionAlreadyChinese(text) {
  const value = String(text || '')
    .replace(/\[[^\]]{0,16}\]/g, ' ')
    .replace(/>>/g, ' ');
  const han = (value.match(/\p{Script=Han}/gu) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  return han >= 12 && han * 2 >= latin;
}

export function timestampOnlyHeading(section) {
  const heading = String(section || '').split('\n').map((line) => line.trim()).find((line) => line.startsWith('##'));
  return Boolean(heading && CLOCK_ONLY_HEADING.test(heading));
}

function usableClock(value) {
  const raw = String(value || '').trim();
  if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) return '';
  return normalizeClock(raw);
}

export function repairTimestampHeading(section, start = '', source = '') {
  const text = String(section || '').replace(/\r\n/g, '\n').trim();
  if (!timestampOnlyHeading(text)) return text;
  const lines = text.split('\n');
  const heading = lines.map((line) => line.trim()).find((line) => line.startsWith('##')) || '';
  const clock = usableClock(heading.match(/(\d{1,2}:\d{2}(?::\d{2})?)/)?.[1])
    || usableClock(start)
    || usableClock(firstClock(source));
  const bodyLines = lines.filter((line) => !CLOCK_ONLY_HEADING.test(line.trim()));
  const candidates = bodyLines.map((line) => line.trim()).filter(Boolean);
  if (!candidates.length && String(source || '').trim()) candidates.push(String(source).trim());
  let topic = '';
  for (const line of candidates) {
    const stripped = line
      .replace(/^\[[^\]]{0,16}\]\s*/, '')
      .replace(/^>>\s*/, '')
      .replace(/^[-*]\s+/, '')
      .replace(/^[^：:\n]{1,16}[：:]\s*/, '')
      .trim();
    const sentence = stripped.split(/[。！？!?]/)[0].replace(/\s+/g, ' ').trim();
    if (!sentence) continue;
    topic = [...sentence].slice(0, 18).join('');
    break;
  }
  if (!topic) topic = '本节';
  const title = clock ? `## ${topic}（${clock}）` : `## ${topic}`;
  const rest = bodyLines.join('\n').trim();
  return rest ? `${title}\n\n${rest}` : title;
}

export function gemmaArticleNeedsRepair(state) {
  if (!state || state.engine !== 'gemma' || !Array.isArray(state.parts) || !state.parts.length) return false;
  return state.parts.some((part) => {
    const text = String(part?.text || '');
    const translation = String(part?.translation || '');
    if (captionAlreadyChinese(text) && translation && !captionAlreadyChinese(translation)) return true;
    return timestampOnlyHeading(part?.section);
  });
}

export function needsChineseTitle(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  const han = (value.match(/\p{Script=Han}/gu) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  if (han >= 2 && han * 2 >= latin) return false;
  return latin >= 3;
}

export function needsEnglishQuote(text) {
  const value = String(text || '').trim();
  const han = (value.match(/\p{Script=Han}/gu) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  return latin >= 8 && han < 4;
}

export function summaryQuoteBodies(summary) {
  const lines = String(summary || '').split('\n');
  const quotes = [];
  let inQuotes = false;
  for (const line of lines) {
    if (line.trim() === '关键句：') {
      inQuotes = true;
      continue;
    }
    if (!inQuotes) continue;
    if (!line.startsWith('- ')) break;
    quotes.push(line.replace(/^- (?:\d{2}:\d{2}:\d{2} )?/, '').trim());
  }
  return quotes;
}
