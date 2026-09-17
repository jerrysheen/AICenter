import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  DomainEventSchema,
  InstrumentSchema,
  parseContract,
  TransactionSchema,
  ValidationError,
} from '../packages/contracts/src/index.js';
import { createStore } from '../packages/database/src/index.js';
import { createCapabilityRegistry } from '../packages/runtime/src/capability-registry.js';

function temporaryStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-domain-'));
  const databasePath = path.join(directory, 'test.db');
  return {
    directory,
    databasePath,
    store: createStore(databasePath),
    remove() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test('domain contracts keep decimal values exact and events versioned', () => {
  const now = Date.now();
  assert.equal(parseContract(InstrumentSchema, {
    id: 'instrument-1', canonicalKey: 'US:XNAS:AAPL', symbol: 'AAPL', name: 'Apple',
    assetClass: 'equity', market: 'us', exchangeCode: 'XNAS', currency: 'USD',
    metadata: {}, createdAt: now, updatedAt: now,
  }).canonicalKey, 'US:XNAS:AAPL');
  assert.throws(() => parseContract(TransactionSchema, {
    id: 'tx-1', workspaceId: 'local', portfolioId: 'p-1', instrumentId: 'i-1', type: 'buy',
    quantity: 1.25, price: '100.01', cashAmount: '-125.0125', currency: 'USD', fees: '0',
    note: '', occurredAt: now, createdAt: now,
  }), ValidationError);
  assert.throws(() => parseContract(DomainEventSchema, {
    id: 1, workspaceId: 'local', name: 'feed.created', schemaVersion: 1,
    aggregateType: 'content-item', aggregateId: 'item-1', payload: {}, correlationId: null,
    causationId: null, occurredAt: now, createdAt: now,
  }), ValidationError);
});

test('feed repository stores provider-neutral capture and content records', () => {
  const temporary = temporaryStore();
  const source = temporary.store.repositories.feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'bilibili', externalId: '472747194', displayName: '结构笔记',
  });
  const subscription = temporary.store.repositories.feed.upsertSubscription({
    workspaceId: 'local', sourceAccountId: source.id, priority: 'high',
  });
  const capture = temporary.store.repositories.feed.saveCapture({
    workspaceId: 'local', provider: 'bilibili', externalId: 'BV-test', sourceAccountId: source.id,
    sourceUrl: 'https://www.bilibili.com/video/BV-test', contentHash: 'sha256-test',
    rawArtifactPath: 'blobs/captures/test.json', publishedAt: 1,
  });
  const item = temporary.store.repositories.feed.saveContentItem({
    workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'video',
    title: '测试视频', body: '标准化内容', sourceUrl: capture.sourceUrl, publishedAt: 1,
  });
  assert.equal(item.captureId, capture.id);
  assert.equal(subscription.priority, 'high');
  assert.equal(temporary.store.repositories.feed.listDueSubscriptions()[0].id, subscription.id);
  assert.equal(temporary.store.repositories.feed.listContentItems('local')[0].title, '测试视频');
  assert.equal(temporary.store.repositories.feed.listContentItemsByProvider('local', 'bilibili')[0].externalId, 'BV-test');
  assert.equal(temporary.store.repositories.feed.getContentItem('local', item.id).body, '标准化内容');
  const olderTweet = temporary.store.repositories.feed.saveCapture({
    workspaceId: 'local', provider: 'x', externalId: 'old-tweet', sourceAccountId: source.id,
    sourceUrl: 'https://x.com/user/status/old-tweet', contentHash: 'sha256-old',
    publishedAt: 9_000, capturedAt: 100,
  });
  const newerCapture = temporary.store.repositories.feed.saveCapture({
    workspaceId: 'local', provider: 'x', externalId: 'new-tweet', sourceAccountId: source.id,
    sourceUrl: 'https://x.com/user/status/new-tweet', contentHash: 'sha256-new',
    publishedAt: 1, capturedAt: 200,
  });
  temporary.store.repositories.feed.saveContentItem({
    workspaceId: 'local', captureId: olderTweet.id, originType: 'subscription', contentType: 'post',
    title: '更早抓到但发得晚', body: 'old', sourceUrl: olderTweet.sourceUrl, publishedAt: 9_000,
  });
  temporary.store.repositories.feed.saveContentItem({
    workspaceId: 'local', captureId: newerCapture.id, originType: 'subscription', contentType: 'post',
    title: '刚抓到的旧推', body: 'new', sourceUrl: newerCapture.sourceUrl, publishedAt: 1,
  });
  assert.equal(temporary.store.repositories.feed.listContentItemsByProvider('local', 'x')[0].externalId, 'new-tweet');
  assert.ok(temporary.store.listEvents(0).some((event) => event.name === 'feed.content-item.saved.v1'));
  const translation = temporary.store.repositories.feed.saveTranslations([{
    workspaceId: 'local',
    itemId: 'bilibili:BV-test',
    targetLang: 'zh',
    sourceHash: 'sha256-body',
    translatedText: '标准化内容的译文',
    engine: 'gemini',
  }])[0];
  assert.equal(translation.translatedText, '标准化内容的译文');
  temporary.store.close();
  const reopened = createStore(temporary.databasePath);
  assert.equal(reopened.repositories.feed.listTranslations('local', ['bilibili:BV-test'], 'zh')[0].translatedText, '标准化内容的译文');
  reopened.close();
  temporary.remove();
});

