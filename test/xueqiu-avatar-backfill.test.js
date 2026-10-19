import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { normalizeXueqiuAvatar } from '../packages/connectors/src/xueqiu/home-browser.js';
import { backfillXueqiuAvatars, openXueqiuAvatarDatabase } from '../scripts/backfill-xueqiu-avatars.mjs';

test('xueqiu avatar backfill rewrites relative paths and can dry-run', () => {
  assert.equal(normalizeXueqiuAvatar('//xqimg.imedao.com/a.png'), 'https://xqimg.imedao.com/a.png');
  assert.equal(
    normalizeXueqiuAvatar('community/2017x/a.jpg,community/2017x/a.jpg!180x180.jpg'),
    'https://xavatar.imedao.com/community/2017x/a.jpg',
  );
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-xq-avatar-'));
  const file = path.join(directory, 'ai-center.db');
  const store = createStore(file);
  store.close();
  const database = openXueqiuAvatarDatabase(file);
  try {
    database.prepare(`INSERT INTO authors
      (workspace_id, author_id, platform, native_id, handle, name, avatar_url, profile_url, bio, kind, provisional, aliases_json, followed)
      VALUES
      ('local', 'xueqiu:1', 'xueqiu', '1', 'a', '甲', 'community/2017x/a.jpg,community/2017x/a.jpg!180x180.jpg', '', '', 'person', 0, '[]', 0),
      ('local', 'xueqiu:2', 'xueqiu', '2', 'b', '乙', 'https://xavatar.imedao.com/community/ok.jpg', '', '', 'person', 0, '[]', 0),
      ('local', 'x:1', 'x', '1', 'c', '丙', 'https://pbs.twimg.com/profile_images/a.jpg', '', '', 'person', 0, '[]', 0)`).run();
    database.prepare(`INSERT INTO captures
      (id, workspace_id, provider, external_id, source_url, title, content_hash, captured_at, metadata_json)
      VALUES (?, 'local', 'xueqiu', 'ext-1', '', '', 'hash-1', 1, ?)`).run(
      'cap-1',
      JSON.stringify({ authorProfile: { avatarUrl: 'community/2017x/b.jpg', name: '甲' } }),
    );
    const preview = backfillXueqiuAvatars(database, { dryRun: true });
    assert.equal(preview.authors, 1);
    assert.equal(preview.captures, 1);
    assert.equal(preview.dryRun, true);
    assert.match(database.prepare(`SELECT avatar_url FROM authors WHERE author_id = 'xueqiu:1'`).get().avatar_url, /^community\//);
    const applied = backfillXueqiuAvatars(database, { dryRun: false });
    assert.equal(applied.authors, 1);
    assert.equal(applied.captures, 1);
    assert.equal(
      database.prepare(`SELECT avatar_url FROM authors WHERE author_id = 'xueqiu:1'`).get().avatar_url,
      'https://xavatar.imedao.com/community/2017x/a.jpg',
    );
    assert.equal(
      database.prepare(`SELECT avatar_url FROM authors WHERE author_id = 'xueqiu:2'`).get().avatar_url,
      'https://xavatar.imedao.com/community/ok.jpg',
    );
    assert.equal(
      database.prepare(`SELECT avatar_url FROM authors WHERE author_id = 'x:1'`).get().avatar_url,
      'https://pbs.twimg.com/profile_images/a.jpg',
    );
    const metadata = JSON.parse(database.prepare(`SELECT metadata_json FROM captures WHERE id = 'cap-1'`).get().metadata_json);
    assert.equal(metadata.authorProfile.avatarUrl, 'https://xavatar.imedao.com/community/2017x/b.jpg');
    assert.equal(metadata.authorProfile.name, '甲');
    const again = backfillXueqiuAvatars(database, { dryRun: false });
    assert.equal(again.authors, 0);
    assert.equal(again.captures, 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
