import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTICLE_READ_POSITION_KEY,
  articleIsLong,
  clearArticleReadPosition,
  loadArticleReadPositions,
  pickReadAnchor,
  positionWorthRestoring,
  reachedArticleEnd,
  readAnchorId,
  saveArticleReadPosition,
  scrollTopForAnchor,
} from '../apps/web/public/article-read-position.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

test('reading position uses a stable anchor and offset, not only pixels', () => {
  const seen = new Map();
  const first = readAnchorId({ kind: 'h3', text: '利率路径（00:12:03）' }, seen);
  const again = readAnchorId({ kind: 'h3', text: '利率路径（00:12:03）' }, seen);
  assert.equal(first.startsWith('h3:'), true);
  assert.equal(again, `${first}.1`);
  assert.equal(readAnchorId({ paragraphId: 'p-9', text: '别的' }, new Map()), 'para:p-9');
  const blocks = [
    { id: first, top: 20, bottom: 80 },
    { id: 'h3:later', top: 400, bottom: 460 },
  ];
  assert.deepEqual(pickReadAnchor(blocks, 100), { anchorId: 'h3:later', offset: 300 });
  assert.equal(scrollTopForAnchor({ scrollY: 900, anchorTop: 120, line: 60, offset: 300 }), 660);
  assert.equal(positionWorthRestoring({ anchorId: first, offset: 4 }, { firstAnchorId: first }), false);
  assert.equal(positionWorthRestoring({ anchorId: 'h3:later', offset: -20 }, { firstAnchorId: first }), true);
});

test('positions are stored per article and cleared at the end or from the start', () => {
  const storage = memoryStorage();
  assert.equal(articleIsLong({ scrollHeight: 2000, viewport: 800 }), true);
  assert.equal(articleIsLong({ scrollHeight: 900, viewport: 800 }), false);
  assert.equal(reachedArticleEnd({ scrollY: 1140, viewport: 800, scrollHeight: 2000 }), true);
  assert.equal(reachedArticleEnd({ scrollY: 400, viewport: 800, scrollHeight: 2000 }), false);
  assert.equal(reachedArticleEnd({ scrollY: 100, viewport: 800, scrollHeight: 900 }), false);
  saveArticleReadPosition(storage, 'article-a', { anchorId: 'h3:later', offset: -12 }, 10);
  saveArticleReadPosition(storage, 'article-b', { anchorId: 'p:1', offset: 4 }, 20);
  assert.deepEqual(loadArticleReadPositions(storage)['article-a'], { anchorId: 'h3:later', offset: -12, at: 10 });
  assert.equal(clearArticleReadPosition(storage, 'article-a'), true);
  assert.equal(loadArticleReadPositions(storage)['article-a'], undefined);
  assert.equal(loadArticleReadPositions(storage)['article-b'].anchorId, 'p:1');
  assert.match(storage.getItem(ARTICLE_READ_POSITION_KEY), /article-b/);
  const broken = memoryStorage({ [ARTICLE_READ_POSITION_KEY]: '{oops' });
  assert.deepEqual(loadArticleReadPositions(broken), {});
});
