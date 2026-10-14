import { randomUUID } from 'node:crypto';

export function createModelQuotaRepository(database, emitEvent) {
  return Object.freeze({
    reserve({ slots, model, at, requestsPerHour, requestsPerMinute, minIntervalMs, estimatedTokensPerMinute, estimatedTokens, accountMode=false, requestsPerDay=Infinity, requestsPerKeyPerDay=Infinity, dayStart=at, dayEnd=at+86400000, legacyProject='', dryRun=false, pacingModels=[], balance='', idleAfterMs=0 }) {
      return database.transaction(() => {
        const global = accountMode
          ? database.prepare('SELECT at FROM model_quota_reservations WHERE model=? AND at>? ORDER BY at').all(model,at-3600000)
          : database.prepare('SELECT at FROM model_quota_reservations WHERE at>? ORDER BY at').all(at-3600000);
        if(global.length>=requestsPerHour)return {admitted:false,retryAt:global[0].at+3600000};
        const dayModels=JSON.stringify(pacingModels.length?pacingModels:[model]);
        const day=database.prepare('SELECT project,at FROM model_quota_reservations WHERE model IN (SELECT value FROM json_each(?)) AND at>=? AND at<? ORDER BY at').all(dayModels,dayStart,dayEnd);
        if(day.length>=requestsPerDay)return {admitted:false,retryAt:dayEnd};
        const latest=global.at(-1)?.at;
        if(!accountMode && latest!==undefined && at<latest+minIntervalMs)return {admitted:false,retryAt:latest+minIntervalMs};
        let retryAt=Infinity,cooldownCount=0;
        const ordered=balance==='least-used' ? leastUsed(database,slots,model,at,dayStart,dayEnd,idleAfterMs) : accountMode ? [...slots].sort((a,b)=>{
          const rows=p=>day.filter(r=>r.project===p);
          return rows(a.project).length-rows(b.project).length || (rows(a.project).at(-1)?.at || 0)-(rows(b.project).at(-1)?.at || 0);
        }) : slots;
        for(const slot of ordered) {
          const cooldownKey=slot.cooldownKey || slot.project;
          const block=database.prepare('SELECT until_at FROM model_quota_cooldowns WHERE project=? AND model=?').get(cooldownKey,model);
          if(block?.until_at>at){cooldownCount++;retryAt=Math.min(retryAt,block.until_at);continue;}
          const keyDay=day.filter(r=>r.project===slot.project || (legacyProject && r.project===legacyProject));
          if(keyDay.length>=requestsPerKeyPerDay){retryAt=Math.min(retryAt,dayEnd);continue;}
          if(accountMode){
            const lease=database.prepare('SELECT until_at FROM model_quota_leases WHERE project=? AND model=?').get(slot.project,model);
            if(lease?.until_at>at){retryAt=Math.min(retryAt,lease.until_at);continue;}
            const last=pacingModels.length ? database.prepare('SELECT MAX(at) at FROM model_quota_reservations WHERE project=? AND model IN (SELECT value FROM json_each(?))').get(slot.project,JSON.stringify(pacingModels)).at : keyDay.at(-1)?.at;
            if(last!==undefined && at<last+minIntervalMs){retryAt=Math.min(retryAt,last+minIntervalMs);continue;}
          }
          const pace=JSON.stringify(pacingModels.length?pacingModels:[model]);
          const minute=database.prepare('SELECT at,estimated_tokens FROM model_quota_reservations WHERE project=? AND model IN (SELECT value FROM json_each(?)) AND at>? ORDER BY at').all(slot.project,pace,at-60000);
          if(minute.length>=requestsPerMinute || minute.reduce((n,r)=>n+r.estimated_tokens,0)+estimatedTokens>estimatedTokensPerMinute){
            retryAt=Math.min(retryAt,minute.length ? minute[0].at+60000 : at+3600000);continue;
          }
          if(dryRun)return {admitted:true,project:slot.project,model,keyEnv:slot.keyEnv};
          const id=randomUUID();
          database.prepare('INSERT INTO model_quota_reservations(id,project,model,at,estimated_tokens,key_env) VALUES(?,?,?,?,?,?)').run(id,slot.project,model,at,estimatedTokens,slot.keyEnv || '');
          if(accountMode)database.prepare('INSERT INTO model_quota_leases(project,model,owner,until_at) VALUES(?,?,?,?) ON CONFLICT(project,model) DO UPDATE SET owner=excluded.owner,until_at=excluded.until_at').run(slot.project,model,id,at+240000);
          emitEvent('runtime.model-quota.reserved.v1','model-quota',id,{model,at},'local');
          return {admitted:true,id,project:slot.project,cooldownKey,model,keyEnv:slot.keyEnv};
        }
        return {admitted:false,retryAt,quotaExhausted:cooldownCount===slots.length};
      }).immediate();
    },
    release(ticket) {
      database.transaction(()=>{
        const result=database.prepare('DELETE FROM model_quota_leases WHERE project=? AND model=? AND owner=?').run(ticket.project,ticket.model,ticket.id);
        if(result.changes)emitEvent('runtime.model-quota.released.v1','model-quota',ticket.id,{model:ticket.model},'local');
      }).immediate();
    },
    cooldown(project,model,untilAt) {
      database.transaction(()=>{
        database.prepare('INSERT INTO model_quota_cooldowns(project,model,until_at) VALUES(?,?,?) ON CONFLICT(project,model) DO UPDATE SET until_at=MAX(until_at,excluded.until_at)').run(project,model,untilAt);
        emitEvent('runtime.model-quota.cooldown.v1','model-quota',model,{untilAt},'local');
      }).immediate();
    },
    setCooldown(project,model,untilAt) {
      database.prepare('INSERT INTO model_quota_cooldowns(project,model,until_at) VALUES(?,?,?) ON CONFLICT(project,model) DO UPDATE SET until_at=excluded.until_at').run(project,model,untilAt);
    },
    clearCooldown(project,model) {
      database.prepare('DELETE FROM model_quota_cooldowns WHERE project=? AND model=?').run(project,model);
    },
    listCooldowns(at) {
      return database.prepare('SELECT project,model,until_at FROM model_quota_cooldowns WHERE until_at>?').all(at)
        .map(row => ({project:row.project, model:row.model, untilAt:row.until_at}));
    },
    // A +24h daily block can still be in the future after Pacific midnight. Cap anything past
    // the next reset, and drop a long block whose implied start is already a previous quota day.
    repairDailyCooldowns({at, nextReset, dayStart}) {
      const slack=2*3600000, long=12*3600000;
      return database.transaction(()=>{
        let changed=0;
        for(const row of database.prepare('SELECT project,model,until_at FROM model_quota_cooldowns').all()){
          if(row.until_at<=at || (row.until_at-at>=long && row.until_at-86400000<dayStart-slack)){
            database.prepare('DELETE FROM model_quota_cooldowns WHERE project=? AND model=?').run(row.project,row.model);
            changed++;
          }else if(row.until_at>nextReset){
            database.prepare('UPDATE model_quota_cooldowns SET until_at=? WHERE project=? AND model=?').run(nextReset,row.project,row.model);
            changed++;
          }
        }
        return changed;
      }).immediate();
    },
    recordActualTokens(id, tokens) {
      if (!id || !Number.isInteger(tokens) || tokens < 1) return 0;
      return database.prepare('UPDATE model_quota_reservations SET estimated_tokens=? WHERE id=?').run(tokens, id).changes;
    },
    recordProbeUse({project,keyEnv,model,at}) {
      database.prepare('INSERT INTO model_quota_reservations(id,project,model,at,estimated_tokens,key_env) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(),project,model,at,1,keyEnv || '');
    },
    pairUsage({ models, dayStart, dayEnd }) {
      const rows = database.prepare(`SELECT model, key_env AS keyEnv, COUNT(*) AS n, MAX(at) AS last
        FROM model_quota_reservations
        WHERE model IN (SELECT value FROM json_each(?)) AND at>=? AND at<? AND key_env!=''
        GROUP BY model, key_env`).all(JSON.stringify(models), dayStart, dayEnd);
      const seen = database.prepare(`SELECT key_env AS keyEnv, MAX(at) AS last
        FROM model_quota_reservations WHERE key_env!='' GROUP BY key_env`).all();
      return { rows, seen };
    },
    readModelCursor(poolKey) {
      const row = database.prepare('SELECT models_json, cursor FROM gemini_model_cursors WHERE pool_key=?').get(poolKey);
      if (!row || !Number.isInteger(row.cursor)) return null;
      try {
        const models = JSON.parse(row.models_json);
        if (!Array.isArray(models) || models.some((model) => typeof model !== 'string')) return null;
        return { models, cursor: row.cursor };
      } catch { return null; }
    },
    writeModelCursor(poolKey, models, cursor, at) {
      database.prepare(`INSERT INTO gemini_model_cursors(pool_key, models_json, cursor, updated_at) VALUES(?,?,?,?)
        ON CONFLICT(pool_key) DO UPDATE SET models_json=excluded.models_json, cursor=excluded.cursor, updated_at=excluded.updated_at`)
        .run(poolKey, JSON.stringify(models), cursor, at);
    },
  });
}

function leastUsed(database, slots, model, at, dayStart, dayEnd, idleAfterMs) {
  const usage=database.prepare(`SELECT key_env,COUNT(*) n,MAX(at) last FROM model_quota_reservations
    WHERE model=? AND at>=? AND at<? AND key_env!='' GROUP BY key_env`).all(model,dayStart,dayEnd);
  const seen=database.prepare(`SELECT key_env,MAX(at) last FROM model_quota_reservations WHERE key_env!='' GROUP BY key_env`).all();
  const count=new Map(usage.map(row=>[row.key_env,row.n]));
  const todayLast=new Map(usage.map(row=>[row.key_env,row.last]));
  const last=new Map(seen.map(row=>[row.key_env,row.last]));
  return slots.map((slot,index)=>({slot,index})).sort((a,b)=>{
    const idle=item=>{
      const used=last.get(item.slot.keyEnv)||0;
      return idleAfterMs>0 && (used===0 || at-used>=idleAfterMs);
    };
    if(idle(a)!==idle(b))return idle(a)?-1:1;
    return (count.get(a.slot.keyEnv)||0)-(count.get(b.slot.keyEnv)||0)
      || (todayLast.get(a.slot.keyEnv)||0)-(todayLast.get(b.slot.keyEnv)||0)
      || a.index-b.index;
  }).map(item=>item.slot);
}
