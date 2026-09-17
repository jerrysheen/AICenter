export function toDecimalNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toDecimalString(value, digits = 8) {
  const number = toDecimalNumber(value);
  if (Object.is(number, -0) || number === 0) return '0';
  const text = number.toFixed(digits).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
}

export function fxRateForBoard(board, fx) {
  if (board === 'b_sh') return fx.usdCny;
  if (board === 'b_sz' || board === 'hk_connect') return fx.hkdCny;
  return 1;
}

export function costFxForBoard(board, fx) {
  if (board === 'hk_connect') return 1;
  return fxRateForBoard(board, fx);
}

export function buildHoldingsBoard({
  accounts = [],
  lots = [],
  instruments = [],
  aliases = [],
  cash = [],
  quotes = [],
  now = Date.now(),
  note = '',
} = {}) {
  const instrumentById = new Map(instruments.map((item) => [item.id, item]));
  const yahooByInstrument = new Map(aliases.filter((item) => item.providerId === 'yahoo').map((item) => [item.instrumentId, item.providerSymbol]));
  const quoteByYahoo = new Map(quotes.map((item) => [String(item.symbol || '').toUpperCase(), item]));
  const usd = quoteByYahoo.get('USDCNY=X');
  const hkd = quoteByYahoo.get('HKDCNY=X');
  const fx = {
    usdCny: usd?.lastPrice != null ? toDecimalString(usd.lastPrice) : null,
    hkdCny: hkd?.lastPrice != null ? toDecimalString(hkd.lastPrice) : null,
  };

  const missingQuotes = [];
  const positions = lots.map((lot) => {
    const instrument = instrumentById.get(lot.instrumentId);
    const yahoo = yahooByInstrument.get(lot.instrumentId);
    const quote = yahoo ? quoteByYahoo.get(String(yahoo).toUpperCase()) : null;
    const live = quote?.lastPrice != null;
    if (!live && yahoo) missingQuotes.push(yahoo);
    const quantity = toDecimalNumber(lot.quantity);
    const costPrice = toDecimalNumber(lot.costPrice);
    const lastPrice = live ? toDecimalNumber(quote.lastPrice) : null;
    const previousClose = quote?.prevClose != null ? toDecimalNumber(quote.prevClose) : null;
    const fxNumbers = {
      usdCny: fx.usdCny == null ? null : toDecimalNumber(fx.usdCny),
      hkdCny: fx.hkdCny == null ? null : toDecimalNumber(fx.hkdCny),
    };
    const fxValue = fxRateForBoard(lot.board, fxNumbers);
    const costFx = costFxForBoard(lot.board, fxNumbers);
    const fxReady = fxValue != null;
    const marketValueListing = live ? quantity * lastPrice : null;
    const marketValueCny = live && fxReady ? marketValueListing * fxValue : null;
    const costCny = costFx != null ? quantity * costPrice * costFx : quantity * costPrice;
    const positionPnlCny = marketValueCny == null ? null : marketValueCny - costCny;
    const positionPnlPct = costCny ? (positionPnlCny / costCny) : null;
    const dayPnlListing = live && previousClose != null ? (lastPrice - previousClose) * quantity : null;
    const dayPnlCny = dayPnlListing == null || !fxReady ? null : dayPnlListing * fxValue;
    const dayPnlPct = previousClose ? ((lastPrice - previousClose) / previousClose) : null;
    return {
      lotId: lot.id,
      portfolioId: lot.portfolioId,
      board: lot.board,
      instrumentId: lot.instrumentId,
      symbol: instrument?.symbol || lot.symbol || '',
      name: instrument?.name || lot.name || '',
      quantity: toDecimalString(quantity, 4),
      costPrice: toDecimalString(costPrice, 6),
      lastPrice: live ? toDecimalString(lastPrice, 6) : null,
      previousClose: previousClose == null ? null : toDecimalString(previousClose, 6),
      listingCurrency: lot.listingCurrency,
      fxToCny: fxReady ? toDecimalString(fxValue, 6) : '1',
      marketValueListing: marketValueListing == null ? null : toDecimalString(marketValueListing, 4),
      marketValueCny: marketValueCny == null ? null : toDecimalString(marketValueCny, 4),
      costCny: toDecimalString(costCny, 4),
      positionPnlCny: positionPnlCny == null ? null : toDecimalString(positionPnlCny, 4),
      positionPnlPct: positionPnlPct == null ? null : toDecimalString(positionPnlPct, 6),
      dayPnlCny: dayPnlCny == null ? null : toDecimalString(dayPnlCny, 4),
      dayPnlPct: dayPnlPct == null ? null : toDecimalString(dayPnlPct, 6),
      quoteStatus: live ? 'live' : 'missing',
    };
  }).filter((item) => item.symbol && item.name)
    .sort((left, right) => toDecimalNumber(right.marketValueCny) - toDecimalNumber(left.marketValueCny));

  const cashByPortfolio = new Map();
  for (const row of cash) {
    const list = cashByPortfolio.get(row.portfolioId) || [];
    list.push(row);
    cashByPortfolio.set(row.portfolioId, list);
  }

  function cashToCny(currency, amount) {
    const value = toDecimalNumber(amount);
    if (currency === 'CNY') return value;
    if (currency === 'USD') return fx.usdCny == null ? null : value * toDecimalNumber(fx.usdCny);
    if (currency === 'HKD') return fx.hkdCny == null ? null : value * toDecimalNumber(fx.hkdCny);
    return null;
  }

  const accountViews = accounts.map((account) => {
    const holdings = positions.filter((item) => item.portfolioId === account.id);
    const marketValueCny = holdings.reduce((sum, item) => sum + toDecimalNumber(item.marketValueCny), 0);
    const cashRows = (cashByPortfolio.get(account.id) || account.cash || []).map((item) => {
      const amountCny = cashToCny(item.currency, item.amount);
      return {
        currency: item.currency,
        amount: toDecimalString(item.amount, 4),
        amountCny: amountCny == null ? null : toDecimalString(amountCny, 4),
      };
    });
    const cashCny = cashRows.reduce((sum, item) => sum + toDecimalNumber(item.amountCny), 0);
    return {
      id: account.id,
      name: account.name,
      group: account.group,
      cash: cashRows,
      marketValueCny: toDecimalString(marketValueCny, 4),
      totalCny: toDecimalString(marketValueCny + cashCny, 4),
    };
  });

  const aShareCny = positions
    .filter((item) => item.board === 'a_share' || item.board === 'hk_connect')
    .reduce((sum, item) => sum + toDecimalNumber(item.marketValueCny), 0);
  const bShareCny = positions
    .filter((item) => item.board === 'b_sh' || item.board === 'b_sz')
    .reduce((sum, item) => sum + toDecimalNumber(item.marketValueCny), 0);
  const cashCny = accountViews.reduce((sum, item) => (
    sum + item.cash.reduce((inner, row) => inner + toDecimalNumber(row.amountCny), 0)
  ), 0);

  const cashByCurrency = new Map();
  for (const account of accountViews) {
    for (const row of account.cash) {
      const current = cashByCurrency.get(row.currency) || { amount: 0, amountCny: 0, missingCny: false };
      current.amount += toDecimalNumber(row.amount);
      if (row.amountCny == null) current.missingCny = true;
      else current.amountCny += toDecimalNumber(row.amountCny);
      cashByCurrency.set(row.currency, current);
    }
  }

  function sumBoards(boards, listingCurrency) {
    const rows = positions.filter((item) => boards.includes(item.board));
    const listingRows = rows.filter((item) => item.listingCurrency === listingCurrency);
    return {
      stockCny: rows.reduce((sum, item) => sum + toDecimalNumber(item.marketValueCny), 0),
      stockListing: listingRows.reduce((sum, item) => sum + toDecimalNumber(item.marketValueListing), 0),
    };
  }

  function makeLine({ id, label, boards, listingCurrency }) {
    const { stockCny, stockListing } = sumBoards(boards, listingCurrency);
    const cash = cashByCurrency.get(listingCurrency) || { amount: 0, amountCny: 0, missingCny: listingCurrency !== 'CNY' };
    const cashListing = toDecimalNumber(cash.amount);
    const cashCnyValue = cash.missingCny ? null : toDecimalNumber(cash.amountCny);
    const totalCny = stockCny + toDecimalNumber(cashCnyValue);
    return {
      id,
      label,
      listingCurrency,
      stockListing: toDecimalString(stockListing, 4),
      stockCny: toDecimalString(stockCny, 4),
      cashListing: toDecimalString(cashListing, 4),
      cashCny: cashCnyValue == null ? null : toDecimalString(cashCnyValue, 4),
      totalListing: toDecimalString(stockListing + cashListing, 4),
      totalCny: toDecimalString(totalCny, 4),
    };
  }

  return {
    baseCurrency: 'CNY',
    fx,
    summary: {
      aShareCny: toDecimalString(aShareCny, 4),
      bShareCny: toDecimalString(bShareCny, 4),
      cashCny: toDecimalString(cashCny, 4),
      totalCny: toDecimalString(aShareCny + bShareCny + cashCny, 4),
      lines: [
        makeLine({ id: 'a_share', label: 'A股', boards: ['a_share', 'hk_connect'], listingCurrency: 'CNY' }),
        makeLine({ id: 'b_sh', label: 'B股沪市', boards: ['b_sh'], listingCurrency: 'USD' }),
        makeLine({ id: 'b_sz', label: 'B股深市', boards: ['b_sz'], listingCurrency: 'HKD' }),
      ],
    },
    accounts: accountViews,
    positions,
    moves: [],
    missingQuotes: [...new Set(missingQuotes)],
    updatedAt: now,
    note,
  };
}

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfChinaDay(ms) {
  const shifted = ms + CHINA_OFFSET_MS;
  return Math.floor(shifted / DAY_MS) * DAY_MS - CHINA_OFFSET_MS;
}

