import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hourlyAllowance,
  readBambooUsage,
  shanghaiUsageStamp,
  takeBambooUsageSlot,
} from '../packages/domain/src/bamboo-usage.js';
import { createFeedFilter, resolveFeedFilterConfig } from '../packages/domain/src/feed-filter.js';

const modulePath = fileURLToPath(new URL('../packages/domain/src/bamboo-usage.js', import.meta.url));
const hour0 = Date.parse('2026-10-18T16:00:00.000Z');
const hour1 = Date.parse('2026-10-18T17:00:00.000Z');
const hour23 = Date.parse('2026-10-19T15:00:00.000Z');

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'ai-center-bamboo-usage-'));
}

function runChild({ directory, takes, max, at, spread = 'fifo' }) {
  const code = `
    import { readBambooUsage, takeBambooUsageSlot } from ${JSON.stringify(modulePath)};
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
