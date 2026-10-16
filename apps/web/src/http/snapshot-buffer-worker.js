import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';

const db = new Database(workerData.databasePath, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');
const select = db.prepare(`SELECT generated_at, payload_json
  FROM runtime_snapshots WHERE workspace_id = ? AND snapshot_key = ?`);

function clientPayload(snapshotKey, text) {
  const raw = String(text ?? '');
  if (snapshotKey !== 'home-bootstrap' || !raw.includes('"timings"')) return raw;
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'timings')) return raw;
    delete body.timings;
    return JSON.stringify(body);
  } catch {
    return raw;
  }
}

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

parentPort.on('message', (message) => {
  if (!message || message.type !== 'poll') return;
  const updates = [];
  const transfer = [];
  const known = message.known || {};
  try {
    for (const item of message.keys || []) {
      const row = select.get(item.workspace, item.snapshotKey);
      if (!row?.payload_json) continue;
      const generatedAt = Number(row.generated_at) || 0;
      if (known[item.slot] === generatedAt) continue;
      const packed = pack(clientPayload(item.snapshotKey, row.payload_json));
      updates.push({
        slot: item.slot,
        generatedAt,
        etag: packed.etag,
        bytes: packed.bytes,
        json: packed.json,
        gzipped: packed.gzipped,
      });
      transfer.push(packed.json);
      if (packed.gzipped) transfer.push(packed.gzipped);
    }
    parentPort.postMessage({ type: 'slots', updates }, transfer);
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: String(error?.message || error) });
  }
});
