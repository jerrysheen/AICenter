/**
 * LEGACY / LOCAL-RUNTIME ONLY
 *
 * Doubao sidecar for the first Domain web.search in the local Agent loop.
 * Harness does not use this path.
 */
export const AUXILIARY_SEARCH_BUDGET_MS = 80_000;
export const AUXILIARY_SEARCH_GRACE_MS = 35_000;
const MAX_NOTE_CHARS = 4_000;

export function appendAuxiliarySearchNote(answer, text) {
  const extra = String(text || '').trim();
  if (!extra) return String(answer || '').trim();
  const clipped = extra.length > MAX_NOTE_CHARS ? `${extra.slice(0, MAX_NOTE_CHARS)}…` : extra;
  return `${String(answer || '').trim()}\n\n---\n\n### 补充资讯\n\n${clipped}`;
}

export function auxiliarySearchWarning(settled) {
  if (settled?.status === 'login_required') {
    return '补充检索需要先登录网页助手，本次未并入额外资讯';
  }
  return '补充检索未返回，本次回答只基于已完成的网页搜索';
}

export async function takeAuxiliarySearch(handle, {
  signal,
  graceMs = AUXILIARY_SEARCH_GRACE_MS,
  budgetMs = AUXILIARY_SEARCH_BUDGET_MS,
  now = Date.now,
} = {}) {
  if (!handle?.promise) return null;
  const startedAt = Number(handle.startedAt) || now();
  const waitMs = Math.min(graceMs, Math.max(0, budgetMs - (now() - startedAt)));
  let timer;
  let onAbort;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  const abort = !signal ? null : new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const settled = await Promise.race([
      handle.promise.then((value) => (value && typeof value === 'object' ? value : null)).catch(() => null),
      timeout,
      ...(abort ? [abort] : []),
    ]);
    return settled;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
