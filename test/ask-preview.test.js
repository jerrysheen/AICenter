import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';

test('ask preview strips markdown before clipping to 180 characters', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-ask-preview-'));
  const databasePath = path.join(directory, 'test.db');
  const store = createStore(databasePath);
  const fence = `\`\`\`\n${'x'.repeat(220)}\n\`\`\`\n正文才是预览`;
  const run = store.repositories.knowledge.recordAgentRun({
    jobId: 'job-preview',
    workspaceId: 'local',
    message: '问题',
    answer: fence,
    providerId: 'fake',
    modelId: 'fake',
  });
  const session = store.repositories.knowledge.getSession('local', run.sessionId);
  assert.match(session.preview, /^正文才是预览/);
  assert.equal(session.preview.includes('```'), false);
  assert.equal(session.preview.includes('xxx'), false);
  store.close();

  const database = new Database(databasePath);
  database.prepare('UPDATE ai_sessions SET preview = ? WHERE id = ?').run('**加粗** 和 `代码`', run.sessionId);
  database.close();
  const again = createStore(databasePath);
  assert.equal(again.repositories.knowledge.getSession('local', run.sessionId).preview, '加粗 和 代码');
  again.close();
  rmSync(directory, { recursive: true, force: true });
});
