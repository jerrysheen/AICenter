import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from '../config/media.json' with { type: 'json' };
import { MediaConfigSchema } from '../packages/contracts/src/media.js';
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
import { extractZaobaoArticle, parseZaobaoWorldList, readZaobaoList } from '../packages/connectors/src/media/zaobao-public.js';
import { fetchAllowlisted } from '../packages/connectors/src/media/http.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';
import { createStore } from '../packages/database/src/index.js';

const NOW = Date.parse('2026-10-07T14:00:00Z');
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];
const source = config.sources.find((entry) => entry.sourceKey === 'zaobaoworld');

function response({ status = 200, body = '', headers = {} } = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: { get: (name) => normalized[String(name).toLowerCase()] || '' },
    async arrayBuffer() { return Buffer.from(body); },
  };
}

function listHtml(cards) {
  const body = cards.map((card) => `<article><a class="article-graphic-image" href="${card.href}"></a><a class="article-link" title="${card.title}" href="${card.href}">${card.title}</a><span>${card.time || ''}</span></article>`).join('');
  return `<html><head><title>国际新闻 | 联合早报网</title></head><body><a href="/news/china/story20261007-1000001">中国栏目</a><div data-testid="article-list">${body}</div></body></html>`;
}

function articleHtml({
  title = '合成国际短讯',
  paragraphs = ['第一段说明已经结束。', '第二段保留现场事实。'],
  wordCount,
  lead = '',
  free = true,
  author = '测试作者',
  date = '2026-10-07T21:26:48+08:00',
  visibleTime = '',
  extra = '',
  caption = '',
  statusTitle = '合成国际短讯 | 联合早报网',
} = {}) {
  const count = wordCount === null ? undefined : (wordCount ?? paragraphs.join('').length);
  const ld = {
    '@type': 'NewsArticle', headline: title, datePublished: date || undefined, wordCount: count,
    articleBody: lead, isAccessibleForFree: free, author: { '@type': 'Organization', name: '联合早报' },
  };
  return `<html><head><title>${statusTitle}</title><link rel="canonical" href="https://www.zaobao.com/news/world/story20261007-2222222">
    <script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>
    <a href="/subscribe">订阅新闻速递</a>
    <a class="byline_area" href="mailto:reporter@sph.com.sg">reporter@sph.com.sg</a>
    <a class="byline_area" href="/byline">${author}</a>
    <div id="publish_time">${visibleTime}</div>
    <article id="article-body"><p>${paragraphs.join('</p><p>')}</p>
      ${caption ? `<figcaption>${caption}</figcaption>` : ''}
      <astro-island><p>广告语不应进入正文。</p></astro-island>
      <section class="further-reading"><h4>延伸阅读</h4><a href="/news/china/story20261007-1000001">另一篇中国新闻</a></section>
      <p>${paragraphs[0]}</p>
    </article>
    <footer>购买此文章</footer>${extra}</body></html>`;
}

test('zaobao world stays disabled in the macro catalog and uses the checked com entry', () => {
  const parsed = MediaConfigSchema.parse(config);
  assert.equal(parsed.sources.length, 42);
  assert.equal(source.enabled, false);
  assert.equal(source.channel, 'macro');
  assert.equal(source.publisher, '早报');
  assert.equal(source.channelName, '早报');
  assert.equal(source.transport, 'html');
  assert.equal(source.listReadMethod, 'http');
  assert.equal(source.bodyReadMethod, 'http');
  assert.equal(source.probeUrl, 'https://www.zaobao.com/news/world');
  assert.equal(source.refreshMinutes, 60);
  assert.equal(source.backfillHours, 48);
  assert.deepEqual(source.listUrls, ['https://www.zaobao.com/news/world', 'https://www.zaobao.com/news/china']);
  assert.equal(source.maxListCandidates, 80);
  assert.equal(source.maxNewBodiesPerRound, 80);
  assert.equal(source.minRequestIntervalMs, 3000);
  assert.deepEqual(source.articleHosts, ['www.zaobao.com', 'www.zaobao.com.sg']);
  assert.equal(MediaConfigSchema.safeParse({ ...config, sources: [...config.sources, { ...source, sourceKey: 'extra' }] }).success, false);
});

