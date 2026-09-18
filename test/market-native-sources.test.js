import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PredictionMarketQuoteSchema,
  parseContract,
} from '../packages/contracts/src/index.js';
import {
  parseDefillamaStablecoins,
  parseHyperliquidMetaAndAssetContexts,
  parseKalshiEvents,
  parsePolymarketMarkets,
} from '../packages/connectors/src/market-native.js';
import { createMarketNativeSourceDefinitions } from '../packages/source/src/static/market-native-definitions.js';
import { readMarketNativeBoard } from '../packages/source/src/static/market-native-board.js';

const observedAt = Date.UTC(2026, 8, 17, 12, 0, 0);

test('prediction market adapters preserve venue quotes without creating a blended probability', () => {
  const polymarket = parsePolymarketMarkets([{
    id: 'pm-1', conditionId: '0xabc', question: 'Will the Fed cut rates in October?',
    slug: 'fed-cut-october', outcomes: '["Yes","No"]', outcomePrices: '["0.61","0.39"]',
    bestBid: 0.60, bestAsk: 0.62, lastTradePrice: 0.61, spread: 0.02,
    volume24hr: 1200, volume: '9000', liquidity: '3400', endDate: '2026-10-28T23:59:00Z',
  }], [{ market: '0xabc', value: 700 }], observedAt, { limit: 10 });
  const kalshi = parseKalshiEvents([{ events: [{
    series_ticker: 'KXFEDDECISION', title: 'Fed decision in October?',
    markets: [{
      ticker: 'KXFEDDECISION-26OCT-C25', title: 'Fed cuts 25 bps?', yes_sub_title: '25 bps cut',
      yes_bid_dollars: '0.6300', yes_ask_dollars: '0.6500', last_price_dollars: '0.6400',
      volume_24h_fp: '2300.00', volume_fp: '12000.00', liquidity_dollars: '5000.00',
      open_interest_fp: '850.00', close_time: '2026-10-28T18:00:00Z',
    }],
  }] }], observedAt, { limit: 10 });

  assert.equal(polymarket[0].midPrice, '0.61');
  assert.equal(polymarket[0].openInterest, '700');
  assert.equal(kalshi[0].midPrice, '0.64');
  assert.equal(kalshi[0].outcome, '25 bps cut');
  assert.notEqual(polymarket[0].quoteId, kalshi[0].quoteId);
  assert.equal('probability' in polymarket[0], false);
  assert.equal('consensus' in kalshi[0], false);
});

test('prediction quote contract rejects interpretation-layer additions', () => {
  const quote = parsePolymarketMarkets([{
    id: 'pm-1', conditionId: '0xabc', question: 'Will Bitcoin exceed a threshold?',
    slug: 'btc-threshold', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]',
  }], [], observedAt, { limit: 10 })[0];
  assert.doesNotThrow(() => parseContract(PredictionMarketQuoteSchema, quote));
  assert.throws(() => parseContract(PredictionMarketQuoteSchema, { ...quote, bullish: true }));
});

test('Hyperliquid parser exposes BTC and ETH raw derivative state with base-asset OI', () => {
  const quotes = parseHyperliquidMetaAndAssetContexts([{
    universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }],
  }, [
    { markPx: '76000', midPx: '76001', oraclePx: '76002', prevDayPx: '75000', funding: '0.00001', openInterest: '35000', dayNtlVlm: '3000000000' },
    { markPx: '2400', midPx: '2401', oraclePx: '2402', prevDayPx: '2350', funding: '-0.00002', openInterest: '900000', dayNtlVlm: '1500000000' },
    { markPx: '100', midPx: '101', oraclePx: '100', prevDayPx: '99', funding: '0', openInterest: '1', dayNtlVlm: '2' },
  ]], observedAt, {});
  assert.deepEqual(quotes.map((quote) => quote.symbol), ['BTC', 'ETH']);
  assert.equal(quotes[0].openInterestUnit, 'base-asset');
  assert.equal(quotes[1].fundingRate, '-0.00002');
});

