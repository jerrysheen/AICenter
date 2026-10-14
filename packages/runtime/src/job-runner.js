import { randomUUID } from 'node:crypto';
import { translationRetryDelayMs } from '../../database/src/translation-retry.js';
import { withModelUsageContext } from './model-usage-context.js';
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
  if(type==='report.information.prepare')return limits.informationPreparationLimit;
  if(type==='feed.translation.run')return limits.translationLimit;
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
  const maxRunningMs = Number(options.maxRunningMs);
  const maxRunningMsByType = options.maxRunningMsByType && typeof options.maxRunningMsByType === 'object'
    ? options.maxRunningMsByType
    : {};
  const recoverEveryMs = Math.max(100, Number(options.recoverEveryMs) || 30_000);
  const configuredWatchdog = Number(options.watchdogMs ?? process.env.AI_CENTER_JOB_LOOP_WATCHDOG_MS);
  const watchdogMs = Number.isFinite(configuredWatchdog) && configuredWatchdog > 0
    ? configuredWatchdog
    : 5 * 60_000;
  const concurrency = parseWorkerJobConcurrency(options.concurrency || {});
  const supersedeAfterMs = options.supersedeAfterMs && typeof options.supersedeAfterMs === 'object'
    ? options.supersedeAfterMs
    : {};
  const abortController = new AbortController();
  let running = false;
  const inFlight = new Map();

  function recoverStale() {
    store.recoverStaleJobs?.(staleAfterMs, Date.now(), {
      ...(Number.isFinite(maxRunningMs) && maxRunningMs > 0 ? { maxRunningMs } : {}),
      maxRunningMsByType,
    });
    for (const [id] of inFlight) {
      const current = store.getJob?.(id);
      if (current && current.status !== 'running') inFlight.delete(id);
    }
  }

  function releaseSuperseded(now = Date.now()) {
    for (const [id, item] of inFlight) {
      const limit = Number(supersedeAfterMs[item.type]);
      const current = store.getJob?.(id);
      const replaced = current && current.status !== 'running';
      const expired = Number.isFinite(limit) && limit > 0 && now - item.startedAt >= limit;
      if (!replaced && !expired) continue;
      if (expired && current?.status === 'running') {
        store.abandonRunningJobs?.([item.type], '新的订阅同步开始，上一轮仍未结束', now);
        options.onSupersede?.(item.type, now);
      }
      inFlight.delete(id);
    }
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
      && (!options.readyAt?.[type] || options.readyAt[type]()<=Date.now())
    ));
  }

  async function execute(job) {
    const handler = handlers.get(job.type);
    const heartbeat = setInterval(() => store.touchJob(job.id, workerId), 30_000);
    heartbeat.unref?.();
    const executor = { workerId, attemptCount: job.attemptCount };
    try {
      const output = await withModelUsageContext({ workspaceId: job.workspaceId || 'local', jobId: job.id,
        jobAttempt: job.attemptCount, stage: job.type, observe: value => store.repositories?.modelUsage?.save(value) }, () => handler(job.input, {
        job,
        workerId,
        signal: abortController.signal,
        store,
      }));
      return store.completeJob(job.id, output ?? {}, executor);
    } catch (error) {
      const retryDelayMs = job.type === 'feed.translation.run' && error.code === 'budget-deferred' && Number.isFinite(error.retryAt)
        ? Math.max(1000, error.retryAt - Date.now())
        : job.type === 'feed.translation.run'
          ? translationRetryDelayMs(job.attemptCount)
          : Math.min(60_000, 1_000 * (2 ** Math.max(0, job.attemptCount - 1)));
      options.onError?.(error, job);
      return store.failJob(job.id, error, retryDelayMs, executor);
    } finally {
      clearInterval(heartbeat);
    }
  }

  function launch(job) {
    const tracked = {
      type: job.type,
      startedAt: Date.now(),
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
    const types=claimableTypes();
    if(!types.length)return null;
    const job = store.claimNextJob(workerId, types);
    if (!job) return null;
    return execute(job);
  }

  async function start() {
    if (running) return;
    running = true;
    recoverStale();
    const recoverTimer = setInterval(recoverStale, recoverEveryMs);
    recoverTimer.unref?.();
    let lastTick = Date.now();
    let watchdogLogged = false;
    const watchdogTimer = setInterval(() => {
      const idleMs = Date.now() - lastTick;
      if (idleMs < watchdogMs) {
        watchdogLogged = false;
        return;
      }
      if (watchdogLogged) return;
      watchdogLogged = true;
      const line = `[worker] job loop has not ticked for ${Math.max(1, Math.round(idleMs / 1000))}s`;
      console.error(line);
      options.onWatchdog?.(line, idleMs);
    }, Math.min(watchdogMs, 60_000));
    watchdogTimer.unref?.();
    try {
      while (!abortController.signal.aborted) {
        lastTick = Date.now();
        watchdogLogged = false;
        try {
          releaseSuperseded();
          const types = claimableTypes();
          const job = types.length ? await store.claimNextJob(workerId, types) : null;
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
        } catch (error) {
          if (options.onClaimError) options.onClaimError(error);
          else console.error('[worker] claim failed:', error);
          const jobId = error && typeof error === 'object' ? error.jobId : '';
          if (jobId && typeof store.failQueuedJob === 'function') {
            try {
              store.failQueuedJob(jobId, error);
            } catch (failError) {
              if (options.onClaimError) options.onClaimError(failError);
              else console.error('[worker] claim failed:', failError);
            }
          }
          await wait(pollIntervalMs, abortController.signal);
        }
      }
      await Promise.allSettled([...inFlight.values()].map((item) => item.promise));
    } finally {
      clearInterval(recoverTimer);
      clearInterval(watchdogTimer);
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
