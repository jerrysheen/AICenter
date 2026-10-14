export const CLIENT_ERROR_ENDPOINT = '/api/v1/runtime/client-error';
const DEDUPE_MS = 60_000;
const sentAt = new Map();

export function clientErrorPayload(input) {
  const kind = String(input?.kind || '').trim().slice(0, 40);
  const path = String(input?.path || '').split('#')[0].trim().slice(0, 180);
  if (!/^[a-z0-9._-]{1,40}$/i.test(kind)) return null;
  if (!path.startsWith('/')) return null;
  const status = Number(input?.status);
  const detail = String(input?.detail || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
  return {
    kind,
    path,
    status: Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0,
    detail,
  };
}

export function shouldSendClientError(payload, now = Date.now(), windowMs = DEDUPE_MS) {
  if (!payload) return false;
  const key = `${payload.kind}|${payload.status}|${payload.path}`;
  const previous = sentAt.get(key);
  if (previous && now - previous < windowMs) return false;
  sentAt.set(key, now);
  return true;
}

export function postClientError(input, transport, now = Date.now()) {
  const payload = clientErrorPayload(input);
  if (!shouldSendClientError(payload, now)) return false;
  const body = JSON.stringify(payload);
  const fetchImpl = transport?.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return false;
  try {
    const result = fetchImpl(CLIENT_ERROR_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return true;
  } catch {
    return false;
  }
}
