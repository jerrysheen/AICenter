import { formatYmd, zonedParts } from './zoned-time.js';

export function shanghaiToday(at = Date.now()) {
  return formatYmd(zonedParts(at, 'Asia/Shanghai'));
}

export function flowDateLabel(tradeDate, today = '') {
  const date = String(tradeDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  if (today && date !== today) return `数据日期 ${date}，不是今天`;
  return `数据日期 ${date}`;
}
