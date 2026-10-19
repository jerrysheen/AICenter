import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTypeSafeSystemOneClient } from '../packages/connectors/src/typesafe-system-one.js';
import { createXHomeBrowserClient, formatXExpandLog } from '../packages/connectors/src/x/home-browser.js';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion, unusedSchemaVersions } from '../packages/database/src/migrations.js';
import { createFeedFilter, decideFeedAdmissionFallback, resolveFeedFilterConfig } from '../packages/domain/src/feed-filter.js';
import { openJevClient, resolveJevEnabled } from '../packages/domain/src/jev-enabled.js';
import { admitHeldCapture, reevaluateHeldCaptures } from '../packages/domain/src/jev-replay.js';
import { createFeedValueRefreshService } from '../packages/domain/src/feed-value-refresh-service.js';
import { createReadingHourService } from '../packages/domain/src/reading-hour-service.js';
import { isMain } from '../packages/runtime/src/is-main.js';
import { resolveAgentQualityConfig } from '../packages/runtime/src/agent-quality.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const predicate = "provider='x' AND json_extract(metadata_json,'$.xFocus.method') IS NOT NULL";
const focusConfig = {
  version: 'x-focus-1',
  directions: [{ id: 'oil-geopolitics', keywords: ['原油'], weight: 1 }],
};
const good = {
  reading_value: 0.8,
  advertising: 0.1,
  specific_content: 0.8,
  sufficient_information: 0.8,
  missing_context: 0.05,
};

function answers(scores) {
  return Object.fromEntries(Object.entries(scores).map(([key, noul]) => [key, { type: 'noul', noul }]));
}

function filterFor(client, config = {}, extra = {}) {
  return createFeedFilter({
    client,
    xFocusConfig: focusConfig,
    config: {
      mode: 'enforce',
      version: 'feed-value-v3.0',
      rule: 'all-three-0.60',
      fallback: true,
      jevEnabled: true,
      xFocusMin: 0.7,
      ...config,
    },
    ...extra,
  });
}

function bodyInput(body, extra = {}) {
  return {
    provider: extra.provider || 'x',
    sourceExternalId: extra.sourceExternalId || 'x:home:for-you',
    originalText: body,
    item: {
      provider: extra.provider || 'x',
      title: extra.title || body,
      body,
      sourceExternalId: extra.sourceExternalId || 'x:home:for-you',
      ...(extra.xFocus ? { xFocus: extra.xFocus } : {}),
      ...(extra.captureContext ? { captureContext: extra.captureContext } : {}),
    },
  };
}

test('fallback config defaults on and the global jev switch wins', () => {
  assert.equal(resolveJevEnabled({}), true);
  assert.equal(resolveJevEnabled({ AI_CENTER_JEV_ENABLED: 'false' }), false);
  assert.equal(resolveJevEnabled({ AI_CENTER_JEV_ENABLED: 'off' }), false);
  assert.equal(resolveFeedFilterConfig({ AI_CENTER_FEED_FILTER_FALLBACK: 'off' }).fallback, false);
  assert.equal(resolveFeedFilterConfig({ AI_CENTER_FEED_FILTER_XFOCUS_MIN: '0.85' }).xFocusMin, 0.85);
  assert.equal(resolveFeedFilterConfig({ AI_CENTER_JEV_ENABLED: 'false' }).jevEnabled, false);
  assert.equal(resolveAgentQualityConfig({ AI_CENTER_JEV_ENABLED: 'false' }).disabled, true);
  assert.equal(resolveAgentQualityConfig({ AI_CENTER_JEV_ENABLED: 'false' }).priorMode, 'off');
  assert.equal(resolveAgentQualityConfig({ AI_CENTER_JEV_DISABLED: '1' }).disabled, true);
  assert.equal(resolveAgentQualityConfig({}).disabled, false);
  let built = 0;
  assert.equal(openJevClient({ AI_CENTER_JEV_ENABLED: 'false' }, undefined, () => { built += 1; return { id: 'client' }; }), null);
  assert.equal(built, 0);
  assert.equal(openJevClient({}, undefined, () => { built += 1; return { id: 'client' }; }).id, 'client');
  assert.equal(built, 1);
});

