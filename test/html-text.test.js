import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHtmlEntities } from '../apps/web/public/html-text.js';

test('html entities decode before excerpt and body render', () => {
  assert.equal(decodeHtmlEntities('趋势&hellip;继续'), '趋势…继续');
  assert.equal(decodeHtmlEntities('A&amp;B &lt; C&gt;'), 'A&B < C>');
  assert.equal(decodeHtmlEntities('&#x2026;'), '…');
  assert.equal(decodeHtmlEntities('already …'), 'already …');
});
