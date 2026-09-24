import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { resolveDailyWindow } from '../packages/domain/src/daily-window.js';
import { createReportService } from '../packages/domain/src/report-service.js';
import { createReportJobHandlers } from '../packages/runtime/src/report-module.js';
import { createJobRunner } from '../packages/runtime/src/job-runner.js';
import { createRouter } from '../apps/web/src/http/router.js';
import { createReportRoutes } from '../apps/web/src/routes/report-routes.js';
import { createTradingRoutes } from '../apps/web/src/routes/trading-routes.js';

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-daily-'));
  return {
    path: path.join(directory, 'test.db'),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function responseRecorder() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = body; },
  };
}

function jsonRequest(body) {
  const encoded = Buffer.from(JSON.stringify(body));
  return {
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield encoded; },
  };
}

const window = resolveDailyWindow({
  reportDate: '2026-09-22',
  timezone: 'Asia/Shanghai',
  cutoffHour: 8,
  cutoffMinute: 0,
});

function release(publishedAt, releaseId) {
  return {
    releaseId,
    country: 'CN',
    authority: '中国人民银行',
    documentType: 'announcement',
    title: releaseId,
    publishedAt,
    timePrecision: 'date',
    effectiveAt: null,
    documentNumber: null,
    sourceUrl: 'https://www.pbc.gov.cn/example',
    observedAt: publishedAt,
  };
}

function event(scheduledAt, eventId) {
  return {
    eventId,
    country: 'CN',
    authority: '国务院',
    eventType: 'government-meeting',
    title: eventId,
    scheduledAt,
    scheduledEndAt: null,
    referencePeriod: null,
    status: 'scheduled',
    scheduleBasis: 'official-calendar',
    timePrecision: 'exact',
    sourceUrl: 'https://www.gov.cn/example',
    observedAt: scheduledAt,
  };
}

function board(name) {
  return {
    board: name,
    mode: 'live',
    fetchedAt: window.endAt,
    indices: [{ symbol: name === 'cn' ? '000001.SS' : 'GC=F', name, lastPrice: 10, changePct: 0.01, asOf: window.endAt }],
  };
}

function createService(store, feed) {
  return createReportService({
    reportRepository: store.repositories.report,
    feedService: feed,
    tradingService: { async getBoard({ board: name }) { return board(name); } },
    staticSignalPort: {
      async readBoard() {
        return {
          generatedAt: window.endAt,
          releases: [
            release(window.startAt, 'in-window'),
            release(window.startAt - 1, 'before-window'),
            release(window.endAt, 'at-end'),
          ],
          upcoming: [
            event(window.endAt, 'at-upcoming-start'),
            event(window.endAt - 1, 'still-in-news-window'),
            event(window.endAt + 36 * 3_600_000, 'at-upcoming-end'),
          ],
          sourceHealth: [],
        };
      },
    },
    defaultConfig: { timezone: 'Asia/Shanghai', cutoffHour: 8, cutoffMinute: 0, upcomingHours: 36 },
    now: () => window.endAt,
  });
}

test('feed window is half-open and uses publishedAt before capturedAt', () => {
  const temporary = temporaryDatabase();
  const store = createStore(temporary.path);
  const feed = store.repositories.feed;
  try {
    const saved = ['before', 'start', 'inside', 'end'].map((label, index) => feed.saveContentItem({
      workspaceId: 'local',
      originType: 'manual',
      contentType: 'note',
      title: label,
      publishedAt: [window.startAt - 1, window.startAt, window.endAt - 1, window.endAt][index],
      sourceUrl: `https://example.com/${label}`,
    }));
    const rows = feed.listContentItemsInWindow('local', window);
    assert.deepEqual(rows.map((item) => item.title), ['start', 'inside']);
    assert.equal(rows[0].eventAt, window.startAt);

    const capturedToday = window.endAt + 3_600_000;
    const capture = feed.saveCapture({
      workspaceId: 'local',
      provider: 'custom',
      externalId: 'late',
      title: '昨天的新闻',
      contentHash: 'late-hash',
      publishedAt: window.startAt + 5_000,
      capturedAt: capturedToday,
    });
    feed.saveContentItem({
      workspaceId: 'local',
      captureId: capture.id,
      originType: 'subscription',
      contentType: 'article',
      title: '昨天的新闻',
      publishedAt: window.startAt + 5_000,
      sourceUrl: 'https://example.com/late',
    });
    const yesterday = feed.listContentItemsInWindow('local', window).map((item) => item.title);
    assert.ok(yesterday.includes('昨天的新闻'));
    const today = feed.listContentItemsInWindow('local', {
      startAt: window.endAt,
      endAt: window.endAt + 86_400_000,
    });
    assert.equal(today.some((item) => item.title === '昨天的新闻'), false);

    const fallback = feed.saveContentItem({
      workspaceId: 'local',
      originType: 'manual',
      contentType: 'note',
      title: '没有发布时间',
      publishedAt: null,
    });
    const included = feed.listContentItemsInWindow('local', {
      startAt: fallback.createdAt,
      endAt: fallback.createdAt + 1,
    });
    const excluded = feed.listContentItemsInWindow('local', {
      startAt: fallback.createdAt + 1,
      endAt: fallback.createdAt + 2,
    });
    assert.equal(included[0].title, '没有发布时间');
    assert.equal(included[0].eventAt, fallback.createdAt);
    assert.equal(included[0].publishedAt, null);
    assert.equal(excluded.length, 0);
    assert.equal(saved.length, 4);
  } finally {
    store.close();
    temporary.remove();
  }
});

