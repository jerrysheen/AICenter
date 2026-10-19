import { createMemorySnapshotCache } from '../../../runtime/src/snapshot-cache.js';
import { marketStaleMs } from './service.js';
import {
  asiaSessionsAt,
  boardInRegularSession,
  cnSessionAt,
  hkSessionAt,
  parseAsiaExtraSymbols,
  parseCnExtraSymbols,
  parseUsExtraSymbols,
  preferredOverviewFocus,
  quoteInRegularSession,
  quoteVenue,
  usRegularOpenAt,
  usRegularSessionAt,
  usSessionAt,
} from './boards.js';
import { US_OPEN_GRACE_MS, usPreStartAt } from '../../../connectors/src/us-session.js';

export const EXTRA_QUOTE_TIMEOUT_MS = 10_000;

export const MARKET_BOARD_CACHE_TTL_MS = 45_000;
export const MARKET_BOARD_NAMES = Object.freeze(['overview', 'us', 'asia', 'cn', 'global']);

const EXTRA_QUOTE_CACHE_LIMIT = 32;

export function marketBoardSnapshotKey(board) {
  return `market-board-${board}`;
}

export function emptyMarketBoard(board = 'overview', now = Date.now()) {
  const name = MARKET_BOARD_NAMES.includes(board) ? board : 'overview';
  const flat = { advancers: 0, decliners: 0, unchanged: 0 };
  const fetchedAt = Math.trunc(Number(now));
  return {
    board: name,
    mode: 'partial',
    fetchedAt: Number.isInteger(fetchedAt) && fetchedAt >= 0 ? fetchedAt : Date.now(),
    session: 'closed',
    ...(name === 'overview' ? { focus: 'us' } : {}),
    note: '行情快照尚未就绪。',
    groups: [],
    indices: [],
    watchlist: [],
    gainers: [],
    losers: [],
    breadth: name === 'overview'
      ? { us: { ...flat }, asia: { ...flat }, cn: { ...flat } }
      : flat,
    ...(name === 'overview' ? { sections: [] } : {}),
  };
}

function extraSymbolsFor(board, query, marketCatalog) {
  if (board === 'us') return parseUsExtraSymbols(query?.extraUs || query?.extra || '', marketCatalog);
  if (board === 'asia') return parseAsiaExtraSymbols(query?.extraAsia || query?.extra || '', marketCatalog);
  if (board === 'cn') return parseCnExtraSymbols(query?.extraCn || query?.extra || '', marketCatalog);
  return [];
}

function extraRow(symbol, quote, board) {
  const item = quote && String(quote.symbol || '').toUpperCase() === symbol ? quote : null;
  return {
    symbol,
    name: item?.name || symbol,
    market: board.board,
    assetClass: 'equity',
    group: '自选',
    summary: '',
    lastPrice: item?.lastPrice ?? null,
    changePct: item?.changePct ?? null,
    change: item?.change ?? null,
    high: item?.high ?? null,
    low: item?.low ?? null,
    prevClose: item?.prevClose ?? null,
    volume: item?.volume ?? null,
    sparkline: Array.isArray(item?.sparkline) ? item.sparkline : [],
    currency: item?.currency || '',
    exchange: item?.exchange || '',
    session: item?.session || board.session || 'closed',
    asOf: item?.asOf ?? null,
    provider: item?.provider || 'yahoo',
    expiry: '',
  };
}

export function quoteAsOfMs(item) {
  const at = Number(item?.asOf ?? item?.marketTime);
  if (!Number.isFinite(at) || at <= 0) return 0;
  return at < 1e12 ? Math.trunc(at * 1000) : Math.trunc(at);
}

export function newestQuoteAsOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const rows = [
    ...(payload.indices || []),
    ...(payload.watchlist || []),
    ...((payload.sections || []).flatMap((section) => [
      ...(section?.indices || []),
      ...(section?.gainers || []),
      ...(section?.losers || []),
    ])),
  ];
  let newest = 0;
  for (const item of rows) {
    if (item?.lastPrice == null) continue;
    const at = quoteAsOfMs(item);
    if (at > newest) newest = at;
  }
  return newest || null;
}

function newestOpenQuoteAsOf(payload, nowMs) {
  if (!payload || typeof payload !== 'object') return null;
  const rows = [
    ...(payload.indices || []),
    ...(payload.watchlist || []),
    ...((payload.sections || []).flatMap((section) => [
      ...(section?.indices || []),
      ...(section?.gainers || []),
      ...(section?.losers || []),
    ])),
  ];
  let newest = 0;
  for (const item of rows) {
    if (item?.lastPrice == null || !quoteInRegularSession(item, nowMs, payload.board)) continue;
    const at = quoteAsOfMs(item);
    if (at > newest) newest = at;
  }
  return newest || null;
}

