import { createHash, randomUUID } from 'node:crypto';
import { TRANSLATION_MAX_ATTEMPTS, translationRetryDelayMs } from '../translation-retry.js';
import {
  parseContract,
  SaveCaptureInputSchema,
  SaveContentItemInputSchema,
  SaveFeedItemTranslationInputSchema,
  UpsertFeedIdentityFingerprintInputSchema,
  UpsertSubscriptionInputSchema,
  UpsertSourceAccountInputSchema,
  PatchUserItemStateInputSchema,
} from '../../../contracts/src/index.js';

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function sourceHash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function publicTranslationError(error) {
  const text = String(error?.message || error || '翻译失败')
    .replace(/AIza[0-9A-Za-z\-_]{8,}/g, '[redacted]')
    .replace(/(api[_-]?key|x-goog-api-key|authorization|bearer)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return text || '翻译失败';
}

const USER_VISIBLE_CONTENT_SQL = `NOT EXISTS (
  SELECT 1 FROM user_item_states uis
  WHERE uis.workspace_id = ci.workspace_id
    AND uis.content_item_id = ci.id
    AND uis.is_hidden = 1
)`;
const VISIBLE_CONTENT_SQL = `${USER_VISIBLE_CONTENT_SQL} AND NOT EXISTS (SELECT 1 FROM captures quality_capture
  WHERE quality_capture.id=ci.capture_id AND quality_capture.workspace_id=ci.workspace_id
    AND json_extract(quality_capture.metadata_json,'$.filterMode')='enforce'
    AND json_extract(quality_capture.metadata_json,'$.filterDecision') IN ('DROP','REVIEW')
    AND json_extract(quality_capture.metadata_json,'$.filterApplied')=1)`;

function approvedQualitySql(rule='') {
  if(!rule) return '1=1';
  if(rule!=='all-three-0.60') throw new Error('Unsupported admission rule');
  return `EXISTS (SELECT 1 FROM captures qa WHERE qa.id=ci.capture_id AND qa.workspace_id=ci.workspace_id
    AND json_extract(qa.metadata_json,'$.filterRule')='all-three-0.60'
    AND json_extract(qa.metadata_json,'$.filterDecision')='KEEP'
    AND json_extract(qa.metadata_json,'$.filterScores.reading_value')>=0.60
    AND json_extract(qa.metadata_json,'$.filterScores.specific_content')>=0.60
    AND json_extract(qa.metadata_json,'$.filterScores.sufficient_information')>=0.60)`;
}

const LOW_VALUE_SQL = `json_extract(c.metadata_json,'$.filterMode')='enforce'
  AND json_extract(c.metadata_json,'$.filterDecision') IN ('DROP','REVIEW')
  AND json_extract(c.metadata_json,'$.filterApplied')=1`;

function feedVisibilitySql({ qualityRule = '', includeLowValue = false } = {}) {
  if (!includeLowValue) return `${VISIBLE_CONTENT_SQL} AND ${approvedQualitySql(qualityRule)}`;
  if (!qualityRule) return USER_VISIBLE_CONTENT_SQL;
  return `${USER_VISIBLE_CONTENT_SQL} AND ((${approvedQualitySql(qualityRule)}) OR (${LOW_VALUE_SQL}))`;
}

const TAGGED_CONTENT_SQL = `EXISTS (
  SELECT 1 FROM resource_taggings rt
  WHERE rt.workspace_id = ci.workspace_id
    AND rt.resource_type = 'content-item'
    AND rt.resource_id = ci.id
    AND rt.tags_json != '[]'
    AND rt.tags_json != ''
)`;

function mapSourceAccount(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    externalId: row.external_id,
    handle: row.handle,
    displayName: row.display_name,
    profileUrl: row.profile_url,
    authMode: row.auth_mode,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCapture(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    externalId: row.external_id,
    sourceAccountId: row.source_account_id || null,
    sourceUrl: row.source_url,
    title: row.title,
    contentHash: row.content_hash,
    rawArtifactPath: row.raw_artifact_path || null,
    status: row.status,
    publishedAt: row.published_at ?? null,
    capturedAt: row.captured_at,
    metadata: parseJson(row.metadata_json),
  };
}

function mapSubscription(row) {
  const priority = row.priority > 0 ? 'high' : row.priority < 0 ? 'low' : 'normal';
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceAccountId: row.source_account_id,
    enabled: Boolean(row.enabled),
    priority,
    refreshIntervalMinutes: row.refresh_interval_minutes,
    notificationPolicy: row.notification_policy,
    lastSyncAt: row.last_sync_at ?? null,
    nextSyncAt: row.next_sync_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContentItem(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    captureId: row.capture_id || null,
    originType: row.origin_type,
    contentType: row.content_type,
    title: row.title,
    body: row.body,
    summary: row.summary,
    sourceUrl: row.source_url,
    authorName: row.author_name,
    publishedAt: row.published_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapIdentityFingerprint(row) {
  return {
    workspaceId: row.workspace_id,
    provider: row.provider,
    identityHash: row.identity_hash,
    externalId: row.external_id || '',
    hiddenAt: row.hidden_at ?? null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function createFeedRepository(database, emitEvent) {
  const repository = {
    upsertSourceAccount(value) {
      const input = parseContract(UpsertSourceAccountInputSchema, value);
      const now = Date.now();
      const id = input.id || randomUUID();
      database.transaction(() => {
        database.prepare(`INSERT INTO source_accounts
          (id, workspace_id, provider, external_id, handle, display_name, profile_url, auth_mode,
           metadata_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, provider, external_id) DO UPDATE SET
            handle = excluded.handle,
            display_name = excluded.display_name,
            profile_url = excluded.profile_url,
            auth_mode = excluded.auth_mode,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at`)
          .run(id, input.workspaceId, input.provider, input.externalId, input.handle, input.displayName,
            input.profileUrl, input.authMode, JSON.stringify(input.metadata), now, now);
        const row = database.prepare(`SELECT * FROM source_accounts
          WHERE workspace_id = ? AND provider = ? AND external_id = ?`)
          .get(input.workspaceId, input.provider, input.externalId);
        emitEvent('feed.source-account.upserted.v1', 'source-account', row.id,
          { sourceAccountId: row.id, provider: input.provider }, input.workspaceId);
      })();
      return mapSourceAccount(database.prepare(`SELECT * FROM source_accounts
        WHERE workspace_id = ? AND provider = ? AND external_id = ?`)
        .get(input.workspaceId, input.provider, input.externalId));
    },

    getSourceAccount(id) {
      const row = database.prepare('SELECT * FROM source_accounts WHERE id = ?').get(id);
      return row ? mapSourceAccount(row) : null;
    },

    upsertSubscription(value) {
      const input = parseContract(UpsertSubscriptionInputSchema, value);
      const now = Date.now();
      const id = input.id || randomUUID();
      const priority = input.priority === 'high' ? 10 : input.priority === 'low' ? -10 : 0;
      database.transaction(() => {
        database.prepare(`INSERT INTO subscriptions
          (id, workspace_id, source_account_id, enabled, priority, refresh_interval_minutes,
           notification_policy, last_sync_at, next_sync_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
          ON CONFLICT(workspace_id, source_account_id) DO UPDATE SET
            enabled = excluded.enabled,
            priority = excluded.priority,
            refresh_interval_minutes = excluded.refresh_interval_minutes,
            notification_policy = excluded.notification_policy,
            next_sync_at = excluded.next_sync_at,
            updated_at = excluded.updated_at`)
          .run(id, input.workspaceId, input.sourceAccountId, input.enabled ? 1 : 0, priority,
            input.refreshIntervalMinutes, input.notificationPolicy, input.nextSyncAt, now, now);
        const row = database.prepare(`SELECT * FROM subscriptions
          WHERE workspace_id = ? AND source_account_id = ?`)
          .get(input.workspaceId, input.sourceAccountId);
        emitEvent('feed.subscription.upserted.v1', 'subscription', row.id,
          { subscriptionId: row.id, sourceAccountId: input.sourceAccountId }, input.workspaceId);
      })();
      return mapSubscription(database.prepare(`SELECT * FROM subscriptions
        WHERE workspace_id = ? AND source_account_id = ?`)
        .get(input.workspaceId, input.sourceAccountId));
    },

    ensureSubscription(value) {
      const input = parseContract(UpsertSubscriptionInputSchema, value);
      const now = Date.now();
      const id = input.id || randomUUID();
      const priority = input.priority === 'high' ? 10 : input.priority === 'low' ? -10 : 0;
      database.transaction(() => {
        const inserted = database.prepare(`INSERT INTO subscriptions
          (id, workspace_id, source_account_id, enabled, priority, refresh_interval_minutes,
           notification_policy, last_sync_at, next_sync_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
          ON CONFLICT(workspace_id, source_account_id) DO NOTHING`)
          .run(id, input.workspaceId, input.sourceAccountId, input.enabled ? 1 : 0, priority,
            input.refreshIntervalMinutes, input.notificationPolicy, input.nextSyncAt, now, now);
        if (!inserted.changes) return;
        const row = database.prepare(`SELECT * FROM subscriptions
          WHERE workspace_id = ? AND source_account_id = ?`)
          .get(input.workspaceId, input.sourceAccountId);
        emitEvent('feed.subscription.upserted.v1', 'subscription', row.id,
          { subscriptionId: row.id, sourceAccountId: input.sourceAccountId }, input.workspaceId);
      })();
      return mapSubscription(database.prepare(`SELECT * FROM subscriptions
        WHERE workspace_id = ? AND source_account_id = ?`)
        .get(input.workspaceId, input.sourceAccountId));
    },

    setSubscriptionRefreshInterval(subscriptionId, refreshIntervalMinutes) {
      const minutes = Number(refreshIntervalMinutes);
      const row = database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
      if (!row || !Number.isInteger(minutes) || minutes < 1 || minutes > 43_200) return row ? mapSubscription(row) : null;
      if (row.refresh_interval_minutes === minutes) return mapSubscription(row);
      database.prepare(`UPDATE subscriptions
        SET refresh_interval_minutes = ?, updated_at = ?
        WHERE id = ?`).run(minutes, Date.now(), subscriptionId);
      return mapSubscription(database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId));
    },

    listDueSubscriptions(now = Date.now(), limit = 50) {
      return database.prepare(`SELECT * FROM subscriptions
        WHERE enabled = 1 AND (next_sync_at IS NULL OR next_sync_at <= ?)
        ORDER BY priority DESC, COALESCE(next_sync_at, 0) ASC LIMIT ?`)
        .all(now, Math.max(1, Math.min(Number(limit) || 50, 200))).map(mapSubscription);
    },

    claimDueSubscriptions(now = Date.now(), limit = 50, leaseMs = 10 * 60_000) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
      const at = Number(now);
      const leaseUntil = at + Math.max(1_000, Number(leaseMs) || 10 * 60_000);
      database.exec('BEGIN IMMEDIATE');
      try {
        const rows = database.prepare(`SELECT * FROM subscriptions
          WHERE enabled = 1 AND (next_sync_at IS NULL OR next_sync_at <= ?)
          ORDER BY priority DESC, COALESCE(next_sync_at, 0) ASC
          LIMIT ?`).all(at, safeLimit);
        const update = database.prepare(`UPDATE subscriptions
          SET next_sync_at = ?, updated_at = ?
          WHERE id = ? AND enabled = 1 AND (next_sync_at IS NULL OR next_sync_at <= ?)`);
        const claimed = [];
        for (const row of rows) {
          const result = update.run(leaseUntil, at, row.id, at);
          if (!result.changes) continue;
          const fresh = database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(row.id);
          claimed.push(mapSubscription(fresh));
        }
        database.exec('COMMIT');
        return claimed;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* already closed */ }
        throw error;
      }
    },

    completeSubscriptionSync(subscriptionId, syncedAt = Date.now()) {
      const at = Number(syncedAt);
      const row = database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
      if (!row || !Number.isInteger(at) || at < 0) return null;
      const nextSyncAt = at + row.refresh_interval_minutes * 60_000;
      database.prepare(`UPDATE subscriptions
        SET last_sync_at = ?, next_sync_at = ?, updated_at = ?
        WHERE id = ?`).run(at, nextSyncAt, Date.now(), subscriptionId);
      return mapSubscription(database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId));
    },

    failSubscriptionSync(subscriptionId, failedAt = Date.now(), retryAfterMs = 5 * 60_000) {
      const at = Number(failedAt);
      const row = database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
      if (!row || !Number.isInteger(at) || at < 0) return null;
      const nextSyncAt = at + Math.max(1_000, Number(retryAfterMs) || 5 * 60_000);
      database.prepare(`UPDATE subscriptions
        SET next_sync_at = ?, updated_at = ?
        WHERE id = ?`).run(nextSyncAt, Date.now(), subscriptionId);
      return mapSubscription(database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId));
    },

    releaseOpenSubscriptionLeases(now = Date.now(), leaseMs = 10 * 60_000) {
      const at = Number(now);
      const lease = Math.max(1_000, Number(leaseMs) || 10 * 60_000);
      if (!Number.isInteger(at) || at < 0) return 0;
      const result = database.prepare(`UPDATE subscriptions
        SET next_sync_at = ?, updated_at = ?
        WHERE enabled = 1 AND next_sync_at > ?
          AND (next_sync_at - updated_at) <= ?`).run(at, at, at, lease + 5_000);
      return result.changes;
    },

    deferSubscriptionSync(subscriptionId, deferredAt = Date.now(), delayMs = 30 * 60_000) {
      const at = Number(deferredAt);
      const row = database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
      if (!row || !Number.isInteger(at) || at < 0) return null;
      const nextSyncAt = at + Math.max(60_000, Number(delayMs) || 30 * 60_000);
      database.prepare(`UPDATE subscriptions
        SET next_sync_at = ?, updated_at = ?
        WHERE id = ?`).run(nextSyncAt, Date.now(), subscriptionId);
      return mapSubscription(database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId));
    },

    saveCapture(value) {
      const input = parseContract(SaveCaptureInputSchema, value);
      const capturedAt = input.capturedAt || Date.now();
      const id = input.id || randomUUID();
      database.transaction(() => {
        database.prepare(`INSERT INTO captures
          (id, workspace_id, provider, external_id, source_account_id, source_url, title, content_hash,
           raw_artifact_path, status, published_at, captured_at, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, provider, external_id) DO UPDATE SET
            source_account_id = excluded.source_account_id,
            source_url = excluded.source_url,
            title = excluded.title,
            content_hash = excluded.content_hash,
            raw_artifact_path = excluded.raw_artifact_path,
            status = excluded.status,
            published_at = excluded.published_at,
            captured_at = excluded.captured_at,
            metadata_json = excluded.metadata_json`)
          .run(id, input.workspaceId, input.provider, input.externalId, input.sourceAccountId,
            input.sourceUrl, input.title, input.contentHash, input.rawArtifactPath, input.status,
            input.publishedAt, capturedAt, JSON.stringify(input.metadata));
        const row = database.prepare(`SELECT * FROM captures
          WHERE workspace_id = ? AND provider = ? AND external_id = ?`)
          .get(input.workspaceId, input.provider, input.externalId);
        emitEvent('feed.capture.saved.v1', 'capture', row.id,
          { captureId: row.id, provider: input.provider, status: input.status }, input.workspaceId);
      })();
      return mapCapture(database.prepare(`SELECT * FROM captures
        WHERE workspace_id = ? AND provider = ? AND external_id = ?`)
        .get(input.workspaceId, input.provider, input.externalId));
    },

    saveContentItem(value) {
      const input = parseContract(SaveContentItemInputSchema, value);
      const now = Date.now();
      const id = input.id || randomUUID();
      database.transaction(() => {
        if (input.captureId) {
          database.prepare(`INSERT INTO content_items
            (id, workspace_id, capture_id, origin_type, content_type, title, body, summary,
             source_url, author_name, published_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(capture_id) DO UPDATE SET
              origin_type = excluded.origin_type,
              content_type = excluded.content_type,
              title = excluded.title,
              body = excluded.body,
              summary = excluded.summary,
              source_url = excluded.source_url,
              author_name = excluded.author_name,
              published_at = excluded.published_at,
              updated_at = excluded.updated_at`)
            .run(id, input.workspaceId, input.captureId, input.originType, input.contentType, input.title,
              input.body, input.summary, input.sourceUrl, input.authorName, input.publishedAt, now, now);
        } else {
          database.prepare(`INSERT INTO content_items
            (id, workspace_id, capture_id, origin_type, content_type, title, body, summary,
             source_url, author_name, published_at, created_at, updated_at)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, input.workspaceId, input.originType, input.contentType, input.title, input.body,
              input.summary, input.sourceUrl, input.authorName, input.publishedAt, now, now);
        }
        const item = input.captureId
          ? database.prepare('SELECT * FROM content_items WHERE capture_id = ?').get(input.captureId)
          : database.prepare('SELECT * FROM content_items WHERE id = ?').get(id);
        emitEvent('feed.content-item.saved.v1', 'content-item', item.id,
          { contentItemId: item.id, captureId: item.capture_id || null }, input.workspaceId);
      })();
      const row = input.captureId
        ? database.prepare('SELECT * FROM content_items WHERE capture_id = ?').get(input.captureId)
        : database.prepare('SELECT * FROM content_items WHERE id = ?').get(id);
      return mapContentItem(row);
    },

    getCapture(workspaceId, provider, externalId) {
      const row = database.prepare(`SELECT * FROM captures
        WHERE workspace_id = ? AND provider = ? AND external_id = ?`)
        .get(workspaceId, provider, String(externalId || ''));
      return row ? mapCapture(row) : null;
    },

    getCaptureByContentHash(workspaceId, provider, contentHash) {
      const hash = String(contentHash || '').trim();
      if (!hash) return null;
      const row = database.prepare(`SELECT * FROM captures
        WHERE workspace_id = ? AND provider = ? AND content_hash = ?
        LIMIT 1`)
        .get(workspaceId, provider, hash);
      return row ? mapCapture(row) : null;
    },

    listCaptureExternalIds(workspaceId, provider) {
      return database.prepare(`SELECT external_id AS externalId
        FROM captures
        WHERE workspace_id = ? AND provider = ?`)
        .all(workspaceId, provider)
        .map((row) => String(row.externalId || ''))
        .filter(Boolean);
    },

    listContentItemStatesByExternalIds(workspaceId, provider, externalIds) {
      const ids = [...new Set(externalIds)].slice(0, 10_000);
      if (!ids.length) return [];
      return database.prepare(`SELECT c.external_id AS externalId, ci.id AS contentItemId,
          ci.created_at AS createdAt, COALESCE(s.is_read, 0) AS isRead,
          COALESCE(s.is_hidden, 0) AS isHidden, COALESCE(s.is_saved,0) AS isSaved
        FROM captures c INNER JOIN content_items ci ON ci.capture_id = c.id AND ci.workspace_id = c.workspace_id
        LEFT JOIN user_item_states s ON s.workspace_id = ci.workspace_id AND s.content_item_id = ci.id
        WHERE c.workspace_id = ? AND c.provider = ? AND c.external_id IN (${ids.map(() => '?').join(',')})`)
        .all(workspaceId, provider, ...ids)
        .map(row => ({ ...row, isRead: Boolean(row.isRead), isHidden: Boolean(row.isHidden), isSaved:Boolean(row.isSaved) }));
    },

    listQualityExcludedExternalIds(workspaceId,provider) {
      return database.prepare(`SELECT external_id FROM captures WHERE workspace_id=? AND provider=?
        AND json_extract(metadata_json,'$.filterMode')='enforce' AND json_extract(metadata_json,'$.filterDecision') IN ('DROP','REVIEW')
        AND json_extract(metadata_json,'$.filterApplied')=1`)
        .all(workspaceId,provider).map(r=>r.external_id);
    },

    listQualityApprovedExternalIds(workspaceId,provider) {
      return database.prepare(`SELECT external_id FROM captures WHERE workspace_id=? AND provider=?
        AND json_extract(metadata_json,'$.filterRule')='all-three-0.60' AND json_extract(metadata_json,'$.filterDecision')='KEEP'
        AND json_extract(metadata_json,'$.filterScores.reading_value')>=0.60
        AND json_extract(metadata_json,'$.filterScores.specific_content')>=0.60
        AND json_extract(metadata_json,'$.filterScores.sufficient_information')>=0.60`)
        .all(workspaceId,provider).map(r=>r.external_id);
    },

    listQualityRefreshItems(workspaceId,{perSourceLimit=200}={}) {
      const limit=Math.max(1,Math.min(200,Number(perSourceLimit)||200));
      return database.prepare(`SELECT * FROM (SELECT ci.*,c.provider,c.external_id,c.captured_at,c.metadata_json AS capture_metadata_json,
        ROW_NUMBER() OVER (PARTITION BY c.source_account_id ORDER BY c.captured_at DESC,ci.created_at DESC,ci.id DESC) AS pool_rank
        FROM content_items ci JOIN captures c ON c.id=ci.capture_id AND c.workspace_id=ci.workspace_id
        WHERE ci.workspace_id=? AND c.provider IN ('x','xueqiu','trendforce','bilibili') AND ${USER_VISIBLE_CONTENT_SQL})
        WHERE pool_rank<=? ORDER BY provider,captured_at DESC`).all(workspaceId,limit)
        .map(r=>({...mapContentItem(r),provider:r.provider,externalId:r.external_id,captureMetadata:parseJson(r.capture_metadata_json)}));
    },

    listContentItemsByProvider(workspaceId, provider, { limit = 200, sourceExternalId = '', taggedOnly = false, qualityRule='', before = null, savedOnly = false, includeLowValue = false } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
      const visibilitySql = feedVisibilitySql({ qualityRule, includeLowValue });
      const taggedSql = taggedOnly ? `AND ${TAGGED_CONTENT_SQL}` : '';
      const savedSql = savedOnly ? 'AND COALESCE(item_state.is_saved, 0) = 1' : '';
      const cursorSql = before
        ? `AND (
            COALESCE(item_state.is_read, 0) > ?
            OR (COALESCE(item_state.is_read, 0) = ? AND c.captured_at < ?)
            OR (COALESCE(item_state.is_read, 0) = ? AND c.captured_at = ? AND ci.id < ?)
          )`
        : '';
      const cursorParams = before ? [before.isRead, before.isRead, before.at, before.isRead, before.at, before.id] : [];
      const order = 'ORDER BY COALESCE(item_state.is_read, 0) ASC, c.captured_at DESC, ci.id DESC';
      const rows = sourceExternalId
        ? database.prepare(`SELECT ci.*, c.provider AS provider, c.external_id AS external_id,
            c.captured_at AS captured_at, c.metadata_json AS capture_metadata_json,
            COALESCE(item_state.is_read, 0) AS is_read,
            COALESCE(item_state.is_saved, 0) AS is_saved,
            CASE WHEN ${LOW_VALUE_SQL} THEN 1 ELSE 0 END AS low_value
            FROM content_items ci
            INNER JOIN captures c ON c.id = ci.capture_id
            INNER JOIN source_accounts sa ON sa.id = c.source_account_id
            LEFT JOIN user_item_states item_state
              ON item_state.workspace_id = ci.workspace_id AND item_state.content_item_id = ci.id
            WHERE ci.workspace_id = ? AND c.provider = ? AND sa.external_id = ?
              AND ${visibilitySql}
              ${taggedSql}
              ${savedSql}
              ${cursorSql}
            ${order}
            LIMIT ?`).all(workspaceId, provider, sourceExternalId, ...cursorParams, safeLimit)
        : database.prepare(`SELECT ci.*, c.provider AS provider, c.external_id AS external_id,
            c.captured_at AS captured_at, c.metadata_json AS capture_metadata_json,
            COALESCE(item_state.is_read, 0) AS is_read,
            COALESCE(item_state.is_saved, 0) AS is_saved,
            CASE WHEN ${LOW_VALUE_SQL} THEN 1 ELSE 0 END AS low_value
            FROM content_items ci
            INNER JOIN captures c ON c.id = ci.capture_id
            LEFT JOIN user_item_states item_state
              ON item_state.workspace_id = ci.workspace_id AND item_state.content_item_id = ci.id
            WHERE ci.workspace_id = ? AND c.provider = ?
              AND ${visibilitySql}
              ${taggedSql}
              ${savedSql}
              ${cursorSql}
            ${order}
            LIMIT ?`).all(workspaceId, provider, ...cursorParams, safeLimit);
      return rows.map((row) => ({
        ...mapContentItem(row),
        provider: row.provider,
        externalId: row.external_id,
        capturedAt: row.captured_at,
        captureMetadata: parseJson(row.capture_metadata_json),
        isRead: Boolean(row.is_read),
        isSaved: Boolean(row.is_saved),
        lowValue: Boolean(row.low_value),
      }));
    },

    countContentItemsByProvider(workspaceId, provider, { sourceExternalId = '', taggedOnly = false, qualityRule = '', includeLowValue = false } = {}) {
      const visibilitySql = feedVisibilitySql({ qualityRule, includeLowValue });
      const taggedSql = taggedOnly ? `AND ${TAGGED_CONTENT_SQL}` : '';
      const row = sourceExternalId
        ? database.prepare(`SELECT COUNT(*) AS n
            FROM content_items ci
            INNER JOIN captures c ON c.id = ci.capture_id
            INNER JOIN source_accounts sa ON sa.id = c.source_account_id
            WHERE ci.workspace_id = ? AND c.provider = ? AND sa.external_id = ?
              AND ${visibilitySql}
              ${taggedSql}`).get(workspaceId, provider, sourceExternalId)
        : database.prepare(`SELECT COUNT(*) AS n
            FROM content_items ci
            INNER JOIN captures c ON c.id = ci.capture_id
            WHERE ci.workspace_id = ? AND c.provider = ?
              AND ${visibilitySql}
              ${taggedSql}`).get(workspaceId, provider);
      return Number(row?.n) || 0;
    },

    getContentItemByCapture(workspaceId, captureId) {
      if (!captureId) return null;
      const row = database.prepare(`SELECT ci.*, c.provider, c.external_id, c.captured_at, c.metadata_json AS capture_metadata_json
        FROM content_items ci
        LEFT JOIN captures c ON c.id = ci.capture_id
        WHERE ci.workspace_id = ? AND ci.capture_id = ?`).get(workspaceId, captureId);
      return row ? {
        ...mapContentItem(row),
        provider: row.provider || '',
        externalId: row.external_id || '',
        capturedAt: row.captured_at || row.created_at,
        captureMetadata: parseJson(row.capture_metadata_json),
      } : null;
    },

    isContentHidden(workspaceId, contentItemId) {
      if (!contentItemId) return false;
      const row = database.prepare(`SELECT is_hidden FROM user_item_states
        WHERE workspace_id = ? AND content_item_id = ?`).get(workspaceId, contentItemId);
      return Boolean(row?.is_hidden);
    },

    listHiddenExternalIds(workspaceId, provider) {
      const fromItems = database.prepare(`SELECT c.external_id AS externalId
        FROM user_item_states uis
        INNER JOIN content_items ci
          ON ci.id = uis.content_item_id AND ci.workspace_id = uis.workspace_id
        INNER JOIN captures c ON c.id = ci.capture_id
        WHERE uis.workspace_id = ? AND uis.is_hidden = 1 AND c.provider = ?`)
        .all(workspaceId, provider)
        .map((row) => String(row.externalId || ''))
        .filter(Boolean);
      const fromFingerprints = database.prepare(`SELECT external_id AS externalId
        FROM feed_identity_fingerprints
        WHERE workspace_id = ? AND provider = ? AND hidden_at IS NOT NULL AND external_id != ''`)
        .all(workspaceId, provider)
        .map((row) => String(row.externalId || ''))
        .filter(Boolean);
      return [...new Set([...fromItems, ...fromFingerprints])];
    },

    upsertIdentityFingerprint(value) {
      const input = parseContract(UpsertFeedIdentityFingerprintInputSchema, value);
      const now = Date.now();
      let saved = null;
      database.transaction(() => {
        const existing = database.prepare(`SELECT * FROM feed_identity_fingerprints
          WHERE workspace_id = ? AND provider = ? AND identity_hash = ?`)
          .get(input.workspaceId, input.provider, input.identityHash);
        const hiddenAt = input.hiddenAt !== undefined
          ? input.hiddenAt
          : (existing?.hidden_at ?? null);
        const firstSeenAt = existing?.first_seen_at || now;
        const externalId = String(existing?.external_id || '') || String(input.externalId || '');
        database.prepare(`INSERT INTO feed_identity_fingerprints
          (workspace_id, provider, identity_hash, external_id, hidden_at, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, provider, identity_hash) DO UPDATE SET
            external_id = excluded.external_id,
            hidden_at = excluded.hidden_at,
            last_seen_at = excluded.last_seen_at`)
          .run(
            input.workspaceId,
            input.provider,
            input.identityHash,
            externalId,
            hiddenAt,
            firstSeenAt,
            now,
          );
        const row = database.prepare(`SELECT * FROM feed_identity_fingerprints
          WHERE workspace_id = ? AND provider = ? AND identity_hash = ?`)
          .get(input.workspaceId, input.provider, input.identityHash);
        emitEvent('feed.identity-fingerprint.upserted.v1', 'identity-fingerprint', input.identityHash, {
          identityHash: input.identityHash,
          provider: input.provider,
          hiddenAt: row.hidden_at ?? null,
        }, input.workspaceId);
        saved = mapIdentityFingerprint(row);
      })();
      return saved;
    },

    getIdentityFingerprint(workspaceId, provider, identityHash) {
      const row = database.prepare(`SELECT * FROM feed_identity_fingerprints
        WHERE workspace_id = ? AND provider = ? AND identity_hash = ?`)
        .get(workspaceId, provider, String(identityHash || ''));
      return row ? mapIdentityFingerprint(row) : null;
    },

    hasIdentityFingerprint(workspaceId, provider, identityHash) {
      if (!identityHash) return false;
      const row = database.prepare(`SELECT 1 AS present FROM feed_identity_fingerprints
        WHERE workspace_id = ? AND provider = ? AND identity_hash = ?`)
        .get(workspaceId, provider, String(identityHash));
      return Boolean(row);
    },

    isIdentityHidden(workspaceId, provider, { identityHash = '', externalId = '' } = {}) {
      const hash = String(identityHash || '');
      const id = String(externalId || '');
      if (!hash && !id) return false;
      const row = database.prepare(`SELECT 1 AS present FROM feed_identity_fingerprints
        WHERE workspace_id = ? AND provider = ? AND hidden_at IS NOT NULL
          AND (identity_hash = ? OR (external_id != '' AND external_id = ?))`)
        .get(workspaceId, provider, hash, id);
      return Boolean(row);
    },

    listIdentityExternalIds(workspaceId, provider) {
      return database.prepare(`SELECT external_id AS externalId
        FROM feed_identity_fingerprints
        WHERE workspace_id = ? AND provider = ? AND external_id != ''`)
        .all(workspaceId, provider)
        .map((row) => String(row.externalId || ''))
        .filter(Boolean);
    },

    getContentItem(workspaceId, id) {
      const row = database.prepare(`SELECT ci.*, c.provider, c.external_id, c.captured_at, c.metadata_json AS capture_metadata_json
        FROM content_items ci
        LEFT JOIN captures c ON c.id = ci.capture_id
        WHERE ci.workspace_id = ? AND ci.id = ?`).get(workspaceId, id);
      if (!row) return null;
      return {
        ...mapContentItem(row),
        provider: row.provider || '',
        externalId: row.external_id || '',
        capturedAt: row.captured_at || row.created_at,
        captureMetadata: parseJson(row.capture_metadata_json),
      };
    },

    getContentItemByCaptureId(workspaceId, captureId) {
      const row = database.prepare(`SELECT ci.*, c.provider, c.external_id, c.captured_at, c.metadata_json AS capture_metadata_json
        FROM content_items ci
        LEFT JOIN captures c ON c.id = ci.capture_id
        WHERE ci.workspace_id = ? AND ci.capture_id = ?`).get(workspaceId, captureId);
      if (!row) return null;
      return {
        ...mapContentItem(row),
        provider: row.provider || '',
        externalId: row.external_id || '',
        capturedAt: row.captured_at || row.created_at,
        captureMetadata: parseJson(row.capture_metadata_json),
      };
    },

    listContentItemsWithSource(workspaceId, { limit = 200, ids = [],qualityRule='' } = {}) {
      const wanted = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
      const rows = wanted.length
        ? database.prepare(`SELECT ci.*, c.provider AS provider, c.external_id AS external_id
            FROM content_items ci
            LEFT JOIN captures c ON c.id = ci.capture_id
            WHERE ci.workspace_id = ? AND ci.id IN (${wanted.map(() => '?').join(', ')}) AND ${approvedQualitySql(qualityRule)}`).all(workspaceId, ...wanted)
        : database.prepare(`SELECT ci.*, c.provider AS provider, c.external_id AS external_id
            FROM content_items ci
            LEFT JOIN captures c ON c.id = ci.capture_id
            WHERE ci.workspace_id = ? AND ${VISIBLE_CONTENT_SQL} AND ${approvedQualitySql(qualityRule)}
            ORDER BY ci.created_at DESC, ci.id DESC LIMIT ?`).all(workspaceId, safeLimit);
      return rows.map((row) => ({
        ...mapContentItem(row),
        provider: row.provider || '',
        externalId: row.external_id || '',
      }));
    },

    listContentItems(workspaceId, { limit = 50, before = null,qualityRule='' } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
      const rows = before === null
        ? database.prepare(`SELECT * FROM content_items ci WHERE ci.workspace_id = ?
            AND ${VISIBLE_CONTENT_SQL} AND ${approvedQualitySql(qualityRule)}
            ORDER BY ci.created_at DESC, ci.id DESC LIMIT ?`).all(workspaceId, safeLimit)
        : database.prepare(`SELECT * FROM content_items ci WHERE ci.workspace_id = ?
            AND ci.created_at < ?
            AND ${VISIBLE_CONTENT_SQL} AND ${approvedQualitySql(qualityRule)}
            ORDER BY ci.created_at DESC, ci.id DESC LIMIT ?`)
          .all(workspaceId, Number(before), safeLimit);
      return rows.map(mapContentItem);
    },

    listWindowSources(workspaceId, { startAt, endAt,qualityRule='',excludedItemIds=[] }) {
      const rows=database.prepare(`SELECT COALESCE(c.source_account_id,'local') sourceId,
        COALESCE(sa.display_name,'本地信息') sourceName,
        COALESCE(sa.provider,c.provider,'local') provider, COUNT(ci.id) available,
        MAX(sub.last_sync_at) lastSyncAt FROM content_items ci
        LEFT JOIN captures c ON c.id=ci.capture_id AND c.workspace_id=ci.workspace_id
        LEFT JOIN source_accounts sa ON sa.id=c.source_account_id AND sa.workspace_id=ci.workspace_id
        LEFT JOIN subscriptions sub ON sub.source_account_id=sa.id AND sub.workspace_id=ci.workspace_id
        WHERE ci.workspace_id=? AND ${VISIBLE_CONTENT_SQL} AND ${approvedQualitySql(qualityRule)}
          AND COALESCE(ci.published_at,ci.created_at)>=? AND COALESCE(ci.published_at,ci.created_at)<?
        AND ci.id NOT IN (SELECT value FROM json_each(?))
        GROUP BY COALESCE(c.source_account_id,'local')`).all(workspaceId,startAt,endAt,JSON.stringify(excludedItemIds));
      const configured=database.prepare(`SELECT sa.id sourceId,sa.display_name sourceName,sa.provider,sub.last_sync_at lastSyncAt
        FROM subscriptions sub JOIN source_accounts sa ON sa.id=sub.source_account_id
        WHERE sub.workspace_id=? AND sub.enabled=1`).all(workspaceId);
      for(const source of configured) if(!rows.some(r=>r.sourceId===source.sourceId)) rows.push({...source,available:0});
      return rows;
    },

    listContentItemsInWindow(workspaceId, { startAt, endAt, limit = 200, sourceId = null, cursor = null,qualityRule='',excludedItemIds=[],metadataOnly=false,timeBasis='published' } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
      const timeSql=timeBasis==='ingested' ? 'ci.created_at' : 'COALESCE(ci.published_at, ci.created_at)';
      const rows = database.prepare(`SELECT ${metadataOnly ? 'ci.id,ci.title,ci.published_at,ci.created_at,ci.updated_at' : 'ci.*'}, c.captured_at AS captured_at,
        COALESCE(sa.provider,c.provider,'local') AS provider, COALESCE(c.source_account_id,'local') AS source_id,
        COALESCE(sa.display_name,'') AS source_name, c.metadata_json AS capture_metadata
        FROM content_items ci
        LEFT JOIN captures c ON c.id = ci.capture_id
        LEFT JOIN source_accounts sa ON sa.id=c.source_account_id
        WHERE ci.workspace_id = ?
          AND ${VISIBLE_CONTENT_SQL} AND ${approvedQualitySql(qualityRule)}
          AND ${timeSql} >= ?
          AND ${timeSql} < ?
          AND (? IS NULL OR COALESCE(c.source_account_id,'local')=?)
          AND (? IS NULL OR (${timeSql},ci.id) > (?,?))
          AND ci.id NOT IN (SELECT value FROM json_each(?))
        ORDER BY ${timeSql} ASC, ci.id ASC
        LIMIT ?`).all(workspaceId, Number(startAt), Number(endAt), sourceId, sourceId,
          cursor?.eventAt ?? null, cursor?.eventAt ?? 0, cursor?.id ?? '', JSON.stringify(excludedItemIds), safeLimit);
      if(metadataOnly)return rows.map(row=>({id:`feed:${row.id}`,version:String(row.updated_at || row.created_at),eventAt:timeBasis==='ingested' ? row.created_at : row.published_at ?? row.created_at}));
      return rows.map((row) => ({
        ...mapContentItem(row),
        capturedAt: row.captured_at ?? null,
        eventAt: timeBasis==='ingested' ? row.created_at : row.published_at ?? row.created_at,
        provider: row.provider, sourceId: row.source_id, sourceName: row.source_name,
        captureMetadata: parseJson(row.capture_metadata),
      }));
    },

    listLegacyProviderItems(workspaceId,provider) {
      return database.prepare(`SELECT ci.*,c.external_id,c.captured_at,c.metadata_json capture_metadata FROM content_items ci
        JOIN captures c ON c.id=ci.capture_id AND c.workspace_id=ci.workspace_id WHERE ci.workspace_id=? AND c.provider=? ORDER BY ci.created_at`)
        .all(workspaceId,provider).map(r=>({...mapContentItem(r),externalId:r.external_id,capturedAt:r.captured_at,captureMetadata:parseJson(r.capture_metadata)}));
    },

    saveTranslations(values) {
      const records = (Array.isArray(values) ? values : [values])
        .map((value) => parseContract(SaveFeedItemTranslationInputSchema, value));
      if (!records.length) return [];
      const now = Date.now();
      const saved = [];
      database.transaction(() => {
        const statement = database.prepare(`INSERT INTO feed_item_translations
          (workspace_id, item_id, target_lang, source_hash, translated_text, engine, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, item_id, target_lang) DO UPDATE SET
            source_hash = excluded.source_hash,
            translated_text = excluded.translated_text,
            engine = excluded.engine,
            updated_at = excluded.updated_at`);
        for (const input of records) {
          statement.run(
            input.workspaceId,
            input.itemId,
            input.targetLang,
            input.sourceHash,
            input.translatedText,
            input.engine,
            now,
            now,
          );
          database.prepare(`DELETE FROM feed_translation_failures
            WHERE workspace_id = ? AND item_id = ? AND target_lang = ?`)
            .run(input.workspaceId, input.itemId, input.targetLang);
          emitEvent('feed.item-translation.saved.v1', 'item-translation', input.itemId, {
            itemId: input.itemId,
            targetLang: input.targetLang,
            engine: input.engine,
          }, input.workspaceId);
          saved.push({
            itemId: input.itemId,
            targetLang: input.targetLang,
            sourceHash: input.sourceHash,
            translatedText: input.translatedText,
            engine: input.engine,
            updatedAt: now,
          });
        }
      })();
      return saved;
    },

    removeTranslationIfUnchanged(value,expectedUpdatedAt) {
      const input=parseContract(SaveFeedItemTranslationInputSchema,value);
      if(!Number.isSafeInteger(expectedUpdatedAt))throw new Error('expected translation version is required');
      return database.transaction(()=>{
        const result=database.prepare('DELETE FROM feed_item_translations WHERE workspace_id=? AND item_id=? AND target_lang=? AND source_hash=? AND translated_text=? AND engine=? AND updated_at=?').run(input.workspaceId,input.itemId,input.targetLang,input.sourceHash,input.translatedText,input.engine,expectedUpdatedAt);
        if(result.changes)emitEvent('feed.item-translation.removed.v1','item-translation',input.itemId,{itemId:input.itemId,targetLang:input.targetLang},input.workspaceId);
        return result.changes===1;
      })();
    },

    listTranslations(workspaceId, itemIds = [], targetLang = 'zh') {
      const ids = [...new Set((itemIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
      if (!ids.length) return [];
      const placeholders = ids.map(() => '?').join(', ');
      const rows = database.prepare(`SELECT item_id, target_lang, source_hash, translated_text, engine, updated_at
        FROM feed_item_translations
        WHERE workspace_id = ? AND target_lang = ? AND item_id IN (${placeholders})`)
        .all(workspaceId, targetLang, ...ids);
      return rows.map((row) => ({
        itemId: row.item_id,
        targetLang: row.target_lang,
        sourceHash: row.source_hash,
        translatedText: row.translated_text,
        engine: row.engine || '',
        updatedAt: row.updated_at,
      }));
    },

    listTranslationsByHash(workspaceId, hashes = [], targetLang = 'zh') {
      const keys = [...new Set((hashes || []).map((hash) => String(hash || '').trim()).filter(Boolean))];
      if (!keys.length) return [];
      const placeholders = keys.map(() => '?').join(', ');
      const rows = database.prepare(`SELECT item_id, target_lang, source_hash, translated_text, engine, updated_at
        FROM feed_item_translations
        WHERE workspace_id = ? AND target_lang = ? AND source_hash IN (${placeholders})
        ORDER BY updated_at DESC`).all(workspaceId, targetLang, ...keys);
      return rows.map((row) => ({
        itemId: row.item_id,
        targetLang: row.target_lang,
        sourceHash: row.source_hash,
        translatedText: row.translated_text,
        engine: row.engine || '',
        updatedAt: row.updated_at,
      }));
    },

    listTranslationFailures(workspaceId, itemIds = [], targetLang = 'zh') {
      const ids = [...new Set((itemIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
      if (!ids.length) return [];
      const placeholders = ids.map(() => '?').join(', ');
      const rows = database.prepare(`SELECT item_id, target_lang, source_hash, attempt_count, next_retry_at, last_error, updated_at
        FROM feed_translation_failures
        WHERE workspace_id = ? AND target_lang = ? AND item_id IN (${placeholders})`)
        .all(workspaceId, targetLang, ...ids);
      return rows.map((row) => ({
        itemId: row.item_id,
        targetLang: row.target_lang,
        sourceHash: row.source_hash,
        attemptCount: row.attempt_count,
        nextRetryAt: row.next_retry_at ?? null,
        lastError: row.last_error || '',
        updatedAt: row.updated_at,
      }));
    },

    noteTranslationFailure({ workspaceId, items = [], targetLang = 'zh', error, attemptCount, terminal, nextRetryAt } = {}) {
      const lang = targetLang === 'en' ? 'en' : 'zh';
      const message = publicTranslationError(error);
      const now = Date.now();
      const rows = [];
      database.transaction(() => {
        const readFailure = database.prepare(`SELECT attempt_count FROM feed_translation_failures
          WHERE workspace_id = ? AND item_id = ? AND target_lang = ?`);
        const readReady = database.prepare(`SELECT source_hash, translated_text FROM feed_item_translations
          WHERE workspace_id = ? AND item_id = ? AND target_lang = ?`);
        const write = database.prepare(`INSERT INTO feed_translation_failures
          (workspace_id, item_id, target_lang, source_hash, attempt_count, next_retry_at, last_error, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, item_id, target_lang) DO UPDATE SET
            source_hash = excluded.source_hash,
            attempt_count = excluded.attempt_count,
            next_retry_at = excluded.next_retry_at,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at`);
        for (const item of items) {
          const id = String(item?.id || '').trim();
          const text = String(item?.text || '');
          if (!id || !text) continue;
          const hash = sourceHash(text);
          const saved = readReady.get(workspaceId, id, lang);
          if (saved?.translated_text && saved.source_hash === hash) continue;
          const previous = readFailure.get(workspaceId, id, lang);
          const attempts = Number.isInteger(attemptCount) ? attemptCount : (Number(previous?.attempt_count) || 0) + 1;
          const done = terminal === true || attempts >= TRANSLATION_MAX_ATTEMPTS;
          const retryAt = done ? null : (Number.isInteger(nextRetryAt) ? nextRetryAt : now + translationRetryDelayMs(attempts));
          write.run(workspaceId, id, lang, hash, attempts, retryAt, message, now);
          rows.push({ itemId: id, attemptCount: attempts, nextRetryAt: retryAt, lastError: message });
        }
      })();
      return rows;
    },

    upsertUserItemState(value) {
      const input = parseContract(PatchUserItemStateInputSchema, value);
      const now = Date.now();
      const existing = database.prepare(`SELECT is_read, is_saved, is_hidden FROM user_item_states
        WHERE workspace_id = ? AND content_item_id = ?`)
        .get(input.workspaceId, input.contentItemId);
      const next = {
        isRead: input.isRead ?? Boolean(existing?.is_read),
        isSaved: input.isSaved ?? Boolean(existing?.is_saved),
        isHidden: input.isHidden ?? Boolean(existing?.is_hidden),
      };
      database.prepare(`INSERT INTO user_item_states
        (workspace_id, content_item_id, is_read, is_saved, is_hidden, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, content_item_id) DO UPDATE SET
          is_read = excluded.is_read,
          is_saved = excluded.is_saved,
          is_hidden = excluded.is_hidden,
          updated_at = excluded.updated_at`)
        .run(input.workspaceId, input.contentItemId, next.isRead ? 1 : 0, next.isSaved ? 1 : 0, next.isHidden ? 1 : 0, now);
      emitEvent('feed.item-state.updated.v1', 'user-item-state', input.contentItemId, {
        contentItemId: input.contentItemId,
        isHidden: next.isHidden,
        isSaved: next.isSaved,
        isRead: next.isRead,
      }, input.workspaceId);
      return {
        workspaceId: input.workspaceId,
        contentItemId: input.contentItemId,
        ...next,
        updatedAt: now,
      };
    },
  };
  return Object.freeze(repository);
}
