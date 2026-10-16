import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';
import { ingestTwkrNews, TWKR_FUTURE_SLACK_MS } from '../packages/domain/src/twkr-ingestion.js';
import {
  fetchTwkrDocument,
  parseTwkrPayload,
  readTwkrSource,
  resolveTwkrSources,
  TWKR_SOURCES,
} from '../packages/connectors/src/twkr-sources.js';
import {
  createTwkrJobHandlers,
  ensureTwkrSchedules,
  prepareTwkrEnqueue,
  TWKR_NEWS_JOB_TYPE,
  TWKR_REVENUE_JOB_TYPE,
} from '../packages/runtime/src/twkr-job.js';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const fixture = (name) => readFileSync(new URL(`./fixtures/twkr/${name}`, import.meta.url), 'utf8');
const source = (key) => TWKR_SOURCES.find((item) => item.sourceKey === key);

function openStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-twkr-'));
  const file = path.join(directory, 'test.db');
  const store = createStore(file);
  const mediaService = createMediaIngestionService({
    mediaRepository: store.repositories.media,
    feedRepository: store.repositories.feed,
  });
  return { directory, file, store, mediaService };
}

test('台湾和韩国来源按原文时间解析，付费墙只留标题和摘要', () => {
  const material = parseTwkrPayload(source('twsematerial'), fixture('twse-material.json'));
  assert.equal(material.ok, true);
  assert.equal(material.items.length, 2);
  const filing = material.items.find((item) => item.externalId.includes(':3406:'));
  assert.equal(filing.publishedAt, Date.parse('2026-10-15T06:44:28+08:00'));
  assert.match(filing.title, /玉晶光\(3406\)/);
  assert.match(filing.summary, /869\.60/);

  const cnyes = parseTwkrPayload(source('cnyes'), fixture('cnyes.json'));
  assert.equal(cnyes.items.length, 1);
  assert.equal(cnyes.items[0].publishedAt, 1792135809 * 1000);
  assert.equal(cnyes.items[0].sourceUrl, 'https://news.cnyes.com/news/id/6632054');
  assert.match(cnyes.items[0].summary, /台光電/);

  const ctee = parseTwkrPayload(source('ctee'), fixture('ctee.xml'));
  assert.equal(ctee.items[0].publishedAt, Date.parse('2026-10-16T15:06:07+08:00'));
  assert.equal(ctee.items[0].externalId, 'ctee:20261016701276');

  const udn = parseTwkrPayload(source('udnmoney'), fixture('udn.xml'));
  assert.equal(udn.items[0].publishedAt, Date.parse('2026-10-16T15:16:36+08:00'));

  const digitimes = parseTwkrPayload(source('digitimesrss'), fixture('digitimes.xml'));
  assert.equal(digitimes.items[0].publishedAt, Date.parse('2026-10-16T06:57:00Z'));
  assert.match(digitimes.items[0].summary, /paywalled/);
  assert.equal(JSON.stringify(digitimes.items[0]).includes('FULL PAYWALLED BODY'), false);

  const elec = parseTwkrPayload(source('thelec'), fixture('thelec.xml'));
  assert.equal(elec.items[0].externalId, 'thelec:idxno:14656');
  assert.equal(elec.items[0].publishedAt, Date.parse('2026-10-16T15:49:05+09:00'));

  const revenue = parseTwkrPayload(source('twserevenue'), fixture('twse-revenue.json'));
  assert.equal(revenue.items.length, 0);
  assert.equal(revenue.rows.length, 2);
  assert.equal(revenue.rows[0].yearMonth, '202609');
  assert.equal(revenue.rows[0].revenueMonth, '14321556');
  assert.equal(revenue.rows[0].revenueMomPct, '5.963671135746468');
  assert.equal(revenue.rows[0].note, '');
  assert.equal(revenue.rows[0].publishedAt, Date.parse('2026-10-15T00:00:00+08:00'));
});

test('每个来源可以单独关闭，环境变量盖过配置', () => {
  const flags = { ctee: false, thelec: true };
  const resolved = resolveTwkrSources({ env: { AI_CENTER_TWKR_THELEC: '0', AI_CENTER_TWKR_CNYES: '1' }, flags });
  const byKey = Object.fromEntries(resolved.map((item) => [item.sourceKey, item.enabled]));
  assert.equal(byKey.ctee, false);
  assert.equal(byKey.thelec, false);
  assert.equal(byKey.cnyes, true);
  assert.equal(byKey.twsematerial, true);
});