const QUOTE_LIST_KEYS = ['indices', 'watchlist', 'gainers', 'losers'];

function quoteLiveSession(item, nowMs, boardHint) {
  const venue = quoteVenue(item, boardHint);
  if (venue === 'cn') return cnSessionAt(nowMs);
  if (venue === 'hk') return hkSessionAt(nowMs);
  if (venue === 'us') {
    const clock = usSessionAt(nowMs);
    if (clock === 'pre' || clock === 'post') {
      const own = String(item?.session || '').trim();
      if (own === 'pre' || own === 'post') return own;
      return clock;
    }
    if (clock !== 'regular') return clock;
    const openAt = usRegularOpenAt(nowMs);
    const at = quoteAsOfMs(item);
    if (openAt != null && at >= openAt) return 'regular';
    if (openAt != null && nowMs - openAt < US_OPEN_GRACE_MS) {
      const preStart = usPreStartAt(nowMs);
      if (preStart != null && at >= preStart && at < openAt) return 'pre';
    }
    return 'regular';
  }
  if (venue === 'asia') {
    const open = hkSessionAt(nowMs) === 'regular' || Object.values(asiaSessionsAt(nowMs)).includes('regular');
    return open ? 'regular' : 'closed';
  }
  const session = String(item?.session || '').trim();
  return session || 'closed';
}

function stampQuoteClock(item, nowMs, boardHint) {
  if (!item || typeof item !== 'object') return item;
  const session = quoteLiveSession(item, nowMs, boardHint);
  const venue = quoteVenue(item, boardHint);
  const openAt = venue === 'us' ? usRegularOpenAt(nowMs) : null;
  const at = quoteAsOfMs(item);
  const inGrace = venue === 'us'
    && usSessionAt(nowMs) === 'regular'
    && openAt != null
    && nowMs - openAt < US_OPEN_GRACE_MS;
  const hasRegularPrint = openAt != null && at >= openAt;
  const awaitingQuote = inGrace && !hasRegularPrint && session !== 'pre' && session !== 'post';
  const next = {
    ...item,
    session,
    marketOpen: session === 'regular' && !awaitingQuote,
  };
  if (awaitingQuote) next.awaitingQuote = true;
  else delete next.awaitingQuote;
  return next;
}

function usRowsAwaitingOpen(rows, nowMs) {
  if (usSessionAt(nowMs) !== 'regular') return false;
  const openAt = usRegularOpenAt(nowMs);
  if (openAt == null || nowMs - openAt >= US_OPEN_GRACE_MS) return false;
  const usRows = (rows || []).filter((item) => item?.lastPrice != null && quoteVenue(item, 'us') === 'us');
  if (!usRows.length) return true;
  return !usRows.some((item) => quoteAsOfMs(item) >= openAt);
}

function pricedRows(payload) {
  return [
    ...(payload.indices || []),
    ...(payload.watchlist || []),
    ...((payload.sections || []).flatMap((section) => [
      ...(section?.indices || []),
      ...(section?.gainers || []),
      ...(section?.losers || []),
    ])),
  ].filter((item) => item && item.lastPrice != null);
}

function boardClockOpen(payload, nowMs) {
  const rows = pricedRows(payload);
  if (rows.length) return rows.some((item) => item.marketOpen === true);
  const board = String(payload.board || '').toLowerCase();
  const focus = String(payload.focus || '').toLowerCase();
  if (board === 'cn' || focus === 'cn') return cnSessionAt(nowMs) === 'regular';
  if (board === 'us' || focus === 'us') return usRegularSessionAt(nowMs) === 'regular';
  if (board === 'hk') return hkSessionAt(nowMs) === 'regular';
  if (board === 'asia') return hkSessionAt(nowMs) === 'regular' || Object.values(asiaSessionsAt(nowMs)).includes('regular');
  if (board === 'overview') {
    const which = focus || preferredOverviewFocus(nowMs);
    return which === 'cn' ? cnSessionAt(nowMs) === 'regular' : usRegularSessionAt(nowMs) === 'regular';
  }
  return false;
}

function listedExtendedSession(rows) {
  const sessions = rows.map((item) => String(item?.session || '').trim());
  if (sessions.includes('pre')) return 'pre';
  if (sessions.includes('post')) return 'post';
  return '';
}

function usExtendedSession(rows, nowMs) {
  const listed = listedExtendedSession(rows);
  if (listed) return listed;
  const clock = usSessionAt(nowMs);
  return clock === 'pre' || clock === 'post' ? clock : '';
}

