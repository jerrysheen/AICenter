import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { createStore } from '../packages/database/src/index.js';
import { createHarnessUsageObserver } from '../packages/harness/src/model-usage-observer.js';
import { createHarnessAgentRuntime } from '../packages/harness/src/harness-agent-runtime.js';
import { createToolRegistry } from '../packages/runtime/src/tool-registry.js';
import { withModelUsageContext } from '../packages/runtime/src/model-usage-context.js';
import { createUsageFetch } from '../packages/connectors/src/model-usage-fetch.js';
import { providerTokenUsage } from '../packages/connectors/src/model-usage-fetch.js';
import { createTranslateService } from '../packages/connectors/src/translate/index.js';
import { searchElucidWeb } from '../packages/harness/src/web-search-elucid.js';
import { createToolGateway } from '../packages/harness/src/tool-gateway.js';
import { createModelUsageService, estimateModelCost } from '../packages/domain/src/model-usage-service.js';
import { decodeUsageHistory, supplementHarnessUsage } from '../packages/harness/src/model-usage-history.js';
import { createAiCenterServer } from '../apps/web/src/server.js';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { Context } from '@deepseek-ai/cordis';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { usageFixture } from './fixtures/harness-token-usage.js';

test('live notifications, result events and history reconciliation use stable attempt identities', () => {
  const rows = new Map();
  const observer = createHarnessUsageObserver({ record: row => rows.set(row.id, structuredClone(row)), attribution: { jobId: 'job', applicationSessionId: 'app' } });
  const events = usageFixture();
  events.forEach(event => observer.notification({ method: 'session.event', params: { sessionId: 'session', event } }));
  observer.events('session', events); observer.events('session', events);
  const requests = [...rows.values()].filter(row => row.kind === 'request');
  assert.equal(requests.length, 2);
  assert.equal(requests.reduce((sum, row) => sum + row.usage.totalTokens, 0), 32);
  assert.deepEqual(requests.map(row => row.status), ['failed', 'succeeded']);
  assert.equal([...rows.values()].find(row => row.kind === 'turn').usage.totalTokens, 32);
  assert.ok(requests.every(row => row.applicationSessionId === 'app' && row.jobId === 'job'));
});

test('native undefined keeps missing attempt plus known nonzero request; interruption retains records', () => {
  const rows = new Map();
  const observer = createHarnessUsageObserver({ record: row => rows.set(row.id, structuredClone(row)) });
  observer.events('session', usageFixture({ missing: true }));
  const requests = [...rows.values()].filter(row => row.kind === 'request');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].usage.totalTokens, null);
  assert.equal(requests[1].usage.totalTokens, 17);
  assert.equal([...rows.values()].find(row => row.kind === 'turn').completeness, 'missing');
  observer.events('other', usageFixture().slice(0, 2)); observer.interrupt();
  assert.ok([...rows.values()].filter(row => row.harnessSessionId === 'other').every(row => row.status === 'interrupted'));
});

test('missing attempt lifecycle keeps a known settlement but never prices it as an exact request', () => {
  const rows = new Map(), events = usageFixture();
  const observer = createHarnessUsageObserver({ record: row => rows.set(row.id, structuredClone(row)) });
  observer.events('session', [events[0], events[5], events[7]]);
  const request = [...rows.values()].find(row => row.kind === 'request');
  assert.equal(request.usage.totalTokens, 17); assert.equal(request.attempt, null); assert.equal(request.completeness, 'partial');
  assert.equal([...rows.values()].find(row => row.kind === 'turn').usage.totalTokens, null);
});

test('direct total prompt usage cannot prove uncached input when the provider omits cache accounting', () => {
  const usage = providerTokenUsage({ usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }, 'elucid-grok');
  assert.equal(usage.inputTokens, null); assert.equal(usage.cacheReadTokens, null); assert.equal(usage.totalTokens, 12);
});

test('released physical v3 codec replays history, ignores torn last line and rejects foreign identity', () => {
  const header = sessionFormatCatalog.encodeCurrentHeader({ version: 3, id: 'session', createdAt: 0, isSeeded: false, delegationDepth: 0 }, 0);
  const text = [header, ...usageFixture().map(event => sessionFormatCatalog.encodeCurrentEvent(event))].map(row => JSON.stringify(row)).join('\n') + '\n{"torn';
  assert.equal(decodeUsageHistory(text, 'session').length, 8);
  assert.equal(decodeUsageHistory(text, 'foreign').length, 0);
});

