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

  function reportScheduleError(error, schedule) {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    const key = schedule?.key || schedule?.id || '-';
    const line = `[worker] schedule tick failed key=${key} ${detail}`;
    if (typeof options.log === 'function') options.log(line);
    else console.error(line);
  }

  async function tick(at = now()) {
    const due = store.listDueSchedules(at, options.limit || 50) || [];
    const created = [];
    for (const schedule of due) {
      try {
        if (!allowedJobTypes.has(schedule.jobType)) continue;
        if (typeof options.beforeEnqueue === 'function' && options.beforeEnqueue(schedule, at) === false) continue;
        const result = store.enqueueDueSchedule(schedule.id, at);
        if (result) created.push(result);
      } catch (error) {
        // One schedule must not reject the loop. Node exits on an unhandled rejection,
        // the launcher starts a new Worker, and running jobs become WorkerLeaseExpired.
        reportScheduleError(error, schedule);
      }
    }
    return created;
  }

  async function start() {
    if (running) return;
    running = true;
    try {
      while (!abortController.signal.aborted) {
        try {
          await tick();
        } catch (error) {
          reportScheduleError(error);
        }
        if (abortController.signal.aborted) break;
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