test('DefiLlama parser calculates objective stablecoin supply deltas for assets and chains', () => {
  const parsed = parseDefillamaStablecoins({ peggedAssets: [
    {
      symbol: 'USDT', pegType: 'peggedUSD', circulating: { peggedUSD: 100 },
      circulatingPrevDay: { peggedUSD: 90 }, circulatingPrevWeek: { peggedUSD: 80 }, circulatingPrevMonth: { peggedUSD: 70 },
      chainCirculating: { Ethereum: { current: { peggedUSD: 60 }, circulatingPrevDay: { peggedUSD: 50 }, circulatingPrevWeek: { peggedUSD: 40 }, circulatingPrevMonth: { peggedUSD: 30 } } },
    },
    {
      symbol: 'USDC', pegType: 'peggedUSD', circulating: { peggedUSD: 50 },
      circulatingPrevDay: { peggedUSD: 45 }, circulatingPrevWeek: { peggedUSD: 40 }, circulatingPrevMonth: { peggedUSD: 35 },
      chainCirculating: { Ethereum: { current: { peggedUSD: 20 }, circulatingPrevDay: { peggedUSD: 19 }, circulatingPrevWeek: { peggedUSD: 18 }, circulatingPrevMonth: { peggedUSD: 17 } } },
    },
    { symbol: 'EURC', pegType: 'peggedEUR', circulating: { peggedEUR: 999 } },
  ] }, observedAt, { assets: ['USDT', 'USDC'], chains: ['Ethereum'] });
  assert.equal(parsed.total.supplyUsd, '150.00');
  assert.equal(parsed.total.change7dUsd, '30.00');
  assert.equal(parsed.chains[0].supplyUsd, '80.00');
  assert.equal(parsed.assets.length, 2);
});

test('market-native definitions degrade connector errors to unavailable snapshots', async () => {
  const definitions = createMarketNativeSourceDefinitions({
    polymarket: async () => { throw new Error('offline'); },
    kalshi: async () => { throw new Error('offline'); },
    hyperliquid: async () => { throw new Error('offline'); },
    stablecoins: async () => { throw new Error('offline'); },
  }, { now: () => observedAt });
  for (const definition of definitions) {
    const output = await definition.read(definition.inputSchema.parse({}));
    assert.equal(output.available, false);
    assert.match(output.note, /offline/);
    assert.doesNotThrow(() => definition.outputSchema.parse(output));
  }
});

test('market-native board aggregates only its new view kinds and keeps venue rows separate', async () => {
  const prediction = parsePolymarketMarkets([{
    id: 'pm-1', conditionId: '0xabc', question: 'Will the Fed cut rates?', slug: 'fed-cut',
    outcomes: '["Yes","No"]', outcomePrices: '["0.55","0.45"]', volume24hr: 10,
  }], [], observedAt, { limit: 10 })[0];
  const derivative = parseHyperliquidMetaAndAssetContexts([
    { universe: [{ name: 'BTC' }] },
    [{ markPx: '1', midPx: '1', oraclePx: '1', prevDayPx: '1', funding: '0', openInterest: '2', dayNtlVlm: '3' }],
  ], observedAt, {})[0];
  const stable = parseDefillamaStablecoins({ peggedAssets: [] }, observedAt, { assets: [], chains: [] });
  const manifests = [
    { id: 'market-native.prediction.polymarket', title: 'P', viewKind: 'prediction-market' },
    { id: 'market-native.derivatives.hyperliquid', title: 'D', viewKind: 'crypto-derivatives' },
    { id: 'market-native.liquidity.stablecoins', title: 'L', viewKind: 'stablecoin-liquidity' },
    { id: 'calendar.us.bls', title: 'Old', viewKind: 'calendar' },
  ];
  const snapshots = {
    'market-native.prediction.polymarket': { status: 'ready', observedAt, warnings: [], data: { available: true, observedAt, sourceUrl: 'https://example.com/p', quotes: [prediction], note: '' } },
    'market-native.derivatives.hyperliquid': { status: 'ready', observedAt, warnings: [], data: { available: true, observedAt, sourceUrl: 'https://example.com/d', quotes: [derivative], note: '' } },
    'market-native.liquidity.stablecoins': { status: 'ready', observedAt, warnings: [], data: { available: true, observedAt, sourceUrl: 'https://example.com/l', ...stable, note: '' } },
  };
  const board = await readMarketNativeBoard({
    list: () => manifests,
    read: async (id) => snapshots[id],
  }, {}, { now: () => observedAt });
  assert.equal(board.predictionMarkets.length, 1);
  assert.equal(board.cryptoDerivatives.length, 1);
  assert.equal(board.sourceHealth.length, 3);
  assert.equal(board.stablecoinLiquidity.total.supplyUsd, '0.00');
});
