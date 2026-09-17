import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  StructuredArtifactSchema,
  TaxonomyCatalogSchema,
  TaxonomyKeySchema,
  parseContract,
  parseCreateInspirationFromRunInput,
  parseCreateKnowledgeFromRunInput,
  ValidationError,
} from '../packages/contracts/src/index.js';
import { createStore } from '../packages/database/src/index.js';
import { legacyTaxonomyBootstrapNodes, taxonomySeedNodes } from '../packages/database/src/taxonomy-seed.js';
import { createKnowledgeService } from '../packages/domain/src/knowledge-service.js';
import {
  compileStructuredArtifact,
  extractJsonObject,
  sanitizeStructuredArtifact,
} from '../packages/domain/src/structured-artifact.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';

function temporaryStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-taxonomy-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    directory,
    store,
    remove() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('taxonomy keys reject uuid and underscore forms', () => {
  assert.equal(parseContract(TaxonomyKeySchema, 'industry.semiconductor.memory'), 'industry.semiconductor.memory');
  assert.throws(() => parseContract(TaxonomyKeySchema, 'asset_class.equity'), ValidationError);
  assert.throws(() => parseContract(TaxonomyKeySchema, 'industry'), ValidationError);
});

test('instance taxonomy default is neutral and V16 seed is explicitly legacy', () => {
  const catalog = TaxonomyCatalogSchema.parse(JSON.parse(
    readFileSync(path.join('config', 'taxonomy.default.json'), 'utf8'),
  ));
  assert.ok(catalog.nodes.some((node) => node.key === 'domain.general'));
  assert.equal(catalog.nodes.some((node) => node.key.startsWith('topic.graphics.')), false);
  assert.throws(() => TaxonomyCatalogSchema.parse({
    version: 1,
    nodes: [{
      key: 'topic.child', name: 'Child', parentKey: 'topic.missing', description: '', sortOrder: 1,
    }],
  }));
  assert.deepEqual(taxonomySeedNodes(), legacyTaxonomyBootstrapNodes());
  assert.ok(legacyTaxonomyBootstrapNodes().some((node) => node.key === 'topic.graphics.runtime.hybridclr'));
});

test('structured artifact forbids extra source refs and duplicate primary in one dimension', () => {
  const valid = parseContract(StructuredArtifactSchema, {
    schemaVersion: 1,
    target: 'knowledge',
    title: 'HBM扩产如何影响传统DRAM景气度',
    contentType: 'mechanism',
    bodyMarkdown: '## 核心结论\n产能迁移。',
    taxonomy: [
      { key: 'domain.investment', primary: true, confidence: 0.99 },
      { key: 'lens.business-cycle', primary: true, confidence: 0.98 },
    ],
  });
  assert.equal(valid.taxonomy.length, 2);
  assert.throws(() => parseContract(StructuredArtifactSchema, {
    schemaVersion: 1,
    target: 'knowledge',
    title: '标题',
    contentType: 'mechanism',
    bodyMarkdown: '正文',
    taxonomy: [
      { key: 'lens.business-cycle', primary: true },
      { key: 'lens.supply-chain', primary: true },
    ],
  }), ValidationError);
  assert.throws(() => parseCreateInspirationFromRunInput({ runId: '' }), ValidationError);
  assert.equal(parseCreateKnowledgeFromRunInput({ runId: 'run-1' }).instruction, '');
});

