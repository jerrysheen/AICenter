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
