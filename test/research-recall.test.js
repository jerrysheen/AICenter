import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ARTICLE_VALIDATOR_VERSION } from '../packages/contracts/src/information-tree.js';
import { createResearchRelevanceJudge } from '../packages/runtime/src/research-judges.js';
import { createResearchRecallJobHandlers } from '../packages/runtime/src/research-recall-module.js';
import { createStore } from '../packages/database/src/index.js';
import { applyResearchAddition, loadResearchCatalog, projectResearchTags } from '../packages/domain/src/research-catalog.js';
import { compareRecallMethods, scoreRecallByStratum, splitLabeledSet } from '../packages/domain/src/research-eval.js';
import { createResearchRecallService } from '../packages/domain/src/research-recall-service.js';

const START = 1_700_000_000_000;
const DAY = 86_400_000;
const root = new URL('../', import.meta.url);

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function serviceFor(store, judges = {}, options = {}) {
  const calls = { tag: 0, relevance: 0, tagPayloads: [], relevancePayloads: [] };
  const service = createResearchRecallService({
    repository: store.repositories.research,
    feedRepository: store.repositories.feed,
    mediaRepository: store.repositories.media,
    informationRepository: store.repositories.informationTree,
    modelId: 'research-mock',
    now: () => options.now?.() ?? START,
    batchSize: options.batchSize ?? 8,
    tagJudge: judges.tagJudge || (async (payload) => {
      calls.tag += 1;
      calls.tagPayloads.push(payload);
      return { assignments: payload.items.map((item) => ({ resourceId: item.resourceId, tagIds: [] })) };
    }),
    relevanceJudge: judges.relevanceJudge || (async (payload) => {
      calls.relevance += 1;
      calls.relevancePayloads.push(payload);
      return { results: payload.items.map((item) => ({ resourceId: item.resourceId, verdict: 'irrelevant' })) };
    }),
  });
  return { service, calls };
}

function keywordJudge(calls) {
  return {
    tagJudge: async (payload) => {
      calls.tag += 1;
      calls.tagPayloads.push(payload);
      return {
        assignments: payload.items.map((item) => {
          const blob = `${item.title}\n${item.text}\n${item.body || ''}`;
          const tagIds = payload.tags.filter((tag) => [...tag.keywords, ...tag.aliases].some((term) => term && blob.includes(term))).map((tag) => tag.id);
          return { resourceId: item.resourceId, tagIds: blob.includes('天气') ? [...tagIds, 'not_a_tag'] : tagIds };
        }),
      };
    },
    relevanceJudge: async (payload) => {
      calls.relevance += 1;
      calls.relevancePayloads.push(payload);
      return {
        results: payload.items.map((item) => {
          const blob = `${item.title}\n${item.text}\n${item.body || ''}`;
          if (!item.bodyIncluded && item.bodyAvailable) return { resourceId: item.resourceId, verdict: 'insufficient' };
          if (blob.includes('错位') || (item.bodyIncluded && blob.includes('订单'))) return { resourceId: item.resourceId, verdict: 'direct' };
          return { resourceId: item.resourceId, verdict: 'irrelevant' };
        }),
      };
    },
  };
}

function saveNode(store, sourceId, eventAt, title, text, extra = {}) {
  const version = sha(JSON.stringify({ sourceId, eventAt, title, text, body: extra.body || '', sourceVersion: extra.sourceVersion || '' }));
  const node = {
    title, text, tagId: extra.tagId ?? null,
    id: `i:${version}`, layer: 'information', version,
    children: [], articleIds: [sourceId], sourceId,
    window: { startAt: eventAt, endAt: eventAt + 1 },
    generatedAt: eventAt, eventAt,
    sourceVersion: extra.sourceVersion || version,
    sourceUpdatedAt: extra.sourceUpdatedAt || eventAt,
    ...(extra.body ? { body: extra.body, formatVersion: ARTICLE_VALIDATOR_VERSION } : {}),
  };
  store.repositories.informationTree.saveNode('local', node);
  store.repositories.informationTree.setInformationHead('local', node, 'policy');
  return node;
}

