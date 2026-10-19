import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { buildCnMarketBoard } from '../packages/connectors/src/market-boards.js';
import { createMarketService } from '../packages/connectors/src/market-service.js';
import { composeHomeBootstrap } from '../apps/web/src/http/home-bootstrap.js';

const appSource = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../apps/web/public/styles.css', import.meta.url), 'utf8');

function functionSource(name) {
  const match = appSource.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.type = '';
    this.listeners = {};
  }

  set innerHTML(value) {
    throw new Error(`innerHTML ${value}`);
  }

  append(...nodes) {
    this.children.push(...nodes.flat());
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
}

function byClass(root, className) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (String(node.className || '').split(/\s+/).includes(className)) found.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return found;
}

function catalog() {
  return {
    version: 1,
    us: { groups: ['全部'], indices: [], watchlist: [] },
    asia: { groups: ['全部'], indices: [], watchlist: [] },
    cn: {
      groups: ['全部', '电池', '自选'],
      indices: [],
      watchlist: [{ symbol: '300750.SZ', name: '宁德时代', group: '电池', summary: '动力电池' }],
    },
    global: { groups: ['指数'], watchlist: [] },
  };
}

test('mover rows show the name, a deduped subtitle, and literal text', () => {
  assert.doesNotMatch(functionSource('renderMovers'), /innerHTML/);
  const opened = [];
  const context = vm.createContext({
    document: { createElement: (tag) => new El(tag) },
    openPage(kind, id) { opened.push([kind, id]); },
  });
  vm.runInContext([
    functionSource('formatPct'),
    functionSource('moverText'),
    functionSource('moverPrimary'),
    functionSource('moverSecondary'),
    functionSource('renderMovers'),
  ].join('\n'), context);
  const card = context.renderMovers([
    { symbol: '688110.SS', name: '东芯股份', summary: '存储芯片', changePct: 3.2 },
    { symbol: '688110.SS', name: '688110.SS', summary: '存储芯片', changePct: -1.5 },
    { symbol: 'AAPL', changePct: null },
    { symbol: '688111.SS', name: '<b>东芯</b>', summary: '板块<img>', changePct: 1 },
  ], '领涨');
  const rows = byClass(card, 'mover-row');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].tagName, 'BUTTON');
  assert.equal(byClass(rows[0], 'quote-name')[0].textContent, '东芯股份');
  assert.equal(byClass(rows[0], 'quote-code')[0].textContent, '存储芯片 · 688110.SS');
  assert.equal(byClass(rows[0], 'up')[0].textContent, '+3.20%');
  rows[0].listeners.click[0]();
  assert.deepEqual(opened, [['quote', '688110.SS']]);

  assert.equal(byClass(rows[1], 'quote-name')[0].textContent, '存储芯片');
  assert.equal(byClass(rows[1], 'quote-code')[0].textContent, '688110.SS');
  assert.equal(byClass(rows[1], 'down')[0].textContent, '-1.50%');

  assert.equal(byClass(rows[2], 'quote-name')[0].textContent, 'AAPL');
  assert.equal(byClass(rows[2], 'quote-code').length, 0);
  assert.equal(rows[2].children.find((node) => node.tagName === 'B').textContent, '—');

  const injected = byClass(rows[3], 'quote-name')[0];
  assert.equal(injected.textContent, '<b>东芯</b>');
  assert.equal(injected.children.length, 0);
  assert.equal(byClass(rows[3], 'quote-code')[0].textContent, '板块<img> · 688111.SS');
  assert.match(cssSource, /\.mover-row \{[^}]*minmax\(0, 1fr\) auto/);
  assert.doesNotMatch(cssSource, /\.mover-row \{[^}]*56px/);
  assert.match(cssSource, /\.mover-row \.quote-name \{[^}]*text-overflow: ellipsis/);
  assert.match(cssSource, /\.mover-row \.quote-code \{[^}]*var\(--font-tertiary\)/);
  assert.match(cssSource, /\.mover-row b \{[^}]*white-space: nowrap/);
  assert.doesNotMatch(appSource, /function hubMovers\(/);
  assert.doesNotMatch(appSource, /function hubStreamItems\(/);
});

