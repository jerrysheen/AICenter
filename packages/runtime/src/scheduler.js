import { wait } from './job-runner.js';

export function createScheduler(options) {
  const store = options.store;
  if (!store?.listDueSchedules || !store?.enqueueDueSchedule) {
    throw new Error('scheduler requires schedule store methods');
  }
  const allowedJobTypes = new Set(options.allowedJobTypes || []);
  const pollIntervalMs = Math.max(1_000, Number(options.pollIntervalMs) || 20_000);
  const now = options.now || (() => Date.now());
  const abortController = new AbortController();
  let running = false;

  async function tick(at = now()) {
    const due = store.listDueSchedules(at, options.limit || 50) || [];
    const created = [];
    for (const schedule of due) {
      if (!allowedJobTypes.has(schedule.jobType)) continue;
      const result = store.enqueueDueSchedule(schedule.id, at);
      if (result) created.push(result);
    }
    return created;
  }

  async function start() {
    if (running) return;
    running = true;
    try {
      while (!abortController.signal.aborted) {
        await tick();
        await wait(pollIntervalMs, abortController.signal);
      }
    } finally {
      running = false;
    }
  }

  function stop() {
    abortController.abort();
  }

  return {
    get running() { return running; },
    tick,
    start,
    stop,
  };
}
