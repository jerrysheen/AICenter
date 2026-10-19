import Database from 'better-sqlite3';
import { normalizeXueqiuAvatar } from '../packages/connectors/src/xueqiu/home-browser.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

class DryRunRollback extends Error {
  constructor() {
    super('dry-run');
  }
}

function authorUpdates(database) {
  const rows = database.prepare(`SELECT workspace_id, author_id, avatar_url
    FROM authors WHERE platform = 'xueqiu' AND avatar_url != ''`).all();
  const updates = [];
  for (const row of rows) {
    const next = normalizeXueqiuAvatar(row.avatar_url);
    if (!next || next === row.avatar_url) continue;
    updates.push({ workspaceId: row.workspace_id, authorId: row.author_id, from: row.avatar_url, next });
  }
  return updates;
}

function captureUpdates(database) {
  const rows = database.prepare(`SELECT id, metadata_json FROM captures
    WHERE provider = 'xueqiu' AND instr(metadata_json, 'avatarUrl') > 0`).all();
  const updates = [];
  for (const row of rows) {
    let metadata;
    try { metadata = JSON.parse(row.metadata_json || '{}'); } catch { continue; }
    const profile = metadata?.authorProfile;
    if (!profile || typeof profile.avatarUrl !== 'string') continue;
    const next = normalizeXueqiuAvatar(profile.avatarUrl);
    if (!next || next === profile.avatarUrl) continue;
    profile.avatarUrl = next;
    updates.push({ id: row.id, metadata: JSON.stringify(metadata) });
  }
  return updates;
}

function applyUpdates(database, authors, captures) {
  const updateAuthor = database.prepare(`UPDATE authors SET avatar_url = ?
    WHERE workspace_id = ? AND author_id = ? AND avatar_url = ?`);
  for (const row of authors) updateAuthor.run(row.next, row.workspaceId, row.authorId, row.from);
  const updateCapture = database.prepare('UPDATE captures SET metadata_json = ? WHERE id = ?');
  for (const row of captures) updateCapture.run(row.metadata, row.id);
}

export function backfillXueqiuAvatars(database, { dryRun = false } = {}) {
  const authors = authorUpdates(database);
  const captures = captureUpdates(database);
  if (dryRun) {
    try {
      database.transaction(() => {
        applyUpdates(database, authors, captures);
        throw new DryRunRollback();
      })();
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
  } else if (authors.length || captures.length) {
    database.transaction(() => applyUpdates(database, authors, captures))();
  }
  return { authors: authors.length, captures: captures.length, dryRun: Boolean(dryRun) };
}

export function openXueqiuAvatarDatabase(file) {
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  return database;
}

const invoked = isMain(import.meta.url);
if (invoked) {
  const dryRun = process.argv.includes('--dry-run');
  const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
  const database = openXueqiuAvatarDatabase(instance.databasePath);
  try {
    const result = backfillXueqiuAvatars(database, { dryRun });
    console.log(`[xueqiu-avatar] authors=${result.authors} captures=${result.captures}${result.dryRun ? ' dry-run' : ''}`);
  } finally {
    database.close();
  }
}
