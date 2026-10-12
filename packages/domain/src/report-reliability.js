// Bounded hourly/daily recovery. These helpers stay free of I/O so the retry
// and catch-up decisions can be tested without a model or a database.

export function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

export function upstreamHttpStatus(error) {
  const direct = Number(error?.upstreamStatus ?? error?.status ?? error?.statusCode);
  if (direct === 500 || direct === 503) return direct;
  if (Number.isInteger(direct) && direct >= 400 && direct <= 599 && direct !== 500 && direct !== 503) return direct;
  const matched = String(error?.message || '').match(/(?:模型调用失败：|HTTP\s*|status[=:\s]+)(500|503)\b|(?:^|\s)(500|503)\b/);
  const code = Number(matched?.[1] || matched?.[2]);
  return code === 500 || code === 503 ? code : (Number.isInteger(direct) ? direct : null);
}

export function isRetryableUpstreamStatus(status) {
  return status === 500 || status === 503;
}

export function isAttributionValidationError(error) {
  return /未知或重复输入归属|输入归属不完整|未知主Tag|模块主Tag与固定分组不符/.test(String(error?.message || ''));
}

export function modelRetryDelayMs(attempt, { baseMs = 1000, maxMs = 8000 } = {}) {
  const step = Math.max(0, Number(attempt) || 0);
  const base = Math.max(0, Number(baseMs) || 0);
  const cap = Math.max(base, Number(maxMs) || base);
  return Math.min(cap, base * (2 ** step));
}

export function sameIdSet(left = [], right = []) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((id, index) => id === b[index]);
}

export function nextHourlyAttempt({ prior, inputIds, freshFailure, cap }) {
  const limit = Math.max(1, Number(cap) || 1);
  const same = prior && sameIdSet(prior.inputIds || [], inputIds || []);
  const previousCount = same && prior.status === 'failed' ? (Number(prior.attemptCount) || 1) : 0;
  const attemptCount = freshFailure || !same ? previousCount + 1 : Math.max(1, previousCount);
  return { attemptCount, terminal: attemptCount >= limit };
}
