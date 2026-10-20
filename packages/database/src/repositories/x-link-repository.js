function mapRow(row) {
  if (!row) return null;
  return {
    tweetId: row.tweet_id,
    contentItemId: row.content_item_id || '',
    authorHandle: row.author_handle || '',
    authorName: row.author_name || '',
    sourceUrl: row.source_url || '',
    finalUrl: row.final_url || '',
    publisher: row.publisher || '',
    linkLabel: row.link_label || '',
    status: row.status || '',
    reason: row.reason || '',
    title: row.title || '',
    bodyZh: row.body_zh || '',
    articleDay: row.article_day || '',
    attempts: Number(row.attempts) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export function createXLinkRepository(database) {
  return {
    get(workspaceId, tweetId) {
      return mapRow(database.prepare(`SELECT * FROM x_link_articles
        WHERE workspace_id = ? AND tweet_id = ?`).get(workspaceId, tweetId));
    },

    findReadyByFinalUrl(workspaceId, finalUrl) {
      const url = String(finalUrl || '').trim();
      if (!url) return null;
      return mapRow(database.prepare(`SELECT * FROM x_link_articles
        WHERE workspace_id = ? AND final_url = ? AND status = 'ready'
        ORDER BY updated_at ASC LIMIT 1`).get(workspaceId, url));
    },

    countReadyOnDay(workspaceId, articleDay) {
      const row = database.prepare(`SELECT COUNT(*) AS n FROM x_link_articles
        WHERE workspace_id = ? AND status = 'ready' AND article_day = ?`).get(workspaceId, articleDay);
      return Number(row?.n) || 0;
    },

    save(input) {
      const now = Date.now();
      const current = database.prepare(`SELECT * FROM x_link_articles
        WHERE workspace_id = ? AND tweet_id = ?`).get(input.workspaceId, input.tweetId);
      const createdAt = current ? Number(current.created_at) : now;
      const pick = (field, column, fallback = '') => (
        input[field] !== undefined ? input[field] : (current?.[column] ?? fallback)
      );
      database.prepare(`INSERT INTO x_link_articles
        (workspace_id, tweet_id, content_item_id, author_handle, author_name, source_url,
         final_url, publisher, link_label, status, reason, title, body_zh, article_day,
         attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, tweet_id) DO UPDATE SET
          content_item_id = excluded.content_item_id,
          author_handle = excluded.author_handle,
          author_name = excluded.author_name,
          source_url = excluded.source_url,
          final_url = excluded.final_url,
          publisher = excluded.publisher,
          link_label = excluded.link_label,
          status = excluded.status,
          reason = excluded.reason,
          title = excluded.title,
          body_zh = excluded.body_zh,
          article_day = excluded.article_day,
          attempts = excluded.attempts,
          updated_at = excluded.updated_at`).run(
        input.workspaceId,
        input.tweetId,
        pick('contentItemId', 'content_item_id'),
        pick('authorHandle', 'author_handle'),
        pick('authorName', 'author_name'),
        pick('sourceUrl', 'source_url'),
        pick('finalUrl', 'final_url'),
        pick('publisher', 'publisher'),
        pick('linkLabel', 'link_label'),
        pick('status', 'status', 'pending'),
        pick('reason', 'reason'),
        pick('title', 'title'),
        pick('bodyZh', 'body_zh'),
        pick('articleDay', 'article_day'),
        input.attempts !== undefined ? input.attempts : (Number(current?.attempts) || 0),
        createdAt,
        now,
      );
      return this.get(input.workspaceId, input.tweetId);
    },
  };
}