test('home bootstrap keeps mover summaries so the first paint matches the board', async () => {
  const longSummary = '存储芯片设计与封测'.repeat(5);
  const body = await composeHomeBootstrap({
    informationTree: {
      list() { return { hours: [], days: [] }; },
      latestDaily() { return null; },
    },
    marketBoard: {
      async read() {
        return {
          pending: false,
          market: {
            board: 'overview',
            focus: 'cn',
            sections: [{
              id: 'cn',
              indices: [{ symbol: '000001.SS', name: '上证指数', summary: '指数不带副标', lastPrice: 1 }],
              gainers: [{ symbol: '688110.SS', name: '东芯股份', summary: longSummary, lastPrice: 80, changePct: 1 }],
              losers: [{ symbol: '300750.SZ', name: '宁德时代', summary: '动力电池', lastPrice: 20, changePct: -1 }],
            }],
          },
        };
      },
    },
    staticSignalBoard: {
      async read() {
        return { board: { generatedAt: 1, releases: [], sourceHealth: [] }, pending: false };
      },
    },
  }, { workspace: 'phone', now: Date.parse('2026-10-19T02:00:00Z') });
  const section = body.market.market.sections[0];
  assert.equal(section.indices[0].summary, undefined);
  assert.equal(section.losers[0].summary, '动力电池');
  assert.equal(section.gainers[0].name, '东芯股份');
  assert.equal(section.gainers[0].summary.endsWith('…'), true);
  assert.equal(section.gainers[0].summary.length, 41);
});

test('cn watchlist uses the catalog name when the quote name is the symbol', () => {
  const board = buildCnMarketBoard({
    quotes: [{ symbol: '300750.SZ', name: '300750.SZ', lastPrice: 20, prevClose: 18, currency: 'CNY', session: 'regular' }],
    extraSymbols: ['300750.SZ'],
    fetchedAt: Date.parse('2026-10-19T02:00:00Z'),
    marketCatalog: catalog(),
  });
  const picked = board.watchlist.find((item) => item.symbol === '300750.SZ' && item.group === '自选');
  assert.equal(picked.name, '宁德时代');
  assert.notEqual(picked.name, picked.symbol);
});

test('tonghuashun fallback keeps a name learned from a successful xueqiu quote', async () => {
  let xueqiuOn = true;
  const thsCalls = [];
  const service = createMarketService({
    marketCatalog: {
      version: 1,
      us: { groups: ['全部'], indices: [], watchlist: [] },
      asia: { groups: ['全部'], indices: [], watchlist: [] },
      cn: { groups: ['全部', '自选'], indices: [], watchlist: [] },
      global: { groups: ['指数'], watchlist: [] },
    },
    ttlMs: 0,
    xueqiuTtlMs: 0,
    now: () => Date.parse('2026-10-19T02:00:00Z'),
    log() {},
    tushare: null,
    sinaFutures: null,
    yahoo: { async fetchQuotes() { return { quotes: [], session: 'closed' }; } },
    cnQuotes: {
      async fetchQuotes(symbols) {
        thsCalls.push([...symbols]);
        return symbols.map((symbol) => ({
          symbol,
          name: symbol,
          lastPrice: 20,
          prevClose: 18,
          session: 'regular',
          currency: 'CNY',
        }));
      },
    },
    xueqiuQuotes: {
      async fetchQuotes(symbols) {
        if (!xueqiuOn) return [];
        return symbols.map((symbol) => ({
          symbol,
          name: symbol === '300750.SZ' ? '宁德时代' : '贵州茅台',
          lastPrice: 21,
          prevClose: 18,
          session: 'regular',
          currency: 'CNY',
        }));
      },
    },
  });
  const primed = await service.fetchQuotes(['600519.SS', '300750.SZ']);
  assert.equal(primed.find((item) => item.symbol === '300750.SZ').name, '宁德时代');
  assert.equal(thsCalls.length, 0);
  xueqiuOn = false;
  const board = await service.getBoard({ board: 'cn', extraCn: '300750.SZ' });
  const row = board.watchlist.find((item) => item.symbol === '300750.SZ');
  assert.equal(row.group, '自选');
  assert.equal(row.name, '宁德时代');
  assert.notEqual(row.name, row.symbol);
  assert.equal(row.lastPrice, 20);
  assert.deepEqual(thsCalls, [['300750.SZ']]);
});
