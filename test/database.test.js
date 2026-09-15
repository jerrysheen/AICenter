import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';

test('pairing is one-time and device authorization persists', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-db-'));
  const databasePath = path.join(directory, 'test.db');
  const store = createStore(databasePath);
  const pairing = store.createPairingCode(10);
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
  const sketched = store.createNote({ body: '这条需要一点思路', wantAi: true });
  assert.match(sketched.aiReply, /下一步/);
  const archived = store.archiveNote(sketched.id);
  assert.equal(archived.status, 'archived');
  assert.equal(store.listNotes('inbox').length, 1);
  assert.equal(store.listKnowledge()[0].source, 'inspiration');
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
