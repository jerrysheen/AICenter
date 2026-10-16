import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { recordCapturedAuthor } from '../packages/database/src/repositories/author-repository.js';
import { authorCaptureFields } from '../packages/domain/src/authors.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const BATCH = 500;

class DryRunRollback extends Error {
  constructor(counts) {
    super('dry-run');
    this.counts = counts;
  }
}

function applyAuthorBatch(database, rows) {
  let linked = 0;
  let written = 0;
  for (const row of rows) {
    let metadata = {};
    try { metadata = JSON.parse(row.metadata_json || '{}') || {}; } catch { metadata = {}; }
    const profile = metadata.authorProfile && typeof metadata.authorProfile === 'object' ? metadata.authorProfile : {};
    const fields = authorCaptureFields(row.provider, {
      ...profile,
      authorNativeId: row.author_native_id || profile.nativeId || '',
      authorHandle: profile.handle || row.author_handle || '',
      authorName: profile.name || row.author_name || '',
    });
    let changed = false;
    if (fields && fields.authorNativeId !== (row.author_native_id || '')) {
      metadata.authorProfile = fields.authorProfile;
      database.prepare('UPDATE captures SET author_native_id = ?, metadata_json = ? WHERE id = ?')
        .run(fields.authorNativeId, JSON.stringify(metadata), row.capture_id);
      changed = true;
    }
    if (row.content_item_id && fields) {
      const result = recordCapturedAuthor(database, {
        workspaceId: row.workspace_id,
        captureId: row.capture_id,
        contentItemId: row.content_item_id,
        authorName: row.author_name || '',
        title: row.title || '',
        publishedAt: row.item_published_at || row.published_at || null,
        createdAt: row.created_at,
      });
      if (result?.inserted || result?.reassigned) changed = true;
      if (result) linked += 1;
    }
    if (changed) written += 1;
  }
  return { linked, written };
}

export function backfillAuthorBatch(database, { afterRowid = 0, limit = BATCH, dryRun = false } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || BATCH, BATCH));
  const rows = database.prepare(`SELECT c.rowid AS rowid, c.id AS capture_id, c.workspace_id, c.provider,
      c.author_native_id, c.author_handle, c.metadata_json, c.published_at, c.captured_at,
      ci.id AS content_item_id, ci.author_name, ci.title, ci.published_at AS item_published_at, ci.created_at
    FROM captures c
    LEFT JOIN content_items ci ON ci.capture_id = c.id AND ci.workspace_id = c.workspace_id
    WHERE c.rowid > ? AND c.provider IN ('x', 'xueqiu', 'bilibili')
    ORDER BY c.rowid
    LIMIT ?`).all(Number(afterRowid) || 0, cap);
  const lastRowid = rows.length ? Number(rows.at(-1).rowid) : Number(afterRowid) || 0;
  if (dryRun) {
    let counts = { linked: 0, written: 0 };
    try {
      database.transaction(() => {
        counts = applyAuthorBatch(database, rows);
        throw new DryRunRollback(counts);
      })();
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
      counts = error.counts;
    }
    return { rows: rows.length, linked: counts.linked, written: counts.written, lastRowid, dryRun: true };
  }
  const counts = database.transaction(() => applyAuthorBatch(database, rows))();
  return { rows: rows.length, linked: counts.linked, written: counts.written, lastRowid, dryRun: false };
}

export async function runAuthorBackfill(database, { afterRowid = 0, sleepMs = 50, dryRun = false, onBatch } = {}) {
  let cursor = Number(afterRowid) || 0;
  let total = 0;
  let written = 0;
  for (;;) {
    const batch = backfillAuthorBatch(database, { afterRowid: cursor, dryRun });
    total += batch.rows;
    written += batch.written;
    cursor = batch.lastRowid;
    onBatch?.(batch);
    if (batch.rows < BATCH) return { total, written, lastRowid: cursor, dryRun };
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

export function openBackfillDatabase(file) {
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  return database;
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
  const root = process.cwd();
  const instance = resolveInstanceConfig({ repositoryRoot: root });
  const checkpointPath = path.join(path.dirname(instance.databasePath), 'author-backfill.json');
  let checkpoint = { lastRowid: 0 };
  try { checkpoint = { ...checkpoint, ...JSON.parse(readFileSync(checkpointPath, 'utf8')) }; } catch { /* 从头开始 */ }
  const dryRun = process.argv.includes('--dry-run');
  const store = createStore(instance.databasePath);
  store.close();
  const database = openBackfillDatabase(instance.databasePath);
  try {
    const result = await runAuthorBackfill(database, {
      afterRowid: Number(arg('--after', checkpoint.lastRowid || 0)) || 0,
      sleepMs: Number(arg('--sleep-ms', '50')) || 0,
      dryRun,
      onBatch(batch) {
        if (!dryRun) {
          writeFileSync(checkpointPath, `${JSON.stringify({ lastRowid: batch.lastRowid, updatedAt: new Date().toISOString() })}\n`);
        }
        console.log(`[authors] backfill rows=${batch.rows} linked=${batch.linked} written=${batch.written} rowid=${batch.lastRowid}${dryRun ? ' dry-run' : ''}`);
      },
    });
    console.log(`[authors] backfill done total=${result.total} written=${result.written} rowid=${result.lastRowid}${dryRun ? ' dry-run' : ''}`);
  } finally {
    database.close();
  }
}
