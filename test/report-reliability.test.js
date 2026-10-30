import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../packages/database/src/index.js';
import {createJobRunner, wait} from '../packages/runtime/src/job-runner.js';
import {repairTreeModuleAttribution} from '../packages/contracts/src/information-tree.js';
import {createInformationTreeService} from '../packages/domain/src/information-tree-service.js';
import {loadInformationTreeSkills} from '../packages/runtime/src/information-tree/skills.js';
import {modelRetryDelayMs} from '../packages/domain/src/report-reliability.js';
import {resolveDailyConfig} from '../packages/domain/src/daily-window.js';
import {
  DAILY_REPORT_CATCHUP_KEY,
  REPORT_DAILY_JOB_TYPE,
  REPORT_HOURLY_JOB_TYPE,
  createReportJobHandlers,
  dailyCatchupAllowed,
  ensureDailyReportCatchupSchedule,
} from '../packages/runtime/src/report-module.js';

const H = 3600000;
const start = 10 * H;
const material = (id, text = `原文内容 ${id}：厂商计划下季度交付，当前仅部分用户测试。`) => ({
  id, title: `标题 ${id}`, author: '作者', publisher: '来源', publishedAt: start + 1, contentLevel: 'full',
  paragraphs: [{role: 'body', text}], sourceRefs: [],
});

function fixture(extra = {}) {
  const store = createStore(':memory:');
  const calls = [];
  const runtime = {async run(input) {
    calls.push(input);
    const payload = JSON.parse(input.message);
    if (input.usageStage === 'tree-information') {
      return {answer: JSON.stringify({title: payload.source.title, text: payload.source.paragraphs.map((item) => item.text).join('').slice(0, 160), tagId: null})};
    }
    if (input.usageStage === 'tree-daily') {
      return {answer: JSON.stringify({modules: [{title: '日报', text: '当日要点仍在测试。', tagId: payload.tagId, inputIds: payload.inputs.map((item) => item.id)}]})};
    }
    return {answer: JSON.stringify({modules: [{title: '未分类进展', text: '厂商计划交付，目前仍在测试。', tagId: payload.tagId ?? null, inputIds: payload.inputs.map((item) => item.id)}]})};
  }};
  const service = createInformationTreeService({
    repository: store.repositories.informationTree,
    reportRepository: store.repositories.report,
    agentRuntime: runtime,
    skills: loadInformationTreeSkills(),
    sleep: async () => {},
    ...extra,
  });
  return {store, calls, runtime, service};
}

function temporaryDatabase(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {path: path.join(directory, 'test.db'), remove() { fs.rmSync(directory, {recursive: true, force: true}); }};
}

test('retry delays double until the cap', () => {
  assert.deepEqual([0, 1, 2, 3].map((attempt) => modelRetryDelayMs(attempt, {baseMs: 1000, maxMs: 8000})), [1000, 2000, 4000, 8000]);
  assert.equal(modelRetryDelayMs(8, {baseMs: 1000, maxMs: 8000}), 8000);
});

test('bad module attribution keeps the first owner and attaches omitted inputs', () => {
  const inputs = [{id: 'a'}, {id: 'b'}, {id: 'c'}];
  const tags = new Set(['macro']);
  const repaired = repairTreeModuleAttribution({
    modules: [
      {title: '进展', text: '计划仍在测试。', tagId: 'missing', inputIds: ['a', 'unknown', 'a']},
      {title: '重复', text: '不应再占有 a。', tagId: 'macro', inputIds: ['a', 'b']},
    ],
  }, inputs, tags, {tagId: 'macro'});
  assert.deepEqual(repaired.modules.map((module) => module.inputIds), [['a'], ['b', 'c']]);
  assert.equal(repaired.modules.every((module) => module.tagId === 'macro'), true);
  assert.equal(repairTreeModuleAttribution({modules: []}, inputs, tags), null);
});

