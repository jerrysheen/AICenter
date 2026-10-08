import { randomUUID } from 'node:crypto';

export function createModelQuotaRepository(database, emitEvent) {
  return Object.freeze({
    reserve({ slots, model, at, requestsPerHour, requestsPerMinute, minIntervalMs, estimatedTokensPerMinute, estimatedTokens, accountMode=false, requestsPerDay=Infinity, requestsPerKeyPerDay=Infinity, dayStart=at, dayEnd=at+86400000, legacyProject='', dryRun=false, pacingModels=[] }) {
      return database.transaction(() => {
        const global = accountMode
          ? database.prepare('SELECT at FROM model_quota_reservations WHERE model=? AND at>? ORDER BY at').all(model,at-3600000)
          : database.prepare('SELECT at FROM model_quota_reservations WHERE at>? ORDER BY at').all(at-3600000);
        if(global.length>=requestsPerHour)return {admitted:false,retryAt:global[0].at+3600000};
        const day=database.prepare('SELECT project,at FROM model_quota_reservations WHERE model=? AND at>=? AND at<? ORDER BY at').all(model,dayStart,dayEnd);
        if(day.length>=requestsPerDay)return {admitted:false,retryAt:dayEnd};
        const latest=global.at(-1)?.at;
        if(!accountMode && latest!==undefined && at<latest+minIntervalMs)return {admitted:false,retryAt:latest+minIntervalMs};
        let retryAt=Infinity,cooldownCount=0;
        const ordered=accountMode ? [...slots].sort((a,b)=>{
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
          const minute=database.prepare('SELECT at,estimated_tokens FROM model_quota_reservations WHERE project=? AND model=? AND at>? ORDER BY at').all(slot.project,model,at-60000);
          const requestMinute=pacingModels.length ? database.prepare('SELECT at FROM model_quota_reservations WHERE project=? AND model IN (SELECT value FROM json_each(?)) AND at>? ORDER BY at').all(slot.project,JSON.stringify(pacingModels),at-60000) : minute;
          if(requestMinute.length>=requestsPerMinute || minute.reduce((n,r)=>n+r.estimated_tokens,0)+estimatedTokens>estimatedTokensPerMinute){
            const rows=requestMinute.length>=requestsPerMinute ? requestMinute : minute;
            retryAt=Math.min(retryAt,rows.length ? rows[0].at+60000 : at+3600000);continue;
          }
          if(dryRun)return {admitted:true,project:slot.project,model,keyEnv:slot.keyEnv};
          const id=randomUUID();
          database.prepare('INSERT INTO model_quota_reservations(id,project,model,at,estimated_tokens) VALUES(?,?,?,?,?)').run(id,slot.project,model,at,estimatedTokens);
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
  });
}
