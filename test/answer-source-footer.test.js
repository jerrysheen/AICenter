import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createKnowledgeService } from '../packages/domain/src/knowledge-service.js';
import { projectAnswerSourceFooter } from '../packages/domain/src/answer-source-footer.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

test('answer source footer dedupes tool hits, keeps selected, and drops unknown types', () => {
  const footer = projectAnswerSourceFooter([
    { resourceType: 'content-item', resourceId: 'a', origin: 'tool', label: '帖 A' },
    { resourceType: 'content-item', resourceId: 'a', origin: 'selected', label: '你指定的帖' },
    { resourceType: 'web-result', resourceId: 'https://example.com/x', origin: 'tool', label: '公开页' },
    { resourceType: 'unknown', resourceId: 'x', origin: 'tool', label: '丢弃' },
    { resourceType: 'inspiration', resourceId: '', origin: 'tool', label: '空 id' },
  ]);
  assert.equal(footer.total, 2);
  assert.equal(footer.groups[0].id, 'feed');
  assert.equal(footer.groups[0].items[0].origin, 'selected');
  assert.equal(footer.groups[0].items[0].label, '你指定的帖');
  assert.equal(footer.groups[1].id, 'web');
  assert.equal(footer.extraCount, 0);
});

test('answer source footer caps at 24 unique local refs', () => {
  const refs = Array.from({ length: 30 }, (_, index) => ({
    resourceType: 'content-item',
    resourceId: `item-${index}`,
    origin: 'tool',
    label: `帖 ${index}`,
  }));
  const footer = projectAnswerSourceFooter(refs);
  assert.equal(footer.total, 30);
  assert.equal(footer.groups[0].items.length, 24);
  assert.equal(footer.extraCount, 6);
});

test('session detail attaches a source footer from persisted refs', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-footer-'));
  const store = createStore(path.join(directory, 'ai-center.db'));
  const knowledge = createKnowledgeService({
    legacyRepository: store,
    knowledgeRepository: store.repositories.knowledge,
  });
  try {
    const run = knowledge.recordAgentRun({
      jobId: 'job-footer',
      workspaceId: 'local',
      message: '算力',
      answer: '几条社媒',
      providerId: 'fake',
      modelId: 'fake',
      refs: [
        { resourceType: 'content-item', resourceId: 'item-1', revision: null, asOf: 1, label: 'Rubin', origin: 'tool' },
        { resourceType: 'inspiration', resourceId: 'note-1', revision: null, asOf: 1, label: '备忘', origin: 'selected' },
      ],
    });
    const detail = knowledge.getAiSession('local', run.sessionId);
    assert.equal(detail.exchanges[0].sourceFooter.total, 2);
    assert.deepEqual(detail.exchanges[0].sourceFooter.groups.map((group) => group.id), ['feed', 'inspiration']);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('content item and knowledge document can be read for source jumps on loopback', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-footer-api-'));
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory });
  const item = app.store.repositories.feed.saveContentItem({
    workspaceId: 'local',
    originType: 'subscription',
    contentType: 'post',
    title: '昇腾超节点',
    body: 'NPO',
    summary: 'NPO',
    sourceUrl: 'https://x.com/example/status/1',
    authorName: '测试',
    publishedAt: 1,
  });
  const address = await app.listen();
  try {
    const content = await fetch(`${address.localUrl}/api/v1/content-items/${item.id}`).then((response) => response.json());
    assert.equal(content.ok, true);
    assert.equal(content.item.title, '昇腾超节点');
    const document = await fetch(`${address.localUrl}/api/v1/knowledge/documents/${encodeURIComponent('finance.framework.tech_growth')}`)
      .then((response) => response.json());
    assert.equal(document.ok, true);
    assert.equal(document.item.id, 'finance.framework.tech_growth');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
