import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  bambooUsagePath,
  hourlyAllowance,
  listBambooDailyUsage,
  readBambooUsage,
  shanghaiUsageStamp,
  shiftShanghaiDay,
  takeBambooUsageSlot,
} from '../packages/domain/src/bamboo-usage.js';
import { createBambooUsageView } from '../packages/domain/src/bamboo-usage-view.js';
import { BambooDailyUsageDaySchema } from '../packages/contracts/src/model-usage.js';
import { formatBambooDailySummary, openModelUsageDialog } from '../apps/web/public/model-usage.js';
import { createAiCenterServer } from '../apps/web/src/server.js';
import { createFeedFilter, resolveFeedFilterConfig } from '../packages/domain/src/feed-filter.js';

const moduleUrl = pathToFileURL(fileURLToPath(new URL('../packages/domain/src/bamboo-usage.js', import.meta.url))).href;
const hour0 = Date.parse('2026-10-18T16:00:00.000Z');
const hour1 = Date.parse('2026-10-18T17:00:00.000Z');
const hour23 = Date.parse('2026-10-19T15:00:00.000Z');

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'ai-center-bamboo-usage-'));
}

test('child import uses a file URL so a Windows drive path is not a scheme', () => {
  assert.equal(moduleUrl.startsWith('file:'), true);
  assert.equal(/^[a-zA-Z]:/.test(moduleUrl), false);
});

