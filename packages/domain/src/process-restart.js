function normalizePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function classifyPath(file) {
  if (!file) return 'ignore';
  if (
    file.startsWith('docs/')
    || file.startsWith('test/')
    || file.startsWith('.cursor/')
    || file.startsWith('knowledge/')
    || file.startsWith('apps/harmony/')
    || file.startsWith('apps/web/public/')
  ) {
    return 'ignore';
  }
  if (file.startsWith('apps/web/src/')) return 'web';
  if (file.startsWith('apps/worker/')) return 'worker';
  if (
    file.startsWith('packages/')
    || file === 'package.json'
    || file === 'package-lock.json'
  ) {
    return 'both';
  }
  return 'ignore';
}

export function classifyProcessRestart(changedPaths = []) {
  const paths = [...new Set((Array.isArray(changedPaths) ? changedPaths : [changedPaths]).map(normalizePath))]
    .filter(Boolean);
  let web = false;
  let worker = false;
  const reasons = [];
  for (const file of paths) {
    const kind = classifyPath(file);
    if (kind === 'ignore') continue;
    reasons.push(file);
    if (kind === 'web' || kind === 'both') web = true;
    if (kind === 'worker' || kind === 'both') worker = true;
  }
  const scope = web && worker ? 'both' : web ? 'web' : worker ? 'worker' : 'none';
  return Object.freeze({
    required: scope !== 'none',
    scope,
    reasons,
    restartRequired: scope === 'none' ? 'not_required' : 'required',
  });
}
