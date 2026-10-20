import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { parseContract } from '../../../../packages/contracts/src/errors.js';
import { emptyReadingHourPayload } from '../../../../packages/contracts/src/information-tree.js';
import { createStore } from '../../../../packages/database/src/index.js';
import { createFeedService } from '../../../../packages/domain/src/feed-service.js';
import { createHardwarePriceService } from '../../../../packages/domain/src/hardware-price-service.js';
import { createInformationTreeReader } from '../../../../packages/domain/src/information-tree-service.js';
import { createReadingHourService, readingHourSourceAccess } from '../../../../packages/domain/src/reading-hour-service.js';
import { createXSourceDefinition, createXueqiuSourceDefinition } from '../../../../packages/source/src/content/definitions.js';

function pack(text) {
  const raw = Buffer.from(String(text));
  const json = new Uint8Array(raw);
  let gzipped = null;
  if (raw.length >= 2048) {
    try {
      const zipped = gzipSync(raw);
      if (zipped.length < raw.length) gzipped = new Uint8Array(zipped);
    } catch {
      gzipped = null;
    }
  }
  return {
    json: json.buffer,
    gzipped: gzipped ? gzipped.buffer : null,
    etag: `W/"${createHash('sha1').update(raw).digest('hex')}"`,
    bytes: raw.length,
  };
}

function createReaders(databasePath) {
  const store = createStore(databasePath);
  const unused = { async getFeed() { return { items: [], fetchedAt: Date.now() }; } };
  const definitions = new Map([createXSourceDefinition(unused), createXueqiuSourceDefinition(unused)]
    .map((definition) => [definition.manifest.id, definition]));
  const sourcePort = {
    findByProvider(providerId, viewKind) {
      for (const definition of definitions.values()) {
        const manifest = definition.manifest;
        if (manifest.providerId === providerId && (!viewKind || manifest.viewKind === viewKind)) return manifest;
      }
      return null;
    },
    persistence(sourceId, input = {}) {
      const definition = definitions.get(sourceId);
      if (typeof definition?.persistence !== 'function') return null;
      return definition.persistence(parseContract(definition.inputSchema, input));
    },
  };
  return {
    store,
    feed: createFeedService({
      legacyRepository: store,
      feedRepository: store.repositories.feed,
      sourcePort,
      taggingRepository: store.repositories.tagging,
    }),
    informationTree: createInformationTreeReader({
      repository: store.repositories.informationTree,
      timezone: workerData.timezone || 'Asia/Shanghai',
      pipeline: workerData.pipeline === 'tree-v3' ? 'tree-v3' : 'legacy',
    }),
    readingHour: createReadingHourService({
      repository: store.repositories.informationTree,
      reportRepository: store.repositories.report,
      enabled: true,
      ...readingHourSourceAccess({ feed: store.repositories.feed, media: store.repositories.media }),
    }),
    hardwarePrices: createHardwarePriceService({
      repository: store.repositories.hardwarePrices,
      artifactStore: { save() { return ''; }, read() { return null; } },
    }),
  };
}

const readers = createReaders(workerData.databasePath);

async function run(task) {
  const workspace = task.workspace || 'local';
  if (task.kind === 'feed') {
    const feed = await readers.feed.getExternalFeed(task.providerId, task.query, { workspaceId: workspace });
    return { status: 200, payload: { ok: true, feed } };
  }
  if (task.kind === 'hardware-list') {
    const view = readers.hardwarePrices.list(workspace, task.query || {});
    return { status: 200, payload: { ok: true, ...view } };
  }
  if (task.kind === 'tree-edition') {
    const value = readers.informationTree.edition(workspace, task.id);
    if (!value) return { status: 404, payload: { ok: false, error: '刊期不存在' } };
    return { status: 200, payload: { ok: true, edition: value.edition, nodes: value.nodes } };
  }
  if (task.kind === 'tree-list') {
    const manifest = readers.informationTree.list(workspace, task.window);
    return { status: 200, payload: { ok: true, ...manifest } };
  }
  if (task.kind === 'reading-hour') {
    const snapshot = readers.readingHour.forWindow(workspace, { startAt: task.startAt, endAt: task.endAt }, task.scope || 'hour');
    if (!snapshot) return { status: 200, payload: emptyReadingHourPayload() };
    return { status: 200, payload: { ok: true, snapshot } };
  }
  if (task.kind === 'reading-index') {
    const index = readers.readingHour.indexForRange(workspace, { startAt: task.startAt, endAt: task.endAt }, task.scope || 'hour');
    return { status: 200, payload: { ok: true, ...index } };
  }
  return { status: 404, payload: { ok: false } };
}

function reply(id, status, payload) {
  const packed = pack(JSON.stringify(payload));
  const transfer = [packed.json];
  if (packed.gzipped) transfer.push(packed.gzipped);
  parentPort.postMessage({
    id,
    status,
    etag: packed.etag,
    bytes: packed.bytes,
    json: packed.json,
    gzipped: packed.gzipped,
  }, transfer);
}

parentPort.on('message', async (message) => {
  if (!message) return;
  if (message.type === 'ping') {
    parentPort.postMessage({ type: 'ready' });
    return;
  }
  if (message.type !== 'build') return;
  try {
    const outcome = await run(message.task || {});
    reply(message.id, outcome.status, outcome.payload);
  } catch (error) {
    reply(message.id, 502, { ok: false, error: String(error?.message || error).slice(0, 300) });
  }
});