test('请求使用 AbortSignal.timeout，并行抓取不共用队列', async () => {
  const timeouts = [];
  const news = await readTwkrSource(source('ctee'), {
    env: {},
    timeoutImpl(ms) {
      timeouts.push(ms);
      return AbortSignal.timeout(ms);
    },
    fetchImpl: async (_url, init) => {
      assert.equal(init.signal.aborted, false);
      return new Response(fixture('ctee.xml'), { status: 200 });
    },
  });
  assert.deepEqual(timeouts, [15_000]);
  assert.equal(news.items.length, 1);

  let active = 0;
  let max = 0;
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    active += 1;
    max = Math.max(max, active);
    const timer = setTimeout(() => {
      active -= 1;
      reject(new Error('slow'));
    }, 200);
    init.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      active -= 1;
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      reject(error);
    });
  });
  const [left, right] = await Promise.all([
    fetchTwkrDocument('https://www.ctee.com.tw/rss_web/livenews/stock', { timeoutMs: 40, fetchImpl }),
    fetchTwkrDocument('https://money.udn.com/rssfeed/news/1001/5590?ch=money', { timeoutMs: 40, fetchImpl }),
  ]);
  assert.equal(max, 2);
  assert.equal(left.health, 'timeout');
  assert.equal(right.health, 'timeout');
});

test('新闻去重并保留原文时间，月营收只积累历史', async () => {
  const { file, store, mediaService } = openStore();
  const bodies = {
    [source('twsematerial').url]: fixture('twse-material.json'),
    [source('cnyes').url]: fixture('cnyes.json'),
    [source('ctee').url]: fixture('ctee.xml'),
    [source('digitimesrss').url]: fixture('digitimes.xml'),
    [source('twserevenue').url]: fixture('twse-revenue.json'),
  };
  const enqueued = [];
  const handlers = createTwkrJobHandlers({
    mediaService,
    revenueRepository: store.repositories.twseRevenue,
    sources: resolveTwkrSources({ env: {} }),
    now: () => NOW,
    fetchImpl: async (url) => new Response(bodies[url], { status: 200 }),
    enqueueTranslation(jobStore, workspaceId) {
      enqueued.push({ jobStore, workspaceId });
    },
  });
  const material = await handlers[TWKR_NEWS_JOB_TYPE]({ sourceKey: 'twsematerial' }, { store, job: { id: 'job-material', workspaceId: 'local' } });
  assert.equal(material.added, 1);
  const saved = store.repositories.media.getEntries('local', material.added ? ['twsematerial:3406:1151015:064428:placeholder'] : []);
  const rows = store.repositories.media.listEntries('local', { limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].publishedAt, Date.parse('2026-10-15T06:44:28+08:00'));
  assert.equal(rows[0].sourceKey, 'twsematerial');
  assert.equal(rows[0].canonicalUrl, 'https://mops.twse.com.tw/mops/web/t05st01?co_id=3406');
  assert.equal(saved.length, 0);
  assert.equal(enqueued.length, 1);

  const again = await handlers[TWKR_NEWS_JOB_TYPE]({ sourceKey: 'twsematerial' }, { store, job: { id: 'job-material-2', workspaceId: 'local' } });
  assert.equal(again.added, 0);
  assert.equal(enqueued.length, 1);
  assert.equal(store.repositories.media.listEntries('local', { limit: 10 }).length, 1);

  const digitimes = await handlers[TWKR_NEWS_JOB_TYPE]({ sourceKey: 'digitimesrss' }, { store, job: { id: 'job-digitimes', workspaceId: 'local' } });
  assert.equal(digitimes.added, 1);
  const digi = store.repositories.media.listEntries('local', { limit: 10 }).find((row) => row.sourceKey === 'digitimesrss');
  assert.match(digi.summary, /paywalled/);
  assert.equal(digi.summary.includes('FULL PAYWALLED BODY'), false);

  const revenue = await handlers[TWKR_REVENUE_JOB_TYPE]({ sourceKey: 'twserevenue' }, { store, job: { id: 'job-revenue', workspaceId: 'local' } });
  assert.equal(revenue.saved, 2);
  assert.equal(revenue.added, 0);
  assert.equal(store.repositories.media.listEntries('local', { limit: 10 }).length, 2);
  assert.equal(enqueued.length, 2);

  const older = JSON.parse(fixture('twse-revenue.json'));
  older.push({ ...older[0], 資料年月: '11508', '營業收入-當月營收': '999' });
  older[0]['營業收入-當月營收'] = '15000000';
  store.repositories.twseRevenue.upsertMany('local', parseTwkrPayload(source('twserevenue'), JSON.stringify(older)).rows, NOW + 1000);
  const history = store.repositories.twseRevenue.listByCompany('local', '1101');
  assert.deepEqual(history.map((row) => row.yearMonth), ['202608', '202609']);
  assert.equal(history[0].revenueMonth, '999');
  assert.equal(history[1].revenueMonth, '15000000');
  assert.equal(store.repositories.twseRevenue.count('local'), 3);

  const database = new Database(file, { readonly: true });
  const migration = database.prepare('SELECT name FROM schema_migrations WHERE version = 76').get();
  assert.equal(migration.name, 'twse_monthly_revenue');
  database.close();
  const migrationSource = readFileSync(new URL('../packages/database/src/migrations.js', import.meta.url), 'utf8');
  assert.match(migrationSource, /version: 76, name: 'twse_monthly_revenue'[\s\S]*CREATE TABLE IF NOT EXISTS twse_monthly_revenue/);
  assert.match(migrationSource, /CREATE INDEX IF NOT EXISTS idx_twse_monthly_revenue_month/);
  const reopened = createStore(file);
  assert.equal(reopened.repositories.twseRevenue.count('local'), 3);
  assert.equal(reopened.repositories.twseRevenue.listByCompany('local', '1101')[1].revenueMonth, '15000000');
});

