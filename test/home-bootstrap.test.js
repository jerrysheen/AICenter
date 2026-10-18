import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { homeRequestPlan } from '../apps/web/public/home-timeline.js';
import { homeColdLoadRequests, projectHomeBootstrap, chooseHomeBootstrap, homeBootstrapCachePath } from '../apps/web/public/home-bootstrap.js';
import { homeEditionNote, homeHourSections, shanghaiHourStart } from '../apps/web/public/home-timeline.js';
import {
  composeHomeBootstrap,
  createHomeBootstrapHandler,
  HOME_BOOTSTRAP_RAW_BUDGET,
  homeBootstrapEtag,
  homeBootstrapQuery,
} from '../apps/web/src/http/home-bootstrap.js';
import { prepareJsonBody } from '../apps/web/src/http/prepared-json.js';
import { createPreparedSlotStore, packPreparedJson } from '../apps/web/src/http/prepared-slots.js';
import { HOME_BOOTSTRAP_SNAPSHOT_KEY } from '../packages/runtime/src/web-snapshot-jobs.js';
import { isApiTokenAllowlisted } from '../apps/web/src/http/api-token-access.js';
import { json } from '../apps/web/src/http/response.js';

const NOW = Date.parse('2026-10-10T02:00:00Z');

function services() {
  const calls = [];
  return {
    calls,
    informationTree: {
      list(workspace, query) {
        calls.push(['tree', workspace, query.view, query.startAt, query.endAt]);
        return {
          hours: [{ window: { startAt: query.endAt - 3_600_000, endAt: query.endAt } }],
          days: [],
        };
      },
    },
    readingHour: {
      indexForRange(workspace, window, scope) {
        calls.push(['index', workspace, scope, window.startAt]);
        return { hours: [{ startAt: window.endAt - 3_600_000, endAt: window.endAt }] };
      },
      forWindow(workspace, window, scope) {
        calls.push(['hour', workspace, scope, window.startAt]);
        return { id: 'hour-1', window, items: [{ title: '一条', disposition: 'hit', readingDirectionName: '金融', nodeId: 'n1', timely: true }] };
      },
    },
    report: {
      getLatestDailyBrief() {
        calls.push(['brief']);
        return { sentence: '日报', providerId: 'secret-provider', modelId: 'secret-model' };
      },
    },
    marketBoard: {
      async read(query, options) {
        calls.push(['market', query.board, options.refresh]);
        return { market: { board: 'overview', indices: [{ symbol: 'X', lastPrice: 1 }] }, pending: false };
      },
    },
    staticSignalBoard: {
      async read(input, options) {
        calls.push(['board', input.from, options.refresh]);
        return { board: { generatedAt: NOW, items: [] }, pending: false };
      },
    },
    trading: {
      async getBoard() {
        calls.push(['trading']);
        throw new Error('bootstrap must not live-sync markets');
      },
    },
    feed: {
      listLegacyPosts(limit) {
        calls.push(['posts', limit]);
        return Array.from({ length: 20 }, (_, index) => ({ id: `p${index}` }));
      },
      async getExternalFeed(providerId, query) {
        calls.push(['feed', providerId, query.limit, query.refresh, query.fields]);
        return { items: Array.from({ length: 20 }, (_, index) => ({ id: `${providerId}${index}` })) };
      },
      async localizeTexts() {
        calls.push(['localize']);
        return { localizations: {} };
      },
    },
  };
}

function mockResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    req: { headers: {} },
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ? body.toString('utf8') : '';
    },
  };
}

