import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.join('apps', 'web', 'public', 'index.html'), 'utf8');
const js = readFileSync(path.join('apps', 'web', 'public', 'app.js'), 'utf8');

test('selected references expose export, task and ask without a new wizard', () => {
  assert.match(html, /id="reference-pack"/);
  assert.match(html, /id="reference-pack-ask">去问答</);
  assert.match(html, /id="reference-pack-task">发给任务</);
  assert.match(html, /id="reference-pack-export">导出</);
  assert.match(html, /id="ask-ref-export">导出</);
  assert.match(html, /id="ask-ref-task">发给任务</);
  assert.match(js, /\/api\/v1\/context\/pack/);
  assert.match(js, /function sendReferencePackToTask/);
  assert.match(js, /function exportReferencePack/);
  assert.match(js, /----- 材料 -----/);
});
