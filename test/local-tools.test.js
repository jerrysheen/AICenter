import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalToolRegistry } from '../packages/runtime/src/local-tools.js';
import { marketBoardAiWarnings, projectMarketBoardForAI } from '../packages/source/src/source-projections.js';
import { createStore } from '../packages/database/src/index.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { createTaggingService } from '../packages/domain/src/tagging-service.js';
import { TAG_PROMPT_VERSION } from '../packages/domain/src/tag-prompt.js';
import { buildRuntimeContext } from '../packages/runtime/src/runtime-context.js';

function services() {
  const fixtures = {
    contextService: {
      async build(input) {
        return {
          generatedAt: 100,
          knowledge: [{ knowledgeId: 'knowledge-1', revision: 2, title: '投资方法' }],
          recentFeed: [], holdings: null,
          refs: [{ resourceType: 'knowledge-revision', resourceId: 'knowledge-1', revision: 2, asOf: null, label: '投资方法' }],
          ...input,
        };
      },
    },
    feedService: {
      searchContentItems(workspaceId, query, { limit }) {
        return [{ id: 'content-1', workspaceId, title: '半导体行业动态', body: query, publishedAt: 150, limit }];
      },
    },
    knowledgeService: {
      search(workspaceId, query, limit) { return [{ workspaceId, query, limit, knowledgeId: 'knowledge-1', revision: 2, title: '投资方法', snippet: '景气度' }]; },
      getCurrentRevision(workspaceId, knowledgeId) {
        return knowledgeId === 'knowledge-1' ? { workspaceId, knowledgeId, revision: 2, title: '投资方法', body: '先看景气度', createdAt: 100 } : null;
      },
      getCurrentRevisionByMetadataKind(workspaceId, kind) {
        return kind === 'investment-method' ? { workspaceId, knowledgeId: 'knowledge-1', revision: 2, title: '投资方法', body: '先看景气度', createdAt: 100 } : null;
      },
      listTaxonomy() {
        return [{ key: 'lens.business-cycle', dimension: 'lens', name: '景气度', parentKey: null }];
      },
      persistStructuredArtifact(input) {
        return {
          resourceType: input.artifact.target,
          resourceId: 'saved-1',
          title: input.artifact.title,
          contentType: input.artifact.contentType,
          taxonomy: [{ key: 'lens.business-cycle', name: '景气度', parentName: null, dimension: 'lens', primary: true }],
          proposalCount: 0,
        };
      },
    },
    tradingService: {
      async getBoard({ board }) {
        if (board === 'global') {
          return {
            board: 'global', fetchedAt: 200, groups: ['利率', '贵金属'],
            watchlist: [
              { symbol: 'US10Y', name: '十年期美债', lastPrice: 4.1, change: 0.01, changePct: 0.2, currency: 'USD', session: 'regular', asOf: 200, group: '利率', assetClass: 'rate', sparkline: [4, 4.1] },
              { symbol: 'XAUUSD', name: '黄金', lastPrice: 3600, change: -10, changePct: -0.3, currency: 'USD', session: 'regular', asOf: 200, group: '贵金属', assetClass: 'metal' },
            ],
            indices: [], gainers: [], losers: [],
          };
        }
        return { board, fetchedAt: 200, sections: [{ id: 'us', indices: [{ symbol: 'IDX', sparkline: [1, 2] }] }] };
      },
      async getHoldingsBoard() {
        return {
          updatedAt: 300, missingQuotes: [],
          positions: [
            { symbol: 'LOW', dayPnlPct: '-0.1', dayPnlCny: '-1', positionPnlPct: '0', positionPnlCny: '0' },
            { symbol: 'HIGH', dayPnlPct: '0.2', dayPnlCny: '2', positionPnlPct: '0', positionPnlCny: '0' },
          ],
        };
      },
      async getPersonalAssetDashboard() { return { updatedAt: 400, note: '', latest: { total: '1' }, points: [{ total: 'old' }] }; },
    },
  };
  fixtures.sourcePort = {
    list() { return []; },
    describe(sourceId) { return { id: sourceId, title: sourceId === 'market.global' ? '全球资产' : '市场概览' }; },
    async projectForAI(sourceId) {
      const data = await fixtures.tradingService.getBoard({ board: sourceId.replace('market.', '') });
      const projected = projectMarketBoardForAI(data);
      return { data: projected, observedAt: data.fetchedAt, warnings: marketBoardAiWarnings(projected) };
    },
  };
  return fixtures;
}

