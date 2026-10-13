import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { labelEventLoop } from './event-loop-blocks.js';

const gzipBuffer = promisify(gzip);

function acceptsGzip(request) {
  return String(request?.headers?.['accept-encoding'] || '').split(',').some((part) => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.find((value) => /^\s*q\s*=/i.test(value));
    return name.toLowerCase() === 'gzip' && (!quality || Number(quality.split('=')[1]) > 0);
  });
}

export async function prepareJsonBody(payload) {
  const leave = labelEventLoop('json.stringify');
  let json;
  try {
    json = JSON.stringify(payload);
  } finally {
    leave();
  }
  const raw = Buffer.from(json);
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

export function sendPreparedJson(request, response, status, prepared, headers = {}) {
  const useGzip = Boolean(prepared?.gzipped && acceptsGzip(request));
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