test('compiler drops unknown keys, falls back to parent, and keeps one proposal', async () => {
  const temporary = temporaryStore();
  const catalog = temporary.store.repositories.knowledge.listTaxonomy('local');
  const artifact = sanitizeStructuredArtifact({
    title: 'Nanite 可见性',
    contentType: 'architecture',
    bodyMarkdown: '## 机制\n基于现有讨论。',
    taxonomy: [
      { key: 'topic.graphics.gpu-driven.visibility-virtual-geometry.nanite', primary: true, confidence: 0.9 },
      { key: 'lens.architecture', primary: true, confidence: 0.95 },
    ],
    taxonomyProposals: [{
      dimension: 'topic',
      key: 'topic.graphics.gpu-driven.visibility-virtual-geometry.nanite',
      name: 'Nanite',
      parentKey: 'topic.graphics.gpu-driven.visibility-virtual-geometry',
      reason: '现有分类无法表达 Nanite',
    }],
  }, { target: 'knowledge', catalog });
  assert.equal(artifact.contentType, 'thesis');
  assert.ok(artifact.taxonomy.some((item) => item.key === 'topic.graphics.gpu-driven.visibility-virtual-geometry'));
  assert.ok(artifact.taxonomy.some((item) => item.key === 'lens.architecture' && item.primary));
  assert.throws(() => sanitizeStructuredArtifact({
    title: '回执',
    contentType: 'hypothesis',
    bodyMarkdown: '已落库。\n\n- **去向**：灵感\n- **分类路径**：投资研究',
  }, { target: 'inspiration', catalog }), /落库回执/);
  assert.equal(artifact.taxonomyProposals[0].key, 'topic.graphics.gpu-driven.visibility-virtual-geometry.nanite');
  assert.equal(extractJsonObject('```json\n{"title":"ok"}\n```').title, 'ok');

  let calls = 0;
  const compiled = await compileStructuredArtifact({
    catalog,
    target: 'inspiration',
    sourceText: 'HBM 可能造成传统 DRAM 景气外溢',
    generateText: async ({ repair }) => {
      calls += 1;
      if (!repair) return 'not-json';
      return JSON.stringify({
        schemaVersion: 1,
        target: 'inspiration',
        title: '传统DRAM可能进入景气外溢',
        contentType: 'hypothesis',
        bodyMarkdown: '## 核心想法\nHBM 占用产能。',
        taxonomy: [{ key: 'industry.semiconductor.memory', primary: true, confidence: 0.99 }],
        taxonomyProposals: [],
      });
    },
  });
  assert.equal(calls, 2);
  assert.equal(compiled.contentType, 'hypothesis');
  temporary.remove();
});

test('seed taxonomy stays near one hundred nodes and search can filter by key', () => {
  const temporary = temporaryStore();
  const knowledge = temporary.store.repositories.knowledge;
  const nodes = knowledge.listTaxonomy('local');
  assert.equal(nodes.length, taxonomySeedNodes().length);
  assert.ok(nodes.length >= 90 && nodes.length <= 120);
  assert.ok(nodes.some((node) => node.key === 'market.cn-a'));
  assert.ok(nodes.some((node) => node.key === 'asset-class.equity'));
  const document = knowledge.createDocument({
    workspaceId: 'local',
    title: '存储景气',
    body: '观察价格、库存与产能',
    createdByType: 'user',
    knowledgeType: 'framework',
    metadata: {},
  });
  knowledge.replaceResourceTaxonomy({
    workspaceId: 'local',
    resourceType: 'knowledge',
    resourceId: document.id,
    assignments: [
      { key: 'market.cn-a', primary: true, confidence: 1 },
      { key: 'lens.business-cycle', primary: true, confidence: 1 },
      { key: 'industry.semiconductor.memory', primary: true, confidence: 1 },
    ],
  });
  assert.equal(knowledge.search('local', {
    query: '观察价格',
    taxonomy: ['market.cn-a', 'lens.business-cycle'],
  })[0].knowledgeId, document.id);
  assert.equal(knowledge.search('local', {
    taxonomy: ['platform.unity'],
  }).length, 0);
  temporary.remove();
});

