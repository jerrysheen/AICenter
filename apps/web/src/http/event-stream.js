import { labelEventLoop } from './event-loop-blocks.js';

const REPLAY_PAGE_SIZE = 200;
const REPLAY_MAX_EVENTS = 10_000;
const FLUSH_PAGE_SIZE = 1;

export const SSE_REPLAY_PAGE_SIZE = REPLAY_PAGE_SIZE;
export const SSE_REPLAY_MAX_EVENTS = REPLAY_MAX_EVENTS;

export function createEventStreamHub(runtimeService, options = {}) {
  const replayPageSize = Math.max(1, Number(options.replayPageSize) || REPLAY_PAGE_SIZE);
  const replayMaxEvents = Math.max(1, Number(options.replayMaxEvents) || REPLAY_MAX_EVENTS);
  const clients = new Set();
  let eventCursor = runtimeService.latestEventId();
  let flushing = false;

  function eventFrame(event) {
    const data = typeof event.payloadJson === 'string' ? event.payloadJson : JSON.stringify(event.payload ?? {});
    return `id: ${event.id}\nevent: ${event.name}\ndata: ${data}\n\n`;
  }

  function readFrames(afterId, limit, workspaceId) {
    if (typeof runtimeService.listEventFrames === 'function') {
      return runtimeService.listEventFrames(afterId, limit, workspaceId);
    }
    return runtimeService.listEvents(afterId, limit, workspaceId);
  }

  function emitChunk(workspaceId, chunk) {
    for (const client of clients) {
      if (client.workspaceId === workspaceId) client.response.write(chunk);
    }
  }

  function flush() {
    if (flushing) return;
    if (clients.size === 0) {
      try { eventCursor = runtimeService.latestEventId(); } catch { /* 没有订阅者时不读事件正文 */ }
      return;
    }
    flushing = true;
    const sliced = typeof runtimeService.listEventFrameHeads === 'function';
    setTimeout(sliced ? stepHeads : stepFrames, 0);
  }

  function finishFlush() {
    flushing = false;
  }

  function stepFrames() {
    const leave = labelEventLoop('events.flush');
    let more = false;
    try {
      const events = readFrames(eventCursor, FLUSH_PAGE_SIZE);
      for (const event of events) {
        eventCursor = event.id;
        emitChunk(event.workspaceId, eventFrame(event));
      }
      more = events.length === FLUSH_PAGE_SIZE;
    } finally {
      leave();
      if (!more) finishFlush();
    }
    if (more) setTimeout(stepFrames, 0);
  }

  function stepHeads() {
    const leave = labelEventLoop('events.flush');
    let next = null;
    try {
      const heads = runtimeService.listEventFrameHeads(eventCursor, 1);
      if (!heads.length) return;
      const head = heads[0];
      eventCursor = head.id;
      const bytes = head.payloadBytes == null ? null : Number(head.payloadBytes);
      const data = typeof head.sseData === 'string' && head.sseData
        ? head.sseData
        : `{"truncated":true,"bytes":${bytes == null ? 'null' : bytes}}`;
      emitChunk(head.workspaceId, `id: ${head.id}\nevent: ${head.name}\ndata: ${data}\n\n`);
      next = 'event';
    } finally {
      leave();
      if (!next) finishFlush();
    }
    if (next === 'event') setTimeout(stepHeads, 0);
  }

  function replaySince(lastEventId, workspaceId, write) {
    return new Promise((resolve) => {
      let replayedThrough = lastEventId;
      let replayed = 0;
      const finish = (snapshotRequired) => resolve({ replayedThrough, snapshotRequired, replayed });
      const step = () => {
        const leave = labelEventLoop('events.replay');
        let again = false;
        try {
          if (replayed >= replayMaxEvents) {
            finish(readFrames(replayedThrough, 1, workspaceId).length > 0);
            return;
          }
          const events = readFrames(replayedThrough, replayPageSize, workspaceId);
          if (!events.length) {
            finish(false);
            return;
          }
          for (const event of events) {
            replayedThrough = event.id;
            write(eventFrame(event));
            replayed += 1;
            if (replayed >= replayMaxEvents) break;
          }
          if (events.length < replayPageSize || replayed >= replayMaxEvents) {
            const snapshotRequired = replayed >= replayMaxEvents
              && readFrames(replayedThrough, 1, workspaceId).length > 0;
            finish(snapshotRequired);
            return;
          }
          again = true;
        } finally {
          leave();
        }
        if (again) setImmediate(step);
      };
      step();
    });
  }

  async function open(request, response, identity, lastEventId) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const workspaceId = identity.device?.workspaceId || 'local';
    let replayedThrough = 0;
    let snapshotRequired = false;
    if (Number.isSafeInteger(lastEventId) && lastEventId > 0) {
      const replay = await replaySince(lastEventId, workspaceId, (frame) => response.write(frame));
      replayedThrough = replay.replayedThrough;
      snapshotRequired = replay.snapshotRequired;
    }
    let uiRevision = '';
    if (typeof options.getUiRevision === 'function') {
      try {
        uiRevision = String(await options.getUiRevision() || '');
      } catch {
        uiRevision = '';
      }
    }
    response.write(`event: ready\ndata: ${JSON.stringify({
      now: Date.now(),
      latestEventId: runtimeService.latestEventId(),
      replayedThrough,
      snapshotRequired,
      uiRevision,
    })}\n\n`);
    const client = { response, workspaceId, deviceId: identity.device?.id || null };
    clients.add(client);
    const heartbeat = setInterval(() => response.write(`: heartbeat ${Date.now()}\n\n`), 20_000);
    heartbeat.unref?.();
    request.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
  }

  function closeDevice(deviceId) {
    for (const client of clients) {
      if (client.deviceId === deviceId) {
        client.response.end();
        clients.delete(client);
      }
    }
  }

  function closeAll() {
    for (const client of clients) client.response.end();
    clients.clear();
  }

  return Object.freeze({ closeAll, closeDevice, flush, open });
}
