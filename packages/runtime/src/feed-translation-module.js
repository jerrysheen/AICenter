import { FeedTranslationJobInputSchema } from '../../contracts/src/index.js';
import { TRANSLATION_MAX_ATTEMPTS } from '../../database/src/translation-retry.js';

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
  for (const unit of units.filter(unit => pending.has(unit.id) && unit.text.length <= 20000)) {
    const input = FeedTranslationJobInputSchema.parse({ workspaceId, items: [{ id: unit.localizationId || unit.id, text: unit.text }] });
    const open = store.listOpenJobs?.('feed.translation.run')?.find(job => job.workspaceId === workspaceId && JSON.stringify(job.input) === JSON.stringify(input));
    jobs.push(open || store.createJob({ type: 'feed.translation.run', workspaceId, input, maxAttempts: TRANSLATION_MAX_ATTEMPTS }));
  }
  return jobs;
}
