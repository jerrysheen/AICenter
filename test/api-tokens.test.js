import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';
import { createApiTokenService, hashApiToken, tokenHashesEqual } from '../packages/domain/src/api-token-service.js';
import { isApiTokenAllowlisted } from '../apps/web/src/http/api-token-access.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function publicHeaders(extra = {}) {
  return {
    'CF-Connecting-IP': '203.0.113.80',
    ...extra,
  };
}

function cookiePair(response) {
  const lines = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : String(response.headers.get('set-cookie') || '').split(/,(?=\s*(?:__Host-)?[A-Za-z0-9_]+=)/);
  const line = lines.find((item) => item.startsWith('ai_center_device='));
  assert.ok(line, 'missing device cookie');
  return line.split(';')[0];
}

function emptyBoard(board = 'overview') {
  return {
    board,
    mode: 'partial',
    fetchedAt: Date.now(),
    session: 'closed',
    note: '',
    groups: [],
    indices: [],
    watchlist: [],
    gainers: [],
    losers: [],
    breadth: { advancers: 0, decliners: 0, unchanged: 0 },
  };
}

test('allowlist is GET-only and leaves admin paths closed', () => {
  assert.equal(tokenHashesEqual(hashApiToken('aic_one'), hashApiToken('aic_one')), true);
  assert.equal(tokenHashesEqual(hashApiToken('aic_one'), hashApiToken('aic_two')), false);
  assert.equal(tokenHashesEqual('aa', 'abcd'), false);

  const allowed = [
    ['GET', '/api/v1/reports/daily/latest'],
    ['GET', '/api/v1/reports/daily/latest/brief'],
    ['GET', '/api/v1/reports/hourly'],
    ['GET', '/api/v1/reports/hourly/search'],
    ['GET', '/api/v1/reports/tree'],
    ['GET', '/api/v1/reports/reading-hour/index'],
    ['GET', '/api/v1/feed/x'],
    ['GET', '/api/v1/feed/media'],
    ['GET', '/api/v1/feed/media/article'],
    ['GET', `/api/v1/content-items/${randomUUID()}`],
    ['GET', '/api/v1/content-items/official/2026-20957'],
    ['GET', '/api/v1/investor-discussion'],
    ['GET', '/api/v1/markets'],
    ['GET', '/api/v1/markets/search'],
    ['GET', '/api/v1/hardware-prices'],
    ['GET', '/api/v1/compute-prices'],
    ['GET', '/api/v1/etf-whale/overview'],
    ['GET', '/api/v1/etf-whale/daily'],
    ['GET', '/api/v1/etf-whale/signals'],
    ['GET', '/api/v1/etf-whale/series'],
    ['GET', '/api/v1/etf-whale/etfs/159915'],
    ['GET', '/api/v1/etf-whale/etfs/abc'],
  ];
  for (const [method, pathName] of allowed) assert.equal(isApiTokenAllowlisted(method, pathName), true, pathName);

  const denied = [
    ['POST', '/api/v1/reports/daily/latest'],
    ['GET', '/api/v1/api-tokens'],
    ['DELETE', `/api/v1/api-tokens/${randomUUID()}`],
    ['GET', '/api/v1/runtime/deploy-status'],
    ['GET', '/api/v1/runtime/access-summary'],
    ['POST', '/api/v1/runtime/client-timing'],
    ['GET', '/api/v1/runtime'],
    ['GET', '/api/v1/devices'],
    ['GET', '/api/v1/holdings'],
    ['GET', '/api/v1/assets/personal'],
    ['GET', '/api/v1/notes'],
    ['GET', '/api/v1/events/stream'],
    ['POST', '/api/v1/posts'],
    ['GET', '/api/v1/feed/media/probe'],
    ['POST', '/api/v1/etf-whale/overview'],
    ['GET', '/api/v1/etf-whale/etfs/159915/shares'],
    ['GET', '/api/v1/etf-whale/sync'],
  ];
  for (const [method, pathName] of denied) assert.equal(isApiTokenAllowlisted(method, pathName), false, pathName);
});

