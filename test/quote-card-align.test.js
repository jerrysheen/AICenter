import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseMarketQuoteQuery } from '../packages/contracts/src/index.js';
import { ValidationError } from '../packages/contracts/src/errors.js';
import { isApiTokenAllowlisted } from '../apps/web/src/http/api-token-access.js';
import { createTradingService } from '../packages/domain/src/trading-service.js';
import { createMarketService } from '../packages/source/src/market/service.js';
import { buildCnMarketBoard, quoteDisplayName } from '../packages/source/src/market/boards.js';
import { EXTRA_QUOTE_TIMEOUT_MS, withMarketClock } from '../packages/source/src/market/board-read.js';
import { createRouter } from '../apps/web/src/http/router.js';
import { createTradingRoutes } from '../apps/web/src/routes/trading-routes.js';
import { marketClosedLabel, quoteBasisParts, quoteClosedLabel } from '../apps/web/public/home-timeline.js';

const appSource = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../apps/web/public/styles.css', import.meta.url), 'utf8');
const lunch = Date.parse('2026-10-19T04:00:00Z');

function functionSource(name) {
  const match = appSource.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

function emptyCatalog() {
  return {
    version: 1,
    us: { groups: ['全部'], indices: [], watchlist: [] },
    asia: { groups: ['全部'], indices: [], watchlist: [] },
    cn: { groups: ['全部', '自选'], indices: [], watchlist: [] },
    global: { groups: ['指数'], watchlist: [] },
  };
}

test('quote display name prefers the catalog, then the live name, then the remembered name', () => {
  assert.equal(quoteDisplayName({
    symbol: '300750.SZ',
    quotedName: 'CATL',
    catalogName: '宁德时代',
    rememberedName: '旧名字',
  }), '宁德时代');
  assert.equal(quoteDisplayName({
    symbol: '300750.SZ',
    quotedName: '宁德时代',
    rememberedName: '旧名字',
  }), '宁德时代');
  assert.equal(quoteDisplayName({
    symbol: '300750.SZ',
    quotedName: '300750.SZ',
    rememberedName: '宁德时代',
  }), '宁德时代');
  assert.equal(quoteDisplayName({ symbol: '300750.SZ', quotedName: '300750.SZ' }), '300750.SZ');
});

test('cn board keeps the quote provider instead of labeling every row market', () => {
  const catalog = emptyCatalog();
  catalog.cn.watchlist = [{ symbol: '300316.SZ', name: '晶盛机电', group: '半导体', summary: '' }];
  const board = buildCnMarketBoard({
    quotes: [{
      symbol: '300316.SZ', name: '晶盛机电', lastPrice: 70, prevClose: 68, changePct: 2.94,
      currency: 'CNY', session: 'regular', provider: 'xueqiu',
    }],
    fetchedAt: lunch,
    marketCatalog: catalog,
  });
  assert.equal(board.watchlist[0].provider, 'xueqiu');
  assert.notEqual(board.provider, 'market');
});

test('lunch keeps the real break session on the board and the cards', () => {
  const stamped = withMarketClock({
    board: 'cn',
    session: 'regular',
    indices: [{ symbol: '000001.SS', name: '上证指数', lastPrice: 3000, asOf: lunch - 60_000 }],
    watchlist: [],
    gainers: [],
    losers: [],
    sections: [{
      id: 'cn',
      title: 'A股 / 港股观察',
      session: 'regular',
      indices: [{ symbol: '000001.SS', name: '上证指数', lastPrice: 3000, asOf: lunch - 60_000 }],
      gainers: [{ symbol: '688110.SS', name: '东芯股份', lastPrice: 80, prevClose: 77, changePct: 3.2, asOf: lunch - 60_000 }],
      losers: [],
    }],
  }, lunch);
  assert.equal(stamped.marketOpen, false);
  assert.equal(stamped.session, 'break');
  assert.equal(stamped.indices[0].session, 'break');
  assert.equal(stamped.sections[0].session, 'break');
  assert.equal(stamped.sections[0].indices[0].session, 'break');
  assert.match(marketClosedLabel(stamped, lunch), /^午间休市 · /);
  assert.match(quoteClosedLabel(stamped.indices[0], lunch), /^午间休市 · /);
});

test('single quote reuses fetchQuotes and resolves catalog before memory', async () => {
  const seen = [];
  const service = createMarketService({
    marketCatalog: {
      ...emptyCatalog(),
      cn: {
        groups: ['全部'],
        indices: [],
        watchlist: [{ symbol: '600519.SS', name: '贵州茅台', group: '白酒', summary: '' }],
      },
    },
    ttlMs: 0,
    xueqiuTtlMs: 0,
    now: () => lunch,
    log() {},
    tushare: null,
    sinaFutures: null,
    yahoo: { async fetchQuotes() { return { quotes: [], session: 'closed' }; } },
    cnQuotes: { async fetchQuotes() { return []; } },
    xueqiuQuotes: {
      async fetchQuotes(symbols) {
        seen.push([...symbols]);
        return symbols.map((symbol) => ({
          symbol,
          name: 'MOUTAI',
          lastPrice: 1400,
          prevClose: 1380,
          session: 'regular',
          currency: 'CNY',
        }));
      },
    },
  });
  const [quote] = await service.fetchQuotes(['600519.SS']);
  assert.deepEqual(seen, [['600519.SS']]);
  assert.equal(quote.name, '贵州茅台');
  assert.equal(quote.lastPrice, 1400);
  assert.equal(quote.prevClose, 1380);
  assert.equal(quote.session, 'break');
});

test('remembered A-share names stop at 2000 and ignore Hong Kong symbols', async () => {
  const names = new Map();
  const service = createMarketService({
    marketCatalog: emptyCatalog(),
    ttlMs: 0,
    xueqiuTtlMs: 0,
    now: () => lunch,
    log() {},
    tushare: null,
    sinaFutures: null,
    yahoo: {
      async fetchQuotes(symbols) {
        return {
          quotes: symbols.map((symbol) => ({
            symbol,
            name: names.get(symbol) || symbol,
            lastPrice: 1,
            prevClose: 1,
            session: 'regular',
            currency: symbol.endsWith('.HK') ? 'HKD' : 'CNY',
          })),
          session: 'closed',
        };
      },
    },
    cnQuotes: { async fetchQuotes() { return []; } },
    xueqiuQuotes: {
      async fetchQuotes(symbols) {
        return symbols.map((symbol) => ({
          symbol,
          name: names.get(symbol) || symbol,
          lastPrice: 2,
          prevClose: 1,
          session: 'regular',
          currency: 'CNY',
        }));
      },
    },
  });
  const symbols = Array.from({ length: 2001 }, (_, index) => `${String(index + 1).padStart(6, '0')}.SZ`);
  for (const symbol of symbols) names.set(symbol, `名${symbol.slice(0, 6)}`);
  names.set('00700.HK', '腾讯控股');
  names.set('830001.BJ', '北交示例');
  await service.fetchQuotes(symbols);
  names.set(symbols[0], symbols[0]);
  const [evicted] = await service.fetchQuotes([symbols[0]]);
  assert.equal(evicted.name, symbols[0]);
  names.set(symbols[1], symbols[1]);
  const [kept] = await service.fetchQuotes([symbols[1]]);
  assert.equal(kept.name, `名${symbols[1].slice(0, 6)}`);
  await service.fetchQuotes(['00700.HK']);
  names.set('00700.HK', '00700.HK');
  const [hongKong] = await service.fetchQuotes(['00700.HK']);
  assert.equal(hongKong.name, '00700.HK');
  await service.fetchQuotes(['830001.BJ']);
  names.set('830001.BJ', '830001.BJ');
  const [beijing] = await service.fetchQuotes(['830001.BJ']);
  assert.equal(beijing.name, '北交示例');
});

test('quote route symbol is validated and the read token can call it', async () => {
  assert.equal(parseMarketQuoteQuery('600519.ss'), '600519.SS');
  assert.throws(() => parseMarketQuoteQuery(''), ValidationError);
  assert.throws(() => parseMarketQuoteQuery('带空格 X'), ValidationError);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/markets/quote'), true);
  assert.equal(isApiTokenAllowlisted('POST', '/api/v1/markets/quote'), false);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/holdings'), false);
  const calls = [];
  const signal = AbortSignal.timeout(1_000);
  const trading = createTradingService({
    tradingRepository: {},
    sourcePort: {
      async read(sourceId, input, context) {
        calls.push([sourceId, input.symbols, context.signal]);
        return { data: [{ symbol: '600519.SS', name: '贵州茅台', lastPrice: 1400, prevClose: 1380, changePct: 1.2, session: 'break', asOf: lunch }] };
      },
    },
  });
  const quote = await trading.getQuote('600519.SS', { signal });
  assert.deepEqual(calls, [['market.quotes', ['600519.SS'], signal]]);
  assert.equal(quote.name, '贵州茅台');
  assert.equal(quote.prevClose, 1380);
  const missing = await trading.getQuote('000001.SS');
  assert.equal(missing.lastPrice, null);
  assert.equal(missing.symbol, '000001.SS');
});

test('quote route returns 504 when the quote read exceeds 10 seconds', async () => {
  assert.equal(EXTRA_QUOTE_TIMEOUT_MS, 10_000);
  const routeSource = readFileSync(new URL('../apps/web/src/routes/trading-routes.js', import.meta.url), 'utf8');
  assert.match(routeSource, /AbortSignal\.timeout\(10_000\)/);
  const router = createRouter(createTradingRoutes());
  const response = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = body; },
  };
  const started = Date.now();
  const keepAlive = setTimeout(() => {}, 20_000);
  try {
    await router.dispatch({
      request: { method: 'GET' },
      response,
      url: new URL('http://127.0.0.1/api/v1/markets/quote?symbol=600519.SS'),
      identity: { kind: 'desktop' },
      services: {
        trading: {
          getQuote() { return new Promise(() => {}); },
        },
      },
    });
  } finally {
    clearTimeout(keepAlive);
  }
  const elapsed = Date.now() - started;
  assert.equal(response.status, 504);
  assert.match(response.body, /报价超时/);
  assert.ok(elapsed >= 9_000 && elapsed < 15_000, `elapsed ${elapsed}`);
});

