import { parseDocument, DomUtils } from 'htmlparser2';
import { clipUtf8 } from './article-html.js';
import { hostAllowed, isPublicHttpsUrl } from './article-url.js';
import { parseFeedDate } from './dates.js';
import { fetchAllowlisted } from './http.js';

const STORY_PATH = /^\/news\/(world|china)\/story(\d{8})-(\d{5,})\/?$/;
export const zaobaoSectionLists = [
  'https://www.zaobao.com/news/world',
  'https://www.zaobao.com/news/china',
];
const CANONICAL_HOST = 'www.zaobao.com';
const SKIP_TAGS = new Set(['script', 'style', 'nav', 'aside', 'form', 'button', 'noscript', 'svg', 'iframe', 'astro-island']);
const CHROME_TEXT = /^(?:订阅新闻速递|展开全文|在早报应用继续阅读|延伸阅读|相关新闻|购买此文章)$/;
const PAYWALL_TEXT = /此文章为付费内容|订阅后继续阅读|登录后阅读|会员专享|付费阅读/;
const SENTENCE_END = /[。！？.!?]$/;
const lastHits = new Map();

function clean(value) {
  return String(value || '').replace(/[\t \r]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

function classId(node) {
  return `${node?.attribs?.class || ''} ${node?.attribs?.id || ''}`;
}

function storyDayEndsAt(yyyymmdd) {
  if (!/^\d{8}$/.test(yyyymmdd)) return null;
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Exclusive end of that calendar day in Asia/Singapore. This is not a publication timestamp.
  return Date.UTC(year, month - 1, day, 16, 0, 0);
}

export function zaobaoStoryRef(value, { base = 'https://www.zaobao.com/news/world', articleHosts = [CANONICAL_HOST, 'www.zaobao.com.sg'] } = {}) {
  let url;
  try { url = new URL(String(value || ''), base); } catch { return null; }
  if (!isPublicHttpsUrl(url.toString()) || !hostAllowed(url.hostname, articleHosts)) return null;
  const match = url.pathname.match(STORY_PATH);
  if (!match) return null;
  const section = match[1];
  const storyDate = match[2];
  const storyId = match[3];
  return {
    storyId,
    storyDate,
    section,
    externalId: `zaobao:${storyId}`,
    sourceUrl: `https://${CANONICAL_HOST}/news/${section}/story${storyDate}-${storyId}`,
  };
}

function outsideWindow(storyDate, now, backfillHours) {
  const end = storyDayEndsAt(storyDate);
  if (end == null || !Number.isFinite(now) || !Number.isFinite(backfillHours)) return false;
  return end <= now - backfillHours * 60 * 60 * 1000;
}

function ldArticles(html) {
  const dom = parseDocument(String(html || ''));
  const found = [];
  for (const node of DomUtils.findAll((item) => item.name === 'script' && /ld\+json/i.test(item.attribs?.type || ''), dom)) {
    try {
      const walk = (value) => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') {
          if (/NewsArticle|Article/i.test(String(value['@type'] || ''))) found.push(value);
          if (value['@graph']) walk(value['@graph']);
        }
      };
      walk(JSON.parse(DomUtils.textContent(node)));
    } catch { /* Malformed metadata is not a timestamp or a body. */ }
  }
  return found.sort((a, b) => String(b.headline || '').length - String(a.headline || '').length);
}

function first(dom, predicate) {
  return DomUtils.findAll(predicate, dom ? [dom] : [])[0] || null;
}

function pageTitle(dom) {
  return clean(DomUtils.textContent(first(dom, (node) => node.name === 'title') || { children: [] })).slice(0, 300);
}

function failed(reason, extra = {}) {
  return {
    ok: false, contentLevel: 'summary_only', reason, text: '', paragraphs: [], captions: [], truncated: false,
    extractionMethod: 'site:zaobao', visualEvidenceRequired: false, author: '', canonical: '', publishedAt: null,
    publishedAtRaw: '', updatedAtRaw: '', title: '', ...extra,
  };
}

function inlineText(node) {
  if (!node || node.type === 'text') return node?.data || '';
  if (node.type !== 'tag') return '';
  if (SKIP_TAGS.has(node.name) || node.name === 'figcaption' || /\bcaption\b/i.test(classId(node))) return '';
  if (node.name === 'br') return '\n';
  return (node.children || []).map(inlineText).join('');
}

