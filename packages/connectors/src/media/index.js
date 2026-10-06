export const MEDIA_SYNC_JOB_TYPE = 'media.sources.sync';
export const MEDIA_PROBE_JOB_TYPE = 'media.sources.probe';
export const MEDIA_ENRICH_JOB_TYPE = 'media.index.enrich';
export const MEDIA_SYNC_SCHEDULE_KEY = 'media-index-sync';

export const mediaConnectorManifest = {
  id: 'connector.media',
  version: '1.0.0',
  capabilities: ['media.read'],
  jobTypes: [MEDIA_SYNC_JOB_TYPE, MEDIA_PROBE_JOB_TYPE],
  sourceIds: ['content.media.articles'],
};

export function ensureMediaIndexSyncSchedule(store, now = Date.now()) {
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: MEDIA_SYNC_SCHEDULE_KEY,
    jobType: MEDIA_SYNC_JOB_TYPE,
    enabled: true,
    schedule: { kind: 'interval', intervalMinutes: 60 },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: now,
  });
}

export function enqueueMediaIndexEnrich(store, workspaceId = 'local') {
  if (!store?.createJob) return null;
  const pending = (store.listJobs?.(40) || []).some((job) => (
    job.type === MEDIA_ENRICH_JOB_TYPE && (job.status === 'queued' || job.status === 'running')
  ));
  if (pending) return null;
  return store.createJob({
    type: MEDIA_ENRICH_JOB_TYPE,
    workspaceId,
    maxAttempts: 2,
    input: { workspaceId },
  });
}

export function createMediaJobHandlers(service) {
  return {
    [MEDIA_PROBE_JOB_TYPE]: input => service.probe({ workspaceId: input.workspaceId || 'local', sourceKeys: input.sourceKeys, policyReviewed: input.policyReviewed === true, run: true }),
    [MEDIA_SYNC_JOB_TYPE]: async (input = {}, context) => {
      const channel = input.channel === 'macro' || input.channel === 'tech' ? input.channel : '';
      const workspaceId = input.workspaceId || 'local';
      const result = await service.syncEnabled({ workspaceId, channel, force: input.force === true });
      if (context?.store && (result.feed?.items?.length || service.selectBodyCandidates?.(workspaceId)?.length)) enqueueMediaIndexEnrich(context.store, workspaceId);
      return result;
    },
  };
}