function tinyCatalog(lookback = 0) {
  return {
    id: 'sample_direction',
    version: '1',
    tags: [{
      id: 'order_adoption', name: '订单与采用', definition: '材料写明订单或采用发生了变化。', include: '订单上调或下调。',
      exclude: '只出现公司名称时不要打这个标签。', keywords: ['订单'], aliases: [], enabled: true,
    }],
    questions: [{
      id: 'sample_question', version: '1', objective: '组织订单变化，材料不足时结论为尚不能判断。',
      subquestions: [{ id: 'demand', text: '订单发生了什么变化？', tagIds: ['order_adoption'], queries: [{ phrase: 'HBM', aliases: [], entities: [] }] }],
      queries: [], historyLookbackMs: lookback, evidence: '材料不足时结论为尚不能判断。',
    }],
  };
}

test('research catalog keeps definitions, rejects conclusion tags, and detects content changes', () => {
  const catalog = loadResearchCatalog(JSON.parse(readFileSync(new URL('./config/research/ai-compute.json', root), 'utf8')));
  const projected = projectResearchTags(catalog.tags);
  assert.equal(catalog.questions[0].subquestions.length, 3);
  assert.ok(projected.every((tag) => tag.definition && tag.include && tag.exclude));
  assert.throws(() => loadResearchCatalog({ ...catalog, tags: [{ ...catalog.tags[0], name: '行业逻辑破坏' }] }), /预设结论/);
  assert.throws(() => loadResearchCatalog({
    ...catalog,
    questions: [{ ...catalog.questions[0], subquestions: [{ ...catalog.questions[0].subquestions[0], tagIds: ['missing_tag'] }] }],
  }), /不存在/);
  const same = applyResearchAddition(catalog, { kind: 'research-addition', version: 'label-only', tags: [], questions: [] });
  assert.equal(same.contentHash, catalog.contentHash);
  const changed = applyResearchAddition(catalog, {
    kind: 'research-addition', version: catalog.version,
    tags: [{ ...catalog.tags[0], exclude: `${catalog.tags[0].exclude}补充边界。` }], questions: [],
  });
  assert.notEqual(changed.contentHash, catalog.contentHash);
  assert.notEqual(changed.tags[0].definitionHash, catalog.tags[0].definitionHash);
  assert.equal(changed.tags[1].definitionHash, catalog.tags[1].definitionHash);
  const added = applyResearchAddition(catalog, JSON.parse(readFileSync(new URL('./config/research/optical-export.json', root), 'utf8')));
  assert.ok(added.questions.some((question) => question.id === 'optical_export_conditions'));
  assert.ok(added.tags.some((tag) => tag.id === 'overseas_orders' && tag.exclude.includes('不要打这个标签')));
});

