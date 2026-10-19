import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { loadResearchCatalog } from '../packages/domain/src/research-catalog.js';
import { createResearchRecallService } from '../packages/domain/src/research-recall-service.js';
import { createBambooStartLuxClient } from '../packages/connectors/src/bamboo-startlux.js';
import { createTypeSafeSystemOneClient } from '../packages/connectors/src/typesafe-system-one.js';
import { openClassificationClient } from '../packages/domain/src/classification-provider.js';
import { openJevClient } from '../packages/domain/src/jev-enabled.js';
import { createResearchRelevanceJudge, createResearchTagJudge } from '../packages/runtime/src/research-judges.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'data', 'research-recall');
const isolatedPath = path.join(outputDir, 'isolated.sqlite');
const START = Date.parse('2026-10-01T00:00:00Z');

function keywordJudges() {
  return {
    tagJudge: async (payload) => ({
      assignments: payload.items.map((item) => {
        const blob = `${item.title}\n${item.text}\n${item.body || ''}`;
        return {
          resourceId: item.resourceId,
          tagIds: payload.tags.filter((tag) => [...tag.keywords, ...tag.aliases].some((term) => term && blob.includes(term))).map((tag) => tag.id),
        };
      }),
    }),
    relevanceJudge: async (payload) => ({
      results: payload.items.map((item) => {
        const blob = `${item.title}\n${item.text}\n${item.body || ''}`;
        if (!item.bodyIncluded && item.bodyAvailable) return { resourceId: item.resourceId, verdict: 'insufficient' };
        if (/订单|产能|认证|许可|名录/.test(blob)) return { resourceId: item.resourceId, verdict: 'direct' };
        return { resourceId: item.resourceId, verdict: 'irrelevant' };
      }),
    }),
  };
}

function seedSynthetic(store) {
  store.repositories.informationTree.activatePolicy('local', 'research-recall-isolated');
  const rows = [
    ['info:order', '云厂商上调HBM订单', '客户订单增加'],
    ['info:capacity', '封装产能爬坡', '交付能力变化'],
    ['info:directory', '供应商名录', '欧洲运营商把该厂商写入供应商名录。'],
    ['info:name', '公司名', '英伟达'],
  ];
  for (const [index, row] of rows.entries()) {
    const [sourceId, title, text] = row;
    const version = `synthetic-${index}`.padEnd(64, '0');
    const node = {
      title, text, tagId: null, id: `i:${version}`, layer: 'information', version, children: [], articleIds: [sourceId], sourceId,
      window: { startAt: START + index, endAt: START + index + 1 }, generatedAt: START, eventAt: START + index, sourceVersion: version, sourceUpdatedAt: START,
    };
    store.repositories.informationTree.saveNode('local', node);
    store.repositories.informationTree.setInformationHead('local', node, 'research-recall-isolated');
  }
  return { copied: rows.length, source: 'synthetic', skipped: 0 };
}

function copyProduction(store, databasePath) {
  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  let rows = [];
  try {
    rows = source.prepare(`SELECT h.event_at, n.value_json FROM information_tree_information_heads h
      JOIN information_tree_nodes n ON n.workspace_id=h.workspace_id AND n.id=h.node_id
      WHERE h.workspace_id='local' ORDER BY h.event_at DESC LIMIT 200`).all();
  } finally { source.close(); }
  store.repositories.informationTree.activatePolicy('local', 'research-recall-isolated');
  let copied = 0;
  let skipped = 0;
  for (const row of rows.reverse()) {
    try {
      const node = JSON.parse(row.value_json);
      if (node.layer !== 'information') { skipped += 1; continue; }
      store.repositories.informationTree.saveNode('local', node);
      store.repositories.informationTree.setInformationHead('local', node, 'research-recall-isolated');
      copied += 1;
    } catch { skipped += 1; }
  }
  return { copied, skipped, source: 'production-readonly', available: rows.length };
}

function recalledFacts(report) {
  return (report.pack?.events || []).map((event) => ({
    title: event.title,
    facts: event.facts,
    bucket: event.bucket,
    hits: event.hits,
    origins: event.origins,
  }));
}

