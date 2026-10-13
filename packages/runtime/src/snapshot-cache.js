export function createMemorySnapshotCache({
  read,
  ttlMs = 45_000,
  missTtlMs = 5_000,
  refreshLeadMs = 0,
  now = () => Date.now(),
} = {}) {
  if (typeof read !== 'function') throw new TypeError('snapshot cache requires a reader');
  let entry = null;
  let refreshing = null;
  let leadTimer = null;

  function armLead() {
    if (leadTimer) clearTimeout(leadTimer);
    leadTimer = null;
    const lead = Math.max(0, Number(refreshLeadMs) || 0);
    if (!entry || lead <= 0 || entry.ttl <= lead) return;
    leadTimer = setTimeout(() => {
      leadTimer = null;
      if (entry && now() - entry.at >= entry.ttl - lead) scheduleRefresh();
    }, entry.ttl - lead);
    leadTimer.unref?.();
  }

  function remember(value) {
    entry = {
      at: now(),
      value,
      ttl: value ? ttlMs : missTtlMs,
    };
    armLead();
    return value;
  }

  function load() {
    const task = Promise.resolve()
      .then(() => read())
      .then((value) => remember(value))
      .catch((error) => {
        if (entry) return entry.value;
        throw error;
      })
      .finally(() => {
        if (refreshing === task) refreshing = null;
      });
    refreshing = task;
    return task;
  }

  function scheduleRefresh() {
    if (refreshing) return;
    setImmediate(() => {
      if (!refreshing) load();
    });
  }

  return {
    async get({ refresh = false } = {}) {
      const timestamp = now();
      const age = entry ? timestamp - entry.at : 0;
      const fresh = entry && !refresh && age < entry.ttl;
      const lead = Math.max(0, Number(refreshLeadMs) || 0);
      if (fresh) {
        if (lead > 0 && age >= entry.ttl - lead) scheduleRefresh();
        return entry.value;
      }
      if (entry && !refresh) {
        scheduleRefresh();
        return entry.value;
      }
      if (refreshing && !refresh) return refreshing;
      return load();
    },
  };
}
