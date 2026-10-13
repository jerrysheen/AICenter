import { performance } from 'node:perf_hooks';

export function formatEventLoopLine(sample) {
  return `[web] event-loop p50=${Math.round(sample.p50Ms)}ms p99=${Math.round(sample.p99Ms)}ms max=${Math.round(sample.maxMs)}ms`;
}

export function formatEventLoopBlock(block) {
  return `[web] event-loop-block task=${block.task} blockedMs=${block.blockedMs}`;
}

export function combineLoopDelayMs(histogramMs, blockMs) {
  const values = [histogramMs, blockMs].filter((value) => Number.isFinite(value) && value >= 0);
  if (!values.length) return null;
  return Math.max(...values);
}

let bound = null;

export function bindEventLoopProbe(probe) {
  bound = probe || null;
}

export function labelEventLoop(name) {
  return bound?.enter(name) || (() => {});
}

export function lastEventLoopBlock() {
  return bound?.lastBlock() || null;
}

export function createEventLoopProbe({
  intervalMs = 50,
  blockMs = 50,
  now = () => performance.now(),
  onBlock,
} = {}) {
  let label = 'idle';
  const stack = [];
  let retire = 0;
  let lastTick = process.hrtime.bigint();
  let last = null;
  const timer = setInterval(() => {
    const current = process.hrtime.bigint();
    const gapMs = Number(current - lastTick) / 1e6;
    lastTick = current;
    const blockedMs = gapMs - intervalMs;
    if (blockedMs >= blockMs) {
      const block = { at: Date.now(), blockedMs: Math.round(blockedMs), task: label };
      last = block;
      try { onBlock?.(block); } catch { /* 归因失败不影响请求 */ }
    }
    if (retire > 0) {
      retire -= 1;
      label = stack.pop() || 'idle';
    }
  }, intervalMs);
  timer.unref?.();

  function enter(name) {
    stack.push(label);
    label = String(name || 'task');
    let left = false;
    return () => {
      if (left) return;
      left = true;
      retire += 1;
    };
  }

  return {
    enter,
    lastBlock() { return last; },
    stop() { clearInterval(timer); },
  };
}
