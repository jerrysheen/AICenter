import { createHash } from 'node:crypto';
import { sendPreparedJson } from './prepared-json.js';

const PENDING_JSON = Buffer.from('{"ok":true,"pending":true}');

export const PENDING_PREPARED = Object.freeze({
  json: PENDING_JSON,
  gzipped: null,
  etag: `W/"${createHash('sha1').update(PENDING_JSON).digest('hex')}"`,
  bytes: PENDING_JSON.length,
  generatedAt: 0,
  pending: true,
});

function ifNoneMatch(request, etag) {
  const header = String(request?.headers?.['if-none-match'] || '').trim();
  if (!header || !etag) return false;
  if (header === '*') return true;
  const wanted = etag.replace(/^W\//, '');
  return header.split(',').some((part) => part.trim().replace(/^W\//, '') === wanted);
}

export function packPreparedJson(text, { etag, generatedAt = 0 } = {}) {
  const json = Buffer.isBuffer(text) ? text : Buffer.from(String(text ?? ''));
  return {
    json,
    gzipped: null,
    etag: etag || `W/"${createHash('sha1').update(json).digest('hex')}"`,
    bytes: json.length,
    generatedAt: Number(generatedAt) || 0,
    pending: false,
  };
}

export function createPreparedSlotStore() {
  const slots = new Map();
  const stats = { hit: 0, pending: 0 };

  return {
    publish(key, prepared) {
      if (!key || !prepared?.json) return;
      const json = Buffer.isBuffer(prepared.json) ? prepared.json : Buffer.from(prepared.json);
      slots.set(String(key), {
        json,
        gzipped: prepared.gzipped
          ? (Buffer.isBuffer(prepared.gzipped) ? prepared.gzipped : Buffer.from(prepared.gzipped))
          : null,
        etag: prepared.etag || `W/"${createHash('sha1').update(json).digest('hex')}"`,
        bytes: Number(prepared.bytes) || json.length,
        generatedAt: Number(prepared.generatedAt) || 0,
        pending: false,
      });
    },
    get(key) {
      return slots.get(String(key)) || null;
    },
    stats() {
      return { hit: stats.hit, pending: stats.pending, size: slots.size };
    },
    send(request, response, key, { headers = {}, allow304 = true } = {}) {
      const slot = slots.get(String(key)) || null;
      const prepared = slot || PENDING_PREPARED;
      if (slot) stats.hit += 1;
      else stats.pending += 1;
      const outgoing = {
        ETag: prepared.etag,
        'Cache-Control': 'private, no-cache',
        ...headers,
      };
      if (allow304 && ifNoneMatch(request, prepared.etag)) {
        response.writeHead(304, outgoing);
        response.end();
        return prepared;
      }
      sendPreparedJson(request, response, 200, prepared, outgoing);
      return prepared;
    },
  };
}
