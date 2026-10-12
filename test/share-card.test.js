import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  clampShareScale,
  planSharePages,
  resolveShareScale,
  sharePngFilename,
} from '../apps/web/public/share-card.js';
import { qrMatrix } from '../apps/web/public/qr-code.js';

const html = readFileSync(path.join('apps', 'web', 'public', 'index.html'), 'utf8');
const js = readFileSync(path.join('apps', 'web', 'public', 'app.js'), 'utf8');
const css = readFileSync(path.join('apps', 'web', 'public', 'styles.css'), 'utf8');
const news = readFileSync(path.join('apps', 'web', 'public', 'news-list.js'), 'utf8');
const brief = readFileSync(path.join('apps', 'web', 'public', 'brief-page.js'), 'utf8');
const staticFiles = readFileSync(path.join('apps', 'web', 'src', 'http', 'static-files.js'), 'utf8');
const share = readFileSync(path.join('apps', 'web', 'public', 'share-card.js'), 'utf8');

function fingerprint(matrix) {
  let hash = 2166136261;
  for (const row of matrix) {
    for (const cell of row) {
      hash ^= cell ? 1 : 0;
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

test('share filename keeps a date stamp and strips path characters', () => {
  const name = sharePngFilename('台积电 / 3nm? 展望', new Date('2026-09-21T04:00:00.000Z'));
  assert.equal(name, 'aicenter-台积电 3nm 展望-2026-09-21.png');
  assert.equal(sharePngFilename('问答', new Date('2026-09-21T04:00:00.000Z'), 1, 3), 'aicenter-问答-2026-09-21-2.png');
});

test('share scale stays inside 2..3 and pages long cards instead of shrinking them', () => {
  assert.equal(clampShareScale(1), 2);
  assert.equal(clampShareScale(2), 2);
  assert.equal(clampShareScale(2.75), 2.75);
  assert.equal(clampShareScale(3), 3);
  assert.equal(clampShareScale(4), 3);
  assert.equal(clampShareScale(Number.NaN), 2);

  const plan = planSharePages({
    cssWidth: 720,
    chromeHeight: 220,
    blockHeights: Array.from({ length: 40 }, () => 200),
    devicePixelRatio: 3,
  });
  assert.equal(plan.scale, 3);
  assert.ok(plan.pageCount > 1);
  for (const page of plan.pages) {
    const edge = page.cssHeight * plan.scale;
    const area = 720 * plan.scale * edge;
    assert.ok(edge <= 4096, `edge ${edge}`);
    assert.ok(area <= 16_777_216, `area ${area}`);
  }
  const covered = plan.pages.reduce((sum, page) => sum + page.bodyHeight, 0);
  assert.equal(covered, 8000);
});

test('share scale drops only when one page cannot fit the canvas limits', () => {
  const wide = planSharePages({
    cssWidth: 3000,
    chromeHeight: 400,
    blockHeights: [100],
    devicePixelRatio: 3,
  });
  assert.ok(wide.scale < 2);
  assert.ok(3000 * wide.scale <= 4096);
  assert.ok(wide.pages[0].cssHeight * wide.scale <= 4096);

  const tall = planSharePages({
    cssWidth: 720,
    chromeHeight: 200,
    blockHeights: [5000],
    devicePixelRatio: 2,
  });
  assert.equal(tall.scale, 2);
  assert.ok(tall.pageCount > 1);
  assert.equal(tall.pages.reduce((sum, page) => sum + page.bodyHeight, 0), 5000);

  const fitted = resolveShareScale(3, 720, 2000);
  assert.ok(fitted < 3);
  assert.ok(fitted >= 2);
  assert.ok(720 * fitted <= 4096);
  assert.ok(2000 * fitted <= 4096);
});

test('offline qr for tradingplus.cn is a version-2 matrix', () => {
  const matrix = qrMatrix('https://tradingplus.cn');
  assert.equal(matrix.length, 25);
  assert.equal(matrix.every((row) => row.length === 25), true);
  assert.equal(matrix[0][0], 1);
  assert.equal(fingerprint(matrix), 3374196081);
});

test('feed, reader, brief bullets and ask share one card', () => {
  assert.match(js, /import\('\.\/share-card\.js\?v=dev'\)/);
  assert.match(js, /shareImage\.textContent = '分享'/);
  assert.match(js, /async function shareAskExchange/);
  assert.match(js, /exportAskSharePng\(card, \{ deliver: 'auto' \}\)/);
  assert.match(js, /async function presentShareCard/);
  assert.match(js, /async function openShareImagePreview/);
  assert.match(js, /await openShareImagePreview\(result\)/);
  assert.match(js, /onShare: \(\) => presentShareCard\(postShareInput\(post\)\)/);
  assert.match(js, /label: '分享'/);
  assert.match(js, /shareCard: \(input\) => presentShareCard\(input\)/);
  assert.match(news, /className = 'text-button news-share'/);
  assert.match(news, /row\.onShare/);
  assert.match(brief, /button\('分享'/);
  assert.match(brief, /source: context\.brief \? '日报' : '小时报'/);
  assert.match(html, /id="share-image-dialog"/);
  assert.match(html, /id="share-image-pages"/);
  assert.match(html, /id="share-image-preview"/);
  assert.match(html, /id="share-image-save">保存</);
  assert.doesNotMatch(html, /id="share-image-hint"/);
  assert.match(css, /#share-image-dialog\.share-image-dialog/);
  assert.match(css, /\.share-sheet-host \{/);
  assert.match(css, /width:\s*720px/);
  assert.match(staticFiles, /'\/share-card\.js':/);
  assert.match(staticFiles, /'\/qr-code\.js':/);
  assert.match(share, /share-sheet-question/);
  assert.match(share, /function paintTree/);
  assert.match(share, /function textLineBoxes/);
  assert.match(share, /function paintListMarker/);
  assert.match(share, /function exportShareCard/);
  assert.match(share, /tradingplus\.cn/);
  assert.match(share, /from '\.\/qr-code\.js'/);
  assert.doesNotMatch(share, /const maxWidth = Math\.max/);
  assert.match(share, /function makePreviewDataUrl/);
  assert.match(share, /image\/png/);
  assert.doesNotMatch(share, /image\/jpeg/);
  assert.doesNotMatch(share, /foreignObject/);
  assert.doesNotMatch(share, /html2canvas|dom-to-image/);
});
