// Listing/filtering indexes must not load every RSS HTML body into memory.
const ENTRY_INDEX_COLUMNS = 'workspace_id,external_id,source_key,publisher_key,publisher_name,author_name,channel,canonical_url,title,summary,published_at,published_at_raw,content_level,content_hash,revision,status,origin_url,discovered_via_json,observed_at,body_hash,truncated,created_at,updated_at,fetch_state_json,article_kind';

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
    ingestionPolicy: row.ingestion_policy || '',
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
    publisherName: row.publisher_name || '',
    authorName: row.author_name || '',
    channel: row.channel,
    canonicalUrl: row.canonical_url,
    title: row.title || '',
    summary: row.summary || '',
    publishedAt: row.published_at || null,
    publishedAtRaw: row.published_at_raw || '',
    articleKind: row.article_kind || 'article',
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
    saveArticleKind(workspaceId,externalId,kind) { database.prepare('UPDATE media_index_entries SET article_kind=? WHERE workspace_id=? AND external_id=?').run(kind,workspaceId,externalId); },
    getEntry(workspaceId, externalId) {
      return mapEntry(database.prepare(`SELECT ${ENTRY_INDEX_COLUMNS} FROM media_index_entries WHERE workspace_id=? AND external_id=?`).get(workspaceId, externalId));
    },
    linkLegacy(workspaceId,externalId,contentItemId,legacyProvider,legacyExternalId) {
      database.prepare('INSERT OR IGNORE INTO media_entry_legacy_links VALUES (?,?,?,?,?)').run(workspaceId,externalId,contentItemId,legacyProvider,legacyExternalId);
    },
    legacyLinks(workspaceId) { return database.prepare('SELECT external_id externalId,content_item_id contentItemId,legacy_provider legacyProvider,legacy_external_id legacyExternalId FROM media_entry_legacy_links WHERE workspace_id=?').all(workspaceId); },
    listWindowSources(workspaceId, {startAt,endAt,hiddenExternalIds=[]}) {
      const visible=hiddenExternalIds.length ? `AND e.external_id NOT IN (${hiddenExternalIds.map(()=>'?').join(',')})` : '';
      return database.prepare(`SELECT e.source_key sourceId,e.channel,COUNT(*) available
        FROM media_index_entries e WHERE e.workspace_id=?
        AND COALESCE(e.published_at,e.observed_at)>=? AND COALESCE(e.published_at,e.observed_at)<?
        ${visible} GROUP BY e.source_key`).all(workspaceId,startAt,endAt,...hiddenExternalIds);
    },
    listEntriesInWindow(workspaceId, {startAt,endAt,sourceId,cursor=null,limit=100,hiddenExternalIds=[]}) {
      const visible=hiddenExternalIds.length ? `AND external_id NOT IN (${hiddenExternalIds.map(()=>'?').join(',')})` : '';
      return database.prepare(`SELECT ${ENTRY_INDEX_COLUMNS} FROM media_index_entries
        WHERE workspace_id=? AND source_key=?
        AND COALESCE(published_at,observed_at)>=? AND COALESCE(published_at,observed_at)<?
        ${visible}
        AND (? IS NULL OR (COALESCE(published_at,observed_at),external_id) > (?,?))
        ORDER BY COALESCE(published_at,observed_at),external_id LIMIT ?`)
        .all(workspaceId,sourceId,startAt,endAt,...hiddenExternalIds,cursor?.eventAt ?? null,cursor?.eventAt ?? 0,cursor?.id ?? '',Math.min(200,limit)).map(mapEntry);
    },
    listEntriesAcrossWindow(workspaceId, {startAt,endAt,cursor=null,limit=200}={}) {
      const safe=Math.max(1, Math.min(Number(limit)||200, 200));
      return database.prepare(`SELECT e.*, (
          SELECT p.brief_status FROM media_article_processing p
          WHERE p.workspace_id=e.workspace_id AND p.external_id=e.external_id AND p.body_hash=e.body_hash
          LIMIT 1) AS brief_status
        FROM media_index_entries e
        WHERE e.workspace_id=?
          AND COALESCE(e.published_at,e.observed_at)>=?
          AND COALESCE(e.published_at,e.observed_at)<?
          AND (? IS NULL OR (COALESCE(e.published_at,e.observed_at), e.external_id) > (?, ?))
        ORDER BY COALESCE(e.published_at,e.observed_at), e.external_id
        LIMIT ?`).all(workspaceId, startAt, endAt, cursor?.eventAt ?? null, cursor?.eventAt ?? 0, cursor?.id ?? '', safe)
        .map(row=>({...mapEntry(row), briefStatus:row.brief_status || '', eventAt:row.published_at || row.observed_at}));
    },
    findByUrl(workspaceId, url) {
      // Preserve the oldest existing identity, including its Capture and reading state.
      return mapEntry(database.prepare('SELECT * FROM media_index_entries WHERE workspace_id=? AND canonical_url=? ORDER BY created_at,external_id LIMIT 1').get(workspaceId,url));
    },
    saveDiscovery(value) {
      const row = MediaDiscoverySchema.parse(value);
      return database.transaction(() => {
        database.prepare(`INSERT INTO media_entry_discoveries VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id,external_id,source_key) DO UPDATE SET
            entry_url=excluded.entry_url,list_position=excluded.list_position,last_seen_at=excluded.last_seen_at`)
          .run(row.workspaceId,row.externalId,row.sourceKey,row.entryUrl,row.listPosition,row.firstSeenAt,row.lastSeenAt);
        emitEvent('feed.media-discovery.saved.v1','media-index',row.externalId,{externalId:row.externalId,sourceKey:row.sourceKey},row.workspaceId);
      })();
    },
    listDiscoveries(workspaceId, externalIds) {
      const ids = [...new Set(externalIds || [])];
      if (!ids.length) return [];
      return database.prepare(`SELECT * FROM media_entry_discoveries WHERE workspace_id=? AND external_id IN (${ids.map(()=>'?').join(',')})`)
        .all(workspaceId,...ids).map(row=>({workspaceId:row.workspace_id,externalId:row.external_id,sourceKey:row.source_key,entryUrl:row.entry_url,
          listPosition:row.list_position,firstSeenAt:row.first_seen_at,lastSeenAt:row.last_seen_at}));
    },
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
    listBriefProcessing(workspaceId, keys = []) {
      const pairs = (keys || []).filter((key) => key?.externalId);
      if (!pairs.length) return [];
      const marks = pairs.map(() => '(?,?)').join(',');
      const params = pairs.flatMap((key) => [key.externalId, key.bodyHash || '']);
      return database.prepare(`SELECT external_id AS externalId, body_hash AS bodyHash, brief_status AS status, brief_reason AS reason, last_attempt_at AS lastAttemptAt
        FROM media_article_processing
        WHERE workspace_id=? AND (external_id, body_hash) IN (${marks})`).all(workspaceId, ...params);
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
    reserveRequest(workspaceId, dayKey, sourceKey, now, globalMax = null, sourceMax = null, sourceAliases = []) {
      return database.transaction(() => {
        database.prepare(`INSERT OR IGNORE INTO media_budget_days (workspace_id,day_key,new_metadata,selected_bodies,deferred_count,updated_at) VALUES (?,?,0,0,0,?)`).run(workspaceId,dayKey,now);
        database.prepare(`INSERT OR IGNORE INTO media_source_budgets (workspace_id,day_key,source_key,bodies,updated_at) VALUES (?,?,?,0,?)`).run(workspaceId,dayKey,sourceKey,now);
        const day = database.prepare('SELECT body_requests FROM media_budget_days WHERE workspace_id=? AND day_key=?').get(workspaceId,dayKey);
        const keys = [...new Set([sourceKey,...sourceAliases])];
        const source = database.prepare(`SELECT COALESCE(SUM(requests),0) requests FROM media_source_budgets WHERE workspace_id=? AND day_key=? AND source_key IN (${keys.map(()=>'?').join(',')})`).get(workspaceId,dayKey,...keys);
        if ((globalMax != null && day.body_requests >= globalMax) || (sourceMax != null && source.requests >= sourceMax)) return false;
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
         health_detail, etag, last_modified, feed_hash, last_probe_json, last_sync_at, updated_at, ingestion_policy)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          updated_at = excluded.updated_at,
          ingestion_policy = excluded.ingestion_policy`)
        .run(
          state.workspaceId, state.sourceKey, state.enabled ? 1 : 0, state.hostDirectVerified ? 1 : 0,
          state.bodyUseAcknowledged ? 1 : 0, state.health, state.healthDetail || '', state.etag || '',
          state.lastModified || '', state.feedHash || '', JSON.stringify(state.lastProbe || null),
          state.lastSyncAt || null, state.updatedAt, state.ingestionPolicy || '',
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
    listFeedPage(workspaceId, {
      channel = '',
      sourceKey = '',
      view = 'all',
      offset = 0,
      limit = 50,
      before = null,
      excludedExternalIds = [],
      extractorVersion = '',
    } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 101));
      const safeOffset = before ? 0 : Math.max(0, Number(offset) || 0);
      const categorySql = `CASE
        WHEN COALESCE(e.article_kind,'article')='report-intro' THEN 'index'
        WHEN json_extract(e.fetch_state_json,'$.fetchStatus')='ready'
          AND e.content_level='full'
          AND json_extract(e.fetch_state_json,'$.extractorVersion')=?
          AND json_extract(e.fetch_state_json,'$.fetchedRevision')=e.revision THEN 'full'
        WHEN json_extract(e.fetch_state_json,'$.fetchStatus') IN ('failed','policy_skipped') THEN 'failed'
        WHEN e.content_level IN ('full','partial') THEN 'partial'
        WHEN json_extract(e.fetch_state_json,'$.fetchStatus') IN ('pending','deferred') THEN 'pending'
        ELSE 'index' END`;
      const readSql = `CASE WHEN link.external_id IS NOT NULL AND lci.id IS NOT NULL THEN COALESCE(ls.is_read,0) ELSE COALESCE(s.is_read,0) END`;
      const hiddenSql = `CASE WHEN link.external_id IS NOT NULL AND lci.id IS NOT NULL THEN COALESCE(ls.is_hidden,0) ELSE COALESCE(s.is_hidden,0) END`;
      const savedSql = `CASE WHEN link.external_id IS NOT NULL AND lci.id IS NOT NULL THEN COALESCE(ls.is_saved,0) ELSE COALESCE(s.is_saved,0) END`;
      const contentIdSql = `CASE WHEN link.external_id IS NOT NULL AND lci.id IS NOT NULL THEN lci.id ELSE ci.id END`;
      const joins = `
        LEFT JOIN content_items ci ON ci.id = (
          SELECT ci2.id FROM content_items ci2
          INNER JOIN captures c2 ON c2.id=ci2.capture_id AND c2.workspace_id=ci2.workspace_id
          WHERE c2.workspace_id=e.workspace_id AND c2.provider='media' AND c2.external_id=e.external_id
          ORDER BY ci2.created_at DESC, ci2.id DESC LIMIT 1)
        LEFT JOIN user_item_states s ON s.workspace_id=ci.workspace_id AND s.content_item_id=ci.id
        LEFT JOIN media_entry_legacy_links link ON link.workspace_id=e.workspace_id AND link.external_id=e.external_id
        LEFT JOIN content_items lci ON lci.id = (
          SELECT ci3.id FROM content_items ci3
          INNER JOIN captures c3 ON c3.id=ci3.capture_id AND c3.workspace_id=ci3.workspace_id
          WHERE link.external_id IS NOT NULL AND c3.workspace_id=link.workspace_id AND c3.provider=link.legacy_provider AND c3.external_id=link.legacy_external_id
          ORDER BY ci3.created_at DESC, ci3.id DESC LIMIT 1)
        LEFT JOIN user_item_states ls ON ls.workspace_id=lci.workspace_id AND ls.content_item_id=lci.id`;
      const where = `e.workspace_id=?
        AND (?='' OR e.channel=?)
        AND (?='' OR e.source_key=? OR e.publisher_key=?)
        AND ${hiddenSql}=0
        AND e.external_id NOT IN (SELECT value FROM json_each(?))`;
      const filterParams = [workspaceId, channel, channel, sourceKey, sourceKey, sourceKey, JSON.stringify(excludedExternalIds || [])];
      const columns = ENTRY_INDEX_COLUMNS.split(',').map((name) => `e.${name.trim()} AS ${name.trim()}`).join(',');
      const counted = database.prepare(`SELECT category, COUNT(*) AS n FROM (
          SELECT ${categorySql} AS category
          FROM media_index_entries e
          ${joins}
          WHERE ${where}
        ) GROUP BY category`).all(extractorVersion, ...filterParams);
      const counts = { all: 0, full: 0, partial: 0, index: 0, pending: 0, failed: 0 };
      for (const row of counted) {
        if (Object.hasOwn(counts, row.category)) counts[row.category] = Number(row.n) || 0;
        counts.all += Number(row.n) || 0;
      }
      const matched = view && view !== 'all' ? (counts[view] || 0) : counts.all;
      const viewSql = view && view !== 'all' ? 'AND category = ?' : '';
      const cursorSql = before
        ? `AND (is_read > ? OR (is_read = ? AND sort_at < ?) OR (is_read = ? AND sort_at = ? AND external_id < ?))`
        : '';
      const pageParams = [
        extractorVersion,
        ...filterParams,
        ...(view && view !== 'all' ? [view] : []),
        ...(before ? [before.isRead, before.isRead, before.at, before.isRead, before.at, before.id] : []),
        safeLimit,
        ...(before ? [] : [safeOffset]),
      ];
      const rows = database.prepare(`SELECT * FROM (
          SELECT ${columns},
            ${readSql} AS is_read,
            ${hiddenSql} AS is_hidden,
            ${savedSql} AS is_saved,
            ${contentIdSql} AS content_item_id,
            link.content_item_id AS legacy_content_item_id,
            link.legacy_provider AS legacy_provider,
            link.legacy_external_id AS legacy_external_id,
            COALESCE(e.published_at, e.observed_at) AS sort_at,
            ${categorySql} AS category
          FROM media_index_entries e
          ${joins}
          WHERE ${where}
        ) page
        WHERE 1=1 ${viewSql} ${cursorSql}
        ORDER BY is_read ASC, sort_at DESC, external_id DESC
        LIMIT ? ${before ? '' : 'OFFSET ?'}`).all(...pageParams).map((row) => ({
        ...mapEntry(row),
        paged: true,
        isRead: Boolean(row.is_read),
        isHidden: Boolean(row.is_hidden),
        isSaved: Boolean(row.is_saved),
        contentItemId: row.content_item_id || null,
        legacyContentItemId: row.legacy_content_item_id || null,
        legacyProvider: row.legacy_provider || '',
        legacyExternalId: row.legacy_external_id || '',
        sortAt: row.sort_at || 0,
      }));
      return { rows, counts, matched };
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
    informationCandidates(workspaceId,{startAt,endAt,hiddenExternalIds=[],extractorVersion}) {
      return database.prepare(`SELECT e.external_id,e.source_key,e.title,e.canonical_url,e.revision,e.created_at event_at,
        coalesce((SELECT b.revision FROM media_body_snapshots b WHERE b.workspace_id=e.workspace_id AND b.external_id=e.external_id AND b.body_hash=e.body_hash
          AND b.revision=(SELECT max(s.revision) FROM media_body_snapshots s WHERE s.workspace_id=e.workspace_id AND s.external_id=e.external_id AND s.body_hash=e.body_hash)
          AND (b.content_level='partial' OR (b.content_level='full' AND b.truncated=0 AND json_extract(b.article_json,'$.extractorVersion')=? AND json_extract(e.fetch_state_json,'$.fetchStatus')='ready' AND json_extract(e.fetch_state_json,'$.fetchedRevision')=e.revision AND json_extract(e.fetch_state_json,'$.extractorVersion')=?))),0) body_revision
        FROM media_index_entries e WHERE e.workspace_id=? AND e.created_at>=? AND e.created_at<? AND e.external_id NOT IN (SELECT value FROM json_each(?)) ORDER BY event_at,e.external_id`)
        .all(extractorVersion,extractorVersion,workspaceId,startAt,endAt,JSON.stringify(hiddenExternalIds)).map(r=>({id:`media:${r.external_id}`,sourceKey:r.source_key || '',title:r.title || '',sourceUrl:r.canonical_url || '',version:`index:${r.revision}/body:${r.body_revision}`,eventAt:r.event_at}));
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
         discovered_via_json, observed_at, body_hash, truncated, created_at, updated_at, publisher_name, author_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, external_id) DO UPDATE SET
          title = excluded.title,
          publisher_key = CASE WHEN excluded.publisher_name != '' THEN excluded.publisher_key ELSE media_index_entries.publisher_key END,
          publisher_name = CASE WHEN excluded.publisher_name != '' THEN excluded.publisher_name ELSE media_index_entries.publisher_name END,
          author_name = CASE WHEN excluded.author_name != '' THEN excluded.author_name ELSE media_index_entries.author_name END,
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
          entry.bodyHash || '', entry.truncated ? 1 : 0, entry.createdAt, entry.updatedAt, entry.publisherName || '', entry.authorName || '',
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
        const allowed = maxNew == null ? requested : Math.max(0, Math.min(requested, maxNew - used));
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
    reserveBody(workspaceId, dayKey, sourceKey, now, { globalMax, sourceMax, sourceAliases = [] }) {
      return database.transaction(() => {
        const day = database.prepare(`SELECT * FROM media_budget_days
          WHERE workspace_id = ? AND day_key = ?`).get(workspaceId, dayKey);
        const keys = [...new Set([sourceKey,...sourceAliases])];
        const source = database.prepare(`SELECT COALESCE(SUM(bodies),0) bodies FROM media_source_budgets
          WHERE workspace_id = ? AND day_key = ? AND source_key IN (${keys.map(()=>'?').join(',')})`).get(workspaceId, dayKey, ...keys);
        const globalUsed = day?.selected_bodies || 0;
        const sourceUsed = source?.bodies || 0;
        if ((globalMax != null && globalUsed >= globalMax) || (sourceMax != null && sourceUsed >= sourceMax)) {
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
        const currentSource = database.prepare('SELECT 1 FROM media_source_budgets WHERE workspace_id=? AND day_key=? AND source_key=?').get(workspaceId,dayKey,sourceKey);
        if (!currentSource) {
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
import { MediaBriefSchema, MediaDiscoverySchema, MediaFetchStateSchema, MediaParagraphSchema } from '../../../contracts/src/media.js';