test('material pool pages past 500 feed and media rows and keeps the snapshot', () => {
  const store = createStore(':memory:');
  store.repositories.informationTree.activatePolicy('local', 'policy');
  const { service } = serviceFor(store);
  const window = { startAt: START, endAt: START + DAY };
  for (let index = 0; index < 520; index += 1) {
    store.repositories.feed.saveContentItem({
      id: `feed-${index}`, workspaceId: 'local', originType: 'manual', contentType: 'note',
      title: `feed ${index}`, summary: '摘要', publishedAt: START + index,
    });
    store.repositories.media.upsertEntry({
      workspaceId: 'local', externalId: `media-${index}`, sourceKey: 'example', publisherKey: 'example', channel: 'tech',
      canonicalUrl: `https://example.com/m/${index}`, title: `media ${index}`, summary: '媒体摘要', publishedAt: START + index,
      contentLevel: 'summary_only', contentHash: 'h', revision: 1, status: 'indexed', observedAt: START + index,
      createdAt: START + index, updatedAt: START + index,
    });
  }
  store.repositories.media.saveBriefProcessing('local', 'media-0', '', 'failed', 'prepare', START);
  store.repositories.feed.saveContentItem({
    id: 'outside', workspaceId: 'local', originType: 'manual', contentType: 'note', title: '窗外', summary: '不在窗口', publishedAt: START + DAY,
  });
  saveNode(store, 'info:inside', START + 5, '节点', '窗口内的信息节点');
  const first = service.freezePool({ window });
  const members = store.repositories.research.listMembers('local', first.poolId);
  assert.equal(members.filter((member) => member.originType === 'content-item' && member.lane === 'unprepared').length, 520);
  assert.equal(members.filter((member) => member.originType === 'media-index').length, 520);
  assert.equal(members.filter((member) => member.lane === 'information').length, 1);
  assert.equal(members.filter((member) => member.lane === 'prepare-failed').length, 1);
  assert.equal(new Set(members.map((member) => `${member.originType}:${member.originId}`)).size, members.length);
  assert.ok(!members.some((member) => member.originId === 'outside'));
  store.repositories.feed.saveContentItem({
    id: 'feed-later', workspaceId: 'local', originType: 'manual', contentType: 'note', title: '后写入', summary: '新材料', publishedAt: START + 8,
  });
  assert.equal(store.repositories.research.listMembers('local', first.poolId).length, members.length);
  const second = service.freezePool({ window });
  assert.notEqual(second.poolId, first.poolId);
  assert.equal(store.repositories.research.listMembers('local', second.poolId).length, members.length + 1);
});

