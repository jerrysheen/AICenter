import { randomUUID } from 'node:crypto';
import {
  parseContract,
  SaveCaptureInputSchema,
  SaveContentItemInputSchema,
  SaveFeedItemTranslationInputSchema,
  UpsertSubscriptionInputSchema,
  UpsertSourceAccountInputSchema,
  PatchUserItemStateInputSchema,
} from '../../../contracts/src/index.js';

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

const VISIBLE_CONTENT_SQL = `NOT EXISTS (
  SELECT 1 FROM user_item_states uis
  WHERE uis.workspace_id = ci.workspace_id
    AND uis.content_item_id = ci.id
    AND uis.is_hidden = 1
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

export function createFeedRepository(database, emitEvent) {
  return Object.freeze({
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

    listDueSubscriptions(now = Date.now(), limit = 50) {
      return database.prepare(`SELECT * FROM subscriptions
        WHERE enabled = 1 AND (next_sync_at IS NULL OR next_sync_at <= ?)
        ORDER BY priority DESC, COALESCE(next_sync_at, 0) ASC LIMIT ?`)
        .all(now, Math.max(1, Math.min(Number(limit) || 50, 200))).map(mapSubscription);
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

    listContentItemsByProvider(workspaceId, provider, { limit = 200, sourceExternalId = '' } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
      const rows = sourceExternalId
        ? database.prepare(`SELECT ci.*, c.provider AS provider, c.external_id AS external_id,
            c.captured_at AS captured_at, c.metadata_json AS capture_metadata_json
            FROM content_items ci
            INNER JOIN captures c ON c.id = ci.capture_id
            INNER JOIN source_accounts sa ON sa.id = c.source_account_id
            WHERE ci.workspace_id = ? AND c.provider = ? AND sa.external_id = ?
              AND ${VISIBLE_CONTENT_SQL}
            ORDER BY c.captured_at DESC, ci.created_at DESC, ci.id DESC
            LIMIT ?`).all(workspaceId, provider, sourceExternalId, safeLimit)
        : database.prepare(`SELECT ci.*, c.provider AS provider, c.external_id AS external_id,
            c.captured_at AS captured_at, c.metadata_json AS capture_metadata_json
            FROM content_items ci
            INNER JOIN captures c ON c.id = ci.capture_id
            WHERE ci.workspace_id = ? AND c.provider = ?
              AND ${VISIBLE_CONTENT_SQL}
            ORDER BY c.captured_at DESC, ci.created_at DESC, ci.id DESC
            LIMIT ?`).all(workspaceId, provider, safeLimit);
      return rows.map((row) => ({
        ...mapContentItem(row),
        provider: row.provider,
        externalId: row.external_id,
        capturedAt: row.captured_at,
        captureMetadata: parseJson(row.capture_metadata_json),
      }));
    },

    getContentItem(workspaceId, id) {
      const row = database.prepare(`SELECT ci.*, c.provider, c.external_id, c.captured_at
        FROM content_items ci
        LEFT JOIN captures c ON c.id = ci.capture_id
        WHERE ci.workspace_id = ? AND ci.id = ?`).get(workspaceId, id);
      if (!row) return null;
      return {
        ...mapContentItem(row),
        provider: row.provider || '',
        externalId: row.external_id || '',
        capturedAt: row.captured_at || row.created_at,
      };
    },

    listContentItemsWithSource(workspaceId, { limit = 200, ids = [] } = {}) {
      const wanted = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
      const rows = wanted.length
        ? database.prepare(`SELECT ci.*, c.provider AS provider
            FROM content_items ci
            LEFT JOIN captures c ON c.id = ci.capture_id
            WHERE ci.workspace_id = ? AND ci.id IN (${wanted.map(() => '?').join(', ')})`).all(workspaceId, ...wanted)
        : database.prepare(`SELECT ci.*, c.provider AS provider
            FROM content_items ci
            LEFT JOIN captures c ON c.id = ci.capture_id
            WHERE ci.workspace_id = ? AND ${VISIBLE_CONTENT_SQL}
            ORDER BY ci.created_at DESC, ci.id DESC LIMIT ?`).all(workspaceId, safeLimit);
      return rows.map((row) => ({
        ...mapContentItem(row),
        provider: row.provider || '',
      }));
    },

    listContentItems(workspaceId, { limit = 50, before = null } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
      const rows = before === null
        ? database.prepare(`SELECT * FROM content_items ci WHERE ci.workspace_id = ?
            AND ${VISIBLE_CONTENT_SQL}
            ORDER BY ci.created_at DESC, ci.id DESC LIMIT ?`).all(workspaceId, safeLimit)
        : database.prepare(`SELECT * FROM content_items ci WHERE ci.workspace_id = ?
            AND ci.created_at < ?
            AND ${VISIBLE_CONTENT_SQL}
            ORDER BY ci.created_at DESC, ci.id DESC LIMIT ?`)
          .all(workspaceId, Number(before), safeLimit);
      return rows.map(mapContentItem);
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
  });
}
