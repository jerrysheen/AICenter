import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createKnowledgeService } from '../packages/domain/src/knowledge-service.js';
import { createLocalKnowledgeFiles, parseKnowledgeFrontMatter } from '../packages/connectors/src/local-knowledge-files.js';
import { formatToolBudgetNote } from '../packages/runtime/src/agent-runtime.js';

const TECH_GROWTH_FIXTURE = `---
id: finance.framework.tech_growth
type: framework
domain: finance
tags:
  - AI
  - 科技成长
version: 1
---

# 科技成长公司分析框架

## Analysis Chain

Demand → Product → Revenue → Margin → Cash Flow

## Preferred Signal

ARR growth with improving retention and disciplined valuation.
`;

function createKnowledgeFixture(parentDirectory) {
  const rootDirectory = path.join(parentDirectory, 'knowledge');
  const frameworkDirectory = path.join(rootDirectory, 'finance', 'frameworks');
  mkdirSync(frameworkDirectory, { recursive: true });
  writeFileSync(path.join(frameworkDirectory, 'tech-growth-company.md'), TECH_GROWTH_FIXTURE);
  return rootDirectory;
}

test('file knowledge front matter requires a dotted semantic id', () => {
  assert.equal(parseKnowledgeFrontMatter('# no yaml'), null);
  assert.equal(parseKnowledgeFrontMatter('---\nid: Not-Valid\n---\n# X\n'), null);
  const parsed = parseKnowledgeFrontMatter(`---
id: finance.framework.tech_growth
type: framework
tags:
  - AI
version: 1
---

# Title
`);
  assert.equal(parsed.id, 'finance.framework.tech_growth');
  assert.deepEqual(parsed.tags, ['AI']);
});

test('local knowledge files search and get the tech growth framework without exposing paths', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-knowledge-framework-'));
  try {
    const files = createLocalKnowledgeFiles({ rootDirectory: createKnowledgeFixture(directory) });
    const hits = files.search({ query: '分析一家高增长AI公司的商业质量和估值', limit: 5 });
    assert.equal(hits[0].knowledgeId, 'finance.framework.tech_growth');
    assert.match(hits[0].snippet, /科技成长/);
    const encoded = JSON.stringify(hits);
    assert.doesNotMatch(encoded, /tech-growth-company\.md/);
    assert.doesNotMatch(encoded, /knowledge[/\\]finance/);

    const doc = files.get('finance.framework.tech_growth');
    assert.match(doc.body, /## Analysis Chain/);
    assert.doesNotMatch(JSON.stringify(doc), /tech-growth-company\.md/);
    assert.equal(files.get('missing.id'), null);
    const listed = files.list({ limit: 8 });
    assert.equal(listed[0].knowledgeId, 'finance.framework.tech_growth');
    assert.equal(listed[0].kind, 'framework');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('file knowledge adapter stays inside the given root', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-knowledge-'));
  mkdirSync(path.join(directory, 'finance'));
  writeFileSync(path.join(directory, 'finance', 'sample.md'), `---
id: finance.concepts.arr
type: concept
domain: finance
tags:
  - ARR
---

# ARR

ARR = current recurring revenue run-rate annualized
`);
  writeFileSync(path.join(directory, 'README.md'), '# ignore me\nARR secret');
  try {
    const files = createLocalKnowledgeFiles({ rootDirectory: directory });
    const hits = files.search({ query: 'ARR' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].knowledgeId, 'finance.concepts.arr');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('knowledge service merges file hits ahead of sqlite documents', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-knowledge-svc-'));
  const knowledgeDirectory = createKnowledgeFixture(directory);
  const store = createStore(path.join(directory, 'test.db'));
  store.repositories.knowledge.createDocument({
    workspaceId: 'local',
    title: 'ARR 备忘',
    body: '这里也提到 ARR。',
    createdByType: 'user',
    metadata: {},
  });
  const service = createKnowledgeService({
    legacyRepository: store,
    knowledgeRepository: store.repositories.knowledge,
    fileKnowledgePort: createLocalKnowledgeFiles({ rootDirectory: knowledgeDirectory }),
  });
  try {
    const hits = service.search('local', 'ARR', 8);
    assert.equal(hits[0].knowledgeId, 'finance.framework.tech_growth');
    const current = service.getCurrentRevision('local', 'finance.framework.tech_growth');
    assert.match(current.body, /Preferred Signal/);
    assert.equal(current.revision, 1);
    const mentions = service.listMentions('local', '', 8);
    assert.equal(mentions[0].resourceType, 'knowledge-revision');
    assert.equal(mentions[0].resourceId, 'finance.framework.tech_growth');
    assert.equal(mentions[0].kind, 'framework');
    assert.equal(JSON.stringify(mentions).includes('tech-growth-company.md'), false);
    const filtered = service.listMentions('local', '科技成长', 8);
    assert.equal(filtered[0].resourceId, 'finance.framework.tech_growth');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('knowledge mention API lists local frameworks without pairing on loopback', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-mention-'));
  const knowledgeDirectory = createKnowledgeFixture(directory);
  const { createAiCenterServer } = await import('../apps/web/src/server.js');
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: path.join(directory, 'data'),
    knowledgeDirectory,
  });
  const address = await app.listen();
  try {
    const empty = await fetch(`${address.localUrl}/api/v1/knowledge/mentions`).then((response) => response.json());
    assert.equal(empty.ok, true);
    assert.equal(empty.items[0].resourceId, 'finance.framework.tech_growth');
    assert.equal(empty.items[0].kind, 'framework');
    const searched = await fetch(`${address.localUrl}/api/v1/knowledge/mentions?q=${encodeURIComponent('科技成长')}`).then((response) => response.json());
    assert.equal(searched.items[0].resourceType, 'knowledge-revision');
    assert.equal(searched.items[0].resourceId, 'finance.framework.tech_growth');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent tool budget note only carries time and remaining budget', () => {
  assert.match(formatToolBudgetNote({
    usedToolCalls: 0, remainingToolCalls: 12, maxToolCalls: 12, maxModelCalls: 7, modelCallCount: 1,
  }), /remaining 12/);
  assert.equal(formatToolBudgetNote({
    usedToolCalls: 0, remainingToolCalls: 12, maxToolCalls: 12, maxModelCalls: 7, modelCallCount: 1,
  }).includes('reusable reasoning context'), false);
});
