export const FLOW_BOARD_ID = 'flow';

export const NORTHBOUND_NET_FALLBACK = '每日净买入没有公布。2024年8月19日起，沪股通和深股通不再公布每日净买入，只公布成交额和十大成交股。这里的金额是成交额，不是净流入。';

export function marketStockPath(rest) {
  return rest?.[0] === FLOW_BOARD_ID ? FLOW_BOARD_ID : '';
}

export function stocksHash(stockBoard) {
  return stockBoard === FLOW_BOARD_ID ? '#market/flow' : '#market';
}

export function nextStockBoard(current, routeBoard) {
  if (routeBoard === FLOW_BOARD_ID) return FLOW_BOARD_ID;
  if (current === FLOW_BOARD_ID) return 'overview';
  return current || 'overview';
}

export function flowNetCopy(signed) {
  const text = String(signed ?? '').trim();
  if (!text) return { label: '净额', amount: '—', unit: '亿港元' };
  const negative = text.startsWith('-');
  const amount = text.replace(/^[+-]/, '');
  if (!negative && !text.startsWith('+') && Number(amount) === 0) {
    return { label: '净额', amount, unit: '亿港元' };
  }
  return { label: negative ? '净卖出' : '净买入', amount, unit: '亿港元' };
}

export function flowTurnoverCopy(amount) {
  const text = String(amount ?? '').trim();
  if (!text) return { label: '成交额', amount: '—', unit: '亿元人民币' };
  return { label: '成交额', amount: text.replace(/^[+-]/, ''), unit: '亿元人民币' };
}

export function flowNoteVisible(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (/更新时间|已处理|fetchedAt|check_status|checkStatus|\bsource\b/i.test(value)) return '';
  return value;
}
