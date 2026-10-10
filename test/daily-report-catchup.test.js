import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContract, GenerateDailyReportInputSchema } from '../packages/contracts/src/index.js';
import {
  createReportJobHandlers,
  DAILY_REPORT_CATCHUP_GRACE_MS,
  DAILY_REPORT_CATCHUP_LIMIT,
} from '../packages/runtime/src/report-module.js';

function memoryStore() {
  const jobs = [];
  return {
    jobs,
    listOpenJobs(type) {
      return jobs.filter((job) => job.type === type && (job.status === 'queued' || job.status === 'running'));
    },
    createJob(input) {
      const job = {
        id: `job-${jobs.length + 1}`,
        type: input.type,
        status: 'queued',
        workspaceId: input.workspaceId,
        maxAttempts: input.maxAttempts,
        availableAt: input.availableAt,
        input: input.input,
      };
      jobs.push(job);
      return job;
    },
  };
}

function handlers(edition) {
  return createReportJobHandlers({
    reportService: { async generateDailyReport() { throw new Error('legacy 日报不应被调用'); } },
    treeService: { async generateDaily() { return edition; } },
  });
}

const failedEdition = (retryAt) => ({
  id: 'edition:failed',
  status: 'failed',
  missingHours: [1_700_000_000_000, 1_700_003_600_000],
  groupFailures: [
    { tagId: 'ai', reason: 'queue-timeout', retryable: true, retryAt },
    { tagId: null, reason: 'needs-content', retryable: false, retryAt: null },
  ],
});

test('daily report catchup waits out the group cooldown and stops after three', async () => {
  const retryAt = Date.now() + 30 * 60 * 1000;
  const store = memoryStore();
  const run = handlers(failedEdition(retryAt));
  const logs = [];
  const original = console.error;
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  const job = { id: 'job-daily', workspaceId: 'local', maxAttempts: 2 };
  try {
    await assert.rejects(
      () => run['report.daily.generate'](
        { reportDate: '2026-10-10' },
        { job: { ...job, attemptCount: 1 }, store },
      ),
      /日报浓缩树生成失败，旧刊期继续可读/,
    );
    assert.equal(store.jobs.length, 0);
    assert.match(logs.at(-1), /reportDate=2026-10-10/);
    assert.match(logs.at(-1), /groups=2/);
    assert.match(logs.at(-1), /tag=ai reason=queue-timeout/);
    assert.match(logs.at(-1), new RegExp(`retryAt=${retryAt}`));
    assert.match(logs.at(-1), /tag=null reason=needs-content retryAt=-/);
    assert.match(logs.at(-1), /missingHours=1700000000000,1700003600000/);

    await assert.rejects(
      () => run['report.daily.generate'](
        { reportDate: '2026-10-10' },
        { job: { ...job, attemptCount: 2 }, store },
      ),
      /日报浓缩树生成失败/,
    );
    assert.equal(store.jobs.length, 1);
    assert.equal(store.jobs[0].type, 'report.daily.generate');
    assert.equal(store.jobs[0].input.reportDate, '2026-10-10');
    assert.equal(store.jobs[0].input.catchup, 1);
    assert.equal(store.jobs[0].availableAt, retryAt + DAILY_REPORT_CATCHUP_GRACE_MS);
    assert.equal(store.jobs[0].maxAttempts, 2);

    await assert.rejects(
      () => run['report.daily.generate'](
        { reportDate: '2026-10-10', catchup: 1 },
        { job: { ...job, id: 'job-catchup-1', attemptCount: 2 }, store },
      ),
      /日报浓缩树生成失败/,
    );
    assert.equal(store.jobs.length, 1);

    store.jobs.length = 0;
    await assert.rejects(
      () => run['report.daily.generate'](
        { reportDate: '2026-10-10', catchup: DAILY_REPORT_CATCHUP_LIMIT },
        { job: { ...job, id: 'job-cap', attemptCount: 2 }, store },
      ),
      /日报浓缩树生成失败/,
    );
    assert.equal(store.jobs.length, 0);
  } finally {
    console.error = original;
  }
});

test('daily report catchup is skipped when no group can be retried', async () => {
  const store = memoryStore();
  const run = handlers({
    id: 'edition:failed',
    status: 'failed',
    missingHours: [],
    groupFailures: [{ tagId: 'ai', reason: 'needs-content', retryable: false, retryAt: null }],
  });
  await assert.rejects(
    () => run['report.daily.generate'](
      { reportDate: '2026-10-10' },
      { job: { id: 'job-daily', workspaceId: 'local', attemptCount: 2, maxAttempts: 2 }, store },
    ),
    /日报浓缩树生成失败/,
  );
  assert.equal(store.jobs.length, 0);
});

test('daily generate input accepts an integer catchup count', () => {
  const parsed = parseContract(GenerateDailyReportInputSchema, { reportDate: '2026-10-10', catchup: 2 });
  assert.equal(parsed.catchup, 2);
  assert.equal(parseContract(GenerateDailyReportInputSchema, { reportDate: '2026-10-10' }).catchup, undefined);
  assert.throws(() => parseContract(GenerateDailyReportInputSchema, { catchup: 1.5 }));
  assert.throws(() => parseContract(GenerateDailyReportInputSchema, { catchup: 1, extra: true }));
});
