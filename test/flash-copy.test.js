import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFlashCopy } from '../packages/connectors/src/flash-copy.js';

test('flash copy uses a leading bracket and otherwise leaves a repeated title empty', () => {
  const bracket = normalizeFlashCopy('【央行】宣布降准'.slice(0, 48), '【央行】宣布降准五十个基点');
  assert.deepEqual(bracket, { title: '央行', body: '宣布降准五十个基点' });
  assert.deepEqual(normalizeFlashCopy(bracket.title, bracket.body), bracket);

  const plain = '这是一条没有括号的快讯正文，用来验证四十八字标题不会再写进标题栏。后面还有更多内容。';
  assert.deepEqual(normalizeFlashCopy(plain.slice(0, 48), plain), { title: '', body: plain });
  assert.deepEqual(normalizeFlashCopy('较早快讯', '较早的一条快讯'), { title: '较早快讯', body: '较早的一条快讯' });
  assert.deepEqual(normalizeFlashCopy('', '央行公告'), { title: '', body: '央行公告' });
});
