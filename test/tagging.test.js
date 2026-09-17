import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseContract, TagAnalyzeJobInputSchema, ValidationError } from '../packages/contracts/src/index.js';
import { createStore } from '../packages/database/src/index.js';
import { loadTagCatalog } from '../packages/domain/src/tag-catalog.js';
import { parseTagBatchOutput } from '../packages/domain/src/tag-parser.js';
import { createTaggingService } from '../packages/domain/src/tagging-service.js';
import { createTaggingJobHandlers } from '../packages/runtime/src/tagging-module.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

const CATALOG = {
  version: 'tags_v1',
  tags: [
    { id: 'ai', name: 'AI', parent_id: null, keywords: ['AI', 'LLM'] },
    { id: 'semiconductor', name: '半导体', parent_id: null, keywords: ['芯片'] },
    { id: 'semiconductor_memory', name: '存储', parent_id: 'semiconductor', keywords: ['HBM', 'DRAM'] },
  ],
};

function temporaryStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-tagging-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    store,
    remove() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('default tag catalog remains a neutral template', () => {
  const loaded = loadTagCatalog(readFileSync(path.join('config', 'tags.default.json'), 'utf8'));
  assert.ok(loaded.ids.has('general'));
  assert.ok(loaded.ids.has('technology'));
  assert.equal(loaded.ids.has('ai_compute'), false);
  assert.equal(loaded.ids.has('semiconductor_memory'), false);
});

test('tag query resolves aliases and reverse-looks up tagged resources', () => {
  const temporary = temporaryStore();
  const service = createTaggingService({
    catalog: JSON.parse(readFileSync(path.join('test', 'fixtures', 'tags.test.json'), 'utf8')),
    taggingRepository: temporary.store.repositories.tagging,
  });
  assert.deepEqual(service.resolveTagQuery('算力').map((tag) => tag.id), ['ai_compute']);
  assert.deepEqual(service.resolveTagQuery('AI算力').map((tag) => tag.id), ['ai_compute']);
  assert.deepEqual(service.resolveTagQuery('ai_compute').map((tag) => tag.id), ['ai_compute']);
  temporary.store.repositories.tagging.saveTaggings([{
    workspaceId: 'local', resourceType: 'content-item', resourceId: 'c1',
    tags: ['ai_compute'], tagCatalogVersion: 'tags_v1', promptVersion: 'tag_v1', model: 'test', analyzedAt: 1,
  }]);
  const found = service.findTaggedResources({
    workspaceId: 'local', resourceType: 'content-item', tagIds: ['ai_compute'],
  });
  assert.equal(found[0].resourceId, 'c1');
  temporary.remove();
});

test('tag catalog rejects duplicates and unknown parents', () => {
  const loaded = loadTagCatalog(readFileSync(path.join('test', 'fixtures', 'tags.test.json'), 'utf8'));
  assert.equal(loaded.version, 'tags_v1');
  assert.ok(loaded.ids.has('semiconductor_memory'));
  assert.throws(() => loadTagCatalog({
    version: 'x',
    tags: [
      { id: 'ai', name: 'AI', parent_id: null, keywords: [] },
      { id: 'ai', name: 'Dup', parent_id: null, keywords: [] },
    ],
  }), ValidationError);
  assert.throws(() => loadTagCatalog({
    version: 'x',
    tags: [{ id: 'child', name: '子', parent_id: 'missing', keywords: [] }],
  }), ValidationError);
});

test('parseTagBatchOutput drops unknown tags and keeps empty arrays', () => {
  const parsed = parseTagBatchOutput({
    items: [
      { item_id: 'x1', tags: ['ai', 'fake_tag'] },
      { item_id: 'x2', tags: [] },
      { item_id: 'ghost', tags: ['ai'] },
    ],
  }, { itemIds: ['x1', 'x2', 'x3'], catalogIds: new Set(['ai', 'semiconductor']) });
  assert.deepEqual(parsed.accepted.find((row) => row.itemId === 'x1').tags, ['ai']);
  assert.deepEqual(parsed.accepted.find((row) => row.itemId === 'x2').tags, []);
  assert.deepEqual(parsed.missingItemIds, ['x3']);
  assert.equal(parsed.unknownItems.includes('ghost'), true);
  assert.equal(parsed.unknownTags[0].tagId, 'fake_tag');
});

test('parseTagBatchOutput recovers items from messy Doubao chatter', () => {
  const parsed = parseTagBatchOutput(`好的，标签如下
\`\`\`json
{"schema_version":"tag_texts_output.v0.1","items":[{"item_id":"x1","tags":["ai"]}]}
\`\`\`
还要不要继续？`, { itemIds: ['x1'], catalogIds: new Set(['ai']) });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.accepted, [{ itemId: 'x1', tags: ['ai'] }]);
});

