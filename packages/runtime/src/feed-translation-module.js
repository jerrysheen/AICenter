import { FEED_TRANSLATION_TEXT_MAX, FeedTranslationJobInputSchema } from '../../contracts/src/index.js';
import { TRANSLATION_MAX_ATTEMPTS } from '../../database/src/translation-retry.js';
import { needsZhLocalization } from '../../domain/src/localize-texts.js';

export const TRANSLATION_BACKFILL_LIMIT = 80;
export const TRANSLATION_BACKFILL_STARTUP_MAX = 80;

export function translationStartupBackfillLimit(value) {
  if (value === undefined || value === null || String(value).trim() === '') return TRANSLATION_BACKFILL_LIMIT;
  const raw = Number(value);
  if (!Number.isInteger(raw) || raw < 0) return TRANSLATION_BACKFILL_LIMIT;
  return Math.min(raw, TRANSLATION_BACKFILL_STARTUP_MAX);
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

export async function enqueueOriginalTranslations({ store, feedService, workspaceId, units }) {
  if (!store?.createJob || !feedService?.localizeTexts || !units.length) return [];
  const state = await feedService.localizeTexts(units, { workspaceId }, { wait: false });
  const pending = new Set(state.pendingIds || []);
  const jobs = [];
  for (const unit of units.filter(unit => pending.has(unit.id) && unit.text.length > 0 && unit.text.length <= FEED_TRANSLATION_TEXT_MAX)) {
    const input = FeedTranslationJobInputSchema.parse({ workspaceId, items: [{ id: unit.localizationId || unit.id, text: unit.text }] });
    const open = store.listOpenJobs?.('feed.translation.run')?.find(job => job.workspaceId === workspaceId && JSON.stringify(job.input) === JSON.stringify(input));
    jobs.push(open || store.createJob({ type: 'feed.translation.run', workspaceId, input, maxAttempts: TRANSLATION_MAX_ATTEMPTS }));
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
  if (cap === 0 || !repo?.listUntranslatedFeedBodies || !feedService?.localizeTexts) return [];
  const rows = repo.listUntranslatedFeedBodies(workspaceId, {
    limit: cap,
    scan: Math.min(500, Math.max(cap * 5, cap)),
    excludeSourceIds,
  });
  const units = [];
  for (const row of rows) {
    const text = String(row.body || '').trim();
    if (!text || text.length > FEED_TRANSLATION_TEXT_MAX || !needsZhLocalization(text)) continue;
    units.push({ id: row.id, text });
    if (units.length >= cap) break;
  }
  if (!units.length) return [];
  return enqueueOriginalTranslations({ store, feedService, workspaceId, units });
}
