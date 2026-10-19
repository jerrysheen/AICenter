// Offline helpers for the Bamboo / JEV label comparison. They do not call a model.

const NEEDLES = Object.freeze(['创业板', '光通信', '光模块', '光纤', '光伏', '创业公司', '港股', '主板']);

export function selectComparisonItems(items, { limit = 50, needles = NEEDLES } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter((item) => item && item.id);
  const wanted = Math.max(0, Math.min(Number(limit) || 0, rows.length));
  const picked = [];
  const seen = new Set();
  const take = (item) => {
    if (!item || seen.has(item.id) || picked.length >= wanted) return;
    seen.add(item.id);
    picked.push(item);
  };
  for (const needle of needles) {
    take(rows.find((item) => textOf(item).includes(needle)));
  }
  const providers = [...new Set(rows.map((item) => String(item.provider || 'other')))];
  const buckets = new Map(providers.map((provider) => [provider, rows.filter((item) => String(item.provider || 'other') === provider)]));
  let moved = true;
  while (picked.length < wanted && moved) {
    moved = false;
    for (const provider of providers) {
      const bucket = buckets.get(provider) || [];
      const next = bucket.find((item) => !seen.has(item.id));
      if (!next) continue;
      take(next);
      moved = true;
      if (picked.length >= wanted) break;
    }
  }
  return picked;
}

function textOf(item) {
  return [item.title, item.summary, item.body].map((value) => String(value || '')).join('\n');
}

export function hitsAt(scores, threshold) {
  const limit = Number(threshold);
  if (!Number.isFinite(limit)) return [];
  return Object.entries(scores || {})
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= limit)
    .map(([id]) => id)
    .sort();
}

export function labelSetDiff(left, right) {
  const a = new Set(left || []);
  const b = new Set(right || []);
  return {
    onlyLeft: [...a].filter((id) => !b.has(id)).sort(),
    onlyRight: [...b].filter((id) => !a.has(id)).sort(),
  };
}

// Human labels must be an array. null means unlabeled and is left out of the score.
// A tag with no positive labels does not get a precision or F1.
export function labelMetrics(rows, tagIds, threshold = 0.5) {
  const metrics = {};
  for (const tag of tagIds) {
    let labeled = 0;
    let positives = 0;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    const misses = [];
    for (const row of rows || []) {
      if (!Array.isArray(row?.human)) continue;
      labeled += 1;
      const expected = row.human.includes(tag);
      const predicted = typeof row.scores?.[tag] === 'number' && row.scores[tag] >= threshold;
      if (expected) positives += 1;
      if (expected && predicted) tp += 1;
      else if (!expected && predicted) {
        fp += 1;
        misses.push({ id: row.id, title: row.title || '', kind: 'fp', score: row.scores[tag] });
      } else if (expected && !predicted) {
        fn += 1;
        misses.push({ id: row.id, title: row.title || '', kind: 'fn', score: row.scores?.[tag] ?? null });
      }
    }
    if (positives === 0) {
      metrics[tag] = { labeled, positives: 0, precision: null, recall: null, f1: null, reason: '无正例，不算分', misses: [] };
      continue;
    }
    const precision = tp + fp === 0 ? null : tp / (tp + fp);
    const recall = tp / positives;
    const f1 = precision == null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
    metrics[tag] = { labeled, positives, tp, fp, fn, precision, recall, f1, misses };
  }
  return metrics;
}
