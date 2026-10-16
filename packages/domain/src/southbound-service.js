export function formatYiAmount(hkd) {
  const number = Number(hkd);
  if (!Number.isFinite(number)) return '';
  return (number / 100_000_000).toFixed(2);
}

export function formatSignedYi(hkd) {
  const text = formatYiAmount(hkd);
  if (!text) return '';
  return Number(hkd) > 0 ? `+${text}` : text;
}

export function displaySouthboundName(name) {
  return String(name || '').replace(/-W$/, '').trim();
}

export const SOUTHBOUND_TOP10_SCOPE = '十大成交口径：合计是沪、深各自前十相加。只进了一边前十的股票，另一边的成交会少算。';

export function formatSouthboundLine(netHkd, names = []) {
  if (!Number.isFinite(Number(netHkd))) return '';
  const verb = Number(netHkd) < 0 ? '净卖出' : '净买入';
  const head = `南向${verb} ${formatYiAmount(Math.abs(netHkd))} 亿港元`;
  const ranked = [...names]
    .filter((row) => Number.isFinite(Number(row?.netAmt)))
    .sort((left, right) => Math.abs(right.netAmt) - Math.abs(left.netAmt))
    .slice(0, 3);
  if (!ranked.length) return head;
  const tail = ranked.map((row) => `${displaySouthboundName(row.name)} ${formatSignedYi(row.netAmt)} 亿`).join('、');
  return `${head}；${tail}`;
}

export function normalizeHkCode(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  const matched = raw.match(/^(\d{1,5})(?:\.HK)?$/);
  return matched ? matched[1].padStart(5, '0') : '';
}

export function hkSymbol(code) {
  const normalized = normalizeHkCode(code);
  return normalized ? `${normalized}.HK` : '';
}

function monthDay(date) {
  return String(date || '').slice(5);
}

function noticeFor(latest, snapshot) {
  if (latest?.checkStatus === 'mismatch') return { badge: '与港交所成交额不一致', note: '' };
  if (latest?.checkStatus === 'hkex_missing') return { badge: '港交所尚未公布', note: '' };
  if (snapshot?.status === 'late') return { badge: '今日南向尚未公布', note: '' };
  if (snapshot?.status === 'pending') return { badge: '', note: '等待公布' };
  return { badge: '', note: '' };
}

function channelView(row, label) {
  if (!row) return { label, net: '' };
  return { label, net: formatSignedYi(row.netAmt) };
}

function nameRows(rows) {
  return rows.map((row) => ({
    code: row.code,
    name: displaySouthboundName(row.name),
    symbol: hkSymbol(row.code),
    net: formatSignedYi(row.netAmt),
  }));
}

export function buildSouthboundView({ dailyRows = [], topRows = [], snapshot = null, days = 20 } = {}) {
  const totals = dailyRows.filter((row) => row.channel === 'total');
  const latestDate = totals.at(-1)?.tradeDate || '';
  const onLatest = (channel) => dailyRows.find((row) => row.tradeDate === latestDate && row.channel === channel) || null;
  const latestTotal = onLatest('total');
  const windowRows = totals.slice(-days);
  const sum = (count) => windowRows.slice(-count).reduce((total, row) => total + (Number(row.netAmt) || 0), 0);
  const ranked = [...topRows].sort((left, right) => Math.abs(right.netAmt) - Math.abs(left.netAmt));
  const { badge, note } = noticeFor(latestTotal, snapshot);
  return {
    ok: true,
    tradeDate: latestDate,
    badge,
    note,
    scope: SOUTHBOUND_TOP10_SCOPE,
    line: latestTotal ? formatSouthboundLine(latestTotal.netAmt, ranked) : '',
    channels: {
      sh: channelView(onLatest('sh'), '沪'),
      sz: channelView(onLatest('sz'), '深'),
      total: channelView(latestTotal, '合计'),
    },
    bars: windowRows.map((row) => ({
      date: monthDay(row.tradeDate),
      net: Number(row.netAmt) || 0,
    })),
    sum5: formatSignedYi(sum(5)),
    sum20: formatSignedYi(sum(Math.min(20, windowRows.length || 20))),
    buy: nameRows(ranked.filter((row) => row.netAmt > 0).sort((left, right) => right.netAmt - left.netAmt).slice(0, 5)),
    sell: nameRows(ranked.filter((row) => row.netAmt < 0).sort((left, right) => left.netAmt - right.netAmt).slice(0, 5)),
  };
}

export function createSouthboundReadService({ repository, snapshots = null, workspaceId = 'local' } = {}) {
  if (!repository) throw new Error('southbound read service requires a repository');

  function snapshot() {
    return snapshots?.readSnapshot?.(workspaceId, 'southbound-health')?.payload || null;
  }

  return {
    board(days = 20) {
      const limit = Number.isInteger(days) ? days : 20;
      const dailyRows = repository.listRecent(workspaceId, limit);
      const tradeDate = repository.latestDate(workspaceId);
      const topRows = tradeDate ? repository.listTop10(workspaceId, tradeDate, 'total') : [];
      return buildSouthboundView({ dailyRows, topRows, snapshot: snapshot(), days: limit });
    },
    top10(date) {
      const tradeDate = date || repository.latestDate(workspaceId);
      const items = tradeDate ? repository.listTop10(workspaceId, tradeDate, 'total') : [];
      return {
        ok: true,
        tradeDate: tradeDate || '',
        items: items.map((row) => ({
          rank: row.rank,
          code: row.code,
          name: displaySouthboundName(row.name),
          symbol: hkSymbol(row.code),
          net: formatSignedYi(row.netAmt),
        })),
      };
    },
    history(code, days = 20) {
      const normalized = normalizeHkCode(code);
      const items = normalized ? repository.listByCode(workspaceId, normalized, days) : [];
      return {
        ok: true,
        code: normalized,
        symbol: hkSymbol(normalized),
        items: items.map((row) => ({
          date: row.tradeDate,
          net: formatSignedYi(row.netAmt),
        })),
      };
    },
    annotateHoldings(board) {
      const tradeDate = repository.latestDate(workspaceId);
      const rows = tradeDate ? repository.listTop10(workspaceId, tradeDate, 'total') : [];
      const byCode = new Map(rows.map((row) => [row.code, row]));
      for (const position of board?.positions || []) {
        const code = normalizeHkCode(position.symbol);
        const row = code ? byCode.get(code) : null;
        position.southboundTag = row ? `南向 ${formatSignedYi(row.netAmt)} 亿` : '';
      }
      return board;
    },
  };
}
