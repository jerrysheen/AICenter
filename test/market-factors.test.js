import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFactorSnapshot } from '../packages/domain/src/market-factors/factor-engine.js';
import { maxDrawdown } from '../packages/domain/src/market-factors/price-factors.js';
import { percentileRank } from '../packages/domain/src/market-factors/percentile.js';

function closeTo(actual, expected) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-10, `${actual} !~ ${expected}`);
}

function barsFrom(closes, volume = 100) {
  return closes.map((close, index) => ({ at: index + 1, close, volume }));
}

test('percentile rank counts values at or below the current observation', () => {
  assert.equal(percentileRank([1, 2, 3, 4, 10], 3), 0.6);
  assert.equal(percentileRank([1, 2, 3], null), null);
});

test('price factors distinguish rising, falling, and flat series without look-ahead', () => {
  const rising = buildFactorSnapshot({
    symbol: '600519.SS',
    asOf: 20,
    bars: barsFrom(Array.from({ length: 20 }, (_, index) => index + 1)),
  });
  closeTo(rising.price.return5d, 20 / 15 - 1);
  assert.equal(rising.price.return252d, null);
  closeTo(rising.price.distanceToMA20, 20 / 10.5 - 1);
  assert.ok(rising.warnings.includes('priceSeriesAdjusted=false'));

  const path = barsFrom(Array.from({ length: 20 }, () => 10));
  path[5].close = 20;
  path[8].close = 4;
  path[19].close = 8;
  const fallen = buildFactorSnapshot({ symbol: '600519.SS', asOf: 20, bars: path });
  closeTo(fallen.risk.drawdown20d, 8 / 20 - 1);
  closeTo(maxDrawdown(path.map((bar) => ({ close: bar.close })), 20), 4 / 20 - 1);

  const flat = buildFactorSnapshot({
    symbol: '600519.SS',
    asOf: 252,
    bars: barsFrom(Array.from({ length: 252 }, () => 50)),
  });
  assert.equal(flat.price.return5d, 0);
  assert.equal(flat.risk.drawdown252d, 0);
  assert.equal(flat.risk.realizedVol20, 0);
  assert.equal(flat.price.pricePosition252d, null);

  const withFuture = barsFrom([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1000]);
  const bounded = buildFactorSnapshot({ symbol: '600519.SS', asOf: 10, bars: withFuture });
  closeTo(bounded.price.return5d, 10 / 5 - 1);
  assert.equal(bounded.coverage.priceSamples, 10);
});

test('adjusted prices ignore a cash dividend drop and raw prices warn', () => {
  const closes = [100, 100, 100, 100, 100, 90];
  const bars = barsFrom(closes);
  const factors = closes.map((_, index) => ({
    at: index + 1,
    adjFactor: index === 5 ? 100 / 90 : 1,
  }));
  const adjusted = buildFactorSnapshot({ symbol: '600519.SS', asOf: 6, bars, factors });
  assert.equal(adjusted.coverage.adjustedPrice, true);
  assert.equal(adjusted.warnings.includes('priceSeriesAdjusted=false'), false);
  assert.equal(adjusted.price.return5d, 0);

  const raw = buildFactorSnapshot({ symbol: '600519.SS', asOf: 6, bars });
  closeTo(raw.price.return5d, 90 / 100 - 1);
  assert.ok(raw.warnings.includes('priceSeriesAdjusted=false'));
});

test('valuation percentile keeps negative PE raw and refuses a short window label', () => {
  const positive = Array.from({ length: 4 }, (_, index) => ({
    at: index + 1,
    peTtm: (index + 1) * 10,
    pb: index === 3 ? null : index + 1,
    dividendYieldTtm: index + 1,
    turnoverRate: index + 1,
    volumeRatio: 1,
  }));
  const negative = buildFactorSnapshot({
    symbol: '600519.SS',
    asOf: 5,
    bars: barsFrom([10, 10, 10, 10, 10, 10]),
    metrics: [...positive.map((point) => ({ ...point, pb: null })), {
      at: 5, peTtm: -4, pb: null, dividendYieldTtm: 5, turnoverRate: 5, volumeRatio: 1.5,
    }],
  });
  assert.equal(negative.valuation.peTtm.value, -4);
  assert.equal(negative.valuation.peTtm.percentile5y.percentile, null);
  assert.equal(negative.valuation.peTtm.available.percentile, null);
  assert.equal(negative.valuation.pb.value, null);

  const short = Array.from({ length: 420 }, (_, index) => ({
    at: index + 1,
    peTtm: 15,
    pb: 2,
    dividendYieldTtm: 3,
    turnoverRate: 1,
    volumeRatio: 1,
  }));
  const partial = buildFactorSnapshot({
    symbol: '600519.SS',
    asOf: 420,
    bars: barsFrom(Array.from({ length: 6 }, () => 10)),
    metrics: short,
  });
  assert.equal(partial.valuation.peTtm.percentile5y.percentile, null);
  assert.equal(partial.valuation.peTtm.percentile5y.sampleCount, 420);
  assert.equal(partial.valuation.peTtm.percentile5y.requestedWindow, '5y');
  closeTo(partial.valuation.peTtm.percentile5y.coverage, 420 / 1260);
  assert.equal(partial.valuation.peTtm.available.percentile, 1);

  const full = Array.from({ length: 1260 }, (_, index) => ({
    at: index + 1,
    peTtm: index + 1,
    pb: 1,
    dividendYieldTtm: 1,
    turnoverRate: 1,
    volumeRatio: 1,
  }));
  const complete = buildFactorSnapshot({
    symbol: '600519.SS',
    asOf: 1260,
    bars: barsFrom(Array.from({ length: 21 }, () => 10)),
    metrics: full,
  });
  assert.equal(complete.valuation.peTtm.percentile5y.percentile, 1);
  assert.equal(complete.valuation.peTtm.percentile5y.sampleCount, 1260);
  assert.equal(complete.valuation.peTtm.value, 1260);
  assert.equal(JSON.stringify(complete).includes('值得买'), false);
});

test('liquidity uses turnover history and trailing volume', () => {
  const metrics = Array.from({ length: 20 }, (_, index) => ({
    at: index + 1,
    peTtm: 10,
    pb: 1,
    dividendYieldTtm: 1,
    turnoverRate: index + 1,
    volumeRatio: 2,
  }));
  const volumes = Array.from({ length: 20 }, (_, index) => (index === 19 ? 20 : 10));
  const snapshot = buildFactorSnapshot({
    symbol: '600519.SS',
    asOf: 20,
    bars: volumes.map((volume, index) => ({ at: index + 1, close: 10, volume })),
    metrics,
  });
  assert.equal(snapshot.liquidity.turnoverRate.value, 20);
  assert.equal(snapshot.liquidity.turnoverRate.percentile20d.percentile, 1);
  assert.equal(snapshot.liquidity.turnoverRate.percentile252d.percentile, null);
  assert.equal(snapshot.liquidity.turnoverRate.percentile252d.sampleCount, 20);
  assert.equal(snapshot.liquidity.volumeRatio, 2);
  closeTo(snapshot.liquidity.volume20dMean, 10.5);
  closeTo(snapshot.liquidity.volume20dRatio, 20 / 10.5);
});
