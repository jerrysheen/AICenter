import { createHash } from 'node:crypto';
import { FEED_TRANSLATION_TEXT_MAX, FeedTranslationJobInputSchema } from '../../contracts/src/index.js';
import { TRANSLATION_MAX_ATTEMPTS } from '../../database/src/translation-retry.js';
import { stripLeadingPreview } from '../../connectors/src/x/home-browser.js';
import { needsZhLocalization, translationLooksTruncated } from '../../domain/src/localize-texts.js';

function bodyHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export const TRANSLATION_BACKFILL_PRIORITY = -10;
export const TRANSLATION_INTERACTIVE_PRIORITY = 10;
export const TRANSLATION_JOB_UNIT_LIMIT = 30;
export const TRANSLATION_JOB_CHAR_BUDGET = 12_000;
export const TRANSLATION_BULK_JOB_CAP = 8;

export const TRANSLATION_BACKFILL_LIMIT = 80;
export const TRANSLATION_BACKFILL_STARTUP_MAX = 80;

export function translationStartupBackfillLimit(value) {
  if (value === undefined || value === null || String(value).trim() === '') return TRANSLATION_BACKFILL_LIMIT;
  const raw = Number(value);
  if (!Number.isInteger(raw) || raw < 0) return TRANSLATION_BACKFILL_LIMIT;
  return Math.min(raw, TRANSLATION_BACKFILL_STARTUP_MAX);
}

// Backfill stays at 1 or 2 jobs. When the translation pool has room, one slot stays for priority >= 0.
export function translationBackfillConcurrency(value, translationLimit = 5) {
  const slots = Number.isInteger(Number(translationLimit)) && Number(translationLimit) >= 1 ? Number(translationLimit) : 5;
  const raw = Number(value);
  const chosen = Number.isInteger(raw) && raw >= 1 ? raw : 2;
  const capped = Math.min(2, Math.max(1, chosen));
  return slots >= 2 ? Math.min(capped, slots - 1) : 1;
}

export function createFeedTranslationChunkStore(feed) {
  return {
    load({ workspaceId, itemId, targetLang, sourceHash }) {
      return feed?.listTranslationChunks?.(workspaceId, itemId, targetLang, sourceHash) || [];
    },
    save(row) {
      feed?.saveTranslationChunk?.(row);
    },
    clear({ workspaceId, itemId, targetLang }) {
      feed?.deleteTranslationChunks?.(workspaceId, itemId, targetLang);
    },
  };
}

function emptyBackfillSummary(limit) {
  return {
    enqueued: 0, limit, scanned: 0, cjk: 0, flash: 0, hidden: 0, tooLong: 0, empty: 0,
    translated: 0, failure: 0, hourlyTitle: 0, stale: 0, otherProvider: 0,
    ids: { cjk: [], flash: [], hidden: [], tooLong: [], translated: [], failure: [], hourlyTitle: [], stale: [] },
  };
}

function noteSkip(summary, key, id) {
  summary[key] += 1;
  if (id && summary.ids[key] && summary.ids[key].length < 8) summary.ids[key].push(id);
}

function translationCovers(rowHash, engine, translatedLength, text, hash, translatedText = '') {
  if (!rowHash || rowHash !== hash) return false;
  if (engine === 'hourly-report' && text.length > 400 && text.length > Number(translatedLength) * 3) return false;
  if (translationLooksTruncated(text, translatedLength, translatedText)) return false;
  return true;
}

export function formatTranslationBackfillLog(summary = {}, { enqueued = 0, limit = 0 } = {}) {
  const fields = [
    ['cjk', summary.cjk], ['flash', summary.flash], ['hidden', summary.hidden],
    ['too-long', summary.tooLong], ['translated', summary.translated], ['failure', summary.failure],
    ['hourly-title', summary.hourlyTitle], ['stale', summary.stale], ['other-provider', summary.otherProvider],
  ];
  const idKeys = [
    ['cjk', 'cjk'], ['flash', 'flash'], ['hidden', 'hidden'], ['too-long', 'tooLong'],
    ['translated', 'translated'], ['failure', 'failure'], ['hourly-title', 'hourlyTitle'], ['stale', 'stale'],
  ];
  const ids = idKeys.flatMap(([label, key]) => (summary.ids?.[key]?.length ? [`${label}-ids=${summary.ids[key].join(',')}`] : []));
  return `[worker] translation-backfill enqueued=${enqueued} limit=${limit} scanned=${summary.scanned ?? 0} ${fields.map(([name, value]) => `${name}=${Number(value) || 0}`).join(' ')}${ids.length ? ` ${ids.join(' ')}` : ''}`;
}

export const feedTranslationManifest = Object.freeze({
  id: 'feed.translation', version: '1.0.0',
  capabilities: ['feed.translation.run'], jobTypes: ['feed.translation.run'],
});