test('default compressed Harness history supplements only turns already tied to the current run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aicenter-usage-history-'));
  const rows = new Map(), sessionId = 'aicenter-abcd';
  const observer = createHarnessUsageObserver({ record: row => rows.set(row.id, structuredClone(row)) });
  try {
    observer.events(sessionId, usageFixture().slice(0, 2));
    const header = sessionFormatCatalog.encodeCurrentHeader({ version: 3, id: sessionId, createdAt: 0, isSeeded: false, delegationDepth: 0 }, 0);
    const frames = [header, ...usageFixture().map(event => sessionFormatCatalog.encodeCurrentEvent(event))]
      .map(row => zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n')));
    const directory = path.join(root, 'sessions', '_no-cwd', sessionId); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'session.v3.jsonl.zstd'), Buffer.concat(frames));
    const context = new Context();
    try {
      const persistence = new JsonlSessionPersistence(context, { root: path.join(root, 'sessions'), compression: 'zstd' });
      const handle = await persistence.open(sessionId, 'read');
      try { assert.equal((await handle.read()).events.length, 8); } finally { await handle.close(); }
    } finally { await context.fiber.dispose(); }
    await supplementHarnessUsage({ dshHome: root, sessionId, observer });
    assert.equal([...rows.values()].find(row => row.kind === 'turn').usage.totalTokens, 32);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('desktop HTTP query validates ranges and serves the registered usage module', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aicenter-usage-api-'));
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory, env: {} });
  const { localUrl } = await app.listen();
  try {
    const result = await fetch(`${localUrl}/api/v1/runtime/model-usage`);
    assert.equal(result.status, 200); assert.deepEqual((await result.json()).records, []);
    assert.equal((await fetch(`${localUrl}/api/v1/runtime/model-usage?limit=0`)).status, 400);
    assert.equal((await fetch(`${localUrl}/model-usage.js`)).status, 200);
    assert.equal((await fetch(`${localUrl}/api/v1/runtime/model-usage`, { headers: { 'CF-Connecting-IP': '203.0.113.30' } })).status, 401);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SQLite index deduplicates replay, preserves neutral query contract and rejects prompt fields', () => {
  const store = createStore(':memory:');
  try {
    const observer = createHarnessUsageObserver({ record: row => store.repositories.modelUsage.save(row), attribution: { jobId: 'job' } });
    observer.events('session', usageFixture()); observer.events('session', usageFixture());
    const service = createModelUsageService({ repository: store.repositories.modelUsage });
    const rows = service.list({ jobId: 'job' });
    assert.equal(rows.length, 3); assert.ok(rows.every(row => !('provider' in row) && !('model' in row)));
    assert.ok(rows.every(row => row.estimate === null && row.supplierAmount === null));
    const record = store.repositories.modelUsage.list('local')[0];
    assert.throws(() => store.repositories.modelUsage.save({ ...record, prompt: 'secret' }));
    assert.throws(() => service.list({ limit: 0 }));
    assert.equal(service.list({ jobId: 'foreign' }).length, 0);
  } finally { store.close(); }
});

test('Elucid 400 retry is two HTTP attempts, even when a failed response reports usage', async () => {
  const rows = new Map(); let calls = 0;
  const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 3 } };
  await searchElucidWeb({ query: 'fixture' }, { apiKey: 'fixture', llm: { model: 'fixture' }, usageObserver: row => rows.set(row.id, structuredClone(row)),
    fetchImpl: async () => ++calls === 1 ? Response.json({ usage }, { status: 400 })
      : Response.json({ usage, output: [{ type: 'web_search_call', action: { sources: [{ url: 'https://example.com' }] } }] }) });
  assert.equal(rows.size, 2); assert.equal(calls, 2);
  assert.deepEqual([...rows.values()].map(row => row.status), ['failed', 'succeeded']);
  assert.ok([...rows.values()].every(row => row.usage.inputTokens === 7 && row.usage.cacheReadTokens === 3 && row.usage.totalTokens === 12));
});

