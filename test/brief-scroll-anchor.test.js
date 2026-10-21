import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { briefVisibleAnchor } from '../apps/web/public/information-tree.js';

function row(id, top, bottom) {
  return {
    dataset: { nodeId: id },
    getBoundingClientRect: () => ({ top, bottom }),
  };
}

test('a brief row tucked under the sticky bar is not the scroll anchor', () => {
  const hidden = row('under', -20, 40);
  const visible = row('below', 70, 182);
  assert.equal(briefVisibleAnchor([hidden, visible], 0).anchorId, 'under');
  const saved = briefVisibleAnchor([hidden, visible], 58);
  assert.equal(saved.anchorId, 'below');
  assert.equal(saved.anchorOffset, 70);
  assert.deepEqual(briefVisibleAnchor([hidden], 58), { anchorId: '', anchorOffset: 0 });
});

test('the brief list keeps a skeleton until the rows exist', () => {
  const tree = readFileSync(new URL('../apps/web/public/information-tree.js', import.meta.url), 'utf8');
  const brief = readFileSync(new URL('../apps/web/public/brief-page.js', import.meta.url), 'utf8');
  assert.match(tree, /briefVisibleAnchor\(list\?\.querySelectorAll\?\.\('\[data-node-id\]'\)/);
  assert.match(tree, /stickyCoverBottom\(\)/);
  assert.equal(tree.includes("list.textContent='读取中…'"), false);
  assert.match(tree, /paintListSkeleton\(list,\{rows:6,label:'正在读取简报…',variant:'feed'\}/);
  assert.match(brief, /readingSkeleton\(root\)/);
  assert.equal(brief.includes('正在读取简报…'), true);
  assert.equal(brief.includes("node('p','brief-empty','正在读取简报…')"), false);
});