test('structured persist writes inspiration taxonomy without copying source refs into the body', () => {
  const temporary = temporaryStore();
  const service = createKnowledgeService({
    legacyRepository: temporary.store,
    knowledgeRepository: temporary.store.repositories.knowledge,
  });
  const run = temporary.store.repositories.knowledge.recordAgentRun({
    jobId: 'job-structure-1',
    workspaceId: 'local',
    message: 'HBM 怎么影响 DRAM',
    answer: 'HBM 扩产可能挤占传统 DRAM 产能。',
    providerId: 'fake',
    modelId: 'fake',
    refs: [{
      resourceType: 'knowledge-revision',
      resourceId: 'doc-1',
      revision: 1,
      asOf: null,
      label: '旧笔记',
      origin: 'selected',
    }],
  });
  const output = service.persistStructuredArtifact({
    workspaceId: 'local',
    sourceRunId: run.id,
    artifact: {
      schemaVersion: 1,
      target: 'inspiration',
      title: '传统DRAM可能进入景气外溢阶段',
      contentType: 'hypothesis',
      bodyMarkdown: '## 核心想法\nHBM持续占用头部产能。',
      taxonomy: [{ key: 'industry.semiconductor.memory', primary: true, confidence: 0.99 }],
      taxonomyProposals: [],
    },
  });
  const note = temporary.store.getNote(output.resourceId);
  assert.equal(note.sourceType, 'ai-run');
  assert.equal(note.sourceId, run.id);
  const sessionSaved = service.persistStructuredArtifact({
    workspaceId: 'local',
    sourceType: 'ai-session',
    sourceId: run.sessionId,
    artifact: {
      schemaVersion: 1,
      target: 'knowledge',
      title: '会话沉淀',
      contentType: 'thesis',
      bodyMarkdown: '## 结论\n来自整段对话。',
      taxonomy: [{ key: 'domain.investment', primary: true, confidence: 0.9 }],
      taxonomyProposals: [],
    },
  });
  assert.equal(sessionSaved.resourceType, 'knowledge');
  assert.equal(temporary.store.listKnowledge()[0].source, 'ai-session');
  assert.equal(service.deleteDocument('local', sessionSaved.resourceId), true);
  assert.equal(temporary.store.listKnowledge().length, 0);
  assert.equal(note.inspirationType, 'hypothesis');
  assert.doesNotMatch(note.body, /doc-1/);
  assert.equal(output.taxonomy[0].name, '存储');
  temporary.remove();
});

test('structure worker job compiles an AI run into knowledge', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-structure-job-'));
  const store = createStore(path.join(directory, 'ai-center.db'));
  const run = store.repositories.knowledge.recordAgentRun({
    jobId: 'job-run',
    workspaceId: 'local',
    message: 'HBAO 为什么用 horizon angle',
    answer: 'HBAO 用 horizon angle 估计遮蔽。',
    providerId: 'fake',
    modelId: 'fake',
  });
  const payload = JSON.stringify({
    schemaVersion: 1,
    target: 'knowledge',
    title: 'HBAO 为什么使用 horizon angle',
    contentType: 'mechanism',
    bodyMarkdown: '## 核心结论\n用 horizon angle 估计遮蔽。',
    taxonomy: [
      { key: 'domain.graphics-engine', primary: true, confidence: 0.99 },
      { key: 'topic.graphics.ambient-occlusion.hbao', primary: true, confidence: 0.99 },
      { key: 'lens.mechanism', primary: true, confidence: 0.97 },
    ],
    taxonomyProposals: [],
  });
  const worker = createAiCenterWorker({
    store,
    workerId: 'structure-test-worker',
    agentClient: {
      async respond() {
        return { text: payload, providerId: 'fake', modelId: 'fake', warnings: [] };
      },
    },
  });
  try {
    const job = store.createJob({
      type: 'knowledge.from-run',
      input: { target: 'knowledge', workspaceId: 'local', sourceRunId: run.id, instruction: '' },
      maxAttempts: 1,
    });
    const completed = await worker.runner.runOnce();
    assert.equal(completed.id, job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.contentType, 'mechanism');
    assert.equal(store.repositories.knowledge.getCurrentRevision('local', completed.output.resourceId).title,
      'HBAO 为什么使用 horizon angle');
  } finally {
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
