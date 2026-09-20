import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { escapeFts5MatchQuery } from '../packages/database/src/fts-query.js';

test('FTS match queries quote tokens so hyphens are not syntax', () => {
  assert.equal(escapeFts5MatchQuery('non-autoregressive LLM gatekeeper'), '"non-autoregressive" "LLM" "gatekeeper"');
  assert.equal(escapeFts5MatchQuery('GPU-driven C++ R&D'), '"GPU-driven" "C++" "R&D"');
  assert.equal(escapeFts5MatchQuery('say "quoted" term'), '"say" "quoted" "term"');
  assert.equal(escapeFts5MatchQuery('   '), '');
});

test('knowledge search accepts hyphenated model queries without FTS column errors', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-fts-'));
  const store = createStore(path.join(directory, 'ai-center.db'));
  try {
    const document = store.repositories.knowledge.createDocument({
      workspaceId: 'local',
      title: 'System One',
      body: 'A non-autoregressive gatekeeper can do structured output classification with calibrated probability.',
      createdByType: 'user',
      metadata: {},
    });
    assert.doesNotThrow(() => store.repositories.knowledge.search('local', 'non-autoregressive LLM gatekeeper'));
    assert.doesNotThrow(() => store.repositories.knowledge.search('local', 'structured output classification calibrated probability'));
    const hits = store.repositories.knowledge.search('local', 'non-autoregressive');
    assert.equal(hits[0].knowledgeId, document.id);
    assert.doesNotThrow(() => store.repositories.knowledge.search('local', 'GPU-driven C++'));
    assert.equal(store.repositories.knowledge.search('local', 'GPU-driven C++').length, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
