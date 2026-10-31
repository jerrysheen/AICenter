import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createStore } from '../packages/database/src/index.js';
import { localizationItemId } from '../packages/domain/src/localize-texts.js';
import { treeCatalog } from '../packages/domain/src/information-tree-policy.js';
import { resolveHarnessLlm } from '../packages/harness/src/llm-route.js';
import {
  HOURLY_CATEGORY_TASK,
  bucketCategoryItems,
  buildTreeCategoryEdition,
  censusCategoryTags,
  coverCategoryEvents,
  categorySourceHref,
  createHourlyCategoryService,
  formatHourlyCategoryObserveLog,
  hourlyCategoryEnabled,
  parseCategoryBriefOutput,
  primaryCategoryId,
  projectHourlyCategory,
} from '../packages/domain/src/hourly-category.js';
import {
  REPORT_HOURLY_JOB_TYPE,
  createReportJobHandlers,
  hourlyCategoryHourStarts,
  runHourlyCategoryAlongside,
} from '../packages/runtime/src/report-module.js';
import { layoutHourlyDual, paintHourlyCategory } from '../apps/web/public/hourly-category-view.js';

const HOUR = 3_600_000;
const hour = 500_000 * HOUR;
const catalog = {
  version: 'tags_v1',
  tags: [
    { id: 'ai', name: 'AI' },
    { id: 'ai_compute', name: 'AI算力' },
    { id: 'macro', name: '宏观' },
    { id: 'market_cn', name: 'A股' },
    { id: 'corporate_results', name: '企业经营与财报' },
  ],
  reading: {
    version: 'tree-reading-v2',
    groupByTag: { ai: 'ai', ai_compute: 'ai', macro: 'macro', market_cn: 'market_cn', corporate_results: 'corporate_results' },
    directionByTag: { ai: 'tech', ai_compute: 'tech', macro: 'finance', market_cn: 'finance', corporate_results: 'finance' },
  },
};

function item(sourceId, tags, extra = {}) {
  return { sourceId, title: extra.title || sourceId, excerpt: extra.excerpt || '摘要', tags, eventAt: extra.eventAt || hour + 1 };
}

test('primary bucket uses the first catalog tag and groupByTag', () => {
  const classification = treeCatalog(catalog);
  assert.equal(primaryCategoryId(['not_a_real_tag', 'ai_compute', 'macro'], classification), 'ai');
  assert.equal(primaryCategoryId(['macro', 'ai'], classification), 'macro');
  const buckets = bucketCategoryItems([
    item('feed:a', ['ai_compute', 'macro']),
    item('feed:b', ['macro']),
    item('feed:c', ['not_a_real_tag']),
    item('feed:d', []),
    item('feed:e', null),
  ], catalog);
  assert.deepEqual(buckets.map((bucket) => [bucket.id, bucket.label, bucket.items.map((row) => row.sourceId)]), [
    ['ai', 'AI', ['feed:a']],
    ['macro', '宏观', ['feed:a', 'feed:b']],
    ['__untagged__', '待标注', ['feed:c', 'feed:d', 'feed:e']],
  ]);
  const ids = buckets.flatMap((bucket) => bucket.items.map((row) => row.sourceId));
  assert.equal(new Set(ids).size, 5);
  assert.equal(ids.length, 6);
  assert.equal(buckets[0].items[0].excerpt.length <= 200, true);
  const census = censusCategoryTags([
    item('feed:a', ['ai_compute', 'macro']),
    item('feed:stock', ['corporate_results']),
    item('feed:none', []),
  ], buckets, catalog);
  assert.equal(census.ingested, 3);
  assert.equal(census.nonempty, 2);
  assert.equal(census.missing, 1);
  assert.equal(census.direction.tech, 1);
  assert.equal(census.direction.finance, 2);
  assert.equal(census.direction.stock, 1);
  assert.equal(census.tags.find((row) => row.id === 'macro').tagged, 1);
  assert.equal(census.tags.find((row) => row.id === 'ai').bucketed, 1);
});

test('category brief output rejects sourceIds outside the input', () => {
  const allowed = ['feed:1', 'media:story'];
  const accepted = parseCategoryBriefOutput(JSON.stringify({
    categoryId: 'ai',
    events: [{ bullet: '模型公布新接口。', sourceIds: ['feed:1', 'feed:1'] }],
  }), { categoryId: 'ai', sourceIds: allowed });
  assert.deepEqual(accepted.events[0].sourceIds, ['feed:1']);
  assert.throws(() => parseCategoryBriefOutput(JSON.stringify({
    categoryId: 'ai',
    events: [{ bullet: '越界来源。', sourceIds: ['feed:other'] }],
  }), { categoryId: 'ai', sourceIds: allowed }), /sourceIds/);
  assert.throws(() => parseCategoryBriefOutput(JSON.stringify({
    categoryId: 'macro',
    events: [],
  }), { categoryId: 'ai', sourceIds: allowed }), /categoryId/);
  assert.throws(() => parseCategoryBriefOutput(JSON.stringify({
    categoryId: 'ai',
    events: Array.from({ length: 13 }, () => ({ bullet: '太多。', sourceIds: ['feed:1'] })),
  }), { categoryId: 'ai', sourceIds: allowed }), /事件数量/);
  const covered = coverCategoryEvents(
    [{ bullet: '已写入。', sourceIds: ['feed:1'] }],
    [{ sourceId: 'feed:1', title: '已覆盖' }, { sourceId: 'feed:2', title: '第二条' }],
  );
  assert.deepEqual(covered.events.map((event) => event.sourceIds), [['feed:1'], ['feed:2']]);
  assert.equal(covered.events[1].bullet, '第二条');
  assert.equal(covered.truncated, false);
});

function clippedIngestTitle(lead) {
  return `${lead.slice(0, 48)}…`;
}

