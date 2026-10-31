import { XMLParser } from 'fast-xml-parser';
import { fetchAllowlisted } from './http.js';

export const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
export const DEFAULT_ARXIV_CATEGORIES = Object.freeze(['cs.DC', 'cs.AR', 'cs.CL', 'cs.LG']);
export const ARXIV_MIN_INTERVAL_MS = 3000;

const CATEGORY = /^[a-z]{2,}\.[A-Z]{2}$/;
const MODERN_ID = /(?:arxiv\.org\/(?:abs|pdf|html)\/)?((?:\d{4}\.\d{4,5}))(v\d+)?$/i;
const LEGACY_ID = /(?:arxiv\.org\/(?:abs|pdf|html)\/)?([a-z-]+\/\d{7})(v\d+)?$/i;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: false,
  htmlEntities: false,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: true,
  isArray: (name) => name === 'entry' || name === 'link' || name === 'author' || name === 'category',
});

function collapse(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return collapse(value);
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === 'object') return textOf(value['#text']);
  return '';
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function parseArxivCategories(value = process.env.AI_CENTER_ARXIV_CATEGORIES) {
  const raw = value == null || String(value).trim() === '' ? DEFAULT_ARXIV_CATEGORIES.join(',') : String(value);
  const categories = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const token = part.trim();
    if (!CATEGORY.test(token) || categories.includes(token)) continue;
    categories.push(token);
  }
  return categories.length ? categories : [...DEFAULT_ARXIV_CATEGORIES];
}

export function arxivMaxResults(value = process.env.AI_CENTER_ARXIV_MAX_RESULTS) {
  if (value == null || String(value).trim() === '') return 25;
  const number = Number(value);
  if (!Number.isInteger(number)) return 25;
  return Math.min(50, Math.max(1, number));
}

export function parseArxivPaperId(value) {
  const text = collapse(value);
  const match = text.match(MODERN_ID) || text.match(LEGACY_ID);
  if (!match) return null;
  const base = match[1];
  const version = (match[2] || 'v1').toLowerCase();
  return {
    base,
    version,
    externalId: `arxiv:${base}${version}`,
    absUrl: `https://arxiv.org/abs/${base}${version}`,
  };
}

export function arxivFullTextTarget(paper) {
  const id = `${paper.base}${paper.version}`;
  const pdfUrl = `https://arxiv.org/pdf/${id}`;
  return {
    status: 'deferred',
    preferred: 'html',
    htmlUrl: `https://arxiv.org/html/${id}`,
    pdfUrl,
    absUrl: paper.absUrl,
    reason: `full_text_deferred:html_preferred pdf=${pdfUrl}`.slice(0, 500),
  };
}

