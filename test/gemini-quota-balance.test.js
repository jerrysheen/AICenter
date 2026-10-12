import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../packages/database/src/index.js';
import {createGeminiArticleAdmission} from '../packages/runtime/src/gemini-article-admission.js';
import {resolveGoogleHourlyAdmissionModels} from '../packages/harness/src/llm-route.js';
import {nextGeminiDailyReset} from '../packages/connectors/src/gemini-grok-task.js';
import {previousDailyInstant} from '../packages/domain/src/zoned-time.js';
import {describeCondenseFailure,condenseJobFailure} from '../packages/domain/src/information-tree-policy.js';
import {createReportJobHandlers,REPORT_HOURLY_JOB_TYPE} from '../packages/runtime/src/report-module.js';
import {createJobRunner} from '../packages/runtime/src/job-runner.js';
import {createModelUsageService} from '../packages/domain/src/model-usage-service.js';

const pacific = {timeZone:'America/Los_Angeles',hour:0,minute:0};
const input = {model:'gemini-3.1-flash-lite',inputBytes:1,maxTokens:1};

function open(env, atRef) {
  const store = createStore(':memory:');
  const admission = createGeminiArticleAdmission({
    repository:store.repositories.modelQuota,
    usage:store.repositories.modelUsage,
    env, now:()=>atRef.at, log:()=>{},
  });
  return {store, admission};
}

test('daily quota cooldown ends at the next Pacific midnight, including PST', () => {
  for (const at of [Date.parse('2026-10-04T14:00:00Z'), Date.parse('2026-12-04T14:00:00Z')]) {
    const atRef = {at};
    const {store, admission} = open({GEMINI_API_KEY:'one', AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS:'1'}, atRef);
    try {
      const ticket = admission.reserve(input);
      const error = new Error('429 GenerateRequestsPerDayPerProjectPerModel-FreeTier retryDelay: 64908s');
      admission.failed(ticket, error);
      assert.equal(error.retryAt, nextGeminiDailyReset(at));
      assert.notEqual(error.retryAt, at + 86400000);
      atRef.at += 120000;
      assert.throws(() => admission.reserve(input), e => e.code === 'budget-deferred' && e.retryAt === nextGeminiDailyReset(at));
    } finally { store.close(); }
  }
});

test('startup repair caps a 24h block at the next reset and drops one already past the quota day', () => {
  const atRef = {at:Date.parse('2026-10-11T02:00:00Z')};
  const env = {GEMINI_API_KEY:'one', AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS:'1'};
  const {store, admission} = open(env, atRef);
  try {
    const key = admission.policy.slots[0].cooldownKey;
    store.repositories.modelQuota.cooldown(key, input.model, atRef.at + 86400000);
    const repaired = createGeminiArticleAdmission({repository:store.repositories.modelQuota, env, now:()=>atRef.at});
    const reset = nextGeminiDailyReset(atRef.at);
    assert.throws(() => repaired.reserve(input), error => error.retryAt === reset);
    atRef.at = reset;
    assert.equal(repaired.reserve(input).keyEnv, 'GEMINI_API_KEY');
  } finally { store.close(); }

  const later = {at:Date.parse('2026-10-11T08:00:00Z')};
  const stale = createStore(':memory:');
  try {
    const first = createGeminiArticleAdmission({repository:stale.repositories.modelQuota, env, now:()=>later.at});
    stale.repositories.modelQuota.cooldown(first.policy.slots[0].cooldownKey, input.model, Date.parse('2026-10-12T00:00:00Z'));
    const fixed = createGeminiArticleAdmission({repository:stale.repositories.modelQuota, env, now:()=>later.at});
    assert.equal(fixed.reserve(input).keyEnv, 'GEMINI_API_KEY');
  } finally { stale.close(); }

  const kept = createStore(':memory:');
  const now = {at:Date.parse('2026-10-07T16:00:00Z')};
  try {
    const first = createGeminiArticleAdmission({repository:kept.repositories.modelQuota, env, now:()=>now.at});
    const slot = first.policy.slots[0].cooldownKey;
    kept.repositories.modelQuota.cooldown(slot, input.model, now.at + 60000);
    kept.repositories.modelQuota.setCooldown(slot, 'other-model', nextGeminiDailyReset(now.at));
    const next = createGeminiArticleAdmission({repository:kept.repositories.modelQuota, env, now:()=>now.at});
    assert.throws(() => next.reserve(input), error => error.retryAt === now.at + 60000);
    assert.throws(() => next.reserve({...input, model:'other-model'}), error => error.retryAt === nextGeminiDailyReset(now.at));
    now.at += 60000;
    assert.equal(next.reserve(input).keyEnv, 'GEMINI_API_KEY');
    const dayStart = previousDailyInstant(Date.parse('2026-10-11T08:00:00Z'), pacific);
    assert.equal(dayStart, Date.parse('2026-10-11T07:00:00Z'));
  } finally { kept.close(); }
});