function idleSession(rows) {
  if ((rows || []).some((item) => item?.session === 'break')) return 'break';
  return 'closed';
}

function sectionLiveSession(section, nowMs) {
  const rows = ['indices', 'gainers', 'losers']
    .flatMap((key) => section[key] || [])
    .filter((item) => item && item.lastPrice != null);
  const id = String(section.id || '').toLowerCase();
  if (id === 'us' && usRowsAwaitingOpen(rows, nowMs)) return 'regular';
  if (rows.length) {
    if (rows.some((item) => item.marketOpen === true)) return 'regular';
    if (id === 'us') {
      const extended = usExtendedSession(rows, nowMs);
      if (extended) return extended;
    }
    return idleSession(rows);
  }
  if (id === 'cn') return cnSessionAt(nowMs);
  if (id === 'us') return usSessionAt(nowMs);
  if (id === 'asia' || id === 'hk') {
    const asia = id === 'asia' && Object.values(asiaSessionsAt(nowMs)).includes('regular');
    return hkSessionAt(nowMs) === 'regular' || asia ? 'regular' : 'closed';
  }
  return String(section.session || '').trim() === 'regular' ? 'regular' : 'closed';
}

function focusesUs(payload, nowMs) {
  const board = String(payload.board || '').toLowerCase();
  const focus = String(payload.focus || '').toLowerCase();
  return board === 'us' || (board === 'overview' && (focus || preferredOverviewFocus(nowMs)) === 'us');
}

function boardLiveSession(payload, nowMs, open) {
  if (open) return 'regular';
  if (!focusesUs(payload, nowMs)) return '';
  if (usRowsAwaitingOpen(pricedRows(payload), nowMs)) return 'regular';
  return usExtendedSession(pricedRows(payload), nowMs) || '';
}

export function withMarketClock(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const board = payload.board;
  const next = { ...payload };
  for (const key of QUOTE_LIST_KEYS) {
    if (Array.isArray(payload[key])) next[key] = payload[key].map((item) => stampQuoteClock(item, nowMs, board));
  }
  if (Array.isArray(payload.sections)) {
    next.sections = payload.sections.map((section) => {
      if (!section || typeof section !== 'object') return section;
      const stamped = { ...section };
      for (const key of ['indices', 'gainers', 'losers']) {
        if (Array.isArray(section[key])) {
          stamped[key] = section[key].map((item) => stampQuoteClock(item, nowMs, section.id || board));
        }
      }
      return stamped;
    });
  }
  const open = boardClockOpen(next, nowMs);
  const awaitingQuote = !open && focusesUs(next, nowMs) && usRowsAwaitingOpen(pricedRows(next), nowMs);
  if (Array.isArray(next.sections)) {
    next.sections = next.sections.map((section) => {
      if (!section || typeof section !== 'object') return section;
      const session = sectionLiveSession(section, nowMs);
      const sectionAwaiting = awaitingQuote && String(section.id || '').toLowerCase() === 'us';
      const nextSection = { ...section, session, marketOpen: session === 'regular' && !sectionAwaiting };
      if (sectionAwaiting) nextSection.awaitingQuote = true;
      else delete nextSection.awaitingQuote;
      return nextSection;
    });
  }
  const idleRows = [
    ...(next.indices || []),
    ...(next.watchlist || []),
    ...(next.gainers || []),
    ...(next.losers || []),
    ...((next.sections || []).flatMap((section) => [
      ...(section?.indices || []),
      ...(section?.gainers || []),
      ...(section?.losers || []),
    ])),
  ];
  const live = open ? 'regular' : boardLiveSession(next, nowMs, open);
  const stamped = { ...next, marketOpen: open, session: live || idleSession(idleRows) };
  if (awaitingQuote) stamped.awaitingQuote = true;
  else delete stamped.awaitingQuote;
  return stamped;
}

export function stampBoardStale(payload, nowMs, staleMs) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const open = boardInRegularSession(payload, nowMs);
  if (open === false) {
    if (!payload.stale) return payload;
    return { ...payload, stale: false };
  }
  const quoteAt = open === true ? newestOpenQuoteAsOf(payload, nowMs) : newestQuoteAsOf(payload);
  const basis = quoteAt ?? Number(payload.fetchedAt);
  const stale = Number.isFinite(basis) && nowMs - basis >= staleMs;
  if (Boolean(payload.stale) === stale) return payload;
  return { ...payload, stale };
}

