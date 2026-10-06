// Offline export only: requires a read-only connection and never touches jobs or state.
export function readFeedQualityWindow(database, { workspaceId = 'local', startAt, endAt } = {}) {
  if (!database.readonly) throw new Error('Feed quality audit requires a read-only database');
  if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || startAt >= endAt) {
    throw new Error('Invalid feed quality audit window');
  }
  return database.transaction(() => {
    const feed = database.prepare(`SELECT ci.*,c.provider,c.external_id,c.metadata_json,
      c.captured_at,sa.external_id source_key,sa.display_name source_name
      FROM content_items ci JOIN captures c ON c.id=ci.capture_id
      LEFT JOIN source_accounts sa ON sa.id=c.source_account_id
      WHERE ci.workspace_id=? AND c.provider IN ('x','xueqiu')
      AND ci.created_at>=? AND ci.created_at<? ORDER BY ci.created_at,ci.id`)
      .all(workspaceId, startAt, endAt);
    // Pick the oldest canonical identity across the whole database before selecting the window.
    const media = database.prepare(`SELECT e.* FROM media_index_entries e
      WHERE e.workspace_id=? AND e.created_at>=? AND e.created_at<?
      AND NOT EXISTS (SELECT 1 FROM media_index_entries older
        WHERE older.workspace_id=e.workspace_id AND older.canonical_url=e.canonical_url
        AND (older.created_at<e.created_at OR (older.created_at=e.created_at AND older.external_id<e.external_id)))
      ORDER BY e.created_at,e.external_id`).all(workspaceId, startAt, endAt);
    const getBodies = database.prepare(`SELECT revision,body_hash,body_text,truncated,content_level,observed_at
      FROM media_body_snapshots WHERE workspace_id=? AND external_id=? ORDER BY revision`);
    for (const entry of media) entry.snapshots = getBodies.all(workspaceId, entry.external_id);
    const taggings = database.prepare(`SELECT resource_type,resource_id,tags_json,analyzed_at
      FROM resource_taggings WHERE workspace_id=? AND resource_type IN ('content-item','media-index')`).all(workspaceId);
    return { exportedAt: Date.now(), workspaceId, startAt, endAt, feed, media, taggings,
      mediaIndexRowsInWindow: database.prepare('SELECT COUNT(*) n FROM media_index_entries WHERE workspace_id=? AND created_at>=? AND created_at<?')
        .get(workspaceId, startAt, endAt).n,
      excludedMediaFeedMirrors: database.prepare(`SELECT COUNT(*) n FROM content_items ci JOIN captures c ON c.id=ci.capture_id
        WHERE ci.workspace_id=? AND c.provider='media' AND ci.created_at>=? AND ci.created_at<?`).get(workspaceId,startAt,endAt).n };
  })();
}
