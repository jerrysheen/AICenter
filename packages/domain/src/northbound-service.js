import { flowDateLabel, shanghaiToday } from './flow-labels.js';
import { formatYiAmount } from './southbound-service.js';

export const NORTHBOUND_NET_UNAVAILABLE = '每日净买入没有公布。2024年8月19日起，沪股通和深股通不再公布每日净买入，只公布成交额和十大成交股。这里的金额是成交额，不是净流入。';
export const NORTHBOUND_TOP10_SCOPE = '十大成交按成交额排序，不是净买入。沪股通、深股通各自前十，不合并。';
export const NORTHBOUND_EMPTY = '北向成交额还没有入库，所以没有数据日期。';

function monthDay(date) {
  return String(date || '').slice(5);
}

function noticeFor(latest) {
  if (latest?.checkStatus === 'mismatch') return { badge: '与港交所成交额不一致', note: '' };
  if (latest?.checkStatus === 'hkex_missing') return { badge: '港交所尚未公布', note: '' };
  return { badge: '', note: '' };
}

function channelView(row, label) {
  return { label, turnover: row ? formatYiAmount(row.dealAmt) : '' };
}

export function cnSymbol(code, channel) {
  const normalized = String(code || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(normalized)) return '';
  return `${normalized}.${channel === 'sz' ? 'SZ' : 'SH'}`;
}

function nameRows(rows, channel) {
  return rows
    .filter((row) => row.channel === channel)
    .sort((left, right) => (left.rank || 0) - (right.rank || 0) || String(left.code).localeCompare(String(right.code)))
    .slice(0, 10)
    .map((row) => ({
      rank: row.rank,
      code: row.code,
      name: String(row.name || '').trim(),
      symbol: cnSymbol(row.code, channel),
      turnover: formatYiAmount(row.dealAmt),
    }));
}

export function buildNorthboundView({ dailyRows = [], topRows = [], days = 20, today = '' } = {}) {
  const totals = dailyRows.filter((row) => row.channel === 'total');
  const latestDate = totals.at(-1)?.tradeDate || '';
  const onLatest = (channel) => dailyRows.find((row) => row.tradeDate === latestDate && row.channel === channel) || null;
  const latestTotal = onLatest('total');
  const windowRows = totals.slice(-days);
  const sum = windowRows.reduce((total, row) => total + (Number(row.dealAmt) || 0), 0);
  const { badge, note } = noticeFor(latestTotal);
  const latestTop = topRows.filter((row) => row.tradeDate === latestDate);
  return {
    ok: true,
    tradeDate: latestDate,
    dateLabel: flowDateLabel(latestDate, today),
    unavailable: NORTHBOUND_NET_UNAVAILABLE,
    empty: latestDate ? '' : NORTHBOUND_EMPTY,
    badge,
    note,
    scope: NORTHBOUND_TOP10_SCOPE,
    channels: {
      sh: channelView(onLatest('sh'), '沪股通'),
      sz: channelView(onLatest('sz'), '深股通'),
      total: channelView(latestTotal, '北向合计'),
    },
    bars: windowRows.map((row) => ({
      date: monthDay(row.tradeDate),
      turnover: Number(formatYiAmount(row.dealAmt)) || 0,
    })),
    rangeTurnover: windowRows.length ? formatYiAmount(sum) : '',
    rangeDays: windowRows.length,
    shTop: nameRows(latestTop, 'sh'),
    szTop: nameRows(latestTop, 'sz'),
  };
}

export function createNorthboundReadService({ repository, workspaceId = 'local' } = {}) {
  if (!repository) throw new Error('northbound read service requires a repository');
  return {
    board(days = 20) {
      const limit = Number.isInteger(days) ? days : 20;
      const dailyRows = repository.listRecent(workspaceId, limit);
      const tradeDate = repository.latestDate(workspaceId);
      const topRows = tradeDate
        ? [
          ...repository.listTop10(workspaceId, tradeDate, 'sh'),
          ...repository.listTop10(workspaceId, tradeDate, 'sz'),
        ]
        : [];
      return buildNorthboundView({
        dailyRows,
        topRows,
        days: limit,
        today: shanghaiToday(),
      });
    },
  };
}