const catalog = loadResearchCatalog(JSON.parse(readFileSync(path.join(root, 'config', 'research', 'ai-compute.json'), 'utf8')));
const addition = JSON.parse(readFileSync(path.join(root, 'config', 'research', 'optical-export.json'), 'utf8'));
mkdirSync(outputDir, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(`${isolatedPath}${suffix}`, { force: true });
const store = createStore(isolatedPath);
const productionPath = resolveInstanceConfig({ repositoryRoot: root }).databasePath;
let material = { copied: 0, skipped: 0, source: 'synthetic' };
try {
  if (productionPath && productionPath !== isolatedPath) material = copyProduction(store, productionPath);
} catch (error) {
  material = { ...seedSynthetic(store), copyError: String(error.message || error) };
}
if (!material.copied) material = seedSynthetic(store);
const times = [];
let cursor = null;
for (;;) {
  const page = store.repositories.informationTree.listInformationInWindow('local', { startAt: 0, endAt: Date.now() + 86_400_000 }, { limit: 200, cursor });
  times.push(...page);
  if (page.length < 200) break;
  cursor = { eventAt: page.at(-1).eventAt, sourceId: page.at(-1).sourceId };
}
const nodes = times;
const eventTimes = nodes.map((node) => node.eventAt).filter((value) => Number.isInteger(value));
const window = eventTimes.length
  ? { startAt: Math.min(...eventTimes), endAt: Math.max(...eventTimes) + 1 }
  : { startAt: START, endAt: START + 86_400_000 };
const judges = keywordJudges();
const service = createResearchRecallService({
  repository: store.repositories.research,
  feedRepository: store.repositories.feed,
  mediaRepository: store.repositories.media,
  informationRepository: store.repositories.informationTree,
  ...judges,
  modelId: 'research-mock',
});
service.activate({ catalog });
const first = await service.buildReport({ questionId: 'ai_compute_changes', window, budget: { maxRequests: 400, maxMilliseconds: 120_000 } });
service.activate({ addition });
const second = await service.buildReport({ questionId: 'optical_export_conditions', window, budget: { maxRequests: 400, maxMilliseconds: 120_000 } });
const firstFacts = new Set(recalledFacts(first).flatMap((event) => event.origins.map((origin) => `${origin.type}:${origin.id}`)));
const recovered = recalledFacts(second).filter((event) => event.origins.some((origin) => !firstFacts.has(`${origin.type}:${origin.id}`)) || event.hits.tag.includes('overseas_orders'));
let live = { status: '未执行', reason: '没有设置 AI_CENTER_RESEARCH_RECALL_LIVE=1，或分类客户端不可用。模拟调用不能当作实测。' };
if (process.env.AI_CENTER_RESEARCH_RECALL_LIVE === '1') {
  const client = openClassificationClient(process.env, {
    typesafeClient: openJevClient(process.env, undefined, (options) => createTypeSafeSystemOneClient(options)),
    createBamboo: (options) => createBambooStartLuxClient(options),
  });
  if (!client?.available()) live = { status: '未执行', reason: '分类客户端不可用，未改用其他模型。' };
  else {
    const liveService = createResearchRecallService({
      repository: store.repositories.research,
      feedRepository: store.repositories.feed,
      mediaRepository: store.repositories.media,
      informationRepository: store.repositories.informationTree,
      tagJudge: createResearchTagJudge(client),
      relevanceJudge: createResearchRelevanceJudge(client),
      modelId: client.modelId,
    });
    const started = Date.now();
    try {
      const report = await liveService.buildReport({
        questionId: 'optical_export_conditions', window,
        budget: { maxRequests: Number(process.env.AI_CENTER_RESEARCH_RECALL_LIVE_REQUESTS || 4), maxMilliseconds: 60_000 },
      });
      live = { status: report.status, requests: report.usage.requests, inputTokens: report.usage.inputTokens, outputTokens: report.usage.outputTokens, cost: report.usage.cost, elapsedMs: Date.now() - started, model: report.usage.model };
    } catch (error) {
      live = { status: '失败', reason: String(error.message || error), elapsedMs: Date.now() - started };
    }
  }
}
let productionWindow = null;
try {
  const source = new Database(productionPath, { readonly: true, fileMustExist: true });
  productionWindow = {
    feed: source.prepare(`SELECT COUNT(*) AS count FROM content_items WHERE workspace_id='local' AND COALESCE(published_at, created_at)>=? AND COALESCE(published_at, created_at)<?`).get(window.startAt, window.endAt).count,
    media: source.prepare(`SELECT COUNT(*) AS count FROM media_index_entries WHERE workspace_id='local' AND COALESCE(published_at, observed_at)>=? AND COALESCE(published_at, observed_at)<?`).get(window.startAt, window.endAt).count,
  };
  source.close();
} catch { productionWindow = null; }
const summary = {
  material,
  productionWindow,
  nodeCount: nodes.length,
  window,
  mock: true,
  first: { id: first.id, status: first.status, contentHash: first.contentHash, coverage: first.coverage, usage: first.usage, states: first.states },
  second: { id: second.id, status: second.status, contentHash: second.contentHash, releaseId: second.releaseId, coverage: second.coverage, usage: second.usage, states: second.states },
  recovered: recovered.slice(0, 8).map((event) => ({ title: event.title, bucket: event.bucket, hits: event.hits, origins: event.origins })),
  live,
  note: '已检查数量不是召回率。生产调度未启用。',
};
writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  source: material.source,
  nodes: nodes.length,
  firstStatus: first.status,
  secondRelease: second.releaseId,
  recovered: recovered.length,
  live: live.status,
  summary: path.join('data', 'research-recall', 'summary.json'),
}, null, 2));
