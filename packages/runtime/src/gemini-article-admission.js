import { createHash } from 'node:crypto';

const integer = (env, name, fallback, min = 1) => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
};

// Project labels are quota identities, not credentials. Unspecified projects share
// one conservative rate bucket. An observed rejection only cools that key until
// project membership is explicitly known; untested keys remain eligible.
export function resolveGeminiArticlePolicy(env = process.env) {
  const names = String(env.AI_CENTER_GEMINI_KEY_ENVS || 'GEMINI_API_KEY,GEMINI_API_KEY2,GEMINI_API_KEY3').split(',').map(s => s.trim()).filter(Boolean);
  if (names.length > 3 || names.some(n => !/^[A-Z][A-Z0-9_]*$/.test(n))) throw new Error('invalid Gemini key environment names');
  const seen = new Set(), slots = [];
  for (const name of names) {
    const key = String(env[name] || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const configuredProject = String(env[`${name}_PROJECT`] || '').trim();
    const project = createHash('sha256').update(configuredProject || 'shared-unverified').digest('hex');
    const cooldownKey = configuredProject ? project : createHash('sha256').update(`gemini-key:${key}`).digest('hex');
    slots.push({ keyEnv: name, project, cooldownKey });
  }
  if (!slots.length) throw new Error('Gemini article task requires a configured API key');
  return {
    slots,
    requestsPerHour: integer(env, 'AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_HOUR', 60),
    requestsPerMinute: integer(env, 'AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_MINUTE', 6),
    minIntervalMs: integer(env, 'AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS', 10000),
    // Reservations are conservative local estimates, separate from supplier usage.
    estimatedTokensPerMinute: integer(env, 'AI_CENTER_GEMINI_ARTICLE_ESTIMATED_TOKENS_PER_MINUTE', 100000),
  };
}

export function createGeminiArticleAdmission({ repository, env = process.env, now = Date.now }) {
  if (!repository?.reserve) throw new Error('Gemini article admission requires a persistent quota repository');
  const policy = resolveGeminiArticlePolicy(env);
  return {
    reserve({ model, inputBytes, maxTokens }) {
      const result = repository.reserve({ ...policy, model, at: now(), estimatedTokens: inputBytes + maxTokens + 8192 });
      if (!result.admitted) throw Object.assign(new Error('Gemini 文章任务等待流量窗口'), { code: 'budget-deferred', retryAt: result.retryAt, quotaExhausted:result.quotaExhausted===true });
      return result;
    },
    reserveFallback({model,inputBytes,maxTokens}) {
      const result=repository.reserve({...policy,slots:[{project:'article-fallback-elucid',keyEnv:'ELUCID_GROK_API_KEY'}],model,at:now(),estimatedTokens:inputBytes+maxTokens+8192});
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
