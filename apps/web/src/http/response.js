import { ValidationError } from '../../../../packages/contracts/src/index.js';
import { gzipSync } from 'node:zlib';

export function json(response, status, payload, headers = {}, { compress = false } = {}) {
  let body = JSON.stringify(payload);
  let encoding = '';
  const acceptsGzip = String(response.req?.headers?.['accept-encoding'] || '').split(',').some(part => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.find(value => /^\s*q\s*=/i.test(value));
    return name.toLowerCase() === 'gzip' && (!quality || Number(quality.split('=')[1]) > 0);
  });
  if (compress && acceptsGzip && Buffer.byteLength(body) >= 2048) {
    const zipped = gzipSync(body);
    if (zipped.length < Buffer.byteLength(body)) { body = zipped; encoding = 'gzip'; }
  }
  const outgoing = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(compress ? { Vary: 'Accept-Encoding' } : {}),
    ...(encoding ? { 'Content-Encoding': encoding } : {}),
    ...headers,
  };
  if (outgoing['Set-Cookie'] !== undefined && !Array.isArray(outgoing['Set-Cookie'])) {
    outgoing['Set-Cookie'] = [outgoing['Set-Cookie']];
  }
  response.writeHead(status, outgoing);
  response.end(body);
}

export async function readJson(request, { maxBytes = 128 * 1024 } = {}) {
  const limit = Math.max(1024, Number(maxBytes) || 128 * 1024);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ValidationError('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('请求不是有效 JSON');
  }
}

export function sendBytes(response, bytes, contentType, headers = {}) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'private, max-age=3600',
    ...headers,
  });
  response.end(body);
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return ['', ''];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}