test('daily report job writes one snapshot and can be read after reopen', async () => {
  const temporary = temporaryDatabase();
  const store = createStore(temporary.path);
  const feed = store.repositories.feed;
  feed.saveContentItem({
    workspaceId: 'local',
    originType: 'manual',
    contentType: 'note',
    title: '窗口内',
    summary: '摘要',
    publishedAt: window.startAt + 10,
    sourceUrl: 'https://example.com/news',
  });
  feed.saveContentItem({
    workspaceId: 'local',
    originType: 'manual',
    contentType: 'note',
    title: '窗口外',
    publishedAt: window.endAt,
    sourceUrl: 'https://example.com/out',
  });
  const service = createService(store, feed);
  const runner = createJobRunner({
    store,
    handlers: createReportJobHandlers({ reportService: service }),
  });
  try {
    const job = store.createJob({
      type: 'report.daily.generate',
      input: {
        reportDate: '2026-09-22',
        timezone: 'Asia/Shanghai',
        cutoffHour: 8,
        cutoffMinute: 0,
        scheduledFor: window.endAt,
      },
      maxAttempts: 2,
    });
    const completed = await runner.runOnce();
    assert.equal(completed.id, job.id);
    assert.equal(completed.status, 'completed');
    const again = await service.generateDailyReport({
      reportDate: '2026-09-22',
      timezone: 'Asia/Shanghai',
      cutoffHour: 8,
      cutoffMinute: 0,
    });
    assert.equal(store.repositories.report.listDailyReports('local').length, 1);
    assert.equal(again.id, completed.output.reportId);
    const report = store.repositories.report.getDailyReport('local', '2026-09-22');
    assert.deepEqual(report.content.news.map((item) => item.title), ['窗口内']);
    assert.equal(report.content.news[0].publishedAt, window.startAt + 10);
    assert.equal(report.content.window.startAt, window.startAt);
    assert.equal(report.content.window.endAt, window.endAt);
    assert.deepEqual(report.content.officialReleases.map((item) => item.releaseId), ['in-window']);
    assert.deepEqual(report.content.upcoming.map((item) => item.eventId), ['at-upcoming-start']);
    assert.equal(report.content.market.cn.note.includes('最新行情'), true);
    assert.equal(report.content.market.cn.fetchedAt, window.endAt);
    assert.deepEqual(report.sourceRefs.map((item) => item.type).sort(), [
      'content-item', 'market-snapshot', 'market-snapshot', 'official-release', 'scheduled-event',
    ]);
    assert.equal(store.listEvents(0, 50).some((event) => event.name === 'report.daily.generated.v1'), true);
    assert.equal(JSON.stringify(report.content).includes('值得买'), false);
    store.close();
    const reopened = createStore(temporary.path);
    try {
      const latest = reopened.repositories.report.getLatestDailyReport('local');
      assert.equal(latest.reportDate, '2026-09-22');
      assert.equal(latest.content.news[0].title, '窗口内');
    } finally {
      reopened.close();
    }
  } finally {
    if (store) {
      try { store.close(); } catch { /* already closed */ }
    }
    temporary.remove();
  }
});

test('daily generate route is desktop-only and cannot choose a job type', async () => {
  const jobs = [];
  const services = {
    report: {
      getLatestDailyReport: () => null,
      getDailyReport: () => null,
    },
    runtime: {
      requestDailyReport(input) {
        const job = { id: 'job-1', type: 'report.daily.generate', input };
        jobs.push(job);
        return job;
      },
    },
  };
  const router = createRouter(createReportRoutes());
  const denied = responseRecorder();
  await router.dispatch({
    request: jsonRequest({ date: '2026-09-22', jobType: 'system.healthcheck' }),
    response: denied,
    url: new URL('http://127.0.0.1/api/v1/reports/daily/generate'),
    identity: { kind: 'device' },
    services,
  });
  assert.equal(denied.status, 403);
  assert.equal(jobs.length, 0);

  const accepted = responseRecorder();
  await router.dispatch({
    request: jsonRequest({ date: '2026-09-22' }),
    response: accepted,
    url: new URL('http://127.0.0.1/api/v1/reports/daily/generate'),
    identity: { kind: 'desktop' },
    services,
  });
  assert.equal(accepted.status, 202);
  assert.equal(jobs[0].type, 'report.daily.generate');
  assert.equal(jobs[0].input.reportDate, '2026-09-22');
  assert.equal(jobs[0].input.jobType, undefined);

  const rejected = responseRecorder();
  try {
    await router.dispatch({
      request: jsonRequest({ jobType: 'system.healthcheck' }),
      response: rejected,
      url: new URL('http://127.0.0.1/api/v1/reports/daily/generate'),
      identity: { kind: 'desktop' },
      services,
    });
  } catch (error) {
    rejected.status = error.name === 'ValidationError' ? 400 : 500;
  }
  assert.equal(rejected.status, 400);
});

test('market analysis route delegates to stock statistics', async () => {
  const calls = [];
  const services = {
    marketStatistics: {
      async getStockStatistics(query) {
        calls.push(query);
        return { instrument: { symbol: query.symbol }, range: query.range };
      },
    },
  };
  const router = createRouter(createTradingRoutes());
  const response = responseRecorder();
  await router.dispatch({
    request: { method: 'GET' },
    response,
    url: new URL('http://127.0.0.1/api/v1/markets/analysis?symbol=600519.SS&range=5y'),
    identity: { kind: 'desktop' },
    services,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ symbol: '600519.SS', range: '5y' }]);
  assert.match(response.body, /600519\.SS/);
});
