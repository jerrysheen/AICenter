import { parseContract, ResearchReportSchema } from '../../../contracts/src/index.js';

function parseJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapTag(row) {
  if (!row) return null;
  return {
    status: row.status,
    matched: row.matched === null || row.matched === undefined ? null : Boolean(row.matched),
    inputHash: row.input_hash,
    definitionHash: row.definition_hash,
    requestCount: row.request_count,
    errorCode: row.error_code || '',
    leaseUntil: row.lease_until || 0,
    claimToken: row.claim_token || '',
    pass: row.pass,
    updatedAt: row.updated_at,
  };
}

function mapRelevance(row) {
  if (!row) return null;
  return {
    status: row.status,
    verdict: row.verdict || '',
    inputHash: row.input_hash,
    requestCount: row.request_count,
    errorCode: row.error_code || '',
    leaseUntil: row.lease_until || 0,
    claimToken: row.claim_token || '',
    pass: row.pass,
    updatedAt: row.updated_at,
  };
}

function mapMember(row) {
  return {
    ordinal: row.ordinal,
    lane: row.lane,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    sourceVersion: row.source_version,
    eventAt: row.event_at,
    title: row.title,
    text: row.text,
    body: row.body || '',
    originType: row.origin_type,
    originId: row.origin_id,
    nodeId: row.node_id || null,
    columnTagId: row.column_tag_id || null,
    history: Boolean(row.history),
  };
}

