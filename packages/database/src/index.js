import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mapPost(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    sourceUrl: row.source_url,
    tags: JSON.parse(row.tags_json || '[]'),
    createdByDevice: row.created_by_device,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDevice(row) {
  return {
    id: row.id,
    name: row.name,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export function createStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      paired_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS pairing_codes (
      code_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_by_device TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(created_by_device) REFERENCES devices(id)
    );

    CREATE TABLE IF NOT EXISTS behavior_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      event_name TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY(device_id) REFERENCES devices(id)
    );

    CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_devices_active ON devices(revoked_at, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_behavior_created_at ON behavior_events(created_at DESC);
  `);

  const postCount = database.prepare('SELECT COUNT(*) AS count FROM posts').get().count;
  if (postCount === 0) {
    const now = Date.now();
    database.prepare(`INSERT INTO posts
      (id, title, body, source_url, tags_json, created_by_device, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, NULL, ?, ?)`)
      .run(
        randomUUID(),
        'AI Center 已连接',
        '这条信息由本机发布，并已准备同步到鸿蒙手机。',
        JSON.stringify(['系统', '首发测试']),
        now,
        now,
      );
  }

  return {
    createPairingCode(ttlMinutes = 10) {
      const now = Date.now();
      database.prepare('UPDATE pairing_codes SET used_at = ? WHERE used_at IS NULL').run(now);
      const code = String(randomInt(100000, 1_000_000));
      const expiresAt = now + ttlMinutes * 60_000;
      database.prepare(`INSERT INTO pairing_codes (code_hash, expires_at, used_at, created_at)
        VALUES (?, ?, NULL, ?)`)
        .run(sha256(code), expiresAt, now);
      return { code, expiresAt };
    },

    redeemPairingCode(code, deviceName) {
      const now = Date.now();
      const codeHash = sha256(code);
      database.exec('BEGIN IMMEDIATE');
      try {
        const pairing = database.prepare(`SELECT code_hash, expires_at, used_at FROM pairing_codes
          WHERE code_hash = ?`).get(codeHash);
        if (!pairing || pairing.used_at || pairing.expires_at <= now) {
          database.exec('ROLLBACK');
          return null;
        }
        database.prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?').run(now, codeHash);
        const token = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
        const device = { id: randomUUID(), name: deviceName, pairedAt: now, lastSeenAt: now, revokedAt: null };
        database.prepare(`INSERT INTO devices
          (id, name, token_hash, paired_at, last_seen_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, NULL)`)
          .run(device.id, device.name, sha256(token), now, now);
        database.exec('COMMIT');
        return { device, token };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    authorizeToken(token) {
      if (!token) return null;
      const row = database.prepare(`SELECT id, name, paired_at, last_seen_at, revoked_at
        FROM devices WHERE token_hash = ? AND revoked_at IS NULL`).get(sha256(token));
      if (!row) return null;
      const now = Date.now();
      database.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, row.id);
      return { ...mapDevice(row), lastSeenAt: now };
    },

    listDevices() {
      return database.prepare(`SELECT id, name, paired_at, last_seen_at, revoked_at
        FROM devices ORDER BY paired_at DESC`).all().map(mapDevice);
    },

    revokeDevice(id) {
      const result = database.prepare(`UPDATE devices SET revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL`).run(Date.now(), id);
      return result.changes > 0;
    },

    listPosts(limit = 100) {
      return database.prepare(`SELECT id, title, body, source_url, tags_json,
        created_by_device, created_at, updated_at
        FROM posts ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(Number(limit) || 100, 200))).map(mapPost);
    },

    getPost(id) {
      const row = database.prepare(`SELECT id, title, body, source_url, tags_json,
        created_by_device, created_at, updated_at FROM posts WHERE id = ?`).get(id);
      return row ? mapPost(row) : null;
    },

    createPost(input, deviceId = null) {
      const now = Date.now();
      const post = {
        id: randomUUID(),
        ...input,
        createdByDevice: deviceId,
        createdAt: now,
        updatedAt: now,
      };
      database.prepare(`INSERT INTO posts
        (id, title, body, source_url, tags_json, created_by_device, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(post.id, post.title, post.body, post.sourceUrl, JSON.stringify(post.tags), deviceId, now, now);
      return post;
    },

    recordBehavior(name, deviceId = null, metadata = {}) {
      database.prepare(`INSERT INTO behavior_events
        (device_id, event_name, metadata_json, created_at) VALUES (?, ?, ?, ?)`)
        .run(deviceId, name, JSON.stringify(metadata), Date.now());
    },

    getMetrics() {
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const activeDevices = database.prepare(`SELECT COUNT(*) AS count FROM devices
        WHERE revoked_at IS NULL`).get().count;
      const counts = Object.fromEntries(database.prepare(`SELECT event_name, COUNT(*) AS count
        FROM behavior_events WHERE created_at >= ? GROUP BY event_name`).all(since)
        .map((row) => [row.event_name, row.count]));
      return {
        windowHours: 24,
        activeDevices,
        appOpens: counts['app.open'] || 0,
        feedsLoaded: counts['feed.loaded'] || 0,
        composerStarts: counts['composer.started'] || 0,
        detailsOpened: counts['post.opened'] || 0,
        published: counts['post.created'] || 0,
      };
    },

    close() {
      database.close();
    },
  };
}
