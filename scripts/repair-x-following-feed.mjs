import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { placeXPostsOnFollowing } from '../packages/domain/src/x-video-feed.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

const PAGE = 200;
const MAX_POSTS = 5000;

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function collectPosts(feedRepository, workspaceId) {
  const posts = [];
  let count = 0;
  for (let offset = 0; offset < MAX_POSTS; offset += PAGE) {
    const page = feedRepository.listXPostsOffFollowing(workspaceId, { limit: PAGE, offset });
    const rows = Array.isArray(page?.posts) ? page.posts : [];
    count = Number(page?.count) || count;
    posts.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { count, posts };
}

export function backupRows(posts) {
  return (posts || []).map((row) => ({
    captureId: String(row?.captureId || ''),
    sourceAccountId: row?.sourceAccountId || null,
    externalId: String(row?.externalId || ''),
  })).filter((row) => row.captureId);
}

export function writeFollowingBackup(filePath, { workspaceId, posts }) {
  const target = path.resolve(filePath);
  if (path.extname(target).toLowerCase() !== '.json') {
    throw new Error('备份文件要用 .json');
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const body = {
    workspaceId,
    createdAt: new Date().toISOString(),
    posts: backupRows(posts),
  };
  writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx' });
  return { backupPath: target, backedUp: body.posts.length };
}

export function readFollowingBackup(filePath) {
  const target = path.resolve(filePath);
  if (path.extname(target).toLowerCase() !== '.json') {
    throw new Error('回滚文件要用 .json');
  }
  const parsed = JSON.parse(readFileSync(target, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.posts)) {
    throw new Error('备份里没有 posts');
  }
  return {
    workspaceId: String(parsed.workspaceId || ''),
    posts: backupRows(parsed.posts),
  };
}

export function rollbackFollowingFeed({
  store,
  workspaceId = 'local',
  backupPath,
} = {}) {
  const backup = readFollowingBackup(backupPath);
  if (backup.workspaceId && backup.workspaceId !== workspaceId) {
    throw new Error('备份里的 workspace 和 --workspace 不一致');
  }
  const feedRepository = store.repositories.feed;
  let restored = 0;
  let missing = 0;
  let missingAccount = 0;
  for (const row of backup.posts) {
    const result = feedRepository.restoreCaptureSource(workspaceId, row.captureId, row.sourceAccountId);
    if (result?.status === 'restored') restored += 1;
    else if (result?.status === 'missing-account') missingAccount += 1;
    else missing += 1;
  }
  return {
    status: restored ? 'restored' : 'done',
    restored,
    missing,
    missingAccount,
    backupPath: path.resolve(backupPath),
  };
}

function defaultBackupPath() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return path.join('data', `x-following-repair-backup-${stamp}.json`);
}

export function repairFollowingFeed({
  store,
  workspaceId = 'local',
  dryRun = false,
  backupPath = '',
} = {}) {
  const feedRepository = store.repositories.feed;
  const collected = collectPosts(feedRepository, workspaceId);
  const examples = collected.posts.slice(0, 8).map((row) => ({
    captureId: row.captureId || '',
    externalId: row.externalId || '',
    sourceAccountId: row.sourceAccountId || null,
    sourceExternalId: row.sourceExternalId || '',
  }));
  if (dryRun) {
    return {
      status: 'dry-run',
      count: collected.count,
      moved: 0,
      examples,
    };
  }
  const target = backupPath || defaultBackupPath();
  const backup = writeFollowingBackup(target, { workspaceId, posts: collected.posts });
  const placed = placeXPostsOnFollowing({
    feedRepository,
    workspaceId,
    posts: collected.posts,
  });
  return {
    status: placed.moved ? 'moved' : (placed.status || 'done'),
    count: collected.count,
    moved: placed.moved || 0,
    examples,
    sourceAccountId: placed.sourceAccountId || '',
    backupPath: backup.backupPath,
    backedUp: backup.backedUp,
  };
}

if (isMain(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const rollbackPath = arg('--rollback', '');
  const workspaceId = arg('--workspace', 'local') || 'local';
  const backupPath = arg('--backup', '');
  if (dryRun && rollbackPath) {
    console.error('[x-following] --dry-run 和 --rollback 不能一起用');
    process.exitCode = 1;
  } else {
    const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
    const store = createStore(instance.databasePath);
    try {
      const result = rollbackPath
        ? rollbackFollowingFeed({ store, workspaceId, backupPath: rollbackPath })
        : repairFollowingFeed({ store, workspaceId, dryRun, backupPath });
      if (!rollbackPath && !dryRun) {
        console.log(`[x-following] 回滚：node scripts/repair-x-following-feed.mjs --rollback ${result.backupPath}`);
      }
      console.log(`[x-following] ${JSON.stringify(result)}`);
    } catch (error) {
      console.error(`[x-following] ${error instanceof Error ? error.message : '补挂失败'}`);
      process.exitCode = 1;
    } finally {
      store.close();
    }
  }
}