test('world list keeps the section, dedupes both official hosts, and does not stop on an old pinned story', () => {
  const parsed = parseZaobaoWorldList(listHtml([
    { href: '/news/world/story20261004-1111111', title: '置顶旧闻', time: '10月4日' },
    { href: 'https://www.zaobao.com.sg/news/world/story20261007-2222222?ref=sidebar&utm_source=x', title: '今日外交', time: '19:54' },
    { href: 'https://www.zaobao.com/news/world/story20261007-2222222?fbclid=abc', title: '今日外交' },
    { href: '/news/singapore/story20261007-3333333', title: '新加坡本地' },
    { href: '/finance/story20261007-4444444', title: '财经栏目' },
    { href: '/news/china/story20261007-6666666', title: '中国外交' },
    { href: '/news/world/story20261006-5555555', title: '迟到的贸易消息', time: '10月6日' },
  ]), source, { now: NOW });
  assert.equal(parsed.health, 'ready');
  assert.deepEqual(parsed.items.map((item) => item.externalId), ['zaobao:2222222', 'zaobao:6666666', 'zaobao:5555555']);
  assert.equal(parsed.items[0].sourceUrl, 'https://www.zaobao.com/news/world/story20261007-2222222');
  assert.equal(parsed.items[1].sourceUrl, 'https://www.zaobao.com/news/china/story20261007-6666666');
  assert.equal(parsed.items[0].publishedAt, null);
  assert.equal(parsed.items[0].publishedAtRaw, '');
  assert.equal(parsed.observations.find((item) => item.title === '置顶旧闻').excludedReason, 'outside_lookback');
  assert.equal(parsed.observations.some((item) => item.excludedReason === 'outside_section'), true);
  assert.equal(parsed.items.some((item) => /singapore|finance/.test(item.sourceUrl)), false);
});

test('article boundaries keep a short story complete and reject preview, paywall, challenge and noise', () => {
  const full = extractZaobaoArticle(articleHtml({ extra: '<div id="continue-read">展开全文</div>' }));
  assert.equal(full.contentLevel, 'full');
  assert.equal(full.reason, 'structured_body');
  assert.equal(full.author, '测试作者');
  assert.equal(full.publishedAt, Date.parse('2026-10-07T21:26:48+08:00'));
  assert.equal(full.publishedAtRaw, '2026-10-07T21:26:48+08:00');
  assert.deepEqual(full.paragraphs.map((item) => item.text), ['第一段说明已经结束。', '第二段保留现场事实。']);
  assert.equal(full.text.includes('订阅新闻速递') || full.text.includes('购买此文章') || full.text.includes('延伸阅读') || full.text.includes('广告语'), false);

  const captioned = extractZaobaoArticle(articleHtml({ caption: '照片说明不进入论述。' }));
  assert.equal(captioned.contentLevel, 'full');
  assert.deepEqual(captioned.captions, ['照片说明不进入论述。']);
  assert.equal(captioned.text.includes('照片说明'), false);

  const short = extractZaobaoArticle(articleHtml({ paragraphs: ['双方当天达成停火。'], wordCount: '双方当天达成停火。'.length }));
  assert.equal(short.contentLevel, 'full');

  const lead = '这是只展示的导语。';
  const preview = extractZaobaoArticle(articleHtml({
    paragraphs: [lead], wordCount: 1800, lead, extra: '<div id="continue-read">展开全文</div>',
  }));
  assert.equal(preview.contentLevel, 'summary_only');
  assert.equal(preview.reason, 'preview');
  assert.equal(preview.text, '');

  const incomplete = extractZaobaoArticle(articleHtml({
    paragraphs: ['可见部分已经写完。'], wordCount: 12,
  }));
  assert.equal(incomplete.contentLevel, 'partial');
  assert.equal(incomplete.reason, 'incomplete');

  const unknown = extractZaobaoArticle(articleHtml({ paragraphs: ['时间仍不确定'], wordCount: null, date: '' }));
  assert.equal(unknown.reason, 'unknown');
  assert.equal(unknown.publishedAt, null);

  const dated = extractZaobaoArticle(articleHtml({ date: '', visibleTime: '发布 / 2026年10月7日 21:26', paragraphs: ['正文完整。'], wordCount: '正文完整。'.length }));
  assert.equal(dated.publishedAt, null);
  assert.equal(dated.publishedAtRaw.includes('2026年10月7日 21:26'), true);

  assert.equal(extractZaobaoArticle(articleHtml({ free: false })).reason, 'paywall');
  assert.equal(extractZaobaoArticle(articleHtml({ paragraphs: ['此文章为付费内容，订阅后继续阅读。'] })).reason, 'paywall');
  assert.equal(extractZaobaoArticle('<html><head><title>Just a moment</title></head><body>verify you are human</body></html>').reason, 'challenge');
  assert.equal(extractZaobaoArticle(articleHtml(), { status: 403 }).reason, 'blocked');
  assert.equal(extractZaobaoArticle('').reason, 'empty_page');
  assert.equal(extractZaobaoArticle('<html><head><title>国际新闻</title></head><body><p>没有正文容器</p></body></html>').reason, 'unsupported_template');
});