test('hourly non-quota failure retries once on another key and logs every call', async () => {
  const lines = [];
  const seen = [];
  const google = {
    AI_CENTER_HARNESS_HOURLY_PROVIDER: 'google',
    AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY,GEMINI_API_KEY2',
    GEMINI_API_KEY: 'key-a',
    GEMINI_API_KEY2: 'key-b',
  };
  const f = fixture({env: google, upstreamRetries: 3, log: (line) => lines.push(String(line))});
  const original = f.runtime.run;
  f.runtime.run = async (input) => {
    if (input.usageStage !== 'tree-hourly') return original(input);
    seen.push(input.googleKeyEnv);
    if (input.googleKeyEnv === 'GEMINI_API_KEY') {
      throw Object.assign(new Error('模型调用失败：500: INTERNAL'), {
        name: 'HarnessModelError', upstreamStatus: 500, upstreamBody: `INTERNAL ${'x'.repeat(400)}`,
        admittedModel: 'gemini-3.1-flash-lite', finishReason: 'OTHER',
      });
    }
    return original(input);
  };
  const stdout = [];
  const previous = console.log;
  console.log = (line) => { stdout.push(String(line)); };
  const logged = fixture({env: google, upstreamRetries: 3});
  const loggedOriginal = logged.runtime.run;
  logged.runtime.run = async (input) => {
    if (input.usageStage !== 'tree-hourly') return loggedOriginal(input);
    throw Object.assign(new Error('模型调用失败：500: INTERNAL'), {name: 'HarnessModelError', upstreamStatus: 500, upstreamBody: 'INTERNAL', admittedModel: 'gemini-3.1-flash-lite'});
  };
  try {
    const hour = await f.service.generateHour({hourStart: start, materials: [material('a'), material('b')]});
    assert.equal(hour.status, 'ready');
    assert.deepEqual(seen, ['GEMINI_API_KEY', 'GEMINI_API_KEY2']);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[worker\] tree-hourly kind=model-5xx status=500 message=.*INTERNAL body=INTERNAL /);
    assert.equal(lines[0].includes('\n'), false);
    assert.match(lines[0], /model=gemini-3\.1-flash-lite key=KEY inputBytes=\d+ finishReason=OTHER latencyMs=\d+ outcome=error$/);
    assert.ok(lines[0].split('body=')[1].split(' model=')[0].length <= 300);
    assert.match(lines[1], /key=KEY2 .*outcome=ok$/);
    const failed = await logged.service.generateHour({hourStart: start, materials: [material('c'), material('d')]});
    assert.equal(failed.status, 'failed');
    assert.equal(stdout.filter((line) => line.startsWith('[worker] tree-hourly')).length, 2);
  } finally {
    console.log = previous;
    f.store.close();
    logged.store.close();
  }
});