test('the quote page reads overview cards and labels a daily-bar fallback', () => {
  assert.match(functionSource('findQuote'), /quoteCandidates/);
  assert.match(functionSource('quoteCandidates'), /overview\?\.sections/);
  assert.match(functionSource('renderOverview'), /data-overview-key/);
  assert.match(functionSource('renderOverview'), /dataset\?\.symbol/);
  assert.match(functionSource('renderMovers'), /dataset\.symbol/);
  assert.match(functionSource('quoteBasisLines'), /日K/);
  assert.match(functionSource('quoteBasisLines'), /昨收/);
  const marketStatus = appSource.slice(appSource.indexOf('function renderMarketStatus'), appSource.indexOf('function renderIndexScroller'));
  assert.match(marketStatus, /stockBoard === 'us'/);
  assert.match(marketStatus, /marketQuoteTimeLabel\(market\)/);
  const watchRows = appSource.slice(appSource.indexOf('function renderWatchRows'), appSource.indexOf('function marketRetryBlock'));
  assert.equal(watchRows.includes('appendQuoteBasis'), false);
  assert.match(functionSource('paintQuotePrintFromBars'), /dailyAt: bar\?\.at/);
  assert.match(functionSource('loadLiveQuote'), /\/api\/v1\/markets\/quote\?symbol=/);
  assert.match(cssSource, /\.mover-row:focus-visible \{[^}]*outline: 2px solid var\(--brand\)/);
  assert.doesNotMatch(cssSource, /\.hub-excerpt/);
  const opened = [];
  const context = vm.createContext({
    state: {
      pageId: '688110.SS',
      markets: {
        overview: {
          sections: [{
            id: 'cn',
            indices: [],
            gainers: [{
              symbol: '688110.SS',
              name: '东芯股份',
              lastPrice: 80,
              prevClose: 77.5,
              changePct: 3.2,
              asOf: lunch,
              session: 'break',
              group: '存储芯片',
            }],
            losers: [],
          }],
        },
        us: null,
        asia: null,
        cn: null,
      },
      assetBoard: null,
      liveQuotes: {},
    },
    hubQuotes() { return []; },
    document: { createElement: (tag) => ({ tag, className: '', textContent: '', children: [], append(...nodes) { this.children.push(...nodes); } }) },
  });
  vm.runInContext([
    functionSource('quoteCandidates'),
    functionSource('findQuote'),
    functionSource('quoteInstant'),
    functionSource('shanghaiQuoteParts'),
    functionSource('formatQuoteStamp'),
    functionSource('formatQuoteDay'),
    functionSource('formatPrice'),
    functionSource('quoteBasisLines'),
    functionSource('quoteBasisText'),
  ].join('\n'), context);
  context.quoteBasisParts = quoteBasisParts;
  const quote = context.findQuote('688110.ss');
  assert.equal(quote.name, '东芯股份');
  assert.equal(quote.lastPrice, 80);
  assert.equal(quote.changePct, 3.2);
  assert.equal(quote.session, 'break');
  const basisText = context.quoteBasisText(quote, { nowMs: Date.parse('2026-10-20T13:50:00Z') });
  assert.match(basisText, /昨收 77\.5/);
  assert.match(basisText, /更新 10月19日 12:00/);
  assert.equal(basisText.includes('基准'), false);
  const host = {
    closest() { return detail; },
  };
  const basis = { textContent: '' };
  const last = { textContent: '—', classList: { toggle() {} } };
  const change = { textContent: '—', classList: { toggle() {} } };
  const detail = {
    querySelector(selector) {
      if (selector === '.last') return last;
      if (selector === '.change') return change;
      if (selector === '.quote-basis') return basis;
      return null;
    },
  };
  context.paintQuotePrintFromBars = null;
  vm.runInContext([
    functionSource('formatPct'),
    functionSource('paintQuotePrintFromBars'),
    'globalThis.__paint = paintQuotePrintFromBars;',
  ].join('\n'), context);
  const barAt = Date.parse('2026-10-16T07:00:00Z');
  context.__paint(host, [
    { at: barAt - 86_400_000, close: 70 },
    { at: barAt, close: 77 },
  ]);
  assert.equal(last.textContent.includes('77'), true);
  assert.match(basis.textContent, /^日K 10月16日 · 昨收 /);
  assert.equal(opened.length, 0);
});
