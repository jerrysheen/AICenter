import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
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

export function translationClaimMinPriority(runningTranslationJobs, translationLimit, backfillRunning = 0, backfillLimit = null) {
  const limit = Number(translationLimit) || 1;
  const running = Number(runningTranslationJobs) || 0;
  const backfill = Number(backfillRunning) || 0;
  const cap = backfillLimit == null ? null : Math.max(1, Number(backfillLimit) || 1);
  if (cap != null && limit >= 2 && backfill >= Math.min(cap, limit - 1)) return 0;
  if (limit < 2 || running >= limit || running < limit - 1) return null;
  return 0;
}

export function formatJobLoopDelay(job, delay) {
  const maxMs = Math.round(Number(delay?.maxMs) || 0);
  const meanMs = Math.round(Number(delay?.meanMs) || 0);
  return `[worker] ${job.type} ${job.id} loopMaxMs=${maxMs} loopMeanMs=${meanMs}`;
}

function openLoopDelay() {
  try {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    return histogram;
  } catch {
    return null;
  }
}

function readLoopDelay(histogram) {
  if (!histogram) return { maxMs: 0, meanMs: 0 };
  const maxMs = Number(histogram.max) / 1e6;
  const meanMs = Number(histogram.mean) / 1e6;
  try { histogram.disable(); } catch { /* 采样结束失败不影响任务结果。 */ }
  return {
    maxMs: Number.isFinite(maxMs) ? maxMs : 0,
    meanMs: Number.isFinite(meanMs) ? meanMs : 0,
  };
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
  const translationBackfillCap = Number.isInteger(Number(options.translationBackfillCap)) && Number(options.translationBackfillCap) >= 1
    ? Number(options.translationBackfillCap)
    : null;
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
      executingIds: [...inFlight.keys()],
    });
    for (const [id, item] of [...inFlight]) {
      const current = store.getJob?.(id);
      if (current && current.status !== 'running') dropExecution(id, item);
    }
  }

  function dropExecution(id, item) {
    item.controller?.abort();
    if (inFlight.get(id) === item) inFlight.delete(id);
  }

  function releaseSuperseded(now = Date.now()) {
    for (const [id, item] of [...inFlight]) {
      const limit = Number(supersedeAfterMs[item.type]);
      const current = store.getJob?.(id);
      const replaced = current && current.status !== 'running';
      const expired = Number.isFinite(limit) && limit > 0 && now - item.startedAt >= limit;
      if (!replaced && !expired) continue;
      if (expired && current?.status === 'running') {
        store.abandonRunningJobs?.([item.type], '新的订阅同步开始，上一轮仍未结束', now);
        options.onSupersede?.(item.type, now);
      }
      dropExecution(id, item);
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

  function backfillRunning() {
    let count = 0;
    for (const item of inFlight.values()) {
      if (item.type === 'feed.translation.run' && item.backfill) count += 1;
    }
    return count;
  }

  function claimableTypes() {
    return [...handlers.keys()].filter((type) => (
      runningCount(type) < resolveJobTypeConcurrency(type, concurrency)
      && (!options.readyAt?.[type] || options.readyAt[type]()<=Date.now())
    ));
  }

  function abortResult(signal) {
    if (!signal || signal.aborted) return { promise: Promise.resolve({ aborted: true }), cancel() {} };
    let onAbort = () => {};
    const promise = new Promise((resolve) => {
      onAbort = () => resolve({ aborted: true });
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return {
      promise,
      cancel() { signal.removeEventListener('abort', onAbort); },
    };
  }

  function executionSignal(controller) {
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([abortController.signal, controller.signal]);
    return controller.signal;
  }

  async function execute(job, signal, jobController = null) {
    const handler = handlers.get(job.type);
    const heartbeat = setInterval(() => {
      if (signal?.aborted) return;
      store.touchJob(job.id, workerId);
    }, 30_000);
    heartbeat.unref?.();
    const loopDelay = openLoopDelay();
    const executor = { workerId, attemptCount: job.attemptCount };
    const backfill = job.type === 'feed.translation.run' && Number(job.priority) < 0;
    let quotaWaits = 0;
    try {
      while (!signal?.aborted) {
        const cancelled = jobController ? abortResult(jobController.signal) : null;
        let outcome;
        try {
          const work = Promise.resolve().then(() => withModelUsageContext({ workspaceId: job.workspaceId || 'local', jobId: job.id,
            jobAttempt: job.attemptCount, stage: job.type, observe: value => store.repositories?.modelUsage?.save(value) }, () => handler(job.input, {
            job,
            workerId,
            signal,
            store,
          }))).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          outcome = cancelled ? await Promise.race([work, cancelled.promise]) : await work;
        } finally {
          cancelled?.cancel();
        }
        if (jobController?.signal.aborted || outcome?.aborted) return null;
        if (!outcome.error) return store.completeJob(job.id, outcome.value ?? {}, executor);
        const error = outcome.error;
        const retryAt = Number(error?.retryAt);
        if (backfill && error?.code === 'budget-deferred' && Number.isFinite(retryAt) && quotaWaits < 4) {
          quotaWaits += 1;
          await wait(Math.min(70_000, Math.max(1_000, retryAt - Date.now())), signal);
          if (!signal?.aborted) continue;
          return null;
        }
        const retryDelayMs = job.type === 'feed.translation.run' && error.code === 'budget-deferred' && Number.isFinite(error.retryAt)
          ? Math.max(1000, error.retryAt - Date.now())
          : job.type === 'feed.translation.run'
            ? translationRetryDelayMs(job.attemptCount)
            : Math.min(60_000, 1_000 * (2 ** Math.max(0, job.attemptCount - 1)));
        options.onError?.(error, job);
        return store.failJob(job.id, error, retryDelayMs, executor);
      }
      return null;
    } finally {
      clearInterval(heartbeat);
      try {
        options.onJobEnd?.(job, readLoopDelay(loopDelay));
      } catch {
        // 卡顿日志失败不影响任务结果。
      }
    }
  }

  function launch(job) {
    const controller = new AbortController();
    const tracked = {
      type: job.type,
      backfill: job.type === 'feed.translation.run' && Number(job.priority) < 0,
      startedAt: Date.now(),
      controller,
      promise: execute(job, executionSignal(controller), controller)
        .catch((error) => {
          options.onError?.(error, job);
          return null;
        })
        .finally(() => {
          if (inFlight.get(job.id) === tracked) inFlight.delete(job.id);
        }),
    };
    inFlight.set(job.id, tracked);
    return tracked.promise;
  }

  function claimOptions(types) {
    if (!types.includes('feed.translation.run')) return {};
    const minPriority = translationClaimMinPriority(
      runningCount('feed.translation.run'),
      resolveJobTypeConcurrency('feed.translation.run', concurrency),
      backfillRunning(),
      translationBackfillCap,
    );
    return minPriority == null ? {} : { minPriority };
  }

  async function runOnce() {
    if (!handlers.size) return null;
    const types=claimableTypes();
    if(!types.length)return null;
    const job = store.claimNextJob(workerId, types, claimOptions(types));
    if (!job) return null;
    return execute(job, abortController.signal);
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
          const job = types.length ? await store.claimNextJob(workerId, types, claimOptions(types)) : null;
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
