import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EPISODE_STRUCTURE_SYSTEM,
  GEMMA_SEGMENT_SYSTEM,
  longVideoCallBudget,
  longVideoPartBounds,
} from '../packages/domain/src/gemma-long-video.js';
import {
  MERGE_CHAPTER_CONCAT,
  MERGE_FLASH_POLISH,
  MERGE_POINT_COMPILE,
  mergeChapterConcat,
  mergeParallelArticle,
  podcastMergePlan,
  resolvePodcastMergeRequest,
  segmentProseBody,
} from '../packages/domain/src/podcast-article-merge.js';

test('segment prompt asks for detailed prose and the chapter prompt only cuts chapters', () => {
  assert.match(GEMMA_SEGMENT_SYSTEM, /数字/);
  assert.match(GEMMA_SEGMENT_SYSTEM, /人名/);
  assert.match(GEMMA_SEGMENT_SYSTEM, /公司/);
  assert.match(GEMMA_SEGMENT_SYSTEM, /"zh"/);
  assert.match(GEMMA_SEGMENT_SYSTEM, /hint/);
  assert.equal(GEMMA_SEGMENT_SYSTEM.includes('忠实译'), false);
  assert.match(EPISODE_STRUCTURE_SYSTEM, /partIds/);
  assert.match(EPISODE_STRUCTURE_SYSTEM, /oneLiner/);
  assert.equal(EPISODE_STRUCTURE_SYSTEM.includes('bullets'), false);
  assert.equal(EPISODE_STRUCTURE_SYSTEM.includes('章节总结'), true);
  const bounds = longVideoPartBounds();
  const budget = longVideoCallBudget(GEMMA_SEGMENT_SYSTEM, 'a'.repeat(bounds.maxChars));
  assert.ok(budget.maxOutputTokens > 0);
  assert.ok(budget.total <= 16000);
  const chinese = longVideoCallBudget(GEMMA_SEGMENT_SYSTEM, '字'.repeat(bounds.maxChars));
  assert.ok(chinese.maxOutputTokens >= bounds.maxChars);
  assert.ok(chinese.total <= 16000);
});

test('chapter-concat is the provisional default and the other two strategies stay unwired', () => {
  const fallback = resolvePodcastMergeRequest({});
  assert.equal(fallback.plan.id, MERGE_CHAPTER_CONCAT);
  assert.equal(fallback.plan.flash, 'chapters');
  assert.equal(fallback.pending, false);
  assert.equal(resolvePodcastMergeRequest({ AI_CENTER_PODCAST_MERGE: 'chapter-concat' }).pending, false);
  for (const id of [MERGE_POINT_COMPILE, MERGE_FLASH_POLISH]) {
    const selected = resolvePodcastMergeRequest({ AI_CENTER_PODCAST_MERGE: id });
    assert.equal(selected.pending, true);
    assert.equal(selected.requested, id);
    assert.equal(selected.plan.id, MERGE_CHAPTER_CONCAT);
    assert.equal(selected.plan.flash, 'chapters');
    assert.equal(podcastMergePlan(id).ready, false);
  }
  assert.equal(podcastMergePlan(MERGE_POINT_COMPILE).flash, 'compile');
  assert.equal(podcastMergePlan(MERGE_FLASH_POLISH).flash, 'polish');
  assert.equal(resolvePodcastMergeRequest({ AI_CENTER_PODCAST_MERGE: 'nope' }).plan.id, MERGE_CHAPTER_CONCAT);
});

test('a long episode joins segment prose under chapter headings without a translation layer', () => {
  const parts = [
    { translation: '第一段写了利率会差 24%，NVDA 仍在讨论。' },
    { translation: '第二段写了苹果把回购加到 1100 亿美元，库克认为需求还在。' },
    { translation: '## 不该出现的段标题\n\n第三段回到仓位，桥水把股票降到 40%。' },
  ];
  const chapters = [
    {
      title: '利率与回购',
      start: '00:12:03',
      partIds: [0, 1],
      oneLiner: '利率和回购是同一件事。',
      bullets: ['不该出现的列表'],
    },
    { title: '仓位', start: '01:02:00', partIds: [2], oneLiner: '' },
  ];
  const merged = mergeChapterConcat(parts, chapters);
  assert.equal(mergeParallelArticle(parts, chapters, MERGE_FLASH_POLISH), merged);
  assert.equal(merged, [
    '## 利率与回购（00:12:03）',
    '',
    '利率和回购是同一件事。',
    '',
    '第一段写了利率会差 24%，NVDA 仍在讨论。',
    '',
    '第二段写了苹果把回购加到 1100 亿美元，库克认为需求还在。',
    '',
    '## 仓位（01:02:00）',
    '',
    '第三段回到仓位，桥水把股票降到 40%。',
  ].join('\n'));
  assert.equal(merged.includes('章节总结'), false);
  assert.equal(merged.includes('不该出现的段标题'), false);
  assert.equal(merged.includes('不该出现的列表'), false);
  assert.equal(segmentProseBody('## 重复章名\n\n正文还在。'), '正文还在。');
  assert.equal((merged.match(/^## /gm) || []).length, 2);
});
