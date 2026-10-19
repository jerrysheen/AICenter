import { annotateOfficialReleases } from '../../../domain/src/source-authors.js';
import { createMemorySnapshotCache } from '../../../runtime/src/snapshot-cache.js';
import { emptyStaticSignalBoard, projectStaticSignalBoard } from './board.js';

export const STATIC_SIGNAL_BOARD_SNAPSHOT_KEY = 'static-signal-board';
export const STATIC_SIGNAL_BOARD_CACHE_TTL_MS = 45_000;

export function createStaticSignalBoardReader({
  repository,
  workspaceId = 'local',
  ttlMs = STATIC_SIGNAL_BOARD_CACHE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (!repository?.readSnapshot) throw new TypeError('static signal board reader requires a snapshot repository');
  const cache = createMemorySnapshotCache({
    ttlMs,
    now,
    read: () => repository.readSnapshot(workspaceId, STATIC_SIGNAL_BOARD_SNAPSHOT_KEY),
  });
  return {
    async read(rawInput, { refresh = false } = {}) {
      const stored = await cache.get({ refresh: Boolean(refresh) });
      if (!stored?.payload || stored.payload.generatedAt == null) {
        return { board: emptyStaticSignalBoard(now()), pending: true };
      }
      return {
        board: annotateOfficialReleases(
          projectStaticSignalBoard(stored.payload, rawInput),
          stored.payload.releaseSourceIds,
        ),
        pending: false,
      };
    },
  };
}