test('hidden content items leave the provider feed but stay readable by id', () => {
  const temporary = temporaryStore();
  const feed = temporary.store.repositories.feed;
  const source = feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'x', externalId: 'home', displayName: 'X',
  });
  const capture = feed.saveCapture({
    workspaceId: 'local', provider: 'x', externalId: 'hide-me', sourceAccountId: source.id,
    sourceUrl: 'https://x.com/user/status/hide-me', contentHash: 'sha256-hide',
  });
  const item = feed.saveContentItem({
    workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
    title: '待删除', body: '正文', sourceUrl: capture.sourceUrl,
  });
  assert.equal(feed.listContentItemsByProvider('local', 'x').length, 1);
  const state = feed.upsertUserItemState({
    workspaceId: 'local', contentItemId: item.id, isHidden: true,
  });
  assert.equal(state.isHidden, true);
  assert.equal(feed.listContentItemsByProvider('local', 'x').length, 0);
  assert.equal(feed.getContentItem('local', item.id).title, '待删除');
  const post = temporary.store.createPost({ title: '手工', body: '本地一条', sourceUrl: '', tags: [] });
  assert.equal(temporary.store.hidePost(post.id), true);
  assert.equal(temporary.store.listPosts().some((row) => row.id === post.id), false);
  temporary.store.close();
  temporary.remove();
});

test('trading repository separates canonical instruments from provider aliases', () => {
  const temporary = temporaryStore();
  const trading = temporary.store.repositories.trading;
  const instrument = trading.upsertInstrument({
    canonicalKey: 'US:XNAS:AAPL', symbol: 'AAPL', name: 'Apple', assetClass: 'equity',
    market: 'us', exchangeCode: 'XNAS', currency: 'USD', metadata: {},
  });
  trading.upsertInstrumentAlias({
    instrumentId: instrument.id, providerId: 'yahoo', providerSymbol: 'AAPL', metadata: {},
  });
  const portfolio = trading.createPortfolio({
    workspaceId: 'local', name: '美股账户', marketScope: 'us', baseCurrency: 'USD',
    initialCapital: '10000.00',
  });
  const transaction = trading.appendTransaction({
    workspaceId: 'local', portfolioId: portfolio.id, instrumentId: instrument.id, type: 'buy',
    quantity: '0.12345678', price: '187.2301', cashAmount: '-23.0637639278', currency: 'USD',
    fees: '0.01', note: '', occurredAt: Date.now(),
  });
  assert.equal(trading.getInstrumentByAlias('yahoo', 'AAPL').canonicalKey, 'US:XNAS:AAPL');
  assert.equal(transaction.quantity, '0.12345678');
  assert.equal(trading.listTransactions(portfolio.id)[0].cashAmount, '-23.0637639278');
  temporary.store.close();
  temporary.remove();
});

test('knowledge repository preserves revision history and search index', () => {
  const temporary = temporaryStore();
  const knowledge = temporary.store.repositories.knowledge;
  const document = knowledge.createDocument({
    workspaceId: 'local', title: '可插拔架构', body: '第一版原文', createdByType: 'user', metadata: {},
  });
  knowledge.addRevision({
    knowledgeId: document.id, title: '可插拔架构', body: '第二版加入领域端口',
    createdByType: 'agent', createdById: 'agent-1',
  });
  assert.deepEqual(knowledge.listRevisions(document.id).map((item) => item.revision), [2, 1]);
  assert.equal(knowledge.search('local', '领域端口')[0].knowledgeId, document.id);
  const first = knowledge.recordAgentRun({
    jobId: 'job-1', workspaceId: 'local', message: '今天持仓如何', answer: 'A股小涨',
    providerId: 'fake', modelId: 'fake',
    refs: [{ resourceType: 'knowledge-revision', resourceId: document.id, revision: 2, asOf: null, label: '可插拔架构' }],
  });
  knowledge.recordAgentRun({
    jobId: 'job-2', workspaceId: 'local', sessionId: first.sessionId,
    message: '现金呢', answer: '现金充足', providerId: 'fake', modelId: 'fake',
  });
  const retry = knowledge.recordAgentRun({
    jobId: 'job-1', workspaceId: 'local', message: '今天持仓如何', answer: '不应重复写入',
    providerId: 'fake', modelId: 'fake',
  });
  assert.equal(retry.id, first.id);
  const listed = knowledge.listSessions('local');
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].runCount, 2);
  const detail = knowledge.getSessionDetail('local', first.sessionId);
  assert.equal(detail.exchanges[1].question, '现金呢');
  assert.equal(detail.exchanges[0].refs[0].resourceId, document.id);
  assert.equal(temporary.store.listEvents(0).filter((event) => event.name === 'knowledge.ai-run.completed.v1').length, 2);
  const archived = temporary.store.archiveNote(
    temporary.store.createNote({ body: '存储周期里 DDR3 可能受益于旧产能退出', wantAi: false }).id,
  );
  assert.equal(knowledge.search('local', 'DDR3')[0].knowledgeId, archived.knowledgeId);
  temporary.store.close();
  temporary.remove();
});

