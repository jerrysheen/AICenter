export function percentileRank(series, current) {
  const values = (series || []).filter((value) => Number.isFinite(value));
  if (!values.length || !Number.isFinite(current)) return null;
  const count = values.reduce((total, value) => total + (value <= current ? 1 : 0), 0);
  return count / values.length;
}

export function sampleStd(values) {
  if (!values || values.length < 2) return null;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
