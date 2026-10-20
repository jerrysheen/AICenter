const ARTICLE_PROGRESS_COLUMNS = `
          CASE WHEN json_valid(e.article_state) THEN json_extract(e.article_state, '$.holdReason') ELSE '' END AS hold_reason,
          CASE WHEN json_valid(e.article_state) THEN json_extract(e.article_state, '$.holdDay') ELSE '' END AS hold_day,
          CASE WHEN json_valid(e.article_state) THEN json_extract(e.article_state, '$.touchedAt') ELSE 0 END AS touched_at,
          CASE WHEN json_valid(e.article_state) THEN COALESCE(json_extract(e.article_state, '$.summary'), '') ELSE '' END AS article_summary,
          CASE WHEN json_valid(e.article_state) THEN COALESCE(json_extract(e.article_state, '$.titleStatus'), '') ELSE '' END AS title_status,
          CASE
            WHEN json_valid(e.article_state) AND json_type(json_extract(e.article_state, '$.parts')) = 'array'
            THEN json_array_length(e.article_state, '$.parts')
            ELSE 0
          END AS parts_total,
          (
            SELECT COUNT(*) FROM json_each(
              CASE
                WHEN json_valid(e.article_state) AND json_type(json_extract(e.article_state, '$.parts')) = 'array'
                THEN json_extract(e.article_state, '$.parts')
                ELSE '[]'
              END
            ) AS part
            WHERE TRIM(COALESCE(json_extract(part.value, '$.translation'), '')) != ''
               OR TRIM(COALESCE(json_extract(part.value, '$.reply'), '')) != ''
          ) AS parts_done,
          (
            SELECT COUNT(*) FROM json_each(
              CASE
                WHEN json_valid(e.article_state) AND json_type(json_extract(e.article_state, '$.parts')) = 'array'
                THEN json_extract(e.article_state, '$.parts')
                ELSE '[]'
              END
            ) AS part
            WHERE TRIM(COALESCE(json_extract(part.value, '$.section'), '')) != ''
               OR TRIM(COALESCE(json_extract(part.value, '$.reply'), '')) != ''
          ) AS parts_organized`;

