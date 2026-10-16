import { monthFromTitle } from './polymarket-rollover.js';

export function eventTagSlugs(event) {
  return (Array.isArray(event?.tags) ? event.tags : [])
    .map((tag) => String(tag?.slug || tag || '').trim().toLowerCase())
    .filter(Boolean);
}

export function matchesRollingTitle(title, config) {
  for (const series of config?.rollingSeries || []) {
    if (monthFromTitle(title, series.titleTemplate, config.months || [])) return true;
  }
  return false;
}

export function discoveryCandidate(event, config, { watchedIds, candidateIds, fixedSlugs, tagSlug } = {}) {
  const eventId = String(event?.id || '').trim();
  const title = String(event?.title || '').trim();
  if (!eventId || !title) return null;
  if (watchedIds?.has(eventId) || candidateIds?.has(eventId)) return null;
  if (fixedSlugs?.has(String(event?.slug || ''))) return null;
  if (matchesRollingTitle(title, config)) return null;
  const tags = eventTagSlugs(event);
  const excluded = new Set((config?.discovery?.excludeTags || []).map((tag) => String(tag).toLowerCase()));
  if (tags.some((tag) => excluded.has(tag))) return null;
  let pattern;
  try {
    pattern = new RegExp(config?.discovery?.excludeTitlePattern || '$^', 'i');
  } catch {
    pattern = /$^/;
  }
  if (pattern.test(title)) return null;
  const volume24h = Number(event.volume24hr) || 0;
  const totalVolume = Number(event.volume) || 0;
  const min24 = Number(config?.discovery?.minVolume24hUsd) || 0;
  const minTotal = Number(config?.discovery?.minTotalVolumeUsd) || 0;
  if (volume24h < min24 && totalVolume < minTotal) return null;
  return {
    eventId,
    eventSlug: String(event.slug || ''),
    title,
    tagSlug: String(tagSlug || ''),
    volume24h,
    totalVolume,
  };
}

export function alertProfileForDiscovered(tags, outcomeCount) {
  const names = new Set((tags || []).map((tag) => String(tag).toLowerCase()));
  if (['geopolitics', 'iran', 'strait-of-hormuz'].some((tag) => names.has(tag))) return 'geopolitics';
  return outcomeCount > 1 ? 'multi' : 'binary';
}
