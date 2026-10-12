import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { API_TOKEN_PREFIX, ApiTokenViewSchema, CreateApiTokenInputSchema } from '../../contracts/src/api-tokens.js';
import { parseContract } from '../../contracts/src/errors.js';

const DUMMY_HASH = createHash('sha256').update('aic_absent', 'utf8').digest('hex');
const WINDOW_MS = 60_000;

export function hashApiToken(token) {
  return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

export function tokenHashesEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function redactApiTokenText(value) {
  return String(value ?? '').replace(/aic_[A-Za-z0-9_-]{8,}/g, 'aic_[redacted]');
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function toView(token) {
  return parseContract(ApiTokenViewSchema, {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt ?? null,
    revokedAt: token.revokedAt ?? null,
  });
}

export function createApiTokenService({
  repository,
  ratePerMinute = 60,
  logRetentionDays = 14,
  now = () => Date.now(),
} = {}) {
  if (!repository?.insert || !repository?.findByHash) throw new Error('api token repository is required');
  const limit = boundedInt(ratePerMinute, 60, 1, 10_000);
  const retentionMs = boundedInt(logRetentionDays, 14, 1, 365) * 86_400_000;
  const windows = new Map();
  let lastPruneAt = 0;

  function viewOf(token) {
    return toView(token);
  }

  return Object.freeze({
    issue({ name, workspaceId = 'local', deviceId = null } = {}) {
      const input = parseContract(CreateApiTokenInputSchema, { name });
      const secret = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      const token = repository.insert({
        id: randomUUID(),
        workspaceId,
        name: input.name,
        tokenHash: hashApiToken(secret),
        tokenPrefix: secret.slice(0, 12),
        createdByDeviceId: deviceId,
        createdAt: now(),
      });
      return { token: viewOf(token), secret };
    },
    list(workspaceId = 'local') {
      return repository.list(workspaceId).map(viewOf);
    },
    revoke(id) {
      return repository.revoke(id, now());
    },
    authorize(presented) {
      const hash = hashApiToken(presented);
      const row = repository.findByHash(hash);
      const equal = tokenHashesEqual(hash, row?.tokenHash || DUMMY_HASH);
      if (!equal || !row) return { token: null, matchedId: null, revoked: false };
      if (row.revokedAt) return { token: null, matchedId: row.id, revoked: true };
      return { token: viewOf(row), matchedId: row.id, revoked: false };
    },
    consume(tokenId, at = now()) {
      let state = windows.get(tokenId);
      if (!state || at - state.start >= WINDOW_MS) {
        state = { start: at, count: 0 };
        windows.set(tokenId, state);
      }
      if (windows.size > 5_000) {
        for (const [key, entry] of windows) {
          if (at - entry.start >= WINDOW_MS) windows.delete(key);
        }
      }
      state.count += 1;
      if (state.count > limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((state.start + WINDOW_MS - at) / 1000)),
        };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
    recordAccess(entry) {
      const at = now();
      const path = redactApiTokenText(entry.path).slice(0, 512);
      repository.insertAccess({
        tokenId: entry.tokenId,
        method: String(entry.method || 'GET').slice(0, 8),
        path,
        status: Number(entry.status) || 0,
        latencyMs: Math.max(0, Math.round(Number(entry.latencyMs) || 0)),
        createdAt: at,
      });
      if (entry.touch !== false) repository.touchLastUsed(entry.tokenId, at);
      if (at - lastPruneAt >= WINDOW_MS) {
        lastPruneAt = at;
        repository.pruneAccess(at - retentionMs);
      }
    },
  });
}
