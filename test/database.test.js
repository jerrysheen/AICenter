import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { backfillAiRunQuestions } from '../packages/database/src/migrations.js';

test('pairing is one-time and device authorization persists', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-db-'));
  const databasePath = path.join(directory, 'test.db');
  const store = createStore(databasePath);
  const pairing = store.createPairingCode(10);
  assert.ok(pairing.pairToken.length >= 40);
  assert.equal(store.redeemPairingCode(pairing.code, '公网错误尝试', { requireSecret: true }), null);
  const redeemed = store.redeemPairingCode(pairing.code, '测试手机');
  assert.ok(redeemed);
  assert.equal(store.redeemPairingCode(pairing.code, '第二台手机'), null);
  assert.equal(store.authorizeToken(redeemed.token).name, '测试手机');
  store.close();

  const reopened = createStore(databasePath);
  assert.equal(reopened.authorizeToken(redeemed.token).name, '测试手机');
  reopened.close();
  rmSync(directory, { recursive: true, force: true });
});

test('posts and behavior metrics are persisted', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-db-'));
  const store = createStore(path.join(directory, 'test.db'));
  const pairing = store.createPairingCode(10);
  const { device } = store.redeemPairingCode(pairing.code, '测试手机');
  const post = store.createPost({ title: '手机发布', body: '可行性测试', sourceUrl: '', tags: ['测试'] }, device.id);
  store.recordBehavior('post.created', device.id, { postId: post.id });
  store.recordBehavior('post.opened', device.id, { postId: post.id });
  assert.equal(store.getPost(post.id).title, '手机发布');
  assert.equal(store.getMetrics().published, 1);
  assert.equal(store.getMetrics().detailsOpened, 1);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('inspiration notes archive into knowledge', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-note-'));
  const store = createStore(path.join(directory, 'test.db'));
  const plain = store.createNote({ body: '只记一句，不要回复', wantAi: false });
  assert.equal(plain.aiReply, '');
  const shared = store.createNote({
    body: '从系统分享进入的原文',
    wantAi: false,
    sourceType: 'external-share',
    sourceUrl: 'https://example.com/story',
    sourceTitle: '来源标题',
    captureChannel: 'harmony-share',
    sourceApp: 'com.example.browser',
    clientMutationId: 'harmony-test-1',
    capturedAt: 1_700_000_000_000,
  });
  assert.equal(store.getNote(shared.id).sourceUrl, 'https://example.com/story');
  assert.equal(store.getNote(shared.id).captureChannel, 'harmony-share');
  assert.equal(store.getNote(shared.id).sourceApp, 'com.example.browser');
  assert.equal(store.getNote(shared.id).capturedAt, 1_700_000_000_000);
  assert.equal(store.createNote({ body: '重复重试', clientMutationId: 'harmony-test-1' }).id, shared.id);
  assert.equal(store.listNotes('all').filter((note) => note.clientMutationId === 'harmony-test-1').length, 1);
  const sketched = store.createNote({ body: '这条需要一点思路', wantAi: true });
  assert.match(sketched.aiReply, /下一步/);
  const archived = store.archiveNote(sketched.id);
  assert.equal(archived.status, 'archived');
  assert.equal(store.listNotes('inbox').length, 2);
  assert.equal(store.listKnowledge()[0].source, 'inspiration');
  assert.equal(store.repositories.knowledge.listRevisions(archived.knowledgeId)[0].revision, 1);
  assert.equal(store.repositories.knowledge.search('local', '需要一点思路')[0].knowledgeId, archived.knowledgeId);
  const later = store.createNote({ body: '后写的一条', wantAi: false });
  store.pinNote(later.id);
  const inbox = store.listNotes('inbox');
  assert.equal(inbox[0].id, later.id);
  assert.equal(inbox[0].pinned, true);
  assert.equal(store.deleteNote(plain.id), true);
  assert.equal(store.listNotes('inbox').length, 2);
  assert.equal(store.repositories.knowledge.listSessions('local').sessions[0].kind, 'inspiration');
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('empty ai-run questions are restored from the original job input', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-ask-backfill-'));
  const databasePath = path.join(directory, 'test.db');
  const store = createStore(databasePath);
  const job = store.createJob({ type: 'ai.agent.run', input: { message: '我的提问原文' }, maxAttempts: 1 });
  const run = store.repositories.knowledge.recordAgentRun({
    jobId: job.id, workspaceId: 'local', message: '', answer: '模型回答',
    providerId: 'fake', modelId: 'fake',
  });
  assert.equal(run.inputText, '');
  store.close();

  const database = new Database(databasePath);
  database.prepare('UPDATE ai_runs SET input_text = \'\' WHERE id = ?').run(run.id);
  backfillAiRunQuestions(database);
  assert.equal(database.prepare('SELECT input_text FROM ai_runs WHERE id = ?').get(run.id).input_text, '我的提问原文');
  assert.equal(database.prepare('SELECT title FROM ai_sessions WHERE id = ?').get(run.sessionId).title, '我的提问原文');
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
