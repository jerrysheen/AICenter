import { randomUUID } from 'node:crypto';

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function mapDigest(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    digestDate: row.digest_date,
    status: row.status,
    generatedAt: row.generated_at ?? null,
    model: row.model || '',
    coverage: parseJson(row.coverage_json, {}),
    sections: parseJson(row.sections_json, []),
    questionSet: row.question_set || '',
    error: row.error_text || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createInvestorDiscussionRepository(database, emitEvent) {
  return {
    listHoldings(workspaceId) {
      return database.prepare(`SELECT i.symbol AS symbol, i.name AS name, i.exchange_code AS exchangeCode,
          l.board AS board, a.provider_symbol AS yahoo
        FROM holding_lots l
        JOIN instruments i ON i.id = l.instrument_id
        LEFT JOIN instrument_aliases a ON a.instrument_id = i.id AND a.provider_id = 'yahoo'
        WHERE l.workspace_id = ? AND l.archived_at IS NULL
        ORDER BY i.name, i.symbol, a.provider_symbol`).all(workspaceId);
    },

    get(workspaceId, digestDate) {
      const row = database.prepare(`SELECT * FROM investor_discussion_digests
        WHERE workspace_id = ? AND digest_date = ?`).get(workspaceId, digestDate);
      return mapDigest(row);
    },

    save(value) {
      const now = Date.now();
      const workspaceId = value.workspaceId || 'local';
      const digestDate = String(value.digestDate || '');
      const existing = this.get(workspaceId, digestDate);
      const id = existing?.id || randomUUID();
      const generatedAt = value.generatedAt ?? null;
      database.transaction(() => {
        database.prepare(`INSERT INTO investor_discussion_digests
          (id, workspace_id, digest_date, status, generated_at, model, coverage_json, sections_json,
           error_text, question_set, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, digest_date) DO UPDATE SET
            status = excluded.status,
            generated_at = excluded.generated_at,
            model = excluded.model,
            coverage_json = excluded.coverage_json,
            sections_json = excluded.sections_json,
            error_text = excluded.error_text,
            question_set = excluded.question_set,
            updated_at = excluded.updated_at`).run(
          id, workspaceId, digestDate, value.status, generatedAt, value.model || '',
          JSON.stringify(value.coverage || {}), JSON.stringify(value.sections || []),
          value.error || '', value.questionSet || '', existing?.createdAt || now, now,
        );
        emitEvent('investor.discussion.digest.saved.v1', 'investor-discussion', id, {
          digestDate,
          status: value.status,
        }, workspaceId);
      })();
      return this.get(workspaceId, digestDate);
    },
  };
}
