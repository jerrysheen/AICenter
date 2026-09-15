import { ASIA_GROUPS, ASIA_INDICES, ASIA_WATCHLIST } from './asia-catalog.js';
import { US_GROUPS, US_INDICES, US_WATCHLIST } from './us-catalog.js';

const US_INDEX_SYMBOLS = new Set(US_INDICES.map((item) => item.symbol));
const ASIA_INDEX_SYMBOLS = new Set(ASIA_INDICES.map((item) => item.symbol));

function emptyQuote(symbol, name, currency = '') {
  return {
    symbol,
    name,
    lastPrice: null,
    changePct: null,
    change: null,
    open: null,
    high: null,
    low: null,
    prevClose: null,
    volume: null,
    sparkline: [],
    currency,
    exchange: '',
    marketTime: null,
    session: 'closed',
  };
}

function toSnapshot(quote, extras = {}) {
  return {
    symbol: quote.symbol,
    name: quote.name,
    market: extras.market,
    assetClass: extras.assetClass || 'equity',
    group: extras.group || '',
    summary: extras.summary || '',
    lastPrice: quote.lastPrice,
    changePct: quote.changePct,
    change: quote.change,
    high: quote.high,
    low: quote.low,
    prevClose: quote.prevClose,
    volume: quote.volume,
    sparkline: Array.isArray(quote.sparkline) ? quote.sparkline : [],
    currency: quote.currency || extras.currency || '',
    exchange: quote.exchange || '',
    session: quote.session || extras.session || 'closed',
    asOf: quote.marketTime ? quote.marketTime * 1000 : extras.fetchedAt || null,
    provider: 'yahoo',
  };
}

function parseExtras(raw, pattern, known) {
  if (!raw) return [];
  return [...new Set(String(raw).split(',').map((item) => item.trim().toUpperCase())
    .filter((symbol) => pattern.test(symbol) && !known.has(symbol)))];
}

export function parseUsExtraSymbols(raw) {
  const known = new Set([...US_INDICES, ...US_WATCHLIST].map((item) => item.symbol));
  return parseExtras(raw, /^[A-Z^][A-Z0-9.^-]{0,11}$/, known);
}

export function parseAsiaExtraSymbols(raw) {
  const known = new Set([...ASIA_INDICES, ...ASIA_WATCHLIST].map((item) => item.symbol));
  return parseExtras(raw, /^[A-Z0-9^][A-Z0-9.^-]{0,14}$/, known);
}

export function usTrackedItems(extraSymbols = []) {
  const extras = extraSymbols.map((symbol) => ({ symbol, name: symbol, group: '自选' }));
  return [...US_INDICES, ...US_WATCHLIST, ...extras];
}

export function asiaTrackedItems(extraSymbols = []) {
  const extras = extraSymbols.map((symbol) => ({ symbol, name: symbol, group: '自选' }));
  return [...ASIA_INDICES, ...ASIA_WATCHLIST, ...extras];
}

function sessionInWindow(nowMs, timeZone, openMinutes, closeMinutes) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const weekday = parts.find((part) => part.type === 'weekday')?.value || '';
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  const current = hour * 60 + minute;
  return current >= openMinutes && current < closeMinutes ? 'regular' : 'closed';
}

export function asiaSessionsAt(nowMs = Date.now()) {
  return {
    kr: sessionInWindow(nowMs, 'Asia/Seoul', 9 * 60, 15 * 60 + 30),
    tw: sessionInWindow(nowMs, 'Asia/Taipei', 9 * 60, 13 * 60 + 30),
    jp: sessionInWindow(nowMs, 'Asia/Tokyo', 9 * 60, 15 * 60),
  };
}

function assembleBoard({
  board, market, session, sessions, note, groups, indices, watchlist, errors, fetchedAt, indexSymbols, currency,
}) {
  const ranked = watchlist.filter((item) => item.changePct !== null && !indexSymbols.has(item.symbol));
  const advancers = ranked.filter((item) => (item.changePct ?? 0) > 0.005).length;
  const decliners = ranked.filter((item) => (item.changePct ?? 0) < -0.005).length;
  const unchanged = Math.max(ranked.length - advancers - decliners, 0);
  const byMove = [...ranked].sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity));
  return {
    board,
    mode: errors || watchlist.some((item) => item.lastPrice === null) ? 'partial' : 'live',
    fetchedAt,
    session,
    sessions: sessions || null,
    note,
    groups,
    indices: indices.map((item) => toSnapshot(item, { market, assetClass: 'index', group: '指数', fetchedAt, session, currency })),
    watchlist: watchlist.map((item) => toSnapshot(item, {
      market,
      assetClass: item.group === 'ETF' ? 'etf' : 'equity',
      group: item.group,
      summary: item.summary,
      fetchedAt,
      session,
      currency,
    })),
    gainers: byMove.filter((item) => (item.changePct ?? 0) > 0).slice(0, 5).map((item) => toSnapshot(item, {
      market, group: item.group, summary: item.summary, fetchedAt, session, currency,
    })),
    losers: [...byMove].reverse().filter((item) => (item.changePct ?? 0) < 0).slice(0, 5).map((item) => toSnapshot(item, {
      market, group: item.group, summary: item.summary, fetchedAt, session, currency,
    })),
    breadth: { advancers, decliners, unchanged },
  };
}

