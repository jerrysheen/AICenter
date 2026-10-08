import {previousDailyInstant,nextDailyInstant} from '../../domain/src/zoned-time.js';
import { createHash } from 'node:crypto';
import {resolveGoogleArticleModelPool} from '../../harness/src/llm-route.js';

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
  };
}

export function createGeminiArticleAdmission({ repository, env = process.env, now = Date.now, models, allowFallback = true }) {
  if (!repository?.reserve) throw new Error('Gemini article admission requires a persistent quota repository');
  const policy = resolveGeminiArticlePolicy(env);
  if(models!==undefined)policy.models=[...models];
  if(!allowFallback)env={...env,AI_CENTER_HARNESS_ARTICLE_FALLBACK:'none'};
  let modelCursor=0;
  const request=(model,estimatedTokens,dryRun=false,keyEnv)=>{const at=now(),spec={timeZone:'America/Los_Angeles',hour:0,minute:0};const slots=keyEnv===undefined ? policy.slots : policy.slots.filter(s=>s.keyEnv===keyEnv);if(!slots.length)throw new Error('Google article key is not configured');return repository.reserve({...policy,slots,model,at,estimatedTokens,dryRun,...(policy.accountMode ? {dayStart:previousDailyInstant(at,spec),dayEnd:nextDailyInstant(at,spec)} : {requestsPerDay:Infinity,requestsPerKeyPerDay:Infinity})});};
  return {
    policy,
    nextReadyAt(model) {const results=(policy.models.length ? policy.models : [model]).map(m=>request(m,6144+8192,true));if(results.some(r=>r.admitted))return now();if(results.every(r=>r.quotaExhausted) && env.AI_CENTER_HARNESS_ARTICLE_FALLBACK==='elucid-grok'){const f=repository.reserve({...policy,accountMode:false,requestsPerDay:Infinity,requestsPerKeyPerDay:Infinity,slots:[{project:'article-fallback-elucid',keyEnv:'ELUCID_GROK_API_KEY'}],model:env.AI_CENTER_HARNESS_ARTICLE_FALLBACK_MODEL || 'grok-4.7',at:now(),estimatedTokens:6144+8192,dryRun:true});return f.admitted ? now() : f.retryAt;}return Math.min(...results.map(r=>r.retryAt));},
    release(ticket){repository.release?.(ticket);},
    reserve({ model, keyEnv, inputBytes, maxTokens, useModelPool=false }) {
      const models=useModelPool && policy.models.length ? policy.models : [model],results=[];
      for(let i=0;i<models.length;i++){
        const index=(modelCursor+i)%models.length,result=request(models[index],inputBytes+maxTokens+8192,false,keyEnv);
        if(result.admitted){if(useModelPool)modelCursor=(index+1)%models.length;return result;}
        results.push(result);
      }
      const result={retryAt:Math.min(...results.map(r=>r.retryAt)),quotaExhausted:results.every(r=>r.quotaExhausted)};
      if (!result.admitted) throw Object.assign(new Error('Gemini 文章任务等待流量窗口'), { code: 'budget-deferred', retryAt: result.retryAt, quotaExhausted:result.quotaExhausted===true });
      return result;
    },
    reserveFallback({model,inputBytes,maxTokens}) {
      const result=repository.reserve({...policy,accountMode:false,requestsPerDay:Infinity,requestsPerKeyPerDay:Infinity,slots:[{project:'article-fallback-elucid',keyEnv:'ELUCID_GROK_API_KEY'}],model,at:now(),estimatedTokens:inputBytes+maxTokens+8192});
      if(!result.admitted)throw Object.assign(new Error('文章 fallback 等待流量窗口'),{code:'budget-deferred',retryAt:result.retryAt});
      return result;
    },
    failed(ticket, error) {
      // The next admitted task tries another eligible key after global pacing.
      // Only explicitly known same-project keys share supplier cooldowns.
      if (/429|quota|RESOURCE_EXHAUSTED/i.test(String(error?.message || error?.code))) {
        const message=String(error?.message || '');
        // Harness may wrap Google JSON inside escaped transport JSON. This field
        // survives either representation; never shorten the supplier's delay.
        const seconds=message.match(/retryDelay[^0-9]*(\d+(?:\.\d+)?)s/i);
        const daily=/PerDay|per_day|daily/i.test(message);
        const retryAt=now()+Math.max(60000,seconds ? Math.ceil(Number(seconds[1])*1000) : daily ? 86400000 : 60000);
        repository.cooldown(ticket.cooldownKey || ticket.project, ticket.model, retryAt);
        error.code='budget-deferred';
        const alternatives=policy.slots.filter(s=>s.cooldownKey!==(ticket.cooldownKey || ticket.project));
        error.retryAt=alternatives.length || env.AI_CENTER_HARNESS_ARTICLE_FALLBACK==='elucid-grok' ? now()+policy.minIntervalMs : retryAt;
        error.providerQuota=true;
      }
    },
  };
}