test('technical jev failure uses following, focus, keyword, and source rules', async () => {
  let calls = 0;
  const failing = {
    available: () => true,
    async evaluate() {
      calls += 1;
      const error = new Error('payment required');
      error.code = 'TYPESAFE_HTTP_ERROR';
      error.status = 402;
      throw error;
    },
  };
  const filter = filterFor(failing);
  const following = await filter.evaluate(bodyInput('广告 立即购买本课程', { sourceExternalId: 'x:home:following' }));
  assert.equal(following.metadata.filterDecision, 'KEEP');
  assert.equal(following.metadata.filterReason, 'fallback-following');
  assert.equal(following.metadata.filterApplied, false);
  assert.equal(following.status, 'ready');
  assert.equal(following.createContentItem, true);
  assert.equal(following.metadata.filterErrorCode, 'TYPESAFE_HTTP_ERROR');
  assert.equal(following.metadata.filterErrorStatus, 402);
  assert.match(following.metadata.fallbackAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(following.metadata.filterScores, null);

  const scored = await filter.evaluate(bodyInput('一条普通更新', { xFocus: { focusScore: 0.8, method: 'model' } }));
  assert.equal(scored.metadata.filterReason, 'fallback-xfocus');
  const keyword = await filter.evaluate(bodyInput('原油库存下降'));
  assert.equal(keyword.metadata.filterReason, 'fallback-keyword');
  const ad = await filter.evaluate(bodyInput('广告 立即购买', { xFocus: { focusScore: 0.95, method: 'model' } }));
  assert.equal(ad.metadata.filterDecision, 'REVIEW');
  assert.equal(ad.metadata.filterReason, 'jev-failed');
  assert.equal(ad.status, 'captured');
  const low = await filter.evaluate(bodyInput('今天天气不错', { xFocus: { focusScore: 0.2, method: 'model' } }));
  assert.equal(low.metadata.filterDecision, 'REVIEW');
  assert.equal(low.status, 'captured');
  const other = await filter.evaluate(bodyInput('雪球帖子正文足够完整。', { provider: 'xueqiu', sourceExternalId: 'xueqiu:home' }));
  assert.equal(other.metadata.filterReason, 'fallback-source');
  const truncated = await filter.evaluate(bodyInput('关注流长文还没展开', {
    sourceExternalId: 'x:home:following',
    captureContext: { truncated: true },
  }));
  assert.equal(truncated.metadata.filterReason, 'input-truncated');
  assert.equal(truncated.status, 'captured');
  assert.ok(calls >= 5);

  const healthy = filterFor({
    available: () => true,
    async evaluate() { return { model: 'fixed', answers: answers(good) }; },
  });
  const kept = await healthy.evaluate(bodyInput('完整的产品更新说明，包含具体数据和步骤。'));
  assert.equal(kept.metadata.filterDecision, 'KEEP');
  assert.equal(kept.metadata.filterReason, 'all-three');
  assert.equal(kept.metadata.fallbackAt, undefined);
  assert.equal(kept.metadata.filterErrorCode, '');
  assert.equal(kept.metadata.filterErrorStatus, null);

  const stuck = filterFor(failing, { fallback: false });
  const blocked = await stuck.evaluate(bodyInput('关注流', { sourceExternalId: 'x:home:following' }));
  assert.equal(blocked.metadata.filterDecision, 'REVIEW');
  assert.equal(blocked.metadata.filterReason, 'jev-failed');
  assert.equal(blocked.metadata.fallbackAt, undefined);
});

test('disabled jev never calls the client and labels non-passes jev-disabled', async () => {
  const filter = filterFor({
    available: () => true,
    async evaluate() { throw new Error('should not run'); },
  }, { jevEnabled: false, fallback: false });
  const kept = await filter.evaluate(bodyInput('关注流', { sourceExternalId: 'x:home:following' }));
  assert.equal(kept.metadata.filterReason, 'jev-disabled-following');
  assert.equal(kept.metadata.filterDecision, 'KEEP');
  const missed = await filter.evaluate(bodyInput('没有关键词'));
  assert.equal(missed.metadata.filterReason, 'jev-disabled');
  assert.equal(missed.metadata.filterDecision, 'REVIEW');
  assert.equal(missed.status, 'captured');
  const logs = [];
  const noisy = filterFor({
    available: () => true,
    async evaluate() {
      const error = new Error('down');
      error.code = 'TYPESAFE_HTTP_ERROR';
      error.status = 402;
      throw error;
    },
  }, { warnStreak: 2, warnGapMs: 0, now: () => 1_000 });
  noisy; // configured above; the warning filter is created next with a log
  const warned = createFeedFilter({
    client: {
      available: () => true,
      async evaluate() {
        const error = new Error('down');
        error.code = 'TYPESAFE_HTTP_ERROR';
        error.status = 402;
        throw error;
      },
    },
    log: (message) => logs.push(message),
    config: {
      mode: 'enforce', version: 'feed-value-v3.0', rule: 'all-three-0.60',
      fallback: true, jevEnabled: true, warnStreak: 2, warnGapMs: 0, now: () => 5_000,
    },
  });
  await warned.evaluate(bodyInput('a', { sourceExternalId: 'x:home:following' }));
  assert.equal(logs.length, 0);
  await warned.evaluate(bodyInput('b', { sourceExternalId: 'x:home:following' }));
  assert.match(logs[0], /连续技术失败 2 次/);
});

test('approved lists recognize fallback markers without scanning', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-fallback-list-'));
  const store = createStore(path.join(directory, 'test.db'));
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home:following', displayName: '关注',
    });
    function save(externalId, metadata) {
      const capture = feed.saveCapture({
        workspaceId: 'local', provider: 'x', externalId, sourceAccountId: source.id,
        contentHash: externalId, sourceUrl: `https://x.com/a/status/${externalId}`,
        title: externalId, status: 'ready', metadata,
      });
      feed.saveContentItem({
        workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
        title: externalId, body: externalId, sourceUrl: capture.sourceUrl,
      });
    }
    save('marked', {
      filterMode: 'enforce', filterDecision: 'KEEP', filterApplied: false,
      filterRule: 'all-three-0.60', filterReason: 'fallback-following',
    });
    save('disabled', {
      filterMode: 'enforce', filterDecision: 'KEEP', filterApplied: false,
      filterRule: 'all-three-0.60', filterReason: 'jev-disabled-source',
    });
    save('scored', {
      filterMode: 'enforce', filterDecision: 'KEEP', filterApplied: false, filterRule: 'all-three-0.60',
      filterScores: { reading_value: 0.8, specific_content: 0.8, sufficient_information: 0.8 },
    });
    save('held', {
      filterMode: 'enforce', filterDecision: 'REVIEW', filterApplied: true,
      filterRule: 'all-three-0.60', filterReason: 'jev-failed',
    });
    const visible = feed.listContentItemsByProvider('local', 'x', { qualityRule: 'all-three-0.60' }).map((row) => row.externalId).sort();
    assert.deepEqual(visible, ['disabled', 'marked', 'scored']);
    assert.deepEqual(feed.listQualityApprovedExternalIds('local', 'x').sort(), ['disabled', 'marked', 'scored']);
    const plan = feed.explainProviderFeed('local', 'x', {
      sourceExternalId: 'x:home:following', limit: 10,
    }).join('\n');
    assert.match(plan, /idx_captures_feed_sort/);
    assert.doesNotMatch(plan, /SCAN (?:c |ci |content_items|captures)/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('x focus partial index is migration 85 and the point query uses it', () => {
  assert.deepEqual(unusedSchemaVersions, [63, 79, 80, 82]);
  assert.equal(latestSchemaVersion(), 85);
  const migration = readFileSync(path.join(root, 'packages/database/src/migrations.js'), 'utf8');
  const repository = readFileSync(path.join(root, 'packages/database/src/repositories/feed-repository.js'), 'utf8');
  assert.match(migration, new RegExp(`idx_captures_x_focus ON captures\\(workspace_id, captured_at\\) WHERE ${predicate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(repository.includes(predicate), true);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-x-focus-index-'));
  const store = createStore(path.join(directory, 'test.db'));
  try {
    const feed = store.repositories.feed;
    for (let index = 0; index < 40; index += 1) {
      feed.saveCapture({
        workspaceId: 'local', provider: 'x', externalId: `t${index}`, contentHash: `h${index}`,
        capturedAt: 1_000 + index,
        metadata: { xFocus: { method: index % 2 ? 'model' : 'keyword', focusScore: 0.8, version: 'x-focus-1' } },
      });
    }
    feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'plain', contentHash: 'plain',
      capturedAt: 2_000, metadata: { originalText: 'no focus' },
    });
    const points = feed.listXFocusPoints('local', { since: 0, limit: 100 });
    assert.equal(points.some((row) => row.externalId === 'plain' || row.method === ''), false);
    assert.equal(points.length, 40);
    const plan = feed.explainXFocusPoints('local', 0);
    assert.match(plan, /idx_captures_x_focus/);
    assert.doesNotMatch(plan, /SCAN captures/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('x expand log counts in-cap deadline skips for both feeds', async () => {
  assert.equal(formatXExpandLog({
    feed: 'following', truncated: 8, attempted: 2, ok: 2, failed: 6,
    reasons: { deadline: 6 },
  }), '[x-home] expand feed=following truncated=8 attempted=2 ok=2 failed=6 reasons=deadline:6');
  const cards = [
    { tweet_id: '1', tweet_url: 'https://x.com/a/status/1', text: '短', truncated: true, author_handle: 'a' },
    { tweet_id: '2', tweet_url: 'https://x.com/a/status/2', text: `${'长'.repeat(220)}`, truncated: true, author_handle: 'a' },
  ];
  const logs = [];
  const controller = new AbortController();
  const navigated = [];
  let tab = 'Following';
  const runtime = {
    async withSession(_options, callback) {
      return callback({
        async navigate(url) { navigated.push(url); },
        async evaluate(expression) {
          const source = String(expression);
          if (source.includes('tweetText')) {
            const opened = [...navigated].reverse().find((url) => String(url).includes('/status/'));
            if (opened) {
              const id = opened.match(/status\/(\d+)/)[1];
              const card = cards.find((item) => item.tweet_id === id);
              return { items: [{ ...card, text: `${card.text}${'补'.repeat(250)}`, truncated: false }] };
            }
            return { items: cards };
          }
          if (source.includes('x-status-comments')) return { comments: [] };
          return { url: 'https://x.com/home', title: 'Home', logged_in: true, login_wall: false, selected_tab: tab };
        },
      });
    },
  };
  const client = createXHomeBrowserClient({
    browserRuntime: runtime,
    delay: async () => {},
    log: (message) => logs.push(message),
    scoreHomeCards: async () => ({ minScore: 0.75, maxExpand: 8, byId: { 1: { focusScore: 0.1 }, 2: { focusScore: 0.9 } } }),
  });
  await client.fetchHomeTimeline({ feed: 'following', limit: 5 });
  assert.match(logs.at(-1), /feed=following truncated=2 attempted=2 ok=2 failed=0/);
  logs.length = 0;
  navigated.length = 0;
  tab = 'For you';
  const stopped = createXHomeBrowserClient({
    browserRuntime: runtime,
    delay: async () => {},
    log: (message) => logs.push(message),
    scoreHomeCards: async () => {
      controller.abort();
      return { minScore: 0.75, maxExpand: 8, byId: { 2: { focusScore: 0.9 } } };
    },
  });
  await stopped.fetchHomeTimeline({ feed: 'for-you', limit: 5, signal: controller.signal });
  assert.match(logs.at(-1), /feed=for-you /);
  assert.match(logs.at(-1), /reasons=.*deadline:/);
  assert.match(logs.at(-1), /attempted=0/);
});

test('reading hour uses classification hits when jev fails or is disabled', async () => {
  const node = {
    id: 'n1', sourceId: 's1', version: '1', title: '公司拿到新订单', text: '订单金额已经公布。', publisher: '来源',
  };
  function service(env, client) {
    const calls = [];
    const reading = createReadingHourService({
      enabled: true,
      env,
      client,
      repository: {
        listInformationInWindow: () => [node],
        publishReadingHour: (_workspace, snapshot) => ({ published: true, snapshot }),
      },
      agentRuntime: {
        async run() {
          return { answer: '{"primaryDirection":"industry","subjectKind":"company_event","domainTagIds":[],"classificationStatus":"classified","evidenceQuote":"订单"}' };
        },
      },
      log: () => {},
    });
    return { reading, calls };
  }
  const jevCalls = [];
  const failed = service({}, {
    available: () => true,
    async evaluate() {
      jevCalls.push('evaluate');
      throw new Error('402');
    },
  });
  const hit = await failed.reading.scoreWindow({ window: { startAt: 10, endAt: 20 } });
  assert.equal(jevCalls.length, 1);
  assert.equal(hit.snapshot.items[0].disposition, 'hit');
  assert.equal(hit.readingErrors.length, 1);
  assert.ok(Object.values(hit.snapshot.items[0].questions).some((row) => row.reason === 'reading-classification' && row.score === 1));
  const disabledCalls = [];
  const disabled = service({ AI_CENTER_JEV_ENABLED: 'false' }, {
    available: () => true,
    async evaluate() { disabledCalls.push('evaluate'); throw new Error('should not run'); },
  });
  const direct = await disabled.reading.scoreWindow({ window: { startAt: 10, endAt: 20 } });
  assert.equal(disabledCalls.length, 0);
  assert.equal(direct.snapshot.items[0].disposition, 'hit');
  assert.deepEqual(direct.readingErrors, []);
});

test('quality refresh does not call jev when the switch is off', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-refresh-off-'));
  const store = createStore(path.join(directory, 'test.db'));
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home:following', displayName: '关注',
    });
    const capture = feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'follow', sourceAccountId: source.id,
      contentHash: 'follow', metadata: { originalText: '关注流里的一条完整更新。' },
    });
    feed.saveContentItem({
      workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
      title: '关注', body: '关注流里的一条完整更新。',
    });
    let calls = 0;
    const service = createFeedValueRefreshService({
      feedRepository: feed,
      model: 'fixed',
      jevEnabled: false,
      xFocusConfig: focusConfig,
      client: { async evaluate() { calls += 1; throw new Error('should not run'); } },
    });
    const result = await service.refresh({ concurrency: 1 }, { runId: 'off' });
    assert.equal(calls, 0);
    assert.equal(result.KEEP, 1);
    assert.equal(feed.getCapture('local', 'x', 'follow').metadata.filterReason, 'jev-disabled-following');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('replay keeps original time, skips a client when jev is disabled, and links the author', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-replay-'));
  const store = createStore(path.join(directory, 'test.db'));
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home:following', displayName: '关注',
    });
    const rows = [
      ['c-late', 400, 150],
      ['a-early', 100, 300],
      ['b-mid', null, 200],
    ];
    for (const [id, publishedAt, capturedAt] of rows) {
      feed.saveCapture({
        id, workspaceId: 'local', provider: 'x', externalId: id, sourceAccountId: source.id,
        contentHash: id, title: id, status: 'captured', publishedAt, capturedAt,
        sourceUrl: `https://x.com/alice/status/${id}`,
        authorNativeId: '111',
        metadata: {
          filterReason: 'jev-failed', filterDecision: 'REVIEW', filterApplied: true,
          originalText: `${id} 的正文`,
          authorProfile: { name: 'Alice', handle: 'alice', nativeId: '111' },
        },
      });
    }
    feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'ready', sourceAccountId: source.id,
      contentHash: 'ready', status: 'ready', capturedAt: 50,
      metadata: { filterReason: 'jev-failed', originalText: '已放行' },
    });
    const captures = feed.listJevFailedCaptures('local', { from: 0, to: 1_000, limit: 10 });
    assert.deepEqual(captures.map((row) => row.externalId), ['a-early', 'b-mid', 'c-late']);
    const kept = [];
    const dry = await reevaluateHeldCaptures({
      captures, jevEnabled: false, dryRun: true, xFocusConfig: focusConfig,
      onKeep: (capture) => kept.push(capture.externalId),
    });
    assert.equal(kept.length, 0);
    assert.deepEqual(dry.map((row) => row.externalId), ['a-early', 'b-mid', 'c-late']);
    assert.equal(dry.every((row) => row.reason === 'jev-disabled-following'), true);
    let built = 0;
    assert.equal(openJevClient({ AI_CENTER_JEV_ENABLED: 'false' }, undefined, () => { built += 1; return {}; }), null);
    await reevaluateHeldCaptures({
      captures, jevEnabled: false, xFocusConfig: focusConfig,
      onKeep: (capture, reason) => admitHeldCapture({ feedRepository: feed, capture, reason }),
    });
    assert.equal(feed.getCapture('local', 'x', 'a-early').capturedAt, 300);
    assert.equal(feed.getCapture('local', 'x', 'a-early').status, 'ready');
    assert.equal(feed.getCapture('local', 'x', 'a-early').metadata.filterReason, 'jev-disabled-following');
    const item = feed.listContentItemsByProvider('local', 'x', { qualityRule: 'all-three-0.60' })
      .find((row) => row.externalId === 'a-early');
    assert.ok(item);
    const author = store.repositories.authors.getAuthor('local', 'x:111');
    assert.equal(author?.handle, 'alice');
    assert.equal(built, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('object error details are stringified and Windows script paths compare', async () => {
  const client = createTypeSafeSystemOneClient({
    apiKey: 'test-key',
    fetch: async () => ({
      ok: false,
      status: 402,
      async text() { return JSON.stringify({ error: { message: { code: 'payment_required', detail: 'quota' } } }); },
    }),
  });
  await assert.rejects(
    () => client.evaluate({ state: { title: 'a' }, questions: { reading_value: { type: 'noul' } } }),
    (error) => error.status === 402 && error.message.includes('payment_required') && !error.message.includes('[object Object]'),
  );
  assert.equal(isMain('file:///C:/repo/scripts/replay.mjs', 'C:\\repo\\scripts\\replay.mjs', 'win32'), true);
  assert.equal(isMain('file:///C:/repo/scripts/replay.mjs', 'c:/repo/scripts/REPLAY.mjs', 'win32'), true);
  assert.equal(isMain('file:///C:/repo/scripts/replay.mjs', 'C:\\repo\\scripts\\other.mjs', 'win32'), false);
  assert.equal(decideFeedAdmissionFallback(
    { provider: 'bilibili', item: { body: '动态' } },
    { prefix: 'fallback' },
  ).reason, 'fallback-source');
  const worker = readFileSync(path.join(root, 'apps/worker/src/worker.js'), 'utf8');
  const server = readFileSync(path.join(root, 'apps/web/src/server.js'), 'utf8');
  assert.match(worker, /openJevClient\(env, options\.typesafeClient, createTypeSafeSystemOneClient\)/);
  assert.match(server, /openJevClient\(env, options\.typesafeClient, createTypeSafeSystemOneClient\)/);
  assert.doesNotMatch(worker, /typesafeClient \|\| createTypeSafeSystemOneClient/);
  assert.doesNotMatch(server, /typesafeClient \|\| createTypeSafeSystemOneClient/);
  const quality = worker.slice(worker.indexOf('export function createOptionalAgentQuality'), worker.indexOf('export function createOptionalAuxiliarySearch'));
  assert.ok(quality.indexOf('resolveJevEnabled') < quality.indexOf('createTypeSafeSystemOneClient'));
  assert.match(worker, /log: focusLog/);
});
