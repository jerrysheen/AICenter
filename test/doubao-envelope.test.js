import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_TRANSLATE_OUTPUT_SCHEMA,
  acceptFeedTranslateOutput,
  buildConceptSeedExtractEnvelope,
  buildFeedTranslateEnvelope,
  extractJsonValue,
  jsonlEnvelopeLine,
  materializeJsonlEnvelope,
  normalizeConceptSeedOutput,
} from '../packages/connectors/src/doubao/envelope.js';

test('concept seed envelope is one JSONL record with substituted input JSON', () => {
  const envelope = buildConceptSeedExtractEnvelope({
    batchId: 'seed_batch_0001',
    files: [{
      path: 'knowledge/finance/frameworks/tech-growth-company.md',
      title: 'Technology Growth Company Analysis',
      content: 'ARR is current recurring revenue run-rate annualized. TODO: fill examples.',
    }],
  });
  const line = jsonlEnvelopeLine(envelope);
  assert.equal(line.includes('\n'), false);
  const parsed = JSON.parse(line);
  assert.equal(parsed.custom_id, 'concept_seed_extract_0001');
  assert.equal(parsed.task, 'extract_concept_seed_heads');
  assert.match(parsed.messages[0].content, /concept seed/);
  assert.equal(parsed.messages[1].content.includes('{{INPUT_JSON}}'), false);
  assert.match(parsed.messages[1].content, /tech-growth-company\.md/);
  assert.equal(parsed.input_template.files[0].path, 'knowledge/finance/frameworks/tech-growth-company.md');
  assert.equal(materializeJsonlEnvelope(envelope).messages[1].content.includes('TODO: fill examples'), true);
});

test('extractJsonValue ignores chatter and markdown fences', () => {
  const payload = extractJsonValue(`好的
\`\`\`json
{"schema_version":"concept_seed_extract_output.v0.1","batch_id":"seed_batch_0001","concept_seeds":[{"name":"ARR","source_path":"a.md","reason":"稳定指标"}],"rejected_candidates":[]}
\`\`\`
还要不要继续？`);
  assert.equal(payload.batch_id, 'seed_batch_0001');
  assert.equal(payload.concept_seeds[0].name, 'ARR');
});

test('feed translate envelope is one JSONL record and output format is accepted or rejected', () => {
  const envelope = buildFeedTranslateEnvelope({
    batchId: 'translate_batch_0001',
    items: [{ id: 'x:1', text: 'NVIDIA announced a capacity expansion.' }],
  });
  const line = jsonlEnvelopeLine(envelope);
  const parsed = JSON.parse(line);
  assert.equal(line.includes('\n'), false);
  assert.equal(parsed.task, 'translate_feed_items');
  assert.equal(parsed.input_template.batch_id, 'translate_batch_0001');
  assert.match(parsed.messages[1].content, /NVIDIA announced a capacity expansion/);
  const accepted = acceptFeedTranslateOutput(`
\`\`\`json
{"schema_version":"${FEED_TRANSLATE_OUTPUT_SCHEMA}","batch_id":"translate_batch_0001","translations":[{"id":"x:1","translated":"英伟达宣布扩产。"}]}
\`\`\`
`, { batchId: 'translate_batch_0001', itemIds: ['x:1'] });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.translations, [{ id: 'x:1', translatedText: '英伟达宣布扩产。' }]);
  assert.equal(acceptFeedTranslateOutput('这不是 JSON', { batchId: 'translate_batch_0001', itemIds: ['x:1'] }).ok, false);
  assert.equal(acceptFeedTranslateOutput({
    translations: [{ id: 'x:1', translated: '英伟达宣布扩产。' }],
  }, { batchId: 'other', itemIds: ['x:1'] }).ok, true);
});

test('normalizeConceptSeedOutput keeps traceable heads and rejected rows', () => {
  const normalized = normalizeConceptSeedOutput({
    schema_version: 'concept_seed_extract_output.v0.1',
    batch_id: 'seed_batch_0001',
    concept_seeds: [
      { name: 'GPU Scene', source_path: 'pages/Notion/TinyEngine相关.md', reason: '渲染架构概念' },
      'Bindless Texture',
    ],
    rejected_candidates: [
      { text: '后续继续优化这一套流程', source_path: 'pages/Notion/TinyEngine相关.md', reason: '行动计划' },
    ],
  }, { fallbackPath: 'pages/Notion/TinyEngine相关.md' });
  assert.equal(normalized.concept_seeds[0].name, 'GPU Scene');
  assert.equal(normalized.concept_seeds[1].source_path, 'pages/Notion/TinyEngine相关.md');
  assert.equal(normalized.rejected_candidates[0].text, '后续继续优化这一套流程');
});