export function createResearchRecallRepository(database, emitEvent = () => {}) {
  const tagSelect = `SELECT * FROM research_tag_judgments WHERE workspace_id=? AND resource_type=? AND resource_id=?
    AND source_version=? AND tag_id=? AND definition_hash=? AND prompt_version=? AND model_id=? AND input_hash=?`;
  const relevanceSelect = `SELECT * FROM research_relevance_judgments WHERE workspace_id=? AND resource_type=? AND resource_id=?
    AND source_version=? AND question_id=? AND question_hash=? AND prompt_version=? AND model_id=? AND input_hash=?`;

  function claimRow({ selectSql, selectParams, insertSql, insertParams, retryFailed, token, now, leaseMs }) {
    const row = database.prepare(selectSql).get(...selectParams);
    if (row?.status === 'succeeded') return { action: 'cache', row };
    if (row?.status === 'failed' && !retryFailed) return { action: 'failed', row };
    if (row?.status === 'running' && row.lease_until > now) {
      return { action: row.claim_token === token ? 'owned' : 'inflight', row };
    }
    if (!row) {
      database.prepare(insertSql).run(...insertParams);
      return { action: 'call', row: database.prepare(selectSql).get(...selectParams) };
    }
    const table = selectSql.includes('research_tag_judgments') ? 'research_tag_judgments' : 'research_relevance_judgments';
    const updated = database.prepare(`UPDATE ${table} SET status='running', claim_token=?, lease_until=?, request_count=request_count+1,
      error_code='', updated_at=? WHERE workspace_id=? AND resource_type=? AND resource_id=? AND source_version=?
      AND ${table === 'research_tag_judgments' ? 'tag_id=? AND definition_hash=? AND' : 'question_id=? AND question_hash=? AND'}
      prompt_version=? AND model_id=? AND input_hash=? AND (
        (status='running' AND (lease_until<=? OR claim_token=?)) OR (status='failed' AND ?=1)
      )`).run(
      token, now + leaseMs, now,
      ...selectParams,
      now, token, retryFailed ? 1 : 0,
    );
    if (!updated.changes) {
      const again = database.prepare(selectSql).get(...selectParams);
      if (again?.status === 'succeeded') return { action: 'cache', row: again };
      if (again?.status === 'failed') return { action: 'failed', row: again };
      return { action: 'inflight', row: again };
    }
    return { action: 'call', row: database.prepare(selectSql).get(...selectParams) };
  }

  return {
    activateRelease(workspaceId, release) {
      return database.transaction(() => {
        const current = database.prepare('SELECT release_id, content_hash, label_version FROM research_releases WHERE workspace_id=? AND active=1').get(workspaceId);
        if (current?.content_hash === release.contentHash) {
          return { releaseId: current.release_id, contentHash: current.content_hash, labelVersion: current.label_version, unchanged: true };
        }
        const sameId = database.prepare('SELECT content_hash FROM research_releases WHERE workspace_id=? AND release_id=?').get(workspaceId, release.releaseId);
        if (sameId && sameId.content_hash !== release.contentHash) {
          throw new Error(`研究配置发布标识已存在且内容不同：${release.releaseId}`);
        }
        if (current) database.prepare('UPDATE research_releases SET active=0 WHERE workspace_id=? AND active=1').run(workspaceId);
        database.prepare(`INSERT INTO research_releases
          (workspace_id, release_id, catalog_id, label_version, content_hash, value_json, activated_at, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(
          workspaceId, release.releaseId, release.catalogId, release.labelVersion, release.contentHash,
          JSON.stringify(release.catalog), release.activatedAt,
        );
        emitEvent('research.release.activated.v1', 'research-release', release.releaseId, {
          contentHash: release.contentHash, labelVersion: release.labelVersion,
        }, workspaceId);
        return { releaseId: release.releaseId, contentHash: release.contentHash, labelVersion: release.labelVersion, unchanged: false };
      })();
    },

    activeRelease(workspaceId) {
      const row = database.prepare('SELECT * FROM research_releases WHERE workspace_id=? AND active=1').get(workspaceId);
      if (!row) return null;
      return {
        releaseId: row.release_id,
        catalogId: row.catalog_id,
        labelVersion: row.label_version,
        contentHash: row.content_hash,
        catalog: parseJson(row.value_json, {}),
        activatedAt: row.activated_at,
      };
    },

    getRelease(workspaceId, releaseId) {
      const row = database.prepare('SELECT * FROM research_releases WHERE workspace_id=? AND release_id=?').get(workspaceId, releaseId);
      if (!row) return null;
      return {
        releaseId: row.release_id,
        labelVersion: row.label_version,
        contentHash: row.content_hash,
        catalog: parseJson(row.value_json, {}),
        active: Boolean(row.active),
      };
    },

    savePool(workspaceId, pool) {
      const existing = database.prepare('SELECT member_count FROM research_pools WHERE workspace_id=? AND pool_id=?').get(workspaceId, pool.poolId);
      if (existing) return { poolId: pool.poolId, memberCount: existing.member_count, reused: true };
      database.transaction(() => {
        database.prepare(`INSERT INTO research_pools (workspace_id, pool_id, start_at, end_at, member_count, frozen_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(workspaceId, pool.poolId, pool.window.startAt, pool.window.endAt, pool.members.length, pool.frozenAt);
        const insert = database.prepare(`INSERT INTO research_pool_members
          (workspace_id, pool_id, ordinal, lane, resource_type, resource_id, source_version, event_at, title, text, body,
           origin_type, origin_id, node_id, column_tag_id, history)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        pool.members.forEach((member, index) => insert.run(
          workspaceId, pool.poolId, index + 1, member.lane, member.resourceType, member.resourceId, member.sourceVersion,
          member.eventAt, member.title, member.text, member.body || '', member.originType, member.originId,
          member.nodeId || null, member.columnTagId || null, member.history ? 1 : 0,
        ));
      })();
      return { poolId: pool.poolId, memberCount: pool.members.length, reused: false };
    },

    listMembers(workspaceId, poolId) {
      return database.prepare(`SELECT * FROM research_pool_members WHERE workspace_id=? AND pool_id=? ORDER BY ordinal`)
        .all(workspaceId, poolId).map(mapMember);
    },

    listMemberHeads(workspaceId, poolId) {
      return database.prepare(`SELECT ordinal, lane, resource_type, resource_id, source_version, event_at, title, text,
          CASE WHEN length(body) > 0 THEN 1 ELSE 0 END AS has_body,
          origin_type, origin_id, node_id, column_tag_id, history
        FROM research_pool_members WHERE workspace_id=? AND pool_id=? ORDER BY ordinal`)
        .all(workspaceId, poolId).map((row) => ({
          ordinal: row.ordinal,
          lane: row.lane,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          sourceVersion: row.source_version,
          eventAt: row.event_at,
          title: row.title,
          text: row.text,
          body: '',
          hasBody: row.has_body === 1,
          originType: row.origin_type,
          originId: row.origin_id,
          nodeId: row.node_id || null,
          columnTagId: row.column_tag_id || null,
          history: Boolean(row.history),
        }));
    },

    memberBodies(workspaceId, poolId, ordinals) {
      const ids = [...new Set(ordinals || [])].filter((ordinal) => Number.isInteger(ordinal));
      const bodies = new Map();
      for (let index = 0; index < ids.length; index += 200) {
        const chunk = ids.slice(index, index + 200);
        const rows = database.prepare(`SELECT ordinal, body FROM research_pool_members
          WHERE workspace_id=? AND pool_id=? AND ordinal IN (${chunk.map(() => '?').join(',')})`)
          .all(workspaceId, poolId, ...chunk);
        for (const row of rows) bodies.set(row.ordinal, row.body || '');
      }
      return bodies;
    },

    countMembers(workspaceId, poolId) {
      return database.prepare('SELECT COUNT(*) AS count FROM research_pool_members WHERE workspace_id=? AND pool_id=?')
        .get(workspaceId, poolId).count;
    },

    hasPool(workspaceId, poolId) {
      return Boolean(database.prepare('SELECT 1 AS ok FROM research_pools WHERE workspace_id=? AND pool_id=?').get(workspaceId, poolId));
    },

    latestReport(workspaceId, questionId, window) {
      const key = `${questionId}:${window.startAt}:${window.endAt}`;
      const id = database.prepare('SELECT report_id FROM research_report_heads WHERE workspace_id=? AND period_key=?')
        .get(workspaceId, key)?.report_id;
      return id ? this.getReport(workspaceId, id) : null;
    },

    listTagJudgmentsForPool(workspaceId, poolId, modelId) {
      return database.prepare(`SELECT j.* FROM research_pool_members m
        JOIN research_tag_judgments j
          ON j.workspace_id=m.workspace_id AND j.resource_type=m.resource_type
          AND j.resource_id=m.resource_id AND j.source_version=m.source_version
        WHERE m.workspace_id=? AND m.pool_id=? AND j.model_id=?`).all(workspaceId, poolId, modelId).map((row) => ({
        ...mapTag(row),
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        sourceVersion: row.source_version,
        tagId: row.tag_id,
        definitionHash: row.definition_hash,
        promptVersion: row.prompt_version,
      }));
    },

    listRelevanceJudgmentsForPool(workspaceId, poolId, modelId) {
      return database.prepare(`SELECT j.* FROM research_pool_members m
        JOIN research_relevance_judgments j
          ON j.workspace_id=m.workspace_id AND j.resource_type=m.resource_type
          AND j.resource_id=m.resource_id AND j.source_version=m.source_version
        WHERE m.workspace_id=? AND m.pool_id=? AND j.model_id=?`).all(workspaceId, poolId, modelId).map((row) => ({
        ...mapRelevance(row),
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        sourceVersion: row.source_version,
        questionId: row.question_id,
        questionHash: row.question_hash,
        promptVersion: row.prompt_version,
      }));
    },

    getTagJudgment(key) {
      return mapTag(database.prepare(tagSelect).get(
        key.workspaceId, key.resourceType, key.resourceId, key.sourceVersion, key.tagId, key.definitionHash,
        key.promptVersion, key.modelId, key.inputHash,
      ));
    },

    claimTag(key, { token, now, leaseMs, retryFailed, pass }) {
      const selectParams = [key.workspaceId, key.resourceType, key.resourceId, key.sourceVersion, key.tagId, key.definitionHash, key.promptVersion, key.modelId, key.inputHash];
      const claimed = database.transaction(() => claimRow({
        selectSql: tagSelect,
        selectParams,
        insertSql: `INSERT INTO research_tag_judgments
          (workspace_id, resource_type, resource_id, source_version, tag_id, definition_hash, prompt_version, model_id, input_hash,
           status, matched, claim_token, lease_until, error_code, request_count, pass, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, '', 1, ?, ?)`,
        insertParams: [...selectParams, token, now + leaseMs, pass, now],
        retryFailed, token, now, leaseMs,
      }))();
      return { action: claimed.action, row: mapTag(claimed.row) };
    },

    completeTag(key, token, matched) {
      const result = database.prepare(`UPDATE research_tag_judgments SET status='succeeded', matched=?, lease_until=0, error_code='', updated_at=?
        WHERE workspace_id=? AND resource_type=? AND resource_id=? AND source_version=? AND tag_id=? AND definition_hash=?
        AND prompt_version=? AND model_id=? AND input_hash=? AND claim_token=? AND status='running'`).run(
        matched ? 1 : 0, Date.now(),
        key.workspaceId, key.resourceType, key.resourceId, key.sourceVersion, key.tagId, key.definitionHash,
        key.promptVersion, key.modelId, key.inputHash, token,
      );
      if (!result.changes && this.getTagJudgment(key)?.status !== 'succeeded') throw new Error('研究Tag判断租约已失效');
    },

    releaseTag(key, token) {
      database.prepare(`DELETE FROM research_tag_judgments
        WHERE workspace_id=? AND resource_type=? AND resource_id=? AND source_version=? AND tag_id=? AND definition_hash=?
        AND prompt_version=? AND model_id=? AND input_hash=? AND claim_token=? AND status='running'`).run(
        key.workspaceId, key.resourceType, key.resourceId, key.sourceVersion, key.tagId, key.definitionHash,
        key.promptVersion, key.modelId, key.inputHash, token,
      );
    },

    failTag(key, token, errorCode) {
      database.prepare(`UPDATE research_tag_judgments SET status='failed', error_code=?, lease_until=0, updated_at=?
        WHERE workspace_id=? AND resource_type=? AND resource_id=? AND source_version=? AND tag_id=? AND definition_hash=?
        AND prompt_version=? AND model_id=? AND input_hash=? AND claim_token=? AND status='running'`).run(
        String(errorCode || 'failed').slice(0, 80), Date.now(),
        key.workspaceId, key.resourceType, key.resourceId, key.sourceVersion, key.tagId, key.definitionHash,
        key.promptVersion, key.modelId, key.inputHash, token,
      );
    },

    getRelevanceJudgment(key) {
      return mapRelevance(database.prepare(relevanceSelect).get(
        key.workspaceId, key.resourceType, key.resourceId, key.sourceVersion, key.questionId, key.questionHash,
        key.promptVersion, key.modelId, key.inputHash,
      ));
    },

    claimRelevance(key, { token, now, leaseMs, retryFailed, pass }) {
      const selectParams = [key.workspaceId, key.resourceType, key.resourceId, key.sourceVersion, key.questionId, key.questionHash, key.promptVersion, key.modelId, key.inputHash];
      const claimed = database.transaction(() => claimRow({
        selectSql: relevanceSelect,
        selectParams,
        insertSql: `INSERT INTO research_relevance_judgments
          (workspace_id, resource_type, resource_id, source_version, question_id, question_hash, prompt_version, model_id, input_hash,
           status, verdict, claim_token, lease_until, error_code, request_count, pass, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', '', ?, ?, '', 1, ?, ?)`,
        insertParams: [...selectParams, token, now + leaseMs, pass, now],
        retryFailed, token, now, leaseMs,
      }))();
      return { action: claimed.action, row: mapRelevance(claimed.row) };
    },

    completeRelevance(key, token, verdict) {
      const result = database.prepare(`UPDATE research_relevance_judgments SET status='succeeded', verdict=?, lease_until=0, error_code='', updated_at=?
        WHERE workspace_id=? AND resource_type=? AND resource_id=? AND source_version=? AND question_id=? AND question_hash=?
        AND prompt_version=? AND model_id=? AND input_hash=? AND claim_token=? AND status='running'`).run(
        verdict, Date.now(),
        key.workspaceId, key.resourceType, key.resourceId, key.sourceVersion, key.questionId, key.questionHash,
        key.promptVersion, key.modelId, key.inputHash, token,
      );
      if (!result.changes && this.getRelevanceJudgment(key)?.status !== 'succeeded') throw new Error('研究相关性判断租约已失效');
    },

    releaseRelevance(key, token) {
      database.prepare(`DELETE FROM research_relevance_judgments
        WHERE workspace_id=? AND resource_type=? AND resource_id=? AND source_version=? AND question_id=? AND question_hash=?
        AND prompt_version=? AND model_id=? AND input_hash=? AND claim_token=? AND status='running'`).run(
        key.workspaceId, key.resourceType, key.resourceId, key.sourceVersion, key.questionId, key.questionHash,
        key.promptVersion, key.modelId, key.inputHash, token,
      );
    },

    failRelevance(key, token, errorCode) {
      database.prepare(`UPDATE research_relevance_judgments SET status='failed', error_code=?, lease_until=0, updated_at=?
        WHERE workspace_id=? AND resource_type=? AND resource_id=? AND source_version=? AND question_id=? AND question_hash=?
        AND prompt_version=? AND model_id=? AND input_hash=? AND claim_token=? AND status='running'`).run(
        String(errorCode || 'failed').slice(0, 80), Date.now(),
        key.workspaceId, key.resourceType, key.resourceId, key.sourceVersion, key.questionId, key.questionHash,
        key.promptVersion, key.modelId, key.inputHash, token,
      );
    },

    countTagRows(workspaceId, tagId, definitionHash) {
      return database.prepare(`SELECT COUNT(*) AS count FROM research_tag_judgments
        WHERE workspace_id=? AND tag_id=? AND definition_hash=?`).get(workspaceId, tagId, definitionHash).count;
    },

    saveRun(workspaceId, run) {
      database.prepare(`INSERT INTO research_runs
        (workspace_id, id, release_id, content_hash, question_hash, status, report_id, value_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)`).run(
        workspaceId, run.id, run.releaseId, run.contentHash, run.questionHash, 'open', JSON.stringify(run.snapshot), run.createdAt,
      );
      return this.getRun(workspaceId, run.id);
    },

    finishRun(workspaceId, runId, { status, reportId }) {
      database.prepare(`UPDATE research_runs SET status=?, report_id=? WHERE workspace_id=? AND id=?`).run(status, reportId, workspaceId, runId);
      return this.getRun(workspaceId, runId);
    },

    getRun(workspaceId, runId) {
      const row = database.prepare('SELECT * FROM research_runs WHERE workspace_id=? AND id=?').get(workspaceId, runId);
      if (!row) return null;
      return {
        id: row.id,
        releaseId: row.release_id,
        contentHash: row.content_hash,
        questionHash: row.question_hash,
        status: row.status,
        reportId: row.report_id || '',
        snapshot: parseJson(row.value_json, {}),
        createdAt: row.created_at,
      };
    },

    saveReport(workspaceId, report) {
      const parsed = parseContract(ResearchReportSchema, report);
      return database.transaction(() => {
        database.prepare(`INSERT OR IGNORE INTO research_reports (workspace_id, id, question_id, start_at, value_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(workspaceId, parsed.id, parsed.questionId, parsed.window.startAt, JSON.stringify(parsed), parsed.generatedAt);
        const key = `${parsed.questionId}:${parsed.window.startAt}:${parsed.window.endAt}`;
        database.prepare(`INSERT INTO research_report_heads (workspace_id, period_key, report_id) VALUES (?, ?, ?)
          ON CONFLICT(workspace_id, period_key) DO UPDATE SET report_id=excluded.report_id`).run(workspaceId, key, parsed.id);
        emitEvent('research.report.saved.v1', 'research-report', parsed.id, {
          status: parsed.status, questionId: parsed.questionId, contentHash: parsed.contentHash,
        }, workspaceId);
        return this.getReport(workspaceId, parsed.id);
      })();
    },

    getReport(workspaceId, reportId) {
      const row = database.prepare('SELECT value_json FROM research_reports WHERE workspace_id=? AND id=?').get(workspaceId, reportId);
      return row ? parseJson(row.value_json) : null;
    },
  };
}
