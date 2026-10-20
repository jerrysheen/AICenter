import test from 'node:test';
import assert from 'node:assert/strict';
import { articleTitleSource, normalizeArticleTitle } from '../packages/domain/src/youtube-captions.js';

test('article titles keep the topic and drop quotes, headings and clickbait leftovers', () => {
  assert.equal(normalizeArticleTitle('  「美联储可能在十二月降息」 '), '美联储可能在十二月降息');
  assert.equal(normalizeArticleTitle('标题：利率路径仍在左右仓位。'), '利率路径仍在左右仓位');
  assert.equal(normalizeArticleTitle('## 要点\n\n- 不要用这一行'), '');
  assert.equal(normalizeArticleTitle('Rates and Positioning'), '');
  assert.equal(normalizeArticleTitle('短'), '');
  assert.equal(normalizeArticleTitle('字'.repeat(41)), '');
});

test('a long article title prompt keeps the opening and the section headings', () => {
  const heading = '## 户外行走（00:00:01）';
  const body = `${'甲'.repeat(500)}\n\n${heading}\n\n${'乙'.repeat(500)}`;
  const source = articleTitleSource(body, 700);
  assert.match(source, /小节标题：/);
  assert.match(source, /户外行走（00:00:01）/);
  assert.equal(source.startsWith('甲'), true);
  assert.ok(source.length < body.length);
});
