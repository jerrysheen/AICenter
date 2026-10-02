// Listing/filtering indexes must not load every RSS HTML body into memory.
const ENTRY_INDEX_COLUMNS = 'workspace_id,external_id,source_key,publisher_key,channel,canonical_url,title,summary,published_at,published_at_raw,content_level,content_hash,revision,status,origin_url,discovered_via_json,observed_at,body_hash,truncated,created_at,updated_at,fetch_state_json';

function mapState(row) {
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    sourceKey: row.source_key,
    enabled: Boolean(row.enabled),
    hostDirectVerified: Boolean(row.host_direct_verified),
    bodyUseAcknowledged: Boolean(row.body_use_acknowledged),
    health: row.health,
    healthDetail: row.health_detail || '',
    etag: row.etag || '',
    lastModified: row.last_modified || '',
    feedHash: row.feed_hash || '',
    lastProbe: row.last_probe_json ? JSON.parse(row.last_probe_json) : null,
    lastSyncAt: row.last_sync_at || null,
    updatedAt: row.updated_at,
  };
}

function mapEntry(row) {
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    externalId: row.external_id,
    sourceKey: row.source_key,
    publisherKey: row.publisher_key,
    channel: row.channel,
    canonicalUrl: row.canonical_url,
    title: row.title || '',
    summary: row.summary || '',
    publishedAt: row.published_at || null,
    publishedAtRaw: row.published_at_raw || '',
    contentLevel: row.content_level,
    contentHash: row.content_hash,
    revision: row.revision,
    status: row.status,
    originUrl: row.origin_url || '',
    discoveredVia: row.discovered_via_json ? JSON.parse(row.discovered_via_json) : null,
    observedAt: row.observed_at,
    bodyHash: row.body_hash || '',
    truncated: Boolean(row.truncated),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fetchState: JSON.parse(row.fetch_state_json || '{}'),
    feedBodyHtml: row.feed_body_html || '',
  };
}

