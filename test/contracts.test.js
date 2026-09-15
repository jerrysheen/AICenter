import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBehaviorEvent, parsePairInput, parsePostInput, ValidationError } from '../packages/contracts/src/index.js';

test('post input normalizes title, url, and tags', () => {
  assert.deepEqual(parsePostInput({
    title: '  首发信息  ',
    body: '  手机与电脑同步  ',
    sourceUrl: 'https://example.com/article',
    tags: '测试, 系统,测试',
  }), {
    title: '首发信息',
    body: '手机与电脑同步',
    sourceUrl: 'https://example.com/article',
    tags: ['测试', '系统'],
  });
});

test('post input requires title or body', () => {
  assert.throws(() => parsePostInput({}), ValidationError);
});

test('pair and behavior inputs reject unsupported data', () => {
  assert.deepEqual(parsePairInput({ code: '123456', deviceName: '鸿蒙手机' }), {
    code: '123456', deviceName: '鸿蒙手机',
  });
  assert.throws(() => parseBehaviorEvent({ name: 'unknown.event' }), ValidationError);
});