test('question recall reuses old materials, caches stable inputs, and keeps published reports', async () => {
  const store = createStore(':memory:');
  const tree = store.repositories.informationTree;
  tree.activatePolicy('local', 'policy');
  const calls = { tag: 0, relevance: 0, tagPayloads: [], relevancePayloads: [] };
  const { service } = serviceFor(store, keywordJudge(calls));
  const window = { startAt: START, endAt: START + DAY };
  const catalog = loadResearchCatalog(JSON.parse(readFileSync(new URL('./config/research/ai-compute.json', root), 'utf8')));
  service.activate({ catalog });
  const columnNode = saveNode(store, 'info:orders', START + 1, '存储供应', '订单上调', { tagId: 'tech_column' });
  saveNode(store, 'info:capacity', START + 2, '存储供应', '产能下降');
  saveNode(store, 'info:hbm', START + 3, '简讯', 'HBM');
  saveNode(store, 'info:shift', START + 4, '观察', '观察窗口出现错位');
  saveNode(store, 'info:name', START + 5, '名称', '英伟达');
  saveNode(store, 'info:weather', START + 6, '天气', '今日天气晴好');
  saveNode(store, 'info:body', START + 7, '摘要', '摘要不足', { body: '披露了新的HBM订单' });
  saveNode(store, 'info:directory', START + 8, '名录', '欧洲运营商把该厂商写入供应商名录。');
  saveNode(store, 'info:history', START - 3_600_000, '历史订单', '此前已有订单');
  saveNode(store, 'info:missing', START + 9, '缺正文', 'needs_content');
  store.repositories.feed.saveContentItem({
    id: 'capex', workspaceId: 'local', originType: 'manual', contentType: 'note', title: '数据中心资本开支上调', summary: '建设增加', publishedAt: START + 10,
  });
  store.repositories.media.upsertEntry({
    workspaceId: 'local', externalId: 'permit', sourceKey: 'example', publisherKey: 'example', channel: 'tech',
    canonicalUrl: 'https://example.com/permit', title: '出口许可名单更新', summary: '准入变化', publishedAt: START + 11,
    contentLevel: 'summary_only', contentHash: 'p', revision: 1, status: 'indexed', observedAt: START + 11, createdAt: START + 11, updatedAt: START + 11,
  });
  store.repositories.media.saveBriefProcessing('local', 'permit', '', 'failed', 'prepare', START);
  store.repositories.tagging.saveTaggings({
    workspaceId: 'local', resourceType: 'content-item', resourceId: 'capex', tags: ['technology'],
    tagCatalogVersion: 'column', promptVersion: 'tag_v1', model: '', truncatedForModel: false,
  });
  const first = await service.buildReport({ questionId: 'ai_compute_changes', window, budget: { maxRequests: 50, maxMilliseconds: 60_000 } });
  assert.equal(first.status, 'partial');
  assert.match(first.statusNote, /部分覆盖/);
  assert.doesNotMatch(first.statusNote, /完整覆盖/);
  assert.match(first.coverage.note, /不是召回率/);
  assert.ok(first.coverage.judged > 0 && first.coverage.judged !== first.coverage.recalled);
  assert.equal(first.coverage.missingBody, 1);
  assert.equal(first.coverage.unprepared, 1);
  assert.equal(first.coverage.prepareFailed, 1);
  assert.equal(first.states.definitionLoaded.contentHash, first.states.reportUsed.contentHash);
  assert.notEqual(first.states.windowBackfill.status, first.contentHash);
  const packed = JSON.stringify(first.pack);
  assert.ok(!packed.includes('供应商名录'));
  assert.ok(first.pack.events.some((event) => event.title === '简讯' && event.hits.query.includes('HBM') && !event.hits.tag.length && event.bucket === 'unverified'));
  assert.ok(first.pack.events.some((event) => event.title === '观察' && event.hits.relevance.includes('direct') && !event.hits.tag.length && !event.hits.query.length));
  assert.ok(first.pack.events.some((event) => event.title === '名称' && event.hits.query.includes('英伟达') && !event.hits.tag.length));
  assert.ok(first.pack.events.some((event) => event.origins.length === 2 && event.hits.tag.includes('order_adoption') && event.hits.tag.includes('capacity_delivery')));
  assert.ok(first.relations.some((relation) => relation.type === 'co-occurrence' && relation.note.includes('因果关系')));
  assert.ok(first.relations.some((relation) => relation.type === 'conflict'));
  assert.ok(first.pack.buckets.background.length > 0);
  assert.ok(first.pack.events.some((event) => event.origins.some((origin) => origin.type === 'content-item' && origin.id === 'capex')));
  assert.ok(first.pack.events.some((event) => event.origins.some((origin) => origin.type === 'media-index' && origin.id === 'permit')));
  assert.ok(calls.tagPayloads.some((payload) => payload.items.some((item) => item.body.includes('披露了新的HBM订单') && item.bodyIncluded)));
  assert.ok(calls.tagPayloads.some((payload) => payload.items.some((item) => item.resourceId && !item.bodyIncluded && item.body === '')));
  assert.ok(calls.relevancePayloads.some((payload) => payload.items.some((item) => item.title === '天气') && payload.items.some((item) => item.title === '简讯')));
  assert.ok(!calls.relevancePayloads.some((payload) => payload.items.some((item) => item.title === '缺正文')));
  assert.ok(first.coverage.discardedTagIds.includes('not_a_tag'));
  assert.equal(tree.getNode('local', columnNode.id).tagId, 'tech_column');
  assert.deepEqual(store.repositories.tagging.getTagging('local', 'content-item', 'capex').tags, ['technology']);
  const tagCalls = calls.tag;
  const second = await service.buildReport({ questionId: 'ai_compute_changes', window, budget: { maxRequests: 50, maxMilliseconds: 60_000 } });
  assert.equal(calls.tag, tagCalls);
  assert.equal(second.id, first.id);
  assert.equal(second.usage.requests, first.usage.requests);
  const order = catalog.tags.find((tag) => tag.id === 'order_adoption');
  const { definitionHash, ...orderFields } = order;
  service.activate({ addition: { kind: 'research-addition', version: catalog.version, tags: [{ ...orderFields, exclude: `${order.exclude}补充边界。` }], questions: [] } });
  const redefined = await service.buildReport({ questionId: 'ai_compute_changes', window, budget: { maxRequests: 50, maxMilliseconds: 60_000 } });
  assert.notEqual(redefined.contentHash, first.contentHash);
  assert.equal(redefined.labelVersion, catalog.version);
  assert.ok(calls.tagPayloads.at(-1).tags.some((tag) => tag.id === 'order_adoption' && tag.exclude.includes('补充边界')));
  assert.equal(store.repositories.research.getReport('local', first.id).contentHash, first.contentHash);
  const beforeUnrelated = calls.tag;
  service.activate({
    addition: {
      kind: 'research-addition', version: 'extra',
      tags: [{ id: 'weather_note', name: '天气记录', definition: '材料只记录天气事实。', include: '气温或降水。', exclude: '没有天气事实不要打标。', keywords: ['气温'], aliases: [], enabled: true }],
      questions: [],
    },
  });
  await service.buildReport({ questionId: 'ai_compute_changes', window, budget: { maxRequests: 50, maxMilliseconds: 60_000 } });
  assert.equal(calls.tag, beforeUnrelated);
  const optical = JSON.parse(readFileSync(new URL('./config/research/optical-export.json', root), 'utf8'));
  service.activate({ addition: optical });
  const next = await service.buildReport({ questionId: 'optical_export_conditions', window, budget: { maxRequests: 50, maxMilliseconds: 60_000 } });
  assert.notEqual(next.releaseId, first.releaseId);
  assert.equal(store.repositories.research.getReport('local', first.id).releaseId, first.releaseId);
  assert.ok(calls.tagPayloads.some((payload) => payload.tags.some((tag) => tag.id === 'overseas_orders' && tag.exclude.includes('没有订单、名录或导入事实'))));
  assert.ok(next.pack.events.some((event) => event.origins.length && JSON.stringify(event.facts).includes('供应商名录') && event.hits.tag.includes('overseas_orders')));
  assert.ok(next.judgmentSnapshot.some((row) => row.key === 'overseas_orders' && row.status === 'succeeded'));
  const reloaded = createResearchRecallService({
    repository: store.repositories.research, feedRepository: store.repositories.feed, mediaRepository: store.repositories.media,
    informationRepository: store.repositories.informationTree, tagJudge: keywordJudge(calls).tagJudge, relevanceJudge: keywordJudge(calls).relevanceJudge, modelId: 'research-mock', now: () => START,
  });
  assert.equal(reloaded.pin('local').contentHash, next.contentHash);
});

