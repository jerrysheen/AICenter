import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'path';

const js = readFileSync(path.join('apps', 'web', 'public', 'app.js'), 'utf8');

test('saving a feed item to inspiration keeps the displayed zh translation', () => {
  const fn = js.match(/function inspirationBodyFromPost\(post\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(fn, /translationFor\(post\)\?\.text/);
  assert.match(fn, /post\.author/);
  assert.match(fn, /post\.handle/);
  assert.match(fn, /translationFor\(post\)\?\.text \|\| post\.body/);
  assert.doesNotMatch(fn, /const parts = \[post\.author, post\.handle, post\.body\]/);
  assert.match(js, /clipInspirationBody\(inspirationBodyFromPost\(post\)\)/);
  assert.match(js, /sourceType: 'content-item'/);
  assert.match(js, /captureChannel: 'feed'/);
});