test('同一来源已在队列里时不再入队，新条目有上限', async () => {
  const { store, mediaService } = openStore();
  store.createJob({
    type: TWKR_NEWS_JOB_TYPE,
    workspaceId: 'local',
    input: { sourceKey: 'ctee' },
    maxAttempts: 1,
  });
  const schedule = {
    jobType: TWKR_NEWS_JOB_TYPE,
    input: { sourceKey: 'ctee' },
  };
  assert.equal(prepareTwkrEnqueue(store, schedule), false);
  assert.equal(prepareTwkrEnqueue(store, { jobType: TWKR_NEWS_JOB_TYPE, input: { sourceKey: 'cnyes' } }), true);
  const handlers = createTwkrJobHandlers({
    mediaService,
    sources: resolveTwkrSources({ env: { AI_CENTER_TWKR_CTEE: '0' } }),
    fetchImpl: async () => { throw new Error('disabled source must not fetch'); },
  });
  const skipped = await handlers[TWKR_NEWS_JOB_TYPE]({ sourceKey: 'ctee' }, { store, job: { id: 'other', workspaceId: 'local' } });
  assert.equal(skipped.status, 'disabled');

  const items = Array.from({ length: 41 }, (_value, index) => ({
    externalId: `ctee:n${index}`,
    title: `标题 ${index}`,
    summary: '摘要',
    sourceUrl: `https://www.ctee.com.tw/news/${index}`,
    publishedAt: NOW - index * 60_000,
    publishedAtRaw: '2026-10-16T15:06:07',
    authorName: '證券',
  }));
  const first = ingestTwkrNews(mediaService, 'local', source('ctee'), items, NOW);
  assert.equal(first.added, 40);
  const second = ingestTwkrNews(mediaService, 'local', source('ctee'), items, NOW);
  assert.equal(second.added, 1);
});

test('日程按来源分开，月营收每天一次', () => {
  const { store } = openStore();
  ensureTwkrSchedules(store, { env: { AI_CENTER_TWKR_UDNMONEY: '0' }, flags: {}, now: NOW });
  const material = store.getJobSchedule('local', 'feed.twkr.twsematerial');
  const cnyes = store.getJobSchedule('local', 'feed.twkr.cnyes');
  const revenue = store.getJobSchedule('local', 'feed.twkr.twserevenue');
  const udn = store.getJobSchedule('local', 'feed.twkr.udnmoney');
  assert.equal(material.jobType, TWKR_NEWS_JOB_TYPE);
  assert.equal(material.enabled, true);
  assert.equal(material.schedule.intervalMinutes, 15);
  assert.equal(cnyes.schedule.intervalMinutes, 12);
  assert.equal(revenue.jobType, TWKR_REVENUE_JOB_TYPE);
  assert.equal(revenue.schedule.kind, 'daily');
  assert.equal(revenue.schedule.hour, 8);
  assert.equal(revenue.schedule.minute, 30);
  assert.equal(revenue.schedule.timezone, 'Asia/Shanghai');
  assert.equal(udn.enabled, false);
});

test('翻译只交给现有的媒体索引，不另选模型', () => {
  const job = readFileSync(new URL('../packages/runtime/src/twkr-job.js', import.meta.url), 'utf8');
  const connector = readFileSync(new URL('../packages/connectors/src/twkr-sources.js', import.meta.url), 'utf8');
  assert.match(job, /enqueueMediaIndexEnrich/);
  assert.doesNotMatch(`${job}\n${connector}`, /gemma-4-31b|deepl|generativelanguage|elucid-grok|AI_CENTER_GEMMA_TRANSLATION_MODELS/i);
});

test('不带时区的韩国时间等于 UTC 加 9 小时', () => {
  const elec = parseTwkrPayload(source('thelec'), fixture('thelec.xml'));
  const publishedAt = elec.items[0].publishedAt;
  assert.equal(publishedAt, Date.parse('2026-10-16T15:49:05+09:00'));
  assert.equal(publishedAt, Date.UTC(2026, 9, 16, 6, 49, 5));
});

