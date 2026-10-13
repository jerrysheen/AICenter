import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { labelEventLoop } from './event-loop-blocks.js';
import { json } from './response.js';
import { createStaleReadCache } from './stale-read-cache.js';

const gzipBuffer = promisify(gzip);

function acceptsGzip(request, response) {
  const header = request?.headers?.['accept-encoding'] || response?.req?.headers?.['accept-encoding'] || '';
  return String(header).split(',').some((part) => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.find((value) => /^\s*q\s*=/i.test(value));
    return name.toLowerCase() === 'gzip' && (!quality || Number(quality.split('=')[1]) > 0);
  });
}

async function packJsonBuffer(raw) {
  let gzipped = null;
  if (raw.length >= 2048) {
    try {
      const zipped = await gzipBuffer(raw);
      gzipped = zipped.length < raw.length ? zipped : null;
    } catch {
      gzipped = null;
    }
  }
  return {
    json: raw,
    gzipped,
    etag: `W/"${createHash('sha1').update(raw).digest('hex')}"`,
    bytes: raw.length,
  };
}

export async function prepareJsonText(text) {
  return packJsonBuffer(Buffer.from(String(text ?? '')));
}

export async function prepareJsonBody(payload) {
  const leave = labelEventLoop('json.stringify');
  let json;
  try {
    json = JSON.stringify(payload);
  } finally {
    leave();
  }
  return packJsonBuffer(Buffer.from(json));
}

function ifNoneMatch(request, etag) {
  const header = String(request?.headers?.['if-none-match'] || '').trim();
  if (!header) return false;
  if (header === '*') return true;
  const wanted = etag.replace(/^W\//, '');
  return header.split(',').some((part) => part.trim().replace(/^W\//, '') === wanted);
}

export function createPreparedResponseCache({ ttlMs = 15_000, refreshLeadMs = 5_000, now } = {}) {
  const cache = createStaleReadCache({ ttlMs, refreshLeadMs, now });
  return async function sendCachedJson(request, response, key, produce) {
    const prepared = await cache.get(key, async () => {
      const produced = await produce();
      if (produced?.httpStatus && produced.httpStatus !== 200) return null;
      const payload = produced?.httpStatus ? produced.payload : produced;
      const packed = await prepareJsonBody(payload);
      packed.status = 200;
      return packed;
    });
    if (!prepared) {
      json(response, 404, { ok: false });
      return;
    }
    const headers = { ETag: prepared.etag, 'Cache-Control': 'no-store' };
    if (ifNoneMatch(request, prepared.etag)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    sendPreparedJson(request, response, prepared.status || 200, prepared, headers);
  };
}

export function sendPreparedJson(request, response, status, prepared, headers = {}) {
  const useGzip = Boolean(prepared?.gzipped && acceptsGzip(request, response));
  const body = useGzip ? prepared.gzipped : prepared.json;
  const outgoing = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    Vary: 'Accept-Encoding',
    ...(useGzip ? { 'Content-Encoding': 'gzip' } : {}),
    ...headers,
  };
  response.writeHead(status, outgoing);
  response.end(body);
}
