import { createHash } from 'node:crypto';
import { FEED_TRANSLATION_TEXT_MAX, FeedTranslationJobInputSchema } from '../../contracts/src/index.js';
import { TRANSLATION_MAX_ATTEMPTS } from '../../database/src/translation-retry.js';
import { needsZhLocalization } from '../../domain/src/localize-texts.js';

function bodyHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export const TRANSLATION_BACKFILL_PRIORITY = -10;
export const TRANSLATION_INTERACTIVE_PRIORITY = 10;

export const TRANSLATION_BACKFILL_LIMIT = 80;
export const TRANSLATION_BACKFILL_STARTUP_MAX = 80;

export function translationStartupBackfillLimit(value) {
  if (value === undefined || value === null || String(value).trim() === '') return TRANSLATION_BACKFILL_LIMIT;
  const raw = Number(value);
  if (!Number.isInteger(raw) || raw < 0) return TRANSLATION_BACKFILL_LIMIT;
  return Math.min(raw, TRANSLATION_BACKFILL_STARTUP_MAX);
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

function translationCovers(rowHash, engine, translatedLength, text, hash) {
  if (!rowHash || rowHash !== hash) return false;
  return !(engine === 'hourly-report' && text.length > 400 && text.length > Number(translatedLength) * 3);
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

export async function enqueueOriginalTranslations({ store, feedService, workspaceId, units, priority = 0 }) {
  if (!store?.createJob || !feedService?.localizeTexts || !units.length) return [];
  const state = await feedService.localizeTexts(units, { workspaceId }, { wait: false });
  const pending = new Set(state.pendingIds || []);
  const jobs = [];
  const rank = Number.isFinite(priority) ? Math.trunc(priority) : 0;
  for (const unit of units.filter(unit => pending.has(unit.id) && unit.text.length > 0 && unit.text.length <= FEED_TRANSLATION_TEXT_MAX)) {
    const input = FeedTranslationJobInputSchema.parse({ workspaceId, items: [{ id: unit.localizationId || unit.id, text: unit.text }] });
    const open = store.listOpenJobs?.('feed.translation.run')?.find(job => job.workspaceId === workspaceId && JSON.stringify(job.input) === JSON.stringify(input));
    jobs.push(open || store.createJob({ type: 'feed.translation.run', workspaceId, input, maxAttempts: TRANSLATION_MAX_ATTEMPTS, priority: rank }));
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
    const text = String(row.body || '').trim();
    if (!text) { noteSkip(summary, 'empty', row.id); continue; }
    if (text.length > FEED_TRANSLATION_TEXT_MAX) { noteSkip(summary, 'tooLong', row.id); continue; }
    const hash = bodyHash(text);
    const covered = translationCovers(row.translationHash, row.translationEngine, row.translationLength, text, hash)
      || translationCovers(row.externalTranslationHash, row.externalTranslationEngine, row.externalTranslationLength, text, hash);
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