export function createMediaRepository(database, emitEvent = () => {}) {
  return {
    recoverBriefProcessing() {
      const rows=database.prepare("SELECT workspace_id,external_id,body_hash FROM media_article_processing WHERE brief_status='running'").all();
      return database.transaction(()=>{for(const r of rows) this.saveBriefProcessing(r.workspace_id,r.external_id,r.body_hash,'failed','worker_interrupted',Date.now());return rows.length;})();
    },
    saveBriefProcessing(workspaceId,externalId,bodyHash,status,reason,at) {
      if (!['running','ready','failed','unavailable'].includes(status)) throw new Error('invalid brief status');
      return database.transaction(() => {
        database.prepare(`INSERT INTO media_article_processing VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,external_id,body_hash) DO UPDATE SET
          brief_status=excluded.brief_status,brief_reason=excluded.brief_reason,last_attempt_at=excluded.last_attempt_at`).run(workspaceId,externalId,bodyHash,status,String(reason || '').slice(0,500),at);
        emitEvent('feed.media-brief.observed.v1', 'media-index', externalId, { externalId, bodyHash, status }, workspaceId);
      })();
    },
    getBriefProcessing(workspaceId,externalId,bodyHash) {
      const row = database.prepare('SELECT brief_status,brief_reason,last_attempt_at FROM media_article_processing WHERE workspace_id=? AND external_id=? AND body_hash=?').get(workspaceId,externalId,bodyHash);
      return row ? { status: row.brief_status, reason: row.brief_reason, lastAttemptAt: row.last_attempt_at } : { status: 'pending',reason: '',lastAttemptAt: null };
    },
    atomic(operation) { return database.transaction(operation)(); },
    nextSnapshotRevision(workspaceId,externalId) {
      return database.prepare('SELECT COALESCE(MAX(revision),0)+1 value FROM media_body_snapshots WHERE workspace_id=? AND external_id=?').get(workspaceId,externalId).value;
    },
    saveFetchState(workspaceId, externalId, value) {
      const state = MediaFetchStateSchema.parse(value);
      return database.transaction(() => {
        database.prepare('UPDATE media_index_entries SET fetch_state_json=? WHERE workspace_id=? AND external_id=?').run(JSON.stringify(state), workspaceId, externalId);
        emitEvent('feed.media-body.observed.v1', 'media-index', externalId, { externalId, fetchStatus: state.fetchStatus }, workspaceId);
      })();
    },
    saveFeedBody(workspaceId, externalId, html) {
      database.prepare('UPDATE media_index_entries SET feed_body_html=? WHERE workspace_id=? AND external_id=?').run(html, workspaceId, externalId);
    },
    reserveRequest(workspaceId, dayKey, sourceKey, now, globalMax = 48, sourceMax = 16) {
      return database.transaction(() => {
        database.prepare(`INSERT OR IGNORE INTO media_budget_days (workspace_id,day_key,new_metadata,selected_bodies,deferred_count,updated_at) VALUES (?,?,0,0,0,?)`).run(workspaceId,dayKey,now);
        database.prepare(`INSERT OR IGNORE INTO media_source_budgets (workspace_id,day_key,source_key,bodies,updated_at) VALUES (?,?,?,0,?)`).run(workspaceId,dayKey,sourceKey,now);
        const day = database.prepare('SELECT body_requests FROM media_budget_days WHERE workspace_id=? AND day_key=?').get(workspaceId,dayKey);
        const source = database.prepare('SELECT requests FROM media_source_budgets WHERE workspace_id=? AND day_key=? AND source_key=?').get(workspaceId,dayKey,sourceKey);
        if (day.body_requests >= globalMax || source.requests >= sourceMax) return false;
        database.prepare('UPDATE media_budget_days SET body_requests=body_requests+1 WHERE workspace_id=? AND day_key=?').run(workspaceId,dayKey);
        database.prepare('UPDATE media_source_budgets SET requests=requests+1 WHERE workspace_id=? AND day_key=? AND source_key=?').run(workspaceId,dayKey,sourceKey);
        return true;
      })();
    },
    saveBrief(workspaceId, externalId, brief) {
      const value = MediaBriefSchema.parse(brief);
      return database.transaction(() => {
        database.prepare('UPDATE media_body_snapshots SET brief_json=? WHERE workspace_id=? AND external_id=? AND revision=? AND body_hash=?').run(JSON.stringify(value),workspaceId,externalId,value.snapshotRevision,value.bodyHash);
        emitEvent('feed.media-brief.saved.v1', 'media-index', externalId, { externalId, bodyHash: value.bodyHash }, workspaceId);
      })();
    },
    listStates(workspaceId) {
      return database.prepare('SELECT * FROM media_source_states WHERE workspace_id = ?')
        .all(workspaceId).map(mapState);
    },
    getState(workspaceId, sourceKey) {
      return mapState(database.prepare(`SELECT * FROM media_source_states
        WHERE workspace_id = ? AND source_key = ?`).get(workspaceId, sourceKey));
    },
    saveState(state) {
      return database.transaction(() => {
      database.prepare(`INSERT INTO media_source_states
        (workspace_id, source_key, enabled, host_direct_verified, body_use_acknowledged, health,
         health_detail, etag, last_modified, feed_hash, last_probe_json, last_sync_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, source_key) DO UPDATE SET
          enabled = excluded.enabled,
          host_direct_verified = excluded.host_direct_verified,
          body_use_acknowledged = excluded.body_use_acknowledged,
          health = excluded.health,
          health_detail = excluded.health_detail,
          etag = excluded.etag,
          last_modified = excluded.last_modified,
          feed_hash = excluded.feed_hash,
          last_probe_json = excluded.last_probe_json,
          last_sync_at = excluded.last_sync_at,
          updated_at = excluded.updated_at`)
        .run(
          state.workspaceId, state.sourceKey, state.enabled ? 1 : 0, state.hostDirectVerified ? 1 : 0,
          state.bodyUseAcknowledged ? 1 : 0, state.health, state.healthDetail || '', state.etag || '',
          state.lastModified || '', state.feedHash || '', JSON.stringify(state.lastProbe || null),
          state.lastSyncAt || null, state.updatedAt,
        );
      emitEvent('feed.media-source.saved.v1','media-source',state.sourceKey,{sourceKey:state.sourceKey,enabled:state.enabled,health:state.health},state.workspaceId);
      return this.getState(state.workspaceId, state.sourceKey);
      })();
    },
    listEntries(workspaceId, { channel = '', limit = 50 } = {}) {
      const rows = channel
        ? database.prepare(`SELECT ${ENTRY_INDEX_COLUMNS} FROM media_index_entries
            WHERE workspace_id = ? AND channel = ?
            ORDER BY COALESCE(published_at, observed_at) DESC LIMIT ?`).all(workspaceId, channel, limit)
        : database.prepare(`SELECT ${ENTRY_INDEX_COLUMNS} FROM media_index_entries
            WHERE workspace_id = ?
            ORDER BY COALESCE(published_at, observed_at) DESC LIMIT ?`).all(workspaceId, limit);
      return rows.map(mapEntry);
    },
    latestBodies(workspaceId, externalIds) {
      const ids = [...new Set((externalIds || []).filter(Boolean))];
      if (!ids.length) return [];
      const marks = ids.map(() => '?').join(',');
      return database.prepare(`SELECT body.external_id, body.revision, body.body_text, body.body_hash, body.truncated, body.content_level, body.article_json, body.brief_json, body.observed_at
        FROM media_body_snapshots body
        INNER JOIN (
          SELECT external_id, MAX(revision) AS revision
          FROM media_body_snapshots s
          WHERE workspace_id = ? AND external_id IN (${marks})
            AND body_hash = (SELECT e.body_hash FROM media_index_entries e WHERE e.workspace_id=s.workspace_id AND e.external_id=s.external_id)
          GROUP BY external_id
        ) latest ON latest.external_id = body.external_id AND latest.revision = body.revision
        WHERE body.workspace_id = ?`).all(workspaceId, ...ids, workspaceId).map((row) => ({
        externalId: row.external_id,
        bodyText: row.body_text || '',
        bodyHash: row.body_hash || '',
        truncated: Boolean(row.truncated),
        contentLevel: row.content_level,
        revision: row.revision,
        observedAt: row.observed_at,
        article: JSON.parse(row.article_json || '{}'),
        brief: row.brief_json ? JSON.parse(row.brief_json) : null,
      }));
    },
    getEntries(workspaceId, externalIds) {
      const ids = [...new Set(externalIds.filter(Boolean))];
      if (!ids.length) return [];
      const marks = ids.map(() => '?').join(',');
      const rows = database.prepare(`SELECT * FROM media_index_entries
        WHERE workspace_id = ? AND external_id IN (${marks})`).all(workspaceId, ...ids).map(mapEntry);
      const byId = new Map(rows.map(r => [r.externalId,r]));
      return ids.map(id => byId.get(id)).filter(Boolean);
    },
    upsertEntry(entry) {
      return database.transaction(() => {
      database.prepare(`INSERT INTO media_index_entries
        (workspace_id, external_id, source_key, publisher_key, channel, canonical_url, title, summary,
         published_at, published_at_raw, content_level, content_hash, revision, status, origin_url,
         discovered_via_json, observed_at, body_hash, truncated, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, external_id) DO UPDATE SET
          title = excluded.title,
          summary = excluded.summary,
          canonical_url = excluded.canonical_url,
          published_at = excluded.published_at,
          published_at_raw = excluded.published_at_raw,
          content_level = excluded.content_level,
          content_hash = excluded.content_hash,
          revision = excluded.revision,
          status = excluded.status,
          origin_url = excluded.origin_url,
          discovered_via_json = excluded.discovered_via_json,
          observed_at = excluded.observed_at,
          body_hash = CASE WHEN excluded.body_hash != '' THEN excluded.body_hash ELSE media_index_entries.body_hash END,
          truncated = excluded.truncated,
          updated_at = excluded.updated_at`)
        .run(
          entry.workspaceId, entry.externalId, entry.sourceKey, entry.publisherKey, entry.channel,
          entry.canonicalUrl, entry.title || '', entry.summary || '', entry.publishedAt || null,
          entry.publishedAtRaw || '', entry.contentLevel, entry.contentHash, entry.revision, entry.status,
          entry.originUrl || '', JSON.stringify(entry.discoveredVia || null), entry.observedAt,
          entry.bodyHash || '', entry.truncated ? 1 : 0, entry.createdAt, entry.updatedAt,
        );
      emitEvent('feed.media-index.saved.v1','media-index',entry.externalId,{externalId:entry.externalId,revision:entry.revision},entry.workspaceId);
      })();
    },
    listDeferred(workspaceId, sourceKey) {
      return database.prepare(`SELECT * FROM media_index_entries
        WHERE workspace_id = ? AND source_key = ? AND status = 'budget_deferred'
        ORDER BY observed_at ASC`).all(workspaceId, sourceKey).map(mapEntry);
    },
    reserveMetadata(workspaceId, dayKey, requested, now, maxNew, { recordDeferred = true } = {}) {
      return database.transaction(() => {
        const row = database.prepare(`SELECT * FROM media_budget_days
          WHERE workspace_id = ? AND day_key = ?`).get(workspaceId, dayKey);
        const used = row?.new_metadata || 0;
        const allowed = Math.max(0, Math.min(requested, maxNew - used));
        const deferred = recordDeferred ? Math.max(0, requested - allowed) : 0;
        if (!row) {
          database.prepare(`INSERT INTO media_budget_days
            (workspace_id, day_key, new_metadata, selected_bodies, deferred_count, earliest_deferred_at, updated_at)
            VALUES (?, ?, ?, 0, ?, ?, ?)`).run(workspaceId, dayKey, allowed, deferred, deferred ? now : null, now);
        } else {
          database.prepare(`UPDATE media_budget_days
            SET new_metadata = new_metadata + ?,
                deferred_count = deferred_count + ?,
                earliest_deferred_at = CASE
                  WHEN ? > 0 AND earliest_deferred_at IS NULL THEN ?
                  ELSE earliest_deferred_at END,
                updated_at = ?
            WHERE workspace_id = ? AND day_key = ?`)
            .run(allowed, deferred, deferred, now, now, workspaceId, dayKey);
        }
        return { allowed, deferred };
      })();
    },
    reserveBody(workspaceId, dayKey, sourceKey, now, { globalMax, sourceMax }) {
      return database.transaction(() => {
        const day = database.prepare(`SELECT * FROM media_budget_days
          WHERE workspace_id = ? AND day_key = ?`).get(workspaceId, dayKey);
        const source = database.prepare(`SELECT * FROM media_source_budgets
          WHERE workspace_id = ? AND day_key = ? AND source_key = ?`).get(workspaceId, dayKey, sourceKey);
        const globalUsed = day?.selected_bodies || 0;
        const sourceUsed = source?.bodies || 0;
        if (globalUsed >= globalMax || sourceUsed >= sourceMax) {
          if (!day) {
            database.prepare(`INSERT INTO media_budget_days
              (workspace_id, day_key, new_metadata, selected_bodies, deferred_count, earliest_deferred_at, updated_at)
              VALUES (?, ?, 0, 0, 1, ?, ?)`).run(workspaceId, dayKey, now, now);
          } else {
            database.prepare(`UPDATE media_budget_days
              SET deferred_count = deferred_count + 1,
                  earliest_deferred_at = COALESCE(earliest_deferred_at, ?),
                  updated_at = ?
              WHERE workspace_id = ? AND day_key = ?`).run(now, now, workspaceId, dayKey);
          }
          return { reserved: false };
        }
        if (!day) {
          database.prepare(`INSERT INTO media_budget_days
            (workspace_id, day_key, new_metadata, selected_bodies, deferred_count, earliest_deferred_at, updated_at)
            VALUES (?, ?, 0, 1, 0, NULL, ?)`).run(workspaceId, dayKey, now);
        } else {
          database.prepare(`UPDATE media_budget_days
            SET selected_bodies = selected_bodies + 1, updated_at = ?
            WHERE workspace_id = ? AND day_key = ?`).run(now, workspaceId, dayKey);
        }
        if (!source) {
          database.prepare(`INSERT INTO media_source_budgets
            (workspace_id, day_key, source_key, bodies, updated_at)
            VALUES (?, ?, ?, 1, ?)`).run(workspaceId, dayKey, sourceKey, now);
        } else {
          database.prepare(`UPDATE media_source_budgets
            SET bodies = bodies + 1, updated_at = ?
            WHERE workspace_id = ? AND day_key = ? AND source_key = ?`).run(now, workspaceId, dayKey, sourceKey);
        }
        return { reserved: true };
      })();
    },
    releaseBody(workspaceId, dayKey, sourceKey, now) {
      database.prepare(`UPDATE media_budget_days
        SET selected_bodies = MAX(0, selected_bodies - 1), updated_at = ?
        WHERE workspace_id = ? AND day_key = ?`).run(now, workspaceId, dayKey);
      database.prepare(`UPDATE media_source_budgets
        SET bodies = MAX(0, bodies - 1), updated_at = ?
        WHERE workspace_id = ? AND day_key = ? AND source_key = ?`).run(now, workspaceId, dayKey, sourceKey);
    },
    budgetDay(workspaceId, dayKey) {
      const row = database.prepare(`SELECT * FROM media_budget_days
        WHERE workspace_id = ? AND day_key = ?`).get(workspaceId, dayKey);
      if (!row) return { newMetadata: 0, selectedBodies: 0, deferredCount: 0, earliestDeferredAt: null };
      return {
        newMetadata: row.new_metadata,
        selectedBodies: row.selected_bodies,
        bodyRequests: row.body_requests,
        deferredCount: row.deferred_count,
        earliestDeferredAt: row.earliest_deferred_at || null,
      };
    },
    saveSnapshot(snapshot) {
      for (const p of snapshot.article?.paragraphs || []) MediaParagraphSchema.parse(p);
      database.prepare(`INSERT INTO media_body_snapshots
        (workspace_id, external_id, revision, body_hash, body_text, truncated, content_level, observed_at, article_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, external_id, revision) DO NOTHING`)
        .run(
          snapshot.workspaceId, snapshot.externalId, snapshot.revision, snapshot.bodyHash,
          snapshot.bodyText, snapshot.truncated ? 1 : 0, snapshot.contentLevel, snapshot.observedAt, JSON.stringify(snapshot.article || {}),
        );
    },
    listSnapshots(workspaceId, externalId) {
      return database.prepare(`SELECT revision, body_hash, body_text, truncated, content_level, observed_at, article_json, brief_json
        FROM media_body_snapshots
        WHERE workspace_id = ? AND external_id = ?
        ORDER BY revision ASC`).all(workspaceId, externalId).map((row) => ({
        revision: row.revision,
        bodyHash: row.body_hash,
        bodyText: row.body_text,
        truncated: Boolean(row.truncated),
        contentLevel: row.content_level,
        observedAt: row.observed_at,
        article: JSON.parse(row.article_json || '{}'),
        brief: row.brief_json ? JSON.parse(row.brief_json) : null,
      }));
    },
  };
}
import { MediaBriefSchema, MediaFetchStateSchema, MediaParagraphSchema } from '../../../contracts/src/media.js';