test('hourly models fall back in order only after every key is cooled for the earlier model', () => {
  const atRef = {at:Date.parse('2026-10-07T16:00:00Z')};
  const env = {
    GEMINI_API_KEY:'one', GEMINI_API_KEY2:'two',
    AI_CENTER_GEMINI_KEY_ENVS:'GEMINI_API_KEY,GEMINI_API_KEY2',
    AI_CENTER_HARNESS_HOURLY_MODEL:'gemini-3.1-flash-lite',
    AI_CENTER_GEMINI_HOURLY_MODELS:'gemini-3.5-flash-lite',
    AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS:'1',
  };
  const models = resolveGoogleHourlyAdmissionModels(env);
  assert.deepEqual(models, ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
  const {store, admission} = open(env, atRef);
  const ordered = createGeminiArticleAdmission({
    repository:store.repositories.modelQuota, usage:store.repositories.modelUsage,
    env, now:()=>atRef.at, models, modelOrder:'ordered', allowFallback:false,
  });
  try {
    const first = ordered.reserve({...input, useModelPool:true});
    assert.equal(first.model, 'gemini-3.1-flash-lite');
    assert.equal(first.keyEnv, 'GEMINI_API_KEY');
    ordered.failed(first, new Error('429 PerDay'));
    atRef.at += 10;
    const second = ordered.reserve({...input, useModelPool:true});
    assert.equal(second.model, 'gemini-3.1-flash-lite');
    assert.equal(second.keyEnv, 'GEMINI_API_KEY2');
    ordered.failed(second, new Error('429 PerDay'));
    atRef.at += 10;
    const fallback = ordered.reserve({...input, useModelPool:true});
    assert.equal(fallback.model, 'gemini-3.5-flash-lite');
    assert.throws(() => ordered.reserve(input), error => error.code === 'budget-deferred' && /quota=daily/.test(error.message) && /gemini-3.1-flash-lite/.test(error.message));
    atRef.at += 10;
    assert.equal(ordered.reserve({...input, model:'gemini-3.5-flash-lite'}).model, 'gemini-3.5-flash-lite');
  } finally { store.close(); }
});

test('least-used and idle keys are preferred while a full minute bucket is skipped', () => {
  const atRef = {at:Date.parse('2026-10-07T16:00:00Z')};
  const env = {
    GEMINI_API_KEY:'one', GEMINI_API_KEY2:'two',
    GEMINI_API_KEY_PROJECT:'alpha', GEMINI_API_KEY2_PROJECT:'beta',
    AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS:'1',
    AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_MINUTE:'20',
    AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_HOUR:'100',
    AI_CENTER_GEMINI_KEY_IDLE_MS:String(30 * 60 * 1000),
  };
  const {store, admission} = open(env, atRef);
  try {
    assert.equal(admission.reserve(input).keyEnv, 'GEMINI_API_KEY');
    atRef.at += 1000;
    assert.equal(admission.reserve(input).keyEnv, 'GEMINI_API_KEY2');
    const key = admission.policy.slots[0].cooldownKey;
    const other = admission.policy.slots[1].cooldownKey;
    store.repositories.modelQuota.cooldown(other, input.model, atRef.at + 39 * 60 * 1000);
    atRef.at += 1000;
    assert.equal(admission.reserve(input).keyEnv, 'GEMINI_API_KEY');
    store.repositories.modelQuota.clearCooldown(other, input.model);
    atRef.at += 39 * 60 * 1000;
    assert.equal(admission.reserve(input).keyEnv, 'GEMINI_API_KEY2');
    atRef.at += 60 * 1000;
    assert.equal(admission.reserve(input).keyEnv, 'GEMINI_API_KEY');
    assert.ok(key && other);
  } finally { store.close(); }

  const paced = {at:Date.parse('2026-10-07T18:00:00Z')};
  const limited = {
    ...env,
    AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_MINUTE:'1',
  };
  const second = open(limited, paced);
  try {
    const slots = second.admission.policy.slots;
    second.store.repositories.modelQuota.cooldown(slots[0].cooldownKey, input.model, paced.at + 120000);
    assert.equal(second.admission.reserve(input).keyEnv, 'GEMINI_API_KEY2');
    paced.at += 70000;
    assert.equal(second.admission.reserve(input).keyEnv, 'GEMINI_API_KEY2');
    paced.at = paced.at + 60000;
    assert.equal(second.admission.reserve(input).keyEnv, 'GEMINI_API_KEY');
    paced.at += 10;
    assert.equal(second.admission.reserve(input).keyEnv, 'GEMINI_API_KEY2');
  } finally { second.store.close(); }
});

test('one probe runs at a time, counts usage, and lifts only a successful cooldown', async () => {
  const atRef = {at:Date.parse('2026-10-07T16:00:00Z')};
  const env = {
    GEMINI_API_KEY:'one',
    AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS:'1',
    AI_CENTER_GEMINI_QUOTA_PROBE_MS:String(12 * 60 * 1000),
    AI_CENTER_GEMINI_QUOTA_PROBE_DAILY_MS:String(30 * 60 * 1000),
  };
  const lines = [];
  const store = createStore(':memory:');
  const admission = createGeminiArticleAdmission({
    repository:store.repositories.modelQuota, usage:store.repositories.modelUsage,
    env, now:()=>atRef.at, log:line => lines.push(line),
  });
  const calls = [];
  let blocked = null;
  const generate = spec => {
    calls.push(spec);
    return blocked || Promise.resolve({ok:false, status:429});
  };
  try {
    const ticket = admission.reserve(input);
    const reset = nextGeminiDailyReset(atRef.at);
    admission.failed(ticket, new Error('429 PerDay'));
    let release;
    blocked = new Promise(resolve => { release = () => resolve({ok:false, status:429}); });
    const first = admission.probeOnce({generate});
    const second = admission.probeOnce({generate});
    assert.equal(first, second);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {keyEnv:'GEMINI_API_KEY', model:input.model, maxOutputTokens:1, prompt:'1'});
    release();
    const failed = await first;
    assert.deepEqual(failed, {keySuffix:'KEY', model:input.model, ok:false, status:429, lifted:false});
    assert.match(lines[0], /key=KEY model=gemini-3\.1-flash-lite ok=0 status=429 lifted=0/);
    atRef.at += 12 * 60 * 1000;
    blocked = null;
    assert.equal(await admission.probeOnce({generate}), null);
    assert.equal(calls.length, 1);
    atRef.at += 18 * 60 * 1000;
    const lifted = await admission.probeOnce({generate:spec => { calls.push(spec); return {ok:true, status:200}; }});
    assert.equal(lifted.lifted, true);
    assert.equal(lifted.status, 200);
    assert.match(lines.at(-1), /ok=1 status=200 lifted=1/);
    atRef.at += 10;
    assert.equal(admission.reserve(input).keyEnv, 'GEMINI_API_KEY');
    assert.ok(atRef.at < reset);
    const raw = store.repositories.modelUsage.list('local').find(row => row.status === 'succeeded');
    assert.equal(raw.stage, 'quota-probe');
    assert.equal(raw.model, input.model);
    assert.equal(raw.applicationSessionId, 'KEY');
    assert.equal(raw.jobId, 'probe:200:lifted');
    const view = createModelUsageService({repository:store.repositories.modelUsage}).list();
    assert.equal(view.some(row => row.stage === 'quota-probe' && row.applicationSessionId === 'KEY' && row.jobId === 'probe:200:lifted' && row.model === undefined), true);
    const summary = createModelUsageService({repository:store.repositories.modelUsage}).summary({stage:'quota-probe'});
    assert.equal(summary.statusCounts.failed, 1);
    assert.equal(summary.statusCounts.succeeded, 1);
  } finally { store.close(); }
});

