import {TreeNodeSchema,TreeEditionSchema,isUnavailableTreeText} from '../../../contracts/src/information-tree.js';
import {DailyEditorialSchema} from '../../../contracts/src/daily-editorial.js';

function indexEdition(row,prefix,hasEditorial) {
  const id=row[`${prefix}_id`];
  if(!id) return null;
  return {id,layer:row.layer,window:{startAt:Number(row[`${prefix}_start`]),endAt:Number(row[`${prefix}_end`])},status:row[`${prefix}_status`],generatedAt:Number(row[`${prefix}_generated`]),rootCount:Number(row[`${prefix}_roots`] || 0),hasEditorial};
}

export function createInformationTreeRepository(db,emit) {
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
    listInformation(workspace,window) {
      return db.prepare('SELECT node_id FROM information_tree_information_heads WHERE workspace_id=? AND event_at>=? AND event_at<? ORDER BY event_at,source_id').all(workspace,window.startAt,window.endAt).map(r=>this.getNode(workspace,r.node_id));
    },
    setInformationHead(workspace,node,policyHash) {
      return db.transaction(()=>{
        if(this.policy(workspace)!==policyHash)return false;
        const before=this.informationHead(workspace,node.sourceId)?.node;
        if(before && (before.sourceUpdatedAt || 0)>(node.sourceUpdatedAt || 0))return false;
        if(before?.id===node.id)return true;
        db.prepare('INSERT OR REPLACE INTO information_tree_information_heads VALUES (?,?,?,?,?,?)').run(workspace,node.sourceId,node.id,node.sourceVersion || '',node.eventAt || node.window.startAt,node.sourceUpdatedAt || 0);
        emit('report.tree.information.ready.v1','information-tree',node.id,{sourceId:node.sourceId},workspace);return true;
      })();
    },
    getNode:(workspace,id)=>read('information_tree_nodes',workspace,id),
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
        db.prepare('INSERT OR IGNORE INTO information_tree_editions VALUES (?,?,?)').run(workspace,edition.id,JSON.stringify(edition));
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
        emit('report.tree.edition.saved.v1','information-tree',edition.id,{layer:edition.layer,status:edition.status,published:canPublish,...(!validPrevious ? {reason:prematureEmpty ? 'previous-premature-empty' : 'previous-needs-content-is-not-valid-content'} : {})},workspace);
        return {...edition,published:canPublish,...(!policyAllowed || !headAllowed ? {stale:true} : {})};
      })();
    },
    list(workspace,startAt,endAt,layer='hourly') {
      return db.prepare('SELECT published_id,attempt_id FROM information_tree_heads WHERE workspace_id=? AND layer=? AND start_at>=? AND start_at<? ORDER BY start_at DESC').all(workspace,layer,startAt,endAt)
        .map(row=>({edition:row.published_id ? this.getEdition(workspace,row.published_id) : null,attempt:this.getEdition(workspace,row.attempt_id)}));
    },
    listInformationIndex(workspace,window) {
      return db.prepare(`SELECT h.node_id AS id,
        COALESCE(json_extract(n.value_json, '$.eventAt'), h.event_at) AS eventAt,
        json_extract(n.value_json, '$.window.startAt') AS windowStart,
        json_extract(n.value_json, '$.window.endAt') AS windowEnd,
        json_extract(n.value_json, '$.validatorVersion') AS validatorVersion
        FROM information_tree_information_heads h
        JOIN information_tree_nodes n ON n.workspace_id=h.workspace_id AND n.id=h.node_id
        WHERE h.workspace_id=? AND h.event_at>=? AND h.event_at<?
        ORDER BY h.event_at, h.source_id`).all(workspace,window.startAt,window.endAt).map(row=>({
        id:row.id,eventAt:Number(row.eventAt),window:{startAt:Number(row.windowStart),endAt:Number(row.windowEnd)},
        ...(row.validatorVersion ? {validatorVersion:row.validatorVersion} : {}),
      }));
    },
    listEditionIndex(workspace,startAt,endAt,layer='hourly') {
      return db.prepare(`SELECT h.layer AS layer,
        json_extract(p.value_json, '$.id') AS published_id,
        json_extract(p.value_json, '$.status') AS published_status,
        json_extract(p.value_json, '$.generatedAt') AS published_generated,
        json_extract(p.value_json, '$.window.startAt') AS published_start,
        json_extract(p.value_json, '$.window.endAt') AS published_end,
        COALESCE(json_array_length(p.value_json, '$.roots'), 0) AS published_roots,
        json_extract(a.value_json, '$.id') AS attempt_id,
        json_extract(a.value_json, '$.status') AS attempt_status,
        json_extract(a.value_json, '$.generatedAt') AS attempt_generated,
        json_extract(a.value_json, '$.window.startAt') AS attempt_start,
        json_extract(a.value_json, '$.window.endAt') AS attempt_end,
        COALESCE(json_array_length(a.value_json, '$.roots'), 0) AS attempt_roots,
        CASE WHEN e.published_id IS NOT NULL THEN 1 ELSE 0 END AS has_editorial
        FROM information_tree_heads h
        LEFT JOIN information_tree_editions p ON p.workspace_id=h.workspace_id AND p.id=h.published_id
        LEFT JOIN information_tree_editions a ON a.workspace_id=h.workspace_id AND a.id=h.attempt_id
        LEFT JOIN information_tree_editorial_heads e ON e.workspace_id=h.workspace_id AND e.published_id IS NOT NULL
          AND e.period_key = (CAST(json_extract(COALESCE(p.value_json, a.value_json), '$.window.startAt') AS TEXT) || ':' || CAST(json_extract(COALESCE(p.value_json, a.value_json), '$.window.endAt') AS TEXT))
        WHERE h.workspace_id=? AND h.layer=? AND h.start_at>=? AND h.start_at<?
        ORDER BY h.start_at DESC`).all(workspace,layer,startAt,endAt).map(row=>{
        const hasEditorial=row.has_editorial===1;
        return {edition:indexEdition(row,'published',hasEditorial),attempt:indexEdition(row,'attempt',hasEditorial)};
      });
    },
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
