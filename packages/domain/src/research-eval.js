export function splitLabeledSet(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (row.role !== 'debug' && row.role !== 'holdout') throw new Error(`标注缺少 debug 或 holdout：${row.id || ''}`);
    if (row.stratum !== 'random' && row.stratum !== 'hard') throw new Error(`标注缺少 random 或 hard：${row.id || ''}`);
  }
  return { debug: list.filter((row) => row.role === 'debug'), holdout: list.filter((row) => row.role === 'holdout') };
}

export function scoreRecall(labels, retrievedIds) {
  const got = new Set(retrievedIds || []);
  const direct = labels.filter((row) => row.direct);
  const relevant = labels.filter((row) => row.direct || row.background);
  const directHit = direct.filter((row) => got.has(row.id)).length;
  const inclusiveHit = relevant.filter((row) => got.has(row.id)).length;
  const labeled = new Map(labels.map((row) => [row.id, row]));
  const falseHit = [...got].filter((id) => labeled.has(id) && !labeled.get(id).direct && !labeled.get(id).background).length;
  const majorMisses = direct.filter((row) => !got.has(row.id)).map((row) => ({ id: row.id, gapReason: row.gapReason || 'unspecified' }));
  return {
    directRecall: direct.length ? directHit / direct.length : null,
    inclusiveRecall: relevant.length ? inclusiveHit / relevant.length : null,
    falseHit,
    majorMisses,
  };
}

export function scoreRecallByStratum(labels, retrievedIds) {
  return {
    random: scoreRecall(labels.filter((row) => row.stratum === 'random'), retrievedIds),
    hard: scoreRecall(labels.filter((row) => row.stratum === 'hard'), retrievedIds),
    all: scoreRecall(labels, retrievedIds),
  };
}

export function compareRecallMethods(labels, methods) {
  return Object.fromEntries(Object.entries(methods).map(([name, ids]) => [name, scoreRecallByStratum(labels, ids)]));
}
