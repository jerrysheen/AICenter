function mapArticle(row) {
  if (!row) return null;
  return {
    videoId: row.video_id,
    durationSec: row.duration_sec == null ? null : Number(row.duration_sec),
    status: row.status || '',
    reason: row.reason || '',
    sourceTranscript: row.source_transcript || '',
    sourceHash: row.source_hash || '',
    articleStatus: row.article_status || '',
    articleState: row.article_state || '',
    articleBody: row.article_body || '',
    articleTitle: row.article_title || '',
    articleDay: row.article_day || '',
    manual: Number(row.manual) || 0,
    attempts: Number(row.attempts) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    tweetId: row.tweet_id || '',
    quotedTweetId: row.quoted_tweet_id || '',
    contentItemId: row.content_item_id || '',
    sourceUrl: row.source_url || '',
  };
}

function mapPost(row) {
  if (!row) return null;
  return {
    tweetId: row.tweet_id,
    videoId: row.video_id,
    contentItemId: row.content_item_id || '',
    quotedTweetId: row.quoted_tweet_id || '',
    sourceUrl: row.source_url || '',
    createdAt: Number(row.created_at) || 0,
  };
}

export function createXVideoRepository(database) {
  const articleSql = `SELECT a.*, p.tweet_id, p.quoted_tweet_id, p.content_item_id, p.source_url
    FROM x_video_articles a
    LEFT JOIN x_video_posts p ON p.workspace_id = a.workspace_id AND p.video_id = a.video_id
      AND p.tweet_id = (
        SELECT tweet_id FROM x_video_posts
        WHERE workspace_id = a.workspace_id AND video_id = a.video_id
        ORDER BY created_at ASC, tweet_id ASC LIMIT 1
      )`;

  return {
    article(workspaceId, videoId) {
      return mapArticle(database.prepare(`${articleSql}
        WHERE a.workspace_id = ? AND a.video_id = ?`).get(workspaceId, videoId));
    },

    post(workspaceId, tweetId) {
      return mapPost(database.prepare(`SELECT * FROM x_video_posts
        WHERE workspace_id = ? AND tweet_id = ?`).get(workspaceId, tweetId));
    },

    articleForTweet(workspaceId, tweetId) {
      const post = this.post(workspaceId, tweetId);
      if (!post) return null;
      const article = this.article(workspaceId, post.videoId);
      if (!article) return { ...post, status: '', articleStatus: '', articleState: '', articleBody: '', articleTitle: '', articleDay: '', manual: 0, attempts: 0, durationSec: null, reason: '', sourceTranscript: '', sourceHash: '' };
      return { ...article, tweetId: post.tweetId, quotedTweetId: post.quotedTweetId, contentItemId: post.contentItemId, sourceUrl: post.sourceUrl || article.sourceUrl };
    },

    saveArticle(input) {
      const now = Date.now();
      const current = database.prepare(`SELECT * FROM x_video_articles
        WHERE workspace_id = ? AND video_id = ?`).get(input.workspaceId, input.videoId);
      const createdAt = current ? Number(current.created_at) : now;
      const pick = (field, column, fallback = '') => (input[field] !== undefined ? input[field] : (current?.[column] ?? fallback));
      database.prepare(`INSERT INTO x_video_articles
        (workspace_id, video_id, duration_sec, status, reason, source_transcript, source_hash,
         article_status, article_state, article_body, article_title, article_day, manual, attempts,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, video_id) DO UPDATE SET
          duration_sec = excluded.duration_sec,
          status = excluded.status,
          reason = excluded.reason,
          source_transcript = excluded.source_transcript,
          source_hash = excluded.source_hash,
          article_status = excluded.article_status,
          article_state = excluded.article_state,
          article_body = excluded.article_body,
          article_title = excluded.article_title,
          article_day = excluded.article_day,
          manual = excluded.manual,
          attempts = excluded.attempts,
          updated_at = excluded.updated_at`).run(
        input.workspaceId,
        input.videoId,
        pick('durationSec', 'duration_sec', null),
        pick('status', 'status', 'probe') || 'probe',
        pick('reason', 'reason', '') || '',
        pick('sourceTranscript', 'source_transcript', '') || '',
        pick('sourceHash', 'source_hash', '') || '',
        pick('articleStatus', 'article_status', '') || '',
        pick('articleState', 'article_state', '') || '',
        pick('articleBody', 'article_body', '') || '',
        pick('articleTitle', 'article_title', '') || '',
        pick('articleDay', 'article_day', '') || '',
        Number(pick('manual', 'manual', 0)) || 0,
        Number(pick('attempts', 'attempts', 0)) || 0,
        createdAt,
        now,
      );
      return this.article(input.workspaceId, input.videoId);
    },

    saveEpisode(input) {
      return this.saveArticle(input);
    },

    savePost(input) {
      const now = Date.now();
      const current = this.post(input.workspaceId, input.tweetId);
      database.prepare(`INSERT INTO x_video_posts
        (workspace_id, tweet_id, video_id, content_item_id, quoted_tweet_id, source_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, tweet_id) DO UPDATE SET
          video_id = excluded.video_id,
          content_item_id = excluded.content_item_id,
          quoted_tweet_id = excluded.quoted_tweet_id,
          source_url = excluded.source_url,
          updated_at = excluded.updated_at`).run(
        input.workspaceId,
        input.tweetId,
        input.videoId,
        input.contentItemId !== undefined ? (input.contentItemId || '') : (current?.contentItemId || ''),
        input.quotedTweetId !== undefined ? (input.quotedTweetId || '') : (current?.quotedTweetId || ''),
        input.sourceUrl !== undefined ? (input.sourceUrl || '') : (current?.sourceUrl || ''),
        current?.createdAt || now,
        now,
      );
      return this.post(input.workspaceId, input.tweetId);
    },

    countArticleDay(workspaceId, day) {
      const row = database.prepare(`SELECT COUNT(*) AS n FROM x_video_articles
        WHERE workspace_id = ? AND article_day = ?`).get(workspaceId, day);
      return Number(row?.n) || 0;
    },

    listNewCaptures(workspaceId, limit = 8) {
      const size = Math.max(1, Math.min(Number(limit) || 8, 40));
      return database.prepare(`SELECT c.external_id AS tweetId, c.source_url AS sourceUrl,
          c.metadata_json AS metadataJson, c.published_at AS publishedAt, ci.id AS contentItemId
        FROM captures c
        LEFT JOIN content_items ci ON ci.workspace_id = c.workspace_id AND ci.capture_id = c.id
        LEFT JOIN x_video_posts p ON p.workspace_id = c.workspace_id AND p.tweet_id = c.external_id
        WHERE c.workspace_id = ? AND c.provider = 'x' AND p.tweet_id IS NULL
          AND json_extract(c.metadata_json, '$.xVideo.tweetId') IS NOT NULL
        ORDER BY c.captured_at DESC
        LIMIT ?`).all(workspaceId, size).map((row) => {
        let metadata = {};
        try { metadata = JSON.parse(row.metadataJson || '{}'); } catch { metadata = {}; }
        return {
          tweetId: String(row.tweetId || ''),
          sourceUrl: row.sourceUrl || '',
          publishedAt: row.publishedAt == null ? null : Number(row.publishedAt),
          contentItemId: row.contentItemId || '',
          xVideo: metadata.xVideo || null,
        };
      });
    },

    listByStatus(workspaceId, statuses, limit = 8) {
      const names = (Array.isArray(statuses) ? statuses : [statuses]).map((item) => String(item || '')).filter(Boolean);
      if (!names.length) return [];
      const size = Math.max(1, Math.min(Number(limit) || 8, 40));
      return database.prepare(`${articleSql}
        WHERE a.workspace_id = ? AND a.status IN (${names.map(() => '?').join(',')})
        ORDER BY a.created_at ASC
        LIMIT ?`).all(workspaceId, ...names, size).map((row) => mapArticle(row));
    },

    listTitleRetries(workspaceId, limit = 8) {
      const size = Math.max(1, Math.min(Number(limit) || 8, 40));
      return database.prepare(`${articleSql}
        WHERE a.workspace_id = ? AND a.status = 'ready'
          AND json_extract(a.article_state, '$.titleStatus') = 'pending'
        LIMIT ?`).all(workspaceId, size).map((row) => mapArticle(row));
    },

    listWork(workspaceId) {
      return database.prepare(`${articleSql}
        WHERE a.workspace_id = ? AND a.status IN ('pending', 'transcribing', 'organizing')
        ORDER BY a.manual DESC, COALESCE(a.updated_at, 0) ASC`).all(workspaceId).map((row) => mapArticle(row));
    },

    claim(workspaceId, videoId, fromStatuses, toStatus, day = '') {
      const from = (Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses]).filter(Boolean);
      if (!from.length) return false;
      const now = Date.now();
      const result = database.prepare(`UPDATE x_video_articles
        SET status = ?, updated_at = ?,
            article_day = CASE WHEN article_day = '' AND ? != '' THEN ? ELSE article_day END
        WHERE workspace_id = ? AND video_id = ? AND status IN (${from.map(() => '?').join(',')})`).run(
        toStatus,
        now,
        day,
        day,
        workspaceId,
        videoId,
        ...from,
      );
      return result.changes === 1;
    },

    releaseStale(workspaceId, beforeMs) {
      const result = database.prepare(`UPDATE x_video_articles
        SET status = 'pending', updated_at = ?
        WHERE workspace_id = ? AND status IN ('transcribing', 'organizing') AND updated_at < ?`).run(
        Date.now(),
        workspaceId,
        Number(beforeMs) || 0,
      );
      return result.changes;
    },

    rekey(workspaceId, fromVideoId, toVideoId, patch = {}) {
      if (!fromVideoId || !toVideoId || fromVideoId === toVideoId) {
        if (patch && Object.keys(patch).length) this.saveArticle({ workspaceId, videoId: toVideoId || fromVideoId, ...patch });
        return this.article(workspaceId, toVideoId || fromVideoId);
      }
      const target = database.prepare(`SELECT video_id FROM x_video_articles
        WHERE workspace_id = ? AND video_id = ?`).get(workspaceId, toVideoId);
      const apply = database.transaction(() => {
        if (target) {
          database.prepare(`UPDATE x_video_posts SET video_id = ?, updated_at = ?
            WHERE workspace_id = ? AND video_id = ?`).run(toVideoId, Date.now(), workspaceId, fromVideoId);
          const left = database.prepare(`SELECT COUNT(*) AS n FROM x_video_posts
            WHERE workspace_id = ? AND video_id = ?`).get(workspaceId, fromVideoId);
          if (!Number(left?.n)) {
            database.prepare(`DELETE FROM x_video_articles WHERE workspace_id = ? AND video_id = ?`).run(workspaceId, fromVideoId);
          }
        } else {
          database.prepare(`UPDATE x_video_articles SET video_id = ?, updated_at = ?
            WHERE workspace_id = ? AND video_id = ?`).run(toVideoId, Date.now(), workspaceId, fromVideoId);
          database.prepare(`UPDATE x_video_posts SET video_id = ?, updated_at = ?
            WHERE workspace_id = ? AND video_id = ?`).run(toVideoId, Date.now(), workspaceId, fromVideoId);
        }
      });
      apply();
      if (Object.keys(patch).length) this.saveArticle({ workspaceId, videoId: toVideoId, ...patch });
      return this.article(workspaceId, toVideoId);
    },

    postsForVideo(workspaceId, videoId) {
      return database.prepare(`SELECT * FROM x_video_posts
        WHERE workspace_id = ? AND video_id = ?
        ORDER BY created_at ASC`).all(workspaceId, videoId).map((row) => mapPost(row));
    },
  };
}
