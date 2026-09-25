import test from 'node:test';
import assert from 'node:assert/strict';
import { FeedIdentityFingerprintSchema, parseBehaviorEvent, parseBilibiliFeedQuery, parseBilibiliImportInput, parseBuildContextInput, parseContract, parseCreateAgentRunInput, parseCreateWorkPackageInput, parseHoldingsQuery, parseKnowledgeMentionQuery, parseLoginInput, parseMarketQuery, parseNoteInput, parsePackReferencesInput, parsePageRequest, parsePairInput, parsePersistFeedTranslationsInput, parsePostInput, parseTranslateBatchInput, parseTranslateInput, parseTrendForceFeedQuery, parseWorkerJobConcurrency, parseXFeedQuery, parseXueqiuFeedQuery, PortfolioImportSchema, UpsertFeedIdentityFingerprintInputSchema, ValidationError } from '../packages/contracts/src/index.js';

test('post input normalizes title, url, and tags', () => {
  assert.deepEqual(parsePostInput({
    title: '  首发信息  ',
    body: '  手机与电脑同步  ',
    sourceUrl: 'https://example.com/article',
    tags: '测试, 系统,测试',
  }), {
    title: '首发信息',
    body: '手机与电脑同步',
    sourceUrl: 'https://example.com/article',
    tags: ['测试', '系统'],
  });
});

test('post input requires title or body', () => {
  assert.throws(() => parsePostInput({}), ValidationError);
});

test('pair and behavior inputs reject unsupported data', () => {
  assert.deepEqual(parsePairInput({ code: '123456', deviceName: '鸿蒙手机' }), {
    code: '123456', deviceName: '鸿蒙手机',
  });
  assert.throws(() => parseBehaviorEvent({ name: 'unknown.event' }), ValidationError);
});

test('login input requires username, password, and device name', () => {
  assert.deepEqual(parseLoginInput({
    username: ' owner ',
    password: ' secret-pass ',
    deviceName: '浏览器设备',
  }), {
    username: 'owner',
    password: 'secret-pass',
    deviceName: '浏览器设备',
  });
  assert.throws(() => parseLoginInput({ username: 'owner', deviceName: '浏览器设备' }), ValidationError);
});

test('market query accepts us asia cn overview and global', () => {
  assert.equal(parseMarketQuery({ board: 'asia' }).board, 'asia');
  assert.equal(parseMarketQuery({ board: 'cn' }).board, 'cn');
  assert.equal(parseMarketQuery({ board: 'global' }).board, 'global');
  assert.throws(() => parseMarketQuery({ board: 'crypto' }), ValidationError);
});

test('x feed query defaults to 50 home timeline items', () => {
  assert.deepEqual(parseXFeedQuery({}), {
    platform: 'x', feed: 'for-you', limit: 50, refresh: false,
  });
  assert.equal(parseXFeedQuery({ refresh: '1' }).refresh, true);
  assert.equal(parseXFeedQuery({ feed: 'following', limit: '50' }).feed, 'following');
  assert.throws(() => parseXFeedQuery({ limit: '80' }), ValidationError);
});

test('xueqiu feed query maps following featured and livenews', () => {
  assert.deepEqual(parseXueqiuFeedQuery({}), {
    platform: 'xueqiu', feed: 'following', limit: 50, refresh: false,
  });
  assert.equal(parseXueqiuFeedQuery({ feed: '7x24', refresh: '1' }).feed, 'livenews');
  assert.equal(parseXueqiuFeedQuery({ feed: 'featured' }).feed, 'featured');
  assert.throws(() => parseXueqiuFeedQuery({ platform: 'x' }), ValidationError);
});

test('trendforce feed query is the public page only', () => {
  assert.deepEqual(parseTrendForceFeedQuery({}), {
    platform: 'trendforce', feed: 'public', refresh: false,
  });
  assert.equal(parseTrendForceFeedQuery({ refresh: '1' }).refresh, true);
  assert.throws(() => parseTrendForceFeedQuery({ platform: 'x' }), ValidationError);
});

test('bilibili import accepts share text and requires a link', () => {
  assert.deepEqual(parseBilibiliFeedQuery({}), {
    platform: 'bilibili', feed: 'imports', url: '', refresh: false,
  });
  assert.equal(parseBilibiliImportInput({
    url: '【研读1081份专利后，我终于搞懂了华为为什么要做阔直板-哔哩哔哩】 https://b23.tv/BV1cwtN6sEDr',
  }).url.includes('b23.tv/BV1cwtN6sEDr'), true);
  assert.throws(() => parseBilibiliImportInput({}), ValidationError);
});

test('holdings query treats refresh=1 as a live quote fetch', () => {
  assert.deepEqual(parseHoldingsQuery({}), { refresh: false });
  assert.equal(parseHoldingsQuery({ refresh: '1' }).refresh, true);
});

