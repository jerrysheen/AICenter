import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createInformationTreeRepository } from '../packages/database/src/repositories/information-tree-repository.js';
import { createFeedRepository } from '../packages/database/src/repositories/feed-repository.js';
import { createReadingHourService, readingHourSourceAccess } from '../packages/domain/src/reading-hour-service.js';

const HOUR_MS = 3_600_000;
const FIRST_SCREEN_HOURS = 8;
const DEFAULT_HOURS = 24 * 7;
const DEFAULT_PER_HOUR = 15;
const DEFAULT_QUOTE_WAIT_MS = 8_000;

function parseArgs(argv) {
  const out = {
    hours: DEFAULT_HOURS,
    perHour: DEFAULT_PER_HOUR,
    quoteWaitMs: DEFAULT_QUOTE_WAIT_MS,
    runs: 3,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = Number(argv[index + 1]);
    if (key === '--hours') out.hours = value;
    else if (key === '--per-hour') out.perHour = value;
    else if (key === '--quote-wait-ms') out.quoteWaitMs = value;
    else if (key === '--runs') out.runs = value;
    else throw new Error(`未知参数 ${key}`);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} 需要非负数字`);
    index += 1;
  }
  out.hours = Math.max(FIRST_SCREEN_HOURS, Math.trunc(out.hours));
  out.perHour = Math.max(1, Math.trunc(out.perHour));
  out.runs = Math.max(1, Math.trunc(out.runs));
  out.quoteWaitMs = Math.trunc(out.quoteWaitMs);
  return out;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function instrument(database) {
  const counter = { n: 0 };
  const prepare = database.prepare.bind(database);
  database.prepare = (sql) => {
    const stmt = prepare(sql);
    const get = stmt.get.bind(stmt);
    const all = stmt.all.bind(stmt);
    stmt.get = (...args) => {
      counter.n += 1;
      return get(...args);
    };
    stmt.all = (...args) => {
      counter.n += 1;
      return all(...args);
    };
    return stmt;
  };
  return counter;
}

function buildFixture(database, { hours, perHour }) {
  database.exec(`
    CREATE TABLE information_tree_nodes (
      workspace_id TEXT NOT NULL, id TEXT NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE TABLE reading_hour_snapshots (
      workspace_id TEXT NOT NULL, id TEXT NOT NULL, start_at INTEGER NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE TABLE reading_hour_heads (
      workspace_id TEXT NOT NULL, period_key TEXT NOT NULL, published_id TEXT, attempt_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, period_key)
    );
    CREATE TABLE content_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      capture_id TEXT,
      title TEXT,
      source_url TEXT,
      author_name TEXT,
      published_at INTEGER
    );
    CREATE TABLE item_authors (
      workspace_id TEXT NOT NULL,
      content_item_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, content_item_id)
    );
    CREATE TABLE captures (
      id TEXT PRIMARY KEY,
      source_account_id TEXT,
      provider TEXT
    );
    CREATE TABLE source_accounts (
      id TEXT PRIMARY KEY,
      display_name TEXT
    );
    CREATE TABLE runtime_snapshots (
      workspace_id TEXT NOT NULL,
      snapshot_key TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, snapshot_key)
    );
  `);
  const insertNode = database.prepare('INSERT INTO information_tree_nodes VALUES (?,?,?)');
  const insertItem = database.prepare('INSERT INTO content_items VALUES (?,?,?,?,?,?,?)');
  const insertCapture = database.prepare('INSERT INTO captures VALUES (?,?,?)');
  const insertAccount = database.prepare('INSERT INTO source_accounts VALUES (?,?)');
  const insertSnapshot = database.prepare('INSERT INTO reading_hour_snapshots VALUES (?,?,?,?)');
  const insertHead = database.prepare('INSERT INTO reading_hour_heads VALUES (?,?,?,?)');
  const insertBoard = database.prepare('INSERT INTO runtime_snapshots VALUES (?,?,?,?,?)');
  const origin = Date.parse('2026-10-09T00:00:00Z');
  const write = database.transaction(() => {
    insertAccount.run('acct-bench', '基准来源');
    for (let hour = 0; hour < hours; hour += 1) {
      const startAt = origin + hour * HOUR_MS;
      const endAt = startAt + HOUR_MS;
      const items = [];
      for (let index = 0; index < perHour; index += 1) {
        const nodeId = `node-${hour}-${index}`;
        const contentId = `content-${hour}-${index}`;
        const captureId = `capture-${hour}-${index}`;
        insertAccount.run(`acct-${hour}-${index}`, `来源 ${hour}-${index}`);
        insertCapture.run(captureId, `acct-${hour}-${index}`, 'media');
        insertItem.run(contentId, 'local', captureId, `标题 ${hour}-${index}`, `https://example.test/${contentId}`, '作者', startAt);
        insertNode.run('local', nodeId, JSON.stringify({
          id: nodeId,
          title: `节点 ${hour}-${index}`,
          publisher: '',
          sourceRefs: [{ type: 'content-item', id: contentId }],
        }));
        items.push({
          nodeId,
          title: `条目 ${hour}-${index}`,
          publisher: '',
          disposition: 'hit',
          publishedAt: null,
        });
      }
      const snapshot = {
        id: `hour-${startAt}`,
        status: 'ready',
        scope: 'hour',
        window: { startAt, endAt },
        items,
      };
      insertSnapshot.run('local', snapshot.id, startAt, JSON.stringify(snapshot));
      insertHead.run('local', `${startAt}:${endAt}:hour`, snapshot.id, snapshot.id);
    }
    insertBoard.run('local', 'daily-brief', origin, '{"ok":true}', origin);
    insertBoard.run('local', 'static-board', origin, '{"ok":true}', origin);
    insertBoard.run('local', 'home-bootstrap', origin, '{"ok":true}', origin);
  });
  write();
  return { origin };
}