test('budget, rate limit, retry and inflight do not drop rows or repeat a finished call', async () => {
  const store = createStore(':memory:');
  store.repositories.informationTree.activatePolicy('local', 'policy');
  saveNode(store, 'info:a', START + 1, '甲', '订单甲');
  saveNode(store, 'info:b', START + 2, '乙', '订单乙');
  saveNode(store, 'info:old', START - DAY, '旧', '历史订单');
  let tagCalls = 0;
  const failing = serviceFor(store, {
    tagJudge: async () => { tagCalls += 1; throw Object.assign(new Error('limited'), { code: 'rate-limit', status: 429 }); },
    relevanceJudge: async (payload) => ({ results: payload.items.map((item) => ({ resourceId: item.resourceId, verdict: 'irrelevant' })) }),
  }, { batchSize: 1 });
  failing.service.activate({ catalog: tinyCatalog(DAY) });
  const limited = await failing.service.buildReport({ questionId: 'sample_question', window: { startAt: START, endAt: START + DAY }, budget: { maxRequests: 10, maxMilliseconds: 60_000 } });
  assert.equal(limited.coverage.stoppedReason, 'rate-limit');
  assert.equal(limited.coverage.failed, 1);
  assert.equal(tagCalls, 1);
  const skipped = await failing.service.buildReport({ questionId: 'sample_question', window: { startAt: START, endAt: START + DAY }, budget: { maxRequests: 10, maxMilliseconds: 60_000 } });
  assert.equal(tagCalls, 2);
  assert.ok(skipped.judgmentSnapshot.some((row) => row.status === 'failed'));
  await failing.service.buildReport({ questionId: 'sample_question', window: { startAt: START, endAt: START + DAY }, budget: { maxRequests: 10, maxMilliseconds: 60_000 }, retryFailed: true });
  assert.ok(tagCalls > 2);

  const budgetStore = createStore(':memory:');
  budgetStore.repositories.informationTree.activatePolicy('local', 'policy');
  saveNode(budgetStore, 'info:a', START + 1, '甲', '订单甲');
  saveNode(budgetStore, 'info:b', START + 2, '乙', '订单乙');
  saveNode(budgetStore, 'info:old', START - DAY, '旧', '历史订单');
  const budgeted = serviceFor(budgetStore, {}, { batchSize: 8 });
  budgeted.service.activate({ catalog: tinyCatalog(DAY) });
  const partial = await budgeted.service.buildReport({ questionId: 'sample_question', window: { startAt: START, endAt: START + DAY }, budget: { maxRequests: 1, maxMilliseconds: 60_000 } });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.coverage.stoppedReason, 'budget-requests');
  assert.doesNotMatch(partial.statusNote, /完整覆盖/);
  assert.ok(partial.coverage.pending > 0);
  assert.ok(partial.coverage.historyNotStarted > 0);
  assert.equal(partial.usage.cost, null);

  const live = createStore(':memory:');
  live.repositories.informationTree.activatePolicy('local', 'policy');
  saveNode(live, 'info:a', START + 1, '甲', '订单甲');
  let entered;
  let release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  let overlapped = 0;
  const overlap = serviceFor(live, {
    tagJudge: async (payload) => { overlapped += 1; entered(); await hold; return { assignments: payload.items.map((item) => ({ resourceId: item.resourceId, tagIds: [] })) }; },
    relevanceJudge: async (payload) => ({ results: payload.items.map((item) => ({ resourceId: item.resourceId, verdict: 'irrelevant' })) }),
  });
  overlap.service.activate({ catalog: tinyCatalog(0) });
  const firstRun = overlap.service.buildReport({ questionId: 'sample_question', window: { startAt: START, endAt: START + DAY }, budget: { maxRequests: 10, maxMilliseconds: 60_000 } });
  await ready;
  await overlap.service.buildReport({ questionId: 'sample_question', window: { startAt: START, endAt: START + DAY }, budget: { maxRequests: 10, maxMilliseconds: 60_000 } });
  assert.equal(overlapped, 1);
  release();
  await firstRun;
  await overlap.service.buildReport({ questionId: 'sample_question', window: { startAt: START, endAt: START + DAY }, budget: { maxRequests: 10, maxMilliseconds: 60_000 } });
  assert.equal(overlapped, 1);
});

