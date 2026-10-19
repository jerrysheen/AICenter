// Classification provider switch. Default stays TypeSafe so existing
// deployments keep the current client. Bamboo is opt-in.

export function resolveClassificationProvider(env = process.env) {
  const raw = String(env?.AI_CENTER_CLASSIFICATION_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'bamboo' || raw === 'bamboo-startlux' || raw === 'startlux') return 'bamboo';
  return 'typesafe';
}

// When the provider is typesafe, return the already-opened JEV client (null
// while AI_CENTER_JEV_ENABLED is off). When it is bamboo, build that client
// even if JEV is off. Callers still decide which paths receive it.
export function openClassificationClient(env = process.env, {
  typesafeClient = null,
  explicit,
  createBamboo,
} = {}) {
  if (resolveClassificationProvider(env) !== 'bamboo') return typesafeClient || null;
  if (explicit !== undefined) return explicit || null;
  if (typeof createBamboo !== 'function') return null;
  return createBamboo({ env }) || null;
}