test('parseTagBatchOutput ignores envelopes and 展开全部, accepts a top-level array', () => {
  const dump = `{"custom_id":"tag_20260917_0001","task":"tag_texts","input_template":{"tag_catalog":[{"id":"ai"}],"items":[{"item_id":"x1","source":"x","author":"a","text":"hello AI"}]}}
展开全部
[
  {"item_id":"x1","tags":["ai"]},
  {"item_id":"x2","tags":[]}
]`;
  const parsed = parseTagBatchOutput(dump, {
    itemIds: ['x1', 'x2'],
    catalogIds: new Set(['ai']),
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.accepted, [
    { itemId: 'x1', tags: ['ai'] },
    { itemId: 'x2', tags: [] },
  ]);
});

test('parseTagBatchOutput does not treat input items as empty tags', () => {
  const parsed = parseTagBatchOutput({
    schema_version: 'tag_texts_input.v0.1',
    tag_catalog: [{ id: 'ai' }],
    items: [{ item_id: 'x1', source: 'x', author: 'a', text: 'hello AI' }],
  }, { itemIds: ['x1'], catalogIds: new Set(['ai']) });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'not_json_items');
  assert.deepEqual(parsed.accepted, []);
});

test('tagging service saves by item id, retries missing, and is idempotent', async () => {
  const temporary = temporaryStore();
  const calls = [];
  const service = createTaggingService({
    catalog: CATALOG,
    taggingRepository: temporary.store.repositories.tagging,
    taggingPort: {
        async tagBatch(input) {
        const ids = input.userPayload.items.map((item) => item.item_id);
        calls.push(ids);
        const omitX2 = calls.length === 1 && ids.includes('x2');
        const tagsById = {
          x1: ['ai', 'fake_tag'],
          x2: ['semiconductor', 'semiconductor_memory'],
          x3: [],
        };
        return {
          reply_text: JSON.stringify({
            items: ids
              .filter((id) => !(omitX2 && id === 'x2'))
              .map((id) => ({ item_id: id, tags: tagsById[id] || [] })),
          }),
          model: 'test',
        };
      },
    },
  });
  const first = await service.analyzeItems({
    workspaceId: 'local',
    resourceType: 'content-item',
    items: [
      { id: 'x1', text: 'OpenAI released a model' },
      { id: 'x2', text: 'Micron HBM is sold out' },
      { id: 'x3', text: 'Weather is nice today' },
    ],
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(first.missingItemIds, []);
  assert.deepEqual(service.getTagging('local', 'content-item', 'x1').tags, ['ai']);
  assert.deepEqual(service.getTagging('local', 'content-item', 'x2').tags, ['semiconductor', 'semiconductor_memory']);
  assert.deepEqual(service.getTagging('local', 'content-item', 'x3').tags, []);

  const second = await service.analyzeItems({
    workspaceId: 'local',
    resourceType: 'content-item',
    items: [
      { id: 'x1', text: 'OpenAI released a model' },
      { id: 'x2', text: 'Micron HBM is sold out' },
    ],
  });
  assert.equal(calls.length, 2);
  assert.equal(second.skipped, 2);

  const forced = await service.analyzeItems({
    workspaceId: 'local',
    resourceType: 'content-item',
    force: true,
    items: [{ id: 'x1', text: 'OpenAI released a model' }],
  });
  assert.equal(calls.length, 3);
  assert.equal(forced.saved.length, 1);
  temporary.remove();
});

test('inspiration tagging keeps a single tag', async () => {
  const temporary = temporaryStore();
  const service = createTaggingService({
    catalog: CATALOG,
    taggingRepository: temporary.store.repositories.tagging,
    taggingPort: {
      async tagBatch() {
        return {
          reply_text: JSON.stringify({
            items: [{ item_id: 'note-1', tags: ['ai', 'semiconductor'] }],
          }),
        };
      },
    },
  });
  await service.analyzeItems({
    workspaceId: 'local',
    resourceType: 'inspiration',
    items: [{ id: 'note-1', text: 'HBM and LLM notes' }],
  });
  assert.deepEqual(service.getTagging('local', 'inspiration', 'note-1').tags, ['ai']);
  temporary.remove();
});

test('tagging job collects content items and writes results', async () => {
  const temporary = temporaryStore();
  parseContract(TagAnalyzeJobInputSchema, { resourceType: 'content-item', force: false });
  const handlers = createTaggingJobHandlers({
    taggingService: createTaggingService({
      catalog: CATALOG,
      taggingRepository: temporary.store.repositories.tagging,
      taggingPort: {
        async tagBatch(input) {
          return {
            reply_text: JSON.stringify({
              items: input.userPayload.items.map((item) => ({ item_id: item.item_id, tags: ['ai'] })),
            }),
          };
        },
      },
    }),
    feedService: {
      listTaggableItems() {
        return [{ id: 'c1', source: 'x', author: 'A', title: '', body: 'LLM news' }];
      },
    },
    knowledgeService: { listTaggableItems() { return []; } },
  });
  const output = await handlers['tagging.analyze']({ workspaceId: 'local', resourceType: 'content-item' });
  assert.equal(output.saved[0].resourceId, 'c1');
  temporary.remove();
});

test('tagging analyze API enqueues a job that can be polled', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-tagging-api-'));
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory });
  const address = await app.listen();
  try {
    const created = await fetch(`${address.localUrl}/api/v1/tagging/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceType: 'content-item', resourceIds: ['missing-item'] }),
    }).then((response) => {
      assert.equal(response.status, 202);
      return response.json();
    });
    assert.equal(created.ok, true);
    assert.ok(created.jobId);
    const polled = await fetch(`${address.localUrl}/api/v1/tagging/jobs/${created.jobId}`)
      .then((response) => response.json());
    assert.equal(polled.ok, true);
    assert.equal(polled.job.type, 'tagging.analyze');
    assert.equal(polled.status, 'queued');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