function runChild({ directory, takes, max, at, spread = 'fifo' }) {
  const code = `
    import { readBambooUsage, takeBambooUsageSlot } from ${JSON.stringify(moduleUrl)};
    const takes = Number(process.env.TAKES);
    let ok = 0;
    for (let i = 0; i < takes; i += 1) {
      const slot = takeBambooUsageSlot({
        directory: process.env.DIR,
        max: Number(process.env.MAX),
        spread: process.env.SPREAD,
        at: Number(process.env.AT),
      });
      if (slot.ok) ok += 1;
    }
    const usage = readBambooUsage(process.env.DIR, Number(process.env.AT));
    process.stdout.write(JSON.stringify({ ok, count: usage.count }));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: {
        ...process.env,
        DIR: directory,
        TAKES: String(takes),
        MAX: String(max),
        SPREAD: spread,
        AT: String(at),
      },
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (status) => {
      if (status !== 0) reject(new Error(err || out || `child ${status}`));
      else resolve(JSON.parse(out));
    });
  });
}

test('shanghai stamp uses the calendar day and hour', () => {
  assert.deepEqual(shanghaiUsageStamp(hour0), { day: '20261019', hour: 0 });
  assert.equal(shanghaiUsageStamp(hour23).hour, 23);
  assert.equal(hourlyAllowance({ max: 24, countBeforeHour: 0, hour: 0 }), 1);
  assert.equal(hourlyAllowance({ max: 10, countBeforeHour: 0, hour: 0 }), 0);
  assert.equal(hourlyAllowance({ max: 2000, countBeforeHour: 0, hour: 0 }), 83);
});

test('a new process keeps the count written before it started', async () => {
  const directory = temporaryDirectory();
  try {
    const first = takeBambooUsageSlot({ directory, max: 5, at: hour0 });
    assert.equal(first.ok, true);
    assert.equal(first.count, 1);
    const restarted = await runChild({ directory, takes: 0, max: 5, at: hour0 });
    assert.equal(restarted.count, 1);
    const continued = await runChild({ directory, takes: 1, max: 5, at: hour0 });
    assert.equal(continued.ok, 1);
    assert.equal(readBambooUsage(directory, hour0).count, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('two processes share one daily counter and stop at the cap', async () => {
  const directory = temporaryDirectory();
  try {
    const [left, right] = await Promise.all([
      runChild({ directory, takes: 30, max: 40, at: hour0 }),
      runChild({ directory, takes: 30, max: 40, at: hour0 }),
    ]);
    assert.equal(left.ok + right.ok, 40);
    assert.equal(readBambooUsage(directory, hour0).count, 40);
    const extra = takeBambooUsageSlot({ directory, max: 40, at: hour0 });
    assert.equal(extra.ok, false);
    assert.equal(extra.reason, 'daily');
    assert.equal(readBambooUsage(directory, hour0).count, 40);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('hourly spread keeps the unused part of the day for later hours', () => {
  const directory = temporaryDirectory();
  try {
    const first = takeBambooUsageSlot({ directory, max: 24, spread: 'hourly', at: hour0 });
    const second = takeBambooUsageSlot({ directory, max: 24, spread: 'hourly', at: hour0 });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'hourly');
    assert.equal(readBambooUsage(directory, hour0).count, 1);
    const nextHour = takeBambooUsageSlot({ directory, max: 24, spread: 'hourly', at: hour1 });
    assert.equal(nextHour.ok, true);
    assert.equal(readBambooUsage(directory, hour1).hourCount, 1);
    const eveningDirectory = temporaryDirectory();
    try {
      const blocked = takeBambooUsageSlot({ directory: eveningDirectory, max: 10, spread: 'hourly', at: hour0 });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.allowance, 0);
      let accepted = 0;
      for (let i = 0; i < 12; i += 1) {
        const slot = takeBambooUsageSlot({ directory: eveningDirectory, max: 10, spread: 'hourly', at: hour23 });
        if (slot.ok) accepted += 1;
      }
      assert.equal(accepted, 10);
      assert.equal(readBambooUsage(eveningDirectory, hour23).count, 10);
    } finally {
      rmSync(eveningDirectory, { recursive: true, force: true });
    }
    const fifo = temporaryDirectory();
    try {
      assert.equal(takeBambooUsageSlot({ directory: fifo, max: 2, at: hour0 }).ok, true);
      assert.equal(takeBambooUsageSlot({ directory: fifo, max: 2, at: hour0 }).ok, true);
      assert.equal(takeBambooUsageSlot({ directory: fifo, max: 2, at: hour0 }).reason, 'daily');
    } finally {
      rmSync(fifo, { recursive: true, force: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rename EPERM retries and then reports usage-error without throwing', () => {
  const directory = temporaryDirectory();
  try {
    let attempts = 0;
    const rename = (from, to) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('EPERM');
        error.code = 'EPERM';
        throw error;
      }
      renameSync(from, to);
    };
    const recovered = takeBambooUsageSlot({ directory, max: 5, at: hour0, rename });
    assert.equal(recovered.ok, true);
    assert.equal(attempts, 3);
    assert.equal(readBambooUsage(directory, hour0).count, 1);
    const blocked = takeBambooUsageSlot({
      directory,
      max: 5,
      at: hour0,
      rename: () => {
        const error = new Error('EPERM');
        error.code = 'EPERM';
        throw error;
      },
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'usage-error');
    assert.equal(blocked.category, 'EPERM');
    assert.equal(readBambooUsage(directory, hour0).count, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unreadable usage file logs the file fault and uses the local fallback', async () => {
  const directory = temporaryDirectory();
  try {
    writeFileSync(bambooUsagePath(directory, '20261019'), '{');
    const logs = [];
    let calls = 0;
    const filter = createFeedFilter({
      usageDirectory: directory,
      log: (message) => logs.push(message),
      config: {
        ...resolveFeedFilterConfig({
          AI_CENTER_JEV_ENABLED: 'false',
          AI_CENTER_CLASSIFICATION_PROVIDER: 'bamboo',
          AI_CENTER_FEED_FILTER: 'enforce',
        }),
        now: () => hour0,
      },
      client: {
        available: () => true,
        async evaluate() {
          calls += 1;
          throw new Error('should not call');
        },
      },
    });
    const result = await filter.evaluate({
      provider: 'x',
      sourceExternalId: 'x:home:following',
      originalText: '关注流里的一条完整更新，包含订单金额和交付日期。',
      item: {
        provider: 'x',
        title: '订单',
        body: '关注流里的一条完整更新，包含订单金额和交付日期。',
        sourceExternalId: 'x:home:following',
      },
    });
    assert.equal(calls, 0);
    assert.equal(logs.length, 1);
    assert.equal(logs[0], '[worker] Bamboo 用量文件异常，走本地兜底（BAMBOO_USAGE_READ）');
    assert.equal(result.metadata.filterErrorCode, 'BAMBOO_USAGE_ERROR');
    assert.equal(result.metadata.filterReason, 'jev-disabled-following');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('feed admission hourly mode does not call Bamboo after the hour share is used', async () => {
  const directory = temporaryDirectory();
  try {
    let calls = 0;
    const filter = createFeedFilter({
      usageDirectory: directory,
      config: {
        ...resolveFeedFilterConfig({
          AI_CENTER_JEV_ENABLED: 'false',
          AI_CENTER_CLASSIFICATION_PROVIDER: 'bamboo',
          AI_CENTER_FEED_FILTER: 'enforce',
          AI_CENTER_BAMBOO_DAILY_MAX: '24',
          AI_CENTER_BAMBOO_DAILY_SPREAD: 'hourly',
        }),
        now: () => hour0,
      },
      client: {
        available: () => true,
        async evaluate() {
          calls += 1;
          return {
            model: 'startlux-decision-27b-autothink',
            answers: {
              reading_value: { type: 'noul', noul: 0.9 },
              advertising: { type: 'noul', noul: 0.1 },
              specific_content: { type: 'noul', noul: 0.9 },
              sufficient_information: { type: 'noul', noul: 0.9 },
              missing_context: { type: 'noul', noul: 0.05 },
            },
          };
        },
      },
    });
    filter.config.now = () => hour0;
    const input = (text) => ({
      provider: 'x',
      sourceExternalId: 'x:home:following',
      originalText: text,
      item: { provider: 'x', title: '订单', body: text, sourceExternalId: 'x:home:following' },
    });
    const first = await filter.evaluate(input('关注流里的一条完整更新，包含订单金额和交付日期。'));
    const second = await filter.evaluate(input('关注流里的另一条完整更新，包含产能和客户名称。'));
    assert.equal(calls, 1);
    assert.equal(first.metadata.filterReason, 'all-three');
    assert.equal(second.metadata.filterErrorCode, 'BAMBOO_HOURLY_CAP');
    assert.equal(second.metadata.filterReason, 'jev-disabled-following');
    assert.equal(readBambooUsage(directory, hour0).count, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the usage page reads each Shanghai day without taking another slot', () => {
  assert.equal(shiftShanghaiDay('20261001', -1), '20260930');
  assert.equal(shiftShanghaiDay('20260301', -1), '20260228');
  const directory = temporaryDirectory();
  try {
    const today = shanghaiUsageStamp(hour0).day;
    const yesterday = shiftShanghaiDay(today, -1);
    const broken = shiftShanghaiDay(today, -2);
    writeFileSync(bambooUsagePath(directory, today), JSON.stringify({
      count: 1234, hour: 0, hourCount: 4, provider: 'bamboo', apiKey: 'should-not-leak',
    }));
    writeFileSync(bambooUsagePath(directory, yesterday), JSON.stringify({ count: 50, hour: 23, hourCount: 1 }));
    writeFileSync(bambooUsagePath(directory, broken), '{');
    writeFileSync(path.join(directory, 'bamboo-usage-lock'), '{"count":9999}');
    const before = readdirSync(directory).sort();
    const rows = listBambooDailyUsage({ directory, at: hour0, days: 3, limit: 7000 });
    assert.deepEqual(rows, [
      { day: today, count: 1234, limit: 7000 },
      { day: yesterday, count: 50, limit: 7000 },
      { day: broken, count: null, limit: 7000 },
    ]);
    assert.deepEqual(readdirSync(directory).sort(), before);
    assert.equal(readBambooUsage(directory, hour0).count, 1234);
    assert.equal(JSON.stringify(rows).includes('should-not-leak'), false);
    assert.equal(JSON.stringify(rows).includes('provider'), false);
    assert.throws(() => BambooDailyUsageDaySchema.parse({ ...rows[0], provider: 'bamboo' }));
    const view = createBambooUsageView({ directory, env: {}, now: () => hour0, days: 3 });
    assert.equal(view.listDays()[0].limit, 7000);
    assert.equal(createBambooUsageView({ directory, env: { AI_CENTER_BAMBOO_DAILY_MAX: 'nope' }, now: () => hour0, days: 1 }).listDays()[0].limit, 7000);
    const text = formatBambooDailySummary(rows);
    assert.match(text, /^Bamboo 每天调用（信息流准入）\n今天 1,234 \/ 7,000\n10月18日 50 \/ 7,000\n10月17日 无法读取 \/ 7,000$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeDocument() {
  function createElement(tag) {
    return {
      tag,
      className: '',
      textContent: '',
      type: '',
      placeholder: '',
      value: '',
      disabled: false,
      children: [],
      isConnected: false,
      setAttribute() {},
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = [...nodes]; },
      addEventListener(type, fn) { this.listeners = { ...this.listeners, [type]: fn }; },
      close() { this.listeners?.close?.(); },
      showModal() { this.isConnected = true; },
      remove() { this.isConnected = false; },
    };
  }
  const body = { children: [], append(node) { this.children.push(node); } };
  return { createElement, body };
}

test('the usage dialog shows the daily Bamboo count and cap', async () => {
  const document = fakeDocument();
  const urls = [];
  openModelUsageDialog({
    document,
    api: async (url) => {
      urls.push(url);
      return {
        records: [],
        bambooDays: [
          { day: '20261019', count: 1234, limit: 7000 },
          { day: '20261018', count: 50, limit: 7000 },
        ],
      };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const dialog = document.body.children[0];
  const bamboo = dialog.children.find((node) => node.className === 'model-usage-bamboo');
  assert.match(bamboo.textContent, /Bamboo 每天调用（信息流准入）/);
  assert.match(bamboo.textContent, /今天 1,234 \/ 7,000/);
  assert.match(bamboo.textContent, /10月18日 50 \/ 7,000/);
  assert.equal(bamboo.textContent.includes('should-not-leak'), false);
  assert.match(dialog.children.at(-1).textContent, /暂无记录/);
  const actions = dialog.children.find((node) => node.className === 'model-usage-actions');
  actions.children[0].value = 'fixture-job';
  actions.children[1].onclick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(urls.at(-1), /jobId=fixture-job/);
});

test('model usage HTTP returns Bamboo days and does not increment the counter', async () => {
  const directory = temporaryDirectory();
  const stamp = shanghaiUsageStamp(Date.now());
  writeFileSync(bambooUsagePath(directory, stamp.day), JSON.stringify({
    count: 42, hour: stamp.hour, hourCount: 1, apiKey: 'should-not-leak',
  }));
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory, env: {} });
  const { localUrl } = await app.listen();
  try {
    const response = await fetch(`${localUrl}/api/v1/runtime/model-usage`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.records, []);
    assert.equal(body.bambooDays.length, 14);
    assert.deepEqual(body.bambooDays[0], { day: stamp.day, count: 42, limit: 7000 });
    assert.deepEqual(Object.keys(body.bambooDays[0]).sort(), ['count', 'day', 'limit']);
    assert.equal(JSON.stringify(body).includes('should-not-leak'), false);
    assert.equal(JSON.stringify(body).includes('bamboo-usage-'), false);
    assert.equal(readBambooUsage(directory).count, 42);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
