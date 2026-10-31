import { createHash, randomUUID } from 'node:crypto';
import {
  InferenceAvailabilityRowSchema,
  InferenceBenchmarkRowSchema,
} from '../../../contracts/src/inferencex.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function canonicalAvailability(rows) {
  return rows.map((row) => [row.model, row.hardware, row.framework, row.precision, row.isl, row.osl, row.disagg, row.specMethod, row.benchmarkType, row.date, row.sourceUrl]);
}

function canonicalBenchmark(rows) {
  return rows.map((row) => [row.model, row.hardware, row.framework, row.precision, row.isl, row.osl, row.disagg, row.specMethod, row.benchmarkType, row.date, row.sourceUrl, row.tokensPerSecondPerGpu]);
}

export function createInferencexRepository(database) {
  const touch = database.prepare(`INSERT INTO inference_source_checks
    (workspace_id, source_key, last_checked_at, last_changed_at, content_hash, parser_version, quote_date, status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, source_key) DO UPDATE SET
      last_checked_at=excluded.last_checked_at,
      last_changed_at=excluded.last_changed_at,
      content_hash=excluded.content_hash,
      parser_version=excluded.parser_version,
      quote_date=excluded.quote_date,
      status=excluded.status,
      note=excluded.note`);

  function recordCheck(workspaceId, sourceKey, { capturedAt, quoteDate, parserVersion, contentHash, status, note }) {
    const prior = database.prepare('SELECT content_hash, last_changed_at FROM inference_source_checks WHERE workspace_id=? AND source_key=?').get(workspaceId, sourceKey);
    const changed = !prior || prior.content_hash !== contentHash;
    touch.run(workspaceId, sourceKey, capturedAt, changed ? capturedAt : prior.last_changed_at, contentHash, parserVersion, quoteDate, status, note || '');
    return { unchanged: !changed };
  }

  return {
    saveAvailability(workspaceId, input) {
      const rows = input.rows.map((row) => InferenceAvailabilityRowSchema.parse(row));
      const contentHash = hash(canonicalAvailability(rows));
      return database.transaction(() => {
        const check = recordCheck(workspaceId, 'availability', { ...input, contentHash, status: rows.length ? 'ready' : 'empty' });
        if (!rows.length) return { ...check, snapshotId: null, rowCount: 0 };
        const existing = database.prepare(`SELECT id FROM inference_availability_snapshots
          WHERE workspace_id=? AND quote_date=? AND content_hash=? AND parser_version=?`).get(workspaceId, input.quoteDate, contentHash, input.parserVersion);
        if (existing) {
          return { ...check, unchanged: true, snapshotId: existing.id, rowCount: rows.length };
        }
        const snapshotId = randomUUID();
        database.prepare(`INSERT INTO inference_availability_snapshots
          (id, workspace_id, captured_at, quote_date, content_hash, parser_version, row_count, source_url, rows_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(snapshotId, workspaceId, input.capturedAt, input.quoteDate, contentHash, input.parserVersion, rows.length, input.sourceUrl, JSON.stringify(rows));
        return { unchanged: false, snapshotId, rowCount: rows.length };
      })();
    },

    saveBenchmarks(workspaceId, input) {
      const rows = input.rows.map((row) => InferenceBenchmarkRowSchema.parse(row));
      const contentHash = hash(canonicalBenchmark(rows));
      return database.transaction(() => {
        const check = recordCheck(workspaceId, 'benchmarks', { ...input, contentHash, status: rows.length ? 'ready' : 'empty' });
        if (!rows.length || check.unchanged) return { ...check, snapshotId: null, rowCount: rows.length };
        const snapshotId = randomUUID();
        const insert = database.prepare(`INSERT INTO inference_benchmark_observations
          (id, workspace_id, snapshot_id, model, hardware, framework, precision, isl, osl, disagg, spec_method, benchmark_type, quote_date, source_url, tokens_per_second, citation_eligible, captured_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const row of rows) {
          insert.run(randomUUID(), workspaceId, snapshotId, row.model, row.hardware, row.framework, row.precision, row.isl, row.osl, row.disagg ? 1 : 0, row.specMethod, row.benchmarkType, row.date, row.sourceUrl, row.tokensPerSecondPerGpu, 1, input.capturedAt);
        }
        return { unchanged: false, snapshotId, rowCount: rows.length };
      })();
    },

    reject(workspaceId, sourceKey, input) {
      return database.transaction(() => recordCheck(workspaceId, sourceKey, {
        ...input,
        contentHash: input.contentHash || hash({ rejected: input.note || sourceKey }),
        status: 'rejected',
      }))();
    },

    latest(workspaceId) {
      const snapshot = database.prepare(`SELECT rows_json rowsJson, source_url sourceUrl, quote_date quoteDate, captured_at capturedAt
        FROM inference_availability_snapshots WHERE workspace_id=? ORDER BY captured_at DESC, id DESC LIMIT 1`).get(workspaceId);
      const availability = snapshot ? JSON.parse(snapshot.rowsJson || '[]') : [];
      const benchmarks = database.prepare(`SELECT model, hardware, framework, precision, isl, osl, disagg, spec_method specMethod,
          benchmark_type benchmarkType, quote_date date, source_url sourceUrl, tokens_per_second tokensPerSecondPerGpu,
          citation_eligible citationEligible
        FROM inference_benchmark_observations
        WHERE workspace_id=? AND snapshot_id=(
          SELECT snapshot_id FROM inference_benchmark_observations WHERE workspace_id=? ORDER BY captured_at DESC, id DESC LIMIT 1
        )
        ORDER BY model, hardware, isl, osl`).all(workspaceId, workspaceId).map((row) => ({
        model: row.model,
        hardware: row.hardware,
        framework: row.framework,
        precision: row.precision,
        isl: row.isl,
        osl: row.osl,
        disagg: Boolean(row.disagg),
        specMethod: row.specMethod,
        benchmarkType: row.benchmarkType,
        date: row.date,
        sourceUrl: row.sourceUrl,
        tokensPerSecondPerGpu: row.tokensPerSecondPerGpu,
        citationEligible: row.citationEligible === 1,
        investmentUse: 'not_a_conclusion',
      }));
      const checks = database.prepare(`SELECT source_key sourceKey, quote_date quoteDate, last_checked_at lastCheckedAt,
          last_changed_at lastChangedAt, status, note
        FROM inference_source_checks WHERE workspace_id=? ORDER BY source_key`).all(workspaceId);
      return { availability, benchmarks, checks };
    },
  };
}
