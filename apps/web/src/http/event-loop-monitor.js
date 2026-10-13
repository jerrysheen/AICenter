import { monitorEventLoopDelay } from 'node:perf_hooks';

export function sampleEventLoopDelay(histogram, now = Date.now()) {
  return {
    at: now,
    p50Ms: Number(histogram.percentile(50)) / 1e6,
    p99Ms: Number(histogram.percentile(99)) / 1e6,
    maxMs: Number(histogram.max) / 1e6,
  };
}

export function createEventLoopMonitor({
  intervalMs = 60_000,
  resolution = 20,
  onSample,
  log = console,
} = {}) {
  const histogram = monitorEventLoopDelay({ resolution });
  histogram.enable();
  const timer = setInterval(() => {
    const sample = sampleEventLoopDelay(histogram);
    histogram.reset();
    try {
      onSample?.(sample);
    } catch {
      // 采样失败不影响请求。
    }
    const line = `[web] event-loop p50=${Math.round(sample.p50Ms)}ms p99=${Math.round(sample.p99Ms)}ms max=${Math.round(sample.maxMs)}ms`;
    if (sample.p99Ms >= 200) log.warn?.(line);
    else log.log?.(line);
  }, intervalMs);
  timer.unref?.();
  return {
    histogram,
    stop() {
      clearInterval(timer);
      histogram.disable();
    },
  };
}
