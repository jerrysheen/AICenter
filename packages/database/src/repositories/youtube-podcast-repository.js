export function createYoutubePodcastRepository(database) {
  const done = new Set(['ready', 'skipped']);

  function mapEpisode(row, extra = {}) {
    if (!row) return null;
    return {
      videoId: row.video_id,
      creatorId: row.creator_id,
      channelKey: row.channel_key,
      title: row.title || '',
      durationSec: row.duration_sec == null ? null : Number(row.duration_sec),
      publishedAt: row.published_at == null ? null : Number(row.published_at),
      status: row.status,
      reason: row.reason || '',
      transcriptSource: row.transcript_source || '',
      contentItemId: row.content_item_id || '',
      attempts: Number(row.attempts) || 0,
      summary: extra.summary || '',
      body: extra.body || '',
      sourceUrl: extra.sourceUrl || '',
      displayTitle: extra.displayTitle || '',
      authorName: extra.authorName || '',
    };
  }

  return {
    listEpisodes(workspaceId) {
      return database.prepare(`SELECT * FROM youtube_podcast_episodes
        WHERE workspace_id = ?`).all(workspaceId).map((row) => mapEpisode(row));
    },

    listForDedup(workspaceId, creatorId) {
      return database.prepare(`SELECT * FROM youtube_podcast_episodes
        WHERE workspace_id = ? AND creator_id = ?
          AND (status = 'ready' OR (status = 'skipped' AND reason = 'duplicate-episode'))`)
        .all(workspaceId, creatorId)
        .map((row) => mapEpisode(row));
    },

    episode(workspaceId, videoId) {
      return mapEpisode(database.prepare(`SELECT * FROM youtube_podcast_episodes
        WHERE workspace_id = ? AND video_id = ?`).get(workspaceId, videoId));
    },

    isDone(workspaceId, videoId) {
      const row = database.prepare(`SELECT status FROM youtube_podcast_episodes
        WHERE workspace_id = ? AND video_id = ?`).get(workspaceId, videoId);
      return Boolean(row && done.has(row.status));
    },

    saveEpisode(input) {
      const now = Date.now();
      database.prepare(`INSERT INTO youtube_podcast_episodes
        (workspace_id, video_id, creator_id, channel_key, title, duration_sec, published_at,
         status, reason, transcript_source, content_item_id, attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, video_id) DO UPDATE SET
          creator_id = excluded.creator_id,
          channel_key = excluded.channel_key,
          title = excluded.title,
          duration_sec = excluded.duration_sec,
          published_at = excluded.published_at,
          status = excluded.status,
          reason = excluded.reason,
          transcript_source = excluded.transcript_source,
          content_item_id = excluded.content_item_id,
          attempts = excluded.attempts,
          updated_at = excluded.updated_at`).run(
        input.workspaceId,
        input.videoId,
        input.creatorId,
        input.channelKey,
        input.title || '',
        input.durationSec ?? null,
        input.publishedAt ?? null,
        input.status,
        input.reason || '',
        input.transcriptSource || '',
        input.contentItemId || '',
        Number(input.attempts) || 0,
        now,
        now,
      );
    },

    channel(workspaceId, channelKey) {
      const row = database.prepare(`SELECT channel_id, bootstrapped FROM youtube_podcast_channels
        WHERE workspace_id = ? AND channel_key = ?`).get(workspaceId, channelKey);
      return {
        channelId: row?.channel_id || '',
        bootstrapped: Boolean(row?.bootstrapped),
      };
    },

    saveChannel(workspaceId, channelKey, { channelId = '', bootstrapped = false } = {}) {
      const current = this.channel(workspaceId, channelKey);
      database.prepare(`INSERT INTO youtube_podcast_channels
        (workspace_id, channel_key, channel_id, bootstrapped, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, channel_key) DO UPDATE SET
          channel_id = excluded.channel_id,
          bootstrapped = excluded.bootstrapped,
          updated_at = excluded.updated_at`).run(
        workspaceId,
        channelKey,
        channelId || current.channelId,
        bootstrapped || current.bootstrapped ? 1 : 0,
        Date.now(),
      );
    },

    listReady(workspaceId, limit = 200) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
      const rows = database.prepare(`SELECT e.*, ci.summary AS summary, '' AS body,
          ci.title AS display_title, ci.source_url AS source_url, ci.author_name AS author_name
        FROM youtube_podcast_episodes e
        LEFT JOIN content_items ci ON ci.id = e.content_item_id AND ci.workspace_id = e.workspace_id
        WHERE e.workspace_id = ? AND e.status = 'ready'
        ORDER BY COALESCE(e.published_at, 0) DESC, e.video_id DESC
        LIMIT ?`).all(workspaceId, safeLimit);
      return rows.map((row) => mapEpisode(row, {
        summary: row.summary || '',
        body: row.body || '',
        displayTitle: row.display_title || '',
        sourceUrl: row.source_url || '',
        authorName: row.author_name || '',
      }));
    },

    getReady(workspaceId, videoId) {
      const row = database.prepare(`SELECT e.*, ci.summary AS summary, ci.body AS body,
          ci.title AS display_title, ci.source_url AS source_url, ci.author_name AS author_name
        FROM youtube_podcast_episodes e
        LEFT JOIN content_items ci ON ci.id = e.content_item_id AND ci.workspace_id = e.workspace_id
        WHERE e.workspace_id = ? AND e.video_id = ? AND e.status = 'ready'`).get(workspaceId, videoId);
      if (!row) return null;
      return mapEpisode(row, {
        summary: row.summary || '',
        body: row.body || '',
        displayTitle: row.display_title || '',
        sourceUrl: row.source_url || '',
        authorName: row.author_name || '',
      });
    },
  };
}