test('parallel direct requests isolate attribution; accounting failure leaves HTTP behavior intact', async () => {
  const rows = [];
  const observed = createUsageFetch(async () => Response.json({ usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }), { provider: 'elucid-grok' });
  await Promise.all(['a', 'b'].map(jobId => withModelUsageContext({ jobId, workspaceId: jobId, observe: row => rows.push(structuredClone(row)) }, () => observed('https://example.com', {}))));
  assert.ok(rows.every(row => row.jobId === row.workspaceId));
  const failing = createUsageFetch(async () => Response.json({ ok: true }), { provider: 'fixture', observer: () => { throw new Error('ledger'); } });
  assert.deepEqual(await (await failing('https://example.com', {})).json(), { ok: true });
});

test('queued Harness execution preserves each submitting job context', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aicenter-usage-'));
  const rows = new Map();
  const runtime = createHarnessAgentRuntime({ tools: createToolRegistry(), runtimeDirectory: directory, env: { DEEPSEEK_API_KEY: 'fixture' },
    usageLedger: { record: row => rows.set(row.id, structuredClone(row)) },
    createClient: async () => ({ close: async () => {}, run: async (_prompt, options) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      const events = usageFixture();
      for (const event of events) await options.onNotification({ method: 'session.event', params: { sessionId: options.sessionId, event } });
      return { sessionId: options.sessionId, events, finalResponse: 'fixture' };
    } }) });
  try {
    await Promise.all(['a', 'b'].map(jobId => withModelUsageContext({ jobId, jobAttempt: jobId === 'a' ? 1 : 2, workspaceId: jobId }, () => runtime.run({ workspaceId: jobId, message: 'fixture', closedContext: true }))));
    assert.ok([...rows.values()].every(row => row.jobId === row.workspaceId && row.jobAttempt === (row.jobId === 'a' ? 1 : 2)));
    assert.equal([...rows.values()].filter(row => row.kind === 'request').length, 4);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('translation cache avoids another HTTP attempt', async () => {
  const rows = new Map(); let calls = 0;
  const translation = createTranslateService({ geminiApiKey: 'fixture', quotaState: new Map(),
    usageObserver: row => rows.set(row.id, structuredClone(row)), fetch: async () => { calls++; return Response.json({ candidates: [{ content: { parts: [{ text: '测试译文' }] } }], usageMetadata: { promptTokenCount: 10, totalTokenCount: 14 } }); } });
  const input = { text: 'This is a sufficiently long English fixture for translation.' };
  await translation.translate(input); await translation.translate(input);
  assert.equal(calls, 1); assert.equal(rows.size, 1);
});

test('gateway binds late usage settlement to its opening run and requires its private token', async () => {
  const rows = [];
  const gateway = await createToolGateway({ tools: createToolRegistry(), context: { usageAttribution: { jobId: 'a' } }, onUsage: (row, context) => rows.push({ ...row, ...context.usageAttribution }) });
  try {
    const post = (value, token = gateway.token) => fetch(`${gateway.url}/usage/observe`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal((await post({}, 'wrong')).status, 401);
    await post({ id: 'id', status: 'pending' });
    gateway.setContext({ usageAttribution: { jobId: 'b' } });
    await post({ id: 'id', status: 'succeeded' });
    await post({ id: 'unknown', status: 'succeeded' });
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.jobId === 'a'));
  } finally { await gateway.close(); }
});

test('explicit versioned rates estimate separately; absent buckets or rates never become free', () => {
  const rate = { provider: 'fixture', model: 'fixture', version: 'fixture-v1', currency: 'USD', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0.5, cacheWriteTokens: 1 };
  const record = { provider: 'fixture', model: 'fixture', completeness: 'complete', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 } };
  assert.equal(estimateModelCost(record, [rate]).amount, 0.0000155);
  assert.equal(estimateModelCost(record, []), null);
  assert.equal(estimateModelCost({ ...record, usage: { ...record.usage, cacheReadTokens: null } }, [rate]), null);
  const exact = { ...record, usage: { ...record.usage, cacheWriteTokens: null, totalTokens: 15 } };
  assert.equal(estimateModelCost(exact, [rate]).amount, 0.0000155);
  assert.equal(exact.usage.cacheWriteTokens, null);
});
