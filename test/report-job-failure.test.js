import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../packages/database/src/index.js';
import {createJobRunner} from '../packages/runtime/src/job-runner.js';
import {createReportJobHandlers, REPORT_DAILY_JOB_TYPE, REPORT_HOURLY_JOB_TYPE} from '../packages/runtime/src/report-module.js';

const H = 3600000;
const start = 10 * H;
const secret = 'AIzaSyDUMMYKEY1234567890';

function handlersFor(informationService, treeService = {async generateDaily() { throw new Error('日报不应在小时测试里运行'); }}) {
  return createReportJobHandlers({
    reportService: {async generateDailyReport() { throw new Error('旧日报不应运行'); }},
    informationService,
    treeService,
  });
}

async function runJob(store, handlers, type, input, maxAttempts) {
  const created = store.createJob({type, input, maxAttempts});
  const runner = createJobRunner({store, handlers, pollIntervalMs: 200});
  await runner.runOnce();
  return store.getJob(created.id);
}

test('hourly extract failure stores kind, code, and a redacted message on the job', async () => {
  const store = createStore(':memory:');
  try {
    const handlers = handlersFor({async generateHourlyDigests() {
      return [{
        id: 'edition:failed',
        status: 'failed',
        published: false,
        window: {startAt: start, endAt: start + H},
        pendingIds: [],
        groupFailures: [{id: 'tree-hourly:1', reason: 'retryable-model-error', retryable: true, tagId: 'macro'}],
        condenseDiagnostics: [{
          kind: 'model-5xx',
          code: '500',
          message: `模型调用失败：500: upstream ${secret} authorization: Bearer abc.def.ghi`,
          group: '宏观',
          model: 'grok-4.7',
          durationMs: 180000,
          httpStatus: 500,
        }, {
          kind: 'timeout-execution',
          code: 'execution-timeout',
          message: '模型执行超时',
          group: '产业',
          model: 'sk-supersecretvalue',
          durationMs: 180000,
          httpStatus: null,
        }],
      }];
    }});
    const job = await runJob(store, handlers, REPORT_HOURLY_JOB_TYPE, {hourStart: start}, 2);
    assert.equal(job.status, 'queued');
    assert.equal(job.attemptCount, 1);
    assert.equal(job.error.kind, 'model-5xx');
    assert.equal(job.error.code, '500');
    assert.match(job.error.message, /upstream/);
    assert.equal(job.error.message.includes(secret), false);
    assert.equal(job.error.message.includes('abc.def.ghi'), false);
    assert.equal(job.error.summary, '小时浓缩临时失败；成功分类及检查点已保留');
    assert.equal(job.error.group, '宏观');
    assert.equal(job.error.model, 'grok-4.7');
    assert.equal(job.error.durationMs, 180000);
    assert.equal(job.error.httpStatus, 500);
    assert.equal(job.error.groups[1].model, null);
    assert.equal(job.error.groups[1].kind, 'timeout-execution');
    assert.equal(JSON.stringify(job.error).includes(secret), false);
    assert.equal(JSON.stringify(job.error).includes('sk-supersecretvalue'), false);
  } finally {
    store.close();
  }
});

test('hourly extract failure still records kind and code from group failures', async () => {
  const store = createStore(':memory:');
  try {
    const handlers = handlersFor({async generateHourlyDigests() {
      return [{
        id: 'edition:failed',
        status: 'failed',
        published: false,
        window: {startAt: start, endAt: start + H},
        pendingIds: [],
        groupFailures: [{id: 'tree-hourly:1', reason: 'execution-timeout', retryable: true, tagId: 'macro', queueMs: 40, executionMs: 180000}],
      }];
    }});
    const job = await runJob(store, handlers, REPORT_HOURLY_JOB_TYPE, {hourStart: start}, 1);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.kind, 'timeout-execution');
    assert.equal(job.error.code, 'execution-timeout');
    assert.match(job.error.message, /execution-timeout/);
    assert.equal(job.error.group, 'macro');
    assert.equal(job.error.durationMs, 180000);
    assert.equal(job.error.httpStatus, null);
    assert.equal(job.error.summary, '小时浓缩临时失败；成功分类及检查点已保留');
  } finally {
    store.close();
  }
});

test('daily generate failure stores the same redacted failure fields', async () => {
  const store = createStore(':memory:');
  let calls = 0;
  try {
    const handlers = handlersFor(null, {async generateDaily() {
      calls += 1;
      return {
        id: 'edition:daily',
        status: 'failed',
        condenseDiagnostics: [{
          kind: 'model-4xx',
          code: '429',
          message: '模型调用失败：429: slow api_key=plain-secret',
          group: '产业',
          model: 'gemini-3.1-flash-lite',
          durationMs: 2400,
          httpStatus: 429,
        }],
      };
    }});
    const job = await runJob(store, handlers, REPORT_DAILY_JOB_TYPE, {reportDate: '2026-10-11'}, 1);
    assert.equal(calls, 1);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.kind, 'model-4xx');
    assert.equal(job.error.code, '429');
    assert.match(job.error.message, /429/);
    assert.equal(job.error.message.includes('plain-secret'), false);
    assert.equal(job.error.summary, '日报浓缩树生成失败，旧刊期继续可读');
    assert.equal(job.error.group, '产业');
    assert.equal(job.error.model, 'gemini-3.1-flash-lite');
    assert.equal(job.error.durationMs, 2400);
    assert.equal(job.error.httpStatus, 429);
  } finally {
    store.close();
  }
});

test('daily generate throw is recorded without changing the failure', async () => {
  const store = createStore(':memory:');
  try {
    const handlers = handlersFor(null, {async generateDaily() {
      throw Object.assign(new Error(`模型调用失败：503: upstream ${secret}`), {
        name: 'HarnessModelError', upstreamStatus: 503, upstreamCode: '503',
      });
    }});
    const job = await runJob(store, handlers, REPORT_DAILY_JOB_TYPE, {reportDate: '2026-10-11'}, 2);
    assert.equal(job.status, 'queued');
    assert.equal(job.attemptCount, 1);
    assert.equal(job.error.kind, 'model-5xx');
    assert.equal(job.error.code, '503');
    assert.equal(job.error.httpStatus, 503);
    assert.match(job.error.message, /upstream/);
    assert.equal(job.error.message.includes(secret), false);
    assert.match(job.error.summary, /503/);
  } finally {
    store.close();
  }
});
