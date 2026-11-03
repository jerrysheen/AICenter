import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobRunner } from '../packages/runtime/src/job-runner.js';

test('an immediately completing backlog yields to I/O before draining the queue', async () => {
  const jobs = new Map();
  let claimed = 0;
  const store = {
    claimNextJob(_worker, types) {
      if (!types.includes('fixture.read') || claimed >= 200) return null;
      const job = { id: String(++claimed), type: 'fixture.read', input: {}, status: 'running', attemptCount: 1 };
      jobs.set(job.id, job);
      return job;
    },
    getJob(id) { return jobs.get(id); },
    completeJob(id) { jobs.get(id).status = 'completed'; return jobs.get(id); },
  };
  const runner = createJobRunner({ store, handlers: { 'fixture.read': async () => ({ ok: true }) }, log() {} });
  const running = runner.start();
  const claimedAtIo = await new Promise((resolve) => setImmediate(() => {
    resolve(claimed);
    runner.stop();
  }));
  await running;
  assert.ok(claimedAtIo < 200, `drained ${claimedAtIo} jobs before allowing I/O`);
  assert.equal(runner.inFlightCount, 0);
});
