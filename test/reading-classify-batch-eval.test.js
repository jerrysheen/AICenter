import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { READING_CLASS_VERSION } from '../packages/domain/src/reading-focus-route.js';
import { READING_CLASS_INSTRUCTION } from '../packages/domain/src/reading-hour-service.js';
import {
  alignClassificationIds,
  baselineFromStored,
  batchClassificationInstruction,
  batchResponseSchema,
  chunkItems,
  classificationPayload,
  estimateClassifyCalls,
  formatRate,
  itemsFromFixture,
  loadRecentClassifications,
  parseBatchClassification,
  parseSingleClassification,
  renderClassifyBatchReport,
  resolveEvalOptions,
  runClassifyBatchEvaluation,
  selectEvalItems,
  summarizeBatchCalls,
} from '../packages/domain/src/reading-classify-batch-eval.js';
import { createClassifyBatchClient } from '../scripts/eval-classify-batching.mjs';

const row = (id, primaryDirection, subjectKind = 'market_asset', extra = {}) => ({
  id,
  invalid: false,
  primaryDirection,
  subjectKind,
  ...extra,
});

test('id alignment counts missing, duplicate, unknown, and invalid rows separately', () => {
  const alignment = alignClassificationIds(['a', 'b', 'c', 'd'], [
    row('a', 'finance'),
    row('a', 'industry'),
    { id: 'b', invalid: true },
    row('z', 'ai', 'ai_application'),
    { id: '', invalid: true },
    row('  d  '.trim(), 'geopolitics', 'geopolitics_event'),
  ]);
  assert.deepEqual(alignment.missingIds, ['c']);
  assert.deepEqual(alignment.duplicateIds, ['a']);
  assert.deepEqual(alignment.unknownIds, ['z', '']);
  assert.deepEqual(alignment.invalidIds, ['b']);
  assert.equal(alignment.byId.has('a'), false);
  assert.equal(alignment.byId.get('d').primaryDirection, 'geopolitics');

  const duplicated = alignClassificationIds(['a'], [row('a', 'finance'), { id: 'a', invalid: true }]);
  assert.deepEqual(duplicated.duplicateIds, ['a']);
  assert.deepEqual(duplicated.invalidIds, []);
  assert.equal(duplicated.byId.has('a'), false);
});

test('agreement uses the baseline category and ignores parse failures when counting missing ids', () => {
  const items = [
    { id: 'a', baseline: { primaryDirection: 'finance', subjectKind: 'market_asset' } },
    { id: 'b', baseline: { primaryDirection: 'finance', subjectKind: 'market_asset' } },
    { id: 'c', baseline: { primaryDirection: 'ai', subjectKind: 'ai_application' } },
    { id: 'd', baseline: { primaryDirection: 'geopolitics', subjectKind: 'geopolitics_event' } },
    { id: 'e', baseline: { primaryDirection: 'other', subjectKind: 'other' } },
    { id: 'f', baseline: { primaryDirection: 'industry', subjectKind: 'company_event' } },
  ];
  const summary = summarizeBatchCalls(items, [
    {
      latencyMs: 10,
      parseFailure: false,
      transportFailure: false,
      truncated: false,
      expectedIds: ['a', 'b', 'c', 'd', 'e'],
      rows: [
        row('a', 'finance'),
        row('a', 'finance'),
        { id: 'c', invalid: true },
        row('d', 'geopolitics', 'geopolitics_event'),
        row('e', 'other', 'other'),
        row('z', 'ai', 'ai_application'),
        { id: '', invalid: true },
      ],
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    },
    {
      latencyMs: 30,
      parseFailure: true,
      transportFailure: false,
      truncated: true,
      expectedIds: ['f'],
      rows: [],
      usage: null,
    },
  ]);
  assert.equal(summary.agree, 2);
  assert.equal(summary.total, 6);
  assert.equal(summary.missing, 1);
  assert.equal(summary.duplicate, 1);
  assert.equal(summary.unknown, 2);
  assert.equal(summary.invalid, 1);
  assert.equal(summary.parseFailures, 1);
  assert.equal(summary.transportFailures, 0);
  assert.equal(summary.truncated, 1);
  assert.equal(summary.latencyMs, 40);
  assert.equal(summary.meanLatencyMs, 20);
  assert.deepEqual(summary.perCategory.finance, { total: 2, agree: 0 });
  assert.deepEqual(summary.perCategory.geopolitics, { total: 1, agree: 1 });
  assert.deepEqual(summary.perCategory.other, { total: 1, agree: 1 });
  assert.deepEqual(summary.perCategory.industry, { total: 1, agree: 0 });
  assert.deepEqual(summary.perCategory.ai, { total: 1, agree: 0 });
  assert.deepEqual(summary.perCategory.pending, { total: 0, agree: 0 });
  assert.equal(summary.usage.complete, false);

  const transport = summarizeBatchCalls(
    [{ id: 'a', baseline: { primaryDirection: 'finance' } }],
    [{ latencyMs: 4, transportFailure: true, parseFailure: false, expectedIds: ['a'], rows: [] }],
  );
  assert.equal(transport.missing, 0);
  assert.equal(transport.agree, 0);
  assert.equal(transport.transportFailures, 1);
  assert.equal(formatRate(transport.agree, transport.total), '0.0%（0/1）');
  assert.equal(formatRate(0, 0), '—');
});

