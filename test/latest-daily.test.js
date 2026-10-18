import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../packages/database/src/migrations.js';
import { createInformationTreeRepository } from '../packages/database/src/repositories/information-tree-repository.js';
import { createInformationTreeReader } from '../packages/domain/src/information-tree-service.js';
import { createReportRoutes } from '../apps/web/src/routes/report-routes.js';

function insertDaily(db, { id, start, end, title, text, roots = 1, published = true }) {
  const rootIds = [];
  for (let index = 0; index < roots; index += 1) {
    const rootId = `root-${id}-${index}`;
    rootIds.push(rootId);
    db.prepare('INSERT INTO information_tree_nodes (workspace_id, id, value_json) VALUES (?, ?, ?)')
      .run('local', rootId, JSON.stringify({
        id: rootId,
        title: `${title}-${index}`,
        text: index === 0 ? text : `其他${index}`,
        eventAt: end - 1000,
      }));
  }
  db.prepare(`INSERT INTO information_tree_editions
    (workspace_id, id, value_json, edition_status, generated_at, start_at, end_at, root_count)
    VALUES (?, ?, ?, 'ready', ?, ?, ?, ?)`)
    .run('local', id, JSON.stringify({ id, roots: rootIds, window: { startAt: start, endAt: end }, status: 'ready', generatedAt: end }), end, start, end, rootIds.length);
  db.prepare(`INSERT INTO information_tree_heads
    (workspace_id, period_key, layer, start_at, published_id, attempt_id)
    VALUES (?, ?, 'daily', ?, ?, ?)`)
    .run('local', `daily:${start}:${end}`, start, published ? id : null, id);
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
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_information_tree_heads_layer_start'`).get());
  db.close();
});

test('latestDaily returns the previous published daily when the newest edition is only a draft', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const day = 86_400_000;
  const olderEnd = Date.parse('2026-10-15T16:00:00Z');
  const newerEnd = Date.parse('2026-10-16T16:00:00Z');
  insertDaily(db, { id: 'daily-old', start: olderEnd - day, end: olderEnd, title: '已发布', text: '上一期正文' });
  insertDaily(db, { id: 'daily-draft', start: newerEnd - day, end: newerEnd, title: '草稿', text: '还没发布', published: false });
  const reader = createInformationTreeReader({ repository: createInformationTreeRepository(db, () => {}) });
  const daily = reader.latestDaily('local');
  assert.equal(daily.editionId, 'daily-old');
  assert.equal(daily.reportDate, '2026-10-15');
  assert.equal(daily.informationItems[0].sentence, '上一期正文');
  db.close();
});

test('latestDaily reads five roots, caches each workspace for 60 seconds, and drops the cache when a daily is published', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const day = 86_400_000;
  const end = Date.parse('2026-10-16T16:00:00Z');
  insertDaily(db, { id: 'daily-wide', start: end - day, end, title: '宽日报', text: '第一根', roots: 8 });
  const repository = createInformationTreeRepository(db, () => {});
  let reads = 0;
  const wrapped = {
    ...repository,
    getNode(...args) {
      reads += 1;
      return repository.getNode(...args);
    },
  };
  const reader = createInformationTreeReader({ repository: wrapped });
  const now = 1_700_000_000_000;
  const first = reader.latestDaily('local', now);
  assert.equal(reads, 5);
  assert.equal(first.informationItems.length, 5);
  assert.equal(first.informationItems[0].sentence, '第一根');
  db.prepare('UPDATE information_tree_nodes SET value_json = ? WHERE id = ?').run(
    JSON.stringify({ id: 'root-daily-wide-0', title: '宽日报', text: '改过的正文', eventAt: end - 1000 }),
    'root-daily-wide-0',
  );
  assert.equal(reader.latestDaily('phone', now + 1_000), null);
  const cached = reader.latestDaily('local', now + 59_000);
  assert.equal(cached.informationItems[0].sentence, '第一根');
  assert.equal(reads, 5);
  const expired = reader.latestDaily('local', now + 60_000);
  assert.equal(expired.informationItems[0].sentence, '改过的正文');
  assert.equal(reads, 10);

  const hour = 3_600_000;
  const hourStart = end;
  const version = 'a'.repeat(64);
  repository.saveNode('local', {
    id: 'info-next', layer: 'information', title: '信息', text: '信息正文', tagId: null, version,
    children: [], articleIds: ['src-next'], sourceId: 'src-next',
    window: { startAt: hourStart, endAt: hourStart + hour }, generatedAt: hourStart,
  });
  repository.saveNode('local', {
    id: 'hour-next', layer: 'hourly', title: '小时', text: '小时正文', tagId: null, version,
    children: ['info-next'], articleIds: [],
    window: { startAt: hourStart, endAt: hourStart + hour }, generatedAt: hourStart + hour,
  });
  const nextEnd = end + day;
  repository.saveNode('local', {
    id: 'day-next', layer: 'daily', title: '新一期', text: '新一期正文', tagId: null, version,
    children: ['hour-next'], articleIds: [],
    window: { startAt: end, endAt: nextEnd }, generatedAt: nextEnd,
  });
  const published = repository.publish('local', {
    id: 'edition-next', layer: 'daily', window: { startAt: end, endAt: nextEnd }, timezone: 'Asia/Shanghai',
    status: 'ready', roots: ['day-next'], inputIds: ['hour-next'], pendingIds: [], missingHours: [], generatedAt: nextEnd,
  });
  assert.equal(published.published, true);
  const fresh = reader.latestDaily('local', now + 61_000);
  assert.equal(fresh.editionId, 'edition-next');
  assert.equal(fresh.informationItems[0].sentence, '新一期正文');
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
