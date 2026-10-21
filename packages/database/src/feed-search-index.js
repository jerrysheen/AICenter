// 信息流搜索的 FTS5 索引。迁移只建空表；已有帖子在启动之后分批写入，不堵住 Worker。

const readyCache = new WeakMap();
const running = new WeakMap();

const FEED_SEARCH_SOURCE_SQL = `
SELECT ci.rowid AS rowid,
  ci.id AS content_item_id,
  ci.workspace_id AS workspace_id,
  (
    COALESCE(ci.title, '') || char(10) ||
    COALESCE(ci.summary, '') || char(10) ||
    COALESCE(ci.author_name, '') || char(10) ||
    COALESCE(c.author_handle, '') || char(10) ||
    COALESCE(json_extract(c.metadata_json, '$.authorHandle'), '') || char(10) ||
    COALESCE((
      SELECT group_concat(COALESCE(a.name, '') || char(10) || COALESCE(a.handle, ''), char(10))
      FROM item_authors ia
      JOIN authors a ON a.workspace_id = ia.workspace_id AND a.author_id = ia.author_id
      WHERE ia.workspace_id = ci.workspace_id AND ia.content_item_id = ci.id
    ), '') || char(10) ||
    substr(COALESCE(ci.body, ''), 1, 4000)
  ) AS text
FROM content_items ci
LEFT JOIN captures c ON c.id = ci.capture_id AND c.workspace_id = ci.workspace_id`;

function ftsReady(database) {
  if (!database) return false;
  const cached = readyCache.get(database);
  if (cached !== undefined) return cached;
  let ready = false;
  try {
    ready = Boolean(database.prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'content_item_fts'`,
    ).get());
  } catch {
    ready = false;
  }
  readyCache.set(database, ready);
  return ready;
}

const DELETE_FEED_SEARCH_SQL = 'DELETE FROM content_item_fts WHERE rowid = ?';
const INSERT_FEED_SEARCH_SQL = `INSERT INTO content_item_fts(rowid, content_item_id, workspace_id, text) VALUES(?, ?, ?, ?)`;

function writeFeedSearchRow(row, remove, insert) {
  remove.run(row.rowid);
  insert.run(row.rowid, row.content_item_id, row.workspace_id, row.text || '');
}

export function replaceFeedSearchRow(database, contentItemId) {
  const id = String(contentItemId || '');
  if (!id || !ftsReady(database)) return false;
  const row = database.prepare(`${FEED_SEARCH_SOURCE_SQL} WHERE ci.id = ?`).get(id);
  if (!row?.rowid) return false;
  writeFeedSearchRow(
    row,
    database.prepare(DELETE_FEED_SEARCH_SQL),
    database.prepare(INSERT_FEED_SEARCH_SQL),
  );
  return true;
}

export function indexFeedSearchBatch(database, { limit = 40 } = {}) {
  if (!ftsReady(database)) return { indexed: 0, done: true, cursor: 0 };
  const size = Math.max(1, Math.min(Number(limit) || 40, 200));
  const apply = database.transaction(() => {
    const cursor = database.prepare(
      'SELECT rowid_cursor, done FROM feed_search_index_cursor WHERE id = 1',
    ).get();
    if (!cursor) return { indexed: 0, done: true, cursor: 0 };
    if (cursor.done) return { indexed: 0, done: true, cursor: Number(cursor.rowid_cursor) || 0 };
    const rows = database.prepare(
      `${FEED_SEARCH_SOURCE_SQL} WHERE ci.rowid > ? ORDER BY ci.rowid LIMIT ?`,
    ).all(Number(cursor.rowid_cursor) || 0, size);
    const remove = database.prepare(DELETE_FEED_SEARCH_SQL);
    const insert = database.prepare(INSERT_FEED_SEARCH_SQL);
    for (const row of rows) writeFeedSearchRow(row, remove, insert);
    const next = rows.length ? Number(rows[rows.length - 1].rowid) || 0 : Number(cursor.rowid_cursor) || 0;
    const done = rows.length < size ? 1 : 0;
    database.prepare(
      'UPDATE feed_search_index_cursor SET rowid_cursor = ?, done = ? WHERE id = 1',
    ).run(next, done);
    return { indexed: rows.length, done: done === 1, cursor: next };
  });
  return apply.immediate();
}

export function feedSearchIndexStatus(database) {
  if (!ftsReady(database)) return { rows: 0, done: false, cursor: 0, ready: false };
  const cursor = database.prepare(
    'SELECT rowid_cursor, done FROM feed_search_index_cursor WHERE id = 1',
  ).get();
  const rows = database.prepare('SELECT count(*) AS n FROM content_item_fts').get()?.n || 0;
  return {
    rows,
    done: Boolean(cursor?.done),
    cursor: Number(cursor?.rowid_cursor) || 0,
    ready: true,
  };
}

// 返回停止函数。调用方立刻返回，索引在后续事件循环里一批一批写。
export function startFeedSearchIndex(database, { log = () => {} } = {}) {
  if (!database || !ftsReady(database)) return () => {};
  const existing = running.get(database);
  if (existing) return existing;
  let stopped = false;
  const stop = () => { stopped = true; };
  running.set(database, stop);
  log('[feed-search] index start');
  const step = () => {
    if (stopped || database.open === false) return;
    try {
      const result = indexFeedSearchBatch(database, { limit: 40 });
      if (stopped || database.open === false) return;
      if (result.done) {
        log('[feed-search] index done');
        return;
      }
      setImmediate(step);
    } catch (error) {
      const message = String(error?.message || error?.code || error);
      if (stopped || database.open === false || /closed|not open|SQLITE_MISUSE/i.test(message)) return;
      log(`[feed-search] index failed: ${message}`);
    }
  };
  setImmediate(step);
  return stop;
}
