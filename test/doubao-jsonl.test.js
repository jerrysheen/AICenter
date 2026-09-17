import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDoubaoTranslateJsonlPrompt,
  parseDoubaoTranslateJsonl,
  parseJsonlRecords,
  toJsonl,
} from '../packages/connectors/src/doubao/jsonl.js';

test('toJsonl writes one object per line', () => {
  assert.equal(
    toJsonl([{ id: 'x:1', text: 'Hello' }, { id: 'x:2', text: 'Hi' }]),
    '{"id":"x:1","text":"Hello"}\n{"id":"x:2","text":"Hi"}',
  );
});

test('translate JSONL prompt keeps ids and forbids a JSON array', () => {
  const prompt = buildDoubaoTranslateJsonlPrompt([
    { id: 'x:1', text: 'NVIDIA announced a capacity expansion.' },
  ]);
  assert.match(prompt, /只输出 JSONL/);
  assert.match(prompt, /不要 JSON 数组/);
  assert.match(prompt, /\{"id":"x:1","text":"NVIDIA announced a capacity expansion."\}/);
});

test('parseDoubaoTranslateJsonl accepts fences, chatter, and translatedText', () => {
  const rows = parseDoubaoTranslateJsonl(`
好的，译文如下：
\`\`\`jsonl
{"id":"x:1","translated":"英伟达宣布扩产。"}
not json
{"id":"x:2","translatedText":"SK海力士将扩大产能。"}
{"id":"x:1","translated":"重复应忽略"}
\`\`\`
`);
  assert.deepEqual(rows, [
    { id: 'x:1', translatedText: '英伟达宣布扩产。' },
    { id: 'x:2', translatedText: 'SK海力士将扩大产能。' },
  ]);
  assert.deepEqual(
    parseDoubaoTranslateJsonl('[{"id":"x:1","translated":"英伟达宣布扩产。"}]'),
    [{ id: 'x:1', translatedText: '英伟达宣布扩产。' }],
  );
  assert.deepEqual(parseJsonlRecords('[{"id":"x:1"},{"id":"x:2"}]'), []);
});
