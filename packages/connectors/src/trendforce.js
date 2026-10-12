import { z } from 'zod';
import { parseStructuredPricePage } from './trendforce-prices.js';
import { EXTRACTOR_VERSION } from './media/article-html.js';
const ROOT = 'https://www.trendforce.com.tw';
const DEFAULT_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const RESEARCH_INDEX_NOTE = '会员报告，仅收录标题与介绍，不是 PDF 全文。';

const PRICE_PAGES = Object.freeze([
  { id: 'dram', title: 'DRAM 价格趋势', path: '/price/dram/dram_spot' },
  { id: 'flash', title: 'NAND Flash 价格趋势', path: '/price/flash/flash_spot' },
]);

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTags(value = '') {
  return decodeHtml(String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function attr(tag, name) {
  const match = String(tag || '').match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return decodeHtml(match ? (match[2] ?? match[3] ?? '') : '');
}

function absUrl(value, base = ROOT) {
  const raw = text(value);
  if (!raw) return '';
  try {
    return new URL(raw, base).toString();
  } catch {
    return '';
  }
}

function parseDate(value) {
  const raw = text(value).replace(/年/g, '/').replace(/月/g, '/').replace(/日/g, '');
  if (!raw) return 0;
  const iso = raw.includes('T') ? raw : raw.replace(/(\d{4})[/.](\d{1,2})[/.](\d{1,2})/, (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseInsightCards(html) {
  const cards = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b([^>]*class="[^"]*column-list-item[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = absUrl(attr(match[1], 'href'));
    const slug = attr(match[1], 'data-anchor-id')
      || (href.match(/\/insights\/([^/?#]+)/i) || [])[1]
      || '';
    if (!slug || seen.has(slug) || /\/insights\/?$/i.test(href)) continue;
    seen.add(slug);
    const inner = match[2];
    cards.push({
      kind: 'insight',
      slug,
      title: stripTags((inner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1]),
      summary: stripTags((inner.match(/<p[^>]*class="[^"]*column-list-summary[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || [])[1]),
      publishedAt: parseDate((inner.match(/fa-calendar[\s\S]*?<\/i>\s*([^<]+)/i) || [])[1]),
      sourceUrl: href || `${ROOT}/insights/${slug}`,
    });
  }
  return cards;
}

export function parseInsightArticle(html, url = '') {
  const title = stripTags((String(html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
  const summary = stripTags((String(html || '').match(/<div class="summary">([\s\S]*?)<\/div>/i) || [])[1]);
  const article = stripTags((String(html || '').match(/<article[^>]*class="[^"]*column-content-article[^"]*"[^>]*>([\s\S]*?)<\/article>/i) || [])[1]);
  const date = parseDate((String(html || '').match(/column-header-content[\s\S]*?<p>([^<]+)<\/p>/i) || [])[1]);
  const slug = (String(url).match(/\/insights\/([^/?#]+)/i) || [])[1] || '';
  return {
    kind: 'insight',
    contentLevel: article && !/subscribe to read|會員專享|付费阅读/i.test(article) ? 'full' : summary ? 'summary_only' : 'title_only',
    paragraphs: article ? article.split(/\n\s*\n/).filter(Boolean).map((text,i)=>({id:`p${String(i+1).padStart(4,'0')}`,text,kind:'paragraph'})) : [],
    slug,
    title,
    summary,
    body: [summary, article].filter(Boolean).join('\n\n'),
    publishedAt: date,
    sourceUrl: absUrl(url) || (slug ? `${ROOT}/insights/${slug}` : ''),
  };
}

function parseResearchCard(tag, inner) {
  const href = absUrl(attr(tag, 'href'));
  const number = (href.match(/\/research\/download\/([^/?#]+)/i) || [])[1] || '';
  if (!number) return null;
  return {
    kind: 'research',
    reportNumber: number,
    title: stripTags((inner.match(/<(?:h2|div)[^>]*class="[^"]*card-title[^"]*"[^>]*>([\s\S]*?)<\/(?:h2|div)>/i) || [])[1]),
    summary: stripTags((inner.match(/<p[^>]*class="[^"]*card-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || [])[1]),
    publishedAt: parseDate((inner.match(/fa-calendar[\s\S]*?<\/i>\s*([^<]+)/i) || [])[1]),
    sourceUrl: href || `${ROOT}/research/download/${number}`,
  };
}

export function parseResearchCards(html) {
  const cards = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b([^>]*class="[^"]*report-card-(?:large|small)[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi)) {
    const card = parseResearchCard(match[1], match[2]);
    if (!card || seen.has(card.reportNumber)) continue;
    seen.add(card.reportNumber);
    cards.push(card);
  }
  return cards;
}

export function parseResearchAjax(payload) {
  const rows = [
    ...(Array.isArray(payload?.left) ? payload.left : []),
    ...(Array.isArray(payload?.right) ? payload.right : []),
  ];
  return rows.map((row) => {
    const number = text(row.report_number);
    if (!number) return null;
    return {
      kind: 'research',
      reportNumber: number,
      title: stripTags(row.report_title || row.report_name || ''),
      summary: stripTags(row.report_desc || row.report_content || ''),
      publishedAt: parseDate(row.report_date || row.created_at || row.cr_time || ''),
      sourceUrl: `${ROOT}/research/download/${number}`,
    };
  }).filter(Boolean);
}

function tableToMarkdown(tableHtml) {
  const rows = [...String(tableHtml || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map((cell) => stripTags(cell[1]).replace(/\|/g, '/') || '—'));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const padded = rows.map((row) => {
    const next = row.slice(0, width);
    while (next.length < width) next.push('—');
    return next;
  });
  const header = padded[0];
  const body = padded.slice(1).filter((row) => row.some((cell) => cell && cell !== '—'));
  if (!body.length) return '';
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

export function parsePricePage(html, url = '', title = '价格趋势') {
  const sections = [];
  for (const match of String(html || '').matchAll(/<div class="price-title">([\s\S]*?)<\/div>[\s\S]*?(?:<div class="price-last-update">([\s\S]*?)<\/div>)?[\s\S]*?(<table class="price-table">[\s\S]*?<\/table>)/gi)) {
    const heading = stripTags(match[1]).replace(/走勢圖/g, '').trim();
    const updated = stripTags(match[2] || '');
    const table = tableToMarkdown(match[3]);
    if (!table) continue;
    sections.push([heading, updated, table].filter(Boolean).join('\n\n'));
  }
  return {
    kind: 'price',
    title,
    summary: sections[0] ? stripTags(sections[0]).slice(0, 160) : title,
    body: sections.join('\n\n') || title,
    publishedAt: parseDate((String(html || '').match(/Last Update\s+([0-9-]+\s+[0-9:]+)/i) || [])[1]),
    sourceUrl: absUrl(url),
  };
}

export function trendForceToFeedItem(record, options = {}) {
  const kind = record.kind || 'insight';
  const id = kind === 'insight'
    ? `insight:${record.slug}`
    : kind === 'research'
      ? `research:${record.reportNumber}`
      : `price:${record.id || 'page'}`;
  const title = text(record.title, kind === 'research' ? 'TrendForce 研究报告' : 'TrendForce');
  const intro = text(record.summary);
  const body = kind === 'research'
    ? [`【${RESEARCH_INDEX_NOTE}】`, intro].filter(Boolean).join('\n\n')
    : text(record.body, intro);
  return {
    id: `trendforce:${id}`,
    articleKind: kind === 'research' ? 'report-intro' : 'article',
    contentLevel: kind === 'research' ? (intro ? 'summary_only' : 'title_only') : record.contentLevel || 'summary_only',
    extractorVersion: EXTRACTOR_VERSION,
    paragraphs: record.paragraphs || [],
    workspaceId: options.workspaceId || 'local',
    platform: 'trendforce',
    externalId: id,
    authorName: 'TrendForce',
    title,
    summary: (kind === 'research' ? intro : body).slice(0, 160),
    body,
    sourceUrl: record.sourceUrl,
    publishedAt: Number(record.publishedAt) || 0,
    contentType: kind === 'price' ? 'post' : 'article',
  };
}

async function readText(fetchImpl, url, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        ...extraHeaders,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, url: response.url || url, body };
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTrendForceService(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const now = options.now || (() => Date.now());
  const wait = options.delay || delay;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map();
  const pending = new Map();

  async function getFeed({ feed = 'public', bypassCache = false, excludeExternalIds = [] } = {}) {
    const excluded = new Set((excludeExternalIds || []).map((id) => String(id || '')).filter(Boolean));
    const load = async () => {
      const items = [];
      const priceSnapshots = [];
      const warnings = [];
      try {
        const list = await readText(fetchImpl, `${ROOT}/insights`);
        const cards = list.ok ? parseInsightCards(list.body) : [];
        if (!list.ok) warnings.push(`洞察列表 ${list.status}`);
        for (const card of cards) {
          const externalId = `insight:${card.slug}`;
          if (excluded.has(externalId)) continue;
          await wait(150);
          const detail = await readText(fetchImpl, card.sourceUrl);
          if (!detail.ok) {
            warnings.push(`${card.slug} ${detail.status}`);
            items.push(trendForceToFeedItem({
              ...card,
              body: card.summary,
            }));
            continue;
          }
          const article = parseInsightArticle(detail.body, card.sourceUrl);
          items.push(trendForceToFeedItem({
            ...card,
            ...article,
            title: article.title || card.title,
            summary: article.summary || card.summary,
            publishedAt: article.publishedAt || card.publishedAt,
            sourceUrl: card.sourceUrl,
          }));
        }
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }

      try {
        const page = await readText(fetchImpl, `${ROOT}/research`);
        const cards = page.ok ? parseResearchCards(page.body) : [];
        if (!page.ok) warnings.push(`研究报告 ${page.status}`);
        for (const card of cards) {
          const externalId = `research:${card.reportNumber}`;
          if (excluded.has(externalId)) continue;
          items.push(trendForceToFeedItem(card));
        }
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }

      for (const page of PRICE_PAGES) {
        try {
          const result = await readText(fetchImpl, `${ROOT}${page.path}`);
          if (!result.ok) {
            warnings.push(`${page.id} ${result.status}`);
            continue;
          }
          priceSnapshots.push(parseStructuredPricePage(result.body,{pageKey:page.id,sourceUrl:`${ROOT}${page.path}`,title:page.title,capturedAt:now()}));
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      }

      const usable = items.filter((item) => item.externalId && item.sourceUrl);
      return {
        priceSnapshots,
        platform: 'trendforce',
        workspaceId: 'local',
        feed: 'public',
        source: 'trendforce_public',
        mode: usable.length || priceSnapshots.length ? (warnings.length ? 'partial' : 'live') : 'error',
        fetchedAt: now(),
        note: usable.length || priceSnapshots.length
          ? `公开文章 / 报告简介 ${usable.length} 条 · 价表快照 ${priceSnapshots.length} 张${warnings.length ? ` · ${warnings[0]}` : ''}`
          : (warnings[0] || 'TrendForce 公开页读取失败'),
        items: usable,
      };
    };

    const key = `public:${[...excluded].sort().join(',')}`;
    if(pending.has(key))return pending.get(key);
    const hit = cache.get(key);
    const timestamp = now();
    if (!bypassCache && hit && timestamp - hit.at < ttlMs) return hit.payload;
    const task=load().then(payload=>{cache.set(key,{at:now(),payload});return payload;}).finally(()=>pending.delete(key));
    pending.set(key,task);return task;
  }

  return { getFeed };
}

export const TRENDFORCE_PRICE_JOB_TYPE = 'feed.trendforce.prices';

export async function fetchTrendForcePriceSnapshots({ fetch: fetchImpl = fetch, now = () => Date.now() } = {}) {
  const snapshots = [];
  const errors = [];
  for (const page of PRICE_PAGES) {
    const sourceUrl = `${ROOT}${page.path}`;
    const result = await readText(fetchImpl, sourceUrl);
    if (!result.ok) {
      errors.push({ pageKey: page.id, status: result.status });
      continue;
    }
    snapshots.push(parseStructuredPricePage(result.body, {
      pageKey: page.id,
      sourceUrl,
      title: page.title,
      capturedAt: now(),
    }));
  }
  return { snapshots, errors };
}

export const trendforceConnectorManifest = {
  id: 'connector.trendforce',
  version: '1.0.0',
  capabilities: ['feed.capture'],
  jobTypes: ['feed.trendforce.sync','feed.trendforce.migrate','feed.trendforce.reparse', TRENDFORCE_PRICE_JOB_TYPE],
  sourceIds: ['content.trendforce.public', 'content.trendforce.collection'],
};

export function createTrendForceJobHandlers(options = {}) {
  return {
    async 'feed.trendforce.reparse'(input,context) {
      const value=z.object({workspaceId:z.string().min(1).default('local')}).strict().parse(input || {});
      const workspaceId=context.job?.workspaceId || value.workspaceId,service=options.hardwarePriceService;
      if(!service)throw new Error('缺少硬件报价端口');
      const before=service.savedSnapshots(workspaceId);let processed=0;
      for(const saved of before.filter(s=>s.format==='html')) {
        const snapshot=service.snapshot(workspaceId,saved.id);
        service.ingest(workspaceId,parseStructuredPricePage(snapshot.raw,{pageKey:saved.pageKey,sourceUrl:saved.sourceUrl,title:saved.title,capturedAt:saved.capturedAt}));processed++;
      }
      return {processed,added:service.savedSnapshots(workspaceId).length-before.length};
    },
    async 'feed.trendforce.migrate'(input,context) {
      const value=z.object({workspaceId:z.string().min(1).default('local')}).strict().parse(input || {});
      if(!options.migrateTrendforce)throw new Error('缺少内容迁移端口');
      return options.migrateTrendforce(context.job?.workspaceId || value.workspaceId);
    },
    async [TRENDFORCE_PRICE_JOB_TYPE](input, context) {
      const value = z.object({
        workspaceId: z.string().min(1).default('local'),
        scheduleKey: z.string().max(128).optional(),
        scheduledFor: z.number().optional(),
      }).strict().parse(input || {});
      const service = options.hardwarePriceService;
      if (!service) throw new Error('缺少硬件报价端口');
      const workspaceId = context.job?.workspaceId || value.workspaceId;
      const fetched = await fetchTrendForcePriceSnapshots({ fetch: options.fetch, now: options.now });
      if (!fetched.snapshots.length) throw new Error(fetched.errors.map((item) => `${item.pageKey} ${item.status}`).join('；') || 'TrendForce 价表读取失败');
      const pages = fetched.snapshots.map((snapshot) => {
        const saved = service.ingest(workspaceId, snapshot);
        const after = service.pageChecks?.(workspaceId)?.find((page) => page.pageKey === snapshot.pageKey);
        return {
          pageKey: snapshot.pageKey,
          rows: snapshot.rows.length,
          warnings: snapshot.warnings,
          snapshotId: saved.id,
          lastCheckedAt: after?.lastCheckedAt || saved.lastCheckedAt,
          lastChangedAt: after?.lastChangedAt || saved.lastChangedAt,
          unchanged: Boolean(after?.unchanged),
        };
      });
      return { ok: true, pages, errors: fetched.errors };
    },
    async 'feed.trendforce.sync'(input, context) {
      if (typeof options.syncFeed !== 'function') {
        throw new Error('feed.trendforce.sync 缺少 Worker 注入的 Feed Port');
      }
      const value=z.object({workspaceId:z.string().min(1).default('local'),feed:z.literal('public').optional()}).strict().parse(input || {});
      const workspaceId=context.job?.workspaceId || value.workspaceId;
      const feed = await options.syncFeed('trendforce', {feed:'public',refresh:true}, {workspaceId});
      if(feed.mediaExternalIds?.length)context.store.createJob({type:'media.index.enrich',workspaceId,maxAttempts:2,input:{workspaceId,externalIds:feed.mediaExternalIds}});
      context.store.setProviderHealth('trendforce', feed.mode === 'error' ? 'error' : 'healthy', feed.note, {
        itemCount: feed.items?.length || 0,
      });
      return {
        ok: feed.mode !== 'error',
        mode: feed.mode,
        itemCount: feed.items?.length || 0,
        note: feed.note,
      };
    },
  };
}