test('portfolio import contract is strict, decimal-safe, and validates account references', () => {
  const valid = {
    schemaVersion: 1,
    mode: 'merge',
    accounts: [{
      id: 'synthetic-account', name: '合成账户', marketScope: 'cn', baseCurrency: 'CNY', initialCapital: '0',
    }],
    positions: [{
      id: 'synthetic-lot', portfolioId: 'synthetic-account', board: 'a_share', quantity: '12.5',
      costPrice: '10.01', listingCurrency: 'CNY', note: '', openedAt: null,
      instrument: {
        id: 'synthetic-instrument', canonicalKey: 'CN:XSHG:600000', symbol: '600000', name: '合成证券',
        assetClass: 'equity', market: 'cn', exchangeCode: 'XSHG', currency: 'CNY', metadata: {},
      },
      aliases: [{ providerId: 'fixture', providerSymbol: 'SYNTHETIC', metadata: {} }],
    }],
    cash: [{ portfolioId: 'synthetic-account', currency: 'CNY', amount: '100.25' }],
  };
  assert.equal(parseContract(PortfolioImportSchema, valid).positions[0].quantity, '12.5');
  assert.throws(() => parseContract(PortfolioImportSchema, {
    ...valid,
    positions: [{ ...valid.positions[0], quantity: 12.5 }],
  }), ValidationError);
  assert.throws(() => parseContract(PortfolioImportSchema, {
    ...valid,
    positions: [{ ...valid.positions[0], portfolioId: 'missing-account' }],
  }), ValidationError);
  assert.throws(() => parseContract(PortfolioImportSchema, { ...valid, replace: true }), ValidationError);
});

test('note input requires body', () => {
  assert.deepEqual(parseNoteInput({
    body: '  一条灵感  ',
    wantAi: 1,
    sourceUrl: 'https://example.com/article',
    sourceTitle: ' 示例文章 ',
    sourceType: 'external-share',
    captureChannel: 'harmony-share',
    sourceApp: 'com.example.browser',
  }), {
    title: '',
    body: '一条灵感',
    inspirationType: '',
    wantAi: true,
    sourceType: 'external-share',
    sourceId: '',
    sourceUrl: 'https://example.com/article',
    sourceTitle: '示例文章',
    captureChannel: 'harmony-share',
    sourceApp: 'com.example.browser',
    clientMutationId: '',
    attachmentIds: [],
  });
  assert.throws(() => parseNoteInput({ body: '' }), ValidationError);
  assert.throws(() => parseNoteInput({ body: '非法链接', sourceUrl: 'javascript:alert(1)' }), ValidationError);
  assert.throws(() => parseNoteInput({ body: '非法入口', captureChannel: 'unknown' }), ValidationError);
  assert.equal(parseCreateWorkPackageInput({ body: '  底栏裁切  ' }).body, '底栏裁切');
});

test('translate input defaults to chinese', () => {
  assert.deepEqual(parseTranslateInput({ text: ' hello ' }), { text: 'hello', targetLang: 'zh' });
  assert.deepEqual(parseTranslateInput({ id: 'x:1', text: 'hello' }), { id: 'x:1', text: 'hello', targetLang: 'zh' });
  assert.throws(() => parseTranslateInput({ text: '' }), ValidationError);
});

test('translate batch input keeps ids and caps at 30 items', () => {
  assert.deepEqual(parseTranslateBatchInput({
    items: [{ id: 'x:1', text: ' hello ' }, { id: 'x:2', body: 'world' }],
  }), {
    targetLang: 'zh',
    items: [{ id: 'x:1', text: 'hello' }, { id: 'x:2', text: 'world' }],
  });
  assert.ok(parseTranslateBatchInput({ items: [{ id: 'x:1', text: 'a'.repeat(5_000) }] }).items[0].text.length === 5_000);
  assert.throws(() => parseTranslateBatchInput({ items: [] }), ValidationError);
  assert.throws(() => parseTranslateBatchInput({
    items: Array.from({ length: 31 }, (_, index) => ({ id: `x:${index}`, text: 'hello' })),
  }), ValidationError);
});

test('persist feed translations keeps item ids and source text', () => {
  assert.deepEqual(parsePersistFeedTranslationsInput({
    translations: [{ id: 'x:1', sourceText: ' hello ', translatedText: ' 你好 ', engine: 'gemini' }],
  }), {
    targetLang: 'zh',
    translations: [{
      id: 'x:1',
      sourceText: 'hello',
      translatedText: '你好',
      engine: 'gemini',
      targetLang: 'zh',
    }],
  });
  assert.throws(() => parsePersistFeedTranslationsInput({ translations: [] }), ValidationError);
});

test('context input defaults to the local workspace and bounded result count', () => {
  assert.deepEqual(parseBuildContextInput({ query: '今天市场发生了什么？' }), {
    workspaceId: 'local', query: '今天市场发生了什么？', limit: 8,
  });
  assert.throws(() => parseBuildContextInput({ query: '' }), ValidationError);
  assert.throws(() => parseBuildContextInput({ query: '有效问题', limit: 21 }), ValidationError);
});