test('比现在晚过 10 分钟的稿件不入库', () => {
  const { store, mediaService } = openStore();
  const item = (id, publishedAt) => ({
    externalId: `ctee:${id}`,
    title: id,
    summary: '摘要',
    sourceUrl: `https://www.ctee.com.tw/news/${id}`,
    publishedAt,
    publishedAtRaw: '2026-10-16T15:06:07',
    authorName: '證券',
  });
  const result = ingestTwkrNews(mediaService, 'local', source('ctee'), [
    item('future', NOW + TWKR_FUTURE_SLACK_MS + 60_000),
    item('edge', NOW + TWKR_FUTURE_SLACK_MS),
    item('now', NOW),
  ], NOW);
  assert.equal(result.added, 2);
  const ids = store.repositories.media.listEntries('local', { limit: 10 }).map((row) => row.externalId);
  assert.deepEqual(ids.sort(), ['ctee:edge', 'ctee:now']);
});

test('重大讯息指向 MOPS 公告页，summaryOnly 来源不抓正文', async () => {
  const calls = [];
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-twkr-body-'));
  const store = createStore(path.join(directory, 'test.db'));
  const bodySource = (sourceKey, host) => ({
    sourceKey,
    publisher: sourceKey,
    publisherKey: sourceKey,
    channel: 'tech',
    contentAccess: 'body',
    articleHosts: [host],
    trackingParams: [],
  });
  const mediaService = createMediaIngestionService({
    mediaRepository: store.repositories.media,
    feedRepository: store.repositories.feed,
    mediaPort: {
      sources: [
        bodySource('twsematerial', 'mops.twse.com.tw'),
        bodySource('digitimesrss', 'www.digitimes.com'),
        bodySource('ctee', 'www.ctee.com.tw'),
      ],
      readArticle: async (_entry, input) => {
        calls.push(input.url);
        return { ok: false, health: 'network', status: 599, bytes: 0 };
      },
    },
  });
  const filings = JSON.parse(fixture('twse-material.json'));
  filings.push({
    ...filings[0],
    發言時間: '120000',
    '主旨 ': '公告取得不动产',
    說明: '第二条公告。',
  });
  const material = parseTwkrPayload(source('twsematerial'), JSON.stringify(filings));
  assert.equal(source('twsematerial').summaryOnly, true);
  assert.equal(source('digitimesrss').summaryOnly, true);
  const recent = material.items.filter((item) => item.externalId.includes(':3406:'));
  assert.equal(recent.length, 2);
  assert.deepEqual(recent.map((item) => item.sourceUrl), [
    'https://mops.twse.com.tw/mops/web/t05st01?co_id=3406',
    'https://mops.twse.com.tw/mops/web/t05st01?co_id=3406',
  ]);
  const indexed = ingestTwkrNews(mediaService, 'local', source('twsematerial'), material.items, NOW);
  assert.equal(indexed.added, 2);
  ingestTwkrNews(mediaService, 'local', source('digitimesrss'), parseTwkrPayload(source('digitimesrss'), fixture('digitimes.xml')).items, NOW);
  ingestTwkrNews(mediaService, 'local', source('ctee'), parseTwkrPayload(source('ctee'), fixture('ctee.xml')).items, NOW);
  for (const sourceKey of ['twsematerial', 'digitimesrss', 'ctee']) {
    store.repositories.media.saveState({
      workspaceId: 'local',
      sourceKey,
      enabled: true,
      hostDirectVerified: true,
      bodyUseAcknowledged: true,
      health: 'ready',
      healthDetail: '',
      etag: '',
      lastModified: '',
      feedHash: '',
      lastProbe: null,
      lastSyncAt: null,
      updatedAt: NOW,
      ingestionPolicy: '',
    });
  }
  const rows = store.repositories.media.listEntries('local', { limit: 10 });
  assert.equal(rows.filter((row) => row.sourceKey === 'twsematerial').length, 2);
  const selected = mediaService.selectBodyCandidates('local', 40).map((row) => row.sourceKey);
  assert.equal(selected.includes('twsematerial'), false);
  assert.equal(selected.includes('digitimesrss'), false);
  assert.equal(selected.includes('ctee'), true);
  const fetched = await mediaService.fetchBodies({
    workspaceId: 'local',
    externalIds: rows.map((row) => row.externalId),
    usageReviewed: true,
  });
  assert.deepEqual(calls, [rows.find((row) => row.sourceKey === 'ctee').canonicalUrl]);
  assert.equal(fetched.stats.requests, 0);
  const after = store.repositories.media.listEntries('local', { limit: 10 });
  for (const row of after.filter((item) => item.sourceKey === 'twsematerial' || item.sourceKey === 'digitimesrss')) {
    assert.equal(row.fetchState?.fetchStatus, undefined);
  }
});
