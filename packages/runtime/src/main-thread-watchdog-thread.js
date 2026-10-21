import { parentPort, workerData } from 'node:worker_threads';

const intervalMs = Math.max(20, Number(workerData?.intervalMs) || 1000);
const blockMs = Math.max(intervalMs, Number(workerData?.blockMs) || 10_000);
let lastPongAt = Date.now();
let lastTasks = [];
let reported = false;

function post(message) {
  try { parentPort.postMessage(message); } catch { /* 主进程正在退出 */ }
}

const timer = setInterval(() => {
  const lagMs = Date.now() - lastPongAt;
  if (lagMs >= blockMs && !reported) {
    reported = true;
    post({
      type: 'blocked',
      at: new Date().toISOString(),
      lagMs,
      tasks: lastTasks,
    });
  }
  post({ type: 'ping' });
}, intervalMs);

parentPort.on('message', (message) => {
  if (message?.type === 'pong') {
    lastPongAt = Date.now();
    lastTasks = Array.isArray(message.tasks) ? message.tasks : [];
    reported = false;
    return;
  }
  if (message?.type === 'stop') {
    clearInterval(timer);
    process.exit(0);
  }
});
