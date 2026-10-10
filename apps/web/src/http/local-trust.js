const PROXY_HEADER = /^(cf-|cdn-loop$|x-forwarded-|x-real-ip$|forwarded$|true-client-ip$|x-original-)/;

export function isLoopbackAddress(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function hasProxyHeaders(headers = {}) {
  return Object.keys(headers).some((name) => PROXY_HEADER.test(String(name).toLowerCase()));
}

export function isLocalHost(hostHeader, port) {
  const host = String(hostHeader || '').trim().toLowerCase();
  const numericPort = Number(port);
  const withPort = Number.isInteger(numericPort) && numericPort > 0
    ? [`127.0.0.1:${numericPort}`, `localhost:${numericPort}`, `[::1]:${numericPort}`]
    : [];
  return [...withPort, '127.0.0.1', 'localhost', '[::1]'].includes(host);
}

export function isCrossSiteBrowserWrite(request, port) {
  const method = String(request?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const headers = request?.headers || {};
  const site = String(headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = String(headers.origin || '').trim().toLowerCase();
  if (!origin) return false;
  const numericPort = Number(port);
  const allowed = new Set([
    `http://127.0.0.1:${numericPort}`,
    `http://localhost:${numericPort}`,
    `http://[::1]:${numericPort}`,
  ]);
  return !allowed.has(origin);
}

export function isTrustedLocal(request, port) {
  return isLoopbackAddress(request?.socket?.remoteAddress)
    && !hasProxyHeaders(request?.headers)
    && isLocalHost(request?.headers?.host, port)
    && !isCrossSiteBrowserWrite(request, port);
}