test('stale job recovery does not reset a fresh lease', async () => {
  const temporary = temporaryStore();
  const job = temporary.store.createJob({ type: 'test.retry', input: {}, maxAttempts: 3 });
  const claimed = temporary.store.claimNextJob('worker-a', ['test.retry']);
  assert.equal(claimed.status, 'running');
  assert.equal(temporary.store.recoverStaleJobs(10 * 60_000, claimed.lockedAt + 1_000), 0);
  assert.equal(temporary.store.getJob(job.id).status, 'running');
  assert.equal(temporary.store.getJob(job.id).lockedBy, 'worker-a');
  temporary.store.close();
  temporary.remove();
});

test('expired lease can be recovered and late complete or fail is ignored', async () => {
  const temporary = temporaryStore();
  const job = temporary.store.createJob({ type: 'test.retry', input: {}, maxAttempts: 3 });
  const first = temporary.store.claimNextJob('worker-a', ['test.retry']);
  assert.equal(temporary.store.recoverStaleJobs(1_000, first.lockedAt + 2_000), 1);
  assert.equal(temporary.store.getJob(job.id).status, 'queued');
  const second = temporary.store.claimNextJob('worker-b', ['test.retry']);
  assert.equal(second.attemptCount, 2);
  const lateComplete = temporary.store.completeJob(job.id, { from: 'stale' }, {
    workerId: 'worker-a', attemptCount: 1,
  });
  assert.equal(lateComplete.status, 'running');
  assert.equal(lateComplete.lockedBy, 'worker-b');
  const lateFail = temporary.store.failJob(job.id, new Error('stale fail'), 0, {
    workerId: 'worker-a', attemptCount: 1,
  });
  assert.equal(lateFail.status, 'running');
  const completed = temporary.store.completeJob(job.id, { from: 'current' }, {
    workerId: 'worker-b', attemptCount: 2,
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.output, { from: 'current' });
  temporary.store.close();
  temporary.remove();
});

test('job attempts are retained independently from final job state', async () => {
  const temporary = temporaryStore();
  const job = temporary.store.createJob({ type: 'test.retry', input: {} });
  temporary.store.claimNextJob('worker-a', ['test.retry']);
  temporary.store.failJob(job.id, new Error('first failure'), 0, { workerId: 'worker-a', attemptCount: 1 });
  temporary.store.claimNextJob('worker-b', ['test.retry']);
  temporary.store.completeJob(job.id, { ok: true }, { workerId: 'worker-b', attemptCount: 2 });
  temporary.store.close();
  const database = new Database(temporary.databasePath, { readonly: true });
  const attempts = database.prepare(`SELECT attempt_number, worker_id, status FROM job_attempts
    WHERE job_id = ? ORDER BY attempt_number`).all(job.id);
  assert.deepEqual(attempts, [
    { attempt_number: 1, worker_id: 'worker-a', status: 'failed' },
    { attempt_number: 2, worker_id: 'worker-b', status: 'completed' },
  ]);
  database.close();
  temporary.remove();
});

test('capability registry rejects undeclared and duplicate job handlers', () => {
  const registry = createCapabilityRegistry();
  registry.register({
    manifest: {
      id: 'connector.bilibili', version: '1.0.0', capabilities: ['feed.capture'],
      jobTypes: ['feed.bilibili.sync'],
    },
    jobHandlers: { 'feed.bilibili.sync': async () => ({ ok: true }) },
  });
  assert.equal(registry.findByCapability('feed.capture')[0].id, 'connector.bilibili');
  assert.equal(typeof registry.createJobHandlers()['feed.bilibili.sync'], 'function');
  assert.throws(() => registry.register({
    manifest: {
      id: 'connector.bad', version: '1.0.0', capabilities: ['feed.capture'], jobTypes: [],
    },
    jobHandlers: { 'feed.bad.sync': async () => ({}) },
  }), ValidationError);
});
