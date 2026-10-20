import { Worker } from 'node:worker_threads';

export function mainThreadWatchdogEnabled(env = process.env) {
  return String(env.AI_CENTER_MAIN_THREAD_WATCHDOG || '') === '1';
}

export function startMainThreadWatchdog({
  enabled = false,
  blockMs = 10_000,
  intervalMs = 1_000,
  tasks = () => [],
  log = console.error,
} = {}) {
  if (!enabled) return { stop() {} };
  const worker = new Worker(new URL('./main-thread-watchdog-thread.js', import.meta.url), {
    workerData: { blockMs, intervalMs },
  });
  worker.on('message', (message) => {
    if (message?.type === 'ping') {
      let running = [];
      try { running = tasks() || []; } catch { running = []; }
      worker.postMessage({ type: 'pong', tasks: running });
      return;
    }
    if (message?.type !== 'blocked') return;
    const list = (message.tasks || []).map((task) => `${task.type}:${task.id}`).join(',') || '-';
    log(`[worker] ${message.at} loop-blocked lagMs=${message.lagMs} tasks=${list}`);
  });
  worker.unref?.();
  return {
    stop() {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
    },
  };
}
