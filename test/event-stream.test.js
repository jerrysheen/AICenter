import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createStore } from '../packages/database/src/index.js';
import { createRuntimeService } from '../packages/domain/src/runtime-service.js';
import { createEventStreamHub } from '../apps/web/src/http/event-stream.js';

function createMemoryRuntime(count, workspaceId = 'local') {
  const events = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: 'feed.content-item.saved.v1',
    payload: { n: index + 1 },
    workspaceId,
  }));
  return {
    listEvents(afterId = 0, limit = 200, workspace = null) {
      const rows = events.filter((event) => (
        event.id > afterId && (!workspace || event.workspaceId === workspace)
      ));
      return rows.slice(0, Math.max(1, Math.min(Number(limit) || 200, 1_000)));
    },
    latestEventId() {
      return count;
    },
  };
}

async function openToChunks(runtime, lastEventId, options = {}) {
  const chunks = [];
  const hub = createEventStreamHub(runtime, options);
  await hub.open(
    { on() {} },
    {
      writeHead() {},
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
      end() {},
    },
    { device: { workspaceId: 'local', id: 'device-1' } },
    lastEventId,
  );
  hub.closeAll();
  return chunks.join('');
}

test('SSE replay pages past a single listEvents window', async () => {
  const body = await openToChunks(createMemoryRuntime(12), 1, { replayPageSize: 3, replayMaxEvents: 50 });
  assert.match(body, /id: 2\n/);
  assert.match(body, /id: 12\n/);
  assert.match(body, /"snapshotRequired":false/);
  assert.match(body, /"replayedThrough":12/);
});

test('SSE ready asks the client for a snapshot when replay hits the window', async () => {
  const body = await openToChunks(createMemoryRuntime(8), 1, { replayPageSize: 2, replayMaxEvents: 4 });
  assert.match(body, /id: 5\n/);
  assert.doesNotMatch(body, /id: 8\n/);
  assert.match(body, /"snapshotRequired":true/);
});

test('flush skips payload reads when nobody is listening', () => {
  let reads = 0;
  const hub = createEventStreamHub({
    latestEventId() { return 9; },
    listEvents() { reads += 1; return []; },
    listEventFrames() { reads += 1; return []; },
  });
  hub.flush();
  assert.equal(reads, 0);
});

test('flush sends stored payload text a few events at a time', async () => {
  const events = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    name: 'demo.saved.v1',
    workspaceId: 'local',
    payloadJson: JSON.stringify({ n: index + 1 }),
  }));
  let maxLimit = 0;
  const chunks = [];
  const hub = createEventStreamHub({
    latestEventId() { return 0; },
    listEventFrames(afterId, limit) {
      maxLimit = Math.max(maxLimit, Number(limit) || 0);
      return events.filter((event) => event.id > afterId).slice(0, limit);
    },
    listEvents() {
      throw new Error('flush must not parse event payloads');
    },
  });
  await hub.open(
    { on() {} },
    { writeHead() {}, write(chunk) { chunks.push(String(chunk)); return true; }, end() {} },
    { device: { workspaceId: 'local', id: 'device-1' } },
    0,
  );
  hub.flush();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const body = chunks.join('');
  assert.equal(maxLimit, 1);
  assert.match(body, /"n":1/);
  assert.match(body, /"n":12/);
  hub.closeAll();
});

test('event frames return a replay page of stored payload text', () => {
  const store = createStore(':memory:');
  try {
    for (let index = 0; index < 60; index += 1) {
      store.createJob({ type: 'feed.sync', input: { n: index } });
    }
    const frames = store.listEventFrames(0, 200);
    assert.ok(frames.length > 50);
    assert.equal(typeof frames.at(-1).payloadJson, 'string');
    assert.equal(JSON.parse(frames.at(-1).payloadJson).job.input.n, 59);
    assert.equal(Object.hasOwn(frames.at(-1), 'payload'), false);
  } finally {
    store.close();
  }
});

test('flush skips a large payload instead of reading it on the caller tick', async () => {
  const store = createStore(':memory:');
  const pad = 'x'.repeat(20_000);
  const chunks = [];
  let payloadReads = 0;
  const runtime = {
    latestEventId: () => store.latestEventId(),
    listEventFrameHeads: (...args) => store.listEventFrameHeads(...args),
    readEventPayloadSlice(...args) {
      payloadReads += 1;
      return store.readEventPayloadSlice(...args);
    },
    listEventFrames() {
      throw new Error('flush must not read a full payload frame');
    },
  };
  const hub = createEventStreamHub(runtime);
  await hub.open(
    { on() {} },
    { writeHead() {}, write(chunk) { chunks.push(String(chunk)); return true; }, end() {} },
    { device: { workspaceId: 'local', id: 'device-1' } },
    0,
  );
  store.createJob({ type: 'feed.sync', input: { pad } });
  chunks.length = 0;
  hub.flush();
  assert.equal(payloadReads, 0);
  assert.equal(chunks.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const body = chunks.join('');
  assert.match(body, /"truncated":true/);
  assert.equal(body.includes(pad), false);
  assert.equal(payloadReads, 0);
  hub.closeAll();
  store.close();
});

test('runtime flush emits stored sse text and does not read payload_json', async () => {
  const store = createStore(':memory:');
  let payloadReads = 0;
  let fullReads = 0;
  const runtime = createRuntimeService({ runtimeRepository: store });
  const wrapped = {
    ...runtime,
    listEvents() { fullReads += 1; return store.listEvents(...arguments); },
    readEventPayloadSlice() { payloadReads += 1; return ''; },
    listEventFrameHeads: (...args) => store.listEventFrameHeads(...args),
    listEventFrames: (...args) => store.listEventFrames(...args),
    latestEventId: () => store.latestEventId(),
  };
  const chunks = [];
  const hub = createEventStreamHub(wrapped);
  await hub.open(
    { on() {} },
    { writeHead() {}, write(chunk) { chunks.push(String(chunk)); return true; }, end() {} },
    { device: { workspaceId: 'local', id: 'device-1' } },
    0,
  );
  store.createJob({ type: 'feed.sync', input: { n: 1 } });
  store.createJob({ type: 'feed.sync', input: { pad: 'x'.repeat(20_000) } });
  chunks.length = 0;
  const started = performance.now();
  hub.flush();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const flushMs = performance.now() - started;
  const body = chunks.join('');
  assert.match(body, /"n":1/);
  assert.match(body, /"truncated":true/);
  assert.equal(body.includes('x'.repeat(100)), false);
  assert.equal(payloadReads, 0);
  assert.equal(fullReads, 0);
  console.log(JSON.stringify({ flushMs: Number(flushMs.toFixed(2)), frames: body.split('\n\n').filter(Boolean).length }));
  hub.closeAll();
  store.close();
});

test('SSE ready carries the current ui revision', async () => {
  const body = await openToChunks(createMemoryRuntime(1), 0, {
    getUiRevision: async () => 'abc123def456',
  });
  assert.match(body, /"uiRevision":"abc123def456"/);
});
