import {TreeNodeSchema,TreeEditionSchema,isUnavailableTreeText} from '../../../contracts/src/information-tree.js';
import {DailyEditorialSchema} from '../../../contracts/src/daily-editorial.js';

function indexEdition(row,prefix,hasEditorial) {
  const id=row[`${prefix}_id`];
  if(!id) return null;
  return {id,layer:row.layer,window:{startAt:Number(row[`${prefix}_start`]),endAt:Number(row[`${prefix}_end`])},status:row[`${prefix}_status`],generatedAt:Number(row[`${prefix}_generated`]),rootCount:Number(row[`${prefix}_roots`] || 0),hasEditorial};
}

function editionIndexSql(whereSql, tailSql) {
  return `SELECT h.layer AS layer,
        CASE WHEN p.edition_status != '' THEN p.id ELSE json_extract(p.value_json, '$.id') END AS published_id,
        CASE WHEN p.edition_status != '' THEN p.edition_status ELSE json_extract(p.value_json, '$.status') END AS published_status,
        CASE WHEN p.edition_status != '' THEN p.generated_at ELSE json_extract(p.value_json, '$.generatedAt') END AS published_generated,
        CASE WHEN p.edition_status != '' THEN p.start_at ELSE json_extract(p.value_json, '$.window.startAt') END AS published_start,
        CASE WHEN p.edition_status != '' THEN p.end_at ELSE json_extract(p.value_json, '$.window.endAt') END AS published_end,
        CASE WHEN p.edition_status != '' THEN p.root_count ELSE COALESCE(json_array_length(p.value_json, '$.roots'), 0) END AS published_roots,
        CASE WHEN a.edition_status != '' THEN a.id ELSE json_extract(a.value_json, '$.id') END AS attempt_id,
        CASE WHEN a.edition_status != '' THEN a.edition_status ELSE json_extract(a.value_json, '$.status') END AS attempt_status,
        CASE WHEN a.edition_status != '' THEN a.generated_at ELSE json_extract(a.value_json, '$.generatedAt') END AS attempt_generated,
        CASE WHEN a.edition_status != '' THEN a.start_at ELSE json_extract(a.value_json, '$.window.startAt') END AS attempt_start,
        CASE WHEN a.edition_status != '' THEN a.end_at ELSE json_extract(a.value_json, '$.window.endAt') END AS attempt_end,
        CASE WHEN a.edition_status != '' THEN a.root_count ELSE COALESCE(json_array_length(a.value_json, '$.roots'), 0) END AS attempt_roots,
        CASE WHEN e.published_id IS NOT NULL THEN 1 ELSE 0 END AS has_editorial
        FROM information_tree_heads h
        LEFT JOIN information_tree_editions p ON p.workspace_id=h.workspace_id AND p.id=h.published_id
        LEFT JOIN information_tree_editions a ON a.workspace_id=h.workspace_id AND a.id=h.attempt_id
        LEFT JOIN information_tree_editorial_heads e ON e.workspace_id=h.workspace_id AND e.published_id IS NOT NULL
          AND e.period_key = (
            CAST(CASE WHEN COALESCE(p.edition_status, a.edition_status, '') != '' THEN COALESCE(NULLIF(p.start_at, 0), a.start_at) ELSE json_extract(COALESCE(p.value_json, a.value_json), '$.window.startAt') END AS TEXT)
            || ':' ||
            CAST(CASE WHEN COALESCE(p.edition_status, a.edition_status, '') != '' THEN COALESCE(NULLIF(p.end_at, 0), a.end_at) ELSE json_extract(COALESCE(p.value_json, a.value_json), '$.window.endAt') END AS TEXT)
          )
        WHERE ${whereSql}
        ${tailSql}`;
}

function slotFromIndexRow(row) {
  if (!row) return null;
  const hasEditorial = row.has_editorial === 1;
  return { edition: indexEdition(row, 'published', hasEditorial), attempt: indexEdition(row, 'attempt', hasEditorial) };
}

const LATEST_DAILY_CACHE_MS = 60_000;

