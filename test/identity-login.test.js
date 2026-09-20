import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentityService, resolveLoginCredential } from '../packages/domain/src/identity-service.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

function memoryRepository() {
  const devices = [];
  const behaviors = [];
  return {
    devices,
    behaviors,
    authorizeToken() { return null; },
    createPairingCode() { return { code: '123456', expiresAt: Date.now() + 60_000 }; },
    redeemPairingCode() { return null; },
    issueDevice(deviceName) {
      const device = { id: `dev-${devices.length + 1}`, name: deviceName, pairedAt: 1, lastSeenAt: 1, revokedAt: null };
      const token = `token-${device.id}`;
      devices.push({ device, token });
      return { device, token };
    },
    revokeDevice() { return false; },
    listDevices() { return []; },
    recordBehavior(name, deviceId, metadata) { behaviors.push({ name, deviceId, metadata }); },
    getMetrics() { return {}; },
  };
}

test('resolveLoginCredential stays off unless both env fields exist', () => {
  assert.equal(resolveLoginCredential({}), null);
  assert.equal(resolveLoginCredential({ AI_CENTER_LOGIN_USERNAME: 'owner' }), null);
  assert.deepEqual(resolveLoginCredential({
    AI_CENTER_LOGIN_USERNAME: ' owner ',
    AI_CENTER_LOGIN_PASSWORD: 'secret-pass',
  }), { username: 'owner', password: 'secret-pass' });
});

test('password login issues the same device grant as pairing', () => {
  const repository = memoryRepository();
  const identity = createIdentityService({
    identityRepository: repository,
    loginCredential: { username: 'owner', password: 'secret-pass' },
  });
  assert.equal(identity.loginAvailable(), true);
  assert.equal(identity.loginWithPassword({
    username: 'owner', password: 'wrong', deviceName: '测试设备',
  }).reason, 'invalid');
  const result = identity.loginWithPassword({
    username: 'owner', password: 'secret-pass', deviceName: '测试设备',
  });
  assert.equal(result.ok, true);
  assert.equal(result.device.name, '测试设备');
  assert.equal(repository.behaviors[0].metadata.source, 'password');
});

test('password login stays disabled without instance credentials', () => {
  const identity = createIdentityService({ identityRepository: memoryRepository() });
  assert.equal(identity.loginAvailable(), false);
  assert.equal(identity.loginWithPassword({
    username: 'owner', password: 'secret-pass', deviceName: '测试设备',
  }).reason, 'disabled');
});

test('HTTP password login issues a device cookie and never becomes desktop', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-login-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    loginCredential: { username: 'owner', password: 'secret-pass' },
  });
  const address = await app.listen();
  try {
    const unpaired = await fetch(`${address.localUrl}/api/v1/session`, {
      headers: { Host: 'phone.example', 'CF-Connecting-IP': '203.0.113.20' },
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert.equal(unpaired.status, 401);
    assert.equal(unpaired.body.loginAvailable, true);

    const denied = await fetch(`${address.localUrl}/api/v1/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'nope', deviceName: '测试手机' }),
    });
    assert.equal(denied.status, 401);

    const publicHeaders = { Host: 'center.example.com', 'CF-Connecting-IP': '203.0.113.21' };
    const login = await fetch(`${address.localUrl}/api/v1/session/login`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'secret-pass', deviceName: '测试手机' }),
    });
    assert.equal(login.status, 201);
    const cookies = typeof login.headers.getSetCookie === 'function'
      ? login.headers.getSetCookie()
      : [login.headers.get('set-cookie')];
    const cookie = cookies.find((line) => String(line).startsWith('ai_center_device='))?.split(';')[0];
    assert.ok(cookie);
    const session = await fetch(`${address.localUrl}/api/v1/session`, {
      headers: { ...publicHeaders, Cookie: cookie },
    }).then((response) => response.json());
    assert.equal(session.role, 'device');
    const posts = await fetch(`${address.localUrl}/api/v1/posts`, {
      headers: { ...publicHeaders, Cookie: cookie },
    });
    assert.equal(posts.status, 200);
    const runtime = await fetch(`${address.localUrl}/api/v1/runtime`, {
      headers: { ...publicHeaders, Cookie: cookie },
    });
    assert.equal(runtime.status, 403);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP password login is off when credentials are missing', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-login-off-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    loginCredential: null,
  });
  const address = await app.listen();
  try {
    const session = await fetch(`${address.localUrl}/api/v1/session`).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    assert.equal(session.status, 200);
    assert.equal(session.body.role, 'desktop');

    const unpaired = await fetch(`${address.localUrl}/api/v1/session`, {
      headers: { Host: 'phone.example', 'CF-Connecting-IP': '203.0.113.22' },
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert.equal(unpaired.status, 401);
    assert.equal(unpaired.body.loginAvailable, false);

    const login = await fetch(`${address.localUrl}/api/v1/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'secret-pass', deviceName: '测试手机' }),
    });
    assert.equal(login.status, 503);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
