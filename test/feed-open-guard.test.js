import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'path';

const js = readFileSync(path.join('apps', 'web', 'public', 'app.js'), 'utf8');

test('feed swipe does not treat pointercancel or vertical scroll as an article tap', () => {
  assert.match(js, /function attachSwipe/);
  assert.match(js, /const canceled = event\?\.type === 'pointercancel'/);
  assert.match(js, /const tapped = tracking && !axis && !canceled/);
  assert.match(js, /if \(canceled && !swiped\)/);
  assert.match(js, /axis === 'y'[\s\S]*suppressClick = true/);
  assert.match(js, /host\.setPointerCapture\(event\.pointerId\)/);
  assert.doesNotMatch(js, /front\.style\.transition = 'none';\s*try \{\s*host\.setPointerCapture\(event\.pointerId\)/);
});

test('overview and source cards open only after a guarded click', () => {
  assert.match(js, /function attachGuardedOpen/);
  assert.match(js, /pointercancel[\s\S]*ignore = true/);
  assert.match(js, /attachGuardedOpen\(open, \(\) => openArticle\(post\)\)/);
  assert.match(js, /attachGuardedOpen\(card\.querySelector\('\.feed-content'\), \(\) => openArticle\(post\)\)/);
  assert.doesNotMatch(js, /open\.addEventListener\('click', \(\) => openArticle\(post\)\)/);
});

test('returning to the feed list does not auto-reopen the last article', () => {
  const restore = js.match(/function restoreOpenFeedItem\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(restore, /pendingFeedDialogId = ''/);
  assert.doesNotMatch(restore, /openPost\(/);
  assert.doesNotMatch(restore, /openArticle\(/);
  assert.match(js, /parsed\.pageKind !== 'article'[\s\S]*state\.dialogPost = null/);
});
