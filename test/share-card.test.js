import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sharePngFilename } from '../apps/web/public/share-card.js';

const html = readFileSync(path.join('apps', 'web', 'public', 'index.html'), 'utf8');
const js = readFileSync(path.join('apps', 'web', 'public', 'app.js'), 'utf8');
const css = readFileSync(path.join('apps', 'web', 'public', 'styles.css'), 'utf8');
const staticFiles = readFileSync(path.join('apps', 'web', 'src', 'http', 'static-files.js'), 'utf8');

test('share filename keeps a date stamp and strips path characters', () => {
  const name = sharePngFilename('台积电 / 3nm? 展望', new Date('2026-09-21T04:00:00.000Z'));
  assert.equal(name, 'aicenter-台积电 3nm 展望-2026-09-21.png');
});

test('ask exchange exposes a page-only share image action', () => {
  assert.match(js, /import\('\.\/share-card\.js\?v=dev'\)/);
  assert.match(js, /shareImage\.textContent = '分享'/);
  assert.match(js, /async function shareAskExchange/);
  assert.match(js, /exportAskSharePng\(card, \{ deliver: false \}\)/);
  assert.match(js, /async function openShareImagePreview/);
  assert.match(js, /await openShareImagePreview\(result\)/);
  assert.match(html, /id="share-image-dialog"/);
  assert.match(html, /id="share-image-save">保存</);
  assert.doesNotMatch(html, /id="share-image-hint"/);
  assert.match(css, /#share-image-dialog\.share-image-dialog/);
  assert.match(css, /\.share-sheet-host \{/);
  assert.match(css, /width:\s*720px/);
  assert.match(staticFiles, /'\/share-card\.js':/);
  const share = readFileSync(path.join('apps', 'web', 'public', 'share-card.js'), 'utf8');
  assert.match(share, /share-sheet-question/);
  assert.match(share, /function paintTree/);
  assert.match(share, /function makePreviewDataUrl/);
  assert.match(share, /image\/jpeg/);
  assert.doesNotMatch(share, /foreignObject/);
});
