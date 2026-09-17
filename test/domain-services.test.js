import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { createTradingService } from '../packages/domain/src/trading-service.js';
import { createContextService } from '../packages/domain/src/context-service.js';
import { ValidationError } from '../packages/contracts/src/index.js';

function noOpRepository(extra = {}) {
  return new Proxy(extra, {
    get(target, property) {
      if (property in target) return target[property];
      return () => undefined;
    },
  });
}

function feedSourcePort(providers) {
  return {
    findByProvider(providerId) { return providers.has(providerId) ? { id: `content.${providerId}.test` } : null; },
    persistence(sourceId, input) {
      const providerId = sourceId.split('.')[1];
      return {
        providerId,
        sourceAccount: {
          externalId: providerId === 'bilibili' ? 'bilibili:imports' : `${providerId}:home:${input.feed || 'for-you'}`,
          displayName: providerId,
          profileUrl: providerId === 'bilibili' ? 'https://www.bilibili.com' : 'https://x.com/home',
          authMode: 'browser-session',
        },
      };
    },
    async read(sourceId, input) {
      const data = await providers.get(sourceId.split('.')[1]).getFeed(input);
      return { data };
    },
  };
}

function marketSourcePort(port) {
  return {
    async read(sourceId, input, context = {}) {
      if (sourceId === 'market.search') return { data: await port.search(input.query) };
      if (sourceId === 'market.quotes') return { data: await port.fetchQuotes(input.symbols, { refresh: context.refresh }) };
      if (sourceId === 'market.history') return { data: await port.fetchHistory(input.symbols, { ...input, refresh: context.refresh }) };
      return { data: await port.getBoard({ board: sourceId.slice('market.'.length), ...input }) };
    },
  };
}

test('feed service reads cached source items without calling the provider', async () => {
  let calls = 0;
  const stored = [{
    workspaceId: 'local',
    captureId: 'cap-1',
    externalId: '99',
    title: 'hello',
    body: 'hello',
    summary: 'hello',
    sourceUrl: 'https://x.com/user/status/99',
    authorName: 'user',
    publishedAt: 1,
  }];
  const service = createFeedService({
    legacyRepository: noOpRepository(),
    feedRepository: noOpRepository({
      listContentItemsByProvider() { return stored; },
    }),
    sourcePort: feedSourcePort(new Map([['x', { async getFeed() { calls += 1; return { items: [] }; } }]])),
  });
  const feed = await service.getExternalFeed('x', { feed: 'for-you', limit: 50, refresh: false });
  assert.equal(calls, 0);
  assert.equal(feed.mode, 'cached');
  assert.equal(feed.source, 'source-account');
  assert.equal(feed.items[0].externalId, '99');
});

test('feed service searches only persisted content items', () => {
  const service = createFeedService({
    legacyRepository: noOpRepository(),
    feedRepository: noOpRepository({
      listContentItems() {
        return [
          { id: 'older', title: '半导体回顾', summary: '', body: '库存改善', authorName: '', publishedAt: 10, createdAt: 10 },
          { id: 'newer', title: '市场动态', summary: '', body: '半导体需求改善', authorName: '', publishedAt: 20, createdAt: 20 },
          { id: 'other', title: '宏观', summary: '', body: '利率', authorName: '', publishedAt: 30, createdAt: 30 },
        ];
      },
    }),
    sourcePort: feedSourcePort(new Map()),
  });
  assert.deepEqual(service.searchContentItems('local', '半导体', { limit: 8 }).map((item) => item.id), ['newer', 'older']);
});

test('feed service attaches persisted translations to cached items', async () => {
  const { createHash } = await import('node:crypto');
  const body = 'NVIDIA announced a new HBM partnership.';
  const sourceHash = createHash('sha256').update(body).digest('hex');
  const service = createFeedService({
    legacyRepository: noOpRepository(),
    feedRepository: noOpRepository({
      listContentItemsByProvider() {
        return [{
          workspaceId: 'local',
          captureId: 'cap-1',
          externalId: '99',
          title: body,
          body,
          summary: body,
          sourceUrl: 'https://x.com/user/status/99',
          authorName: 'user',
          publishedAt: 1,
        }];
      },
      listTranslations() {
        return [{
          itemId: 'x:99',
          targetLang: 'zh',
          sourceHash,
          translatedText: '英伟达宣布了新的 HBM 合作。',
          engine: 'gemini',
          updatedAt: 1,
        }];
      },
    }),
    sourcePort: feedSourcePort(new Map([['x', { async getFeed() { return { items: [] }; } }]])),
  });
  const feed = await service.getExternalFeed('x', { feed: 'for-you', limit: 50, refresh: false });
  assert.equal(feed.items[0].translation.text, '英伟达宣布了新的 HBM 合作。');
});