test('clipped ingest titles are not the final bullet when a Chinese translation or fuller excerpt exists', () => {
  const lead = 'NVIDIA reported data-center revenue that beat every public estimate this quarter';
  const title = clippedIngestTitle(lead);
  assert.equal(title.endsWith('…'), true);
  assert.equal(title.length, 49);
  const fuller = coverCategoryEvents([], [
    { sourceId: 'feed:1', title, originalTitle: title, excerpt: lead },
  ]);
  assert.notEqual(fuller.events[0].bullet, title);
  assert.equal(fuller.events[0].bullet.endsWith('…'), false);
  assert.equal(fuller.events[0].bullet, lead);
  const translated = coverCategoryEvents(
    [{ bullet: title, sourceIds: ['feed:1'] }, { bullet: 'Two English headlines were merged into one line.', sourceIds: ['feed:2', 'feed:3'] }],
    [
      { sourceId: 'feed:1', title, originalTitle: title, excerpt: lead, translation: '英伟达数据中心收入超过了公开预期。' },
      { sourceId: 'feed:2', title, originalTitle: title, excerpt: lead, translation: '第一条中文。' },
      { sourceId: 'feed:3', title, originalTitle: title, excerpt: lead, translation: '第二条中文。' },
    ],
  );
  assert.equal(translated.events[0].bullet, '英伟达数据中心收入超过了公开预期。');
  assert.match(translated.events[1].bullet, /第一条中文/);
  assert.match(translated.events[1].bullet, /第二条中文/);
  const kept = coverCategoryEvents(
    [{ bullet: '模型写成的中文。', sourceIds: ['feed:1'] }],
    [{ sourceId: 'feed:1', title, originalTitle: title, excerpt: lead, translation: '英伟达数据中心收入超过了公开预期。' }],
  );
  assert.equal(kept.events[0].bullet, '模型写成的中文。');
});

test('a tree tag is kept when resource taggings are empty, and Flash does not drop the other tag', async () => {
  const store = createStore(':memory:');
  try {
    const calls = [];
    const service = createHourlyCategoryService({
      repository: store.repositories.hourlyCategory,
      candidatePort: async () => [
        { id: 'feed:node', title: '树上有宏观标签', eventAt: hour + 2 },
        { id: 'feed:both', title: '两个正式标签', eventAt: hour + 3 },
      ],
      taggingRepository: {
        listTaggings() {
          return [{ resourceType: 'content-item', resourceId: 'both', tags: ['macro', 'ai_compute'] }];
        },
      },
      nodeTagPort() {
        return new Map([['feed:node', ['market_cn']]]);
      },
      catalog,
      agentRuntime: {
        async run(input) {
          calls.push(JSON.parse(input.message));
          const payload = JSON.parse(input.message);
          return { answer: JSON.stringify({ categoryId: payload.category.id, events: [{ bullet: '只引用第一条。', sourceIds: [payload.items[0].sourceId] }] }) };
        },
      },
      now: () => hour + HOUR + 5,
      log() {},
    });
    const edition = await service.generateHour({ workspaceId: 'local', hourStart: hour });
    const ids = edition.categories.map((category) => category.id).sort();
    assert.deepEqual(ids, ['ai', 'macro', 'market_cn']);
    const macro = edition.categories.find((category) => category.id === 'macro');
    assert.equal(macro.inputCount, 1);
    assert.deepEqual(macro.events.flatMap((event) => event.sourceIds), ['feed:both']);
    const ai = edition.categories.find((category) => category.id === 'ai');
    assert.equal(ai.inputCount, 1);
    assert.ok(ai.events.flatMap((event) => event.sourceIds).includes('feed:both'));
    assert.equal(calls.length, 3);
  } finally { store.close(); }
});

