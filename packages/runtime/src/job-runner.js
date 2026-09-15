import { randomUUID } from 'node:crypto';

function wait(milliseconds, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function createJobRunner(options) {
  const store = options.store;
  const handlers = new Map(Object.entries(options.handlers || {}));
  const workerId = options.workerId || `worker-${randomUUID()}`;
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || 1_000);
  const abortController = new AbortController();
  let running = false;

  async function runOnce() {
    if (!handlers.size) return null;
    const job = store.claimNextJob(workerId, [...handlers.keys()]);
    if (!job) return null;
    const handler = handlers.get(job.type);
    const heartbeat = setInterval(() => store.touchJob(job.id, workerId), 30_000);
    heartbeat.unref?.();
    try {
      const output = await handler(job.input, {
        job,
        workerId,
        signal: abortController.signal,
        store,
      });
      return store.completeJob(job.id, output ?? {});
    } catch (error) {
      const retryDelayMs = Math.min(60_000, 1_000 * (2 ** Math.max(0, job.attemptCount - 1)));
      options.onError?.(error, job);
      return store.failJob(job.id, error, retryDelayMs);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function start() {
    if (running) return;
    running = true;
    while (!abortController.signal.aborted) {
      const job = await runOnce();
      if (!job) await wait(pollIntervalMs, abortController.signal);
    }
    running = false;
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