test('feed service persists uploaded translations onto later feed reads', async () => {
  const saved = [];
  const body = 'Hello world';
  const service = createFeedService({
    legacyRepository: noOpRepository(),
    feedRepository: noOpRepository({
      saveTranslations(records) {
        saved.push(...records);
        return records;
      },
      listContentItemsByProvider() {
        return [{
          workspaceId: 'local',
          captureId: 'cap-1',
          externalId: '1',
          title: body,
          body,
          summary: body,
          sourceUrl: 'https://x.com/user/status/1',
          authorName: 'user',
          publishedAt: 1,
        }];
      },
      listTranslations() {
        return saved.map((row) => ({
          itemId: row.itemId,
          targetLang: row.targetLang,
          sourceHash: row.sourceHash,
          translatedText: row.translatedText,
          engine: row.engine,
          updatedAt: 1,
        }));
      },
    }),
    sourcePort: feedSourcePort(new Map([['x', { async getFeed() { return { items: [] }; } }]])),
  });
  service.persistItemTranslations([{
    id: 'x:1',
    sourceText: body,
    translatedText: '你好世界',
    engine: 'gemini',
    targetLang: 'zh',
  }]);
  const feed = await service.getExternalFeed('x', { feed: 'for-you', limit: 50, refresh: false });
  assert.equal(saved[0].itemId, 'x:1');
  assert.equal(feed.items[0].translation.text, '你好世界');
});

test('feed service persists captured x items through the repository', async () => {
  const saved = [];
  const stored = [];
  const hashes = new Map();
  const service = createFeedService({
    legacyRepository: noOpRepository(),
    feedRepository: noOpRepository({
      upsertSourceAccount(input) { return { id: 'source-1', ...input }; },
      upsertSubscription(input) { return { id: 'sub-1', ...input }; },
      getCapture(_workspaceId, _provider, externalId) {
        const hash = hashes.get(String(externalId));
        return hash ? { contentHash: hash } : null;
      },
      saveCapture(input) {
        hashes.set(String(input.externalId), input.contentHash);
        saved.push(['capture', input.externalId, input.capturedAt]);
        return { id: `cap-${input.externalId}` };
      },
      saveContentItem(input) {
        saved.push(['item', input.captureId]);
        stored.push({
          workspaceId: 'local',
          captureId: input.captureId,
          externalId: input.captureId.replace('cap-', ''),
          title: input.title,
          body: input.body,
          summary: input.summary,
          sourceUrl: input.sourceUrl,
          authorName: input.authorName,
          publishedAt: input.publishedAt,
          capturedAt: saved.find((row) => row[0] === 'capture' && `cap-${row[1]}` === input.captureId)?.[2],
        });
        return { id: 'item-1' };
      },
      listContentItemsByProvider() {
        return [...stored].sort((left, right) => (right.capturedAt || 0) - (left.capturedAt || 0));
      },
    }),
    sourcePort: feedSourcePort(new Map([['x', {
      async getFeed() {
        return {
          feed: 'for-you',
          mode: 'live',
          note: 'live',
          items: [{
            externalId: 'first',
            title: 'first in timeline',
            body: 'first',
            summary: 'first',
            sourceUrl: 'https://x.com/user/status/first',
            authorName: 'user',
            publishedAt: 1,
          }, {
            externalId: 'second',
            title: 'second in timeline',
            body: 'second',
            summary: 'second',
            sourceUrl: 'https://x.com/user/status/second',
            authorName: 'user',
            publishedAt: 9_000,
          }],
        };
      },
    }]])),
  });
  const feed = await service.getExternalFeed('x', { feed: 'for-you', limit: 50, refresh: true });
  assert.equal(feed.items[0].externalId, 'first');
  assert.equal(saved[0][1], 'first');
  assert.equal(saved[2][1], 'second');
  assert.ok(saved[0][2] > saved[2][2]);
  const again = await service.getExternalFeed('x', { feed: 'for-you', limit: 50, refresh: true });
  assert.match(again.note, /去重/);
});

test('feed service keeps 没有 when bilibili has no ai-zh transcript', async () => {
  const service = createFeedService({
    legacyRepository: noOpRepository(),
    feedRepository: noOpRepository({
      listContentItemsByProvider() { return []; },
    }),
    sourcePort: feedSourcePort(new Map([['bilibili', {
      async getFeed() {
        return { feed: 'imports', mode: 'unavailable', note: '没有', items: [] };
      },
    }]])),
  });
  const feed = await service.getExternalFeed('bilibili', { feed: 'imports', url: 'BV1cwtN6sEDr', refresh: true });
  assert.equal(feed.note, '没有');
  assert.equal(feed.items.length, 0);
});