export function startOfChinaWeek(ms) {
  const start = startOfChinaDay(ms);
  const weekday = new Date(start + CHINA_OFFSET_MS).getUTCDay();
  return start - ((weekday + 6) % 7) * DAY_MS;
}

export function startOfChinaMonth(ms) {
  const shifted = new Date(ms + CHINA_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - CHINA_OFFSET_MS;
}

function closeAt(points, at) {
  if (!Array.isArray(points) || !points.length || at == null) return null;
  let found = null;
  for (const point of points) {
    if (point.at <= at) found = point.close;
    else break;
  }
  return found;
}

function fxAt(seriesBySymbol, currency, at, fallback) {
  if (currency === 'CNY') return 1;
  const symbol = currency === 'USD' ? 'USDCNY=X' : currency === 'HKD' ? 'HKDCNY=X' : null;
  if (!symbol) return null;
  const rate = closeAt(seriesBySymbol.get(symbol), at);
  return rate == null ? fallback : rate;
}

export function buildHoldingsMoves({
  lots = [],
  aliases = [],
  cash = [],
  series = [],
  positions = [],
  now = Date.now(),
  nowCny = '0',
  fx = {},
} = {}) {
  const yahooByInstrument = new Map(aliases.filter((item) => item.providerId === 'yahoo').map((item) => [item.instrumentId, String(item.providerSymbol).toUpperCase()]));
  const seriesBySymbol = new Map(series.map((item) => [String(item.symbol || '').toUpperCase(), item.points || []]));
  const liveByLot = new Map(positions
    .filter((item) => item.lotId && item.marketValueCny != null)
    .map((item) => [item.lotId, toDecimalNumber(item.marketValueCny)]));
  const usdNow = fx.usdCny == null ? null : toDecimalNumber(fx.usdCny);
  const hkdNow = fx.hkdCny == null ? null : toDecimalNumber(fx.hkdCny);

  function openedAtOf(lot) {
    return lot.openedAt == null ? null : Number(lot.openedAt);
  }

  function heldLots(at) {
    return lots.filter((lot) => {
      const opened = openedAtOf(lot);
      return opened == null || opened <= at;
    });
  }

  function addedLots(from, to) {
    return lots.filter((lot) => {
      const opened = openedAtOf(lot);
      return opened != null && opened > from && opened <= to;
    });
  }

  function cashAt(at) {
    let cashCny = 0;
    for (const row of cash) {
      const rate = fxAt(seriesBySymbol, row.currency, at, row.currency === 'USD' ? usdNow : row.currency === 'HKD' ? hkdNow : 1);
      if (rate == null) return null;
      cashCny += toDecimalNumber(row.amount) * rate;
    }
    return cashCny;
  }

  function stocksAt(at, lotList, live) {
    let stocks = 0;
    let counted = 0;
    for (const lot of lotList) {
      if (live && liveByLot.has(lot.id)) {
        stocks += liveByLot.get(lot.id);
        counted += 1;
        continue;
      }
      const yahoo = yahooByInstrument.get(lot.instrumentId);
      const price = closeAt(seriesBySymbol.get(yahoo), at);
      const rate = fxAt(seriesBySymbol, lot.listingCurrency, at, lot.listingCurrency === 'USD' ? usdNow : lot.listingCurrency === 'HKD' ? hkdNow : 1);
      if (price == null || rate == null) continue;
      stocks += toDecimalNumber(lot.quantity) * price * rate;
      counted += 1;
    }
    if (!lotList.length) return 0;
    if (counted === 0) return null;
    return stocks;
  }

  function addedEntry(lotList) {
    let entry = 0;
    let counted = 0;
    for (const lot of lotList) {
      const opened = openedAtOf(lot);
      const yahoo = yahooByInstrument.get(lot.instrumentId);
      const close = closeAt(seriesBySymbol.get(yahoo), opened);
      if (close != null) {
        const rate = fxAt(seriesBySymbol, lot.listingCurrency, opened, lot.listingCurrency === 'USD' ? usdNow : lot.listingCurrency === 'HKD' ? hkdNow : 1);
        if (rate == null) continue;
        entry += toDecimalNumber(lot.quantity) * close * rate;
        counted += 1;
        continue;
      }
      const costFx = costFxForBoard(lot.board, { usdCny: usdNow, hkdCny: hkdNow });
      if (costFx == null) continue;
      entry += toDecimalNumber(lot.quantity) * toDecimalNumber(lot.costPrice) * costFx;
      counted += 1;
    }
    if (!lotList.length) return 0;
    if (counted === 0) return null;
    return entry;
  }

  function signedMove(start, end) {
    if (start == null || end == null || start === 0) return { pnlCny: null, pnlPct: null };
    const pnl = end - start;
    return {
      pnlCny: toDecimalString(pnl, 4),
      pnlPct: toDecimalString(pnl / start, 6),
    };
  }

  function move(from, to) {
    const held = heldLots(from);
    const added = addedLots(from, to);
    const live = to === now;
    const cashStart = cashAt(from);
    const cashEnd = cashAt(to);
    const heldStartStocks = stocksAt(from, held, false);
    let heldEndStocks = stocksAt(to, held, live);
    if (live && heldEndStocks == null && !added.length && !liveByLot.size) {
      const totalNow = toDecimalNumber(nowCny);
      const cashNow = cashEnd == null ? 0 : cashEnd;
      heldEndStocks = totalNow - cashNow;
    }
    const heldStart = heldStartStocks == null || cashStart == null ? null : heldStartStocks + cashStart;
    const heldEnd = heldEndStocks == null || cashEnd == null ? null : heldEndStocks + cashEnd;
    const heldMove = live && !added.length && !liveByLot.size && cash.length === 0
      ? signedMove(heldStartStocks == null || cashStart == null ? null : heldStartStocks + (cashStart || 0), toDecimalNumber(nowCny))
      : signedMove(heldStart, heldEnd);
    const addedStart = addedEntry(added);
    const addedEnd = stocksAt(to, added, live);
    const addedMove = added.length ? signedMove(addedStart, addedEnd) : { pnlCny: null, pnlPct: null };
    return {
      ...heldMove,
      addedPnlCny: addedMove.pnlCny,
      addedPnlPct: addedMove.pnlPct,
      backcast: held.some((lot) => openedAtOf(lot) == null),
    };
  }

  function quoteDayPnl(lotList) {
    if (!lotList.length) return 0;
    let sum = 0;
    for (const lot of lotList) {
      const row = positions.find((item) => item.lotId === lot.id);
      if (!row || row.dayPnlCny == null) return null;
      sum += toDecimalNumber(row.dayPnlCny);
    }
    return sum;
  }

  const dayStart = startOfChinaDay(now);
  const weekStart = startOfChinaWeek(now);
  const monthStart = startOfChinaMonth(now);
  const yesterdayStart = dayStart - DAY_MS;
  const lastWeekStart = weekStart - 7 * DAY_MS;
  const lastMonthStart = startOfChinaMonth(monthStart - DAY_MS);

  const day = move(dayStart, now);
  const heldToday = heldLots(dayStart);
  const addedToday = addedLots(dayStart, now);
  const quoteDay = addedToday.length ? null : quoteDayPnl(heldToday);
  const dayFromQuotes = (() => {
    if (quoteDay == null) return day;
    const cashStart = cashAt(dayStart);
    const cashEnd = cashAt(now);
    const cashDelta = cashStart != null && cashEnd != null ? cashEnd - cashStart : 0;
    const end = toDecimalNumber(nowCny);
    return {
      ...signedMove(end - quoteDay - cashDelta, end),
      addedPnlCny: null,
      addedPnlPct: null,
      backcast: day.backcast,
    };
  })();
  const yesterday = move(yesterdayStart, dayStart);
  const week = move(weekStart, now);
  const lastWeek = move(lastWeekStart, weekStart);
  const month = move(monthStart, now);
  const lastMonth = move(lastMonthStart, monthStart);

  function withSample(id, label, current, sampleLabel, sample) {
    return {
      id,
      label,
      pnlCny: current.pnlCny,
      pnlPct: current.pnlPct,
      addedPnlCny: current.addedPnlCny,
      addedPnlPct: current.addedPnlPct,
      sampleLabel,
      samplePnlCny: sample.pnlCny,
      samplePnlPct: sample.pnlPct,
      sampleAddedPnlCny: sample.addedPnlCny,
      sampleAddedPnlPct: sample.addedPnlPct,
      backcast: current.backcast || sample.backcast,
    };
  }

  return [
    withSample('day', '今日', dayFromQuotes, '昨日', yesterday),
    withSample('week', '本周', week, '上周', lastWeek),
    withSample('month', '本月', month, '上月', lastMonth),
  ];
}

export const HOLDING_MOVE_GROUPS = [
  { id: 'a_share', label: 'A股', boards: ['a_share', 'hk_connect'], currencies: ['CNY'] },
  { id: 'b_share', label: 'B股', boards: ['b_sh', 'b_sz'], currencies: ['USD', 'HKD'] },
];

export function buildHoldingsMoveGroups({
  lots = [],
  aliases = [],
  cash = [],
  series = [],
  positions = [],
  summary = {},
  now = Date.now(),
  fx = {},
} = {}) {
  const lines = summary.lines || [];
  return HOLDING_MOVE_GROUPS.map((group) => {
    const groupLots = lots.filter((lot) => group.boards.includes(lot.board));
    const groupCash = cash.filter((row) => group.currencies.includes(row.currency));
    const groupPositions = positions.filter((item) => group.boards.includes(item.board));
    const nowCny = group.id === 'a_share'
      ? (lines.find((item) => item.id === 'a_share')?.totalCny || '0')
      : toDecimalString(
        toDecimalNumber(lines.find((item) => item.id === 'b_sh')?.totalCny)
        + toDecimalNumber(lines.find((item) => item.id === 'b_sz')?.totalCny),
        4,
      );
    return {
      id: group.id,
      label: group.label,
      moves: buildHoldingsMoves({
        lots: groupLots,
        aliases,
        cash: groupCash,
        series,
        positions: groupPositions,
        now,
        nowCny,
        fx,
      }),
    };
  });
}
