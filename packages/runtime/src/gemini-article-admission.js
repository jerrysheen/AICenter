import {previousDailyInstant,nextDailyInstant} from '../../domain/src/zoned-time.js';
import { createHash, randomUUID } from 'node:crypto';
import {resolveGoogleArticleModelPool} from '../../harness/src/llm-route.js';
import {nextGeminiDailyReset} from '../../connectors/src/gemini-grok-task.js';
import {emptyTokenUsage} from '../../contracts/src/model-usage.js';

const PACIFIC={timeZone:'America/Los_Angeles',hour:0,minute:0};
let probeFlight=null;

export function geminiKeySuffix(keyEnv) {
  const name=String(keyEnv || '');
  const digits=name.match(/(\d+)$/);
  if(digits)return `KEY${digits[1]}`;
  if(/GEMINI_API_KEY$/.test(name))return 'KEY';
  return name.slice(-12) || '-';
}

function singleProbe(task) {
  if(probeFlight)return probeFlight;
  probeFlight=(async()=>{try{return await task();}finally{probeFlight=null;}})();
  return probeFlight;
}

function dailyCooldown(until, at) {
  return until>=nextGeminiDailyReset(at)-60000 || until-at>=6*3600000;
}

export async function probeGeminiGenerate(env, {keyEnv, model, maxOutputTokens=1, prompt='1'}={}) {
  const key=String(env?.[keyEnv] || '').trim();
  if(!key)throw Object.assign(new Error('missing probe key'),{status:0});
  const root=String(env.AI_CENTER_GEMINI_API_ROOT || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/,'');
  const response=await fetch(`${root}/models/${encodeURIComponent(model)}:generateContent`,{
    method:'POST',headers:{'x-goog-api-key':key,'Content-Type':'application/json'},
    body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{maxOutputTokens}}),
    signal:AbortSignal.timeout(20000),
  });
  await response.arrayBuffer().catch(()=>{});
  return {ok:response.ok,status:response.status};
}

const integer = (env, name, fallback, min = 1) => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
};

