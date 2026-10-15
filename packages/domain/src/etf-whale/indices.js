export const ETF_WHALE_INDICES = Object.freeze([
  Object.freeze({ symbol: '000300', exchange: 'SH', name: '沪深300' }),
  Object.freeze({ symbol: '000016', exchange: 'SH', name: '上证50' }),
  Object.freeze({ symbol: '000905', exchange: 'SH', name: '中证500' }),
  Object.freeze({ symbol: '000852', exchange: 'SH', name: '中证1000' }),
  Object.freeze({ symbol: '399006', exchange: 'SZ', name: '创业板指' }),
  Object.freeze({ symbol: '000688', exchange: 'SH', name: '科创50' }),
]);

export const CFFEX_PRODUCTS = Object.freeze(['IF', 'IH', 'IC', 'IM']);
export const TURNOVER_SOURCE = 'sina-amount';
export const CITIC_PARTY_ID_DEFAULT = '0018';

export function citicPartyId(env = process.env) {
  const raw = String(env.AI_CENTER_ETF_WHALE_CITIC_PARTY_ID || CITIC_PARTY_ID_DEFAULT).trim();
  return raw.padStart(4, '0');
}

export function marketSymbol(code, exchange) {
  const prefix = exchange === 'SZ' ? 'sz' : 'sh';
  return `${prefix}${code}`;
}

export function eastmoneySecid(code, exchange) {
  return `${exchange === 'SZ' ? '0' : '1'}.${code}`;
}
