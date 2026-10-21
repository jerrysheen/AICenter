export const FEED_TAG_BATCH = 40;
export const FEED_TAG_GAP_MS = 1_500;
export const FEED_TAG_FRESH_MS = 60_000;
export const FEED_TAG_QUERY_PATH = '/api/v1/tagging/query';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function planFeedTaggingRequests(ids, { known = [], batch = FEED_TAG_BATCH } = {}) {
  const pending = [];
  const seen = new Set(known);
  for (const id of ids || []) {
    const value = String(id || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    pending.push(value);
  }
  const batches = [];
  for (let index = 0; index < pending.length; index += batch) {
    batches.push(pending.slice(index, index + batch));
  }
  return batches;
}

export function createFeedTaggingLoader({
  post,
  now = () => Date.now(),
  gapMs = FEED_TAG_GAP_MS,
  freshMs = FEED_TAG_FRESH_MS,
  batch = FEED_TAG_BATCH,
} = {}) {
  const seenAt = new Map();
  let chain = Promise.resolve();
  let lastAt = 0;
  return {
    load(ids, resourceType = 'content-item', { maxBatches = 0 } = {}) {
      const requested = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
      if (!requested.length) return Promise.resolve([]);
      const run = chain.then(async () => {
        const current = now();
        const pending = requested.filter((id) => {
          const seen = seenAt.get(`${resourceType}:${id}`);
          return seen == null || current - seen >= freshMs;
        });
        const planned = planFeedTaggingRequests(pending, { batch });
        const cap = Number(maxBatches) || 0;
        const batches = cap > 0 ? planned.slice(0, cap) : planned;
        const rows = [];
        for (const group of batches) {
          const wait = lastAt ? Math.max(0, gapMs - (now() - lastAt)) : 0;
          if (wait) await delay(wait);
          const payload = await post({ resourceType, resourceIds: group });
          lastAt = now();
          const stamp = now();
          for (const id of group) seenAt.set(`${resourceType}:${id}`, stamp);
          rows.push(...(payload?.items || []));
        }
        return rows;
      });
      chain = run.then(() => {}, () => {});
      return run;
    },
  };
}
