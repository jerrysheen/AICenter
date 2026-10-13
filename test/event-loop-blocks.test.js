import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import {
  bindEventLoopProbe,
  combineLoopDelayMs,
  createEventLoopProbe,
  formatEventLoopLine,
} from '../apps/web/src/http/event-loop-blocks.js';
import { createAccessLog } from '../apps/web/src/http/access-log.js';

test('loop delay keeps the in-request histogram delta and a labeled block', () => {
  assert.equal(combineLoopDelayMs(0, null), 0);
  assert.equal(combineLoopDelayMs(259, 40), 259);
  assert.equal(combineLoopDelayMs(null, 1800), 1800);
  assert.equal(combineLoopDelayMs(null, null), null);
});

test('probe names the task that stalled the loop', async () => {
  const blocks = [];
  const probe = createEventLoopProbe({
    intervalMs: 20,
    blockMs: 40,
    onBlock(block) { blocks.push(block); },
  });
  const leave = probe.enter('hardware-prices.list');
  const started = Date.now();
  while (Date.now() - started < 90) { /* hold the loop */ }
  leave();
  await new Promise((resolve) => setTimeout(resolve, 50));
  probe.stop();
  assert.ok(blocks.some((block) => block.task === 'hardware-prices.list' && block.blockedMs >= 40));
});

test('minute event-loop line is written into the log file', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-loop-line-'));
  const accessLog = createAccessLog({ directory, salt: 'salt', env: {} });
  const sample = { at: Date.parse('2026-10-13T02:00:00Z'), p50Ms: 12.2, p99Ms: 254.4, maxMs: 1900.2 };
  accessLog.writeEventLoop(sample);
  await accessLog.flush();
  const name = readdirSync(directory).find((item) => item.startsWith('event-loop.') && item.endsWith('.log'));
  const text = readFileSync(path.join(directory, name), 'utf8');
  assert.match(text, /\[web\] event-loop p50=12ms p99=254ms max=1900ms/);
  assert.equal(formatEventLoopLine(sample), '[web] event-loop p50=12ms p99=254ms max=1900ms');
  const accessName = readdirSync(directory).find((item) => item.startsWith('access.') && item.endsWith('.log'));
  const row = JSON.parse(readFileSync(path.join(directory, accessName), 'utf8').trim());
  assert.equal(row.kind, 'event-loop');
  assert.equal(row.line, formatEventLoopLine(sample));
  await accessLog.close();
  rmSync(directory, { recursive: true, force: true });
});

test('a stall inside the request is visible as loopMs', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-loop-req-'));
  const blocks = [];
  const probe = createEventLoopProbe({
    intervalMs: 15,
    blockMs: 30,
    onBlock(block) { blocks.push(block); },
  });
  bindEventLoopProbe(probe);
  const accessLog = createAccessLog({ directory, salt: 'salt', env: {} });
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    accessLog.observe(request, response, url);
    const leave = probe.enter('GET /api/v1/feed/x');
    const started = Date.now();
    while (Date.now() - started < 80) { /* hold the loop */ }
    leave();
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fetch(`http://127.0.0.1:${port}/api/v1/feed/x`);
    await accessLog.flush();
    const name = readdirSync(directory).find((item) => item.startsWith('access.') && item.endsWith('.log'));
    const row = readFileSync(path.join(directory, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .find((item) => item.path === '/api/v1/feed/x');
    assert.ok(row.loopMs >= 30, `loopMs=${row.loopMs}`);
    assert.ok(blocks.some((block) => block.task === 'GET /api/v1/feed/x'));
  } finally {
    bindEventLoopProbe(null);
    probe.stop();
    await accessLog.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