test('untagged fill uses stored gemma Chinese and does not keep a clipped English title', async () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X',
    });
    const lead = 'Market desk note about rates and liquidity in the funding market this hour';
    const title = clippedIngestTitle(lead);
    const saved = [];
    for (let index = 0; index < 9; index += 1) {
      const externalId = `tweet-${index}`;
      const capture = feed.saveCapture({
        workspaceId: 'local', provider: 'x', externalId, sourceAccountId: source.id,
        sourceUrl: `https://x.com/example/status/${externalId}`,
        contentHash: createHash('sha256').update(externalId).digest('hex'),
        capturedAt: hour + index + 1,
      });
      const item = feed.saveContentItem({
        workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
        title, body: lead, summary: lead,
        sourceUrl: `https://x.com/example/status/${externalId}`,
        authorName: 'Desk', publishedAt: hour + index + 1,
      });
      const translation = `第${index + 1}条：资金市场流动性有变化。`;
      feed.saveTranslations([{
        workspaceId: 'local',
        itemId: index === 8 ? item.id : `x:${externalId}`,
        targetLang: 'zh',
        sourceHash: createHash('sha256').update(`${lead}:${index}`).digest('hex'),
        translatedText: index === 0 ? `Still an English note about ${lead}` : translation,
        engine: 'gemma',
      }]);
      if (index === 0) {
        feed.saveTranslations([{
          workspaceId: 'local',
          itemId: item.id,
          targetLang: 'zh',
          sourceHash: createHash('sha256').update(`${lead}:zh`).digest('hex'),
          translatedText: translation,
          engine: 'gemma',
        }]);
      }
      saved.push({ id: item.id, externalId, translation, eventAt: hour + index + 1 });
    }
    const looked = feed.listHourlyCategoryTexts('local', saved.map((row) => row.id));
    assert.equal(looked.length, 9);
    assert.equal(looked.every((row) => row.title === title), true);
    assert.match(looked.find((row) => row.id === `feed:${saved[0].id}`).translation, /第1条/);
    assert.match(looked.find((row) => row.id === `feed:${saved[8].id}`).translation, /第9条/);
    const calls = [];
    const service = createHourlyCategoryService({
      repository: store.repositories.hourlyCategory,
      candidatePort: async () => saved.map((row) => ({ id: `feed:${row.id}`, title, eventAt: row.eventAt })),
      excerptPort(workspaceId, candidates) {
        const ids = candidates.filter((row) => String(row.id || '').startsWith('feed:')).map((row) => row.id.slice(5));
        return feed.listHourlyCategoryTexts(workspaceId, ids);
      },
      catalog,
      now: () => hour + HOUR + 5,
      agentRuntime: {
        async run(input) {
          calls.push(input);
          const payload = JSON.parse(input.message);
          return {
            answer: JSON.stringify({
              categoryId: payload.category.id,
              events: [{ bullet: 'OpenAI released a clipped English title that should not ship', sourceIds: [payload.items[0].sourceId] }],
            }),
            model: 'gemini-3.1-flash-lite',
          };
        },
      },
      log() {},
    });
    const edition = await service.generateHour({ workspaceId: 'local', hourStart: hour });
    assert.equal(calls.length, 1);
    const payload = JSON.parse(calls[0].message);
    assert.equal(payload.category.id, '__untagged__');
    assert.equal(payload.items.length, 8);
    assert.equal(payload.truncated, true);
    assert.equal(payload.eventLimit, 8);
    assert.equal(payload.items.some((row) => row.sourceId === `feed:${saved[8].id}`), false);
    assert.equal(payload.items.every((row) => row.title.startsWith('第') && !row.title.endsWith('…')), true);
    assert.equal(calls[0].message.includes(title), false);
    assert.equal(calls[0].message.includes(lead), false);
    const untagged = edition.categories.find((category) => category.id === '__untagged__');
    assert.deepEqual(untagged.events.flatMap((event) => event.sourceIds).sort(), saved.map((row) => `feed:${row.id}`).sort());
    for (const event of untagged.events) {
      assert.equal(event.bullet.endsWith('…'), false);
      assert.equal(event.bullet === title, false);
      assert.match(event.bullet, /第\d+条/);
    }
    const first = untagged.events.find((event) => event.sourceIds.includes(`feed:${saved[0].id}`));
    const last = untagged.events.find((event) => event.sourceIds.includes(`feed:${saved[8].id}`));
    assert.equal(first.bullet, saved[0].translation);
    assert.equal(last.bullet, saved[8].translation);
  } finally { store.close(); }
});

