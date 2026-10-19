import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { sourceAuthorProfile, officialAuthorForRelease } from '../packages/domain/src/source-authors.js';
import { ensureSourceAuthorItem, syncOfficialReleases } from '../packages/domain/src/source-author-sync.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

const BATCH = 500;
const PHASES = new Set(['captures', 'index', 'official', 'publish']);

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function emptyCounts() {
  return { captures: 0, linked: 0, indexed: 0, official: 0, resorted: 0 };
}

function resumeState(checkpoint) {
  const phase = checkpoint?.phase;
  if (!PHASES.has(phase)) return null;
  return {
    phase,
    afterRowid: Number(checkpoint.afterRowid) || 0,
    afterId: String(checkpoint.afterId || ''),
    officialIndex: Number(checkpoint.officialIndex) || 0,
    repairAfter: String(checkpoint.repairAfter || ''),
    counts: { ...emptyCounts(), ...(checkpoint.counts || {}) },
  };
}

export async function runSourceAuthorBackfill(store, {
  sleepMs = 20,
  dryRun = false,
  onBatch,
  batchSize = BATCH,
  checkpoint = null,
  saveCheckpoint,
} = {}) {
  const limit = Math.max(1, Math.min(Number(batchSize) || BATCH, BATCH));
  const authors = store.repositories.authors;
  const feed = store.repositories.feed;
  const resume = dryRun ? null : resumeState(checkpoint);
  const counts = resume?.counts || emptyCounts();
  let phase = resume?.phase || 'captures';
  const persist = (state) => {
    if (dryRun || typeof saveCheckpoint !== 'function') return;
    saveCheckpoint({
      phase: state.phase,
      afterRowid: Number(state.afterRowid) || 0,
      afterId: String(state.afterId || ''),
      officialIndex: Number(state.officialIndex) || 0,
      repairAfter: String(state.repairAfter || ''),
      counts: { ...counts },
    });
  };
  const pause = async () => {
    if (sleepMs > 0 && !dryRun) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  };

  if (phase === 'captures') {
    let afterRowid = resume?.phase === 'captures' ? resume.afterRowid : 0;
    for (;;) {
      const batch = authors.backfillSourceAuthorBatch({ afterRowid, limit, dryRun });
      counts.captures += batch.rows;
      counts.linked += batch.linked;
      onBatch?.({ phase: 'captures', ...batch, dryRun });
      afterRowid = batch.lastRowid;
      const done = batch.rows < limit;
      persist({ phase: done ? 'index' : 'captures', afterRowid });
      if (done) break;
      await pause();
    }
    phase = 'index';
  }

  if (phase === 'index') {
    let afterId = resume?.phase === 'index' ? resume.afterId : '';
    for (;;) {
      const rows = authors.listMediaIndexForAuthors({ afterId, limit });
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
      const done = rows.length < limit;
      if (!done) afterId = rows.at(-1).externalId;
      persist({ phase: done ? 'official' : 'index', afterId });
      if (done) break;
      await pause();
    }
    phase = 'official';
  }

  if (phase === 'official') {
    const boards = authors.listOfficialBoardPayloads();
    let officialIndex = resume?.phase === 'official' ? Math.min(resume.officialIndex, boards.length) : 0;
    for (; officialIndex < boards.length; officialIndex += 1) {
      const board = boards[officialIndex];
      const releases = Array.isArray(board.payload?.releases) ? board.payload.releases : [];
      const resolvable = releases.filter((release) => officialAuthorForRelease(release, board.payload?.releaseSourceIds || {})).length;
      if (dryRun) {
        counts.official += resolvable;
        onBatch?.({ phase: 'official', workspaceId: board.workspaceId, linked: resolvable, dryRun: true });
      } else {
        const result = syncOfficialReleases(feed, board.workspaceId, releases, board.payload?.releaseSourceIds || {});
        counts.official += result.linked;
        onBatch?.({ phase: 'official', workspaceId: board.workspaceId, linked: result.linked });
      }
      persist({ phase: 'official', officialIndex: officialIndex + 1 });
    }
    phase = 'publish';
  }

  if (phase === 'publish') {
    let repairAfter = resume?.phase === 'publish' ? resume.repairAfter : '';
    for (;;) {
      const batch = authors.repairAuthorPublishBatch({ afterId: repairAfter, limit, dryRun });
      counts.resorted += batch.updated;
      onBatch?.({ phase: 'publish', ...batch, dryRun });
      repairAfter = batch.lastId;
      const done = batch.rows < limit;
      persist({ phase: done ? 'done' : 'publish', repairAfter });
      if (done) break;
      await pause();
    }
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
    let checkpoint = null;
    try { checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')); } catch { checkpoint = null; }
    const result = await runSourceAuthorBackfill(store, {
      sleepMs,
      dryRun,
      checkpoint,
      onBatch(batch) {
        console.log(`[source-authors] ${JSON.stringify(batch)}`);
      },
      saveCheckpoint(state) {
        writeFileSync(checkpointPath, `${JSON.stringify({
          ...state,
          updatedAt: new Date().toISOString(),
          previous: checkpoint?.updatedAt || '',
        })}\n`);
      },
    });
    const elapsedMs = Date.now() - started;
    console.log(`[source-authors] done ${JSON.stringify({ ...result, elapsedMs, dryRun, resumed: Boolean(checkpoint?.phase && checkpoint.phase !== 'done') })}`);
  } finally {
    store.close();
  }
}
