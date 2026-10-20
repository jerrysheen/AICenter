import test from 'node:test';
import assert from 'node:assert/strict';
import { behaviorClickName, behaviorControlLabel, behaviorDetailsExpand } from '../apps/web/public/behavior-clicks.js';

test('original and expand controls map to behavior events', () => {
  assert.equal(behaviorClickName('原文'), 'source.original');
  assert.equal(behaviorClickName('打开原文'), 'source.original');
  assert.equal(behaviorClickName('打开原站'), 'source.original');
  assert.equal(behaviorClickName('原帖'), 'source.original');
  assert.equal(behaviorClickName('前往原站 ↗'), 'source.original');
  assert.equal(behaviorClickName('阅读站内原文'), 'source.original');
  assert.equal(behaviorClickName('展开'), 'item.expand');
  assert.equal(behaviorClickName('展开本期其余 3 条'), 'item.expand');
  assert.equal(behaviorClickName('展开相邻上下文'), 'item.expand');
  assert.equal(behaviorClickName('展开', { detailsOpen: true }), '');
  assert.equal(behaviorClickName('分享'), '');
  assert.equal(behaviorClickName('中文正文'), '');
});

test('visible control text and open folds are recognized', () => {
  const button = {
    getAttribute(name) { return name === 'aria-label' ? '原文' : ''; },
    textContent: '报纸 原文',
  };
  assert.equal(behaviorControlLabel(button), '原文');
  assert.equal(behaviorClickName(behaviorControlLabel(button)), 'source.original');
  const fold = {
    open: true,
    dataset: { behavior: 'item.expand' },
    className: 'reading-fold',
  };
  assert.equal(behaviorDetailsExpand(fold), true);
  fold.open = false;
  assert.equal(behaviorDetailsExpand(fold), false);
  const body = { open: true, className: 'tree-body', dataset: {} };
  assert.equal(behaviorDetailsExpand(body), true);
  const evidence = {
    open: true,
    className: 'brief-evidence',
    dataset: {},
    querySelector() { return { textContent: '原文证据 1' }; },
  };
  assert.equal(behaviorDetailsExpand(evidence), false);
});