function progressExtra(row) {
  return {
    holdReason: row.hold_reason || '',
    holdDay: row.hold_day || '',
    partsDone: Number(row.parts_done) || 0,
    partsTotal: Number(row.parts_total) || 0,
    partsOrganized: Number(row.parts_organized) || 0,
    touchedAt: Number(row.touched_at) || 0,
    articleSummary: row.article_summary || '',
    titleStatus: row.title_status || '',
  };
}

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
      sourceTranscript: row.source_transcript || '',
      sourceHash: row.source_hash || '',
      articleStatus: row.article_status || '',
      articleState: row.article_state || '',
      articleDay: row.article_day || '',
      ingestedAt: row.created_at == null ? null : Number(row.created_at),
      holdReason: extra.holdReason || '',
      holdDay: extra.holdDay || '',
      partsDone: Number(extra.partsDone) || 0,
      partsOrganized: Number(extra.partsOrganized) || 0,
      partsTotal: Number(extra.partsTotal) || 0,
      touchedAt: Number(extra.touchedAt) || 0,
      articleSummary: extra.articleSummary || '',
      titleStatus: extra.titleStatus || '',
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
      const current = this.episode(input.workspaceId, input.videoId);
      const sourceTranscript = input.sourceTranscript !== undefined ? input.sourceTranscript : (current?.sourceTranscript || '');
      const sourceHash = input.sourceHash !== undefined ? input.sourceHash : (current?.sourceHash || '');
      const articleStatus = input.articleStatus !== undefined ? input.articleStatus : (current?.articleStatus || '');
      const articleState = input.articleState !== undefined ? input.articleState : (current?.articleState || '');
      const articleDay = input.articleDay !== undefined ? input.articleDay : (current?.articleDay || '');
      const contentItemId = input.contentItemId !== undefined ? (input.contentItemId || '') : (current?.contentItemId || '');
      const createdAt = Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : now;
      database.prepare(`INSERT INTO youtube_podcast_episodes
        (workspace_id, video_id, creator_id, channel_key, title, duration_sec, published_at,
         status, reason, transcript_source, content_item_id, attempts,
         source_transcript, source_hash, article_status, article_state, article_day,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          source_transcript = excluded.source_transcript,
          source_hash = excluded.source_hash,
          article_status = excluded.article_status,
          article_state = excluded.article_state,
          article_day = excluded.article_day,
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
        contentItemId,
        Number(input.attempts) || 0,
        sourceTranscript,
        sourceHash,
        articleStatus,
        articleState,
        articleDay,
        createdAt,
        now,
      );
    },

    countArticleDay(workspaceId, day) {
      const row = database.prepare(`SELECT COUNT(*) AS n FROM youtube_podcast_episodes
        WHERE workspace_id = ? AND article_day = ?`).get(workspaceId, day);
      return Number(row?.n) || 0;
    },

    listArticlesNeedingTitle(workspaceId, limit = 500) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 500));
      return database.prepare(`SELECT e.video_id, e.creator_id, e.channel_key, e.title,
          e.duration_sec, e.published_at, e.status, e.reason, e.transcript_source, e.content_item_id,
          e.attempts, e.source_hash, e.article_status, e.article_state, e.article_day,
          ci.summary AS summary, ci.body AS body, ci.title AS display_title,
          ci.source_url AS source_url, ci.author_name AS author_name
        FROM youtube_podcast_episodes e
        LEFT JOIN content_items ci ON ci.id = e.content_item_id AND ci.workspace_id = e.workspace_id
        WHERE e.workspace_id = ? AND e.status = 'ready' AND e.article_status = 'ready'
          AND (
            e.article_state = ''
            OR json_extract(e.article_state, '$.titleStatus') IS NULL
            OR json_extract(e.article_state, '$.titleStatus') != 'ready'
          )
        ORDER BY COALESCE(e.published_at, 0) DESC, e.video_id DESC
        LIMIT ?`).all(workspaceId, safeLimit)
        .map((row) => {
          const episode = mapEpisode(row, {
            summary: row.summary || '',
            body: row.body || '',
            displayTitle: row.display_title || '',
            sourceUrl: row.source_url || '',
            authorName: row.author_name || '',
          });
          delete episode.sourceTranscript;
          return episode;
        });
    },

    listArticleCandidates(workspaceId) {
      return database.prepare(`SELECT e.*, ci.summary AS summary, ci.body AS body,
          ci.title AS display_title, ci.source_url AS source_url, ci.author_name AS author_name
        FROM youtube_podcast_episodes e
        LEFT JOIN content_items ci ON ci.id = e.content_item_id AND ci.workspace_id = e.workspace_id
        WHERE e.workspace_id = ? AND e.status = 'ready'
          AND (
            e.article_status != 'ready'
            OR (e.article_status = 'ready' AND e.article_state LIKE '%"engine":"gemma"%')
          )
        ORDER BY CASE
            WHEN e.article_status = 'pending' THEN 0
            WHEN e.article_status = 'ready' THEN 2
            ELSE 1
          END,
          COALESCE(e.published_at, 0) DESC, e.video_id DESC`).all(workspaceId)
        .map((row) => mapEpisode(row, {
          summary: row.summary || '',
          body: row.body || '',
          displayTitle: row.display_title || '',
          sourceUrl: row.source_url || '',
          authorName: row.author_name || '',
        }));
    },

    channel(workspaceId, channelKey) {
      const row = database.prepare(`SELECT channel_id, bootstrapped, backfilled_at, backfill_attempts, backfill_failed_at
        FROM youtube_podcast_channels
        WHERE workspace_id = ? AND channel_key = ?`).get(workspaceId, channelKey);
      return {
        channelId: row?.channel_id || '',
        bootstrapped: Boolean(row?.bootstrapped),
        backfilledAt: row?.backfilled_at == null ? null : Number(row.backfilled_at),
        backfillAttempts: Number(row?.backfill_attempts) || 0,
        backfillFailedAt: row?.backfill_failed_at == null ? null : Number(row.backfill_failed_at),
      };
    },

    saveChannel(workspaceId, channelKey, patch = {}) {
      const current = this.channel(workspaceId, channelKey);
      const backfilledAt = Object.hasOwn(patch, 'backfilledAt') ? patch.backfilledAt : current.backfilledAt;
      const backfillAttempts = Object.hasOwn(patch, 'backfillAttempts') ? patch.backfillAttempts : current.backfillAttempts;
      const backfillFailedAt = Object.hasOwn(patch, 'backfillFailedAt') ? patch.backfillFailedAt : current.backfillFailedAt;
      database.prepare(`INSERT INTO youtube_podcast_channels
        (workspace_id, channel_key, channel_id, bootstrapped, backfilled_at, backfill_attempts, backfill_failed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, channel_key) DO UPDATE SET
          channel_id = excluded.channel_id,
          bootstrapped = excluded.bootstrapped,
          backfilled_at = excluded.backfilled_at,
          backfill_attempts = excluded.backfill_attempts,
          backfill_failed_at = excluded.backfill_failed_at,
          updated_at = excluded.updated_at`).run(
        workspaceId,
        channelKey,
        patch.channelId || current.channelId,
        patch.bootstrapped || current.bootstrapped ? 1 : 0,
        backfilledAt ?? null,
        Number(backfillAttempts) || 0,
        backfillFailedAt ?? null,
        Date.now(),
      );
    },

    listReady(workspaceId, limit = 200) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
      const rows = database.prepare(`SELECT e.video_id, e.creator_id, e.channel_key, e.title,
          e.duration_sec, e.published_at, e.status, e.reason, e.transcript_source, e.content_item_id,
          e.attempts, e.article_status, e.article_day, e.created_at, ci.summary AS summary, '' AS body,
          ci.title AS display_title, ci.source_url AS source_url, ci.author_name AS author_name,
          ${ARTICLE_PROGRESS_COLUMNS}
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
        ...progressExtra(row),
      }));
    },

    getStatus(workspaceId, videoId) {
      const row = database.prepare(`SELECT e.video_id, e.creator_id, e.channel_key, e.title,
          e.duration_sec, e.published_at, e.status, e.reason, e.transcript_source, e.content_item_id,
          e.attempts, e.article_status, e.article_day, e.created_at, '' AS body,
          '' AS summary, '' AS display_title, '' AS source_url, '' AS author_name,
          ${ARTICLE_PROGRESS_COLUMNS}
        FROM youtube_podcast_episodes e
        WHERE e.workspace_id = ? AND e.video_id = ? AND e.status = 'ready'`).get(workspaceId, videoId);
      if (!row) return null;
      const episode = mapEpisode(row, progressExtra(row));
      delete episode.sourceTranscript;
      delete episode.articleState;
      return episode;
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
