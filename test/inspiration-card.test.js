import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');

function functionSource(name) {
  const match = app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

test('inspiration subtitle and body do not repeat the card title', () => {
  const box = vm.createContext({});
  vm.runInContext([
    functionSource('inspirationCardTitle'),
    functionSource('inspirationCardMeta'),
    functionSource('escapeRegExp'),
    functionSource('noteBodyWithoutRepeatedTitle'),
  ].join('\n'), box);
  const note = { title: '', sourceTitle: '芯片出口', sourceUrl: 'https://example.com/a', body: '芯片出口\n\n后面的想法' };
  assert.equal(box.inspirationCardTitle(note), '芯片出口');
  assert.equal(box.inspirationCardMeta(note), '来自信息流');
  assert.equal(box.noteBodyWithoutRepeatedTitle(note.body, box.inspirationCardTitle(note)), '后面的想法');
  const own = { title: '我的题目', sourceTitle: '原文标题', sourceUrl: '', body: '# 我的题目\n\n正文' };
  assert.equal(box.inspirationCardMeta(own), '原文标题');
  assert.equal(box.noteBodyWithoutRepeatedTitle(own.body, '我的题目'), '正文');
  const scratch = { title: '', sourceTitle: '', body: '随手一句\n\n展开后还在' };
  assert.equal(box.inspirationCardMeta(scratch), '我的随记');
  assert.equal(box.noteBodyWithoutRepeatedTitle(scratch.body, box.inspirationCardTitle(scratch)), '展开后还在');
});
