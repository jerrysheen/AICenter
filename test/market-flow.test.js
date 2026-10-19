import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NORTHBOUND_NET_FALLBACK,
  flowNetCopy,
  flowNoteVisible,
  flowTurnoverCopy,
  marketStockPath,
  nextStockBoard,
  stocksHash,
} from '../apps/web/public/market-flow.js';

test('资金子页路由刷新后仍停在资金', () => {
  assert.equal(marketStockPath(['flow']), 'flow');
  assert.equal(marketStockPath(['global']), '');
  assert.equal(marketStockPath([]), '');
  assert.equal(stocksHash('flow'), '#market/flow');
  assert.equal(stocksHash('us'), '#market');
  assert.equal(stocksHash('overview'), '#market');
  assert.equal(nextStockBoard('us', 'flow'), 'flow');
  assert.equal(nextStockBoard('flow', ''), 'overview');
  assert.equal(nextStockBoard('asia', ''), 'asia');
});

test('资金金额带方向和单位，不显示后台字段', () => {
  assert.deepEqual(flowNetCopy('-20.66'), { label: '净卖出', amount: '20.66', unit: '亿港元' });
  assert.deepEqual(flowNetCopy('+7.64'), { label: '净买入', amount: '7.64', unit: '亿港元' });
  assert.deepEqual(flowNetCopy('0.00'), { label: '净额', amount: '0.00', unit: '亿港元' });
  assert.deepEqual(flowNetCopy(''), { label: '净额', amount: '—', unit: '亿港元' });
  assert.deepEqual(flowTurnoverCopy('1148.65'), { label: '成交额', amount: '1148.65', unit: '亿元人民币' });
  assert.equal(flowTurnoverCopy('1148.65').label.includes('净'), false);
  assert.equal(flowNoteVisible('等待公布'), '等待公布');
  assert.equal(flowNoteVisible('更新时间 10月16日'), '');
  assert.equal(flowNoteVisible('已处理 3/3'), '');
  assert.match(NORTHBOUND_NET_FALLBACK, /不是净流入/);
  assert.match(NORTHBOUND_NET_FALLBACK, /2024年8月19日/);
});
