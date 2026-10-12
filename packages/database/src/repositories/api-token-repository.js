function mapToken(row, { includeHash = false } = {}) {
  const token = {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    prefix: row.token_prefix,
    createdByDeviceId: row.created_by_device_id || null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
    revokedAt: row.revoked_at ?? null,
  };
  if (includeHash) token.tokenHash = row.token_hash;
  return token;
}

function mapAccess(row) {
  return {
    tokenId: row.token_id,
    method: row.method,
    path: row.path,
    status: row.status,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}

export function createApiTokenRepository(database) {
  const insertToken = database.prepare(`INSERT INTO api_access_tokens
    (id, workspace_id, name, token_hash, token_prefix, created_by_device_id, created_at, last_used_at, revoked_at)
    VALUES (@id, @workspaceId, @name, @tokenHash, @tokenPrefix, @createdByDeviceId, @createdAt, NULL, NULL)`);
  const listActive = database.prepare(`SELECT id, workspace_id, name, token_prefix, created_by_device_id,
      created_at, last_used_at, revoked_at
    FROM api_access_tokens
    WHERE workspace_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC`);
  const findByHash = database.prepare(`SELECT id, workspace_id, name, token_hash, token_prefix,
      created_by_device_id, created_at, last_used_at, revoked_at
    FROM api_access_tokens WHERE token_hash = ?`);
  const revokeToken = database.prepare(`UPDATE api_access_tokens SET revoked_at = ?
    WHERE id = ? AND revoked_at IS NULL`);
  const touchLastUsed = database.prepare(`UPDATE api_access_tokens SET last_used_at = ?
    WHERE id = ? AND revoked_at IS NULL`);
  const insertAccess = database.prepare(`INSERT INTO api_token_access_log
    (token_id, method, path, status, latency_ms, created_at)
    VALUES (@tokenId, @method, @path, @status, @latencyMs, @createdAt)`);
  const pruneAccess = database.prepare('DELETE FROM api_token_access_log WHERE created_at < ?');
  const listAccess = database.prepare(`SELECT token_id, method, path, status, latency_ms, created_at
    FROM api_token_access_log WHERE token_id = ? ORDER BY id DESC LIMIT ?`);

  return Object.freeze({
    insert(input) {
      insertToken.run({
        id: input.id,
        workspaceId: input.workspaceId,
        name: input.name,
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix,
        createdByDeviceId: input.createdByDeviceId || null,
        createdAt: input.createdAt,
      });
      return {
        id: input.id,
        workspaceId: input.workspaceId,
        name: input.name,
        prefix: input.tokenPrefix,
        createdByDeviceId: input.createdByDeviceId || null,
        createdAt: input.createdAt,
        lastUsedAt: null,
        revokedAt: null,
      };
    },
    list(workspaceId) {
      return listActive.all(workspaceId).map((row) => mapToken(row));
    },
    findByHash(tokenHash) {
      const row = findByHash.get(tokenHash);
      return row ? mapToken(row, { includeHash: true }) : null;
    },
    revoke(id, revokedAt) {
      return revokeToken.run(revokedAt, id).changes > 0;
    },
    touchLastUsed(id, seenAt) {
      touchLastUsed.run(seenAt, id);
    },
    insertAccess(entry) {
      insertAccess.run(entry);
    },
    pruneAccess(before) {
      return pruneAccess.run(before).changes;
    },
    listAccess(tokenId, limit = 20) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
      return listAccess.all(tokenId, safeLimit).map(mapAccess);
    },
  });
}
