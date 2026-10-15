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

function whenFilterReady(columnSql, jsonSql) {
  return `CASE WHEN c.feed_filter_ready = 1 THEN (${columnSql}) ELSE (${jsonSql}) END`;
}

const LOW_VALUE_SQL = whenFilterReady(
  `c.filter_mode = 'enforce' AND c.filter_decision IN ('DROP','REVIEW') AND c.filter_applied = 1`,
  `json_extract(c.metadata_json,'$.filterMode')='enforce'
  AND json_extract(c.metadata_json,'$.filterDecision') IN ('DROP','REVIEW')
  AND json_extract(c.metadata_json,'$.filterApplied')=1`,
);

const AUTHOR_HANDLE_SQL = `CASE WHEN c.feed_filter_ready = 1 THEN c.author_handle ELSE COALESCE(json_extract(c.metadata_json, '$.authorHandle'), '') END`;

function feedVisibilitySql({ qualityRule = '', includeLowValue = false } = {}) {
  if (!includeLowValue) return `${VISIBLE_CONTENT_SQL} AND ${approvedQualitySql(qualityRule)}`;
  if (!qualityRule) return USER_VISIBLE_CONTENT_SQL;
  return `${USER_VISIBLE_CONTENT_SQL} AND ((${approvedQualitySql(qualityRule)}) OR (${LOW_VALUE_SQL}))`;
}

function captureApprovedSql(rule = '') {
  if (!rule) return '1=1';
  if (rule !== 'all-three-0.60') throw new Error('Unsupported admission rule');
  return whenFilterReady(
    `c.filter_rule = 'all-three-0.60'
    AND c.filter_decision = 'KEEP'
    AND c.filter_reading >= 0.60
    AND c.filter_specific >= 0.60
    AND c.filter_sufficient >= 0.60`,
    `json_extract(c.metadata_json,'$.filterRule')='all-three-0.60'
    AND json_extract(c.metadata_json,'$.filterDecision')='KEEP'
    AND json_extract(c.metadata_json,'$.filterScores.reading_value')>=0.60
    AND json_extract(c.metadata_json,'$.filterScores.specific_content')>=0.60
    AND json_extract(c.metadata_json,'$.filterScores.sufficient_information')>=0.60`,
  );
}

// json_extract 缺字段时是 NULL。直接 NOT (NULL) 也会把行滤掉，所以缺字段按「不是低价值」处理。
const JOINED_LOW_VALUE_SQL = whenFilterReady(
  `c.filter_mode = 'enforce' AND c.filter_decision IN ('DROP','REVIEW') AND c.filter_applied = 1`,
  `IFNULL(json_extract(c.metadata_json,'$.filterMode'), '') = 'enforce'
  AND IFNULL(json_extract(c.metadata_json,'$.filterDecision'), '') IN ('DROP','REVIEW')
  AND IFNULL(json_extract(c.metadata_json,'$.filterApplied'), 0) = 1`,
);

// 与 feedVisibilitySql 同义，但落在已经 JOIN 的 captures / user_item_states 上，避免再对每行做一次相关子查询。
function joinedFeedVisibilitySql({ qualityRule = '', includeLowValue = false } = {}) {
  const visible = 'COALESCE(item_state.is_hidden, 0) = 0';
  if (!includeLowValue) return `${visible} AND NOT (${JOINED_LOW_VALUE_SQL}) AND (${captureApprovedSql(qualityRule)})`;
  if (!qualityRule) return visible;
  return `${visible} AND ((${captureApprovedSql(qualityRule)}) OR (${JOINED_LOW_VALUE_SQL}))`;
}

const PROVIDER_FEED_FROM = `
  FROM captures c
  INNER JOIN content_items ci ON ci.capture_id = c.id AND ci.workspace_id = c.workspace_id
  LEFT JOIN user_item_states item_state
    ON item_state.workspace_id = ci.workspace_id AND item_state.content_item_id = ci.id`;

function providerFeedIndexedFrom(sourceAccountId = '') {
  const captureIndex = sourceAccountId ? 'idx_captures_feed_sort' : 'idx_captures_provider_captured';
  return `
  FROM captures c INDEXED BY ${captureIndex}
  INNER JOIN content_items ci INDEXED BY idx_content_items_capture_cover
    ON ci.capture_id = c.id AND ci.workspace_id = c.workspace_id
  LEFT JOIN user_item_states item_state
    ON item_state.workspace_id = ci.workspace_id AND item_state.content_item_id = ci.id`;
}