test('batch output keeps production categories and requires ids', () => {
  const batch = batchClassificationInstruction();
  const rules = READING_CLASS_INSTRUCTION.replace(/仅返回 JSON：\{[\s\S]*$/, '').trim();
  assert.ok(batch.startsWith(rules));
  assert.equal(batch.includes('仅返回 JSON：{"primaryDirection"'), false);
  assert.ok(batch.includes('仅返回 JSON：{"items"'));
  assert.ok(batch.includes('"id"'));
  for (const line of ['finance：宏观环境', 'industry：某家或几家具体公司', 'ai：AI 模型', 'geopolitics：国家关系', 'other：明确四类都不覆盖', 'pending：读完仍无法判断']) {
    assert.ok(batch.includes(line), line);
  }
  const schema = batchResponseSchema();
  assert.deepEqual(schema.required, ['items']);
  assert.ok(schema.properties.items.items.required.includes('id'));
  assert.deepEqual(schema.properties.items.items.properties.primaryDirection.enum, ['finance', 'industry', 'ai', 'geopolitics', 'other', 'pending']);
  assert.equal(parseBatchClassification('{"primaryDirection":"finance","subjectKind":"market_asset"}').ok, false);
  const parsed = parseBatchClassification('说明\n[{"id":10,"primaryDirection":"finance","subjectKind":"market_asset","classificationStatus":"out-of-scope"}]');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows[0].id, '10');
  assert.equal(parsed.rows[0].primaryDirection, 'finance');
  assert.equal(parsed.rows[0].status, 'out-of-scope');
  assert.equal(parseSingleClassification('{"items":[{"id":"a","primaryDirection":"finance","subjectKind":"market_asset"}]}'), null);
  assert.equal(parseSingleClassification('{"primaryDirection":"finance","subjectKind":"nope"}'), null);
  assert.equal(parseSingleClassification('{"primaryDirection":"ai","subjectKind":"ai_application"}').primaryDirection, 'ai');
});

test('stored baseline follows the hourly cache and the body cap matches production', () => {
  const node = { readingClassification: { primaryDirection: 'industry', subjectKind: 'company_event', status: 'classified' } };
  const stage = { status: 'completed', output: { status: 'classified', primaryDirection: 'finance', subjectKind: 'market_asset' } };
  assert.equal(baselineFromStored(node, stage).source, 'stored-node');
  assert.equal(baselineFromStored({ readingClassification: { primaryDirection: 'pending', subjectKind: 'unknown', status: 'pending' } }, stage).source, 'stored-stage');
  assert.equal(baselineFromStored({}, { status: 'failed', output: stage.output }), null);
  const body = '字'.repeat(8001);
  const payload = classificationPayload({ title: '题', text: '摘要', body });
  assert.equal(payload.summary, '摘要');
  assert.equal(payload.includedChars, 8000);
  assert.equal(payload.bodyChars, 8001);
  assert.equal(payload.inputScope, 'saved-body-prefix');
  assert.equal(payload.body.length, 8000);
});

