const KEY_MAX = 64;

function snapshotKey(value) {
  const key = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key) || key.length > KEY_MAX) {
    throw new TypeError('快照键无效');
  }
  return key;
}

function workspaceId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 64) throw new TypeError('工作区无效');
  return id;
}

export function createRuntimeSnapshotRepository(database) {
  const upsert = database.prepare(`INSERT INTO runtime_snapshots
    (workspace_id, snapshot_key, generated_at, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, snapshot_key) DO UPDATE SET
      generated_at = excluded.generated_at,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at`);
  const select = database.prepare(`SELECT generated_at, payload_json, updated_at
    FROM runtime_snapshots WHERE workspace_id = ? AND snapshot_key = ?`);

  return {
    saveSnapshot(workspace, key, payload, generatedAt = Date.now()) {
      const at = Number(generatedAt);
      if (!Number.isInteger(at) || at < 0) throw new TypeError('快照时间无效');
      const json = JSON.stringify(payload ?? null);
      upsert.run(workspaceId(workspace), snapshotKey(key), at, json, Date.now());
    },
    readSnapshot(workspace, key) {
      const row = select.get(workspaceId(workspace), snapshotKey(key));
      if (!row) return null;
      try {
        const payload = JSON.parse(row.payload_json);
        if (!payload || typeof payload !== 'object') return null;
        return {
          generatedAt: Number(row.generated_at),
          updatedAt: Number(row.updated_at),
          payload,
        };
      } catch {
        return null;
      }
    },
  };
}
