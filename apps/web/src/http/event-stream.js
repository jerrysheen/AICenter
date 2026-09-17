const REPLAY_PAGE_SIZE = 200;
const REPLAY_MAX_EVENTS = 10_000;

export const SSE_REPLAY_PAGE_SIZE = REPLAY_PAGE_SIZE;
export const SSE_REPLAY_MAX_EVENTS = REPLAY_MAX_EVENTS;

export function createEventStreamHub(runtimeService, options = {}) {
  const replayPageSize = Math.max(1, Number(options.replayPageSize) || REPLAY_PAGE_SIZE);
  const replayMaxEvents = Math.max(1, Number(options.replayMaxEvents) || REPLAY_MAX_EVENTS);
  const clients = new Set();
  let eventCursor = runtimeService.latestEventId();
  let flushing = false;

  function eventFrame(event) {
    return `id: ${event.id}\nevent: ${event.name}\ndata: ${JSON.stringify(event.payload)}\n\n`;
  }

  function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (true) {
        const events = runtimeService.listEvents(eventCursor, 200);
        if (!events.length) break;
        for (const event of events) {
          eventCursor = event.id;
          const frame = eventFrame(event);
          for (const client of clients) {
            if (client.workspaceId === event.workspaceId) client.response.write(frame);
          }
        }
        if (events.length < 200) break;
      }
    } finally {
      flushing = false;
    }
  }

  function replaySince(lastEventId, workspaceId, write) {
    let replayedThrough = lastEventId;
    let replayed = 0;
    while (replayed < replayMaxEvents) {
      const events = runtimeService.listEvents(replayedThrough, replayPageSize, workspaceId);
      if (!events.length) break;
      for (const event of events) {
        replayedThrough = event.id;
        write(eventFrame(event));
        replayed += 1;
        if (replayed >= replayMaxEvents) break;
      }
      if (events.length < replayPageSize) break;
    }
    let snapshotRequired = false;
    if (replayed >= replayMaxEvents) {
      snapshotRequired = runtimeService.listEvents(replayedThrough, 1, workspaceId).length > 0;
    }
    return { replayedThrough, snapshotRequired, replayed };
  }

  function open(request, response, identity, lastEventId) {
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
      const replay = replaySince(lastEventId, workspaceId, (frame) => response.write(frame));
      replayedThrough = replay.replayedThrough;
      snapshotRequired = replay.snapshotRequired;
    }
    response.write(`event: ready\ndata: ${JSON.stringify({
      now: Date.now(),
      latestEventId: runtimeService.latestEventId(),
      replayedThrough,
      snapshotRequired,
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
