import {
  AUTHOR_ACTIVITY_MIN,
  AUTHOR_ACTIVITY_WINDOW_MS,
  AUTHOR_LIST_PAGE_SIZE,
  authorPreviewText,
  authorCaptureFields,
  chinesePreview,
  preferNativeId,
  provisionalAuthorId,
} from '../../../domain/src/authors.js';

const cache = new Map();
const CACHE_MS = 30_000;

export function invalidateAuthorCache() {
  cache.clear();
}

export function readAuthorCache(key, now = Date.now()) {
  const hit = cache.get(key);
  if (!hit || now - hit.at >= CACHE_MS) return null;
  return hit.value;
}

export function writeAuthorCache(key, value, now = Date.now()) {
  cache.set(key, { at: now, value });
  if (cache.size > 200) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function parseAliases(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function sameAuthor(left, right) {
  const at = Number(left.at) || 0;
  const bt = Number(right.at) || 0;
  if (bt > at) return right;
  if (bt < at) return left;
  return String(right.id || '') > String(left.id || '') ? right : left;
}

function lookupTitle(database, workspaceId, contentItemId, externalKey, fallbackTitle) {
  const ids = [contentItemId, externalKey].filter(Boolean);
  for (const id of ids) {
    const row = database.prepare(`SELECT translated_text FROM feed_item_translations
      WHERE workspace_id = ? AND item_id = ? AND target_lang = 'zh'`).get(workspaceId, id);
    if (row?.translated_text) return authorPreviewText(row.translated_text);
  }
  return chinesePreview(fallbackTitle);
}

function bumpStats(database, row) {
  const recent = row.sortAt >= row.now - AUTHOR_ACTIVITY_WINDOW_MS ? 1 : 0;
  const unread = row.isRead ? 0 : 1;
  const existing = database.prepare(`SELECT latest_item_at, latest_item_id, latest_unread_at, latest_title_zh
    FROM author_stats WHERE workspace_id = ? AND author_id = ?`).get(row.workspaceId, row.authorId);
  if (!existing) {
    database.prepare(`INSERT INTO author_stats
      (workspace_id, author_id, platform, followed, unread_count, has_unread, total_count,
       latest_unread_at, latest_item_at, latest_item_id, latest_title_zh, recent_30d_count)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
      row.workspaceId, row.authorId, row.platform, row.followed ? 1 : 0, unread, unread ? 1 : 0,
      unread ? row.sortAt : 0, row.sortAt, row.contentItemId, row.title, recent,
    );
    return;
  }
  const latest = sameAuthor(
    { at: existing.latest_item_at, id: existing.latest_item_id },
    { at: row.sortAt, id: row.contentItemId },
  );
  const latestUnread = row.isRead
    ? existing.latest_unread_at
    : Math.max(Number(existing.latest_unread_at) || 0, row.sortAt);
  const title = latest.id === row.contentItemId ? row.title : existing.latest_title_zh;
  database.prepare(`UPDATE author_stats SET
      platform = ?,
      unread_count = unread_count + ?,
      has_unread = CASE WHEN unread_count + ? > 0 THEN 1 ELSE 0 END,
      total_count = total_count + 1,
      latest_unread_at = ?,
      latest_item_at = ?,
      latest_item_id = ?,
      latest_title_zh = ?,
      recent_30d_count = recent_30d_count + ?
    WHERE workspace_id = ? AND author_id = ?`).run(
    row.platform, unread, unread, latestUnread, latest.at, latest.id, title, recent,
    row.workspaceId, row.authorId,
  );
}

function foldStats(database, workspaceId, realId, provisionalId) {
  const from = database.prepare(`SELECT * FROM author_stats WHERE workspace_id = ? AND author_id = ?`)
    .get(workspaceId, provisionalId);
  if (!from || !from.total_count) return from;
  const real = database.prepare(`SELECT * FROM author_stats WHERE workspace_id = ? AND author_id = ?`)
    .get(workspaceId, realId);
  const latest = sameAuthor(
    { at: real?.latest_item_at || 0, id: real?.latest_item_id || '' },
    { at: from.latest_item_at || 0, id: from.latest_item_id || '' },
  );
  const latestTitle = latest.id === from.latest_item_id && from.latest_title_zh
    ? from.latest_title_zh
    : (real?.latest_title_zh || from.latest_title_zh || '');
  const unread = (real?.unread_count || 0) + (from.unread_count || 0);
  const recent = (real?.recent_30d_count || 0) + (from.recent_30d_count || 0);
  const total = (real?.total_count || 0) + (from.total_count || 0);
  const latestUnread = Math.max(Number(real?.latest_unread_at) || 0, Number(from.latest_unread_at) || 0);
  const followed = real?.followed || from.followed ? 1 : 0;
  if (!real) {
    database.prepare(`INSERT INTO author_stats
      (workspace_id, author_id, platform, followed, unread_count, has_unread, total_count,
       latest_unread_at, latest_item_at, latest_item_id, latest_title_zh, recent_30d_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      workspaceId, realId, from.platform, followed, unread, unread > 0 ? 1 : 0, total,
      unread > 0 ? latestUnread : 0, latest.at, latest.id, latestTitle, recent,
    );
  } else {
    database.prepare(`UPDATE author_stats SET
        followed = ?, unread_count = ?, has_unread = ?, total_count = ?,
        latest_unread_at = ?, latest_item_at = ?, latest_item_id = ?, latest_title_zh = ?,
        recent_30d_count = ?
      WHERE workspace_id = ? AND author_id = ?`).run(
      followed, unread, unread > 0 ? 1 : 0, total, unread > 0 ? latestUnread : 0,
      latest.at, latest.id, latestTitle, recent, workspaceId, realId,
    );
  }
  database.prepare(`UPDATE author_stats SET
      unread_count = 0, has_unread = 0, total_count = 0, latest_unread_at = 0,
      latest_item_at = 0, latest_item_id = '', latest_title_zh = '', recent_30d_count = 0
    WHERE workspace_id = ? AND author_id = ?`).run(workspaceId, provisionalId);
  return from;
}

function mergeProvisional(database, workspaceId, profile) {
  if (profile.provisional || profile.kind === 'system') return null;
  const provisionalId = provisionalAuthorId(profile.platform, profile.handle, profile.name);
  if (!provisionalId || provisionalId === profile.authorId) return null;
  const row = database.prepare(`SELECT * FROM authors
    WHERE workspace_id = ? AND author_id = ? AND provisional = 1
      AND (merged_into IS NULL OR merged_into = '')`).get(workspaceId, provisionalId);
  if (!row) return null;
  database.prepare(`UPDATE item_authors SET author_id = ?
    WHERE workspace_id = ? AND author_id = ?`).run(profile.authorId, workspaceId, provisionalId);
  const from = foldStats(database, workspaceId, profile.authorId, provisionalId);
  const aliases = [...new Set([
    ...parseAliases(row.aliases_json),
    row.handle,
    profile.handle,
  ].filter(Boolean))];
  database.prepare(`UPDATE authors SET merged_into = ? WHERE workspace_id = ? AND author_id = ?`)
    .run(profile.authorId, workspaceId, provisionalId);
  if (row.followed) {
    database.prepare(`UPDATE authors SET followed = 1, followed_at = COALESCE(followed_at, ?)
      WHERE workspace_id = ? AND author_id = ? AND followed = 0`)
      .run(row.followed_at || Date.now(), workspaceId, profile.authorId);
    database.prepare(`UPDATE author_stats SET followed = 1 WHERE workspace_id = ? AND author_id = ?`)
      .run(workspaceId, profile.authorId);
  }
  return { aliases, from };
}

function upsertAuthor(database, workspaceId, profile, extraAliases = []) {
  const existing = database.prepare(`SELECT * FROM authors WHERE workspace_id = ? AND author_id = ?`)
    .get(workspaceId, profile.authorId);
  const aliases = [...new Set([
    ...parseAliases(existing?.aliases_json),
    ...extraAliases,
    existing && existing.handle && profile.handle && existing.handle !== profile.handle ? existing.handle : '',
  ].filter(Boolean))].slice(-20);
  const now = Date.now();
  database.prepare(`INSERT INTO authors
      (workspace_id, author_id, platform, native_id, handle, name, avatar_url, profile_url, bio,
       followers, kind, provisional, merged_into, aliases_json, followed, followed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL)
    ON CONFLICT(workspace_id, author_id) DO UPDATE SET
      handle = CASE WHEN excluded.handle != '' THEN excluded.handle ELSE authors.handle END,
      name = CASE WHEN excluded.name != '' THEN excluded.name ELSE authors.name END,
      avatar_url = CASE WHEN excluded.avatar_url != '' THEN excluded.avatar_url ELSE authors.avatar_url END,
      profile_url = CASE WHEN excluded.profile_url != '' THEN excluded.profile_url ELSE authors.profile_url END,
      bio = CASE WHEN excluded.bio != '' THEN excluded.bio ELSE authors.bio END,
      followers = COALESCE(excluded.followers, authors.followers),
      kind = excluded.kind,
      provisional = excluded.provisional,
      aliases_json = excluded.aliases_json`).run(
    workspaceId, profile.authorId, profile.platform, profile.nativeId, profile.handle, profile.name || profile.handle,
    profile.avatarUrl, profile.profileUrl, profile.bio, profile.followers, profile.kind,
    profile.provisional ? 1 : 0, JSON.stringify(aliases),
  );
  return database.prepare(`SELECT * FROM authors WHERE workspace_id = ? AND author_id = ?`)
    .get(workspaceId, profile.authorId) || { followed: 0, followed_at: now };
}

export function linkAuthorItem(database, input) {
  const profile = input;
  if (!profile?.authorId || !input.contentItemId) return null;
  const merged = mergeProvisional(database, input.workspaceId, profile);
  const author = upsertAuthor(database, input.workspaceId, profile, merged?.aliases || []);
  const state = database.prepare(`SELECT is_read FROM user_item_states
    WHERE workspace_id = ? AND content_item_id = ?`).get(input.workspaceId, input.contentItemId);
  const isRead = state?.is_read ? 1 : 0;
  const sortAt = Number(input.sortAt) || Date.now();
  const title = lookupTitle(
    database,
    input.workspaceId,
    input.contentItemId,
    input.externalId ? `${profile.platform}:${input.externalId}` : '',
    input.title,
  );
  const inserted = database.prepare(`INSERT OR IGNORE INTO item_authors
    (workspace_id, content_item_id, author_id, sort_at, is_read)
    VALUES (?, ?, ?, ?, ?)`).run(input.workspaceId, input.contentItemId, profile.authorId, sortAt, isRead);
  if (inserted.changes) {
    bumpStats(database, {
      workspaceId: input.workspaceId,
      authorId: profile.authorId,
      platform: profile.platform,
      contentItemId: input.contentItemId,
      sortAt,
      isRead,
      title,
      followed: author.followed,
      now: Date.now(),
    });
    invalidateAuthorCache();
    return { authorId: profile.authorId, inserted: true };
  }
  const current = database.prepare(`SELECT author_id, is_read, sort_at FROM item_authors
    WHERE workspace_id = ? AND content_item_id = ?`).get(input.workspaceId, input.contentItemId);
  if (current && current.author_id !== profile.authorId) {
    database.prepare(`UPDATE item_authors SET author_id = ? WHERE workspace_id = ? AND content_item_id = ?`)
      .run(profile.authorId, input.workspaceId, input.contentItemId);
    if (!current.is_read) {
      database.prepare(`UPDATE author_stats SET unread_count = MAX(0, unread_count - 1)
        WHERE workspace_id = ? AND author_id = ?`).run(input.workspaceId, current.author_id);
      database.prepare(`UPDATE author_stats SET unread_count = unread_count + 1, has_unread = 1,
          latest_unread_at = MAX(latest_unread_at, ?)
        WHERE workspace_id = ? AND author_id = ?`).run(current.sort_at, input.workspaceId, profile.authorId);
    }
    invalidateAuthorCache();
  }
  return { authorId: profile.authorId, inserted: false };
}

export function recordCapturedAuthor(database, input) {
  if (!input?.captureId || !input.contentItemId) return null;
  const capture = database.prepare(`SELECT provider, external_id, author_native_id, author_handle, metadata_json,
      published_at, captured_at
    FROM captures WHERE id = ?`).get(input.captureId);
  if (!capture || !['x', 'xueqiu', 'bilibili'].includes(capture.provider)) return null;
  let metadata = {};
  try { metadata = JSON.parse(capture.metadata_json || '{}') || {}; } catch { metadata = {}; }
  const fields = authorCaptureFields(capture.provider, {
    ...(metadata.authorProfile || {}),
    authorNativeId: capture.author_native_id || metadata.authorProfile?.nativeId || '',
    authorHandle: metadata.authorProfile?.handle || capture.author_handle || '',
    authorName: metadata.authorProfile?.name || input.authorName || '',
  });
  if (!fields) return null;
  return linkAuthorItem(database, {
    ...fields.authorProfile,
    workspaceId: input.workspaceId,
    contentItemId: input.contentItemId,
    externalId: capture.external_id,
    sortAt: Number(input.publishedAt) || Number(capture.published_at) || Number(capture.captured_at) || input.createdAt || Date.now(),
    title: input.title || '',
  });
}

export function noteCaptureAuthor(database, input) {
  const row = database.prepare(`SELECT c.id, c.provider, c.author_native_id, c.metadata_json, ci.id AS content_item_id
    FROM captures c
    LEFT JOIN content_items ci ON ci.capture_id = c.id AND ci.workspace_id = c.workspace_id
    WHERE c.workspace_id = ? AND c.provider = ? AND c.external_id = ?`)
    .get(input.workspaceId, input.provider, input.externalId);
  if (!row) return null;
  const nextNative = preferNativeId(row.author_native_id, input.authorNativeId);
  const linked = row.content_item_id
    ? database.prepare(`SELECT author_id FROM item_authors WHERE workspace_id = ? AND content_item_id = ?`)
      .get(input.workspaceId, row.content_item_id)
    : null;
  const sameNative = (row.author_native_id || '') === (nextNative || '') && Boolean(row.author_native_id);
  const nextHandle = String(input.authorProfile?.handle || '').trim();
  if (sameNative && linked) {
    const current = database.prepare(`SELECT handle FROM authors WHERE workspace_id = ? AND author_id = ?`)
      .get(input.workspaceId, linked.author_id);
    if (!nextHandle || current?.handle === nextHandle) return { unchanged: true, authorId: linked.author_id };
  }
  let metadata = {};
  try { metadata = JSON.parse(row.metadata_json || '{}') || {}; } catch { metadata = {}; }
  if (input.authorProfile) metadata.authorProfile = input.authorProfile;
  database.prepare(`UPDATE captures SET author_native_id = ?, metadata_json = ? WHERE id = ?`)
    .run(nextNative || null, JSON.stringify(metadata), row.id);
  if (!row.content_item_id) return { linked: false };
  return recordCapturedAuthor(database, {
    workspaceId: input.workspaceId,
    captureId: row.id,
    contentItemId: row.content_item_id,
    authorName: input.authorProfile?.name || '',
    title: input.title || '',
    publishedAt: input.publishedAt || null,
  });
}

export function syncAuthorRead(database, workspaceId, contentItemId, isRead) {
  const link = database.prepare(`SELECT author_id, sort_at, is_read FROM item_authors
    WHERE workspace_id = ? AND content_item_id = ?`).get(workspaceId, contentItemId);
  if (!link) return;
  const next = isRead ? 1 : 0;
  if (link.is_read === next) return;
  database.prepare(`UPDATE item_authors SET is_read = ? WHERE workspace_id = ? AND content_item_id = ?`)
    .run(next, workspaceId, contentItemId);
  if (!next) {
    database.prepare(`UPDATE author_stats SET
        unread_count = unread_count + 1,
        has_unread = 1,
        latest_unread_at = MAX(latest_unread_at, ?)
      WHERE workspace_id = ? AND author_id = ?`).run(link.sort_at, workspaceId, link.author_id);
  } else {
    database.prepare(`UPDATE author_stats SET unread_count = MAX(0, unread_count - 1)
      WHERE workspace_id = ? AND author_id = ?`).run(workspaceId, link.author_id);
    const top = database.prepare(`SELECT sort_at AS sortAt FROM item_authors
      WHERE workspace_id = ? AND author_id = ? AND is_read = 0
      ORDER BY sort_at DESC, content_item_id DESC LIMIT 1`).get(workspaceId, link.author_id);
    database.prepare(`UPDATE author_stats SET has_unread = ?, latest_unread_at = ?,
        unread_count = CASE WHEN ? = 0 THEN 0 ELSE unread_count END
      WHERE workspace_id = ? AND author_id = ?`).run(
      top ? 1 : 0, top?.sortAt || 0, top ? 1 : 0, workspaceId, link.author_id,
    );
  }
  invalidateAuthorCache();
}

export function noteAuthorTranslation(database, workspaceId, itemId, text) {
  const preview = authorPreviewText(text);
  if (!preview) return false;
  let contentItemId = '';
  const direct = database.prepare(`SELECT content_item_id FROM item_authors
    WHERE workspace_id = ? AND content_item_id = ?`).get(workspaceId, itemId);
  if (direct) contentItemId = itemId;
  else {
    const split = String(itemId || '').indexOf(':');
    if (split > 0) {
      const row = database.prepare(`SELECT ci.id AS id FROM captures c
        JOIN content_items ci ON ci.capture_id = c.id AND ci.workspace_id = c.workspace_id
        WHERE c.workspace_id = ? AND c.provider = ? AND c.external_id = ?`)
        .get(workspaceId, itemId.slice(0, split), itemId.slice(split + 1));
      contentItemId = row?.id || '';
    }
  }
  if (!contentItemId) return false;
  const result = database.prepare(`UPDATE author_stats SET latest_title_zh = ?
    WHERE workspace_id = ? AND latest_item_id = ?`).run(preview, workspaceId, contentItemId);
  if (result.changes) invalidateAuthorCache();
  return result.changes > 0;
}

export function seekLatestUnread(database, workspaceId, authorId) {
  return database.prepare(`SELECT sort_at AS sortAt FROM item_authors
    WHERE workspace_id = ? AND author_id = ? AND is_read = 0
    ORDER BY sort_at DESC, content_item_id DESC LIMIT 1`).get(workspaceId, authorId) || null;
}

function mapAuthor(row) {
  return {
    authorId: row.author_id,
    platform: row.platform,
    nativeId: row.native_id,
    handle: row.handle || '',
    name: row.name || row.handle || '',
    avatarUrl: row.avatar_url || '',
    profileUrl: row.profile_url || '',
    bio: row.bio || '',
    followers: row.followers == null ? null : Number(row.followers),
    kind: row.kind || 'person',
    provisional: Boolean(row.provisional),
    mergedInto: row.merged_into || '',
    aliases: parseAliases(row.aliases_json),
    followed: Boolean(row.followed),
    followedAt: row.followed_at ?? null,
    unreadCount: Number(row.unread_count) || 0,
    hasUnread: Boolean(row.has_unread),
    totalCount: Number(row.total_count) || 0,
    latestUnreadAt: Number(row.latest_unread_at) || 0,
    latestItemAt: Number(row.latest_item_at) || 0,
    latestItemId: row.latest_item_id || '',
    latestTitleZh: row.latest_title_zh || '',
    recent30dCount: Number(row.recent_30d_count) || 0,
  };
}

const AUTHOR_SELECT = `s.workspace_id, s.author_id, s.platform, s.followed, s.unread_count, s.has_unread,
  s.total_count, s.latest_unread_at, s.latest_item_at, s.latest_item_id, s.latest_title_zh, s.recent_30d_count,
  a.native_id, a.handle, a.name, a.avatar_url, a.profile_url, a.bio, a.followers, a.kind, a.provisional,
  a.merged_into, a.aliases_json, a.followed_at`;

const AUTHOR_FROM = `author_stats s
  JOIN authors a ON a.workspace_id = s.workspace_id AND a.author_id = s.author_id`;

const VISIBLE_AUTHOR = `a.kind != 'system' AND (a.merged_into IS NULL OR a.merged_into = '')`;

function platformClause(platform) {
  if (!platform || platform === 'all') return { sql: '', params: [] };
  return { sql: ' AND s.platform = ?', params: [platform] };
}

export function createAuthorRepository(database) {
  return Object.freeze({
    listAuthors({ workspaceId, platform = 'all', cursor = null, limit = AUTHOR_LIST_PAGE_SIZE } = {}) {
      const page = Math.max(1, Math.min(Number(limit) || AUTHOR_LIST_PAGE_SIZE, AUTHOR_LIST_PAGE_SIZE));
      const filter = platformClause(platform);
      const order = `s.has_unread DESC, s.latest_unread_at DESC, s.latest_item_at DESC, s.author_id DESC`;
      const followed = cursor ? [] : database.prepare(`SELECT ${AUTHOR_SELECT} FROM ${AUTHOR_FROM}
        WHERE s.workspace_id = ? AND ${VISIBLE_AUTHOR} AND s.followed = 1 ${filter.sql}
        ORDER BY ${order}`).all(workspaceId, ...filter.params).map(mapAuthor);
      const params = [workspaceId, AUTHOR_ACTIVITY_MIN, ...filter.params];
      let cursorSql = '';
      if (cursor) {
        cursorSql = ` AND (
          s.has_unread < ? OR
          (s.has_unread = ? AND s.latest_unread_at < ?) OR
          (s.has_unread = ? AND s.latest_unread_at = ? AND s.latest_item_at < ?) OR
          (s.has_unread = ? AND s.latest_unread_at = ? AND s.latest_item_at = ? AND s.author_id < ?)
        )`;
        params.push(
          cursor.hasUnread, cursor.hasUnread, cursor.latestUnreadAt,
          cursor.hasUnread, cursor.latestUnreadAt, cursor.latestItemAt,
          cursor.hasUnread, cursor.latestUnreadAt, cursor.latestItemAt, cursor.authorId,
        );
      }
      const others = database.prepare(`SELECT ${AUTHOR_SELECT} FROM ${AUTHOR_FROM}
        WHERE s.workspace_id = ? AND ${VISIBLE_AUTHOR} AND s.followed = 0 AND s.recent_30d_count >= ?
          ${filter.sql} ${cursorSql}
        ORDER BY ${order}
        LIMIT ?`).all(...params, page + 1).map(mapAuthor);
      const hasMore = others.length > page;
      return { followed, others: others.slice(0, page), hasMore };
    },

    countAuthors(workspaceId) {
      const rows = database.prepare(`SELECT s.platform AS platform, COUNT(*) AS count
        FROM ${AUTHOR_FROM}
        WHERE s.workspace_id = ? AND ${VISIBLE_AUTHOR}
          AND (s.followed = 1 OR s.recent_30d_count >= ?)
        GROUP BY s.platform`).all(workspaceId, AUTHOR_ACTIVITY_MIN);
      const counts = { all: 0, x: 0, xueqiu: 0, bilibili: 0 };
      for (const row of rows) {
        const count = Number(row.count) || 0;
        if (Object.hasOwn(counts, row.platform)) counts[row.platform] = count;
        counts.all += count;
      }
      return counts;
    },

    getAuthor(workspaceId, authorId) {
      let row = database.prepare(`SELECT ${AUTHOR_SELECT} FROM ${AUTHOR_FROM}
        WHERE s.workspace_id = ? AND s.author_id = ?`).get(workspaceId, authorId);
      if (!row) {
        const author = database.prepare(`SELECT * FROM authors WHERE workspace_id = ? AND author_id = ?`)
          .get(workspaceId, authorId);
        if (!author) return null;
        if (author.merged_into) return this.getAuthor(workspaceId, author.merged_into);
        return mapAuthor({ ...author, unread_count: 0, has_unread: 0, total_count: 0, latest_unread_at: 0,
          latest_item_at: 0, latest_item_id: '', latest_title_zh: '', recent_30d_count: 0, followed: author.followed });
      }
      if (row.merged_into) return this.getAuthor(workspaceId, row.merged_into);
      return mapAuthor(row);
    },

    setFollow(workspaceId, authorId, followed) {
      const author = database.prepare(`SELECT author_id, kind, merged_into FROM authors
        WHERE workspace_id = ? AND author_id = ?`).get(workspaceId, authorId);
      if (!author || author.kind === 'system') return null;
      const target = author.merged_into || author.author_id;
      const now = Date.now();
      database.prepare(`UPDATE authors SET followed = ?, followed_at = ?
        WHERE workspace_id = ? AND author_id = ?`).run(followed ? 1 : 0, followed ? now : null, workspaceId, target);
      database.prepare(`UPDATE author_stats SET followed = ? WHERE workspace_id = ? AND author_id = ?`)
        .run(followed ? 1 : 0, workspaceId, target);
      invalidateAuthorCache();
      return this.getAuthor(workspaceId, target);
    },

    authorReadCap(workspaceId, authorId) {
      const author = database.prepare(`SELECT author_id, merged_into, kind FROM authors
        WHERE workspace_id = ? AND author_id = ?`).get(workspaceId, authorId);
      if (!author || author.kind === 'system') return null;
      const target = author.merged_into || author.author_id;
      const stats = database.prepare(`SELECT latest_item_at FROM author_stats
        WHERE workspace_id = ? AND author_id = ?`).get(workspaceId, target);
      if (stats) return { authorId: target, capAt: Number(stats.latest_item_at) || 0 };
      const max = database.prepare(`SELECT MAX(sort_at) AS cap FROM item_authors
        WHERE workspace_id = ? AND author_id = ?`).get(workspaceId, target);
      return { authorId: target, capAt: Number(max?.cap) || 0 };
    },

    markAuthorReadBatch(workspaceId, authorId, capAt, limit = 500) {
      const rows = database.prepare(`SELECT content_item_id FROM item_authors
        WHERE workspace_id = ? AND author_id = ? AND is_read = 0 AND sort_at <= ?
        ORDER BY sort_at DESC, content_item_id DESC
        LIMIT ?`).all(workspaceId, authorId, capAt, limit);
      if (!rows.length) return { changed: 0, done: true };
      const ids = rows.map((row) => row.content_item_id);
      const marks = ids.map(() => '?').join(',');
      const now = Date.now();
      database.transaction(() => {
        database.prepare(`UPDATE item_authors SET is_read = 1
          WHERE workspace_id = ? AND author_id = ? AND content_item_id IN (${marks})`)
          .run(workspaceId, authorId, ...ids);
        const upsert = database.prepare(`INSERT INTO user_item_states
          (workspace_id, content_item_id, is_read, is_saved, is_hidden, updated_at)
          VALUES (?, ?, 1, 0, 0, ?)
          ON CONFLICT(workspace_id, content_item_id) DO UPDATE SET
            is_read = 1, updated_at = excluded.updated_at`);
        for (const id of ids) upsert.run(workspaceId, id, now);
        database.prepare(`UPDATE author_stats SET unread_count = MAX(0, unread_count - ?)
          WHERE workspace_id = ? AND author_id = ?`).run(ids.length, workspaceId, authorId);
      })();
      invalidateAuthorCache();
      return { changed: ids.length, done: ids.length < limit };
    },

    finishAuthorUnread(workspaceId, authorId) {
      const top = seekLatestUnread(database, workspaceId, authorId);
      database.prepare(`UPDATE author_stats SET
          has_unread = ?, latest_unread_at = ?,
          unread_count = CASE WHEN ? = 0 THEN 0 ELSE unread_count END
        WHERE workspace_id = ? AND author_id = ?`).run(
        top ? 1 : 0, top?.sortAt || 0, top ? 1 : 0, workspaceId, authorId,
      );
      invalidateAuthorCache();
    },

    listAuthorItemIds(workspaceId, authorId, { readFlag = 0, before = null, limit = 30 } = {}) {
      const page = Math.max(1, Math.min(Number(limit) || 30, 50));
      const params = [workspaceId, authorId, readFlag ? 1 : 0];
      let cursorSql = '';
      if (before) {
        cursorSql = ' AND (sort_at < ? OR (sort_at = ? AND content_item_id < ?))';
        params.push(before.at, before.at, before.id);
      }
      const rows = database.prepare(`SELECT content_item_id AS id, sort_at AS sortAt
        FROM item_authors
        WHERE workspace_id = ? AND author_id = ? AND is_read = ? ${cursorSql}
        ORDER BY sort_at DESC, content_item_id DESC
        LIMIT ?`).all(...params, page + 1);
      return { rows: rows.slice(0, page), hasMore: rows.length > page };
    },

    recomputeAuthor(workspaceId, authorId, now = Date.now()) {
      const author = database.prepare(`SELECT * FROM authors WHERE workspace_id = ? AND author_id = ?`)
        .get(workspaceId, authorId);
      if (!author || author.merged_into) return false;
      const since = now - AUTHOR_ACTIVITY_WINDOW_MS;
      const totals = database.prepare(`SELECT
          SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread_count,
          COUNT(*) AS total_count,
          SUM(CASE WHEN sort_at >= ? THEN 1 ELSE 0 END) AS recent_30d_count
        FROM item_authors WHERE workspace_id = ? AND author_id = ?`).get(since, workspaceId, authorId);
      const latest = database.prepare(`SELECT content_item_id, sort_at FROM item_authors
        WHERE workspace_id = ? AND author_id = ?
        ORDER BY sort_at DESC, content_item_id DESC LIMIT 1`).get(workspaceId, authorId);
      const unread = seekLatestUnread(database, workspaceId, authorId);
      const external = latest
        ? database.prepare(`SELECT c.provider, c.external_id, ci.title FROM content_items ci
            LEFT JOIN captures c ON c.id = ci.capture_id
            WHERE ci.workspace_id = ? AND ci.id = ?`).get(workspaceId, latest.content_item_id)
        : null;
      const title = latest
        ? lookupTitle(
          database, workspaceId, latest.content_item_id,
          external?.provider && external?.external_id ? `${external.provider}:${external.external_id}` : '',
          external?.title || '',
        )
        : '';
      const unreadCount = Number(totals?.unread_count) || 0;
      database.prepare(`INSERT INTO author_stats
          (workspace_id, author_id, platform, followed, unread_count, has_unread, total_count,
           latest_unread_at, latest_item_at, latest_item_id, latest_title_zh, recent_30d_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, author_id) DO UPDATE SET
          platform = excluded.platform,
          followed = excluded.followed,
          unread_count = excluded.unread_count,
          has_unread = excluded.has_unread,
          total_count = excluded.total_count,
          latest_unread_at = excluded.latest_unread_at,
          latest_item_at = excluded.latest_item_at,
          latest_item_id = excluded.latest_item_id,
          latest_title_zh = excluded.latest_title_zh,
          recent_30d_count = excluded.recent_30d_count`).run(
        workspaceId, authorId, author.platform, author.followed ? 1 : 0, unreadCount, unreadCount > 0 ? 1 : 0,
        Number(totals?.total_count) || 0, unread?.sortAt || 0, latest?.sort_at || 0, latest?.content_item_id || '',
        title, Number(totals?.recent_30d_count) || 0,
      );
      return true;
    },

    listAuthorIds(workspaceId, after = '', limit = 500) {
      return database.prepare(`SELECT author_id AS authorId FROM authors
        WHERE workspace_id = ? AND (merged_into IS NULL OR merged_into = '') AND author_id > ?
        ORDER BY author_id LIMIT ?`).all(workspaceId, after, limit).map((row) => row.authorId);
    },
  });
}
