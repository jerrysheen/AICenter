import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EPISODE_COMPILE_SYSTEM,
  EPISODE_STRUCTURE_SYSTEM,
  GEMMA_SEGMENT_SYSTEM,
  longVideoCallBudget,
  longVideoPartBounds,
  parseSegmentTranslation,
  segmentPointsOk,
} from '../packages/domain/src/gemma-long-video.js';
import {
  COMPILE_BATCH_MAX_CHARS,
  COMPILE_BATCH_MAX_PARTS,
  MERGE_CHAPTER_CONCAT,
  MERGE_FLASH_POLISH,
  MERGE_POINT_COMPILE,
  acceptCompiledArticle,
  compileAnchorCoverage,
  compileBatchKey,
  compileMaterialBatches,
  compilePrompt,
  joinCompiledBlocks,
  mergeChapterConcat,
  mergeParallelArticle,
  podcastMergePlan,
  resolvePodcastMergeRequest,
  segmentCompileMaterial,
  segmentProseBody,
} from '../packages/domain/src/podcast-article-merge.js';

test('segment prompt asks for 2 to 5 detailed points and compile writes one article', () => {
  assert.match(GEMMA_SEGMENT_SYSTEM, /数字/);
  assert.match(GEMMA_SEGMENT_SYSTEM, /人名/);
  assert.match(GEMMA_SEGMENT_SYSTEM, /公司/);
  assert.match(GEMMA_SEGMENT_SYSTEM, /"points"/);
  assert.match(GEMMA_SEGMENT_SYSTEM, /\$N billion/);
  assert.match(GEMMA_SEGMENT_SYSTEM, /N×10 亿美元/);
  assert.match(GEMMA_SEGMENT_SYSTEM, /\$4 billion 写成 40 亿美元/);
  assert.match(GEMMA_SEGMENT_SYSTEM, /\$2\.5 billion 写成 25 亿美元/);
  assert.equal(GEMMA_SEGMENT_SYSTEM.includes('"zh"'), false);
  assert.equal(GEMMA_SEGMENT_SYSTEM.includes('忠实译'), false);
  assert.match(EPISODE_COMPILE_SYSTEM, /按主题/);
  assert.match(EPISODE_COMPILE_SYSTEM, /##/);
  assert.match(EPISODE_COMPILE_SYSTEM, /N×10 亿美元/);
  assert.match(EPISODE_COMPILE_SYSTEM, /口水/);
  assert.match(EPISODE_COMPILE_SYSTEM, /因果/);
  assert.match(EPISODE_COMPILE_SYSTEM, /风险/);
  assert.match(EPISODE_COMPILE_SYSTEM, /不要为了写短/);
  assert.match(EPISODE_COMPILE_SYSTEM, /篇幅跟着事点/);
  assert.equal(EPISODE_COMPILE_SYSTEM.includes('### 章节总结'), false);
  assert.equal(/\d+\s*个?字/.test(EPISODE_COMPILE_SYSTEM), false);
  assert.equal(EPISODE_COMPILE_SYSTEM.includes('≥'), false);
  assert.match(EPISODE_STRUCTURE_SYSTEM, /partIds/);
  assert.match(EPISODE_STRUCTURE_SYSTEM, /oneLiner/);
  assert.match(EPISODE_STRUCTURE_SYSTEM, /不要写章节总结/);
  assert.equal(EPISODE_STRUCTURE_SYSTEM.includes('bullets'), false);
  const bounds = longVideoPartBounds();
  const budget = longVideoCallBudget(GEMMA_SEGMENT_SYSTEM, 'a'.repeat(bounds.maxChars));
  assert.ok(budget.maxOutputTokens > 0);
  assert.ok(budget.total <= 16000);
  const chinese = longVideoCallBudget(GEMMA_SEGMENT_SYSTEM, '字'.repeat(bounds.maxChars));
  assert.ok(chinese.maxOutputTokens >= bounds.maxChars);
  assert.ok(chinese.total <= 16000);
  const compile = longVideoCallBudget(EPISODE_COMPILE_SYSTEM, '事'.repeat(200));
  assert.equal(compile.maxOutputTokens, 4096);
  const parsed = parseSegmentTranslation(JSON.stringify({
    points: ['40 亿美元的回购', '1. 库克说需求还在', '- 口头禅'],
    topic: '回购',
  }));
  assert.deepEqual(parsed.points, ['40 亿美元的回购', '库克说需求还在', '口头禅']);
  assert.equal(segmentPointsOk(parsed.points.slice(0, 2)), true);
  assert.equal(segmentPointsOk(parsed.points.slice(0, 1)), false);
});

test('point-compile is the default and flash-polish stays unwired', () => {
  const fallback = resolvePodcastMergeRequest({});
  assert.equal(fallback.plan.id, MERGE_POINT_COMPILE);
  assert.equal(fallback.plan.flash, 'compile');
  assert.equal(fallback.pending, false);
  assert.equal(podcastMergePlan(MERGE_POINT_COMPILE).ready, true);
  const explicit = resolvePodcastMergeRequest({ AI_CENTER_PODCAST_MERGE: 'point-compile' });
  assert.equal(explicit.plan.id, MERGE_POINT_COMPILE);
  assert.equal(explicit.pending, false);
  const concat = resolvePodcastMergeRequest({ AI_CENTER_PODCAST_MERGE: 'chapter-concat' });
  assert.equal(concat.pending, false);
  assert.equal(concat.plan.id, MERGE_CHAPTER_CONCAT);
  assert.equal(concat.plan.flash, 'chapters');
  const polish = resolvePodcastMergeRequest({ AI_CENTER_PODCAST_MERGE: MERGE_FLASH_POLISH });
  assert.equal(polish.pending, true);
  assert.equal(polish.requested, MERGE_FLASH_POLISH);
  assert.equal(polish.plan.id, MERGE_POINT_COMPILE);
  assert.equal(podcastMergePlan(MERGE_FLASH_POLISH).ready, false);
  assert.equal(podcastMergePlan(MERGE_FLASH_POLISH).flash, 'polish');
  for (const id of ['nope', 'oneshot', 'E']) {
    const selected = resolvePodcastMergeRequest({ AI_CENTER_PODCAST_MERGE: id });
    assert.equal(selected.pending, false);
    assert.equal(selected.requested, '');
    assert.equal(selected.plan.id, MERGE_POINT_COMPILE);
  }
});

test('compiled articles must be one markdown piece and rejected drafts stay local', () => {
  const article = '## 利率路径（00:12:03）\n\n利率会差 24%，苹果回购加到 1100 亿美元。';
  assert.equal(acceptCompiledArticle(`\`\`\`markdown\n${article}\n\`\`\``), article);
  assert.equal(acceptCompiledArticle('{"chapters":[{"title":"利率"}]}'), '');
  assert.equal(acceptCompiledArticle('## 利率\n\n### 章节总结\n\n利率会差 24%，NVDA 仍在讨论。'), '');
  assert.equal(acceptCompiledArticle('## 利率\n\n### 对话\n\n主持人：利率会差 24%。'), '');
  assert.equal(acceptCompiledArticle('太短'), '');
  const parts = [{
    start: '00:12:03',
    topic: '回购',
    points: ['苹果把回购加到 1100 亿美元。'],
    text: '[00:12:03] Apple raised the buyback by $110 billion.',
    translation: '不该在有事点时拿译文当材料',
  }];
  const material = segmentCompileMaterial(parts);
  assert.deepEqual(material, [{
    i: 0,
    start: '00:12:03',
    topic: '回购',
    points: ['苹果把回购加到 1100 亿美元。'],
  }]);
  const prompt = compilePrompt(parts, 'Rates');
  assert.match(prompt, /各段事点/);
  assert.match(prompt, /1100 亿美元/);
  assert.equal(prompt.includes('第 1 批'), false);
  assert.equal(prompt.includes('$110 billion'), false);
  assert.equal(prompt.includes('不该在有事点时'), false);
});

test('compile splits long point runs and stitches chapters without a length gate', () => {
  const pad = '交付、折旧、电价和客户承诺都要留下。';
  const parts = Array.from({ length: COMPILE_BATCH_MAX_PARTS + 2 }, (_, index) => ({
    start: `00:${String(index).padStart(2, '0')}:00`,
    topic: `主题${index}`,
    points: [
      index === 0 ? `利率会差 24%，NVDA 仍在讨论。${pad}` : `${pad}第 ${index} 段前半。`,
      index === COMPILE_BATCH_MAX_PARTS + 1
        ? 'CoreWeave 把剩余履约加到 86 亿美元，风险是电力不够。'
        : `第 ${index} 段后半仍要保留因果。`,
    ],
  }));
  const batches = compileMaterialBatches(parts);
  assert.ok(batches.length >= 2);
  assert.ok(batches.every((batch) => batch.length <= COMPILE_BATCH_MAX_PARTS));
  assert.deepEqual(batches.flat().map((item) => item.i), parts.map((_, index) => index));
  for (const batch of batches) {
    const chars = batch.reduce((sum, item) => sum + item.points.join('\n').length, 0);
    if (batch.length > 1) assert.ok(chars <= COMPILE_BATCH_MAX_CHARS);
  }
  const fat = '甲'.repeat(COMPILE_BATCH_MAX_CHARS);
  const dense = compileMaterialBatches([
    { points: [`前半 ${fat}`, '仍有因果。'] },
    { points: ['后半 CoreWeave 加到 86 亿美元。', '风险还在。'] },
  ]);
  assert.equal(dense.length, 2);
  assert.equal(compileBatchKey(batches), batches.map((batch) => batch.map((item) => item.i).join('.')).join(','));
  const first = compilePrompt(parts, 'Rates', { material: batches[0], index: 1, total: batches.length });
  const last = compilePrompt(parts, 'Rates', { material: batches.at(-1), index: batches.length, total: batches.length });
  assert.match(first, /第 1 批/);
  assert.match(first, /24%/);
  assert.equal(first.includes('CoreWeave'), false);
  assert.match(last, new RegExp(`第 ${batches.length} 批`));
  assert.match(last, /86 亿美元/);
  assert.equal(last.includes('NVDA'), false);
  const joined = joinCompiledBlocks([
    '## 利率（00:00:00）\n\n利率会差 24%，NVDA 仍在讨论。',
    '## 算力合同（00:05:00）\n\nCoreWeave 把剩余履约加到 86 亿美元，风险是电力不够。',
  ]);
  assert.equal((joined.match(/^## /gm) || []).length, 2);
  assert.equal(joined.includes('章节总结'), false);
  assert.equal(joinCompiledBlocks(['没有标题的一段正文，汉字够了但不合格。']), '');
  const coverage = compileAnchorCoverage(parts, joined);
  assert.equal(coverage.missing.includes('24%'), false);
  assert.equal(coverage.missing.includes('NVDA'), false);
  assert.equal(coverage.missing.includes('86亿美元'), false);
  assert.equal(coverage.present, coverage.anchors);
  const dropped = compileAnchorCoverage(parts, '## 利率（00:00:00）\n\n利率会差 24%，NVDA 仍在讨论。');
  assert.equal(dropped.missing.includes('86亿美元'), true);
  assert.ok(dropped.present < dropped.anchors);
});

test('chapter concat joins segment material under headings without a second layer', () => {
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