export function createInformationTreeRepository(db,emit) {
  const latestDailyCache = new Map();
  const forgetLatestDaily = (workspace) => {
    latestDailyCache.delete(String(workspace ?? ''));
  };
  const readLatestDaily = (workspace, load, now = Date.now()) => {
    const key = String(workspace ?? '');
    const clock = Number(now);
    const at = Number.isFinite(clock) ? clock : Date.now();
    const hit = latestDailyCache.get(key);
    if (hit && at >= hit.at && at - hit.at < LATEST_DAILY_CACHE_MS) return hit.value;
    const value = load();
    latestDailyCache.set(key, { at, value });
    return value;
  };
  const read=(table,workspace,id)=>{
    const row=db.prepare(`SELECT value_json FROM ${table} WHERE workspace_id=? AND id=?`).get(workspace,id);
    return row ? JSON.parse(row.value_json) : null;
  };
  return {
    activatePolicy(workspace,hash) {db.prepare('INSERT OR REPLACE INTO information_tree_policies VALUES (?,?)').run(workspace,hash);},
    policy(workspace) {return db.prepare('SELECT policy_hash FROM information_tree_policies WHERE workspace_id=?').get(workspace)?.policy_hash || null;},
    head(workspace,layer,window) {return db.prepare('SELECT published_id FROM information_tree_heads WHERE workspace_id=? AND period_key=?').get(workspace,`${layer}:${window.startAt}:${window.endAt}`)?.published_id || null;},
    informationHead(workspace,sourceId) {
      const row=db.prepare('SELECT node_id,source_version FROM information_tree_information_heads WHERE workspace_id=? AND source_id=?').get(workspace,sourceId);
      return row ? {node:this.getNode(workspace,row.node_id),sourceVersion:row.source_version} : null;
    },
    informationHeads(workspace,sourceIds) {
      const ids=[...new Set((sourceIds || []).map(id=>String(id || '').trim()).filter(Boolean))];
      if(!ids.length) return [];
      return db.prepare(`SELECT h.source_id AS sourceId,h.source_version AS sourceVersion,n.value_json AS valueJson
        FROM information_tree_information_heads h
        JOIN information_tree_nodes n ON n.workspace_id=h.workspace_id AND n.id=h.node_id
        WHERE h.workspace_id=? AND h.source_id IN (${ids.map(()=>'?').join(',')})`)
        .all(workspace,...ids)
        .map(row=>({sourceId:row.sourceId,sourceVersion:row.sourceVersion,node:JSON.parse(row.valueJson)}));
    },
    listInformation(workspace,window) {
      return db.prepare('SELECT node_id FROM information_tree_information_heads WHERE workspace_id=? AND event_at>=? AND event_at<? ORDER BY event_at,source_id').all(workspace,window.startAt,window.endAt).map(r=>this.getNode(workspace,r.node_id));
    },
    setInformationHead(workspace,node,policyHash) {
      return db.transaction(()=>{
        if(this.policy(workspace)!==policyHash)return false;
        const before=this.informationHead(workspace,node.sourceId)?.node;
        if(before && (before.sourceUpdatedAt || 0)>(node.sourceUpdatedAt || 0))return false;
        if(before?.id===node.id)return true;
        db.prepare(`INSERT OR REPLACE INTO information_tree_information_heads
          (workspace_id,source_id,node_id,source_version,event_at,source_at,window_start,window_end,validator_version)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(
          workspace, node.sourceId, node.id, node.sourceVersion || '', node.eventAt || node.window.startAt, node.sourceUpdatedAt || 0,
          Number(node.window?.startAt) || 0, Number(node.window?.endAt) || 0, node.validatorVersion || '',
        );
        emit('report.tree.information.ready.v1','information-tree',node.id,{sourceId:node.sourceId},workspace);return true;
      })();
    },
    getNode:(workspace,id)=>read('information_tree_nodes',workspace,id),
    getNodes(workspace, ids) {
      const wanted = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
      const nodes = [];
      for (let offset = 0; offset < wanted.length; offset += 400) {
        const slice = wanted.slice(offset, offset + 400);
        const rows = db.prepare(`SELECT value_json FROM information_tree_nodes
          WHERE workspace_id=? AND id IN (${slice.map(() => '?').join(',')})`).all(workspace, ...slice);
        for (const row of rows) nodes.push(JSON.parse(row.value_json));
      }
      return nodes;
    },
    getEdition:(workspace,id)=>read('information_tree_editions',workspace,id),
    saveNode(workspace,value) {
      const node=TreeNodeSchema.parse(value);
      const expected=node.layer==='daily' ? 'hourly' : 'information';
      if(node.layer==='information') {
        if(node.children.length || !node.sourceId || node.articleIds.length!==1 || node.articleIds[0]!==node.sourceId) throw new Error('信息节点必须绑定唯一原始材料');
      } else {
        if(!node.children.length || new Set(node.children).size!==node.children.length) throw new Error('模块直接子节点为空或重复');
        if(node.children.some(id=>this.getNode(workspace,id)?.layer!==expected)) throw new Error('非法跨层或跨workspace引用');
      }
      db.transaction(()=>{
        db.prepare('INSERT OR IGNORE INTO information_tree_nodes VALUES (?,?,?)').run(workspace,node.id,JSON.stringify(node));
        emit('report.tree.node.saved.v1','information-tree',node.id,{layer:node.layer},workspace);
      })();return this.getNode(workspace,node.id);
    },
    acquire(workspace,key,owner,at,leaseMs=180000) {
      return db.transaction(()=>{
        const row=db.prepare('SELECT owner,lease_until FROM information_tree_leases WHERE workspace_id=? AND cache_key=?').get(workspace,key);
        if(row && row.lease_until>at && row.owner!==owner) return false;
        db.prepare('INSERT OR REPLACE INTO information_tree_leases VALUES (?,?,?,?)').run(workspace,key,owner,at+leaseMs);return true;
      }).immediate();
    },
    renew(workspace,key,owner,at) {
      const result=db.prepare('UPDATE information_tree_leases SET lease_until=? WHERE workspace_id=? AND cache_key=? AND owner=? AND lease_until>?').run(at+180000,workspace,key,owner,at);
      if(!result.changes) throw new Error('浓缩树租约已失效');
    },
    release(workspace,key,owner) {db.prepare('DELETE FROM information_tree_leases WHERE workspace_id=? AND cache_key=? AND owner=?').run(workspace,key,owner);},
    publish(workspace,value,{expectedHead}={}) {
      const edition=TreeEditionSchema.parse(value);
      if(edition.status!=='failed') {
        const inputs=edition.roots.flatMap(id=>{const node=this.getNode(workspace,id);if(node?.layer!==edition.layer)throw new Error('刊期根节点层不符');return node.children;});
        if(new Set(inputs).size!==inputs.length || inputs.length!==edition.inputIds.length || edition.inputIds.some(id=>!inputs.includes(id))) throw new Error('刊期直接输入归属不完整');
      }
      return db.transaction(()=>{
        db.prepare(`INSERT OR IGNORE INTO information_tree_editions
          (workspace_id,id,value_json,edition_status,generated_at,start_at,end_at,root_count)
          VALUES (?,?,?,?,?,?,?,?)`).run(
          workspace, edition.id, JSON.stringify(edition), edition.status || '', Number(edition.generatedAt) || 0,
          Number(edition.window?.startAt) || 0, Number(edition.window?.endAt) || 0, Array.isArray(edition.roots) ? edition.roots.length : 0,
        );
        const key=`${edition.layer}:${edition.window.startAt}:${edition.window.endAt}`;
        const head=db.prepare('SELECT published_id FROM information_tree_heads WHERE workspace_id=? AND period_key=?').get(workspace,key);
        const previous=head?.published_id ? this.getEdition(workspace,head.published_id) : null;
        // Compare material identities for information versions and direct module identities for daily versions.
        const revisions=e=>{
          const values=new Map(),walk=id=>{const n=this.getNode(workspace,id);if(n?.layer==='information'){if(n.validatorVersion || !isUnavailableTreeText(n.text))values.set(n.sourceId,n.sourceUpdatedAt || 0);}else n?.children.forEach(walk);};
          e.inputIds.forEach(walk);return values;
        };
        const oldVersions=previous ? revisions(previous) : new Map(),newVersions=revisions(edition);
        const before=new Set(oldVersions.keys()),after=new Set(newVersions.keys());
        // A pre-fix empty edition generated before its window ended never established completeness.
        const prematureEmpty=previous && previous.generatedAt<previous.window.endAt && !previous.inputIds.length && !previous.roots.length;
        const validPrevious=(()=>{let valid=!prematureEmpty;const walk=id=>{const n=this.getNode(workspace,id);if(!n || (!n.validatorVersion && isUnavailableTreeText(n.text)))valid=false;n?.children.forEach(walk);};previous?.inputIds.forEach(walk);return valid;})();
        const activePolicy=this.policy(workspace);
        const policyAllowed=!activePolicy || activePolicy===edition.policyHash;
        const headAllowed=expectedHead===undefined || (head?.published_id || null)===expectedHead;
        const canPublish=policyAllowed && headAllowed && edition.status!=='failed' && [...before].every(id=>after.has(id))
          && !(validPrevious && previous?.status==='ready' && edition.status==='partial' && after.size<=before.size)
          && [...oldVersions].every(([id,version])=>(newVersions.get(id) ?? -1)>=version);
        if(policyAllowed && headAllowed)db.prepare('INSERT OR REPLACE INTO information_tree_heads VALUES (?,?,?,?,?,?)').run(workspace,key,edition.layer,edition.window.startAt,canPublish ? edition.id : head?.published_id || null,edition.id);
        if(canPublish && edition.layer==='daily') forgetLatestDaily(workspace);
        emit('report.tree.edition.saved.v1','information-tree',edition.id,{layer:edition.layer,status:edition.status,published:canPublish,...(!validPrevious ? {reason:prematureEmpty ? 'previous-premature-empty' : 'previous-needs-content-is-not-valid-content'} : {})},workspace);
        return {...edition,published:canPublish,...(!policyAllowed || !headAllowed ? {stale:true} : {})};
      })();
    },
    list(workspace,startAt,endAt,layer='hourly') {
      return db.prepare('SELECT published_id,attempt_id FROM information_tree_heads WHERE workspace_id=? AND layer=? AND start_at>=? AND start_at<? ORDER BY start_at DESC').all(workspace,layer,startAt,endAt)
        .map(row=>({edition:row.published_id ? this.getEdition(workspace,row.published_id) : null,attempt:this.getEdition(workspace,row.attempt_id)}));
    },
    listInformationIndex(workspace,window) {
      return db.prepare(`SELECT h.node_id AS id, h.event_at AS eventAt,
        CASE WHEN h.window_end > 0 THEN h.window_start ELSE json_extract(n.value_json, '$.window.startAt') END AS windowStart,
        CASE WHEN h.window_end > 0 THEN h.window_end ELSE json_extract(n.value_json, '$.window.endAt') END AS windowEnd,
        CASE WHEN h.window_end > 0 THEN NULLIF(h.validator_version, '') ELSE json_extract(n.value_json, '$.validatorVersion') END AS validatorVersion
        FROM information_tree_information_heads h
        LEFT JOIN information_tree_nodes n ON n.workspace_id=h.workspace_id AND n.id=h.node_id AND h.window_end = 0
        WHERE h.workspace_id=? AND h.event_at>=? AND h.event_at<?
        ORDER BY h.event_at, h.source_id`).all(workspace,window.startAt,window.endAt).map(row=>({
        id:row.id,eventAt:Number(row.eventAt),window:{startAt:Number(row.windowStart),endAt:Number(row.windowEnd)},
        ...(row.validatorVersion ? {validatorVersion:row.validatorVersion} : {}),
      }));
    },
    listEditionIndex(workspace,startAt,endAt,layer='hourly') {
      return db.prepare(editionIndexSql('h.workspace_id=? AND h.layer=? AND h.start_at>=? AND h.start_at<?', 'ORDER BY h.start_at DESC'))
        .all(workspace,layer,startAt,endAt).map(slotFromIndexRow);
    },
    latestDailySlot(workspace) {
      return slotFromIndexRow(db.prepare(editionIndexSql("h.workspace_id=? AND h.layer='daily' AND h.published_id IS NOT NULL", 'ORDER BY h.start_at DESC LIMIT 1')).get(workspace));
    },
    readLatestDaily,
    forgetLatestDaily,
    listInformationInWindow(workspace, window, {limit=200, cursor=null}={}) {
      const safe=Math.max(1, Math.min(Number(limit)||200, 200));
      return db.prepare(`SELECT n.value_json, h.event_at, h.source_id, h.source_version
        FROM information_tree_information_heads h
        JOIN information_tree_nodes n ON n.workspace_id=h.workspace_id AND n.id=h.node_id
        WHERE h.workspace_id=? AND h.event_at>=? AND h.event_at<?
          AND (? IS NULL OR (h.event_at, h.source_id) > (?, ?))
        ORDER BY h.event_at, h.source_id LIMIT ?`).all(workspace, window.startAt, window.endAt, cursor?.eventAt ?? null, cursor?.eventAt ?? 0, cursor?.sourceId ?? '', safe)
        .map(row=>{const node=JSON.parse(row.value_json);return {...node,eventAt:row.event_at,sourceId:node.sourceId || row.source_id,headSourceVersion:row.source_version};});
    },
    countInformationInWindow(workspace, window) {
      return db.prepare(`SELECT COUNT(*) AS count FROM information_tree_information_heads
        WHERE workspace_id=? AND event_at>=? AND event_at<?`).get(workspace, window.startAt, window.endAt).count;
    },
    saveEditorial(workspace,value) {
      const editorial=DailyEditorialSchema.parse(value);
      return db.transaction(()=>{
        db.prepare('INSERT OR IGNORE INTO information_tree_editorials (workspace_id,id,start_at,value_json) VALUES (?,?,?,?)').run(workspace,editorial.id,editorial.window.startAt,JSON.stringify(editorial));
        const key=`${editorial.window.startAt}:${editorial.window.endAt}`;
        const head=db.prepare('SELECT published_id FROM information_tree_editorial_heads WHERE workspace_id=? AND period_key=?').get(workspace,key);
        const publishedId=editorial.status==='failed' ? head?.published_id || null : editorial.id;
        db.prepare('INSERT OR REPLACE INTO information_tree_editorial_heads (workspace_id,period_key,published_id) VALUES (?,?,?)').run(workspace,key,publishedId);
        emit('report.tree.editorial.saved.v1','daily-editorial',editorial.id,{status:editorial.status,published:publishedId===editorial.id},workspace);
        return this.getEditorial(workspace,editorial.id);
      })();
    },
    getEditorial:(workspace,id)=>read('information_tree_editorials',workspace,id),
    editorialForWindow(workspace,window) {
      const id=db.prepare('SELECT published_id FROM information_tree_editorial_heads WHERE workspace_id=? AND period_key=?').get(workspace,`${window.startAt}:${window.endAt}`)?.published_id;
      return id ? this.getEditorial(workspace,id) : null;
    },
    getReadingHour:(workspace,id)=>read('reading_hour_snapshots',workspace,id),
    readingHourHead(workspace,window,scope) {
      const id=db.prepare('SELECT published_id FROM reading_hour_heads WHERE workspace_id=? AND period_key=?').get(workspace,`${window.startAt}:${window.endAt}:${scope}`)?.published_id;
      return id ? this.getReadingHour(workspace,id) : null;
    },
    readingHoursForWindows(workspace, windows, scope = 'hour') {
      const keys = [];
      for (const window of windows || []) {
        const startAt = Number(window?.startAt);
        const endAt = Number(window?.endAt);
        if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) continue;
        keys.push(`${startAt}:${endAt}:${scope}`);
      }
      const snapshots = [];
      for (let offset = 0; offset < keys.length; offset += 200) {
        const slice = keys.slice(offset, offset + 200);
        const rows = db.prepare(`SELECT s.value_json AS valueJson
          FROM reading_hour_heads h
          JOIN reading_hour_snapshots s ON s.workspace_id = h.workspace_id AND s.id = h.published_id
          WHERE h.workspace_id = ? AND h.published_id IS NOT NULL
            AND h.period_key IN (${slice.map(() => '?').join(',')})`).all(workspace, ...slice);
        for (const row of rows) snapshots.push(JSON.parse(row.valueJson));
      }
      return snapshots;
    },
    listReadingHourHeads(workspace,window,scope='hour') {
      return db.prepare(`SELECT h.published_id AS id, s.value_json AS valueJson
        FROM reading_hour_heads h
        JOIN reading_hour_snapshots s ON s.workspace_id=h.workspace_id AND s.id=h.published_id
        WHERE h.workspace_id=? AND h.published_id IS NOT NULL AND s.start_at>=? AND s.start_at<?
          AND substr(h.period_key, length(h.period_key) - length(?)) = ':' || ?
        ORDER BY s.start_at DESC`).all(workspace,window.startAt,window.endAt,scope,scope);
    },
    publishReadingHour(workspace,snapshot) {
      return db.transaction(()=>{
        const key=`${snapshot.window.startAt}:${snapshot.window.endAt}:${snapshot.scope}`;
        const head=db.prepare('SELECT published_id FROM reading_hour_heads WHERE workspace_id=? AND period_key=?').get(workspace,key);
        const previous=head?.published_id ? this.getReadingHour(workspace,head.published_id) : null;
        const newerRoute=previous && snapshot.routeVersion!==previous.routeVersion && snapshot.candidates>=previous.candidates && snapshot.selected>0;
        const canPublish=!previous || snapshot.scored>previous.scored || (snapshot.status==='ready' && previous.status!=='ready') || newerRoute;
        db.prepare('INSERT OR IGNORE INTO reading_hour_snapshots (workspace_id,id,start_at,value_json) VALUES (?,?,?,?)').run(workspace,snapshot.id,snapshot.window.startAt,JSON.stringify(snapshot));
        db.prepare('INSERT OR REPLACE INTO reading_hour_heads (workspace_id,period_key,published_id,attempt_id) VALUES (?,?,?,?)').run(workspace,key,canPublish ? snapshot.id : previous.id,snapshot.id);
        emit('report.reading.hour.saved.v1','reading-hour',snapshot.id,{status:snapshot.status,published:canPublish,scored:snapshot.scored,candidates:snapshot.candidates},workspace);
        return {published:canPublish,snapshot:this.getReadingHour(workspace,canPublish ? snapshot.id : previous.id)};
      })();
    },
  };
}