export function buildArxivQueryUrl(categories, { maxResults = 25, start = 0 } = {}) {
  const chosen = (categories || []).filter((item) => CATEGORY.test(item));
  if (!chosen.length) throw new Error('arXiv 类别为空');
  const url = new URL(ARXIV_API_URL);
  if (url.hostname !== 'export.arxiv.org' || url.pathname !== '/api/query') {
    throw new Error('arXiv 发现只走官方 API');
  }
  url.searchParams.set('search_query', chosen.map((item) => `cat:${item}`).join(' OR '));
  url.searchParams.set('sortBy', 'lastUpdatedDate');
  url.searchParams.set('sortOrder', 'descending');
  url.searchParams.set('start', String(Math.max(0, Math.trunc(start) || 0)));
  url.searchParams.set('max_results', String(Math.min(50, Math.max(1, Math.trunc(maxResults) || 25))));
  const built = url.toString();
  if (/rss\.arxiv\.org|\/rss\//i.test(built)) throw new Error('arXiv 发现不使用类别 Atom');
  return built;
}

export function createArxivRequestGate({
  minIntervalMs = ARXIV_MIN_INTERVAL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let last = null;
  return async function wait(requested = minIntervalMs) {
    const interval = Math.max(ARXIV_MIN_INTERVAL_MS, Math.trunc(Number(requested) || minIntervalMs || ARXIV_MIN_INTERVAL_MS));
    const current = now();
    if (last != null && current - last < interval) await sleep(interval - (current - last));
    last = now();
  };
}

function authorNames(entry) {
  return asArray(entry?.author).map((author) => textOf(author?.name)).filter(Boolean).join(', ').slice(0, 512);
}

function categoriesOf(entry) {
  return asArray(entry?.category).map((category) => String(category?.['@_term'] || '')).filter((term) => CATEGORY.test(term));
}

export function parseArxivApiBody(xml, { maxBytes = 2_097_152 } = {}) {
  const raw = String(xml || '');
  const bytes = Buffer.byteLength(raw);
  if (bytes > maxBytes) return { ok: false, health: 'oversized', items: [], note: 'arXiv 响应超过字节上限' };
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) return { ok: false, health: 'rejected_dtd', items: [], note: '拒绝带 DTD 的 arXiv 响应' };
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(raw)) return { ok: false, health: 'not_api', items: [], note: '响应是 HTML，不是官方 API' };
  if (/<rss[\s>]/i.test(raw) && !/<feed[\s>]/i.test(raw)) {
    return { ok: false, health: 'not_api', items: [], note: '拒绝 RSS。发现只解析官方 API 响应' };
  }
  let document;
  try {
    document = parser.parse(raw);
  } catch (error) {
    return { ok: false, health: 'parse_failed', items: [], note: error instanceof Error ? error.message : 'arXiv 解析失败' };
  }
  if (document?.rss && !document?.feed) return { ok: false, health: 'not_api', items: [], note: '拒绝 RSS。发现只解析官方 API 响应' };
  const feed = document?.feed;
  if (feed == null) return { ok: false, health: 'parse_failed', items: [], note: '响应不是 arXiv API 的 Atom 文档' };
  if (feed === '' || typeof feed !== 'object') return { ok: true, health: 'empty', items: [], note: '官方 API 在这个窗口里没有论文' };
  const seen = new Set();
  const items = [];
  for (const entry of asArray(feed.entry)) {
    const paper = parseArxivPaperId(textOf(entry.id));
    const title = collapse(textOf(entry.title)).slice(0, 2000);
    if (!paper || !title || seen.has(paper.externalId)) continue;
    const updated = textOf(entry.updated);
    const published = textOf(entry.published);
    const publishedAt = Date.parse(updated || published);
    if (!Number.isFinite(publishedAt)) continue;
    seen.add(paper.externalId);
    const fullText = arxivFullTextTarget(paper);
    items.push({
      externalId: paper.externalId,
      paperId: paper.base,
      paperVersion: paper.version,
      sourceUrl: paper.absUrl,
      title,
      summary: collapse(textOf(entry.summary)).slice(0, 20_000),
      publishedAt,
      publishedAtRaw: updated || published,
      authorName: authorNames(entry),
      publisherName: 'arXiv',
      publisherKey: 'arxiv',
      categories: categoriesOf(entry),
      fullText,
    });
  }
  return {
    ok: true,
    health: items.length ? 'ready' : 'empty',
    items,
    note: items.length ? '' : '官方 API 在这个窗口里没有论文',
  };
}

export async function readArxivCatalog(entry, {
  fetchImpl,
  lookupImpl,
  gate,
  env = process.env,
  maxBytes = 2_097_152,
} = {}) {
  const categories = parseArxivCategories(env.AI_CENTER_ARXIV_CATEGORIES);
  let url;
  try {
    url = buildArxivQueryUrl(categories, { maxResults: arxivMaxResults(env.AI_CENTER_ARXIV_MAX_RESULTS) });
  } catch (error) {
    return { ok: false, health: 'config', items: [], note: error instanceof Error ? error.message : 'arXiv 查询无效', requestCount: 0 };
  }
  const interval = Math.max(ARXIV_MIN_INTERVAL_MS, Number(entry?.minRequestIntervalMs) || ARXIV_MIN_INTERVAL_MS);
  if (typeof gate === 'function') await gate(interval);
  const fetched = await fetchAllowlisted({
    url,
    allowedHosts: entry?.allowedHosts?.length ? entry.allowedHosts : ['export.arxiv.org'],
    redirectHosts: entry?.redirectHosts || ['arxiv.org'],
  }, { fetchImpl, lookupImpl, maxBytes });
  if (!fetched.ok) {
    return { ok: false, health: fetched.health, status: fetched.status ?? null, items: [], note: fetched.note || '', requestCount: 1, etag: fetched.etag || '', lastModified: fetched.lastModified || '' };
  }
  const parsed = parseArxivApiBody(fetched.body, { maxBytes });
  return { ...parsed, status: fetched.status ?? null, requestCount: 1, etag: fetched.etag || '', lastModified: fetched.lastModified || '' };
}