function loadHour(database, startAt) {
  const endAt = startAt + HOUR_MS;
  const head = database.prepare('SELECT published_id FROM reading_hour_heads WHERE workspace_id=? AND period_key=?')
    .get('local', `${startAt}:${endAt}:hour`);
  const row = database.prepare('SELECT value_json FROM reading_hour_snapshots WHERE workspace_id=? AND id=?')
    .get('local', head.published_id);
  return JSON.parse(row.value_json);
}

function presentHourOld(database, snapshot) {
  const nodeStmt = database.prepare('SELECT value_json FROM information_tree_nodes WHERE workspace_id=? AND id=?');
  const itemStmt = database.prepare('SELECT id, title, source_url, published_at FROM content_items WHERE workspace_id=? AND id=?');
  const nameStmt = database.prepare(`SELECT ci.author_name AS author_name, c.provider AS provider, sa.display_name AS display_name
    FROM content_items ci
    LEFT JOIN captures c ON c.id = ci.capture_id
    LEFT JOIN source_accounts sa ON sa.id = c.source_account_id
    WHERE ci.workspace_id = ? AND ci.id = ?`);
  for (const item of snapshot.items) {
    const node = JSON.parse(nodeStmt.get('local', item.nodeId).value_json);
    const ref = node.sourceRefs[0];
    itemStmt.get('local', ref.id);
    itemStmt.get('local', ref.id);
    nameStmt.get('local', ref.id);
  }
}

function readStored(database, key) {
  return database.prepare('SELECT payload_json FROM runtime_snapshots WHERE workspace_id=? AND snapshot_key=?')
    .get('local', key);
}

