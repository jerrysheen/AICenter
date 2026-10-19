import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { sourceAuthorProfile, officialAuthorForRelease } from '../packages/domain/src/source-authors.js';
import { ensureSourceAuthorItem, syncOfficialReleases } from '../packages/domain/src/source-author-sync.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

const BATCH = 500;

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

export async function runSourceAuthorBackfill(store, { sleepMs = 20, dryRun = false, onBatch } = {}) {
  const authors = store.repositories.authors;
  const feed = store.repositories.feed;
  const counts = { captures: 0, linked: 0, indexed: 0, official: 0, resorted: 0 };
  let afterRowid = 0;
  for (;;) {
    const batch = authors.backfillSourceAuthorBatch({ afterRowid, limit: BATCH, dryRun });
    counts.captures += batch.rows;
    counts.linked += batch.linked;
    onBatch?.({ phase: 'captures', ...batch, dryRun });
    afterRowid = batch.lastRowid;
    if (batch.rows < BATCH) break;
    if (sleepMs > 0 && !dryRun) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  let afterId = '';
  for (;;) {
    const rows = authors.listMediaIndexForAuthors({ afterId, limit: BATCH });
    let indexed = 0;
    if (!dryRun) {
      for (const row of rows) {
        if (!sourceAuthorProfile(row.sourceKey) || !feed) continue;
        const result = syncIndexRow(feed, row);
        if (result) indexed += 1;
      }
    } else {
      indexed = rows.filter((row) => sourceAuthorProfile(row.sourceKey)).length;
    }
    counts.indexed += indexed;
    onBatch?.({ phase: 'index', rows: rows.length, indexed, afterId });
    if (!rows.length || rows.length < BATCH) break;
    afterId = rows.at(-1).externalId;
    if (sleepMs > 0 && !dryRun) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  for (const board of authors.listOfficialBoardPayloads()) {
    const releases = Array.isArray(board.payload?.releases) ? board.payload.releases : [];
    const resolvable = releases.filter((release) => officialAuthorForRelease(release, board.payload?.releaseSourceIds || {})).length;
    if (dryRun) {
      counts.official += resolvable;
      onBatch?.({ phase: 'official', workspaceId: board.workspaceId, linked: resolvable, dryRun: true });
      continue;
    }
    const result = syncOfficialReleases(feed, board.workspaceId, releases, board.payload?.releaseSourceIds || {});
    counts.official += result.linked;
    onBatch?.({ phase: 'official', workspaceId: board.workspaceId, linked: result.linked });
  }
  let repairAfter = '';
  for (;;) {
    const batch = authors.repairAuthorPublishBatch({ afterId: repairAfter, limit: BATCH, dryRun });
    counts.resorted += batch.updated;
    onBatch?.({ phase: 'publish', ...batch, dryRun });
    repairAfter = batch.lastId;
    if (batch.rows < BATCH) break;
    if (sleepMs > 0 && !dryRun) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  return counts;
}

function syncIndexRow(feed, row) {
  return ensureSourceAuthorItem(feed, {
    workspaceId: row.workspaceId,
    sourceKey: row.sourceKey,
    externalId: row.externalId,
    title: row.title,
    summary: row.summary,
    sourceUrl: row.sourceUrl,
    publishedAt: row.publishedAt,
    publishedAtRaw: row.publishedAtRaw,
    contentHash: row.contentHash,
  });
}

const invoked = isMain(import.meta.url);
if (invoked) {
  const root = process.cwd();
  const instance = resolveInstanceConfig({ repositoryRoot: root });
  const checkpointPath = path.join(path.dirname(instance.databasePath), 'source-author-backfill.json');
  const dryRun = process.argv.includes('--dry-run');
  const sleepMs = Number(arg('--sleep-ms', '20')) || 0;
  const started = Date.now();
  const store = createStore(instance.databasePath);
  try {
    let checkpoint = {};
    try { checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')); } catch { checkpoint = {}; }
    const result = await runSourceAuthorBackfill(store, {
      sleepMs,
      dryRun,
      onBatch(batch) {
        console.log(`[source-authors] ${JSON.stringify(batch)}`);
      },
    });
    const elapsedMs = Date.now() - started;
    if (!dryRun) {
      writeFileSync(checkpointPath, `${JSON.stringify({ ...result, elapsedMs, updatedAt: new Date().toISOString(), previous: checkpoint.updatedAt || '' })}\n`);
    }
    console.log(`[source-authors] done ${JSON.stringify({ ...result, elapsedMs, dryRun })}`);
  } finally {
    store.close();
  }
}