test('list failures stay distinct and 429 honors a bounded Retry-After once', async () => {
  const entry = { ...source, minRequestIntervalMs: 0 };
  assert.equal(parseZaobaoWorldList('', entry).health, 'empty_page');
  assert.equal(parseZaobaoWorldList('<html><head><title>Just a moment</title></head><body>cf-challenge</body></html>', entry).health, 'challenge');
  assert.equal(parseZaobaoWorldList('<html><head><title>国际新闻</title></head><body><div>栏目结构变了</div></body></html>', entry).health, 'unsupported_template');
  const denied = await fetchAllowlisted({ url: source.probeUrl, allowedHosts: source.allowedHosts, kind: 'article' }, {
    lookupImpl: PUBLIC_LOOKUP, fetchImpl: async () => response({ status: 403 }),
  });
  assert.equal(denied.health, 'blocked');
  assert.equal(denied.status, 403);
  let calls = 0;
  const limited = await fetchAllowlisted({ url: source.probeUrl, allowedHosts: source.allowedHosts, kind: 'article' }, {
    lookupImpl: PUBLIC_LOOKUP, honorRetryAfter: true, maxRetryAfterMs: 1000,
    fetchImpl: async () => { calls += 1; return response({ status: 429, headers: { 'retry-after': '30' } }); },
  });
  assert.equal(calls, 1);
  assert.equal(limited.health, 'rate_limited');
  assert.equal(limited.retryAfterMs, 30_000);
  const dns = await readZaobaoList(entry, { lookupImpl: async () => { throw new Error('无法解析 www.zaobao.com'); } });
  assert.equal(dns.health, 'network');
  assert.match(dns.note, /无法解析/);
});

test('yahoo list dispatch and BBC extraction stay on their existing readers', async () => {
  const port = createMediaConnector(config);
  const yahoo = await port.readList(config.sources.find((entry) => entry.sourceKey === 'yahooeconomy'));
  assert.equal(yahoo.health, 'browser_unavailable');
  const prose = 'A synthetic report explains capacity constraints, construction plans and the costs of connecting new facilities. '.repeat(4).trim();
  const bbc = port.extract(`<link rel="canonical" href="https://www.bbc.com/news/articles/shared"><main><article><p class="ssrcss-Paragraph">${prose}</p><p class="ssrcss-Paragraph">Final source evidence.</p></article></main>`, { sourceKey: 'bbc' });
  assert.equal(bbc.contentLevel, 'full');
  assert.equal(bbc.extractionMethod.includes('zaobao'), false);
});