export function runHomeFirstScreenBench(options = {}) {
  const hours = options.hours ?? DEFAULT_HOURS;
  const perHour = options.perHour ?? DEFAULT_PER_HOUR;
  const quoteWaitMs = options.quoteWaitMs ?? DEFAULT_QUOTE_WAIT_MS;
  const runs = options.runs ?? 3;
  const directory = mkdtempSync(path.join(tmpdir(), 'home-perf-'));
  const file = path.join(directory, 'bench.db');
  const database = new Database(file);
  const counter = instrument(database);
  try {
    database.pragma('journal_mode = WAL');
    const { origin } = buildFixture(database, { hours, perHour });
    const windows = Array.from({ length: hours }, (_, hour) => {
      const startAt = origin + hour * HOUR_MS;
      return { startAt, endAt: startAt + HOUR_MS };
    });
    const firstWindows = windows.slice(-FIRST_SCREEN_HOURS);
    const tree = createInformationTreeRepository(database, () => {});
    const feed = createFeedRepository(database, () => {});
    const reading = createReadingHourService({
      repository: tree,
      ...readingHourSourceAccess({ feed }),
    });
    const beforeSamples = [];
    const afterSamples = [];
    const weekBefore = [];
    const weekAfter = [];
    for (let run = 0; run < runs + 1; run += 1) {
      counter.n = 0;
      const beforeStarted = performance.now();
      for (const window of firstWindows) presentHourOld(database, loadHour(database, window.startAt));
      readStored(database, 'daily-brief');
      readStored(database, 'static-board');
      const beforeQueryMs = performance.now() - beforeStarted;
      const beforeQueries = counter.n;

      counter.n = 0;
      const afterStarted = performance.now();
      reading.forWindows('local', firstWindows, 'hour');
      readStored(database, 'home-bootstrap');
      const afterQueryMs = performance.now() - afterStarted;
      const afterQueries = counter.n;

      counter.n = 0;
      const weekBeforeStarted = performance.now();
      for (const window of windows) presentHourOld(database, loadHour(database, window.startAt));
      const weekBeforeMs = performance.now() - weekBeforeStarted;
      const weekBeforeQueries = counter.n;

      counter.n = 0;
      const weekAfterStarted = performance.now();
      reading.forWindows('local', windows, 'hour');
      const weekAfterMs = performance.now() - weekAfterStarted;
      const weekAfterQueries = counter.n;

      if (run === 0) continue;
      beforeSamples.push({ queryMs: beforeQueryMs, queries: beforeQueries });
      afterSamples.push({ queryMs: afterQueryMs, queries: afterQueries });
      weekBefore.push({ queryMs: weekBeforeMs, queries: weekBeforeQueries });
      weekAfter.push({ queryMs: weekAfterMs, queries: weekAfterQueries });
    }
    const before = beforeSamples[Math.floor(beforeSamples.length / 2)]
      ? {
        queryMs: median(beforeSamples.map((item) => item.queryMs)),
        queries: median(beforeSamples.map((item) => item.queries)),
        quoteWaitMs,
        firstScreenMs: median(beforeSamples.map((item) => item.queryMs)) + quoteWaitMs,
      }
      : null;
    const after = {
      queryMs: median(afterSamples.map((item) => item.queryMs)),
      queries: median(afterSamples.map((item) => item.queries)),
      quoteWaitMs: 0,
      firstScreenMs: median(afterSamples.map((item) => item.queryMs)),
    };
    return {
      fixture: {
        hours,
        perHour,
        firstScreenHours: FIRST_SCREEN_HOURS,
        quoteWaitMs,
        note: '本地夹具复现三条根因的查询形状和同步报价等待，不是线上 14.5 秒的回放。',
      },
      before,
      after,
      week: {
        before: {
          queryMs: median(weekBefore.map((item) => item.queryMs)),
          queries: median(weekBefore.map((item) => item.queries)),
        },
        after: {
          queryMs: median(weekAfter.map((item) => item.queryMs)),
          queries: median(weekAfter.map((item) => item.queries)),
        },
      },
    };
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function formatMs(value) {
  return `${Number(value).toFixed(1)} ms`;
}

export function formatBenchReport(result) {
  const { fixture, before, after, week } = result;
  return [
    '本地首屏基准（不是线上 14.5 秒的回放）',
    `夹具：${fixture.hours} 个小时版本 × 每小时 ${fixture.perHour} 条。首屏槽 ${fixture.firstScreenHours} 小时。`,
    '改动前：每个小时单独读刊期，每条条目 1 次节点查询 + 2 次内容查询 + 1 次来源查询，然后串行再读日报和看板，并在请求里等待外部报价。',
    '改动后：首屏小时一次批量读出，节点和来源各一批；报价缺数据时 pending，请求不再等待上游。组包在 Worker 里完成，Web 只读快照。',
    `同步报价等待：${fixture.quoteWaitMs} ms（--quote-wait-ms，用来代表请求路径上的外部拉取）。`,
    '',
    `改动前首屏：${formatMs(before.firstScreenMs)}（查询 ${formatMs(before.queryMs)}，${before.queries} 次读取，报价等待 ${fixture.quoteWaitMs} ms）`,
    `改动后首屏：${formatMs(after.firstScreenMs)}（查询 ${formatMs(after.queryMs)}，${after.queries} 次读取，报价等待 0 ms）`,
    '',
    `七日 present 改动前：${formatMs(week.before.queryMs)}，${week.before.queries} 次读取`,
    `七日 present 改动后：${formatMs(week.after.queryMs)}，${week.after.queries} 次读取`,
  ].join('\n');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(process.argv[1]);
if (invoked && process.argv[1].endsWith('bench-home-first-screen.mjs')) {
  const args = parseArgs(process.argv);
  const result = runHomeFirstScreenBench(args);
  console.log(formatBenchReport(result));
}
