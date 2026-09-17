import { randomUUID } from 'node:crypto';

export function wait(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createJobRunner(options) {
  const store = options.store;
  const handlers = new Map(Object.entries(options.handlers || {}));
  const workerId = options.workerId || `worker-${randomUUID()}`;
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || 1_000);
  const staleAfterMs = Number.isFinite(Number(options.staleAfterMs)) && Number(options.staleAfterMs) > 0
    ? Number(options.staleAfterMs)
    : 10 * 60_000;
  const recoverEveryMs = Math.max(100, Number(options.recoverEveryMs) || 30_000);
  const abortController = new AbortController();
  let running = false;

  function recoverStale() {
    store.recoverStaleJobs?.(staleAfterMs);
  }

  async function runOnce() {
    if (!handlers.size) return null;
    const job = store.claimNextJob(workerId, [...handlers.keys()]);
    if (!job) return null;
    const handler = handlers.get(job.type);
    const heartbeat = setInterval(() => store.touchJob(job.id, workerId), 30_000);
    heartbeat.unref?.();
    const executor = { workerId, attemptCount: job.attemptCount };
    try {
      const output = await handler(job.input, {
        job,
        workerId,
        signal: abortController.signal,
        store,
      });
      return store.completeJob(job.id, output ?? {}, executor);
    } catch (error) {
      const retryDelayMs = Math.min(60_000, 1_000 * (2 ** Math.max(0, job.attemptCount - 1)));
      options.onError?.(error, job);
      return store.failJob(job.id, error, retryDelayMs, executor);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function start() {
    if (running) return;
    running = true;
    recoverStale();
    const recoverTimer = setInterval(recoverStale, recoverEveryMs);
    recoverTimer.unref?.();
    try {
      while (!abortController.signal.aborted) {
        const job = await runOnce();
        if (!job) await wait(pollIntervalMs, abortController.signal);
      }
    } finally {
      clearInterval(recoverTimer);
      running = false;
    }
  }

  function stop() {
    abortController.abort();
  }

  return {
    workerId,
    get running() { return running; },
    runOnce,
    start,
    stop,
  };
}
