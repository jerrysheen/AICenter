import { createHash, randomUUID } from 'node:crypto';
import { ComputePriceSnapshotInputSchema } from '../../../contracts/src/compute-prices.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function canonical(value) {
  return {
    warnings: value.warnings,
    tokens: value.tokens.map((row) => [row.modelKey, row.modelId, row.promptPerMillion, row.completionPerMillion, row.contextLength]),
    gpus: value.gpus.map((row) => [row.gpuKey, row.lane, row.usdPerHour, row.sampleCount]),
  };
}

export function createComputePriceRepository(database) {
  const touch = database.prepare(`INSERT INTO compute_price_checks
    (workspace_id, source_key, last_checked_at, last_changed_at, content_hash, parser_version, quote_date, snapshot_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, source_key) DO UPDATE SET
      last_checked_at=excluded.last_checked_at,
      last_changed_at=excluded.last_changed_at,
      content_hash=excluded.content_hash,
      parser_version=excluded.parser_version,
      quote_date=excluded.quote_date,
      snapshot_id=excluded.snapshot_id`);

  return {
    save(workspaceId, input, quoteDate) {
      const value = ComputePriceSnapshotInputSchema.parse(input);
      const contentHash = hash(canonical(value));
      return database.transaction(() => {
        const existing = database.prepare(`SELECT id FROM compute_price_snapshots
          WHERE workspace_id=? AND source_key=? AND quote_date=? AND content_hash=? AND parser_version=?`).get(workspaceId, value.sourceKey, quoteDate, contentHash, value.parserVersion);
        const prior = database.prepare('SELECT content_hash, last_changed_at FROM compute_price_checks WHERE workspace_id=? AND source_key=?').get(workspaceId, value.sourceKey);
        const changed = !prior || prior.content_hash !== contentHash;
        const lastChangedAt = changed ? value.capturedAt : prior.last_changed_at;
        let snapshotId = existing?.id;
        if (existing) {
          database.prepare('UPDATE compute_price_snapshots SET last_checked_at=? WHERE id=?').run(value.capturedAt, existing.id);
        } else {
          snapshotId = randomUUID();
          database.prepare(`INSERT INTO compute_price_snapshots
            (id, workspace_id, source_key, quote_date, captured_at, content_hash, parser_version, warnings_json, last_checked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(snapshotId, workspaceId, value.sourceKey, quoteDate, value.capturedAt, contentHash, value.parserVersion, JSON.stringify(value.warnings), value.capturedAt);
          const insertToken = database.prepare(`INSERT INTO token_price_observations
            (id, workspace_id, snapshot_id, sort_index, model_key, model_id, name, quote_date, prompt_per_million, completion_per_million, context_length, captured_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const row of value.tokens) {
            insertToken.run(randomUUID(), workspaceId, snapshotId, row.sortIndex, row.modelKey, row.modelId, row.name, quoteDate, row.promptPerMillion, row.completionPerMillion, row.contextLength, value.capturedAt);
          }
          const insertGpu = database.prepare(`INSERT INTO gpu_rent_observations
            (id, workspace_id, snapshot_id, sort_index, source_key, gpu_key, label, lane, quote_date, usd_per_hour, sample_count, captured_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const row of value.gpus) {
            insertGpu.run(randomUUID(), workspaceId, snapshotId, row.sortIndex, value.sourceKey, row.gpuKey, row.label, row.lane, quoteDate, row.usdPerHour, row.sampleCount, value.capturedAt);
          }
        }
        touch.run(workspaceId, value.sourceKey, value.capturedAt, lastChangedAt, contentHash, value.parserVersion, quoteDate, snapshotId);
        return { snapshotId, unchanged: !changed, quoteDate };
      })();
    },

    latestTokens(workspaceId) {
      const snapshot = database.prepare(`SELECT id, quote_date quoteDate, captured_at capturedAt FROM compute_price_snapshots
        WHERE workspace_id=? AND source_key='openrouter' ORDER BY captured_at DESC, id DESC LIMIT 1`).get(workspaceId);
      if (!snapshot) return [];
      return database.prepare(`SELECT sort_index sortIndex, model_key modelKey, model_id modelId, name,
        quote_date quoteDate, prompt_per_million promptPerMillion, completion_per_million completionPerMillion,
        context_length contextLength, captured_at capturedAt
        FROM token_price_observations WHERE workspace_id=? AND snapshot_id=? ORDER BY sort_index`).all(workspaceId, snapshot.id);
    },

    tokenHistory(workspaceId, modelKey) {
      return database.prepare(`SELECT quote_date quoteDate, prompt_per_million promptPerMillion,
        completion_per_million completionPerMillion, captured_at capturedAt
        FROM token_price_observations WHERE workspace_id=? AND model_key=?
        ORDER BY quote_date, captured_at LIMIT 2000`).all(workspaceId, modelKey);
    },

    latestGpus(workspaceId) {
      const snapshots = database.prepare(`SELECT id FROM compute_price_snapshots s
        WHERE workspace_id=? AND source_key IN ('runpod','vast','ccir','gpueconomy','bargo')
          AND id=(SELECT id FROM compute_price_snapshots
            WHERE workspace_id=s.workspace_id AND source_key=s.source_key
            ORDER BY captured_at DESC, id DESC LIMIT 1)`).all(workspaceId);
      if (!snapshots.length) return [];
      const ids = snapshots.map((row) => row.id);
      return database.prepare(`SELECT source_key venue, gpu_key gpuKey, label, lane, quote_date quoteDate,
        usd_per_hour usdPerHour, sample_count sampleCount, captured_at capturedAt, sort_index sortIndex
        FROM gpu_rent_observations WHERE workspace_id=? AND snapshot_id IN (${ids.map(() => '?').join(',')})
        ORDER BY CASE source_key WHEN 'runpod' THEN 0 WHEN 'vast' THEN 1 WHEN 'ccir' THEN 2 WHEN 'gpueconomy' THEN 3 WHEN 'bargo' THEN 4 ELSE 9 END, sort_index`).all(workspaceId, ...ids);
    },

    gpuHistory(workspaceId, venue, gpuKey, lane) {
      return database.prepare(`SELECT quote_date quoteDate, usd_per_hour usdPerHour, captured_at capturedAt
        FROM gpu_rent_observations WHERE workspace_id=? AND source_key=? AND gpu_key=? AND lane=?
        ORDER BY quote_date, captured_at LIMIT 2000`).all(workspaceId, venue, gpuKey, lane);
    },

    checks(workspaceId) {
      return database.prepare(`SELECT source_key sourceKey, quote_date quoteDate, last_checked_at lastCheckedAt,
        last_changed_at lastChangedAt, last_checked_at<>last_changed_at unchanged
        FROM compute_price_checks WHERE workspace_id=? ORDER BY source_key`).all(workspaceId).map((row) => ({
        ...row,
        unchanged: Boolean(row.unchanged),
      }));
    },
  };
}
