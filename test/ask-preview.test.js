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

  const marked = new Database(databasePath);
  marked.prepare('UPDATE ai_sessions SET preview = ? WHERE id = ?').run(
    '# 标题\n> 引用\n保留 snake_case、a > b、#1，以及 **加粗**、__下划线__、~~删除~~ 和 *斜体*',
    run.sessionId,
  );
  marked.close();
  const kept = createStore(databasePath);
  assert.equal(
    kept.repositories.knowledge.getSession('local', run.sessionId).preview,
    '标题 引用 保留 snake_case、a > b、#1，以及 加粗、下划线、删除 和 斜体',
  );
  kept.close();

  const emoji = createStore(databasePath);
  const clipped = emoji.repositories.knowledge.recordAgentRun({
    jobId: 'job-emoji',
    workspaceId: 'local',
    message: '表情',
    answer: `${'字'.repeat(179)}😀尾巴`,
    providerId: 'fake',
    modelId: 'fake',
  });
  assert.equal(emoji.repositories.knowledge.getSession('local', clipped.sessionId).preview, `${'字'.repeat(179)}😀…`);
  emoji.close();
  rmSync(directory, { recursive: true, force: true });
});
