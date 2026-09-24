import { randomUUID } from 'node:crypto';
import { parseContract, StrategySnapshotSchema } from '../../../contracts/src/index.js';

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function mapSnapshot(row) {
  return parseContract(StrategySnapshotSchema, {
    id: row.id,
    workspaceId: row.workspace_id,
    strategyKey: row.strategy_key,
    asOf: row.as_of,
    status: row.status,
    factors: parseJson(row.factors_json, {}),
    warnings: parseJson(row.warnings_json, []),
    createdAt: row.created_at,
  });
}

export function createStrategyRepository(database, emitEvent) {
  return {
    getLatestStrategySnapshot(workspaceId, strategyKey) {
      const row = database.prepare(`SELECT * FROM strategy_snapshots
        WHERE workspace_id = ? AND strategy_key = ?
        ORDER BY as_of DESC LIMIT 1`).get(workspaceId, strategyKey);
      return row ? mapSnapshot(row) : null;
    },

    getLatestStrategySnapshotBefore(workspaceId, strategyKey, beforeAt) {
      const row = database.prepare(`SELECT * FROM strategy_snapshots
        WHERE workspace_id = ? AND strategy_key = ? AND as_of < ?
        ORDER BY as_of DESC LIMIT 1`).get(workspaceId, strategyKey, Number(beforeAt));
      return row ? mapSnapshot(row) : null;
    },

    upsertStrategySnapshot(value) {
      const now = Date.now();
      const id = value.id || randomUUID();
      database.transaction(() => {
        database.prepare(`INSERT INTO strategy_snapshots
          (id, workspace_id, strategy_key, as_of, status, factors_json, warnings_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, strategy_key, as_of) DO UPDATE SET
            status = excluded.status,
            factors_json = excluded.factors_json,
            warnings_json = excluded.warnings_json`)
          .run(id, value.workspaceId, value.strategyKey, value.asOf, value.status,
            JSON.stringify(value.factors), JSON.stringify(value.warnings || []), now);
        const row = database.prepare(`SELECT * FROM strategy_snapshots
          WHERE workspace_id = ? AND strategy_key = ? AND as_of = ?`)
          .get(value.workspaceId, value.strategyKey, value.asOf);
        emitEvent('strategy.snapshot.saved.v1', 'strategy-snapshot', row.id, {
          snapshotId: row.id,
          strategyKey: row.strategy_key,
          asOf: row.as_of,
          regime: parseJson(row.factors_json, {}).regime || null,
          status: row.status,
        }, value.workspaceId);
      })();
      return mapSnapshot(database.prepare(`SELECT * FROM strategy_snapshots
        WHERE workspace_id = ? AND strategy_key = ? AND as_of = ?`)
        .get(value.workspaceId, value.strategyKey, value.asOf));
    },
  };
}