function collectBlocks(node, paragraphs, captions) {
  if (!node || node.type !== 'tag') return;
  if (isCaption(node)) {
    const text = clean(DomUtils.textContent(node));
    if (text) captions.push(text);
    return;
  }
  if (SKIP_TAGS.has(node.name) || /\bfurther-reading\b|\brelated\b|\badvertisement\b|\bnewsletter\b/i.test(classId(node))) return;
  if (['p', 'h2', 'h3', 'blockquote', 'li'].includes(node.name)) {
    const text = clean(inlineText(node));
    if (text && !CHROME_TEXT.test(text)) {
      paragraphs.push({
        kind: /^h\d$/.test(node.name) ? 'heading' : node.name === 'li' ? 'list' : node.name === 'blockquote' ? 'quote' : 'paragraph',
        text,
      });
    }
    return;
  }
  for (const child of node.children || []) collectBlocks(child, paragraphs, captions);
}

function isCaption(node) {
  return node?.name === 'figcaption' || /\bcaption\b|image-credit|figure-caption/i.test(classId(node));
}

function classifyBody({ paragraphs, wordCount, lead, truncationControl }) {
  const prose = paragraphs.filter((item) => item.kind === 'paragraph' || item.kind === 'quote');
  const chars = prose.map((item) => item.text).join('').length;
  const normalized = prose.map((item) => item.text).join('').replace(/\s+/g, '');
  const leadText = clean(lead).replace(/\s+/g, '');
  const onlyLead = Boolean(leadText) && normalized === leadText;
  if (!prose.length) return { ok: false, contentLevel: 'summary_only', reason: 'missing_body' };
  if (Number.isFinite(wordCount) && wordCount > 0) {
    const ratio = chars / wordCount;
    if (onlyLead || ratio < 0.55) return { ok: false, contentLevel: 'summary_only', reason: 'preview' };
    if (ratio < 0.85) return { ok: true, contentLevel: 'partial', reason: 'incomplete' };
    return { ok: true, contentLevel: 'full', reason: 'structured_body' };
  }
  if (onlyLead && truncationControl) return { ok: false, contentLevel: 'summary_only', reason: 'preview' };
  if (SENTENCE_END.test(prose.at(-1).text) && !onlyLead) return { ok: true, contentLevel: 'full', reason: 'structured_body' };
  if (truncationControl) return { ok: true, contentLevel: 'partial', reason: 'incomplete' };
  return { ok: false, contentLevel: 'summary_only', reason: 'unknown' };
}