test('a non-daily cooldown is probed on the shorter interval and a failure keeps the original end', async () => {
  const atRef = {at:Date.parse('2026-10-07T16:00:00Z')};
  const env = {
    GEMINI_API_KEY:'one', AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS:'1',
    AI_CENTER_GEMINI_QUOTA_PROBE_MS:String(12 * 60 * 1000),
    AI_CENTER_GEMINI_QUOTA_PROBE_DAILY_MS:String(30 * 60 * 1000),
  };
  const {store, admission} = open(env, atRef);
  const until = atRef.at + 7200 * 1000;
  try {
    const ticket = admission.reserve(input);
    const error = new Error('429 RESOURCE_EXHAUSTED retryDelay: 7200s');
    admission.failed(ticket, error);
    assert.equal(error.retryAt, until);
    const calls = [];
    const generate = spec => { calls.push(spec); return {ok:false, status:429}; };
    assert.equal((await admission.probeOnce({generate})).lifted, false);
    atRef.at += 11 * 60 * 1000;
    assert.equal(await admission.probeOnce({generate}), null);
    atRef.at += 60 * 1000;
    assert.equal((await admission.probeOnce({generate})).status, 429);
    assert.equal(calls.length, 2);
    atRef.at += 10;
    assert.throws(() => admission.reserve(input), error => error.retryAt === until);
  } finally { store.close(); }
});

