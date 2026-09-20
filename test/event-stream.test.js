import test from 'node:test';
import assert from 'node:assert/strict';
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

test('SSE ready carries the current ui revision', async () => {
  const body = await openToChunks(createMemoryRuntime(1), 0, {
    getUiRevision: async () => 'abc123def456',
  });
  assert.match(body, /"uiRevision":"abc123def456"/);
});