test('local read tools use domain services and return stable refs', async () => {
  const registry = createLocalToolRegistry(services());
  const ids = registry.list().map((item) => item.id);
  assert.deepEqual(ids, [
    'context.build', 'feed.search', 'knowledge.search', 'knowledge.get', 'user.method.get',
    'market.overview.get', 'market.global.get', 'holdings.get', 'holdings.rank', 'assets.get',
    'taxonomy.list', 'memory.save',
  ]);

  const context = await registry.execute('context.build', {}, { workspaceId: 'local', message: '读取投资方法' });
  assert.equal(context.data.knowledge[0].title, '投资方法');
  assert.equal(context.refs[0].resourceId, 'knowledge-1');

  const feed = await registry.execute('feed.search', { query: '半导体', limit: 1 }, { workspaceId: 'local', message: '半导体' });
  assert.equal(feed.data[0].id, 'content-1');
  assert.equal(feed.refs[0].resourceType, 'content-item');

  const knowledge = await registry.execute('knowledge.get', { knowledgeId: 'knowledge-1' }, { workspaceId: 'local' });
  assert.equal(knowledge.data.body, '先看景气度');
  assert.equal(knowledge.refs[0].revision, 2);

  const ranked = await registry.execute('holdings.rank', { metric: 'dayPnlPct', limit: 1 }, { workspaceId: 'local' });
  assert.equal(ranked.data.positions[0].symbol, 'HIGH');
  assert.equal(ranked.refs[0].resourceType, 'holdings-board');

  const assets = await registry.execute('assets.get', {}, { workspaceId: 'local' });
  assert.equal(assets.data.latest.total, '1');
  assert.equal('points' in assets.data, false);

  const market = await registry.execute('market.overview.get', {}, { workspaceId: 'local' });
  assert.equal('sparkline' in market.data.sections[0].indices[0], false);

  const global = await registry.execute('market.global.get', {}, { workspaceId: 'local' });
  assert.equal(global.data.watchlist[0].symbol, 'US10Y');
  assert.equal(global.data.watchlist[1].symbol, 'XAUUSD');
  assert.equal('sparkline' in global.data.watchlist[0], false);
  assert.deepEqual(global.data.groups, ['利率', '贵金属']);
  assert.equal(Array.isArray(global.data.sections), false);
  assert.match(registry.list().find((tool) => tool.id === 'market.global.get').description, /不是新闻搜索工具/);

  const catalog = await registry.execute('taxonomy.list', {}, { workspaceId: 'local' });
  assert.equal(catalog.data.nodes[0].key, 'lens.business-cycle');
  const saved = await registry.execute('memory.save', {
    target: 'inspiration',
    title: 'DRAM 景气外溢',
    contentType: 'hypothesis',
    bodyMarkdown: '## 想法\nHBM 占用产能。',
    taxonomy: [{ key: 'lens.business-cycle', primary: true, confidence: 0.9 }],
  }, { workspaceId: 'local', sessionId: 'session-1' });
  assert.equal(saved.data.savedTo, '灵感');
  assert.equal(saved.refs[0].resourceType, 'inspiration');
});

test('context.build applies the shared bounded holdings projection to large results', async () => {
  const fixtures = services();
  fixtures.contextService = {
    async build() {
      return {
        generatedAt: 500,
        knowledge: [{ knowledgeId: 'k1', revision: 1, title: '方法', body: 'x'.repeat(20_000) }],
        recentFeed: [{ id: 'f1', title: '动态', body: 'y'.repeat(20_000), publishedAt: 10 }],
        holdings: {
          updatedAt: 500,
          note: 'n'.repeat(2_000),
          missingQuotes: [],
          positions: Array.from({ length: 100 }, (_, index) => ({
            symbol: `S${index}`, name: `持仓 ${index}`, board: 'a_share', quantity: '1',
            marketValueCny: String(100 - index), costCny: '1', positionPnlCny: '1', positionPnlPct: '0.1',
            dayPnlCny: '1', dayPnlPct: '0.1', quoteStatus: 'live', rawProviderPayload: 'z'.repeat(10_000),
          })),
        },
        refs: [],
      };
    },
  };
  const registry = createLocalToolRegistry(fixtures);
  const output = await registry.execute('context.build', {}, { workspaceId: 'local', message: '我的持仓' });
  assert.equal(output.data.holdings.positions.length, 24);
  assert.equal(output.data.holdings.returnedCount, 24);
  assert.equal(output.data.holdings.totalCount, 100);
  assert.equal(output.data.holdings.truncated, true);
  assert.equal('rawProviderPayload' in output.data.holdings.positions[0], false);
  assert.ok(Buffer.byteLength(JSON.stringify(output), 'utf8') < 64 * 1024);
});

