import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../packages/database/src/index.js';
import { treeCatalog } from '../packages/domain/src/information-tree-policy.js';
import { resolveHarnessLlm } from '../packages/harness/src/llm-route.js';
import {
  HOURLY_CATEGORY_TASK,
  bucketCategoryItems,
  categorySourceHref,
  createHourlyCategoryService,
  hourlyCategoryEnabled,
  parseCategoryBriefOutput,
  primaryCategoryId,
  projectHourlyCategory,
} from '../packages/domain/src/hourly-category.js';
import {
  REPORT_HOURLY_JOB_TYPE,
  createReportJobHandlers,
  hourlyCategoryHourStarts,
} from '../packages/runtime/src/report-module.js';
import { paintHourlyCategory } from '../apps/web/public/hourly-category-view.js';

const HOUR = 3_600_000;
const hour = 500_000 * HOUR;
const catalog = {
  version: 'tags_v1',
  tags: [
    { id: 'ai', name: 'AI' },
    { id: 'ai_compute', name: 'AI算力' },
    { id: 'macro', name: '宏观' },
  ],
  reading: {
    version: 'tree-reading-v2',
    groupByTag: { ai: 'ai', ai_compute: 'ai', macro: 'macro' },
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
    ['macro', '宏观', ['feed:b']],
    ['__untagged__', '待标注', ['feed:c', 'feed:d', 'feed:e']],
  ]);
  const ids = buckets.flatMap((bucket) => bucket.items.map((row) => row.sourceId));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 5);
  assert.equal(buckets[0].items[0].excerpt.length <= 200, true);
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
});

test('empty closed hour writes a ready edition and does not call Flash', async () => {
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
    assert.equal(edition.status, 'ready');
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
    assert.equal(edition.status, 'partial');
    assert.equal(edition.categories.find((category) => category.id === 'macro').status, 'failed');
    assert.deepEqual(edition.categories.find((category) => category.id === 'macro').events, []);
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
  const on = await createReportJobHandlers({
    reportService: { generateDailyReport() {} },
    informationService: { async generateHourlyDigests() { order.push('tree'); return [digest]; } },
    treeService: {},
    readingHour: { enabled: true, async scoreWindow() { order.push('reading'); return {}; } },
    hourlyCategory: { async generateHour(input) { order.push('category'); categoryCalls.push(input); return { id: `hcat:${input.hourStart}`, status: 'ready' }; } },
    env: { AI_CENTER_HOURLY_CATEGORY: '1' },
  })[REPORT_HOURLY_JOB_TYPE]({ workspaceId: 'local', hourStart: hour }, {});
  assert.deepEqual(order, ['tree', 'reading', 'category']);
  assert.deepEqual(categoryCalls, [{ workspaceId: 'local', hourStart: hour }]);
  assert.deepEqual(on.categoryEditionIds, [`hcat:${hour}`]);

  const failed = [];
  await assert.rejects(createReportJobHandlers({
    reportService: { generateDailyReport() {} },
    informationService: { async generateHourlyDigests() { throw new Error('tree down'); } },
    treeService: {},
    hourlyCategory: { async generateHour(input) { failed.push(input); return { id: 'hcat', status: 'ready' }; } },
    env: { AI_CENTER_HOURLY_CATEGORY: '1' },
  })[REPORT_HOURLY_JOB_TYPE]({ workspaceId: 'local', hourStart: hour }, {}), /tree down/);
  assert.deepEqual(failed, [{ workspaceId: 'local', hourStart: hour }]);
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
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = [...nodes]; },
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
  assert.match(slot.children[0].children[0].children[0].textContent, /材料已截断/);
  assert.equal(slot.children[0].children[1].children[0].children[0].textContent, '模型公布新接口。');
  assert.equal(slot.children[0].children[1].children[0].children[1].children[0].href, '#article/feed:abc');
  const empty = createElement('section');
  paintHourlyCategory(empty, null);
  assert.equal(empty.children[0].textContent, '分类小时报尚未生成');
});
