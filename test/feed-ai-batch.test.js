import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContract } from '../packages/contracts/src/index.js';
import { FeedAiBatchSchema } from '../packages/contracts/src/feed.js';
import { packFeedAiBatches } from '../packages/domain/src/feed-ai-batch.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';

test('packFeedAiBatches tagging splits by 20 items or 30k characters', () => {
  const tweets = Array.from({ length: 45 }, (_, index) => ({
    id: `x:${index + 1}`,
    text: `tweet ${index + 1} hbm`,
  }));
  const packed = packFeedAiBatches(tweets, {
    purpose: 'analyze',
    itemLimit: 45,
  });
  assert.equal(packed.batchCount, 3);
  assert.equal(packed.batches.map((batch) => batch.itemCount).join(','), '20,20,5');

  const articles = Array.from({ length: 10 }, (_, index) => ({
    id: `a:${index + 1}`,
    title: `Article ${index + 1}`,
    body: 'z'.repeat(4_000),
  }));
  const longPacked = packFeedAiBatches(articles, {
    purpose: 'analyze',
    itemLimit: 10,
    charBudget: 30_000,
    maxItemsPerBatch: 20,
  });
  assert.ok(longPacked.batchCount >= 2);
  assert.ok(longPacked.batches.every((batch) => batch.totalChars <= 30_000));
  const huge = packFeedAiBatches([{
    id: 'a:long',
    title: 'HBM',
    body: `${'head'.repeat(2000)}${'tail'.repeat(500)}`,
  }], { purpose: 'analyze', itemLimit: 1 });
  assert.equal(huge.batches[0].units[0].truncatedForModel, true);
  assert.equal(huge.batches[0].units[0].packedChars, 6_000);
  parseContract(FeedAiBatchSchema, packed.batches[0]);
});

test('packFeedAiBatches groups items into 5000-character batches and clips oversized units', () => {
  const packed = packFeedAiBatches([
    { id: 'x:1', text: 'a'.repeat(2_000) },
    { id: 'x:2', text: 'b'.repeat(2_000) },
    { id: 'x:3', text: 'c'.repeat(2_000) },
    { id: 'x:4', text: 'd'.repeat(6_000) },
  ], { purpose: 'translate', charBudget: 5_000, itemLimit: 30 });
  assert.equal(packed.batchCount, 3);
  assert.equal(packed.batches[0].itemCount, 2);
  assert.equal(packed.batches[1].itemCount, 1);
  assert.equal(packed.batches[2].units[0].truncatedForModel, true);
  assert.equal(packed.batches[2].units[0].packedChars, 5_000);
  assert.equal(packed.batches[2].units[0].charCount, 6_000);
  parseContract(FeedAiBatchSchema, packed.batches[0]);
});

test('packFeedAiBatches can clip items at 5000 while packing one larger translate envelope', () => {
  const packed = packFeedAiBatches([
    { id: 'x:1', text: 'a'.repeat(3_000) },
    { id: 'x:2', text: 'b'.repeat(6_000) },
  ], { purpose: 'translate', charBudget: 80_000, itemClipChars: 5_000, itemLimit: 30 });
  assert.equal(packed.batchCount, 1);
  assert.equal(packed.batches[0].itemCount, 2);
  assert.equal(packed.batches[0].units[1].packedChars, 5_000);
  assert.equal(packed.batches[0].units[1].truncatedForModel, true);
});

test('feed translateMany sends packed chunks and hashes the original full text', async () => {
  const calls = [];
  const saved = [];
  const long = 'Hello world '.repeat(600);
  const service = createFeedService({
    legacyRepository: { listPosts() { return []; }, getPost() { return null; }, createPost() { return {}; }, recordBehavior() {} },
    feedRepository: {
      saveTranslations(records) {
        saved.push(...records);
        return records;
      },
    },
    sourcePort: { findByProvider() { return null; } },
    translationPort: {
      async translateMany(input) {
        calls.push(input.items.map((item) => ({ id: item.id, chars: item.text.length })));
        return {
          translations: input.items.map((item) => ({
            id: item.id,
            sourceText: item.text,
            translatedText: `译:${item.id}`,
            targetLang: 'zh',
            engine: 'gemini',
          })),
        };
      },
    },
  });
  const result = await service.translateMany({
    targetLang: 'zh',
    items: [
      { id: 'x:1', text: 'a'.repeat(3_000) },
      { id: 'x:2', text: long },
    ],
  }, { workspaceId: 'local' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
  assert.equal(calls[0][1].chars, 5_000);
  assert.equal(result.translations.length, 2);
  assert.equal(saved[1].sourceHash.length, 64);
});
