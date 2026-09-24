export const DIVIDEND_VALUE_RULES = Object.freeze({
  yieldHigh: 0.8,
  peCheap: 0.3,
  yieldLow: 0.2,
  peRich: 0.7,
  painReturn20d: -0.05,
  painDrawdown252d: -0.1,
});

function known(value) {
  return Number.isFinite(value);
}

export function classifyDividendValue(value = {}) {
  const yieldPercentile = value.dividendYieldPercentile5y;
  const pePercentile = value.pePercentile5y;
  const pe = value.peTtm;
  if (!known(yieldPercentile) || !known(pePercentile) || !(pe > 0)) return 'UNKNOWN';
  if (yieldPercentile >= DIVIDEND_VALUE_RULES.yieldHigh && pePercentile <= DIVIDEND_VALUE_RULES.peCheap) return 'HIGH';
  if (yieldPercentile <= DIVIDEND_VALUE_RULES.yieldLow && pePercentile >= DIVIDEND_VALUE_RULES.peRich) return 'LOW';
  return 'NORMAL';
}

export function classifyDividendPain(pain = {}) {
  if (!known(pain.return20d) || !known(pain.drawdown252d)) return 'UNKNOWN';
  if (pain.return20d <= DIVIDEND_VALUE_RULES.painReturn20d && pain.drawdown252d <= DIVIDEND_VALUE_RULES.painDrawdown252d) {
    return 'HIGH';
  }
  return 'NORMAL';
}

export function classifyDividendRegime(factors = {}) {
  const value = classifyDividendValue(factors.value);
  const pain = classifyDividendPain(factors.pain);
  if (value === 'UNKNOWN' || pain === 'UNKNOWN') return 'UNKNOWN';
  if (value === 'HIGH' && pain === 'HIGH') return 'VALUE_HIGH_PAIN_HIGH';
  if (value === 'HIGH') return 'VALUE_HIGH';
  if (value === 'LOW' && pain === 'HIGH') return 'VALUE_LOW_PAIN_HIGH';
  if (value === 'LOW') return 'VALUE_LOW';
  if (pain === 'HIGH') return 'VALUE_NORMAL_PAIN_HIGH';
  return 'NORMAL';
}
