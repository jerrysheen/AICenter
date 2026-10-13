import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { json } from './response.js';
import { sendPreparedJson } from './prepared-json.js';

const DEFAULT_TTL_MS = 15_000;

export function startOffthreadJson({
  databasePath,
  pipeline = 'legacy',
  timezone = 'Asia/Shanghai',
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  let worker = null;
  let failed = false;
  let booted = false;
  const waiters = new Map();
  const readyWaiters = [];
  const cache = new Map();
  const inflight = new Map();
  let seq = 0;

  function failAll(error) {
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  }

  function ensure() {
    if (worker || failed) return worker;
    if (!databasePath || databasePath === ':memory:' || !existsSync(databasePath)) {
      failed = true;
      return null;
    }
    try {
      worker = new Worker(new URL('./offthread-json-worker.js', import.meta.url), {
        workerData: { databasePath, pipeline, timezone },
      });
    } catch {
      failed = true;
      return null;
    }
    worker.on('message', (message) => {
      if (message?.type === 'ready') {
        booted = true;
        const pending = readyWaiters.splice(0);
        for (const resolve of pending) resolve(true);
        return;
      }
      const waiter = waiters.get(message?.id);
      if (!waiter) return;
      waiters.delete(message.id);
      clearTimeout(waiter.timer);
      if (!message.json) {
        waiter.reject(new Error(message.error || '离线读取失败'));
        return;
      }
      waiter.resolve({
        status: Number(message.status) || 200,
        prepared: {
          json: Buffer.from(message.json),
          gzipped: message.gzipped ? Buffer.from(message.gzipped) : null,
          etag: message.etag,
          bytes: message.bytes,
        },
      });
    });
    worker.on('error', (error) => {
      failed = true;
      failAll(error);
      const pending = readyWaiters.splice(0);
      for (const resolve of pending) resolve(false);
    });
    return worker;
  }

  function ready() {
    const current = ensure();
    if (!current) return Promise.resolve(false);
    if (booted) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      readyWaiters.push((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      try {
        current.postMessage({ type: 'ping' });
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  function build(task) {
    const key = JSON.stringify(task);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = new Promise((resolve, reject) => {
      const current = ensure();
      if (!current) {
        reject(new Error('离线读取尚未就绪'));
        return;
      }
      const id = seq += 1;
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error('离线读取超时'));
      }, 12_000);
      timer.unref?.();
      waiters.set(id, {
        timer,
        resolve: (value) => {
          if (value.status === 200) cache.set(key, { value, expires: Date.now() + ttlMs });
          resolve(value);
        },
        reject,
      });
      try {
        current.postMessage({ type: 'build', id, task });
      } catch (error) {
        clearTimeout(timer);
        waiters.delete(id);
        reject(error);
      }
    });
    inflight.set(key, promise);
    promise.finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
    return promise;
  }

  return {
    build,
    ready,
    stop() {
      failAll(new Error('离线读取已停止'));
      const current = worker;
      worker = null;
      return current ? current.terminate() : Promise.resolve();
    },
  };
}

export async function sendOffthreadJson(offthread, request, response, task, headers = {}) {
  if (typeof offthread?.build !== 'function') {
    json(response, 503, { ok: false, error: '离线读取尚未就绪' });
    return;
  }
  const result = await offthread.build(task);
  sendPreparedJson(request, response, result.status || 200, result.prepared, {
    ETag: result.prepared.etag,
    'Cache-Control': 'no-store',
    ...headers,
  });
}