test('recent rows prefer node classification, then the reading-class stage', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE information_tree_information_heads (
      workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, node_id TEXT NOT NULL,
      source_version TEXT NOT NULL, event_at INTEGER NOT NULL, source_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, source_id)
    );
    CREATE TABLE information_tree_nodes (
      workspace_id TEXT NOT NULL, id TEXT NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY(workspace_id, id)
    );
    CREATE TABLE daily_analysis_stages (
      workspace_id TEXT NOT NULL, report_date TEXT NOT NULL, stage_key TEXT NOT NULL,
      input_hash TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT,
      status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, report_date, stage_key, input_hash)
    );
  `);
  const insertNode = database.prepare('INSERT INTO information_tree_nodes VALUES (?,?,?)');
  const insertHead = database.prepare('INSERT INTO information_tree_information_heads VALUES (?,?,?,?,?,?)');
  const insertStage = database.prepare('INSERT INTO daily_analysis_stages VALUES (?,?,?,?,?,?,?,?,?)');
  insertNode.run('local', 'n-new', JSON.stringify({ id: 'n-new', title: '新', text: '无分类', body: '正文' }));
  insertHead.run('local', 's-new', 'n-new', 'v1', 300, 300);
  insertNode.run('local', 'n-node', JSON.stringify({
    id: 'n-node', sourceId: 's-node', title: '节点', text: '已分类', body: '正文',
    readingClassification: { primaryDirection: 'industry', subjectKind: 'company_event', status: 'classified' },
  }));
  insertHead.run('local', 's-node', 'n-node', 'v2', 200, 200);
  insertNode.run('local', 'n-stage', JSON.stringify({
    id: 'n-stage', sourceId: 's-stage', title: '缓存', text: '待定', body: '正文',
    readingClassification: { primaryDirection: 'pending', subjectKind: 'unknown', status: 'pending' },
  }));
  insertHead.run('local', 's-stage', 'n-stage', 'v3', 100, 100);
  const stageKey = 'reading-class:s-stage:v3';
  insertStage.run('local', 'reading-class', stageKey, 'other-hash', '{}', JSON.stringify({ status: 'classified', primaryDirection: 'ai', subjectKind: 'ai_application' }), 'completed', '', 1);
  insertStage.run('local', 'reading-class', stageKey, READING_CLASS_VERSION, '{}', JSON.stringify({ status: 'classified', primaryDirection: 'finance', subjectKind: 'market_asset' }), 'completed', '', 2);
  const items = loadRecentClassifications(database, 'local', 3);
  assert.deepEqual(items.map((item) => item.id), ['n-new', 'n-node', 'n-stage']);
  assert.equal(items[0].baseline, null);
  assert.equal(items[1].baseline.primaryDirection, 'industry');
  assert.equal(items[1].baseline.source, 'stored-node');
  assert.equal(items[2].baseline.primaryDirection, 'finance');
  assert.equal(items[2].baseline.source, 'stored-stage');
  database.close();
});

test('evaluation fills missing baselines one item per call, then scores each batch size', async () => {
  const requests = [];
  const result = await runClassifyBatchEvaluation({
    items: [
      { id: 'keep', title: '已有', summary: '摘要', body: '正文', baseline: { primaryDirection: 'finance', subjectKind: 'market_asset', status: 'classified', source: 'fixture' } },
      { id: 'fresh', title: '新', summary: '摘要', body: '正文', baseline: null },
    ],
    batchSizes: [2],
    baselineMode: 'auto',
    complete: async (request) => {
      requests.push(request);
      if (request.kind === 'single') {
        assert.equal(request.system, READING_CLASS_INSTRUCTION);
        assert.equal(JSON.parse(request.prompt).baseline, undefined);
        return { text: JSON.stringify({ primaryDirection: 'ai', subjectKind: 'ai_application', domainTagIds: [], classificationStatus: 'classified', evidenceQuote: 'y' }), latencyMs: 7 };
      }
      const ids = JSON.parse(request.prompt).items.map((item) => item.id);
      assert.deepEqual(ids, ['keep', 'fresh']);
      assert.equal(JSON.parse(request.prompt).items[0].baseline, undefined);
      assert.ok(request.schema.required.includes('items'));
      return {
        text: JSON.stringify({ items: [
          { id: 'keep', primaryDirection: 'finance', subjectKind: 'market_asset', domainTagIds: [], classificationStatus: 'classified', evidenceQuote: 'k' },
          { id: 'fresh', primaryDirection: 'ai', subjectKind: 'ai_application', domainTagIds: [], classificationStatus: 'classified', evidenceQuote: 'f' },
        ] }),
        latencyMs: 11,
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      };
    },
  });
  assert.equal(requests.filter((request) => request.kind === 'single').length, 1);
  assert.equal(result.compared.length, 2);
  assert.equal(result.rows[0].summary.agree, 2);
  assert.equal(result.rows[0].summary.calls, 1);
  assert.equal(result.rows[0].summary.usage.totalTokens, 11);
  assert.deepEqual(chunkItems([1, 2, 3, 4, 5], 2).map((chunk) => chunk.length), [2, 2, 1]);
  assert.deepEqual(estimateClassifyCalls(200, 0, [10, 20, 30], 'auto'), { baselineCalls: 0, batchCalls: 37, total: 37 });
  assert.equal(estimateClassifyCalls(200, 200, [10, 20, 30], 'reclassify').baselineCalls, 200);
  const options = resolveEvalOptions({ sample: '200', batches: '10,20,30', baseline: 'auto' });
  assert.deepEqual(options, { sampleSize: 200, batchSizes: [10, 20, 30], baseline: 'auto' });
  assert.equal(selectEvalItems(itemsFromFixture({ items: [
    { id: 'a', title: '甲', baseline: { primaryDirection: 'finance', subjectKind: 'market_asset' } },
    { id: 'b', title: '乙' },
  ] }), 10, 'stored').length, 1);
  const report = renderClassifyBatchReport({
    sampleSize: result.compared.length,
    loaded: 2,
    excluded: 0,
    baselineCounts: { storedNode: 0, storedStage: 0, fixture: 1, reclassified: 1 },
    baselineStats: result.baselineStats,
    model: 'gemini-3.1-flash-lite',
    maxOutputTokens: 16384,
    rows: result.rows,
  });
  assert.match(report, /\| 2 \| 1 \| 0 \| 0 \| 0 \| 11 \| 11 \| 100\.0%（2\/2） \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(report, /100\.0%（1\/1）/);
  assert.match(report, /脚本只读数据库，不写分类，不改小时报任务。/);
});

test('reclassify replaces stored labels with one call per item', async () => {
  let singles = 0;
  const result = await runClassifyBatchEvaluation({
    items: [{ id: 'a', title: '题', summary: '摘要', body: '正文', baseline: { primaryDirection: 'finance', subjectKind: 'market_asset', status: 'classified', source: 'stored-node' } }],
    batchSizes: [1],
    baselineMode: 'reclassify',
    complete: async (request) => {
      if (request.kind === 'single') {
        singles += 1;
        return { text: '{"primaryDirection":"industry","subjectKind":"company_event","classificationStatus":"classified"}', latencyMs: 3 };
      }
      return {
        text: '{"items":[{"id":"a","primaryDirection":"industry","subjectKind":"company_event","classificationStatus":"classified"}]}',
        latencyMs: 4,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  });
  assert.equal(singles, 1);
  assert.equal(result.compared[0].baseline.source, 'reclassified');
  assert.equal(result.compared[0].baseline.primaryDirection, 'industry');
  assert.equal(result.rows[0].summary.agree, 1);
  assert.equal(result.baselineStats.calls, 1);
});

test('gemini client asks for structured json and records latency on failure', async () => {
  const seen = [];
  const client = createClassifyBatchClient({
    apiKey: 'test-key',
    model: 'gemini-3.1-flash-lite',
    apiRoot: 'https://example.test/v1beta',
    fetch: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body), key: init.headers['x-goog-api-key'] });
      if (seen.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"items":[]}' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
          }),
        };
      }
      return { ok: false, status: 429, json: async () => ({ error: { message: 'quota test-key' } }) };
    },
  });
  const ok = await client.complete({ system: '规则', prompt: '{}', schema: batchResponseSchema() });
  assert.equal(seen[0].url, 'https://example.test/v1beta/models/gemini-3.1-flash-lite:generateContent');
  assert.equal(seen[0].key, 'test-key');
  assert.equal(seen[0].body.generationConfig.temperature, 0);
  assert.equal(seen[0].body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(seen[0].body.generationConfig.responseSchema.required, ['items']);
  assert.equal(ok.usage.totalTokens, 7);
  await assert.rejects(() => client.complete({ system: '规则', prompt: '{}', schema: batchResponseSchema() }), (error) => {
    assert.match(error.message, /429/);
    assert.equal(error.message.includes('test-key'), false);
    assert.equal(typeof error.latencyMs, 'number');
    return true;
  });
});