// Project labels are quota identities, not credentials. Parallel account mode
// uses independent key buckets unless a shared project is explicitly configured.
// Legacy serial mode retains its conservative shared rate bucket.
export function resolveGeminiArticlePolicy(env = process.env) {
  const concurrency=integer(env,'AI_CENTER_GEMINI_ARTICLE_POOL_CONCURRENCY',1);
  if(concurrency>5)throw new Error('Gemini article concurrency must be <=5');
  const accountMode=concurrency>1;
  const names = String(env.AI_CENTER_GEMINI_KEY_ENVS || 'GEMINI_API_KEY,GEMINI_API_KEY2,GEMINI_API_KEY3,GEMINI_API_KEY4,GEMINI_API_KEY5').split(',').map(s => s.trim()).filter(Boolean);
  if (names.length > 5 || names.some(n => !/^[A-Z][A-Z0-9_]*$/.test(n))) throw new Error('invalid Gemini key environment names');
  const seen = new Set(), slots = [];
  for (const name of names) {
    const key = String(env[name] || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const configuredProject = String(env[`${name}_PROJECT`] || '').trim();
    const keyIdentity=createHash('sha256').update(`gemini-key:${key}`).digest('hex');
    const project = configuredProject ? createHash('sha256').update(configuredProject).digest('hex') : accountMode ? keyIdentity : createHash('sha256').update('shared-unverified').digest('hex');
    const cooldownKey = configuredProject ? project : keyIdentity;
    slots.push({ keyEnv: name, project, cooldownKey });
  }
  if (!slots.length) throw new Error('Gemini article task requires a configured API key');
  return {
    slots,concurrency,accountMode,models:resolveGoogleArticleModelPool(env),
    legacyProject:accountMode ? createHash('sha256').update('shared-unverified').digest('hex') : '',
    requestsPerDay:integer(env,'AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_DAY',2500),
    requestsPerKeyPerDay:integer(env,'AI_CENTER_GEMINI_ARTICLE_KEY_REQUESTS_PER_DAY',500),
    requestsPerHour: integer(env, 'AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_HOUR', accountMode ? 2500 : 60),
    requestsPerMinute: integer(env, 'AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_MINUTE', accountMode ? 20 : 6),
    minIntervalMs: integer(env, 'AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS', accountMode ? 3000 : 10000),
    // Reservations are conservative local estimates, separate from supplier usage.
    estimatedTokensPerMinute: integer(env, 'AI_CENTER_GEMINI_ARTICLE_ESTIMATED_TOKENS_PER_MINUTE', 100000),
    probeMs:integer(env,'AI_CENTER_GEMINI_QUOTA_PROBE_MS',12*60*1000),
    dailyProbeMs:integer(env,'AI_CENTER_GEMINI_QUOTA_PROBE_DAILY_MS',30*60*1000),
    idleAfterMs:integer(env,'AI_CENTER_GEMINI_KEY_IDLE_MS',30*60*1000,0),
  };
}

export function createGeminiArticleAdmission({ repository, usage, env = process.env, now = Date.now, models, allowFallback = true, modelOrder='round-robin', log=console.log }) {
  if (!repository?.reserve) throw new Error('Gemini article admission requires a persistent quota repository');
  const policy = resolveGeminiArticlePolicy(env);
  if(models!==undefined)policy.models=[...models];
  if(!allowFallback)env={...env,AI_CENTER_HARNESS_ARTICLE_FALLBACK:'none'};
  const opened=now();
  repository.repairDailyCooldowns?.({at:opened,nextReset:nextGeminiDailyReset(opened),dayStart:previousDailyInstant(opened,PACIFIC)});
  let modelCursor=0;
  const probeMemory=new Map();
  const request=(model,estimatedTokens,dryRun=false,keyEnv)=>{
    const at=now();
    const slots=keyEnv===undefined ? policy.slots : policy.slots.filter(s=>s.keyEnv===keyEnv);
    if(!slots.length)throw new Error('Google article key is not configured');
    return repository.reserve({...policy,slots,model,at,estimatedTokens,dryRun,balance:'least-used',idleAfterMs:policy.idleAfterMs,
      dayStart:previousDailyInstant(at,PACIFIC),dayEnd:nextDailyInstant(at,PACIFIC),
      ...(policy.accountMode ? {} : {requestsPerDay:Infinity,requestsPerKeyPerDay:Infinity})});
  };
  function waitMessage(results,retryAt){
    const at=now();
    const names=[...new Set(results.map(item=>item.model).filter(Boolean))];
    const blocks=(repository.listCooldowns?.(at)||[]).filter(block=>names.includes(block.model));
    const suffixes=[...new Set(blocks.map(block=>{
      const slot=policy.slots.find(item=>(item.cooldownKey||item.project)===block.project);
      return slot?geminiKeySuffix(slot.keyEnv):'';
    }).filter(Boolean))];
    const label=blocks.length?(blocks.some(block=>dailyCooldown(block.untilAt,at))?'daily':'rate'):'window';
    return `quota=${label} key=${suffixes.join(',')||'-'} model=${names.join(',')||'-'} cooldownUntil=${Number.isFinite(retryAt)?retryAt:0} Gemini 文章任务等待流量窗口`;
  }
  return {
    policy,
    nextReadyAt(model) {const results=(policy.models.length ? policy.models : [model]).map(m=>request(m,6144+8192,true));if(results.some(r=>r.admitted))return now();if(results.every(r=>r.quotaExhausted) && env.AI_CENTER_HARNESS_ARTICLE_FALLBACK==='elucid-grok'){const f=repository.reserve({...policy,accountMode:false,requestsPerDay:Infinity,requestsPerKeyPerDay:Infinity,slots:[{project:'article-fallback-elucid',keyEnv:'ELUCID_GROK_API_KEY'}],model:env.AI_CENTER_HARNESS_ARTICLE_FALLBACK_MODEL || 'grok-4.7',at:now(),estimatedTokens:6144+8192,dryRun:true});return f.admitted ? now() : f.retryAt;}return Math.min(...results.map(r=>r.retryAt));},
    release(ticket){repository.release?.(ticket);},
    reserve({ model, keyEnv, inputBytes, maxTokens, useModelPool=false }) {
      const pool=useModelPool && policy.models.length ? policy.models : [model],results=[];
      const ordered=modelOrder==='ordered';
      for(let i=0;i<pool.length;i++){
        const index=ordered?i:(modelCursor+i)%pool.length,chosen=pool[index],result=request(chosen,inputBytes+maxTokens+8192,false,keyEnv);
        if(result.admitted){if(useModelPool && !ordered)modelCursor=(index+1)%pool.length;return result;}
        results.push({...result,model:chosen});
      }
      const result={retryAt:Math.min(...results.map(r=>r.retryAt)),quotaExhausted:results.every(r=>r.quotaExhausted)};
      if (!result.admitted) throw Object.assign(new Error(waitMessage(results,result.retryAt)), { code: 'budget-deferred', retryAt: result.retryAt, quotaExhausted:result.quotaExhausted===true });
      return result;
    },
    reserveFallback({model,inputBytes,maxTokens}) {
      const result=repository.reserve({...policy,accountMode:false,requestsPerDay:Infinity,requestsPerKeyPerDay:Infinity,slots:[{project:'article-fallback-elucid',keyEnv:'ELUCID_GROK_API_KEY'}],model,at:now(),estimatedTokens:inputBytes+maxTokens+8192});
      if(!result.admitted)throw Object.assign(new Error('文章 fallback 等待流量窗口'),{code:'budget-deferred',retryAt:result.retryAt});
      return result;
    },
    failed(ticket, error) {
      // The next admitted task tries another eligible key after global pacing.
      // Daily quota waits until Pacific midnight. A short RetryInfo does not extend that.
      // Other 429s keep the supplier delay and are never shortened.
      if (/429|quota|RESOURCE_EXHAUSTED/i.test(String(error?.message || error?.code))) {
        const message=String(error?.message || '');
        const seconds=message.match(/retryDelay[^0-9]*(\d+(?:\.\d+)?)s/i);
        const daily=/PerDay|per_day|daily/i.test(message);
        const retryAt=daily ? nextGeminiDailyReset(now()) : now()+Math.max(60000,seconds ? Math.ceil(Number(seconds[1])*1000) : 60000);
        const cooldownKey=ticket.cooldownKey || ticket.project;
        if(daily)repository.setCooldown(cooldownKey,ticket.model,retryAt);
        else repository.cooldown(cooldownKey,ticket.model,retryAt);
        error.code='budget-deferred';
        if(/429/.test(message) && !Number.isInteger(error.status))error.status=429;
        const note=`quota=${daily?'daily':'rate'} key=${geminiKeySuffix(ticket.keyEnv)} model=${ticket.model || ''} cooldownUntil=${retryAt}`;
        if(!String(error.message).includes('cooldownUntil='))error.message=`${note} ${message}`;
        const alternatives=policy.slots.filter(s=>(s.cooldownKey||s.project)!==cooldownKey);
        error.retryAt=alternatives.length || env.AI_CENTER_HARNESS_ARTICLE_FALLBACK==='elucid-grok' ? now()+policy.minIntervalMs : retryAt;
        error.providerQuota=true;
      }
    },
    nextProbeTarget() {
      const at=now();
      const due=[];
      for(const block of repository.listCooldowns?.(at)||[]){
        const slot=policy.slots.find(item=>(item.cooldownKey||item.project)===block.project);
        if(!slot)continue;
        const suffix=geminiKeySuffix(slot.keyEnv);
        const stored=usage?.latestMatching?.('local',{stage:'quota-probe',applicationSessionId:suffix,model:block.model})||0;
        const last=Math.max(probeMemory.get(`${slot.keyEnv}\0${block.model}`)||0,stored);
        const interval=dailyCooldown(block.untilAt,at)?policy.dailyProbeMs:policy.probeMs;
        if(last && at-last<interval)continue;
        due.push({keyEnv:slot.keyEnv,project:slot.project,cooldownKey:slot.cooldownKey||slot.project,model:block.model,untilAt:block.untilAt,lastProbeAt:last});
      }
      due.sort((a,b)=>a.lastProbeAt-b.lastProbeAt);
      return due[0]||null;
    },
    runProbe(target,{generate,env:probeEnv=env,log:probeLog=log}={}) {
      return executeProbe({repository,usage,now,memory:probeMemory,target,generate,env:probeEnv,log:probeLog});
    },
    probeOnce(options={}){return probeGeminiQuota([this],{...options,env:options.env||env,log:options.log||log});},
  };
}

async function executeProbe({repository,usage,now,memory,target,generate,env,log}){
  const at=now();
  memory.set(`${target.keyEnv}\0${target.model}`,at);
  const generateFn=generate||(spec=>probeGeminiGenerate(env,spec));
  let status=0,ok=false;
  try{
    const result=await generateFn({keyEnv:target.keyEnv,model:target.model,maxOutputTokens:1,prompt:'1'});
    status=Number.isInteger(result?.status)?result.status:(result?.ok===false?0:200);
    ok=result?.ok!==false && status>=200 && status<300;
  }catch(error){
    status=Number.isInteger(error?.status)?error.status:0;
    ok=false;
  }
  let lifted=false;
  if(ok){repository.clearCooldown(target.cooldownKey,target.model);lifted=true;}
  repository.recordProbeUse?.({project:target.project,keyEnv:target.keyEnv,model:target.model,at});
  const suffix=geminiKeySuffix(target.keyEnv);
  try{usage?.save?.({id:`quota-probe:${randomUUID()}`,workspaceId:'local',kind:'request',jobId:`probe:${status}:${lifted?'lifted':'kept'}`,jobAttempt:null,
    stage:'quota-probe',applicationSessionId:suffix,harnessSessionId:'',turn:null,step:null,attempt:null,provider:'google',model:target.model,
    status:ok?'succeeded':'failed',completeness:'complete',usage:{...emptyTokenUsage(),inputTokens:1,outputTokens:ok?1:0,totalTokens:ok?2:1},
    occurredAt:at,supplierAmount:null,supplierCurrency:null});}catch{/* 用量写入失败仍保留探针日志 */}
  log(`[worker] gemini quota probe key=${suffix} model=${target.model} ok=${ok?1:0} status=${status} lifted=${lifted?1:0}`);
  return {keySuffix:suffix,model:target.model,ok,status,lifted};
}

export function probeGeminiQuota(admissions,{env=process.env,log=console.log,generate}={}){
  return singleProbe(async()=>{
    const found=[];
    for(const admission of admissions||[]){
      const target=admission?.nextProbeTarget?.();
      if(target)found.push({admission,target});
    }
    if(!found.length)return null;
    found.sort((a,b)=>a.target.lastProbeAt-b.target.lastProbeAt);
    return found[0].admission.runProbe(found[0].target,{generate,env,log});
  });
}

export function startGeminiQuotaProbe(admissions,{env=process.env,intervalMs=60_000,log=console.log}={}){
  const list=(admissions||[]).filter(Boolean);
  if(!list.length || String(env.AI_CENTER_GEMINI_QUOTA_PROBE||'')==='0')return {stop(){}};
  const timer=setInterval(()=>{probeGeminiQuota(list,{env,log}).catch(error=>log(`[worker] gemini quota probe failed ${String(error?.message||error).slice(0,200)}`));},intervalMs);
  timer.unref?.();
  return {stop(){clearInterval(timer);}};
}
