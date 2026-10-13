import test from 'node:test';
import assert from 'node:assert/strict';
import { homeRequestPlan } from '../apps/web/public/home-timeline.js';
import { homeColdLoadRequests, projectHomeBootstrap } from '../apps/web/public/home-bootstrap.js';
import {
  composeHomeBootstrap,
  createHomeBootstrapHandler,
  homeBootstrapEtag,
  homeBootstrapQuery,
} from '../apps/web/src/http/home-bootstrap.js';
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
        return { id: 'hour-1', window, items: [{ title: '一条', disposition: 'hit' }] };
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
  const body = await composeHomeBootstrap(services(), { workspace: 'phone', now: NOW });
  assert.equal(body.window.startAt, query.tree.startAt);
  assert.equal(body.brief.brief.sentence, '日报');
  assert.equal(body.brief.brief.providerId, undefined);
  assert.equal(body.brief.brief.modelId, undefined);
  assert.equal(body.posts.posts.length, 12);
  assert.equal(body.feeds.x.items.length, 12);
  assert.equal(body.feeds.xueqiu.items.length, 12);
  assert.equal(body.readings[body.window.endAt - 3_600_000].items.length, 1);
  assert.equal(body.market.pending, undefined);
  const projected = projectHomeBootstrap(body);
  assert.equal(projected.market.board, 'overview');
  assert.equal(projected.posts.length, 12);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/home/bootstrap'), false);
});

test('home bootstrap serves a short cache and 304 without calling trading', async () => {
  const fake = services();
  const handler = createHomeBootstrapHandler({ now: () => NOW });
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
  assert.equal(first.headers['Cache-Control'], 'private, no-cache');
  assert.equal(fake.calls.filter((row) => row[0] === 'tree').length, 1);
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
  assert.equal(fake.calls.filter((row) => row[0] === 'tree').length, 1);
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
  assert.equal(fake.calls.filter((row) => row[0] === 'tree').length, 2);
  const bytes = Buffer.byteLength(first.body);
  assert.ok(bytes > 200 && bytes < 20_000, `bootstrap fixture bytes ${bytes}`);
});

test('cold home data requests collapse to the bootstrap url', () => {
  const before = homeColdLoadRequests({ useBootstrap: false, nowMs: NOW, visibleHours: 4 });
  const after = homeColdLoadRequests({ useBootstrap: true, nowMs: NOW });
  assert.equal(before.length, 13);
  assert.equal(after.length, 1);
  assert.equal(after[0], '/api/v1/home/bootstrap');
  assert.ok(before.some((path) => path.includes('/api/v1/reports/tree')));
  assert.ok(before.filter((path) => path.includes('/api/v1/static-signals/board')).length, 2);
});
