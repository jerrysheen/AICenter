import { discoveryCandidate } from '../../domain/src/polymarket-discovery.js';

export const POLYMARKET_DISCOVERY_JOB_TYPE = 'market.polymarket.discover';
export const POLYMARKET_DISCOVERY_SCHEDULE_KEY = 'market.polymarket.discover';

export const polymarketDiscoveryManifest = Object.freeze({
  id: 'market.polymarket-discovery',
  version: '1.0.0',
  capabilities: [POLYMARKET_DISCOVERY_JOB_TYPE],
  jobTypes: [POLYMARKET_DISCOVERY_JOB_TYPE],
});

export async function discoverPolymarketCandidates({
  client,
  repository,
  config,
  now = () => Date.now(),
}) {
  if (!client?.fetchEventsByTag) throw new Error('Polymarket 发现需要按标签读取');
  if (!repository?.insertCandidates) throw new Error('Polymarket 发现需要候选存储');
  const at = Math.trunc(now());
  const watchedIds = new Set((repository.listWatchedOutcomes?.() || []).map((row) => row.eventId));
  const candidateIds = new Set(repository.listCandidateEventIds?.() || []);
  const fixedSlugs = new Set((config?.fixed || []).map((entry) => entry.slug));
  const found = [];
  const errors = [];
  for (const tag of config?.discovery?.whitelistTags || []) {
    try {
      const events = await client.fetchEventsByTag(tag, {
        limit: Number(config.discovery.pageLimit) || 100,
        closed: false,
      });
      for (const event of events) {
        const candidate = discoveryCandidate(event, config, { watchedIds, candidateIds, fixedSlugs, tagSlug: tag });
        if (!candidate) continue;
        candidateIds.add(candidate.eventId);
        watchedIds.add(candidate.eventId);
        found.push(candidate);
      }
    } catch (error) {
      errors.push({ tag, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const inserted = found.length ? repository.insertCandidates(found, at) : 0;
  return { inserted, scanned: (config?.discovery?.whitelistTags || []).length, errors };
}

export function createPolymarketDiscoveryJobHandlers({ client, repository, config, now = () => Date.now() }) {
  return {
    [POLYMARKET_DISCOVERY_JOB_TYPE]: async () => discoverPolymarketCandidates({ client, repository, config, now }),
  };
}

export function ensurePolymarketDiscoverySchedule(store, config, now = Date.now(), { enabled = true } = {}) {
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: POLYMARKET_DISCOVERY_SCHEDULE_KEY,
    jobType: POLYMARKET_DISCOVERY_JOB_TYPE,
    enabled: Boolean(enabled),
    schedule: { kind: 'interval', intervalMinutes: Number(config?.discovery?.scanIntervalMinutes) || 60 },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: Math.trunc(Number(now)),
  });
}
