import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrendForceFeedQuery, ValidationError } from '../packages/contracts/src/index.js';
import {
  createTrendForceService,
  parseInsightArticle,
  parseInsightCards,
  parsePricePage,
  parseResearchCards,
  trendForceToFeedItem,
  trendforceConnectorManifest,
} from '../packages/connectors/src/trendforce.js';
import { createConnectorRegistry } from '../packages/connectors/src/index.js';

const insightList = `
<section class="column-list-articles" id="articleList">
  <a href="https://www.trendforce.com.tw/insights/memory-hierarchy-paradigm-shift" class="column-list-item" data-anchor-id="memory-hierarchy-paradigm-shift">
    <h2 class="column-list-title">HBM 不再是唯一解方！AI 推理重組記憶體階層</h2>
    <span class="meta-group"><i class="fa fa-calendar margin-r-5"></i>2026/9/11</span>
    <p class="column-list-summary">KV Cache 容量與頻寬雙重挑戰</p>
  </a>
</section>
`;

const insightDetail = `
<h1 class="white">HBM 不再是唯一解方！AI 推理重組記憶體階層</h1>
<div class="summary">KV Cache 容量與頻寬雙重挑戰</div>
<article class="column-content-article">
  <p>隨著 Test-time Scaling 展開，AI 產業重心正從訓練轉向推理。</p>
  <h2 id="section-0">AI Training 的記憶體需求</h2>
  <p>記憶體的存取速度成為決定 Training 效率的關鍵。</p>
</article>
`;

const researchList = `
<a href="/research/download/RP260802XS" class="report-card-large">
  <h2 class="card-title">AI伺服器市場擴張加速</h2>
  <div class="card-meta text-muted"><i class="fa fa-calendar margin-r-5"></i>2026/08/03</div>
  <p class="card-desc text-muted">受北美雲端業者資本支出強勁擴張帶動。</p>
</a>
`;

const pricePage = `
<div class="price-title">DRAM Spot Price <small>(未稅)</small></div>
<div class="price-last-update"><p>Last Update 2026-09-18 18:10 (GMT+8)</p></div>
<table class="price-table">
  <thead><tr><th>項目</th><th>盤平均</th></tr></thead>
  <tbody>
    <tr><td><span>DDR5 16Gb (2Gx8) 4800/5600</span></td><td class="lcd-num-l">56.00</td></tr>
  </tbody>
</table>
`;

test('trendforce feed query only accepts the public page', () => {
  assert.deepEqual(parseTrendForceFeedQuery({ refresh: '1' }), {
    platform: 'trendforce', feed: 'public', refresh: true,
  });
  assert.throws(() => parseTrendForceFeedQuery({ platform: 'x' }), ValidationError);
});

test('insight cards and full articles parse from public HTML', () => {
  const [card] = parseInsightCards(insightList);
  assert.equal(card.slug, 'memory-hierarchy-paradigm-shift');
  assert.match(card.title, /HBM/);
  const article = parseInsightArticle(insightDetail, card.sourceUrl);
  assert.match(article.body, /Test-time Scaling/);
  const item = trendForceToFeedItem({ ...card, ...article });
  assert.equal(item.platform, 'trendforce');
  assert.equal(item.externalId, 'insight:memory-hierarchy-paradigm-shift');
  assert.equal(item.contentType, 'article');
  assert.match(item.body, /Training 效率/);
});

test('member research stays title plus intro, not a PDF body', () => {
  const [card] = parseResearchCards(researchList);
  assert.equal(card.reportNumber, 'RP260802XS');
  const item = trendForceToFeedItem(card);
  assert.equal(item.externalId, 'research:RP260802XS');
  assert.match(item.body, /仅收录标题与介绍/);
  assert.match(item.body, /北美雲端業者/);
  assert.equal(item.body.includes('%PDF'), false);
});

test('public price tables become a readable body', () => {
  const page = parsePricePage(pricePage, 'https://www.trendforce.com.tw/price/dram/dram_spot', 'DRAM 价格趋势');
  assert.match(page.body, /DDR5 16Gb/);
  assert.match(page.body, /56.00/);
  const item = trendForceToFeedItem({ ...page, id: 'dram', title: 'DRAM 价格趋势' });
  assert.equal(item.externalId, 'price:dram');
  assert.equal(item.contentType, 'post');
});

test('trendforce service pulls public pages and skips known insight ids', async () => {
  const seen = [];
  const service = createTrendForceService({
    now: () => 1_000,
    delay: async () => {},
    async fetch(url) {
      seen.push(String(url));
      if (String(url).endsWith('/insights')) return { ok: true, status: 200, url, text: async () => insightList };
      if (String(url).includes('/insights/memory-hierarchy-paradigm-shift')) {
        return { ok: true, status: 200, url, text: async () => insightDetail };
      }
      if (String(url).endsWith('/research')) return { ok: true, status: 200, url, text: async () => researchList };
      if (String(url).includes('/price/')) return { ok: true, status: 200, url, text: async () => pricePage };
      return { ok: false, status: 404, url, text: async () => '' };
    },
  });
  const first = await service.getFeed({ bypassCache: true });
  assert.equal(first.mode, 'live');
  assert.ok(first.items.some((item) => item.externalId === 'insight:memory-hierarchy-paradigm-shift'));
  assert.ok(first.items.some((item) => item.externalId === 'research:RP260802XS'));
  assert.ok(first.items.some((item) => item.externalId.startsWith('price:')));
  const again = await service.getFeed({
    bypassCache: true,
    excludeExternalIds: ['insight:memory-hierarchy-paradigm-shift', 'research:RP260802XS'],
  });
  assert.equal(again.items.some((item) => item.externalId.startsWith('insight:')), false);
  assert.ok(again.items.some((item) => item.externalId.startsWith('price:')));
  assert.equal(seen.some((url) => url.includes('/pricedetail/')), false);
  assert.equal(seen.some((url) => url.includes('/api/')), false);
});

test('x connector registry also registers trendforce sync', () => {
  const types = Object.keys(createConnectorRegistry({
    twitterService: { async getFeed() { return { mode: 'live', items: [], tweetCount: 0, note: '' }; } },
    trendforceService: { async getFeed() { return { mode: 'live', items: [], note: '' }; } },
    bilibiliService: { async getFeed() { return { mode: 'empty', items: [], note: '' }; } },
  }).createJobHandlers());
  assert.ok(types.includes('feed.x.sync'));
  assert.ok(types.includes('feed.trendforce.sync'));
  assert.equal(trendforceConnectorManifest.sourceIds[0], 'content.trendforce.public');
});
