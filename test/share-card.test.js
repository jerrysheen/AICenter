import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SHARE_CARD_MAX_WIDTH,
  SHARE_CARD_MIN_WIDTH,
  SHARE_CARD_WIDTH,
  askExchangeShareInput,
  clampShareScale,
  formatShareTime,
  resolveShareScale,
  sharePngFilename,
  prefersShareSheet,
  startShareDownload,
  stripSharePlaceholders,
} from '../apps/web/public/share-card.js';
import { qrMatrix } from '../apps/web/public/qr-code.js';

const html = readFileSync(path.join('apps', 'web', 'public', 'index.html'), 'utf8');
const js = readFileSync(path.join('apps', 'web', 'public', 'app.js'), 'utf8');
const css = readFileSync(path.join('apps', 'web', 'public', 'styles.css'), 'utf8');
const news = readFileSync(path.join('apps', 'web', 'public', 'news-list.js'), 'utf8');
const brief = readFileSync(path.join('apps', 'web', 'public', 'brief-page.js'), 'utf8');
const tree = readFileSync(path.join('apps', 'web', 'public', 'information-tree.js'), 'utf8');
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

test('share text drops unscraped and image placeholders', () => {
  assert.equal(stripSharePlaceholders('韩指已经两个月新低 [未抓取] 图片 ×2'), '韩指已经两个月新低');
  assert.equal(stripSharePlaceholders('说明 [图片] 和 图片 ×3 以及 [未抓取]'), '说明 和 以及');
  assert.equal(stripSharePlaceholders('[未抓取] 视频'), '');
  assert.equal(stripSharePlaceholders('[未抓取] 链接卡片：标题'), '');
  assert.equal(stripSharePlaceholders('小时摘要 [未抓取] 图片'), '小时摘要');
});

test('ask share uses the answer time and keeps a markdown table', () => {
  const card = {
    dataset: { answeredAt: '1735689600000' },
    querySelector(selector) {
      if (selector === '.ask-question') return { textContent: '仓位怎么看' };
      if (selector === '.ask-answer') {
        return {
          shareMarkdown: '见 [课程](https://example.com/a)\n\n| 项目 | 金额 |\n|---|---|\n| 净资产 | 1 |\n',
        };
      }
      if (selector === '.ask-source-footer') return { textContent: 'AI 问答' };
      return null;
    },
  };
  const input = askExchangeShareInput(card);
  assert.equal(input.time, formatShareTime(1735689600000));
  assert.notEqual(input.time, formatShareTime(new Date('2026-10-12T09:00:00Z')));
  assert.equal(input.blocks[0].text, '见 课程');
  assert.equal(input.blocks[1].kind, 'table');
  assert.deepEqual(input.blocks[1].headers, ['项目', '金额']);
  assert.deepEqual(input.blocks[1].rows, [['净资产', '1']]);
  assert.equal(input.paragraphs.join(''), '见 课程');
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
  assert.match(js, /ask-answer-share/);
  assert.match(js, /answeredAt: exchange\.completedAt \|\| exchange\.createdAt/);
  assert.match(js, /answerNode\.shareMarkdown/);
  assert.match(tree, /onShare:\(\)=>shareReadingItem\(item, edition\)/);
  assert.match(tree, /shareDailyArticle\(article, edition\)/);
  assert.match(tree, /onShare:\(\)=>shareTreeNode\(item\.n, item\.edition, '日报'\)/);
  assert.match(css, /min-width:\s*0/);
  assert.match(css, /word-break:\s*break-word/);
  assert.match(css, /\.share-sheet-table/);
  assert.match(css, /\.ask-answer-share\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.ask-turn-a:has\(\.ask-answer-share\) \.ask-answer/);
  assert.doesNotMatch(css, /\.ask-answer-share\s*\{[^}]*position:\s*sticky/);
  assert.match(js, /async function shareAskExchange/);
  assert.match(js, /exportAskSharePng\(card, \{ deliver: 'auto' \}\)/);
  assert.match(js, /async function presentShareCard/);
  assert.match(js, /async function openShareImagePreview/);
  assert.match(js, /function saveShareImagePreview\(\)/);
  assert.doesNotMatch(js, /async function saveShareImagePreview/);
  assert.match(js, /prepareShareDownload\(page\)/);
  assert.match(js, /startShareDownload/);
  assert.match(js, /preferShare: prefersShareSheet\(\)/);
  assert.doesNotMatch(js, /saveShareImagePreview\(\)\.catch/);
  assert.match(js, /stripSharePlaceholders\(decodeHtmlEntities/);
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

test('prepared save downloads in the click turn and shares on iOS', async () => {
  const blob = new Blob(['png'], { type: 'image/png' });
  const clicks = [];
  const link = { href: '', download: '', isConnected: true, click() { clicks.push('download'); } };
  const desktop = startShareDownload({
    blob, filename: 'card.png', downloadLink: link, preferShare: false,
  }, { document: { body: { append() {} } }, navigator: {} });
  assert.equal(desktop, 'download');
  assert.deepEqual(clicks, ['download']);
  assert.equal(prefersShareSheet({ navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 } }), true);
  assert.equal(prefersShareSheet({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 } }), false);
  const shared = [];
  const ios = startShareDownload({
    blob, filename: 'card.png', title: '日报', downloadLink: link, preferShare: true,
  }, {
    File: class { constructor(parts, name, options) { this.parts = parts; this.name = name; this.options = options; } },
    document: { body: { append() {} } },
    navigator: {
      canShare(data) { return Array.isArray(data.files) && data.files.length === 1; },
      share(data) { shared.push(data.files[0].name); return Promise.resolve(); },
    },
  });
  assert.equal(ios, 'share');
  assert.deepEqual(shared, ['card.png']);
  assert.deepEqual(clicks, ['download']);
  const cancelled = startShareDownload({
    blob, filename: 'card.png', downloadLink: link, preferShare: true,
  }, {
    File: class { constructor() {} },
    document: { body: { append() {} } },
    navigator: {
      canShare() { return true; },
      share() { return Promise.reject(Object.assign(new Error('cancel'), { name: 'AbortError' })); },
    },
  });
  assert.equal(cancelled, 'share');
  await Promise.resolve();
  assert.deepEqual(clicks, ['download']);
});
