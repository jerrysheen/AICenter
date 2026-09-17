import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml } from '../apps/web/public/markdown.js';

test('markdown renders headings tables lists and bold without raw html', () => {
  const html = markdownToHtml(`
能看到。数据来自你的**资产工作簿**。

## 总盘

| 项目 | 金额（人民币） |
|---|---|
| 净资产 | **156.3 万** |

1. **B 股价值/分红仓**
   - 伊泰 B：16.4 万，浮盈约 **+110%**
   - 鄂资 B：5.4 万

<script>alert(1)</script>
`);
  assert.match(html, /<h3>总盘<\/h3>/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>项目<\/th>/);
  assert.match(html, /<strong>156.3 万<\/strong>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<strong>\+110%<\/strong>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('markdown keeps ordered list continuation text', () => {
  const html = markdownToHtml(`2. **A 股成长仓**
   芯片 ETF、科创 50`);
  assert.match(html, /<ol>/);
  assert.match(html, /芯片 ETF、科创 50/);
});

test('markdown turns plain http urls into links', () => {
  const html = markdownToHtml('课程 https://example.com/cme-295 已公开');
  assert.match(html, /<a href="https:\/\/example.com\/cme-295" target="_blank" rel="noopener noreferrer">https:\/\/example.com\/cme-295<\/a>/);
});