function providerFeedFilter({
  qualityRule = '',
  includeLowValue = false,
  taggedOnly = false,
  savedOnly = false,
  sourceAccountId = '',
  readFlag = null,
  before = null,
} = {}) {
  const params = [];
  let sql = joinedFeedVisibilitySql({ qualityRule, includeLowValue });
  if (taggedOnly) sql += ` AND ${TAGGED_CONTENT_SQL}`;
  if (savedOnly) sql += ' AND COALESCE(item_state.is_saved, 0) = 1';
  if (sourceAccountId) {
    sql += ' AND c.source_account_id = ?';
    params.push(sourceAccountId);
  }
  if (readFlag === 0) sql += ' AND COALESCE(item_state.is_read, 0) = 0';
  if (readFlag === 1) sql += ' AND item_state.is_read = 1';
  if (before && (readFlag === null || before.isRead === readFlag)) {
    sql += ' AND (c.captured_at < ? OR (c.captured_at = ? AND ci.id < ?))';
    params.push(before.at, before.at, before.id);
  }
  return { sql, params };
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

function sqlLikePrefix(value) {
  return `${String(value).replace(/[\\%_]/g, '\\$&')}%`;
}

const FEED_DEDUP_SELECT = `ci.workspace_id, ci.id, ci.title, ci.summary, ci.source_url, ci.author_name, ci.published_at, ci.created_at,
  CASE WHEN length(ci.body) > 0 THEN 1 ELSE 0 END AS has_body,
  COALESCE(sa.external_id, '') AS source_external_id, COALESCE(sa.profile_url, '') AS profile_url`;

const FEED_DEDUP_FROM = `content_items ci
  LEFT JOIN captures c ON c.id = ci.capture_id AND c.workspace_id = ci.workspace_id
  LEFT JOIN source_accounts sa ON sa.id = c.source_account_id AND sa.workspace_id = ci.workspace_id`;

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

function feedFilterColumns(metadata) {
  const meta = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const scores = meta.filterScores && typeof meta.filterScores === 'object' ? meta.filterScores : {};
  const score = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  return {
    authorHandle: String(meta.authorHandle || ''),
    filterMode: String(meta.filterMode || ''),
    filterDecision: String(meta.filterDecision || ''),
    filterApplied: meta.filterApplied ? 1 : 0,
    filterRule: String(meta.filterRule || ''),
    filterReading: score(scores.reading_value),
    filterSpecific: score(scores.specific_content),
    filterSufficient: score(scores.sufficient_information),
  };
}

export function createFeedRepository(database, emitEvent) {
  function providerAccount(workspaceId, provider, externalId) {
    const id = String(externalId || '');
    if (!id) return { ok: true, id: '' };
    const row = database.prepare(`SELECT id FROM source_accounts
      WHERE workspace_id = ? AND provider = ? AND external_id = ?`).get(workspaceId, provider, id);
    return row ? { ok: true, id: row.id } : { ok: false, id: '' };
  }

  function providerFeedIds(workspaceId, provider, options) {
    const limit = options.limit;
    const before = options.before || null;
    const ids = [];
    const take = (readFlag, cursor, remaining) => {
      if (remaining <= 0) return;
      const filter = providerFeedFilter({
        qualityRule: options.qualityRule || '',
        includeLowValue: Boolean(options.includeLowValue),
        taggedOnly: Boolean(options.taggedOnly),
        savedOnly: Boolean(options.savedOnly),
        sourceAccountId: options.sourceAccountId || '',
        readFlag,
        before: cursor,
      });
      const rows = database.prepare(`SELECT ci.id AS id
        ${providerFeedIndexedFrom(options.sourceAccountId)}
        WHERE c.workspace_id = ? AND c.provider = ?
          AND ${filter.sql}
        ORDER BY c.captured_at DESC, ci.id DESC
        LIMIT ?`).all(workspaceId, provider, ...filter.params, remaining);
      for (const row of rows) ids.push(row.id);
    };
    if (!before || before.isRead === 0) take(0, before && before.isRead === 0 ? before : null, limit);
    if (ids.length < limit) take(1, before && before.isRead === 1 ? before : null, limit - ids.length);
    return ids;
  }

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
        const filter = feedFilterColumns(input.metadata);
        database.prepare(`INSERT INTO captures
          (id, workspace_id, provider, external_id, source_account_id, source_url, title, content_hash,
           raw_artifact_path, status, published_at, captured_at, metadata_json,
           author_handle, filter_mode, filter_decision, filter_applied, filter_rule,
           filter_reading, filter_specific, filter_sufficient, feed_filter_ready)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(workspace_id, provider, external_id) DO UPDATE SET
            source_account_id = excluded.source_account_id,
            source_url = excluded.source_url,
            title = excluded.title,
            content_hash = excluded.content_hash,
            raw_artifact_path = excluded.raw_artifact_path,
            status = excluded.status,
            published_at = excluded.published_at,
            captured_at = captures.captured_at,
            metadata_json = excluded.metadata_json,
            author_handle = excluded.author_handle,
            filter_mode = excluded.filter_mode,
            filter_decision = excluded.filter_decision,
            filter_applied = excluded.filter_applied,
            filter_rule = excluded.filter_rule,
            filter_reading = excluded.filter_reading,
            filter_specific = excluded.filter_specific,
            filter_sufficient = excluded.filter_sufficient,
            feed_filter_ready = 1`)
          .run(id, input.workspaceId, input.provider, input.externalId, input.sourceAccountId,
            input.sourceUrl, input.title, input.contentHash, input.rawArtifactPath, input.status,
            input.publishedAt, capturedAt, JSON.stringify(input.metadata),
            filter.authorHandle, filter.filterMode, filter.filterDecision, filter.filterApplied, filter.filterRule,
            filter.filterReading, filter.filterSpecific, filter.filterSufficient);
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

    rememberFeedDedupKey(workspaceId, id, dedupKey) {
      const key = String(dedupKey || '');
      if (!key || !id) return false;
      const result = database.prepare(`UPDATE content_items SET dedup_key = ?
        WHERE workspace_id = ? AND id = ? AND (dedup_key IS NULL OR dedup_key = '')`).run(key, workspaceId, id);
      return result.changes === 1;
    },

    listFeedByDedupKey(workspaceId, dedupKey) {
      const key = String(dedupKey || '');
      if (!key) return [];
      return database.prepare(`SELECT ${FEED_DEDUP_SELECT} FROM ${FEED_DEDUP_FROM}
        WHERE ci.workspace_id = ? AND ci.dedup_key = ? LIMIT 20`).all(workspaceId, key);
    },

    listFeedByUrlPrefixes(workspaceId, prefixes) {
      const list = [...new Set(prefixes || [])].filter(Boolean).slice(0, 8);
      if (!list.length) return [];
      const clause = list.map(() => `ci.source_url LIKE ? ESCAPE '\\'`).join(' OR ');
      return database.prepare(`SELECT ${FEED_DEDUP_SELECT} FROM ${FEED_DEDUP_FROM}
        WHERE ci.workspace_id = ? AND (${clause})
        ORDER BY length(ci.source_url) ASC LIMIT 40`).all(workspaceId, ...list.map(sqlLikePrefix));
    },

    listFeedByPublishedAt(workspaceId, startAt, endAt) {
      return database.prepare(`SELECT ${FEED_DEDUP_SELECT} FROM ${FEED_DEDUP_FROM}
        WHERE ci.workspace_id = ? AND ci.published_at >= ? AND ci.published_at <= ?
        ORDER BY ci.published_at ASC LIMIT 400`).all(workspaceId, startAt, endAt);
    },

    fillFeedItemGaps(workspaceId, id, fields) {
      const row = database.prepare(`SELECT title, summary, body, author_name, source_url, published_at, dedup_key
        FROM content_items WHERE workspace_id = ? AND id = ?`).get(workspaceId, id);
      if (!row) return false;
      const next = {
        title: row.title || '',
        summary: row.summary || '',
        body: row.body || '',
        authorName: row.author_name || '',
        sourceUrl: row.source_url || '',
        publishedAt: row.published_at || null,
        dedupKey: row.dedup_key || '',
      };
      let contentChanged = false;
      if (!next.title && fields.title) { next.title = String(fields.title); contentChanged = true; }
      if (!next.summary && fields.summary) { next.summary = String(fields.summary); contentChanged = true; }
      if (!next.body && fields.body) { next.body = String(fields.body); contentChanged = true; }
      if (!next.authorName && fields.authorName) { next.authorName = String(fields.authorName); contentChanged = true; }
      if (!next.sourceUrl && fields.url) { next.sourceUrl = String(fields.url); contentChanged = true; }
      if (!next.publishedAt && fields.publishedAt) { next.publishedAt = fields.publishedAt; contentChanged = true; }
      if (!next.dedupKey && fields.dedupKey) next.dedupKey = String(fields.dedupKey);
      const same = next.title === (row.title || '') && next.summary === (row.summary || '') && next.body === (row.body || '')
        && next.authorName === (row.author_name || '') && next.sourceUrl === (row.source_url || '')
        && (next.publishedAt || null) === (row.published_at || null) && next.dedupKey === (row.dedup_key || '');
      if (same) return false;
      database.prepare(`UPDATE content_items SET
          title = ?, summary = ?, body = ?, author_name = ?, source_url = ?, published_at = ?, dedup_key = ?
        WHERE workspace_id = ? AND id = ?`).run(
        next.title, next.summary, next.body, next.authorName, next.sourceUrl, next.publishedAt, next.dedupKey || null,
        workspaceId, id,
      );
      return contentChanged;
    },

    touchPublishedAt(workspaceId, provider, externalId, publishedAt) {
      const at = Number(publishedAt);
      if (!Number.isFinite(at) || at <= 0) return false;
      const capture = database.prepare(`SELECT id, published_at FROM captures
        WHERE workspace_id = ? AND provider = ? AND external_id = ?`)
        .get(workspaceId, provider, String(externalId || ''));
      if (!capture) return false;
      const prev = Number(capture.published_at) || 0;
      if (prev && Math.abs(prev - at) <= 36 * 60 * 60 * 1000) return false;
      database.prepare('UPDATE captures SET published_at = ? WHERE id = ?').run(at, capture.id);
      database.prepare(`UPDATE content_items SET published_at = ?, updated_at = ?
        WHERE workspace_id = ? AND capture_id = ?`).run(at, Date.now(), workspaceId, capture.id);
      return true;
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
        COALESCE(sa.external_id,'') AS source_external_id, COALESCE(sa.display_name,'') AS source_name,
        ROW_NUMBER() OVER (PARTITION BY c.source_account_id ORDER BY c.captured_at DESC,ci.created_at DESC,ci.id DESC) AS pool_rank
        FROM content_items ci JOIN captures c ON c.id=ci.capture_id AND c.workspace_id=ci.workspace_id
        LEFT JOIN source_accounts sa ON sa.id=c.source_account_id AND sa.workspace_id=ci.workspace_id
        WHERE ci.workspace_id=? AND c.provider IN ('x','xueqiu','trendforce','bilibili') AND ${USER_VISIBLE_CONTENT_SQL})
        WHERE pool_rank<=? ORDER BY provider,captured_at DESC`).all(workspaceId,limit)
        .map(r=>({...mapContentItem(r),provider:r.provider,externalId:r.external_id,sourceExternalId:r.source_external_id || '',sourceName:r.source_name || '',captureMetadata:parseJson(r.capture_metadata_json)}));
    },

    listContentItemsByProvider(workspaceId, provider, options = {}) {
      const safeLimit = Math.max(1, Math.min(Number(options.limit) || 200, 500));
      const account = providerAccount(workspaceId, provider, options.sourceExternalId || '');
      if (!account.ok) return [];
      const ids = providerFeedIds(workspaceId, provider, { ...options, sourceAccountId: account.id, limit: safeLimit });
      if (!ids.length) return [];
      const itemColumns = options.omitBody
        ? `ci.id, ci.workspace_id, ci.capture_id, ci.origin_type, ci.content_type, ci.title, '' AS body,
          substr(ci.body, 1, 480) AS body_lang, ci.summary,
          ci.source_url, ci.author_name, ci.published_at, ci.created_at, ci.updated_at`
        : 'ci.*';
      const captureColumns = options.omitBody
        ? `c.provider AS provider, c.external_id AS external_id, c.captured_at AS captured_at,
          ${AUTHOR_HANDLE_SQL} AS author_handle`
        : `c.provider AS provider, c.external_id AS external_id, c.captured_at AS captured_at,
          c.metadata_json AS capture_metadata_json`;
      const rows = database.prepare(`SELECT ${itemColumns}, ${captureColumns},
          COALESCE(item_state.is_read, 0) AS is_read,
          COALESCE(item_state.is_saved, 0) AS is_saved,
          CASE WHEN ${LOW_VALUE_SQL} THEN 1 ELSE 0 END AS low_value
          ${PROVIDER_FEED_FROM}
          WHERE ci.workspace_id = ? AND ci.id IN (${ids.map(() => '?').join(',')})`)
        .all(workspaceId, ...ids);
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id)).filter(Boolean).map((row) => ({
        ...mapContentItem(row),
        provider: row.provider,
        externalId: row.external_id,
        capturedAt: row.captured_at,
        captureMetadata: options.omitBody
          ? { authorHandle: row.author_handle || '' }
          : parseJson(row.capture_metadata_json),
        ...(options.omitBody ? { bodyLang: String(row.body_lang || '') } : {}),
        isRead: Boolean(row.is_read),
        isSaved: Boolean(row.is_saved),
        lowValue: Boolean(row.low_value),
      }));
    },

    backfillFeedFilterColumns(limit = 10, provider = '') {
      const cap = Math.max(1, Math.min(Number(limit) || 10, 40));
      const providerId = String(provider || '');
      const rows = providerId
        ? database.prepare(`SELECT id, metadata_json FROM captures
          WHERE feed_filter_ready = 0 AND provider = ?
          ORDER BY captured_at DESC, id DESC
          LIMIT ?`).all(providerId, cap)
        : database.prepare(`SELECT id, metadata_json FROM captures
          WHERE feed_filter_ready = 0
          ORDER BY captured_at DESC, id DESC
          LIMIT ?`).all(cap);
      const update = database.prepare(`UPDATE captures SET
        author_handle = ?, filter_mode = ?, filter_decision = ?, filter_applied = ?, filter_rule = ?,
        filter_reading = ?, filter_specific = ?, filter_sufficient = ?, feed_filter_ready = 1
        WHERE id = ? AND feed_filter_ready = 0`);
      const write = database.transaction((items) => {
        for (const row of items) {
          let meta = {};
          try {
            meta = JSON.parse(row.metadata_json || '{}') || {};
          } catch {
            meta = {};
          }
          const filter = feedFilterColumns(meta);
          update.run(filter.authorHandle, filter.filterMode, filter.filterDecision, filter.filterApplied,
            filter.filterRule, filter.filterReading, filter.filterSpecific, filter.filterSufficient, row.id);
        }
      });
      write(rows);
      return rows.length;
    },

    explainProviderFeed(workspaceId, provider, options = {}) {
      const account = providerAccount(workspaceId, provider, options.sourceExternalId || '');
      if (!account.ok) return [];
      const filter = providerFeedFilter({
        ...options,
        sourceAccountId: account.id,
        readFlag: 0,
        before: null,
      });
      return database.prepare(`EXPLAIN QUERY PLAN
        SELECT ci.id
        ${providerFeedIndexedFrom(account.id)}
        WHERE c.workspace_id = ? AND c.provider = ?
          AND ${filter.sql}
        ORDER BY c.captured_at DESC, ci.id DESC
        LIMIT ?`).all(workspaceId, provider, ...filter.params, Math.max(1, Math.min(Number(options.limit) || 20, 500)))
        .map((row) => String(row.detail || ''));
    },

    countContentItemsByProvider(workspaceId, provider, { sourceExternalId = '', taggedOnly = false, qualityRule = '', includeLowValue = false } = {}) {
      const account = providerAccount(workspaceId, provider, sourceExternalId);
      if (!account.ok) return 0;
      const filter = providerFeedFilter({
        qualityRule,
        includeLowValue,
        taggedOnly,
        sourceAccountId: account.id,
      });
      const row = database.prepare(`SELECT COUNT(*) AS n
        ${providerFeedIndexedFrom(account.id)}
        WHERE c.workspace_id = ? AND c.provider = ?
          AND ${filter.sql}`).get(workspaceId, provider, ...filter.params);
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

    contentSourceNames(workspaceId, id) {
      const row = database.prepare(`SELECT ci.author_name AS author_name, c.provider AS provider, sa.display_name AS display_name
        FROM content_items ci
        LEFT JOIN captures c ON c.id = ci.capture_id
        LEFT JOIN source_accounts sa ON sa.id = c.source_account_id
        WHERE ci.workspace_id = ? AND ci.id = ?`).get(workspaceId, id);
      if (!row) return null;
      return {
        displayName: String(row.display_name || '').trim(),
        authorName: String(row.author_name || '').trim(),
        provider: String(row.provider || '').trim(),
      };
    },

    listItemSources(workspaceId, ids = []) {
      const wanted = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
      if (!wanted.length) return [];
      const marks = wanted.map(() => '?').join(',');
      return database.prepare(`SELECT ci.id AS id, COALESCE(sa.external_id,'') AS externalId, COALESCE(sa.display_name,'') AS displayName
        FROM content_items ci
        LEFT JOIN captures c ON c.id = ci.capture_id AND c.workspace_id = ci.workspace_id
        LEFT JOIN source_accounts sa ON sa.id = c.source_account_id AND sa.workspace_id = ci.workspace_id
        WHERE ci.workspace_id = ? AND ci.id IN (${marks})`).all(workspaceId, ...wanted);
    },

    listFlashItems(workspaceId, { externalIds = [], limit = 50 } = {}) {
      const ids = [...new Set((externalIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
      if (!ids.length) return [];
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
      const marks = ids.map(() => '?').join(',');
      return database.prepare(`SELECT ci.id, ci.title, ci.summary, ci.body, ci.source_url, ci.published_at, ci.created_at,
          COALESCE(sa.display_name,'') AS source_name
        FROM content_items ci
        JOIN captures c ON c.id = ci.capture_id AND c.workspace_id = ci.workspace_id
        JOIN source_accounts sa ON sa.id = c.source_account_id AND sa.workspace_id = ci.workspace_id
        WHERE ci.workspace_id = ? AND sa.external_id IN (${marks}) AND ${USER_VISIBLE_CONTENT_SQL}
        ORDER BY COALESCE(ci.published_at, ci.created_at) DESC, ci.id DESC
        LIMIT ?`).all(workspaceId, ...ids, safeLimit).map((row) => ({
        id: row.id,
        title: row.title || '',
        summary: row.summary || '',
        body: row.body || '',
        sourceUrl: row.source_url || '',
        publishedAt: row.published_at ?? null,
        createdAt: row.created_at,
        source: row.source_name || '',
      }));
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
      const rows = database.prepare(`SELECT ${metadataOnly ? 'ci.id,ci.title,ci.source_url,ci.published_at,ci.created_at,ci.updated_at' : 'ci.*'}, c.captured_at AS captured_at,
        COALESCE(sa.provider,c.provider,'local') AS provider, COALESCE(c.source_account_id,'local') AS source_id,
        COALESCE(sa.display_name,'') AS source_name, COALESCE(sa.external_id,'') AS source_external_id, c.metadata_json AS capture_metadata
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
      if(metadataOnly)return rows.map(row=>({id:`feed:${row.id}`,title:row.title || '',sourceUrl:row.source_url || '',publishedAt:row.published_at ?? null,version:String(row.updated_at || row.created_at),eventAt:timeBasis==='ingested' ? row.created_at : row.published_at ?? row.created_at,sourceExternalId:row.source_external_id || '',sourceName:row.source_name || ''}));
      return rows.map((row) => ({
        ...mapContentItem(row),
        capturedAt: row.captured_at ?? null,
        eventAt: timeBasis==='ingested' ? row.created_at : row.published_at ?? row.created_at,
        provider: row.provider, sourceId: row.source_id, sourceName: row.source_name,
        sourceExternalId: row.source_external_id || '',
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
          database.prepare(`DELETE FROM feed_translation_chunks
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

    listTranslationPreviews(workspaceId, itemIds = [], targetLang = 'zh', limit = 240) {
      const ids = [...new Set((itemIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
      if (!ids.length) return [];
      const clip = Math.max(40, Math.min(Number(limit) || 240, 400));
      const placeholders = ids.map(() => '?').join(', ');
      const rows = database.prepare(`SELECT item_id, target_lang, source_hash,
          substr(translated_text, 1, ${clip}) AS translated_text, engine, updated_at
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

    replaceContentBody(workspaceId, id, body) {
      const text = String(body || '');
      if (!workspaceId || !id || !text) return false;
      return database.transaction(() => {
        const result = database.prepare(`UPDATE content_items SET body = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND body != ?`).run(text, Date.now(), workspaceId, id, text);
        if (!result.changes) return false;
        const item = database.prepare('SELECT id, capture_id FROM content_items WHERE workspace_id = ? AND id = ?')
          .get(workspaceId, id);
        emitEvent('feed.content-item.saved.v1', 'content-item', id,
          { contentItemId: id, captureId: item?.capture_id || null }, workspaceId);
        return true;
      })();
    },

    listUntranslatedFeedBodies(workspaceId, { limit = 80, scan = 400, excludeSourceIds = [] } = {}) {
      const cap = Math.max(1, Math.min(Number(scan) || Number(limit) || 80, 500));
      const excluded = [...new Set((excludeSourceIds || []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 40);
      const flashOrder = excluded.length
        ? `CASE WHEN COALESCE(sa.external_id, '') IN (${excluded.map(() => '?').join(', ')}) THEN 1 ELSE 0 END`
        : 'CASE WHEN 1 = 0 THEN 1 ELSE 0 END';
      const rows = database.prepare(`SELECT ci.id AS id, ci.body AS body, ci.summary AS summary, ci.title AS title,
          ci.created_at AS created_at, c.provider AS provider, c.external_id AS external_id,
          COALESCE(sa.external_id, '') AS source_external_id,
          COALESCE(uis.is_hidden, 0) AS is_hidden,
          (SELECT t.source_hash FROM feed_item_translations t
            WHERE t.workspace_id = ci.workspace_id AND t.target_lang = 'zh' AND t.translated_text != ''
              AND t.item_id = ci.id LIMIT 1) AS translation_hash,
          (SELECT t.engine FROM feed_item_translations t
            WHERE t.workspace_id = ci.workspace_id AND t.target_lang = 'zh' AND t.translated_text != ''
              AND t.item_id = ci.id LIMIT 1) AS translation_engine,
          (SELECT length(t.translated_text) FROM feed_item_translations t
            WHERE t.workspace_id = ci.workspace_id AND t.target_lang = 'zh' AND t.translated_text != ''
              AND t.item_id = ci.id LIMIT 1) AS translation_length,
          (SELECT substr(t.translated_text, -240) FROM feed_item_translations t
            WHERE t.workspace_id = ci.workspace_id AND t.target_lang = 'zh' AND t.translated_text != ''
              AND t.item_id = ci.id LIMIT 1) AS translation_tail,
          (SELECT t.source_hash FROM feed_item_translations t
            WHERE t.workspace_id = ci.workspace_id AND t.target_lang = 'zh' AND t.translated_text != ''
              AND t.item_id = c.provider || ':' || c.external_id LIMIT 1) AS external_translation_hash,
          (SELECT t.engine FROM feed_item_translations t
            WHERE t.workspace_id = ci.workspace_id AND t.target_lang = 'zh' AND t.translated_text != ''
              AND t.item_id = c.provider || ':' || c.external_id LIMIT 1) AS external_translation_engine,
          (SELECT length(t.translated_text) FROM feed_item_translations t
            WHERE t.workspace_id = ci.workspace_id AND t.target_lang = 'zh' AND t.translated_text != ''
              AND t.item_id = c.provider || ':' || c.external_id LIMIT 1) AS external_translation_length,
          (SELECT substr(t.translated_text, -240) FROM feed_item_translations t
            WHERE t.workspace_id = ci.workspace_id AND t.target_lang = 'zh' AND t.translated_text != ''
              AND t.item_id = c.provider || ':' || c.external_id LIMIT 1) AS external_translation_tail
        FROM content_items ci
        JOIN captures c ON c.id = ci.capture_id AND c.workspace_id = ci.workspace_id
        LEFT JOIN source_accounts sa ON sa.id = c.source_account_id AND sa.workspace_id = ci.workspace_id
        LEFT JOIN user_item_states uis ON uis.workspace_id = ci.workspace_id AND uis.content_item_id = ci.id
        WHERE ci.workspace_id = ?
          AND c.provider IN ('x', 'xueqiu', 'trendforce', 'bilibili')
          AND length(ci.body) > 0
        ORDER BY CASE WHEN length(ci.body) > 20000 THEN 0 ELSE 1 END,
          CASE WHEN COALESCE(uis.is_hidden, 0) = 1 THEN 1 ELSE 0 END,
          ${flashOrder},
          CASE WHEN EXISTS (
            SELECT 1 FROM feed_item_translations t
            WHERE t.workspace_id = ci.workspace_id AND t.target_lang = 'zh' AND t.translated_text != ''
              AND (t.item_id = ci.id OR t.item_id = c.provider || ':' || c.external_id)
          ) THEN 1 ELSE 0 END,
          ci.created_at DESC
        LIMIT ?`).all(workspaceId, ...excluded, cap);
      return rows.map((row) => ({
        id: row.id,
        body: row.body || '',
        summary: row.summary || '',
        title: row.title || '',
        createdAt: row.created_at,
        provider: row.provider || '',
        externalId: row.external_id || '',
        sourceExternalId: row.source_external_id || '',
        hidden: Number(row.is_hidden) === 1,
        translationHash: row.translation_hash || '',
        translationEngine: row.translation_engine || '',
        translationLength: Number(row.translation_length) || 0,
        translationTail: row.translation_tail || '',
        externalTranslationHash: row.external_translation_hash || '',
        externalTranslationEngine: row.external_translation_engine || '',
        externalTranslationLength: Number(row.external_translation_length) || 0,
        externalTranslationTail: row.external_translation_tail || '',
      }));
    },

    listFeedBodiesSince(workspaceId, { since = 0, beforeCreatedAt = null, beforeId = '', limit = 200 } = {}) {
      const cap = Math.max(1, Math.min(Number(limit) || 200, 500));
      const sinceAt = Number(since) || 0;
      const cursorAt = beforeCreatedAt == null || beforeCreatedAt === '' ? Number.NaN : Number(beforeCreatedAt);
      const hasCursor = Number.isFinite(cursorAt);
      const cursorSql = hasCursor
        ? `AND (ci.created_at < ? OR (ci.created_at = ? AND ci.id > ?))`
        : '';
      const params = hasCursor
        ? [workspaceId, sinceAt, cursorAt, cursorAt, String(beforeId || ''), cap]
        : [workspaceId, sinceAt, cap];
      const rows = database.prepare(`SELECT ci.id AS id, ci.body AS body, ci.created_at AS created_at,
          c.provider AS provider, c.external_id AS external_id,
          COALESCE(sa.external_id, '') AS source_external_id,
          COALESCE(uis.is_hidden, 0) AS is_hidden
        FROM content_items ci
        JOIN captures c ON c.id = ci.capture_id AND c.workspace_id = ci.workspace_id
        LEFT JOIN source_accounts sa ON sa.id = c.source_account_id AND sa.workspace_id = ci.workspace_id
        LEFT JOIN user_item_states uis ON uis.workspace_id = ci.workspace_id AND uis.content_item_id = ci.id
        WHERE ci.workspace_id = ?
          AND c.provider IN ('x', 'xueqiu', 'trendforce', 'bilibili')
          AND length(ci.body) > 0
          AND ci.created_at >= ?
          ${cursorSql}
        ORDER BY ci.created_at DESC, ci.id ASC
        LIMIT ?`).all(...params);
      return rows.map((row) => ({
        id: row.id,
        body: row.body || '',
        createdAt: row.created_at,
        provider: row.provider || '',
        externalId: row.external_id || '',
        sourceExternalId: row.source_external_id || '',
        hidden: Number(row.is_hidden) === 1,
      }));
    },

    countLongUntranslatedOutsideProviders(workspaceId) {
      const row = database.prepare(`SELECT COUNT(*) AS n FROM content_items ci
        JOIN captures c ON c.id = ci.capture_id AND c.workspace_id = ci.workspace_id
        WHERE ci.workspace_id = ?
          AND c.provider NOT IN ('x', 'xueqiu', 'trendforce', 'bilibili')
          AND length(ci.body) > 20000
          AND ${USER_VISIBLE_CONTENT_SQL}
          AND NOT EXISTS (
            SELECT 1 FROM feed_item_translations t
            WHERE t.workspace_id = ci.workspace_id AND t.target_lang = 'zh' AND t.translated_text != ''
              AND (t.item_id = ci.id OR t.item_id = c.provider || ':' || c.external_id)
          )`).get(workspaceId);
      return Number(row?.n) || 0;
    },

    listTranslationChunks(workspaceId, itemId, targetLang = 'zh', sourceHash = '') {
      const lang = targetLang === 'en' ? 'en' : 'zh';
      const hash = String(sourceHash || '').trim();
      if (!workspaceId || !itemId || !hash) return [];
      return database.prepare(`SELECT chunk_index, chunk_count, chunk_hash, translated_text, engine
        FROM feed_translation_chunks
        WHERE workspace_id = ? AND item_id = ? AND target_lang = ? AND source_hash = ?
        ORDER BY chunk_index ASC`).all(workspaceId, itemId, lang, hash).map((row) => ({
        chunkIndex: row.chunk_index,
        chunkCount: row.chunk_count,
        chunkHash: row.chunk_hash,
        translatedText: row.translated_text,
        engine: row.engine || '',
      }));
    },

    saveTranslationChunk(value) {
      const workspaceId = String(value?.workspaceId || '').trim();
      const itemId = String(value?.itemId || '').trim();
      const targetLang = value?.targetLang === 'en' ? 'en' : 'zh';
      const sourceHash = String(value?.sourceHash || '').trim();
      const chunkHash = String(value?.chunkHash || '').trim();
      const translatedText = String(value?.translatedText || '');
      const chunkIndex = Number(value?.chunkIndex);
      const chunkCount = Number(value?.chunkCount);
      const engine = String(value?.engine || '').slice(0, 64);
      if (!workspaceId || !itemId || !sourceHash || !chunkHash || !translatedText.trim()) return null;
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || !Number.isInteger(chunkCount) || chunkCount <= chunkIndex) return null;
      const now = Date.now();
      database.prepare(`INSERT INTO feed_translation_chunks
        (workspace_id, item_id, target_lang, source_hash, chunk_index, chunk_count, chunk_hash, translated_text, engine, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, item_id, target_lang, source_hash, chunk_index) DO UPDATE SET
          chunk_count = excluded.chunk_count,
          chunk_hash = excluded.chunk_hash,
          translated_text = excluded.translated_text,
          engine = excluded.engine,
          updated_at = excluded.updated_at`).run(
        workspaceId, itemId, targetLang, sourceHash, chunkIndex, chunkCount, chunkHash, translatedText, engine, now,
      );
      return { chunkIndex, chunkCount, chunkHash, translatedText, engine };
    },

    deleteTranslationChunks(workspaceId, itemId, targetLang = 'zh') {
      const lang = targetLang === 'en' ? 'en' : 'zh';
      database.prepare(`DELETE FROM feed_translation_chunks
        WHERE workspace_id = ? AND item_id = ? AND target_lang = ?`).run(workspaceId, itemId, lang);
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
          const previousAttempts = Number(previous?.attempt_count) || 0;
          const incoming = Number.isInteger(attemptCount) ? attemptCount : previousAttempts + 1;
          const attempts = incoming === 1 && previousAttempts >= TRANSLATION_MAX_ATTEMPTS
            ? previousAttempts + 1
            : Math.max(incoming, previousAttempts);
          const done = terminal === true || attempts >= TRANSLATION_MAX_ATTEMPTS;
          const retryAt = done ? null : (Number.isInteger(nextRetryAt) ? nextRetryAt : now + translationRetryDelayMs(attempts));
          write.run(workspaceId, id, lang, hash, attempts, retryAt, message, now);
          rows.push({ itemId: id, attemptCount: attempts, nextRetryAt: retryAt, lastError: message });
        }
      })();
      return rows;
    },

    listEllipsisLeadBodies(workspaceId, { limit = 400 } = {}) {
      const cap = Math.max(1, Math.min(Number(limit) || 400, 400));
      const rows = database.prepare(`SELECT ci.id AS id, ci.body AS body, c.provider AS provider, c.external_id AS external_id
        FROM content_items ci
        JOIN captures c ON c.id = ci.capture_id AND c.workspace_id = ci.workspace_id
        WHERE ci.workspace_id = ?
          AND (instr(ci.body, '…') > 0 OR instr(ci.body, '...') > 0)
        ORDER BY ci.created_at DESC
        LIMIT ?`).all(workspaceId, cap);
      return rows.map((row) => ({
        id: row.id,
        body: row.body || '',
        provider: row.provider || '',
        externalId: row.external_id || '',
      }));
    },

    listEllipsisLeadTranslations(workspaceId, { limit = 400 } = {}) {
      const cap = Math.max(1, Math.min(Number(limit) || 400, 400));
      const rows = database.prepare(`SELECT item_id, target_lang, source_hash, translated_text, engine
        FROM feed_item_translations
        WHERE workspace_id = ?
          AND (instr(translated_text, '…') > 0 OR instr(translated_text, '...') > 0)
        ORDER BY updated_at DESC
        LIMIT ?`).all(workspaceId, cap);
      return rows.map((row) => ({
        itemId: row.item_id,
        targetLang: row.target_lang === 'en' ? 'en' : 'zh',
        sourceHash: row.source_hash || '',
        translatedText: row.translated_text || '',
        engine: row.engine || '',
      }));
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