test('isolated sync indexes the world list once, caps a round, and pauses after 429', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-zaobao-'));
  const store = createStore(path.join(directory, 'test.db'));
  const cards = [
    { href: '/news/world/story20261007-2222222', title: '今日外交' },
    { href: '/news/world/story20261007-3333333', title: '能源运输' },
    { href: '/news/world/story20261006-5555555', title: '迟到的贸易消息' },
  ];
  let articleCalls = 0;
  let mode = 'ok';
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith('/news/world') || value.endsWith('/news/china')) return response({ body: listHtml(cards) });
    articleCalls += 1;
    if (mode === 'limit') return response({ status: 429, headers: { 'retry-after': '99999' } });
    const id = value.match(/-(\d+)$/)?.[1];
    const title = cards.find((card) => card.href.endsWith(id))?.title || '合成';
    return response({ body: articleHtml({ title, paragraphs: [`${title}的第一段已经结束。`, `${title}的第二段保留事实。`] }) });
  };
  const sources = config.sources.map((entry) => entry.sourceKey === 'zaobaoworld' ? { ...entry, minRequestIntervalMs: 0, maxListCandidates: 2 } : entry);
  const service = createMediaIngestionService({
    mediaRepository: store.repositories.media,
    feedRepository: store.repositories.feed,
    mediaPort: createMediaConnector({ ...config, sources, fetchImpl, lookupImpl: PUBLIC_LOOKUP, now: () => NOW }),
    now: () => NOW,
  });
  try {
    const probe = await service.probe({ sourceKeys: ['zaobaoworld'], policyReviewed: true, run: true });
    assert.equal(probe.results[0].health, 'ready');
    assert.equal(service.enableSource('local', 'zaobaoworld').ok, true);
    const first = await service.syncEnabled({ workspaceId: 'local', channel: 'macro', force: true });
    assert.equal(first.results[0].added, 2);
    assert.match(store.repositories.media.getState('local', 'zaobaoworld').healthDetail, /candidate_limit/);
    const second = await service.syncEnabled({ workspaceId: 'local', channel: 'macro', force: true });
    assert.equal(second.results[0].added, 1);
    const rows = store.repositories.media.listEntries('local', { limit: 20 });
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => row.externalId)).size, 3);
    assert.equal(rows.every((row) => row.channel === 'macro' && row.publishedAt == null), true);
    service.acknowledgeBodyUse('local', ['zaobaoworld']);
    const ids = rows.map((row) => row.externalId);
    const bodies = await service.fetchBodies({ workspaceId: 'local', externalIds: ids.slice(0, 3), usageReviewed: true });
    assert.equal(bodies.stats.validFull, 3);
    assert.equal(articleCalls, 3);
    const saved = store.repositories.media.latestBodies('local', [ids[0]])[0];
    assert.equal(saved.contentLevel, 'full');
    assert.equal(saved.article.publishedAtRaw, '2026-10-07T21:26:48+08:00');
    const again = await service.syncEnabled({ workspaceId: 'local', channel: 'macro', force: true });
    assert.equal(again.results[0].health, 'not_modified');
    assert.equal(store.repositories.media.listEntries('local', { limit: 20 }).length, 3);
    mode = 'limit';
    articleCalls = 0;
    for (const id of [ids[0], ids[1]]) {
      const savedState = store.repositories.media.getEntries('local', [id])[0].fetchState;
      store.repositories.media.saveFetchState('local', id, { ...savedState, fetchStatus: 'pending', fetchedRevision: 0, extractorVersion: '', nextRetryAt: null, failureCount: 0 });
    }
    await service.fetchBodies({ workspaceId: 'local', externalIds: [ids[0], ids[1]], usageReviewed: true });
    assert.equal(articleCalls, 1);
    const paused = store.repositories.media.getEntries('local', [ids[0]])[0].fetchState;
    assert.equal(paused.extractionReason, 'rate_limited');
    assert.equal(paused.httpStatus, 429);
    assert.ok(paused.nextRetryAt > NOW);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