test('hourly model loop starts at the balanced model and falls back to the other', async () => {
  const seen = [];
  const models = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
  const f = fixture({
    upstreamRetries: 0,
    hourlyModels: models,
    rankHourlyModels: () => ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  });
  const ignored = fixture({
    upstreamRetries: 0,
    hourlyModels: models,
    rankHourlyModels: () => ['other-model'],
  });
  const original = f.runtime.run;
  f.runtime.run = async (input) => {
    if (input.usageStage !== 'tree-hourly') return original(input);
    seen.push(input.googleModel);
    if (input.googleModel === 'gemini-3.5-flash-lite') {
      throw Object.assign(new Error('模型调用失败：503: unavailable'), {upstreamStatus: 503, name: 'HarnessModelError'});
    }
    return original(input);
  };
  const ignoredSeen = [];
  const ignoredOriginal = ignored.runtime.run;
  ignored.runtime.run = async (input) => {
    if (input.usageStage !== 'tree-hourly') return ignoredOriginal(input);
    ignoredSeen.push(input.googleModel);
    return ignoredOriginal(input);
  };
  try {
    const hour = await f.service.generateHour({hourStart: start, materials: [material('a'), material('b')]});
    assert.equal(hour.status, 'ready');
    assert.deepEqual(seen, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    const kept = await ignored.service.generateHour({hourStart: start, materials: [material('c'), material('d')]});
    assert.equal(kept.status, 'ready');
    assert.deepEqual(ignoredSeen, ['gemini-3.1-flash-lite']);
  } finally {
    f.store.close();
    ignored.store.close();
  }
});

test('hourly 503 retries on the same model, then uses the next hourly model', async () => {
  const seen = [];
  const f = fixture({upstreamRetries: 2, hourlyModels: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']});
  const original = f.runtime.run;
  f.runtime.run = async (input) => {
    if (input.usageStage !== 'tree-hourly') return original(input);
    seen.push(input.googleModel);
    if (input.googleModel === 'gemini-3.1-flash-lite') {
      throw Object.assign(new Error('模型调用失败：503: unavailable'), {upstreamStatus: 503, name: 'HarnessModelError'});
    }
    return original(input);
  };
  try {
    const hour = await f.service.generateHour({hourStart: start, materials: [material('a'), material('b')]});
    assert.equal(hour.status, 'ready');
    assert.deepEqual(seen, ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
  } finally {
    f.store.close();
  }
});

test('repeated unknown attribution is repaired instead of failing the hour', async () => {
  const f = fixture({upstreamRetries: 0});
  const original = f.runtime.run;
  f.runtime.run = async (input) => {
    if (input.usageStage !== 'tree-hourly') return original(input);
    f.calls.push(input);
    return {answer: JSON.stringify({modules: [{title: '进展', text: '计划仍在测试。', tagId: null, inputIds: ['unknown', 'unknown']}]})};
  };
  try {
    const hour = await f.service.generateHour({hourStart: start, materials: [material('a'), material('b')]});
    assert.equal(hour.status, 'ready');
    assert.equal(f.calls.filter((call) => call.usageStage === 'tree-hourly').length, 2);
  } finally {
    f.store.close();
  }
});

test('invalid hourly JSON switches to the fallback model', async () => {
  const seen = [];
  const f = fixture({upstreamRetries: 0, hourlyModels: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']});
  const original = f.runtime.run;
  f.runtime.run = async (input) => {
    if (input.usageStage !== 'tree-hourly') return original(input);
    seen.push(input.googleModel);
    if (input.googleModel === 'gemini-3.1-flash-lite') return {answer: 'not-json'};
    return original(input);
  };
  try {
    const hour = await f.service.generateHour({hourStart: start, materials: [material('a'), material('b')]});
    assert.equal(hour.status, 'ready');
    assert.deepEqual(seen, ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
  } finally {
    f.store.close();
  }
});

test('a failed hour becomes terminal and is not modeled again', async () => {
  let clock = start + H + 60_000;
  const f = fixture({upstreamRetries: 0, hourlyAttemptCap: 2, now: () => clock});
  f.runtime.run = async (input) => {
    f.calls.push(input);
    if (input.usageStage === 'tree-hourly') throw Object.assign(new Error('模型调用失败：500: down'), {upstreamStatus: 500});
    const payload = JSON.parse(input.message);
    return {answer: JSON.stringify({title: payload.source.title, text: '提炼', tagId: null})};
  };
  try {
    const first = await f.service.generateHour({hourStart: start, materials: [material('a'), material('b')]});
    assert.equal(first.status, 'failed');
    assert.equal(first.attemptCount, 1);
    assert.equal(first.terminal, false);
    assert.equal(first.groupFailures[0].retryable, true);
    clock += 31 * 60_000;
    const second = await f.service.generateHour({hourStart: start, materials: [material('a'), material('b')]});
    assert.equal(second.terminal, true);
    assert.equal(second.attemptCount, 2);
    assert.equal(second.groupFailures[0].retryable, false);
    const before = f.calls.filter((call) => call.usageStage === 'tree-hourly').length;
    const third = await f.service.generateHour({hourStart: start, materials: [material('a'), material('b')]});
    assert.equal(third.id, second.id);
    assert.equal(f.calls.filter((call) => call.usageStage === 'tree-hourly').length, before);
    const handlers = createReportJobHandlers({
      reportService: {generateDailyReport() {}},
      informationService: f.service,
      treeService: f.service,
    });
    const output = await handlers[REPORT_HOURLY_JOB_TYPE]({hourStart: start});
    assert.equal(output.status, 'failed');
    assert.equal(output.editionId, second.id);
  } finally {
    f.store.close();
  }
});

test('daily keeps successful tags when one tag hits the execution timeout', async () => {
  const catalog = {tags: [{id: 'A', name: '一'}, {id: 'B', name: '二'}]};
  const f = fixture({
    catalog,
    primaryTag: (_workspace, item) => ({locked: true, tagId: item.id === 'b' ? 'B' : 'A'}),
    upstreamRetries: 0,
  });
  const original = f.runtime.run;
  f.runtime.run = async (input) => {
    if (input.usageStage === 'tree-daily' && JSON.parse(input.message).tagId === 'B') {
      throw Object.assign(new Error('模型执行超时，已停止本轮调用'), {name: 'ModelExecutionTimeout'});
    }
    if (input.usageStage === 'tree-hourly') {
      const payload = JSON.parse(input.message);
      const text = '这一小时的模块正文需要超过直通长度，避免日报跳过模型。'.repeat(4);
      return {answer: JSON.stringify({modules: [{title: '模块', text, tagId: payload.tagId, inputIds: payload.inputs.map((item) => item.id)}]})};
    }
    return original(input);
  };
  try {
    const hour = await f.service.generateHour({
      hourStart: start,
      materials: [material('a', '第一条正文足够长，不会被当成短讯直通。'.repeat(6)), material('b', '第二条正文也足够长，单独成组。'.repeat(6))],
    });
    assert.equal(hour.status, 'ready');
    const daily = await f.service.generateDaily({window: {startAt: start, endAt: start + H}, hours: [hour]});
    assert.equal(daily.status, 'partial');
    assert.equal(daily.published, true);
    assert.equal(daily.roots.length, 1);
    assert.equal(daily.groupFailures.length, 1);
    assert.equal(daily.groupFailures[0].reason, 'execution-timeout');
  } finally {
    f.store.close();
  }
});

test('daily catch-up waits until the run minute and skips a published edition', async () => {
  const config = resolveDailyConfig({AI_CENTER_DAILY_CUTOFF: '08:00', AI_CENTER_DAILY_RUN_MINUTE: '45', AI_CENTER_DAILY_CATCHUP_MINUTES: '180'});
  assert.equal(dailyCatchupAllowed(Date.UTC(2026, 9, 12, 0, 30), config), false);
  assert.equal(dailyCatchupAllowed(Date.UTC(2026, 9, 12, 0, 50), config), true);
  const store = createStore(':memory:');
  try {
    const created = ensureDailyReportCatchupSchedule(store, config, Date.UTC(2026, 9, 12, 0, 50));
    assert.equal(created.key, DAILY_REPORT_CATCHUP_KEY);
    assert.equal(created.schedule.intervalMinutes, 180);
    assert.equal(created.nextRunAt, Date.UTC(2026, 9, 12, 0, 50));
    assert.equal(ensureDailyReportCatchupSchedule(store, config, Date.UTC(2026, 9, 12, 2, 0)).nextRunAt, created.nextRunAt);
    let calls = 0;
    const handlers = createReportJobHandlers({
      reportService: {generateDailyReport() { throw new Error('legacy'); }},
      treeService: {
        published() { return {id: 'day-1', status: 'partial'}; },
        async generateDaily() { calls += 1; return {id: 'day-2', status: 'ready'}; },
      },
      dailyConfig: resolveDailyConfig({AI_CENTER_DAILY_CUTOFF: '00:00', AI_CENTER_DAILY_RUN_MINUTE: '0'}),
    });
    const skipped = await handlers[REPORT_DAILY_JOB_TYPE]({scheduleKey: DAILY_REPORT_CATCHUP_KEY, reportDate: '2026-10-12'});
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.reason, 'published');
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});

test('a lease interrupt requeues hourly extract and a runtime cap does not refund it', () => {
  const store = createStore(':memory:');
  try {
    const hourStart = Math.floor(Date.now() / H) * H;
    const job = store.createJob({
      type: 'report.hourly.extract',
      workspaceId: 'local',
      maxAttempts: 2,
      input: {workspaceId: 'local', hourStart},
    });
    const claimed = store.claimNextJob('worker-1', ['report.hourly.extract']);
    assert.equal(claimed.id, job.id);
    assert.equal(store.recoverStaleJobs(1, claimed.lockedAt + 5), 1);
    const current = store.getJob(job.id);
    assert.equal(current.status, 'queued');
    assert.equal(current.attemptCount, 1);
    assert.equal(current.maxAttempts, 3);
    assert.equal(current.error.name, 'WorkerLeaseExpired');
    const again = store.claimNextJob('worker-2', ['report.hourly.extract']);
    assert.equal(again.attemptCount, 2);
    assert.equal(store.recoverStaleJobs(1, again.lockedAt + 5), 1);
    const refunded = store.getJob(job.id);
    assert.equal(refunded.status, 'queued');
    assert.equal(refunded.attemptCount, 2);
    assert.equal(refunded.maxAttempts, 3);
    assert.equal(refunded.error.name, 'WorkerLeaseExpired');
    const running = store.claimNextJob('worker-3', ['report.hourly.extract']);
    assert.equal(running.id, job.id);
    assert.equal(running.attemptCount, 3);
    assert.equal(store.recoverStaleJobs(10 * 60_000, Date.now() + 60_000, {
      maxRunningMsByType: {'report.hourly.extract': 30_000},
    }), 1);
    const failed = store.getJob(job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.name, 'WorkerRunTimeout');
    assert.equal(failed.maxAttempts, 3);
  } finally {
    store.close();
  }
});

test('a heartbeating job past its runtime is failed and the same queue can be claimed', async () => {
  const temporary = temporaryDatabase('ai-center-runtime-cap-');
  const store = createStore(temporary.path);
  const side = new Database(temporary.path);
  try {
    const stuck = store.createJob({type: 'report.information.prepare', input: {n: 1}, maxAttempts: 3});
    assert.equal(store.claimNextJob('worker-a', ['report.information.prepare']).id, stuck.id);
    side.prepare('UPDATE job_attempts SET started_at = ? WHERE job_id = ?').run(Date.now() - 120_000, stuck.id);
    assert.equal(store.touchJob(stuck.id, 'worker-a'), true);
    assert.equal(store.recoverStaleJobs(10 * 60_000, Date.now(), {
      maxRunningMsByType: {'report.information.prepare': 30_000},
    }), 1);
    const failed = store.getJob(stuck.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.name, 'WorkerRunTimeout');
    const next = store.createJob({type: 'report.information.prepare', input: {n: 2}, maxAttempts: 1});
    assert.equal(store.claimNextJob('worker-b', ['report.information.prepare']).id, next.id);
  } finally {
    side.close();
    store.close();
    temporary.remove();
  }
});

test('job runner releases an in-process job that exceeded its runtime', async () => {
  const temporary = temporaryDatabase('ai-center-runtime-runner-');
  const store = createStore(temporary.path);
  const side = new Database(temporary.path);
  const started = [];
  const runner = createJobRunner({
    store,
    pollIntervalMs: 20,
    staleAfterMs: 60_000,
    recoverEveryMs: 30,
    maxRunningMsByType: {'report.information.prepare': 1000},
    handlers: {
      'report.information.prepare': (input) => {
        started.push(input.n);
        if (input.n === 1) return new Promise(() => {});
        return {n: input.n};
      },
    },
  });
  store.createJob({type: 'report.information.prepare', input: {n: 1}, maxAttempts: 3});
  const running = runner.start();
  try {
    const claimed = Date.now() + 1000;
    while (!started.includes(1) && Date.now() < claimed) await wait(20);
    const stuck = store.listJobs(5).find((job) => job.input.n === 1);
    side.prepare('UPDATE job_attempts SET started_at = ? WHERE job_id = ?').run(Date.now() - 5000, stuck.id);
    store.createJob({type: 'report.information.prepare', input: {n: 2}, maxAttempts: 1});
    const continued = Date.now() + 2000;
    while (!started.includes(2) && Date.now() < continued) await wait(20);
    assert.deepEqual(started, [1, 2]);
    assert.equal(store.getJob(stuck.id).status, 'failed');
    assert.equal(store.getJob(stuck.id).error.name, 'WorkerRunTimeout');
  } finally {
    runner.stop();
    await running;
    side.close();
    store.close();
    temporary.remove();
  }
});