export function buildUsMarketBoard({ quotes, extraSymbols = [], session = 'closed', fetchedAt = Date.now(), errors = 0 }) {
  const catalog = new Map(usTrackedItems(extraSymbols).map((item) => [item.symbol, item]));
  const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const indices = US_INDICES.map((item) => {
    const quote = quoteMap.get(item.symbol);
    return quote ? { ...quote, name: item.name, group: item.group } : { ...emptyQuote(item.symbol, item.name, 'USD'), group: item.group };
  });
  const watchlist = [...US_WATCHLIST, ...extraSymbols.map((symbol) => catalog.get(symbol)).filter(Boolean)]
    .map((item) => {
      const quote = quoteMap.get(item.symbol);
      const base = quote || emptyQuote(item.symbol, item.name, 'USD');
      return {
        ...base,
        name: quote?.name && item.group === '自选' ? quote.name : item.name,
        group: item.group,
        summary: item.summary,
      };
    });
  return assembleBoard({
    board: 'us',
    market: 'us',
    session,
    note: errors
      ? `部分美股行情暂未获取成功（${errors} 项），页面保留已成功数据。延迟约 0–15 分钟，非投资建议。`
      : '数据来自 Yahoo Finance 公开接口。盘前、盘中、盘后都会刷新；报价通常延迟约 0–15 分钟，非投资建议。',
    groups: US_GROUPS,
    indices,
    watchlist,
    errors,
    fetchedAt,
    indexSymbols: US_INDEX_SYMBOLS,
    currency: 'USD',
  });
}

export function buildAsiaMarketBoard({ quotes, extraSymbols = [], fetchedAt = Date.now(), errors = 0 }) {
  const catalog = new Map(asiaTrackedItems(extraSymbols).map((item) => [item.symbol, item]));
  const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const indices = ASIA_INDICES.map((item) => {
    const quote = quoteMap.get(item.symbol);
    return quote ? { ...quote, name: item.name, group: item.group } : { ...emptyQuote(item.symbol, item.name), group: item.group };
  });
  const watchlist = [...ASIA_WATCHLIST, ...extraSymbols.map((symbol) => catalog.get(symbol)).filter(Boolean)]
    .map((item) => {
      const quote = quoteMap.get(item.symbol);
      const base = quote || emptyQuote(item.symbol, item.name);
      return {
        ...base,
        name: quote?.name && item.group === '自选' ? quote.name : item.name,
        group: item.group,
        summary: item.summary,
      };
    });
  const sessions = asiaSessionsAt(fetchedAt);
  const session = sessions.kr === 'regular' || sessions.tw === 'regular' || sessions.jp === 'regular' ? 'regular' : 'closed';
  return assembleBoard({
    board: 'asia',
    market: 'asia',
    session,
    sessions,
    note: errors
      ? `部分亚洲行情暂未获取成功（${errors} 项），页面保留已成功数据。延迟约 0–15 分钟，非投资建议。`
      : '数据来自 Yahoo Finance 公开接口。韩国 9:00–15:30、台湾 9:00–13:30、日本 9:00–15:00；报价通常延迟约 0–15 分钟，非投资建议。',
    groups: ASIA_GROUPS,
    indices,
    watchlist,
    errors,
    fetchedAt,
    indexSymbols: ASIA_INDEX_SYMBOLS,
  });
}

export function buildOverviewBoard(usBoard, asiaBoard) {
  return {
    board: 'overview',
    mode: usBoard.mode === 'live' && asiaBoard.mode === 'live' ? 'live' : 'partial',
    fetchedAt: Math.max(usBoard.fetchedAt, asiaBoard.fetchedAt),
    session: usBoard.session,
    sessions: asiaBoard.sessions,
    note: '总览放美股和亚洲的指数、宽度和涨跌。分组标的在美股 / 亚洲分览。',
    groups: [],
    indices: [],
    watchlist: [],
    gainers: [],
    losers: [],
    breadth: {
      us: usBoard.breadth,
      asia: asiaBoard.breadth,
    },
    sections: [
      {
        id: 'us',
        title: '美股观察',
        session: usBoard.session,
        mode: usBoard.mode,
        indices: usBoard.indices,
        breadth: usBoard.breadth,
        gainers: usBoard.gainers,
        losers: usBoard.losers,
      },
      {
        id: 'asia',
        title: '亚洲半导体',
        session: asiaBoard.session,
        sessions: asiaBoard.sessions,
        mode: asiaBoard.mode,
        indices: asiaBoard.indices,
        breadth: asiaBoard.breadth,
        gainers: asiaBoard.gainers,
        losers: asiaBoard.losers,
      },
    ],
  };
}
