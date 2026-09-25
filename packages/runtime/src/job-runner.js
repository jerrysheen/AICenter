import { randomUUID } from 'node:crypto';
import {
  parseWorkerJobConcurrency,
  QUANT_PREPARE_JOB_TYPE,
  QUANT_RUN_JOB_TYPE,
  WORK_PACKAGE_DISPATCH_JOB_TYPE,
} from '../../contracts/src/index.js';

export { WORK_PACKAGE_DISPATCH_JOB_TYPE };

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

export function resolveJobTypeConcurrency(type, concurrency) {
  const limits = parseWorkerJobConcurrency(concurrency || {});
  if (type === WORK_PACKAGE_DISPATCH_JOB_TYPE) return limits.workPackageDispatchLimit;
  if (type === QUANT_PREPARE_JOB_TYPE || type === QUANT_RUN_JOB_TYPE) return limits.quantLabLimit;
  return limits.defaultLimit;
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
  const concurrency = parseWorkerJobConcurrency(options.concurrency || {});
  const abortController = new AbortController();
  let running = false;
  const inFlight = new Map();

  function recoverStale() {
    store.recoverStaleJobs?.(staleAfterMs);
  }

  function runningCount(type) {
    const quant = type === QUANT_PREPARE_JOB_TYPE || type === QUANT_RUN_JOB_TYPE;
    let count = 0;
    for (const item of inFlight.values()) {
      const sameFamily = quant
        ? item.type === QUANT_PREPARE_JOB_TYPE || item.type === QUANT_RUN_JOB_TYPE
        : item.type === type;
      if (sameFamily) count += 1;
    }
    return count;
  }

  function claimableTypes() {
    return [...handlers.keys()].filter((type) => (
      runningCount(type) < resolveJobTypeConcurrency(type, concurrency)
    ));
  }

  async function execute(job) {
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

  function launch(job) {
    const tracked = {
      type: job.type,
      promise: execute(job)
        .catch((error) => {
          options.onError?.(error, job);
          return null;
        })
        .finally(() => {
          inFlight.delete(job.id);
        }),
    };
    inFlight.set(job.id, tracked);
    return tracked.promise;
  }

  async function runOnce() {
    if (!handlers.size) return null;
    const job = store.claimNextJob(workerId, [...handlers.keys()]);
    if (!job) return null;
    return execute(job);
  }

  async function start() {
    if (running) return;
    running = true;
    recoverStale();
    const recoverTimer = setInterval(recoverStale, recoverEveryMs);
    recoverTimer.unref?.();
    try {
      while (!abortController.signal.aborted) {
        const types = claimableTypes();
        const job = types.length ? store.claimNextJob(workerId, types) : null;
        if (job) {
          launch(job);
          continue;
        }
        if (!inFlight.size) {
          await wait(pollIntervalMs, abortController.signal);
          continue;
        }
        await Promise.race([
          wait(pollIntervalMs, abortController.signal),
          ...[...inFlight.values()].map((item) => item.promise),
        ]);
      }
      await Promise.allSettled([...inFlight.values()].map((item) => item.promise));
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
    concurrency,
    get running() { return running; },
    get inFlightCount() { return inFlight.size; },
    runOnce,
    start,
    stop,
  };
}