test('tokens are stored as sha256, revoked tokens fail, and logs expire', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-api-token-store-'));
  const store = createStore(path.join(directory, 'ai-center.db'));
  let clock = 1_700_000_000_000;
  const service = createApiTokenService({
    repository: store.repositories.apiTokens,
    ratePerMinute: 2,
    logRetentionDays: 1,
    now: () => clock,
  });
  try {
    assert.equal(latestSchemaVersion(), 71);
    const issued = service.issue({ name: '行情机器人', deviceId: null });
    assert.match(issued.secret, /^aic_[A-Za-z0-9_-]{40,}$/);
    assert.equal(issued.token.prefix, issued.secret.slice(0, 12));
    assert.equal(Object.hasOwn(issued.token, 'tokenHash'), false);
    assert.equal(JSON.stringify(issued.token).includes(issued.secret), false);

    const database = new Database(path.join(directory, 'ai-center.db'), { readonly: true, fileMustExist: true });
    try {
      const columns = database.prepare('PRAGMA table_info(api_access_tokens)').all().map((column) => column.name);
      assert.equal(columns.includes('token'), false);
      assert.equal(columns.includes('secret'), false);
      assert.equal(columns.includes('token_hash'), true);
      const row = database.prepare('SELECT token_hash, token_prefix, name FROM api_access_tokens').get();
      assert.equal(row.token_hash, sha256(issued.secret));
      assert.equal(row.token_hash, hashApiToken(issued.secret));
      assert.notEqual(row.token_hash, issued.secret);
      assert.equal(row.token_prefix, issued.token.prefix);
      assert.equal(row.name, '行情机器人');
      const dumped = database.prepare('SELECT * FROM api_access_tokens').all();
      assert.equal(JSON.stringify(dumped).includes(issued.secret), false);
    } finally {
      database.close();
    }
    for (const name of ['ai-center.db', 'ai-center.db-wal']) {
      const file = path.join(directory, name);
      if (!existsSync(file)) continue;
      assert.equal(readFileSync(file).includes(Buffer.from(issued.secret)), false, name);
    }

    assert.equal(service.authorize(issued.secret).token.id, issued.token.id);
    assert.equal(service.authorize(`${issued.secret}x`).token, null);
    assert.equal(service.authorize('').token, null);
    assert.equal(service.revoke(issued.token.id), true);
    const revoked = service.authorize(issued.secret);
    assert.equal(revoked.token, null);
    assert.equal(revoked.revoked, true);
    assert.equal(service.list('local').some((token) => token.id === issued.token.id), false);

    const fresh = service.issue({ name: '日志' });
    assert.equal(service.consume(fresh.token.id, clock).allowed, true);
    assert.equal(service.consume(fresh.token.id, clock).allowed, true);
    const blocked = service.consume(fresh.token.id, clock);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds >= 1);
    assert.equal(service.consume(fresh.token.id, clock + 60_000).allowed, true);

    service.recordAccess({
      tokenId: fresh.token.id,
      method: 'GET',
      path: `/api/v1/feed/items/${fresh.secret}/original?token=${fresh.secret}`,
      status: 200,
      latencyMs: 4,
    });
    clock += 2 * 86_400_000;
    service.recordAccess({
      tokenId: fresh.token.id,
      method: 'GET',
      path: '/api/v1/posts',
      status: 200,
      latencyMs: 5,
    });
    const logs = store.repositories.apiTokens.listAccess(fresh.token.id, 10);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].path, '/api/v1/posts');
    assert.equal(logs[0].status, 200);
    assert.equal(logs[0].latencyMs, 5);
    assert.equal(JSON.stringify(logs).includes(fresh.secret), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bearer tokens can read the allowlist and nothing else', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-api-token-http-'));
  const captured = [];
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  for (const level of Object.keys(originals)) {
    console[level] = (...args) => {
      captured.push(args.map((item) => String(item?.stack || item)).join(' '));
      return originals[level](...args);
    };
  }
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    loginCredential: { username: 'owner', password: 'secret-pass' },
    marketService: {
      getBoard: async ({ board } = {}) => emptyBoard(board),
      search: async () => [],
      fetchQuotes: async () => [],
      fetchHistory: async () => [],
    },
  });
  const address = await app.listen();
  try {
    const created = await fetch(`${address.localUrl}/api/v1/api-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '外部机器人' }),
    });
    assert.equal(created.status, 201);
    const issued = await created.json();
    const secret = issued.secret;
    assert.match(secret, /^aic_/);
    assert.equal(JSON.stringify(issued.token).includes(secret), false);
    assert.equal(issued.token.name, '外部机器人');
    assert.equal(issued.token.lastUsedAt, null);

    const auth = { Authorization: `Bearer ${secret}` };
    const end = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const start = end - 3_600_000;
    const allowed = [
      '/api/v1/reports/daily/latest',
      '/api/v1/reports/daily/latest/brief',
      '/api/v1/reports/daily/briefs?limit=5',
      `/api/v1/reports/hourly?hourStart=${start}`,
      `/api/v1/reports/hourly/index?startAt=${start}&endAt=${end}`,
      `/api/v1/reports/hourly/search?startAt=${start}&endAt=${end}&query=存储&limit=5`,
      '/api/v1/investor-discussion',
      '/api/v1/markets?board=overview',
      '/api/v1/markets/search?q=AAPL',
      '/api/v1/hardware-prices?category=nand&limit=5',
      '/api/v1/compute-prices',
      '/api/v1/posts?limit=1',
      '/api/v1/feed/x?saved=1&limit=1',
      '/api/v1/etf-whale/overview',
      '/api/v1/etf-whale/etfs/159915',
      '/api/v1/etf-whale/series?code=159915',
      '/api/v1/etf-whale/daily',
      '/api/v1/etf-whale/signals',
    ];
    for (const pathName of allowed) {
      const response = await fetch(`${address.localUrl}${pathName}`, { headers: { ...publicHeaders(), ...auth } });
      const payload = await response.json();
      assert.equal(response.status, 200, `${pathName} ${JSON.stringify(payload)}`);
      assert.equal(payload.ok, true, pathName);
      assert.equal(JSON.stringify(payload).includes(secret), false, pathName);
    }
    const missingItem = await fetch(`${address.localUrl}/api/v1/content-items/${randomUUID()}`, {
      headers: { ...publicHeaders(), ...auth },
    });
    assert.equal(missingItem.status, 404);
    const unknownEtf = await fetch(`${address.localUrl}/api/v1/etf-whale/etfs/000001`, {
      headers: { ...publicHeaders(), ...auth },
    });
    assert.equal(unknownEtf.status, 404);
    assert.equal((await unknownEtf.json()).error, 'not_in_universe');
    const badEtf = await fetch(`${address.localUrl}/api/v1/etf-whale/etfs/abc`, {
      headers: { ...publicHeaders(), ...auth },
    });
    assert.equal(badEtf.status, 400);
    const missingCode = await fetch(`${address.localUrl}/api/v1/etf-whale/series`, {
      headers: { ...publicHeaders(), ...auth },
    });
    assert.equal(missingCode.status, 400);

    const denied = [
      ['GET', '/api/v1/api-tokens'],
      ['GET', '/api/v1/runtime/deploy-status'],
      ['GET', '/api/v1/runtime/access-summary'],
      ['GET', '/api/v1/runtime'],
      ['GET', '/api/v1/devices'],
      ['GET', '/api/v1/holdings'],
      ['GET', '/api/v1/assets/personal'],
      ['GET', '/api/v1/notes'],
      ['POST', '/api/v1/reports/daily/generate'],
      ['POST', '/api/v1/api-tokens'],
      ['DELETE', `/api/v1/api-tokens/${issued.token.id}`],
    ];
    for (const [method, pathName] of denied) {
      const response = await fetch(`${address.localUrl}${pathName}`, {
        method,
        headers: {
          ...publicHeaders(),
          ...auth,
          'Content-Type': 'application/json',
        },
        body: method === 'GET' ? undefined : JSON.stringify({ name: '不该成功', date: '2026-10-12' }),
      });
      assert.equal(response.status, 401, pathName);
      await response.json();
    }

    const loopbackDeploy = await fetch(`${address.localUrl}/api/v1/runtime/deploy-status`, { headers: auth });
    assert.equal(loopbackDeploy.status, 401);

    const jobsBefore = app.store.listJobs(50).filter((job) => job.type === 'media.sources.sync').length;
    const refresh = await fetch(`${address.localUrl}/api/v1/feed/media?channel=tech&refresh=1`, {
      headers: { ...publicHeaders(), ...auth },
    });
    assert.equal(refresh.status, 403);
    assert.equal(app.store.listJobs(50).filter((job) => job.type === 'media.sources.sync').length, jobsBefore);

    const login = await fetch(`${address.localUrl}/api/v1/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'secret-pass', deviceName: '令牌管理' }),
    });
    assert.equal(login.status, 201);
    const cookie = cookiePair(login);
    const deviceCreated = await fetch(`${address.localUrl}/api/v1/api-tokens`, {
      method: 'POST',
      headers: { ...publicHeaders(), Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '手机创建' }),
    });
    assert.equal(deviceCreated.status, 201);
    const deviceSecret = (await deviceCreated.json()).secret;
    const deviceList = await fetch(`${address.localUrl}/api/v1/api-tokens`, {
      headers: { ...publicHeaders(), Cookie: cookie },
    });
    const listed = await deviceList.json();
    assert.equal(deviceList.status, 200);
    assert.equal(listed.tokens.some((token) => token.name === '手机创建'), true);
    assert.equal(JSON.stringify(listed).includes(deviceSecret), false);
    assert.equal(JSON.stringify(listed).includes('token_hash'), false);

    const written = await fetch(`${address.localUrl}/api/v1/posts`, {
      method: 'POST',
      headers: {
        ...publicHeaders(),
        Cookie: cookie,
        ...auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: '设备仍然可以写', body: 'cookie' }),
    });
    assert.equal(written.status, 201);
    const bearerWrite = await fetch(`${address.localUrl}/api/v1/posts`, {
      method: 'POST',
      headers: { ...publicHeaders(), ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '令牌不能写', body: 'no' }),
    });
    assert.equal(bearerWrite.status, 401);

    const revoked = await fetch(`${address.localUrl}/api/v1/api-tokens/${issued.token.id}`, { method: 'DELETE' });
    assert.equal(revoked.status, 200);
    const afterRevoke = await fetch(`${address.localUrl}/api/v1/posts?limit=1`, {
      headers: { ...publicHeaders(), ...auth },
    });
    assert.equal(afterRevoke.status, 401);
    assert.equal((await afterRevoke.json()).error, '令牌无效或已撤销');

    const database = new Database(path.join(directory, 'ai-center.db'), { readonly: true, fileMustExist: true });
    try {
      const row = database.prepare('SELECT token_hash, token_prefix FROM api_access_tokens WHERE id = ?').get(issued.token.id);
      assert.equal(row.token_hash, sha256(secret));
      assert.notEqual(row.token_prefix, secret);
      const logs = database.prepare('SELECT path, status, latency_ms, created_at FROM api_token_access_log WHERE token_id = ?').all(issued.token.id);
      assert.ok(logs.length > 0);
      assert.equal(logs.some((entry) => entry.path === '/api/v1/posts' && entry.status === 200), true);
      assert.equal(logs.some((entry) => entry.path.includes('?')), false);
      assert.equal(logs.every((entry) => entry.latency_ms >= 0 && entry.created_at > 0), true);
      assert.equal(JSON.stringify(logs).includes(secret), false);
    } finally {
      database.close();
    }
    for (const name of ['ai-center.db', 'ai-center.db-wal']) {
      const file = path.join(directory, name);
      if (!existsSync(file)) continue;
      assert.equal(readFileSync(file).includes(Buffer.from(secret)), false, name);
      assert.equal(readFileSync(file).includes(Buffer.from(deviceSecret)), false, name);
    }
    let leaked = 0;
    for (const line of captured) if (line.includes(secret) || line.includes(deviceSecret)) leaked += 1;
    assert.equal(leaked, 0);
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('api tokens return 429 with Retry-After after the per-minute limit', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-api-token-rate-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    env: { ...process.env, AI_CENTER_API_TOKEN_RATE_PER_MINUTE: '2' },
    marketService: { getBoard: async ({ board } = {}) => emptyBoard(board), search: async () => [] },
  });
  const address = await app.listen();
  try {
    const created = await fetch(`${address.localUrl}/api/v1/api-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '限流' }),
    });
    assert.equal(created.status, 201);
    const { secret } = await created.json();
    const headers = { ...publicHeaders({ 'CF-Connecting-IP': '203.0.113.81' }), Authorization: `Bearer ${secret}` };
    assert.equal((await fetch(`${address.localUrl}/api/v1/posts?limit=1`, { headers })).status, 200);
    assert.equal((await fetch(`${address.localUrl}/api/v1/posts?limit=1`, { headers })).status, 200);
    const limited = await fetch(`${address.localUrl}/api/v1/compute-prices`, { headers });
    assert.equal(limited.status, 429);
    const retryAfter = Number(limited.headers.get('retry-after'));
    assert.equal(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, true);
    assert.equal((await limited.json()).ok, false);
    const database = new Database(path.join(directory, 'ai-center.db'), { readonly: true, fileMustExist: true });
    try {
      const statuses = database.prepare('SELECT status FROM api_token_access_log').all().map((row) => row.status);
      assert.equal(statuses.includes(429), true);
      assert.equal(JSON.stringify(statuses).includes(secret), false);
    } finally {
      database.close();
    }
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