test('a running report keeps its pinned catalog when a newer release is activated', async () => {
  const store = createStore(':memory:');
  store.repositories.informationTree.activatePolicy('local', 'policy');
  saveNode(store, 'info:a', START + 1, '甲', '订单甲');
  const { service } = serviceFor(store, {
    tagJudge: async (payload) => {
      const current = service.pin('local');
      const tag = current.catalog.tags[0];
      const { definitionHash, ...fields } = tag;
      service.activate({ addition: { kind: 'research-addition', version: 'during-run', tags: [{ ...fields, exclude: `${tag.exclude}运行中改写。` }], questions: [] } });
      return { assignments: payload.items.map((item) => ({ resourceId: item.resourceId, tagIds: [] })) };
    },
  });
  const activated = service.activate({ catalog: tinyCatalog(0) });
  const report = await service.buildReport({ questionId: 'sample_question', window: { startAt: START, endAt: START + DAY }, budget: { maxRequests: 10, maxMilliseconds: 60_000 } });
  assert.equal(report.contentHash, activated.contentHash);
  assert.equal(store.repositories.research.getRun('local', report.runId).contentHash, activated.contentHash);
  assert.notEqual(service.pin('local').contentHash, activated.contentHash);
});

test('checked irrelevant material can conclude that the question cannot yet be judged', async () => {
  const store = createStore(':memory:');
  store.repositories.informationTree.activatePolicy('local', 'policy');
  saveNode(store, 'info:a', START + 1, '天气', '今日天气晴好');
  const { service } = serviceFor(store);
  service.activate({ catalog: tinyCatalog(0) });
  const report = await service.buildReport({ questionId: 'sample_question', window: { startAt: START, endAt: START + DAY }, budget: { maxRequests: 10, maxMilliseconds: 60_000 } });
  assert.equal(report.status, 'ready');
  assert.equal(report.coverage.judged, 1);
  assert.equal(report.coverage.recalled, 0);
  assert.equal(report.conclusion, '尚不能判断。');
  assert.match(report.coverage.note, /不是召回率/);
});

