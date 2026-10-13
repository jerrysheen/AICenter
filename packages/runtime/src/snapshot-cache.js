export function createMemorySnapshotCache({
  read,
  ttlMs = 45_000,
  missTtlMs = 5_000,
  now = () => Date.now(),
} = {}) {
  if (typeof read !== 'function') throw new TypeError('snapshot cache requires a reader');
  let entry = null;
  let refreshing = null;

  function remember(value) {
    entry = {
      at: now(),
      value,
      ttl: value ? ttlMs : missTtlMs,
    };
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

  return {
    async get({ refresh = false } = {}) {
      const timestamp = now();
      const fresh = entry && !refresh && timestamp - entry.at < entry.ttl;
      if (fresh) return entry.value;
      if (entry && !refresh) {
        if (!refreshing) load();
        return entry.value;
      }
      if (refreshing && !refresh) return refreshing;
      return load();
    },
  };
}