test('media hourly category texts prefer stored Chinese and fall back to English', async () => {
  const store = createStore(':memory:');
  try {
    const media = store.repositories.media;
    const feed = store.repositories.feed;
    const now = hour + 10;
    function entry(externalId, title, summary) {
      media.upsertEntry({
        workspaceId: 'local',
        externalId,
        sourceKey: 'techmeme',
        publisherKey: 'techmeme',
        channel: 'tech',
        canonicalUrl: `https://www.techmeme.com/${encodeURIComponent(externalId)}`,
        title,
        summary,
        publishedAt: now,
        publishedAtRaw: '',
        contentLevel: 'discovery',
        contentHash: createHash('sha256').update(externalId).digest('hex'),
        revision: 1,
        status: 'indexed',
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    const zhTitle = 'Chip orders rise after a large foundry booking';
    const enTitle = 'A plain English headline with no saved translation';
    const longId = `techmeme:${'a'.repeat(140)}`;
    const longTitle = 'A very long media id whose translation is stored under the localization hash';
    entry('techmeme:zh', zhTitle, 'English excerpt about chip orders and capacity.');
    entry('techmeme:en', enTitle, 'English only excerpt that should stay in English.');
    entry(longId, longTitle, 'English excerpt for the hashed localization id.');
    feed.saveTranslations([
      {
        workspaceId: 'local',
        itemId: 'media:techmeme:zh',
        targetLang: 'zh',
        sourceHash: createHash('sha256').update(zhTitle).digest('hex'),
        translatedText: '晶圆厂大额定单之后，芯片订单上升。',
        engine: 'gemma',
      },
      {
        workspaceId: 'local',
        itemId: 'media:techmeme:en',
        targetLang: 'zh',
        sourceHash: createHash('sha256').update(enTitle).digest('hex'),
        translatedText: 'Still an English note with no Han characters.',
        engine: 'gemma',
      },
      {
        workspaceId: 'local',
        itemId: localizationItemId(`media:${longId}`),
        targetLang: 'zh',
        sourceHash: createHash('sha256').update(longTitle).digest('hex'),
        translatedText: '这条长标识的中文标题已经译好。',
        engine: 'gemma',
      },
    ]);
    assert.notEqual(localizationItemId(`media:${longId}`), `media:${longId}`);
    const looked = media.listHourlyCategoryTexts('local', ['techmeme:zh', 'techmeme:en', longId, 'missing']);
    const zh = looked.find((row) => row.id === 'media:techmeme:zh');
    const en = looked.find((row) => row.id === 'media:techmeme:en');
    const hashed = looked.find((row) => row.id === `media:${longId}`);
    assert.equal(looked.some((row) => row.id === 'media:missing'), false);
    assert.equal(zh.title, zhTitle);
    assert.match(zh.translation, /芯片订单/);
    assert.equal(en.title, enTitle);
    assert.equal(en.translation, '');
    assert.match(hashed.translation, /长标识/);
    const calls = [];
    const service = createHourlyCategoryService({
      repository: store.repositories.hourlyCategory,
      candidatePort: async () => [
        { id: 'media:techmeme:zh', title: zhTitle, eventAt: hour + 1 },
        { id: 'media:techmeme:en', title: enTitle, eventAt: hour + 2 },
      ],
      excerptPort(workspaceId, candidates) {
        const ids = candidates.filter((row) => String(row.id || '').startsWith('media:')).map((row) => row.id.slice(6));
        return media.listHourlyCategoryTexts(workspaceId, ids);
      },
      catalog,
      now: () => hour + HOUR + 5,
      agentRuntime: {
        async run(input) {
          calls.push(input);
          const payload = JSON.parse(input.message);
          return {
            answer: JSON.stringify({
              categoryId: payload.category.id,
              events: payload.items.map((row) => ({
                bullet: 'English model sentence that should not replace a stored Chinese line',
                sourceIds: [row.sourceId],
              })),
            }),
            model: 'gemini-3.1-flash-lite',
          };
        },
      },
      log() {},
    });
    const edition = await service.generateHour({ workspaceId: 'local', hourStart: hour });
    assert.equal(calls.length, 1);
    const payload = JSON.parse(calls[0].message);
    const sentZh = payload.items.find((row) => row.sourceId === 'media:techmeme:zh');
    const sentEn = payload.items.find((row) => row.sourceId === 'media:techmeme:en');
    assert.match(sentZh.title, /芯片订单/);
    assert.equal(sentZh.title.includes(zhTitle), false);
    assert.equal(sentEn.title, enTitle);
    const untagged = edition.categories.find((category) => category.id === '__untagged__');
    const zhEvent = untagged.events.find((event) => event.sourceIds.includes('media:techmeme:zh'));
    const enEvent = untagged.events.find((event) => event.sourceIds.includes('media:techmeme:en'));
    assert.equal(zhEvent.bullet, '晶圆厂大额定单之后，芯片订单上升。');
    assert.equal(enEvent.bullet, enTitle);
  } finally { store.close(); }
});

test('empty closed hour writes an empty edition and does not call Flash', async () => {
  const store = createStore(':memory:');
  try {
    let calls = 0;
    const service = createHourlyCategoryService({
      repository: store.repositories.hourlyCategory,
      candidatePort: async () => [],
      catalog,
      agentRuntime: { async run() { calls += 1; throw new Error('should not run'); } },
      now: () => hour + HOUR + 5,
    });
    const edition = await service.generateHour({ workspaceId: 'local', hourStart: hour });
    assert.equal(calls, 0);
    assert.equal(edition.status, 'empty');
    assert.equal(edition.dualRun, true);
    assert.equal(edition.formatVersion, 'hourly-category-v1');
    assert.deepEqual(edition.categories, []);
    assert.equal(edition.untaggedCount, 0);
    assert.equal(store.repositories.hourlyCategory.get('local', hour).id, edition.id);
  } finally { store.close(); }
});

test('each non-empty bucket gets one hourly-category-brief call', async () => {
  const store = createStore(':memory:');
  try {
    const ai = '11111111-1111-4111-8111-111111111111';
    const macro = '22222222-2222-4222-8222-222222222222';
    const bare = '33333333-3333-4333-8333-333333333333';
    const extra = '44444444-4444-4444-8444-444444444444';
    store.repositories.tagging.saveTaggings([
      { workspaceId: 'local', resourceType: 'content-item', resourceId: ai, tags: ['ai_compute'], tagCatalogVersion: 'tags_v1', promptVersion: 'tag_v3' },
      { workspaceId: 'local', resourceType: 'content-item', resourceId: macro, tags: ['macro'], tagCatalogVersion: 'tags_v1', promptVersion: 'tag_v3' },
      { workspaceId: 'local', resourceType: 'content-item', resourceId: bare, tags: [], tagCatalogVersion: 'tags_v1', promptVersion: 'tag_v3' },
    ]);
    const calls = [];
    const service = createHourlyCategoryService({
      repository: store.repositories.hourlyCategory,
      taggingRepository: store.repositories.tagging,
      catalog,
      now: () => hour + HOUR + 5,
      maxItems: 2,
      candidatePort: async () => [
        { id: `feed:${ai}`, title: '算力', excerpt: `${'很长'.repeat(120)}`, body: 'SECRET-BODY', eventAt: hour + 3 },
        { id: `feed:${macro}`, title: '利率', excerpt: '利率维持不变', eventAt: hour + 4 },
        { id: `feed:${bare}`, title: '无标签', excerpt: '只有标题', eventAt: hour + 5 },
        { id: `feed:${extra}`, title: '也没有标签', excerpt: '第二条', eventAt: hour + 6 },
        { id: `feed:${extra}-2`, title: '第三条待标注', excerpt: '会被截断', body: 'SECRET-BODY', eventAt: hour + 7 },
      ],
      agentRuntime: {
        async run(input) {
          calls.push(input);
          const payload = JSON.parse(input.message);
          if (payload.category.id === 'macro') {
            return { answer: JSON.stringify({ categoryId: 'macro', events: [{ bullet: '越界。', sourceIds: ['feed:missing'] }] }), model: 'gemini-3.1-flash-lite' };
          }
          return {
            answer: JSON.stringify({
              categoryId: payload.category.id,
              events: [{ bullet: `${payload.category.label}有新动态。`, sourceIds: payload.items.map((row) => row.sourceId) }],
            }),
            model: 'gemini-3.1-flash-lite',
          };
        },
      },
    });
    const edition = await service.generateHour({ workspaceId: 'local', hourStart: hour });
    assert.deepEqual(calls.map((call) => call.closedTask), [HOURLY_CATEGORY_TASK, HOURLY_CATEGORY_TASK, HOURLY_CATEGORY_TASK]);
    assert.equal(calls.every((call) => call.closedContext === true && call.usageStage === 'hourly-category' && call.closedTask !== 'article-normalize'), true);
    const payloads = calls.map((call) => JSON.parse(call.message));
    assert.deepEqual(payloads.map((payload) => payload.category.id), ['ai', 'macro', '__untagged__']);
    assert.deepEqual(Object.keys(payloads[0].items[0]).sort(), ['excerpt', 'sourceId', 'tags', 'title']);
    assert.equal(payloads[0].items[0].excerpt.length, 200);
    assert.equal(calls.some((call) => call.message.includes('SECRET-BODY')), false);
    assert.equal(payloads[2].truncated, true);
    assert.equal(payloads[2].items.length, 2);
    assert.equal(edition.dualRun, true);
    assert.equal(edition.untaggedCount, 3);
    assert.equal(edition.status, 'ready');
    const macroBlock = edition.categories.find((category) => category.id === 'macro');
    assert.equal(macroBlock.status, 'ready');
    assert.deepEqual(macroBlock.events.map((event) => event.sourceIds), [[`feed:${macro}`]]);
    assert.equal(macroBlock.events[0].bullet, '利率');
    const untagged = edition.categories.find((category) => category.id === '__untagged__');
    assert.deepEqual(untagged.events.flatMap((event) => event.sourceIds).sort(), [`feed:${bare}`, `feed:${extra}`, `feed:${extra}-2`].sort());
    const view = projectHourlyCategory(edition);
    assert.equal(view.categories[0].events[0].links[0].href, categorySourceHref(`feed:${ai}`));
    assert.equal(view.categories[0].events[0].links[0].href, `#article/feed:${ai}`);
    assert.equal(Object.hasOwn(view.categories[0], 'model'), false);
    const hidden = createHourlyCategoryService({
      repository: store.repositories.hourlyCategory,
      catalog,
      enabled: false,
    }).get('local', hour);
    assert.deepEqual(hidden, { enabled: false, edition: null });
    const shown = createHourlyCategoryService({
      repository: store.repositories.hourlyCategory,
      catalog,
      enabled: true,
    }).get('local', hour);
    assert.equal(shown.enabled, true);
    assert.equal(shown.edition.categories[0].events[0].links[0].href.startsWith('#article/'), true);
  } finally { store.close(); }
});

test('category edition copies the tree reading titles and directions and does not call Flash', async () => {
  const items = [
    { sourceId: 'media:openai', title: 'OpenAI 完成新一轮融资，估值下调。', readingDirectionName: '产业个股', disposition: 'hit', firstIngestedAt: hour + 3 },
    { sourceId: 'media:binance', title: '朝鲜黑客被指参与币安被盗。', readingDirectionName: '地缘政治', disposition: 'hit', firstIngestedAt: hour + 1 },
    { sourceId: 'media:poland', title: '波兰宪法法院庭长被停职引发对峙。', readingDirectionName: '地缘政治', disposition: 'miss', firstIngestedAt: hour + 4 },
    { sourceId: 'media:kabila', title: '刚果（金）前总统卡比拉出任叛军领导人。', readingDirectionName: '地缘政治', disposition: 'hit', firstIngestedAt: hour + 2 },
    { sourceId: 'media:english', title: 'A plain English line the tree also kept in English', readingDirectionName: '待分类', disposition: 'miss', firstIngestedAt: hour + 5 },
    { sourceId: 'media:noise', title: '不进刊。', readingDirectionName: '金融', disposition: 'out-of-scope', firstIngestedAt: hour + 6 },
  ];
  const edition = buildTreeCategoryEdition({ workspaceId: 'local', hourStart: hour, items, generatedAt: hour + HOUR });
  assert.equal(edition.status, 'ready');
  assert.deepEqual(edition.categories.map((category) => category.id), ['industry', 'geopolitics', '__untagged__']);
  const industry = edition.categories.find((category) => category.id === 'industry');
  assert.equal(industry.label, '产业个股');
  assert.equal(industry.events[0].bullet, 'OpenAI 完成新一轮融资，估值下调。');
  assert.equal(industry.truncated, false);
  const geo = edition.categories.find((category) => category.id === 'geopolitics');
  assert.equal(geo.label, '地缘政治');
  assert.deepEqual(geo.events.map((event) => event.bullet), [
    '朝鲜黑客被指参与币安被盗。',
    '刚果（金）前总统卡比拉出任叛军领导人。',
    '波兰宪法法院庭长被停职引发对峙。',
  ]);
  const untagged = edition.categories.find((category) => category.id === '__untagged__');
  assert.deepEqual(untagged.events.map((event) => event.sourceIds[0]), ['media:english']);
  assert.equal(untagged.events[0].bullet, 'A plain English line the tree also kept in English');
  assert.equal(JSON.stringify(edition).includes('Suited and booted'), false);
  const many = buildTreeCategoryEdition({
    workspaceId: 'local',
    hourStart: hour,
    items: Array.from({ length: 81 }, (_, index) => ({
      sourceId: `feed:${index}`,
      title: `第${index}条中文`,
      readingDirectionName: '金融',
      disposition: 'hit',
      firstIngestedAt: hour + index,
    })),
    generatedAt: hour + HOUR,
  });
  const finance = many.categories.find((category) => category.id === 'finance');
  assert.equal(finance.inputCount, 81);
  assert.equal(finance.events.length, 80);
  assert.equal(finance.truncated, true);
  const store = createStore(':memory:');
  try {
    let flashes = 0;
    const service = createHourlyCategoryService({
      repository: store.repositories.hourlyCategory,
      nodePort() {
        return [{
          sourceId: 'media:stock',
          title: 'OpenAI因AI板块抛售调整新一轮融资。',
          eventAt: hour + 1,
          readingClassification: { primaryDirection: 'industry', subjectKind: 'company_event', status: 'classified', domainTagIds: [] },
        }];
      },
      agentRuntime: { async run() { flashes += 1; throw new Error('should not run'); } },
      now: () => hour + HOUR + 5,
      log() {},
    });
    const saved = await service.publishFromTree({ workspaceId: 'local', hourStart: hour, snapshot: null });
    assert.equal(flashes, 0);
    assert.equal(saved.categories[0].id, 'industry');
    assert.equal(saved.categories[0].events[0].bullet, 'OpenAI因AI板块抛售调整新一轮融资。');
    assert.equal(saved.untaggedCount, 0);
    const held = await service.publishFromTree({
      workspaceId: 'local',
      hourStart: hour,
      snapshot: { items: [] },
    });
    assert.equal(held.status, 'empty');
    assert.equal(flashes, 0);
  } finally { store.close(); }
});

test('an empty reading hour writes an empty category instead of a second bucket pass', async () => {
  const seen = [];
  const digest = { id: 'edition-1', status: 'empty', published: true, window: { startAt: hour, endAt: hour + HOUR }, pendingIds: [] };
  await createReportJobHandlers({
    reportService: { generateDailyReport() {} },
    informationService: { async generateHourlyDigests() { return [digest]; } },
    treeService: {},
    readingHour: { enabled: true, async scoreWindow() { return { published: false, reason: 'empty' }; } },
    hourlyCategory: {
      async publishFromTree(input) {
        seen.push(input.snapshot);
        return { id: `hcat:${input.hourStart}`, status: 'empty' };
      },
    },
    env: { AI_CENTER_HOURLY_CATEGORY: '1' },
  })[REPORT_HOURLY_JOB_TYPE]({ workspaceId: 'local', hourStart: hour }, {});
  assert.deepEqual(seen, [{ items: [] }]);
});

test('hourly category flag off keeps the tree hour and does not call Flash', async () => {
  assert.equal(hourlyCategoryEnabled({}), false);
  assert.equal(hourlyCategoryEnabled({ AI_CENTER_HOURLY_CATEGORY: '0' }), false);
  assert.equal(hourlyCategoryEnabled({ AI_CENTER_HOURLY_CATEGORY: '1' }), true);
  assert.deepEqual(hourlyCategoryHourStarts({ hourStart: hour }, [{ window: { startAt: hour + HOUR } }]), [hour]);
  assert.deepEqual(hourlyCategoryHourStarts({}, [{ window: { startAt: hour } }, { window: { startAt: hour - HOUR } }]), [hour, hour - HOUR]);
  const digest = { id: 'edition-1', status: 'ready', published: true, window: { startAt: hour, endAt: hour + HOUR }, pendingIds: [] };
  const categoryCalls = [];
  const order = [];
  const handlers = createReportJobHandlers({
    reportService: { generateDailyReport() {} },
    informationService: { async generateHourlyDigests() { order.push('tree'); return [digest]; } },
    treeService: {},
    readingHour: { enabled: true, async scoreWindow() { order.push('reading'); return {}; } },
    hourlyCategory: { async generateHour(input) { order.push('category'); categoryCalls.push(input); return { id: `hcat:${input.hourStart}`, status: 'ready' }; } },
    env: {},
  });
  const off = await handlers[REPORT_HOURLY_JOB_TYPE]({ workspaceId: 'local', hourStart: hour }, {});
  assert.deepEqual(order, ['tree', 'reading']);
  assert.equal(categoryCalls.length, 0);
  assert.equal(Object.hasOwn(off, 'categoryEditionIds'), false);

  order.length = 0;
  categoryCalls.length = 0;
  const snapshot = {
    items: [{
      sourceId: 'feed:openai',
      title: 'OpenAI 完成新一轮融资。',
      readingDirectionName: '产业个股',
      disposition: 'hit',
    }],
  };
  const on = await createReportJobHandlers({
    reportService: { generateDailyReport() {} },
    informationService: { async generateHourlyDigests() { order.push('tree'); return [digest]; } },
    treeService: {},
    readingHour: { enabled: true, async scoreWindow() { order.push('reading'); return { snapshot }; } },
    hourlyCategory: {
      async publishFromTree(input) {
        order.push('category');
        categoryCalls.push(input);
        return { id: `hcat:${input.hourStart}`, status: 'ready' };
      },
    },
    env: { AI_CENTER_HOURLY_CATEGORY: '1' },
  })[REPORT_HOURLY_JOB_TYPE]({ workspaceId: 'local', hourStart: hour }, {});
  assert.deepEqual(order, ['tree', 'reading', 'category']);
  assert.equal(categoryCalls.length, 1);
  assert.equal(categoryCalls[0].hourStart, hour);
  assert.equal(categoryCalls[0].snapshot.items[0].title, 'OpenAI 完成新一轮融资。');
  assert.deepEqual(on.categoryEditionIds, [`hcat:${hour}`]);

  const failed = [];
  await assert.rejects(createReportJobHandlers({
    reportService: { generateDailyReport() {} },
    informationService: { async generateHourlyDigests() { throw new Error('tree down'); } },
    treeService: {},
    hourlyCategory: {
      async generateHour(input) { failed.push(input); return { id: 'hcat', status: 'ready' }; },
      async publishFromTree() { failed.push('copy'); },
    },
    env: { AI_CENTER_HOURLY_CATEGORY: '1' },
  })[REPORT_HOURLY_JOB_TYPE]({ workspaceId: 'local', hourStart: hour }, {}), /tree down/);
  assert.deepEqual(failed, []);
});

test('category brief reuses the hourly Flash route and does not replace article normalize', () => {
  const env = {
    AI_CENTER_HARNESS_PROVIDER: 'deepseek-official',
    AI_CENTER_HARNESS_HOURLY_PROVIDER: 'google',
    AI_CENTER_HARNESS_ARTICLE_PROVIDER: 'google',
    AI_CENTER_HARNESS_HOURLY_MODEL: 'gemini-3.1-flash-lite',
    GEMINI_API_KEY: 'test-key',
  };
  const category = resolveHarnessLlm(env, { closedTask: 'hourly-category-brief' });
  const hourly = resolveHarnessLlm(env, { closedTask: 'hourly-brief' });
  const article = resolveHarnessLlm(env, { closedTask: 'article-normalize' });
  assert.equal(category.provider, 'google');
  assert.equal(category.model, hourly.model);
  assert.equal(article.execution.version, 'article-execution-v2');
  assert.notEqual(category.execution.version, article.execution.version);
  const worker = readFileSync(new URL('../apps/worker/src/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /AI_CENTER_ARTICLE_NORMALIZE==='1'/);
  assert.match(worker, /AI_CENTER_READING_HOUR === '1'/);
  assert.match(worker, /candidatePort:categoryMaterials\.candidates/);
  treeCatalog(JSON.parse(readFileSync(new URL('../config/tags.json', import.meta.url), 'utf8')));
});

test('category blocks render bullets and article links', () => {
  function createElement(tag) {
    const element = {
      tag,
      className: '',
      textContent: '',
      hidden: false,
      children: [],
      parentElement: null,
      append(...nodes) {
        for (const child of nodes) {
          if (child) child.parentElement = this;
          this.children.push(child);
        }
      },
      replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
      },
    };
    Object.defineProperty(element, 'href', { writable: true, value: '' });
    return element;
  }
  globalThis.document = { createElement };
  const slot = createElement('section');
  paintHourlyCategory(slot, {
    categories: [{
      id: 'ai',
      label: 'AI',
      inputCount: 1,
      truncated: true,
      status: 'ready',
      events: [{ bullet: '模型公布新接口。', links: [{ sourceId: 'feed:abc', href: '#article/feed:abc' }] }],
    }],
  });
  assert.equal(slot.children[0].children[0].textContent, 'AI');
  assert.equal(slot.children[0].children[0].children[0].textContent, '1');
  assert.match(slot.children[0].children[0].children[1].textContent, /材料已截断/);
  const bullet = slot.children[0].children[1].children[0].children[0];
  assert.equal(bullet.textContent, '模型公布新接口。');
  assert.equal(bullet.children[0].href, '#article/feed:abc');
  assert.equal(bullet.children[0].textContent, '原文');
  assert.equal(bullet.children[0].parentElement.className, 'hourly-category-bullet');
  assert.equal(elementsByClass(slot, 'hourly-category-links').length, 0);
  const mixed = createElement('section');
  paintHourlyCategory(mixed, {
    status: 'ready',
    categories: [
      {
        id: '__untagged__',
        label: '待标注',
        inputCount: 31,
        events: [{
          bullet: '出口民调显示双方均无清晰的执政途径。',
          links: [{ href: '#article/feed:x' }, { href: '#article/feed:y' }],
        }],
      },
      {
        id: 'ai',
        label: 'AI',
        inputCount: 5,
        events: [{ bullet: '先看这条。', links: [{ href: '#article/feed:a' }] }],
      },
    ],
  });
  assert.equal(mixed.children[0].children[0].textContent, 'AI');
  assert.equal(mixed.children[0].children[0].children[0].textContent, '5');
  assert.equal(mixed.children[1].tag, 'details');
  assert.equal(mixed.children[1].open, false);
  assert.match(mixed.children[1].className, /is-untagged/);
  assert.equal(mixed.children[1].children[0].textContent, '还没归类 · 31');
  assert.equal(mixed.children[1].children[0].children.length, 0);
  const pills = elementsByClass(mixed.children[1], 'hourly-category-link');
  assert.deepEqual(pills.map((pill) => pill.textContent), ['原文 1', '原文 2']);
  assert.equal(pills[0].parentElement.className, 'hourly-category-bullet');
  const empty = createElement('section');
  paintHourlyCategory(empty, null);
  assert.equal(empty.children[0].textContent, '分类小时报尚未生成');
  const quiet = createElement('section');
  paintHourlyCategory(quiet, { status: 'ready', categories: [] });
  assert.equal(quiet.hidden, false);
  assert.equal(quiet.children[0].textContent, '本小时暂无入料');
});

test('hourly category observe log records comparison fields and does not add a model call', async () => {
  const edition = {
    workspaceId: 'local',
    window: { startAt: hour, endAt: hour + HOUR },
    status: 'ready',
    untaggedCount: 1,
    categories: [
      { inputCount: 3, truncated: false, status: 'ready' },
      { inputCount: 1, truncated: true, status: 'ready' },
    ],
  };
  const line = formatHourlyCategoryObserveLog({
    workspaceId: 'local',
    hourStart: hour,
    edition,
    startedAt: 1_000,
    finishedAt: 1_125,
    treeExists: true,
    treeStatus: 'ready',
  });
  assert.match(line, /^\[worker\] hourly-category-observe /);
  assert.match(line, /workspaceId=local/);
  assert.match(line, new RegExp(`hourStart=${hour}`));
  assert.match(line, /flag=on/);
  assert.match(line, /materialCount=4/);
  assert.match(line, /bucketCount=2/);
  assert.match(line, /untaggedCount=1/);
  assert.match(line, /untaggedRatio=0\.250/);
  assert.match(line, /flashCallCount=2/);
  assert.match(line, /categoryDurationMs=125/);
  assert.match(line, /status=ready/);
  assert.match(line, /treeEdition=ready/);
  assert.match(line, /truncatedBuckets=1/);
  assert.equal(line.includes('\n'), false);
  const empty = formatHourlyCategoryObserveLog({
    hourStart: hour,
    edition: { status: 'ready', categories: [], untaggedCount: 0 },
  });
  assert.match(empty, /status=empty/);
  assert.match(empty, /flashCallCount=0/);
  assert.match(empty, /untaggedRatio=0\.000/);
  assert.match(empty, /treeEdition=missing/);
  const failed = formatHourlyCategoryObserveLog({ hourStart: hour, error: new Error('分类简报失败') });
  assert.match(failed, /status=error/);
  assert.match(failed, /message=分类简报失败/);
  assert.match(failed, /flashCallCount=0/);

  const lines = [];
  let calls = 0;
  const off = await runHourlyCategoryAlongside({
    env: {},
    hourStarts: [hour],
    hourlyCategory: { async generateHour() { calls += 1; return edition; } },
    log: (row) => lines.push(row),
  });
  assert.deepEqual(off, []);
  assert.equal(calls, 0);
  assert.deepEqual(lines, []);

  let published = 0;
  const on = await runHourlyCategoryAlongside({
    env: { AI_CENTER_HOURLY_CATEGORY: '1' },
    workspaceId: 'local',
    hourStarts: [hour],
    digests: [{ window: { startAt: hour }, status: 'ready' }],
    treeService: { published() { published += 1; return { status: 'failed' }; } },
    hourlyCategory: { async generateHour() { calls += 1; return edition; } },
    log: (row) => lines.push(row),
    now: () => 2_000,
  });
  assert.equal(calls, 1);
  assert.equal(published, 0);
  assert.equal(on.length, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /flag=on/);
  assert.match(lines[0], /treeEdition=ready/);
  assert.match(lines[0], /flashCallCount=2/);

  lines.length = 0;
  const missed = await runHourlyCategoryAlongside({
    env: { AI_CENTER_HOURLY_CATEGORY: '1' },
    workspaceId: 'local',
    hourStarts: [hour],
    treeService: { published() { published += 1; return { status: 'partial' }; } },
    hourlyCategory: { async generateHour() { throw new Error('save failed'); } },
    log: (row) => lines.push(row),
    now: () => 3_000,
  });
  assert.deepEqual(missed, []);
  assert.equal(published, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /status=error/);
  assert.match(lines[0], /treeEdition=partial/);
  assert.match(lines[0], /message=save_failed/);
});

function elementText(element, found = []) {
  if (!element?.children?.length && element?.textContent) found.push(element.textContent);
  for (const child of element?.children || []) elementText(child, found);
  return found;
}

function elementsByClass(element, className, found = []) {
  if (String(element?.className || '').split(/\s+/).includes(className)) found.push(element);
  for (const child of element?.children || []) elementsByClass(child, className, found);
  return found;
}

test('dual-run hourly page shows both sections only when the flag is on', () => {
  function createElement(tag) {
    const element = {
      tag,
      className: '',
      textContent: '',
      hidden: false,
      children: [],
      parentElement: null,
      append(...nodes) {
        for (const child of nodes) {
          if (child) child.parentElement = this;
          this.children.push(child);
        }
      },
      replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
      },
    };
    Object.defineProperty(element, 'href', { writable: true, value: '' });
    return element;
  }
  globalThis.document = { createElement };
  const edition = {
    categories: [{
      id: 'macro',
      label: '宏观',
      inputCount: 1,
      status: 'ready',
      events: [{ bullet: '利率维持不变。', links: [{ sourceId: 'media:story', href: '#article/media:story' }] }],
    }],
  };
  const flagged = createElement('div');
  const day = createElement('p');
  day.className = 'news-day-label';
  day.textContent = '今天';
  const tree = createElement('p');
  tree.className = 'reading-block';
  tree.textContent = '信息树里的这一小时';
  flagged.append(day, tree);
  const laid = layoutHourlyDual(flagged, { enabled: true });
  paintHourlyCategory(laid.categorySlot, edition);
  assert.deepEqual(elementsByClass(flagged, 'hourly-dual-label').map((item) => item.textContent), ['展开看信息树这一小时', '类目小时']);
  assert.equal(elementsByClass(flagged, 'hourly-dual-tree')[0].open, false);
  const lead = elementsByClass(flagged, 'hourly-category-lead')[0];
  assert.equal(lead.textContent, '按方向整理好了，先看要点');
  assert.equal(lead.hidden, false);
  assert.equal(flagged.children[0].textContent, '今天');
  assert.equal(elementText(elementsByClass(flagged, 'hourly-dual-tree')[0]).includes('信息树里的这一小时'), true);
  assert.equal(elementsByClass(flagged, 'hourly-category-bullet')[0].textContent, '利率维持不变。');
  const link = elementsByClass(flagged, 'hourly-category-link')[0];
  assert.equal(link.href, '#article/media:story');
  assert.equal(link.textContent, '原文');

  const pending = createElement('div');
  const kept = createElement('p');
  kept.textContent = '树侧仍在';
  pending.append(kept);
  const pendingLayout = layoutHourlyDual(pending, { enabled: true });
  paintHourlyCategory(pendingLayout.categorySlot, null);
  assert.equal(elementText(pending).includes('树侧仍在'), true);
  assert.equal(elementText(pending).includes('分类小时报尚未生成'), true);
  assert.equal(elementsByClass(pending, 'hourly-category-lead')[0].hidden, true);
  assert.equal(elementsByClass(pending, 'hourly-dual-label').length, 2);

  const plain = createElement('div');
  const only = createElement('p');
  only.className = 'reading-block';
  only.textContent = '这一小时没有条目';
  plain.append(only);
  const unchanged = layoutHourlyDual(plain, { enabled: false });
  assert.equal(unchanged.categorySlot, null);
  assert.equal(plain.children.length, 1);
  assert.equal(plain.children[0].textContent, '这一小时没有条目');
  assert.equal(elementsByClass(plain, 'hourly-dual-label').length, 0);
  assert.equal(elementText(plain).includes('信息树小时'), false);
  assert.equal(elementText(plain).includes('类目小时'), false);

  const live = createElement('div');
  const row = createElement('p');
  row.textContent = '集合里的树';
  live.append(row);
  const bag = live.children;
  live.children = { length: bag.length, *[Symbol.iterator]() { yield* bag; } };
  layoutHourlyDual(live, { enabled: true });
  assert.deepEqual(elementsByClass(live, 'hourly-dual-label').map((item) => item.textContent), ['展开看信息树这一小时', '类目小时']);
  assert.equal(elementText(live).includes('集合里的树'), true);
});