test('home bootstrap window matches the first-screen plan and strips provider fields', async () => {
  const plan = homeRequestPlan(NOW);
  const query = homeBootstrapQuery(NOW);
  assert.equal(query.tree.startAt, Number(new URL(plan.tree, 'http://local').searchParams.get('startAt')));
  assert.equal(query.tree.endAt, Number(new URL(plan.tree, 'http://local').searchParams.get('endAt')));
  assert.equal(query.board.from, new URL(plan.board, 'http://local').searchParams.get('from'));
  const fake = services();
  const body = await composeHomeBootstrap(fake, { workspace: 'phone', now: NOW });
  assert.equal(body.window.startAt, query.tree.startAt);
  assert.equal(body.brief.brief.sentence, '日报');
  assert.equal(body.brief.brief.providerId, undefined);
  assert.equal(body.brief.brief.modelId, undefined);
  assert.equal(body.posts, undefined);
  assert.equal(body.feeds, undefined);
  assert.equal(body.readings[body.window.endAt - 3_600_000].items.length, 1);
  assert.equal(body.readings[body.window.endAt - 3_600_000].items[0].title, '一条');
  assert.equal(body.market.pending, undefined);
  const projected = projectHomeBootstrap(body);
  assert.equal(projected.market.board, 'overview');
  assert.equal(projected.posts, null);
  assert.equal(fake.calls.some((row) => row[0] === 'posts' || row[0] === 'feed'), false);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/home/bootstrap'), false);
});