export function withExtraWatchlist(board, rows) {
  if (!rows?.length || !board || board.board === 'overview' || board.board === 'global') return board;
  const watchlist = [...(board.watchlist || [])];
  const seen = new Set(watchlist.map((item) => String(item.symbol || '').toUpperCase()));
  for (const row of rows) {
    const symbol = String(row?.symbol || '').toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    watchlist.push(row);
  }
  const indexSymbols = new Set((board.indices || []).map((item) => String(item.symbol || '').toUpperCase()));
  const ranked = watchlist.filter((item) => item.changePct != null && !indexSymbols.has(String(item.symbol || '').toUpperCase()));
  const advancers = ranked.filter((item) => (item.changePct ?? 0) > 0.005).length;
  const decliners = ranked.filter((item) => (item.changePct ?? 0) < -0.005).length;
  const unchanged = Math.max(ranked.length - advancers - decliners, 0);
  const byMove = [...ranked].sort((left, right) => (right.changePct ?? -Infinity) - (left.changePct ?? -Infinity));
  return {
    ...board,
    watchlist,
    mode: watchlist.some((item) => item.lastPrice == null) ? 'partial' : board.mode,
    gainers: byMove.filter((item) => (item.changePct ?? 0) > 0).slice(0, 5),
    losers: [...byMove].reverse().filter((item) => (item.changePct ?? 0) < 0).slice(0, 5),
    breadth: { advancers, decliners, unchanged },
  };
}

export function createMarketBoardReader({
  repository,
  workspaceId = 'local',
  ttlMs = MARKET_BOARD_CACHE_TTL_MS,
  now = () => Date.now(),
  marketCatalog = null,
  quotePort = null,
  env = process.env,
  staleMs = marketStaleMs(env),
  extraTimeoutMs = EXTRA_QUOTE_TIMEOUT_MS,
} = {}) {
  if (!repository?.readSnapshot) throw new TypeError('market board reader requires a snapshot repository');
  const caches = new Map();
  const extraQuotes = new Map();
  const extraInflight = new Set();

  function cacheFor(board) {
    let cache = caches.get(board);
    if (!cache) {
      cache = createMemorySnapshotCache({
        ttlMs,
        now,
        read: () => repository.readSnapshot(workspaceId, marketBoardSnapshotKey(board)),
      });
      caches.set(board, cache);
    }
    return cache;
  }

  function rememberQuotes(key, quotes) {
    extraQuotes.set(key, { at: now(), quotes });
    while (extraQuotes.size > EXTRA_QUOTE_CACHE_LIMIT) {
      const oldest = extraQuotes.keys().next().value;
      extraQuotes.delete(oldest);
    }
  }

  function refreshExtraQuotes(key, symbols) {
    if (!quotePort?.fetchQuotes || extraInflight.has(key)) return;
    extraInflight.add(key);
    const controller = new AbortController();
    const timeout = Math.max(1, Number(extraTimeoutMs) || EXTRA_QUOTE_TIMEOUT_MS);
    const timer = setTimeout(() => controller.abort(), timeout);
    Promise.resolve()
      .then(() => quotePort.fetchQuotes(symbols, { signal: controller.signal }))
      .then((quotes) => {
        if (Array.isArray(quotes)) rememberQuotes(key, quotes);
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        extraInflight.delete(key);
      });
  }

  function loadExtraQuotes(symbols) {
    const key = symbols.join(',');
    const hit = extraQuotes.get(key);
    const fresh = hit && now() - hit.at < ttlMs;
    if (fresh) return { quotes: hit.quotes, pending: false };
    refreshExtraQuotes(key, symbols);
    if (hit) return { quotes: hit.quotes, pending: false };
    return { quotes: [], pending: Boolean(quotePort?.fetchQuotes) };
  }

  return {
    async read(query = {}, { refresh = false } = {}) {
      const board = MARKET_BOARD_NAMES.includes(query.board) ? query.board : 'overview';
      const stored = await cacheFor(board).get({ refresh: Boolean(refresh) });
      const payload = stored?.payload;
      const present = (boardPayload) => stampBoardStale(withMarketClock(boardPayload, now()), now(), staleMs);
      if (!payload || payload.board !== board || payload.fetchedAt == null) {
        return { market: present(emptyMarketBoard(board, now())), pending: true };
      }
      const symbols = extraSymbolsFor(board, query, marketCatalog);
      if (!symbols.length) return { market: present(payload), pending: false };
      const loaded = loadExtraQuotes(symbols);
      const bySymbol = new Map((loaded.quotes || []).map((item) => [String(item?.symbol || '').toUpperCase(), item]));
      const rows = symbols.map((symbol) => extraRow(symbol, bySymbol.get(symbol), payload));
      return {
        market: present(withExtraWatchlist(payload, rows)),
        pending: loaded.pending,
      };
    },
  };
}
