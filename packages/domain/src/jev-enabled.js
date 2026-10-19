// Global TypeSafe / jev switch. Default stays on so existing deployments keep
// calling jev until they set AI_CENTER_JEV_ENABLED=false. Per-feature switches
// such as AI_CENTER_JEV_DISABLED still apply when the global switch is on.

export function resolveJevEnabled(env = process.env) {
  const raw = String(env?.AI_CENTER_JEV_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off') return false;
  return true;
}

// explicit === undefined means "construct if enabled". A provided client is
// used only while jev is enabled, so a disabled process never calls it.
export function openJevClient(env, explicit, create) {
  if (!resolveJevEnabled(env)) return null;
  if (explicit !== undefined) return explicit || null;
  if (typeof create !== 'function') return null;
  return create({ env });
}

function integerStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (Number.isInteger(error?.errorStatus)) return error.errorStatus;
  return null;
}

// Outage whitelist. A 200 body without answers, a 4xx other than the listed
// statuses, and a caller abort stay REVIEW. Missing client is jev-unavailable.
export function isJevOutage(error) {
  if (error == null) return false;
  if (typeof error === 'string') return error === 'jev-unavailable';
  if (typeof error !== 'object') return false;
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.errorCode === 'ABORT_ERR') return false;
  const code = String(error.code || error.errorCode || '');
  if (code === 'TYPESAFE_TIMEOUT' || code === 'TYPESAFE_NETWORK_ERROR' || code === 'TYPESAFE_UNAVAILABLE') return true;
  if (code === 'BAMBOO_TIMEOUT' || code === 'BAMBOO_NETWORK_ERROR' || code === 'BAMBOO_UNAVAILABLE' || code === 'BAMBOO_DAILY_CAP' || code === 'BAMBOO_HOURLY_CAP' || code === 'BAMBOO_USAGE_ERROR') return true;
  if (error.errorReason === 'jev-unavailable') return true;
  const status = integerStatus(error);
  return status === 401 || status === 402 || status === 403 || status === 429 || (status != null && status >= 500);
}