test('quota text from a 429 is stored on the hourly job error', async () => {
  const atRef = {at:Date.parse('2026-10-07T16:00:00Z')};
  const {store, admission} = open({GEMINI_API_KEY:'one', AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS:'1'}, atRef);
  const jobStore = createStore(':memory:');
  try {
    const ticket = admission.reserve(input);
    const failure = new Error('429 PerDay AIzaSyDUMMYKEY1234567890');
    admission.failed(ticket, failure);
    const diagnostic = describeCondenseFailure(failure, {model:input.model, tagName:'宏观'});
    const handlers = createReportJobHandlers({
      reportService:{async generateDailyReport() { throw new Error('unused'); }},
      informationService:{async generateHourlyDigests() {
        return [{
          id:'edition:quota', status:'failed', published:false,
          window:{startAt:atRef.at, endAt:atRef.at + 3600000}, pendingIds:[],
          groupFailures:[{id:'tree-hourly:1', reason:'budget-deferred', retryable:true, tagId:'macro'}],
          condenseDiagnostics:[diagnostic],
        }];
      }},
      treeService:{},
    });
    const created = jobStore.createJob({type:REPORT_HOURLY_JOB_TYPE, input:{hourStart:atRef.at}, maxAttempts:1});
    const runner = createJobRunner({store:jobStore, handlers, pollIntervalMs:200});
    await runner.runOnce();
    const job = jobStore.getJob(created.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'budget-deferred');
    assert.equal(job.error.httpStatus, 429);
    assert.equal(job.error.model, input.model);
    assert.match(job.error.message, /quota=daily key=KEY/);
    assert.match(job.error.message, /cooldownUntil=/);
    assert.match(job.error.message, /429 PerDay/);
    assert.equal(job.error.message.includes('AIzaSyDUMMYKEY1234567890'), false);
    assert.equal(job.error.summary, '小时浓缩临时失败；成功分类及检查点已保留');
    assert.match(condenseJobFailure('小时浓缩临时失败；成功分类及检查点已保留', {diagnostics:[diagnostic]}).message, /cooldownUntil=/);
  } finally { store.close(); jobStore.close(); }
});