test('reference pack input reuses the same selected-reference contract', () => {
  assert.deepEqual(parsePackReferencesInput({
    references: [{ resourceType: 'content-item', resourceId: 'item-1' }],
  }), {
    references: [{ resourceType: 'content-item', resourceId: 'item-1' }],
  });
  assert.deepEqual(parsePackReferencesInput({}).references, []);
  assert.throws(() => parsePackReferencesInput({
    references: [{ resourceType: 'stock', resourceId: '1' }],
  }), ValidationError);
  assert.throws(() => parsePackReferencesInput({
    references: Array.from({ length: 9 }, (_, index) => (
      { resourceType: 'content-item', resourceId: `item-${index}` }
    )),
  }), ValidationError);
});

test('knowledge mention query defaults and caps the list', () => {
  assert.deepEqual(parseKnowledgeMentionQuery({}), { q: '', limit: 8 });
  assert.equal(parseKnowledgeMentionQuery({ q: ' 框架 ', limit: '5' }).q, '框架');
  assert.equal(parseKnowledgeMentionQuery({ q: '框架', limit: '5' }).limit, 5);
  assert.throws(() => parseKnowledgeMentionQuery({ limit: 99 }), ValidationError);
});

test('agent run input accepts selected references', () => {
  assert.deepEqual(parseCreateAgentRunInput({
    message: '结合起来怎么看',
    references: [{ resourceType: 'content-item', resourceId: 'item-1' }],
  }).references, [{ resourceType: 'content-item', resourceId: 'item-1' }]);
  assert.equal(parseCreateAgentRunInput({ message: '你好' }).webMode, 'off');
  assert.equal(parseCreateAgentRunInput({ message: '你好', webMode: 'fallback' }).webMode, 'fallback');
  assert.equal(parseCreateAgentRunInput({ message: '你好' }).researchMode, 'standard');
  assert.equal(parseCreateAgentRunInput({ message: '你好', researchMode: 'research' }).researchMode, 'research');
  assert.throws(() => parseCreateAgentRunInput({ message: '你好', webMode: 'remote' }), ValidationError);
  assert.throws(() => parseCreateAgentRunInput({ message: '你好', researchMode: 'deep' }), ValidationError);
  assert.throws(() => parseCreateAgentRunInput({
    message: '你好',
    references: [{ resourceType: 'stock', resourceId: '1' }],
  }), ValidationError);
});

test('agent run input accepts an optional session id', () => {
  assert.equal(parseCreateAgentRunInput({ message: ' 持仓如何 ' }).message, '持仓如何');
  assert.equal(parseCreateAgentRunInput({ message: '继续', sessionId: 'new' }).sessionId, undefined);
  assert.equal(parseCreateAgentRunInput({ message: '继续', sessionId: 'session-1' }).sessionId, 'session-1');
  assert.throws(() => parseCreateAgentRunInput({ message: '' }), ValidationError);
});

test('feed identity fingerprint is a durable hash id without tweet text', () => {
  const now = Date.now();
  assert.equal(parseContract(FeedIdentityFingerprintSchema, {
    workspaceId: 'local',
    provider: 'x',
    identityHash: 'a'.repeat(64),
    externalId: '123',
    hiddenAt: now,
    firstSeenAt: now,
    lastSeenAt: now,
  }).identityHash.length, 64);
  assert.equal(parseContract(UpsertFeedIdentityFingerprintInputSchema, {
    workspaceId: 'local',
    provider: 'x',
    identityHash: 'b'.repeat(64),
  }).externalId, '');
  assert.throws(() => parseContract(FeedIdentityFingerprintSchema, {
    workspaceId: 'local',
    provider: 'x',
    identityHash: '',
    hiddenAt: null,
    firstSeenAt: now,
    lastSeenAt: now,
  }), ValidationError);
  assert.throws(() => parseContract(UpsertFeedIdentityFingerprintInputSchema, {
    workspaceId: 'local',
    provider: 'x',
    identityHash: 'c'.repeat(64),
    body: 'should not be stored',
  }), ValidationError);
});

test('worker job concurrency defaults to three work-package CLI slots', () => {
  assert.deepEqual(parseWorkerJobConcurrency({}), {
    defaultLimit: 1,
    workPackageDispatchLimit: 3,
    quantLabLimit: 1,
  });
  assert.equal(parseWorkerJobConcurrency({ workPackageDispatchLimit: '3' }).workPackageDispatchLimit, 3);
  assert.equal(parseWorkerJobConcurrency({ workPackageDispatchLimit: 8 }).workPackageDispatchLimit, 8);
  assert.throws(() => parseWorkerJobConcurrency({ workPackageDispatchLimit: 0 }), ValidationError);
  assert.throws(() => parseWorkerJobConcurrency({ workPackageDispatchLimit: 9 }), ValidationError);
});

test('page request keeps an opaque cursor and bounded limit', () => {
  assert.deepEqual(parsePageRequest({}), { limit: 50 });
  assert.equal(parsePageRequest({ limit: '20', cursor: ' abc ' }).limit, 20);
  assert.throws(() => parsePageRequest({ limit: 0 }), ValidationError);
});
