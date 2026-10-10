export const REFERENCE_POOL_VERIFIED_ON = '2026-10-09';
export const REFERENCE_POOL_SOURCE = 'wangwang-etf.com/data/universe.json';

export const ETF_WHALE_UNIVERSE = Object.freeze([
  instrument('510330', 'SH', '沪深300ETF华夏', '宽基/沪深300', true),
  instrument('159919', 'SZ', '沪深300ETF嘉实', '宽基/沪深300', true),
  instrument('510310', 'SH', '沪深300ETF易方达', '宽基/沪深300', true),
  instrument('510300', 'SH', '沪深300ETF华泰柏瑞', '宽基/沪深300', true),
  instrument('510050', 'SH', '上证50ETF华夏', '宽基/上证50', true),
  instrument('510180', 'SH', '上证180ETF华安', '宽基/上证180', true),
  instrument('510500', 'SH', '中证500ETF南方', '宽基/中证500', true),
  instrument('512500', 'SH', '中证500ETF华夏', '宽基/中证500', true),
  instrument('159922', 'SZ', '中证500ETF嘉实', '宽基/中证500', true),
  instrument('515800', 'SH', '中证800ETF汇添富', '宽基/中证800', true),
  instrument('560010', 'SH', '中证1000ETF广发', '宽基/中证1000', true),
  instrument('512100', 'SH', '中证1000ETF南方', '宽基/中证1000', true),
  instrument('159845', 'SZ', '中证1000ETF华夏', '宽基/中证1000', true),
  instrument('159629', 'SZ', '中证1000ETF富国', '宽基/中证1000', true),
  instrument('159915', 'SZ', '创业板ETF易方达', '宽基/创业板', true),
  instrument('159952', 'SZ', '创业板ETF广发', '宽基/创业板', true),
  instrument('159977', 'SZ', '创业板ETF天弘', '宽基/创业板', true),
  instrument('588080', 'SH', '科创50ETF易方达', '宽基/科创50', true),
  instrument('588050', 'SH', '科创50ETF华夏', '宽基/科创50', true),
  instrument('159901', 'SZ', '深证100ETF易方达', '宽基/深证100', true),
  instrument('588000', 'SH', '科创50ETF华夏', '对照/非核心池', false),
]);

function instrument(code, exchange, name, groupKey, referencePool) {
  return Object.freeze({
    code,
    exchange,
    name,
    groupKey,
    referencePool,
    source: REFERENCE_POOL_SOURCE,
    verifiedOn: REFERENCE_POOL_VERIFIED_ON,
  });
}

export function referencePool() {
  return ETF_WHALE_UNIVERSE.filter((item) => item.referencePool);
}

export function universeByCode() {
  return new Map(ETF_WHALE_UNIVERSE.map((item) => [item.code, item]));
}

export function assertUniquePool(items = ETF_WHALE_UNIVERSE) {
  const codes = items.map((item) => item.code);
  const duplicates = codes.filter((code, index) => codes.indexOf(code) !== index);
  if (duplicates.length) throw new Error(`观察池代码重复：${duplicates.join(',')}`);
  return items;
}