export function extractZaobaoArticle(html, { status = 200, title = '', maxBytes = 100_000 } = {}) {
  const source = String(html || '');
  const dom = parseDocument(source);
  const titleText = title || pageTitle(dom);
  if (!source.trim()) return failed('empty_page', { title: titleText });
  if ([401, 402, 403].includes(status)) return failed(status === 402 ? 'paywall' : 'blocked', { title: titleText });
  const visible = clean(DomUtils.textContent(dom));
  const challenge = /just a moment|access denied|verify you are|security check|cf-browser-verification/i.test(titleText)
    || (visible.length < 1500 && /captcha|verify you are human|cf-challenge/i.test(source));
  if (challenge) return failed('challenge', { title: titleText });
  const ld = ldArticles(source)[0] || null;
  const restricted = ld && [false, 'false', 'False'].includes(ld.isAccessibleForFree);
  const body = first(dom, (node) => node.attribs?.id === 'article-body' || (node.name === 'article' && /\barticle-body\b/.test(node.attribs?.class || '')));
  if (!body) return failed(visible ? 'unsupported_template' : 'empty_page', { title: titleText });
  const bodyText = clean(DomUtils.textContent(body));
  if (restricted || PAYWALL_TEXT.test(bodyText)) return failed('paywall', { title: ld?.headline || titleText });
  const paragraphs = [];
  const captions = [];
  collectBlocks(body, paragraphs, captions);
  const seen = new Set();
  const unique = paragraphs.filter((item) => {
    const key = item.text.replace(/\s+/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const wordCount = Number(ld?.wordCount);
  const truncationControl = /id=["']continue-read["']|展开全文|在早报应用继续阅读/.test(source);
  const decision = classifyBody({ paragraphs: unique, wordCount, lead: ld?.articleBody || '', truncationControl });
  const canonical = first(dom, (node) => node.name === 'link' && node.attribs?.rel === 'canonical')?.attribs?.href || '';
  const publishedRaw = String(ld?.datePublished || '');
  const parsedDate = parseFeedDate(publishedRaw);
  const visibleTime = clean(DomUtils.textContent(first(dom, (node) => node.attribs?.id === 'publish_time') || { children: [] }));
  const publishedAtRaw = parsedDate.publishedAtRaw || (visibleTime && !publishedRaw ? visibleTime : '');
  const authorNode = DomUtils.findAll((node) => node.name === 'a' && /\bbyline_area\b/.test(node.attribs?.class || ''), dom)
    .map((node) => clean(DomUtils.textContent(node)))
    .find((value) => value && !value.includes('@') && !value.startsWith('发布'));
  const joined = unique.map((item) => item.text).join('\n\n');
  const truncated = Buffer.byteLength(joined) > maxBytes;
  const text = clipUtf8(joined, maxBytes);
  const kept = [];
  let remaining = Buffer.byteLength(text);
  for (const item of unique) {
    if (remaining <= 0) break;
    const part = clipUtf8(item.text, remaining);
    if (part) kept.push({ id: `p${String(kept.length + 1).padStart(4, '0')}`, kind: item.kind, text: part });
    remaining -= Buffer.byteLength(part) + 2;
  }
  const level = truncated && decision.ok ? 'partial' : decision.contentLevel;
  const reason = truncated && decision.ok ? 'byte_limit' : decision.reason;
  return {
    ok: decision.ok && !restricted, contentLevel: level, reason, text: decision.ok ? text : '', paragraphs: decision.ok ? kept : [],
    captions, truncated, extractionMethod: 'site:zaobao', visualEvidenceRequired: false,
    author: String(authorNode || '').slice(0, 512), canonical: String(canonical || '').slice(0, 2048),
    publishedAt: parsedDate.publishedAt, publishedAtRaw: publishedAtRaw.slice(0, 128),
    updatedAtRaw: String(ld?.dateModified || '').slice(0, 128), title: String(ld?.headline || titleText).slice(0, 1000),
  };
}

export function parseZaobaoWorldList(html, entry, { now = Date.now() } = {}) {
  const source = String(html || '');
  const empty = (health, note) => ({ ok: false, health, items: [], observations: [], note });
  if (!source.trim()) return empty('empty_page', '栏目页为空');
  const dom = parseDocument(source);
  const title = pageTitle(dom);
  const visible = clean(DomUtils.textContent(dom));
  if (/just a moment|access denied|verify you are|security check/i.test(title) || (visible.length < 1500 && /captcha|cf-challenge|verify you are human/i.test(source))) {
    return empty('challenge', '栏目页是验证或挑战页');
  }
  const list = first(dom, (node) => node.attribs?.['data-testid'] === 'article-list');
  if (!list) return empty('unsupported_template', '栏目列表模板已变化');
  const hosts = entry.articleHosts?.length ? entry.articleHosts : [CANONICAL_HOST, 'www.zaobao.com.sg'];
  const base = entry.probeUrl || `https://${CANONICAL_HOST}/news/world`;
  const hours = entry.backfillHours ?? 48;
  const seen = new Set();
  const items = [];
  const observations = [];
  const anchors = DomUtils.findAll((node) => node.name === 'a' && node.attribs?.href && !/\barticle-graphic-image\b/.test(node.attribs?.class || ''), list);
  for (const anchor of anchors) {
    const ref = zaobaoStoryRef(anchor.attribs.href, { base, articleHosts: hosts });
    const label = clean(anchor.attribs?.title || DomUtils.textContent(anchor)).slice(0, 1000);
    const position = observations.length;
    if (!ref) {
      observations.push({ listPosition: position, title: label, sourceUrl: '', excludedReason: 'outside_section', publishedAt: null });
      continue;
    }
    if (seen.has(ref.storyId)) continue;
    seen.add(ref.storyId);
    const timeText = clean(DomUtils.textContent(first(anchor.parent || anchor, (node) => node.name === 'span') || { children: [] }));
    let excludedReason = '';
    if (!label) excludedReason = 'missing_title';
    else if (outsideWindow(ref.storyDate, now, hours)) excludedReason = 'outside_lookback';
    const row = {
      externalId: ref.externalId, sourceUrl: ref.sourceUrl, title: label, summary: '',
      publisherKey: entry.publisherKey || 'zaobao', publisherName: entry.publisher || '早报',
      listPosition: items.length, publishedAt: null, publishedAtRaw: '',
      discoveredVia: { sourceKey: entry.sourceKey || 'zaobaoworld', url: ref.sourceUrl },
    };
    observations.push({ listPosition: position, title: label, sourceUrl: ref.sourceUrl, externalId: ref.externalId, excludedReason, publishedAt: null, listTimeLabel: timeText });
    if (!excludedReason) items.push(row);
  }
  return { ok: true, health: items.length ? 'ready' : 'empty', items, observations, note: items.length ? '' : '国际栏目没有可收录的新文章' };
}

async function pace(entry) {
  const wait = Number(entry?.minRequestIntervalMs) || 0;
  if (wait <= 0) return;
  const key = entry.sourceKey || 'zaobaoworld';
  const now = Date.now();
  const delay = (lastHits.get(key) || 0) + wait - now;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  lastHits.set(key, Date.now());
}

function zaobaoListUrls(entry) {
  const configured = Array.isArray(entry.listUrls) && entry.listUrls.length ? entry.listUrls : zaobaoSectionLists;
  return [...new Set(configured.map((value) => String(value || '').trim()).filter(Boolean))];
}

export async function readZaobaoList(entry, options = {}) {
  const urls = zaobaoListUrls(entry);
  const items = [];
  const observations = [];
  const seen = new Set();
  const notes = [];
  let okCount = 0;
  let lastFailure = null;
  let bytes = 0;
  const redirectChain = [];
  for (const url of urls) {
    await pace(entry);
    const fetched = await fetchAllowlisted({
      url,
      allowedHosts: entry.allowedHosts,
      redirectHosts: entry.redirectHosts,
    }, options);
    bytes += fetched.bytes || 0;
    redirectChain.push(...(fetched.redirectChain || []));
    if (!fetched.ok) {
      lastFailure = fetched;
      notes.push(`${new URL(url).pathname} ${fetched.health}`);
      continue;
    }
    const parsed = parseZaobaoWorldList(fetched.body, { ...entry, probeUrl: url }, { now: options.now });
    if (!parsed.ok) {
      lastFailure = { ...fetched, ok: false, health: parsed.health, note: parsed.note };
      notes.push(`${new URL(url).pathname} ${parsed.health}`);
      continue;
    }
    okCount += 1;
    for (const item of parsed.items) {
      if (seen.has(item.externalId)) continue;
      seen.add(item.externalId);
      items.push({ ...item, listPosition: items.length });
    }
    observations.push(...parsed.observations);
  }
  if (!okCount) return { ...(lastFailure || { ok: false, health: 'empty_page', status: null, bytes: 0, redirectChain, note: '' }), items: [], observations, note: [notes.join('; '), lastFailure?.note].filter(Boolean).join(' ') };
  return {
    ok: true, health: items.length ? 'ready' : 'empty', items, observations, status: 200, bytes, redirectChain,
    finalUrl: urls[0], etag: '', lastModified: '', note: notes.filter(Boolean).join('; '),
  };
}

export async function readZaobaoArticle(entry, input, options = {}) {
  await pace(entry);
  const response = await fetchAllowlisted({
    ...input,
    allowedHosts: input.allowedHosts || entry.articleHosts,
    redirectHosts: input.redirectHosts || entry.redirectHosts,
    kind: 'article',
  }, { ...options, honorRetryAfter: true, maxRetryAfterMs: options.maxRetryAfterMs ?? 120_000 });
  if (!response.ok) return response;
  const ref = zaobaoStoryRef(response.finalUrl || input.url, { articleHosts: [...(entry.articleHosts || []), ...(entry.redirectHosts || [])] });
  if (!ref) return { ...response, ok: false, health: 'blocked_redirect', article: failed('blocked'), note: '文章最终地址不在国际栏目白名单' };
  const article = extractZaobaoArticle(response.body, { status: response.status, title: input.title || '', maxBytes: options.maxBodyBytes || options.maxBytes || 100_000 });
  return { ...response, article: { ...article, canonical: article.canonical || ref.sourceUrl } };
}
