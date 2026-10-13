import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

export function startSnapshotBufferLoader({
  databasePath,
  slots,
  keys,
  intervalMs = 5_000,
} = {}) {
  if (!databasePath || databasePath === ':memory:' || !existsSync(databasePath) || !slots || !keys?.length) {
    return {
      stop() { return Promise.resolve(); },
      refresh() { return Promise.resolve(false); },
    };
  }
  let worker;
  try {
    worker = new Worker(new URL('./snapshot-buffer-worker.js', import.meta.url), {
      workerData: { databasePath },
    });
  } catch {
    return {
      stop() { return Promise.resolve(); },
      refresh() { return Promise.resolve(false); },
    };
  }
  const known = {};
  let waiters = [];
  const settle = (ok) => {
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve(ok);
  };
  worker.on('message', (message) => {
    if (message?.type === 'slots') {
      for (const update of message.updates || []) {
        known[update.slot] = update.generatedAt;
        slots.publish(update.slot, {
          json: Buffer.from(update.json),
          gzipped: update.gzipped ? Buffer.from(update.gzipped) : null,
          etag: update.etag,
          bytes: update.bytes,
          generatedAt: update.generatedAt,
        });
      }
      settle(true);
      return;
    }
    if (message?.type === 'error') settle(false);
  });
  worker.on('error', () => settle(false));
  const poll = () => {
    try {
      worker.postMessage({ type: 'poll', keys, known: { ...known } });
    } catch {
      settle(false);
    }
  };
  poll();
  const timer = setInterval(poll, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      return worker.terminate();
    },
    refresh() {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 2_000);
        waiters.push((ok) => {
          clearTimeout(timeout);
          resolve(ok);
        });
        poll();
      });
    },
  };
}
