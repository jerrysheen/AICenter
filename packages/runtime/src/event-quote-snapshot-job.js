import { readMarketNativeBoard } from '../../source/src/static/market-native-board.js';
import { createEventQuoteSnapshotService } from '../../domain/src/event-quote-snapshots.js';

export const EVENT_QUOTE_SNAPSHOT_JOB_TYPE = 'market.event-quote.snapshot';
export const EVENT_QUOTE_SNAPSHOT_SCHEDULE_KEY = 'market.event-quote.snapshot';

export const eventQuoteSnapshotManifest = Object.freeze({
  id: 'market.event-quote',
  version: '1.0.0',
  capabilities: ['market.event-quote.snapshot'],
  jobTypes: [EVENT_QUOTE_SNAPSHOT_JOB_TYPE],
});

export async function captureEventQuoteSnapshots({ sourcePort, service, now = () => Date.now() }) {
  if (!sourcePort?.list || !sourcePort?.read) throw new Error('事件报价快照需要 Source 端口');
  if (!service?.saveSnapshots) throw new Error('事件报价快照需要存储服务');
  const at = now();
  const board = await readMarketNativeBoard(sourcePort, { predictionLimit: 50 }, { refresh: true, now: () => at });
  if (!board.predictionMarkets.length) {
    const predictionHealth = board.sourceHealth.filter((item) => item.viewKind === 'prediction-market');
    const usable = predictionHealth.some((item) => item.status === 'ready' || item.status === 'partial');
    if (predictionHealth.length && !usable) throw new Error('事件报价来源暂不可用');
  }
  return service.saveSnapshots(board.predictionMarkets, at);
}

export function createEventQuoteSnapshotJobHandlers({ repository, sourcePort, now = () => Date.now() }) {
  const service = repository ? createEventQuoteSnapshotService({ repository, now }) : null;
  return {
    [EVENT_QUOTE_SNAPSHOT_JOB_TYPE]: async () => captureEventQuoteSnapshots({ sourcePort, service, now }),
  };
}

export function ensureEventQuoteSnapshotSchedule(store, now = Date.now()) {
  const nextRunAt = Math.trunc(Number(now));
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: EVENT_QUOTE_SNAPSHOT_SCHEDULE_KEY,
    jobType: EVENT_QUOTE_SNAPSHOT_JOB_TYPE,
    enabled: true,
    schedule: { kind: 'interval', intervalMinutes: 60 },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt,
  });
}
