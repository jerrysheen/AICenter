import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOADING_QUOTE, overviewLoadingIndices } from '../apps/web/public/mock.js';

test('overview loading indices keep names and omit numeric placeholders', () => {
  assert.equal(LOADING_QUOTE, '--');
  for (const focus of ['us', 'cn', 'other']) {
    const rows = overviewLoadingIndices(focus);
    assert.ok(rows.length > 0);
    for (const item of rows) {
      assert.equal(typeof item.name, 'string');
      assert.ok(item.name);
      assert.equal(typeof item.symbol, 'string');
      assert.ok(item.symbol);
      assert.equal(item.lastPrice, null);
      assert.equal(item.changePct, null);
      assert.equal(Object.hasOwn(item, 'price'), false);
    }
  }
  assert.deepEqual(overviewLoadingIndices('us').map((item) => item.symbol), ['^GSPC', '^DJI', '^IXIC']);
  assert.equal(overviewLoadingIndices('cn').some((item) => item.symbol === '^HSI'), true);
  assert.deepEqual(overviewLoadingIndices('asia').map((item) => item.symbol), overviewLoadingIndices('us').map((item) => item.symbol));
});

test('mock market module no longer ships sample quote prices', () => {
  const source = readFileSync(new URL('../apps/web/public/mock.js', import.meta.url), 'utf8');
  assert.equal(source.includes('5628.40'), false);
  assert.equal(source.includes('export const quotes'), false);
  assert.equal(source.includes('export const globalAssets'), false);
  assert.equal(source.includes('export const marketIndex'), false);
});

function functionSource(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

test('overview ticker renders the loading mark and keeps an update time', () => {
  const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /overviewLoadingIndices\(preferredOverviewFocus\(\)\)/);
  assert.equal(app.includes('globalAssets'), false);
  assert.match(app, /lastPrice == null \? LOADING_QUOTE/);
  assert.match(app, /行情已连接 · 更新 /);
  assert.match(functionSource(app, 'renderOverview'), /更新 \$\{formatTime\(market\.fetchedAt\)\}/);
  assert.doesNotMatch(functionSource(app, 'renderOverview'), /market\.note/);
  assert.doesNotMatch(functionSource(app, 'marketBoardHint'), /formatTime/);
  assert.doesNotMatch(functionSource(app, 'assetBoardHint'), /formatTime/);
  assert.match(functionSource(app, 'renderHubTicker'), /行情已连接 · 更新 /);
});