export function createFeedTranslationJobHandlers({ feedService }) {
  return {
    'feed.translation.run': async input => {
      const value = FeedTranslationJobInputSchema.parse(input);
      return feedService.translateMany(value, { workspaceId: value.workspaceId });
    },
  };
}

export function packTranslationJobBatches(units) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const unit of units) {
    const size = String(unit?.text || '').length;
    if (batch.length && (batch.length >= TRANSLATION_JOB_UNIT_LIMIT || chars + size > TRANSLATION_JOB_CHAR_BUDGET)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(unit);
    chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function translationItemId(unit) {
  return unit.localizationId || unit.id;
}

export function demoteQueuedHashTranslationJobs(store, workspaceId = 'local') {
  if (!store?.listOpenJobs || !store?.reprioritizeQueuedJobs) return 0;
  const changes = [];
  for (const job of store.listOpenJobs('feed.translation.run') || []) {
    if (job.workspaceId !== workspaceId || job.status !== 'queued') continue;
    const priority = Number(job.priority) || 0;
    if (priority < 0) continue;
    const items = job.input?.items || [];
    if (items.length !== 1 || !String(items[0]?.id || '').startsWith('h:')) continue;
    changes.push({ id: job.id, priority: TRANSLATION_BACKFILL_PRIORITY, expectedPriority: priority });
  }
  if (!changes.length) return 0;
  const changed = store.reprioritizeQueuedJobs(workspaceId, changes);
  return Array.isArray(changed) ? changed.length : changes.length;
}

export async function enqueueOriginalTranslations({ store, feedService, workspaceId, units, priority = 0 }) {
  if (!store?.createJob || !feedService?.localizeTexts || !units?.length) return [];
  const state = await feedService.localizeTexts(units, { workspaceId }, { wait: false });
  const pending = new Set(state.pendingIds || []);
  const rank = Number.isFinite(priority) ? Math.trunc(priority) : 0;
  const eligible = units.filter((unit) => pending.has(unit.id) && unit.text.length > 0 && unit.text.length <= FEED_TRANSLATION_TEXT_MAX);
  const openJobs = (store.listOpenJobs?.('feed.translation.run') || []).filter((job) => job.workspaceId === workspaceId);
  const jobs = [];
  const seen = new Set();
  const fresh = [];
  const requested = new Set(eligible.map((unit) => translationItemId(unit)));
  const remember = (job) => {
    if (!job || seen.has(job.id)) return;
    seen.add(job.id);
    jobs.push(job);
  };
  for (const unit of eligible) {
    const open = openJobs.find((job) => (job.input?.items || []).some((item) => item?.id === translationItemId(unit)));
    if (!open) {
      fresh.push(unit);
      continue;
    }
    if (open.status === 'queued' && Number(open.priority) !== rank) {
      const current = Number(open.priority) || 0;
      const coversRequest = (open.input?.items || []).every((item) => requested.has(item.id));
      if (rank < 0 && current === 0 && coversRequest && store.reprioritizeQueuedJobs) {
        store.reprioritizeQueuedJobs(workspaceId, [{ id: open.id, priority: rank, expectedPriority: current }]);
        open.priority = rank;
      } else if (rank > current && store.prioritizeQueuedJobs) {
        store.prioritizeQueuedJobs(workspaceId, [open.id], rank);
        open.priority = rank;
      }
    }
    remember(open);
  }
  const batches = packTranslationJobBatches(fresh);
  const cap = rank < 0 ? TRANSLATION_BULK_JOB_CAP : batches.length;
  for (const batch of batches.slice(0, cap)) {
    const input = FeedTranslationJobInputSchema.parse({
      workspaceId,
      items: batch.map((unit) => ({ id: translationItemId(unit), text: unit.text })),
    });
    const open = openJobs.find((job) => JSON.stringify(job.input) === JSON.stringify(input));
    const job = open || store.createJob({
      type: 'feed.translation.run', workspaceId, input, maxAttempts: TRANSLATION_MAX_ATTEMPTS, priority: rank,
    });
    if (!open) openJobs.push(job);
    remember(job);
  }
  return jobs;
}

export async function backfillUntranslatedFeedTranslations({
  store, feedService, workspaceId = 'local', limit = TRANSLATION_BACKFILL_LIMIT, excludeSourceIds = [],
} = {}) {
  const repo = store?.repositories?.feed;
  const requested = Number(limit);
  const cap = Number.isInteger(requested) && requested >= 0
    ? Math.min(requested, 200)
    : TRANSLATION_BACKFILL_LIMIT;
  const summary = emptyBackfillSummary(cap);
  if (cap === 0 || !repo?.listUntranslatedFeedBodies || !feedService?.localizeTexts) return { jobs: [], summary };
  const flash = new Set((excludeSourceIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const rows = repo.listUntranslatedFeedBodies(workspaceId, {
    limit: cap,
    scan: Math.min(500, Math.max(cap * 5, cap)),
    excludeSourceIds,
  });
  summary.scanned = rows.length;
  summary.otherProvider = repo.countLongUntranslatedOutsideProviders?.(workspaceId) || 0;
  const units = [];
  for (const row of rows) {
    if (row.hidden) { noteSkip(summary, 'hidden', row.id); continue; }
    if (flash.has(row.sourceExternalId)) { noteSkip(summary, 'flash', row.id); continue; }
    let text = stripLeadingPreview(row.body || '');
    if (text && text !== String(row.body || '').trim() && repo.replaceContentBody?.(workspaceId, row.id, text)) {
      row.body = text;
    }
    if (!text) { noteSkip(summary, 'empty', row.id); continue; }
    if (text.length > FEED_TRANSLATION_TEXT_MAX) { noteSkip(summary, 'tooLong', row.id); continue; }
    const hash = bodyHash(text);
    const covered = translationCovers(row.translationHash, row.translationEngine, row.translationLength, text, hash, row.translationTail)
      || translationCovers(row.externalTranslationHash, row.externalTranslationEngine, row.externalTranslationLength, text, hash, row.externalTranslationTail);
    if (covered) {
      noteSkip(summary, 'translated', row.id);
      continue;
    }
    if (!needsZhLocalization(text)) { noteSkip(summary, 'cjk', row.id); continue; }
    const hourlyTitle = (row.translationEngine === 'hourly-report' && row.translationHash === hash)
      || (row.externalTranslationEngine === 'hourly-report' && row.externalTranslationHash === hash);
    if (hourlyTitle) noteSkip(summary, 'hourlyTitle', row.id);
    else if (row.translationHash || row.externalTranslationHash) noteSkip(summary, 'stale', row.id);
    units.push({ id: row.id, text });
    if (units.length >= cap) break;
  }
  if (!units.length) return { jobs: [], summary };
  const preview = await feedService.localizeTexts(units, { workspaceId }, { wait: false });
  const pending = new Set(preview?.pendingIds || []);
  const queued = [];
  for (const unit of units) {
    if (pending.has(unit.id)) { queued.push(unit); continue; }
    const loc = preview?.localizations?.[unit.id];
    if (loc?.engine === 'hourly-report') noteSkip(summary, 'hourlyTitle', unit.id);
    else if (loc?.status === 'failed') noteSkip(summary, 'failure', unit.id);
    else noteSkip(summary, 'translated', unit.id);
  }
  const jobs = queued.length
    ? await enqueueOriginalTranslations({
      store, feedService, workspaceId, units: queued, priority: TRANSLATION_BACKFILL_PRIORITY,
    })
    : [];
  summary.enqueued = jobs.length;
  return { jobs, summary };
}

export function repairEllipsisLeadTexts({
  store, workspaceId = 'local', limit = TRANSLATION_BACKFILL_LIMIT,
} = {}) {
  const repo = store?.repositories?.feed;
  const requested = Number(limit);
  const cap = Number.isInteger(requested) && requested >= 0
    ? Math.min(requested, TRANSLATION_BACKFILL_STARTUP_MAX)
    : TRANSLATION_BACKFILL_LIMIT;
  if (cap === 0 || !repo?.listEllipsisLeadBodies || !repo?.listEllipsisLeadTranslations || !repo?.saveTranslations) {
    return { bodies: 0, translations: 0 };
  }
  const cleanedByItem = new Map();
  let bodies = 0;
  for (const row of repo.listEllipsisLeadBodies(workspaceId, { limit: 400 })) {
    if (bodies >= cap) break;
    const cleaned = stripLeadingPreview(row.body || '');
    if (!cleaned || cleaned === String(row.body || '')) continue;
    if (!repo.replaceContentBody?.(workspaceId, row.id, cleaned)) continue;
    bodies += 1;
    const fix = { previousHash: bodyHash(row.body || ''), nextHash: bodyHash(cleaned) };
    cleanedByItem.set(row.id, fix);
    if (row.provider && row.externalId) cleanedByItem.set(`${row.provider}:${row.externalId}`, fix);
  }
  let translations = 0;
  for (const row of repo.listEllipsisLeadTranslations(workspaceId, { limit: 400 })) {
    if (translations >= cap) break;
    const cleaned = stripLeadingPreview(row.translatedText || '');
    if (!cleaned || !row.itemId || !row.sourceHash || cleaned === String(row.translatedText || '')) continue;
    const fix = cleanedByItem.get(row.itemId);
    const sourceHash = fix && row.sourceHash === fix.previousHash ? fix.nextHash : row.sourceHash;
    repo.saveTranslations([{
      workspaceId,
      itemId: row.itemId,
      targetLang: row.targetLang === 'en' ? 'en' : 'zh',
      sourceHash,
      translatedText: cleaned,
      engine: row.engine || '',
    }]);
    translations += 1;
  }
  return { bodies, translations };
}