test('global market board projection warns when watchlist and indices are empty', async () => {
  const fixtures = services();
  fixtures.tradingService.getBoard = async () => ({ board: 'global', fetchedAt: 1, watchlist: [], indices: [] });
  const registry = createLocalToolRegistry(fixtures);
  const output = await registry.execute('market.global.get', {}, { workspaceId: 'local' });
  assert.deepEqual(output.data.watchlist, []);
  assert.match(output.warnings[0], /no projected instruments/);
});

test('invalid local tool parameters do not reach domain services', async () => {
  const fixtures = services();
  let calls = 0;
  fixtures.tradingService.getHoldingsBoard = async () => {
    calls += 1;
    return { updatedAt: 1, missingQuotes: [], positions: [] };
  };
  const registry = createLocalToolRegistry(fixtures);
  await assert.rejects(
    () => registry.execute('holdings.rank', { metric: 'unknown', limit: -1, extra: true }, { workspaceId: 'local' }),
    /参数无效/,
  );
  assert.equal(calls, 0);
});

test('feed.tag.search resolves 算力 to ai_compute and filters today by publishedAt', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-tag-tool-'));
  const store = createStore(path.join(directory, 'test.db'));
  try {
    const feedService = createFeedService({
      legacyRepository: store,
      feedRepository: store.repositories.feed,
      sourcePort: { findByProvider() { return null; }, list() { return []; } },
    });
    const taggingService = createTaggingService({
      catalog: JSON.parse(readFileSync(path.join('test', 'fixtures', 'tags.test.json'), 'utf8')),
      taggingRepository: store.repositories.tagging,
    });
    const today = Date.parse('2026-09-17T02:00:00.000Z');
    const yesterday = Date.parse('2026-09-16T02:00:00.000Z');
    const source = store.repositories.feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'acct-1', handle: 'news', displayName: 'News',
    });
    function saveTagged(externalId, title, body, publishedAt, tags) {
      const capture = store.repositories.feed.saveCapture({
        workspaceId: 'local', provider: 'x', externalId, sourceAccountId: source.id,
        sourceUrl: `https://x.com/u/status/${externalId}`, contentHash: externalId,
      });
      const item = store.repositories.feed.saveContentItem({
        workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
        title, body, sourceUrl: capture.sourceUrl, publishedAt,
      });
      store.repositories.tagging.saveTaggings([{
        workspaceId: 'local', resourceType: 'content-item', resourceId: item.id,
        tags, tagCatalogVersion: 'tags_v1', promptVersion: TAG_PROMPT_VERSION, model: 'test', analyzedAt: publishedAt,
      }]);
      return item;
    }
    const ascend = saveTagged('ascend', '昇腾 960 发布', '华为发布新加速芯片，未写英文缩写', today, ['ai_compute']);
    saveTagged('old', '昨天的算力新闻', 'GPU 集群扩产', yesterday, ['ai_compute']);
    saveTagged('other', '今天的存储新闻', 'HBM 涨价', today, ['semiconductor_memory']);
    const fixtures = services();
    fixtures.feedService = feedService;
    fixtures.taggingService = taggingService;
    const registry = createLocalToolRegistry(fixtures);
    assert.ok(registry.list().some((tool) => tool.id === 'feed.tag.search'));
    const catalog = await registry.execute('tag.list', {}, { workspaceId: 'local' });
    assert.ok(catalog.data.tags.some((tag) => tag.id === 'ai_compute'));
    const runtimeContext = buildRuntimeContext(new Date('2026-09-17T06:00:00.000Z'), 'Asia/Shanghai');
    const result = await registry.execute('feed.tag.search', { tag: '算力', timeRange: 'today' }, {
      workspaceId: 'local', runtimeContext,
    });
    assert.deepEqual(result.data.resolvedTags, [{ id: 'ai_compute', name: 'AI算力' }]);
    assert.equal(result.data.timeRange, 'today');
    assert.equal(result.data.matchedCount, 1);
    assert.equal(result.data.items[0].id, ascend.id);
    assert.match(result.data.items[0].title, /昇腾 960/);
    assert.equal(result.data.items.some((item) => item.title.includes('存储')), false);
    const keyword = feedService.searchContentItems('local', '算力 GPU NVIDIA', { limit: 20 });
    assert.equal(keyword.some((item) => item.id === ascend.id), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
