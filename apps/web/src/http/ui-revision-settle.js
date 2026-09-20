export const UI_REVISION_SETTLE = Object.freeze({
  intervalMs: 450,
  stableReads: 3,
  maxReads: 8,
});

export async function settleUntilStable(read, options = {}) {
  const intervalMs = Math.max(0, Number(options.intervalMs) || UI_REVISION_SETTLE.intervalMs);
  const stableReads = Math.max(1, Number(options.stableReads) || UI_REVISION_SETTLE.stableReads);
  const maxReads = Math.max(stableReads, Number(options.maxReads) || UI_REVISION_SETTLE.maxReads);
  const delay = typeof options.delay === 'function'
    ? options.delay
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let last = await read();
  let stable = 1;
  for (let i = 1; i < maxReads && stable < stableReads; i += 1) {
    await delay(intervalMs);
    const next = await read();
    if (Object.is(next, last)) stable += 1;
    else {
      last = next;
      stable = 1;
    }
  }
  return last;
}