test('home bootstrap serves only a prebuilt buffer and does not compose on the request', async () => {
  const fake = services();
  const slots = createPreparedSlotStore();
  const handler = createHomeBootstrapHandler({ slots });
  const cold = mockResponse();
  await handler({
    request: { headers: {} },
    response: cold,
    services: fake,
    identity: { device: { workspaceId: 'phone' } },
    url: new URL('http://local/api/v1/home/bootstrap'),
    json,
  });
  assert.equal(cold.status, 200);
  assert.equal(JSON.parse(cold.body).pending, true);
  assert.equal(fake.calls.length, 0);
  const built = await composeHomeBootstrap(fake, { workspace: 'phone', now: NOW });
  slots.publish(HOME_BOOTSTRAP_SNAPSHOT_KEY, packPreparedJson(JSON.stringify(built), {
    etag: homeBootstrapEtag(built),
    generatedAt: NOW,
  }));
  const treeCalls = fake.calls.filter((row) => row[0] === 'tree').length;
  const first = mockResponse();
  await handler({
    request: { headers: {} },
    response: first,
    services: fake,
    identity: { device: { workspaceId: 'phone' } },
    url: new URL('http://local/api/v1/home/bootstrap'),
    json,
  });
  const payload = JSON.parse(first.body);
  assert.equal(first.status, 200);
  assert.equal(first.headers.ETag, homeBootstrapEtag(payload));
  assert.equal(first.headers['Cache-Control'], 'private, max-age=0, stale-while-revalidate=60');
  assert.equal(fake.calls.filter((row) => row[0] === 'tree').length, treeCalls);
  assert.equal(fake.calls.some((row) => row[0] === 'trading'), false);
  assert.deepEqual(fake.calls.find((row) => row[0] === 'market'), ['market', 'overview', false]);
  const second = mockResponse();
  await handler({
    request: { headers: {} },
    response: second,
    services: fake,
    identity: { device: { workspaceId: 'phone' } },
    url: new URL('http://local/api/v1/home/bootstrap'),
    json,
  });
  assert.equal(fake.calls.filter((row) => row[0] === 'tree').length, treeCalls);
  const cached = mockResponse();
  await handler({
    request: { headers: { 'if-none-match': first.headers.ETag } },
    response: cached,
    services: fake,
    identity: { device: { workspaceId: 'phone' } },
    url: new URL('http://local/api/v1/home/bootstrap'),
    json,
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.body, '');
  const refreshed = mockResponse();
  await handler({
    request: { headers: {} },
    response: refreshed,
    services: fake,
    identity: { device: { workspaceId: 'phone' } },
    url: new URL('http://local/api/v1/home/bootstrap?refresh=1'),
    json,
  });
  assert.equal(fake.calls.filter((row) => row[0] === 'tree').length, treeCalls);
  const bytes = Buffer.byteLength(first.body);
  assert.ok(bytes > 200 && bytes < 20_000, `bootstrap fixture bytes ${bytes}`);
});

test('first-screen bootstrap stays under 100KB without stringifying the fat snapshot', async () => {
  const text = (count) => '行情与公告'.repeat(count);
  const quote = (symbol) => ({
    symbol, name: symbol, lastPrice: 1, changePct: 0.1, sparkline: Array.from({ length: 80 }, (_, index) => index),
  });
  const fatServices = services();
  fatServices.informationTree.list = () => ({
    hours: Array.from({ length: 48 }, (_, index) => ({
      window: { startAt: NOW - (index + 1) * 3_600_000, endAt: NOW - index * 3_600_000 },
      roots: Array.from({ length: 20 }, () => text(80)),
    })),
    information: Array.from({ length: 80 }, () => ({ text: text(40) })),
    days: [{ editorial: text(200) }],
  });
  fatServices.readingHour.forWindow = (_workspace, window) => ({
    id: `hour-${window.startAt}`,
    window,
    items: Array.from({ length: 60 }, (_, index) => ({
      nodeId: `n${index}`,
      title: text(30),
      disposition: 'hit',
      readingDirectionName: '金融',
      timely: true,
      hits: Array.from({ length: 8 }, () => text(20)),
    })),
  });
  fatServices.report.getLatestDailyBrief = () => ({
    reportDate: '2026-10-13',
    providerId: 'secret-provider',
    modelId: 'secret-model',
    overview: text(80),
    informationItems: Array.from({ length: 80 }, (_, index) => ({
      id: `b${index}`,
      sentence: text(40),
      evidence: Array.from({ length: 4 }, () => text(30)),
    })),
  });
  fatServices.staticSignalBoard.read = async () => ({
    pending: false,
    board: {
      generatedAt: NOW,
      releases: Array.from({ length: 60 }, (_, index) => ({
        releaseId: `r${index}`,
        title: text(40),
        body: text(80),
        authority: '来源',
      })),
      upcoming: Array.from({ length: 40 }, () => ({ title: text(20) })),
      sourceHealth: [],
    },
  });
  fatServices.marketBoard.read = async () => ({
    pending: false,
    market: {
      board: 'overview',
      focus: 'us',
      sections: [{
        id: 'us',
        indices: Array.from({ length: 24 }, (_, index) => quote(`^${index}`)),
        gainers: Array.from({ length: 20 }, (_, index) => quote(`G${index}`)),
        losers: Array.from({ length: 20 }, (_, index) => quote(`L${index}`)),
      }],
    },
  });
  const full = {
    tree: fatServices.informationTree.list(),
    readings: { 1: fatServices.readingHour.forWindow('phone', { startAt: 1, endAt: 2 }) },
    brief: fatServices.report.getLatestDailyBrief(),
    board: (await fatServices.staticSignalBoard.read()).board,
    market: (await fatServices.marketBoard.read()).market,
    posts: Array.from({ length: 12 }, () => ({ body: text(80) })),
    feeds: {
      x: { items: Array.from({ length: 12 }, () => ({ body: text(80) })) },
      xueqiu: { items: Array.from({ length: 12 }, () => ({ body: text(120) })) },
    },
  };
  const beforeStarted = performance.now();
  const beforeJson = JSON.stringify(full);
  const beforeMs = performance.now() - beforeStarted;
  const slimStarted = performance.now();
  const slim = await composeHomeBootstrap(fatServices, { workspace: 'phone', now: NOW });
  const prepared = await prepareJsonBody(slim);
  const afterMs = performance.now() - slimStarted;
  assert.ok(prepared.bytes < HOME_BOOTSTRAP_RAW_BUDGET, `slim bootstrap ${prepared.bytes} bytes`);
  assert.equal(slim.market.market.sections[0].indices[0].sparkline.length, 30);
  assert.equal(JSON.parse(prepared.json.toString('utf8')).brief.brief.providerId, undefined);
  assert.equal(slim.feeds, undefined);
  console.log(JSON.stringify({
    beforeBytes: Buffer.byteLength(beforeJson),
    beforeStringifyMs: Number(beforeMs.toFixed(2)),
    afterBytes: prepared.bytes,
    afterPrepareMs: Number(afterMs.toFixed(2)),
    afterGzipBytes: prepared.gzipped?.length || 0,
  }));
});

test('cold home data requests paint the snapshot and the module urls together', () => {
  const before = homeColdLoadRequests({ useBootstrap: false, nowMs: NOW, visibleHours: 4 });
  const after = homeColdLoadRequests({ useBootstrap: true, nowMs: NOW });
  assert.equal(before.length, 13);
  assert.equal(after.length, 6);
  assert.equal(after[0], '/api/v1/home/bootstrap?day=2026-10-10');
  assert.ok(after.some((path) => path.includes('/api/v1/reports/tree')));
  assert.ok(after.some((path) => path.includes('/api/v1/reports/reading-hour/index')));
  assert.ok(after.some((path) => path.startsWith('/api/v1/markets?board=overview')));
  assert.ok(after.some((path) => path.includes('/api/v1/reports/daily/latest/brief')));
  assert.ok(after.some((path) => path.includes('/api/v1/static-signals/board')));
  assert.equal(after.filter((path) => path.includes('/api/v1/reports/reading-hour?')).length, 0);
  assert.ok(before.some((path) => path.includes('/api/v1/reports/tree')));
  assert.ok(before.filter((path) => path.includes('/api/v1/static-signals/board')).length, 2);
  const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function loadHomeModules\(/);
  assert.match(app, /const modules = loadHomeModules\(token, \{ refresh \}\)/);
});

test('a fresh bootstrap for today replaces yesterday cached on the same url', () => {
  const now = Date.parse('2026-10-14T03:40:00.000Z');
  const hour = 3_600_000;
  const todayStart = shanghaiHourStart(now) - hour;
  const yesterdayStart = Date.parse('2026-10-13T15:00:00.000Z');
  const edition = (start) => ({ window: { startAt: start, endAt: start + hour } });
  const hit = (start, title) => ({
    title,
    nodeId: title,
    disposition: 'hit',
    readingDirectionName: '金融',
    publishedAt: start + 1000,
  });
  const snapshot = (start, endAt, title) => ({
    ok: true,
    window: { startAt: endAt - 48 * hour, endAt },
    tree: { hours: [{ edition: edition(start) }] },
    readings: { [start]: { items: [hit(start, title)] } },
  });
  const yesterday = snapshot(yesterdayStart, Date.parse('2026-10-13T16:00:00.000Z'), '昨天');
  const today = snapshot(todayStart, shanghaiHourStart(now) + hour, '今天');
  const replaced = chooseHomeBootstrap({ cached: yesterday, fresh: today, nowMs: now });
  assert.equal(replaced.source, 'fresh');
  assert.equal(replaced.body, today);
  const sections = homeHourSections({
    editions: [{ window: today.tree.hours[0].edition.window }],
    readings: today.readings,
    nowMs: now,
  });
  assert.equal(sections[0].items[0].title, '今天');
  assert.equal(sections[0].label.includes('13'), false);
  assert.equal(homeEditionNote(Date.parse('2026-10-13T16:00:00.000Z'), Date.parse('2026-10-13T16:00:00.000Z') + hour, now), '00:00–01:00');
  assert.equal(chooseHomeBootstrap({ cached: yesterday, fresh: { ok: true, notModified: true }, nowMs: now }).source, 'none');
  assert.equal(chooseHomeBootstrap({ cached: yesterday, fresh: yesterday, nowMs: now }).source, 'stale');
  assert.equal(chooseHomeBootstrap({ cached: today, fresh: yesterday, nowMs: now }).source, 'cache');
  assert.equal(chooseHomeBootstrap({ cached: today, fresh: null, nowMs: now }).source, 'cache');
  assert.equal(homeBootstrapCachePath(now), '/api/v1/home/bootstrap?day=2026-10-14');
  const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const fetchBootstrap = app.match(/async function fetchHomeBootstrap\([^]*?\n\}/)[0];
  assert.match(fetchBootstrap, /chooseHomeBootstrap\(/);
  assert.match(fetchBootstrap, /cache: 'no-store'/);
  assert.match(fetchBootstrap, /homeBootstrapCachePath\(/);
  assert.match(fetchBootstrap, /bootstrap 仍是上一天/);
});
