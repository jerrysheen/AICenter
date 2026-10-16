import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../packages/database/src/migrations.js';
import { createInformationTreeRepository } from '../packages/database/src/repositories/information-tree-repository.js';
import { createInformationTreeReader } from '../packages/domain/src/information-tree-service.js';
import { createReportRoutes } from '../apps/web/src/routes/report-routes.js';

function insertDaily(db, { id, start, end, title, text }) {
  db.prepare('INSERT INTO information_tree_nodes (workspace_id, id, value_json) VALUES (?, ?, ?)')
    .run('local', `root-${id}`, JSON.stringify({ id: `root-${id}`, title, text, eventAt: end - 1000 }));
  db.prepare(`INSERT INTO information_tree_editions
    (workspace_id, id, value_json, edition_status, generated_at, start_at, end_at, root_count)
    VALUES (?, ?, ?, 'ready', ?, ?, ?, 1)`)
    .run('local', id, JSON.stringify({ id, roots: [`root-${id}`], window: { startAt: start, endAt: end }, status: 'ready', generatedAt: end }), end, start, end);
  db.prepare(`INSERT INTO information_tree_heads
    (workspace_id, period_key, layer, start_at, published_id, attempt_id)
    VALUES (?, ?, 'daily', ?, ?, ?)`)
    .run('local', `daily:${start}:${end}`, start, id, id);
}

test('latestDaily ignores the seven day index and the old brief table', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const day = 86_400_000;
  const olderEnd = Date.parse('2026-10-05T16:00:00Z');
  const newerEnd = Date.parse('2026-10-16T16:00:00Z');
  insertDaily(db, { id: 'daily-old', start: olderEnd - day, end: olderEnd, title: '旧日报', text: '停在十月五日' });
  insertDaily(db, { id: 'daily-new', start: newerEnd - day, end: newerEnd, title: '新日报', text: '十月十六日收盘' });
  const reader = createInformationTreeReader({ repository: createInformationTreeRepository(db, () => {}) });
  const daily = reader.latestDaily('local');
  assert.equal(daily.reportDate, '2026-10-16');
  assert.equal(daily.editionId, 'daily-new');
  assert.equal(daily.informationItems[0].sentence, '十月十六日收盘');
  assert.equal(JSON.stringify(daily).includes('secret'), false);
  db.close();
});

test('latestDaily uses the editorial lead and hides the model', () => {
  const repository = {
    latestDailySlot() {
      return { edition: { id: 'daily-ed', window: { startAt: 1, endAt: 2 }, generatedAt: 3, hasEditorial: true }, attempt: null };
    },
    editorialForWindow() {
      return {
        reportDate: '2026-10-16',
        overview: '概览',
        generatedAt: 9,
        usage: { model: 'secret-model' },
        coverage: { informationNodeCount: 12 },
        articles: [{ direction: 'finance', title: '标题', lead: '导语' }],
      };
    },
  };
  const daily = createInformationTreeReader({ repository }).latestDaily('local');
  assert.equal(daily.reportDate, '2026-10-16');
  assert.equal(daily.overview, '概览');
  assert.equal(daily.informationItemCount, 12);
  assert.deepEqual(daily.informationItems, [{ id: 'finance', sentence: '导语', occurredAt: null }]);
  assert.equal(daily.hasEditorial, true);
  assert.equal(daily.model, undefined);
  assert.equal(JSON.stringify(daily).includes('secret-model'), false);
});

test('latest daily route returns the shared tree card', async () => {
  const route = createReportRoutes().find((item) => item.path === '/api/v1/reports/tree/latest-daily');
  assert.equal(route.method, 'GET');
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
    req: { headers: {} },
  };
  await route.handler({
    response,
    identity: { device: { workspaceId: 'phone' } },
    services: {
      informationTree: {
        latestDaily(workspace) {
          assert.equal(workspace, 'phone');
          return { reportDate: '2026-10-16', overview: '概览', informationItems: [], editionId: 'ed', window: { startAt: 1, endAt: 2 } };
        },
      },
    },
  });
  const payload = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.daily.reportDate, '2026-10-16');
});