test('query keywords do not become tag hits, and recall metrics stay split', async () => {
  const store = createStore(':memory:');
  store.repositories.informationTree.activatePolicy('local', 'policy');
  saveNode(store, 'info:a', START + 1, '订单标题', '只出现订单两个字');
  const { service } = serviceFor(store, {
    tagJudge: async (payload) => ({ assignments: payload.items.map((item) => ({ resourceId: item.resourceId, tagIds: [] })) }),
    relevanceJudge: async (payload) => ({ results: payload.items.map((item) => ({ resourceId: item.resourceId, verdict: 'irrelevant' })) }),
  });
  service.activate({ catalog: tinyCatalog(0) });
  const report = await service.buildReport({ questionId: 'sample_question', window: { startAt: START, endAt: START + DAY }, budget: { maxRequests: 10, maxMilliseconds: 60_000 } });
  const event = report.pack.events[0];
  assert.deepEqual(event.hits.tag, []);
  assert.ok(event.hits.query.includes('订单'));
  assert.equal(event.bucket, 'unverified');
  assert.equal(report.sections[0].supporting.length, 0);
  const labels = [
    { id: 'a', role: 'debug', stratum: 'random', direct: true },
    { id: 'b', role: 'holdout', stratum: 'hard', direct: true, gapReason: 'tag-miss' },
    { id: 'c', role: 'holdout', stratum: 'random', background: true },
    { id: 'd', role: 'holdout', stratum: 'hard', direct: false },
  ];
  const split = splitLabeledSet(labels);
  assert.equal(split.debug.length, 1);
  assert.equal(split.holdout.length, 3);
  const scored = compareRecallMethods(split.holdout, { oldTag: ['d'], newTag: ['c'], tagQueryUnion: ['c'], jev: [] });
  assert.equal(scored.newTag.hard.directRecall, 0);
  assert.equal(scored.newTag.hard.majorMisses[0].gapReason, 'tag-miss');
  assert.equal(scored.newTag.random.directRecall, null);
  assert.equal(scored.oldTag.hard.falseHit, 1);
  assert.equal(scoreRecallByStratum(labels, []).all.directRecall, 0);
  const judge = createResearchRelevanceJudge({ async evaluate() { return { answers: { research_relevance: { results: [{ resourceId: 'a', score: 0.9 }] } }, model: 'jev-test', usage: {} }; } });
  const parsed = await judge.judge({ question: { objective: '问题' }, items: [{ resourceId: 'a' }] });
  assert.equal(parsed.results[0].verdict, '');
  const handlers = createResearchRecallJobHandlers(service);
  assert.equal(typeof handlers['research.report.generate'], 'function');
  assert.equal(typeof handlers['research.catalog.activate'], 'function');
});
