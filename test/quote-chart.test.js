import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateYearlyBars, barsToKLineData, quotePricePrecision } from '../apps/web/public/quote-chart.js';

test('history bars map onto KLineChart rows', () => {
  const rows = barsToKLineData([
    { at: 2000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { at: 1000, open: 8, high: 9, low: 7, close: 8.5, volume: null },
    { at: 2000, open: 11, high: 13, low: 10, close: 12, volume: 80.5 },
    { at: 3000, open: 'x', high: 1, low: 1, close: 1, volume: 1 },
  ]);

  assert.deepEqual(rows, [
    { timestamp: 1000, open: 8, high: 9, low: 7, close: 8.5 },
    { timestamp: 2000, open: 11, high: 13, low: 10, close: 12, volume: 80.5 },
  ]);
  assert.equal(quotePricePrecision(1680.25), 2);
  assert.equal(quotePricePrecision(0.085), 4);
  assert.equal(quotePricePrecision(0.0004), 6);
});

test('monthly bars fold into yearly candles', () => {
  const rows = aggregateYearlyBars([
    { at: Date.parse('2024-01-31T00:00:00Z'), open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { at: Date.parse('2024-06-30T00:00:00Z'), open: 11, high: 15, low: 8, close: 14, volume: 50 },
    { at: Date.parse('2025-03-31T00:00:00Z'), open: 14, high: 16, low: 13, close: 15, volume: null },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].open, 10);
  assert.equal(rows[0].high, 15);
  assert.equal(rows[0].low, 8);
  assert.equal(rows[0].close, 14);
  assert.equal(rows[0].volume, 150);
  assert.equal(rows[1].open, 14);
  assert.equal(rows[1].close, 15);
  assert.equal(rows[1].volume, undefined);
});
