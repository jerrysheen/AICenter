import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SHARE_CARD_MAX_WIDTH,
  SHARE_CARD_MIN_WIDTH,
  SHARE_CARD_WIDTH,
  clampShareScale,
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

function bitmapFits(scale, cssWidth, cssHeight, maxEdge = 16384, maxArea = 16_777_216) {
  const pixelWidth = Math.round(cssWidth * scale);
  const pixelHeight = Math.round(cssHeight * scale);
  assert.ok(pixelWidth <= maxEdge, `width ${pixelWidth}`);
  assert.ok(pixelHeight <= maxEdge, `height ${pixelHeight}`);
  assert.ok(pixelWidth * pixelHeight <= maxArea, `area ${pixelWidth * pixelHeight}`);
}

test('share filename keeps a date stamp and strips path characters', () => {
  const name = sharePngFilename('台积电 / 3nm? 展望', new Date('2026-09-21T04:00:00.000Z'));
  assert.equal(name, 'aicenter-台积电 3nm 展望-2026-09-21.png');
  assert.equal(sharePngFilename('问答', new Date('2026-09-21T04:00:00.000Z')), 'aicenter-问答-2026-09-21.png');
});

test('share card width stays in 375..540 so 2x output is 750..1080', () => {
  assert.equal(SHARE_CARD_MIN_WIDTH, 375);
  assert.equal(SHARE_CARD_MAX_WIDTH, 540);
  assert.ok(SHARE_CARD_WIDTH >= SHARE_CARD_MIN_WIDTH);
  assert.ok(SHARE_CARD_WIDTH <= SHARE_CARD_MAX_WIDTH);
  assert.ok(SHARE_CARD_WIDTH * 2 >= 750);
  assert.ok(SHARE_CARD_WIDTH * 2 <= 1080);
});

test('share scale stays in 2..3 on one image when the bitmap fits', () => {
  assert.equal(clampShareScale(1), 2);
  assert.equal(clampShareScale(2), 2);
  assert.equal(clampShareScale(2.75), 2.75);
  assert.equal(clampShareScale(3), 3);
  assert.equal(clampShareScale(4), 3);
  assert.equal(clampShareScale(Number.NaN), 2);

  const sharp = resolveShareScale(3, SHARE_CARD_WIDTH, 800);
  assert.equal(sharp, 3);
  bitmapFits(sharp, SHARE_CARD_WIDTH, 800);

  const phone = resolveShareScale(1, SHARE_CARD_WIDTH, 1200);
  assert.equal(phone, 2);
  bitmapFits(phone, SHARE_CARD_WIDTH, 1200);
});

test('long share image stays one PNG and lowers scale instead of splitting', () => {
  const mid = resolveShareScale(3, SHARE_CARD_WIDTH, 10000);
  assert.ok(mid >= 1.5 && mid < 2, `mid ${mid}`);
  bitmapFits(mid, SHARE_CARD_WIDTH, 10000);

  const huge = resolveShareScale(3, SHARE_CARD_WIDTH, 20000);
  assert.ok(huge < 1.5, `huge ${huge}`);
  assert.ok(huge > 0);
  bitmapFits(huge, SHARE_CARD_WIDTH, 20000);

  const device = resolveShareScale(3, SHARE_CARD_WIDTH, 4000, {
    maxEdge: 16384,
    deviceMaxEdge: 8000,
    maxArea: 16_777_216,
  });
  assert.equal(device, 2);
  bitmapFits(device, SHARE_CARD_WIDTH, 4000, 8000);
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
  assert.match(css, /\.share-sheet-host \{[^}]*width:\s*540px/);
  assert.match(css, /\.share-sheet \{[^}]*width:\s*540px/);
  assert.match(staticFiles, /'\/share-card\.js':/);
  assert.match(staticFiles, /'\/qr-code\.js':/);
  assert.match(share, /share-sheet-question/);
  assert.match(share, /function paintTree/);
  assert.match(share, /function textLineBoxes/);
  assert.match(share, /function paintListMarker/);
  assert.match(share, /function exportShareCard/);
  assert.match(share, /function resolveShareScale/);
  assert.doesNotMatch(share, /planSharePages|paginateBlocks|share-sheet-page|share-sheet-slice/);
  assert.match(share, /tradingplus\.cn/);
  assert.match(share, /from '\.\/qr-code\.js'/);
  assert.doesNotMatch(share, /const maxWidth = Math\.max/);
  assert.match(share, /function makePreviewDataUrl/);
  assert.match(share, /image\/png/);
  assert.doesNotMatch(share, /image\/jpeg/);
  assert.doesNotMatch(share, /foreignObject/);
  assert.doesNotMatch(share, /html2canvas|dom-to-image/);
});