test('feed service stores original transcript separately from formatted body', async () => {
  const captures = [];
  const stored = [];
  const service = createFeedService({
    legacyRepository: noOpRepository(),
    feedRepository: noOpRepository({
      upsertSourceAccount(input) { return { id: 'source-bili', ...input }; },
      upsertSubscription(input) { return { id: 'sub-bili', ...input }; },
      saveCapture(input) {
        captures.push(input);
        return { id: 'cap-bv' };
      },
      saveContentItem(input) {
        stored.push(input);
        return { id: 'item-bv' };
      },
      listContentItemsByProvider() {
        return stored.map((item) => ({
          ...item,
          workspaceId: 'local',
          externalId: 'BV1cwtN6sEDr',
        }));
      },
    }),
    sourcePort: feedSourcePort(new Map([['bilibili', {
      async getFeed() {
        return {
          feed: 'imports',
          mode: 'live',
          note: 'live',
          items: [{
            externalId: 'BV1cwtN6sEDr',
            title: '研读专利',
            body: '# 标题\n\n整理后的正文',
            summary: '整理后的正文',
            originalText: '口播原文不断句',
            formatEngine: 'gemini',
            sourceUrl: 'https://www.bilibili.com/video/BV1cwtN6sEDr',
            authorName: 'UP',
            publishedAt: 1,
            originType: 'import',
            contentType: 'transcript',
          }],
        };
      },
    }]])),
  });
  const feed = await service.getExternalFeed('bilibili', { feed: 'imports', url: 'BV1', refresh: true });
  assert.equal(captures[0].metadata.originalText, '口播原文不断句');
  assert.equal(stored[0].body, '# 标题\n\n整理后的正文');
  assert.equal(feed.items[0].body, '# 标题\n\n整理后的正文');
});

test('feed service rejects unknown external providers', async () => {
  const service = createFeedService({
    legacyRepository: noOpRepository(),
    feedRepository: noOpRepository(),
    sourcePort: feedSourcePort(new Map()),
  });
  await assert.rejects(() => service.getExternalFeed('missing', {}), ValidationError);
});

test('trading service uses a market-data port without provider-specific fields', async () => {
  const calls = [];
  const service = createTradingService({
    tradingRepository: noOpRepository(),
    sourcePort: marketSourcePort({
      async getBoard(query) { calls.push(['board', query]); return { board: query.board }; },
      async search(query) { calls.push(['search', query]); return [{ symbol: query }]; },
    }),
  });
  assert.deepEqual(await service.getBoard({ board: 'us' }), { board: 'us' });
  assert.deepEqual(await service.search('AAPL'), [{ symbol: 'AAPL' }]);
  assert.deepEqual(calls, [['board', { board: 'us' }], ['search', 'AAPL']]);
  const dashboard = await service.getPersonalAssetDashboard();
  assert.equal(dashboard.source, 'workbook');
  assert.equal(dashboard.points.length, 0);
});

test('context service combines current knowledge, relevant feed, and holdings through domain ports', async () => {
  const service = createContextService({
    knowledgeService: { search() { return [{ knowledgeId: 'knowledge-1', revision: 3, title: '我的投资方法', snippet: '观察盈利预期' }]; } },
    feedService: { listContentItems() { return [{ id: 'content-1', title: '半导体行业动态', publishedAt: 100 }]; } },
    tradingService: { async getHoldingsBoard() { return { updatedAt: 200, summary: { totalCny: '1' } }; } },
  });
  const context = await service.build({ query: '今天市场对我的持仓有什么影响？' });
  assert.equal(context.knowledge[0].revision, 3);
  assert.equal(context.recentFeed[0].id, 'content-1');
  assert.equal(context.holdings.updatedAt, 200);
  assert.deepEqual(context.refs.map((item) => item.resourceType), ['knowledge-revision', 'content-item', 'holdings-board']);
});

test('context service resolves user-selected references without searching', async () => {
  const service = createContextService({
    knowledgeService: {
      getInspiration() { return { id: 'note-1', body: 'HBM 产能挤占', updatedAt: 2, createdAt: 1 }; },
      getCurrentRevision() { return { knowledgeId: 'k-1', revision: 2, title: '存储', body: '周期判断', createdAt: 3 }; },
      getRevision() { return null; },
      getAgentRun() { return { id: 'run-1', inputText: '怎么看', outputText: '供给偏紧', createdAt: 4 }; },
      search() { return []; },
    },
    feedService: {
      getContentItem(_workspaceId, id) {
        if (id !== 'content-1') return null;
        return { id: 'content-1', title: 'SK海力士', body: 'HBM4 进度', sourceUrl: 'https://x.com/a/status/1', createdAt: 5 };
      },
      getLegacyPost() { return { id: 'post-1', title: '手工', body: '备忘', sourceUrl: '', createdAt: 6 }; },
      listContentItems() { return []; },
    },
    tradingService: { async getHoldingsBoard() { return null; } },
  });
  const resolved = await service.resolveReferences({
    workspaceId: 'local',
    references: [
      { resourceType: 'content-item', resourceId: 'content-1' },
      { resourceType: 'inspiration', resourceId: 'note-1' },
      { resourceType: 'content-item', resourceId: 'missing' },
    ],
  });
  assert.equal(resolved.items.length, 2);
  assert.equal(resolved.missing.length, 1);
  assert.equal(resolved.refs[0].origin, 'selected');
  assert.match(resolved.promptText, /用户主动引用/);
  assert.match(resolved.promptText, /SK海力士/);
  assert.match(resolved.promptText, /不要再用工具搜索/);
});
