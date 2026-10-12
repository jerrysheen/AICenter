import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createConfiguredBrowserRuntime } from '../../packages/connectors/src/browser/index.js';
import { createXueqiuStockDiscussionClient } from '../../packages/connectors/src/xueqiu/stock-discussion.js';
import {
  buildDiscussionTargets,
  discussionDayWindow,
  resolveInvestorThemes,
} from '../../packages/domain/src/investor-discussion.js';
import { loadDigestMaterials, materialsFromCollection } from '../../packages/domain/src/investor-digest-ab.js';
import { loadInstanceEnvironment, resolveInstanceConfig } from '../../packages/instance/src/index.js';
import { investorDigestRuntimeConfig } from '../../packages/runtime/src/investor-discussion-job.js';
import { experimentPaths } from './investor-digest-ab.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function arg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] || '';
  return '';
}

export function listDiscussionHoldings(database, workspaceId = 'local') {
  return database.prepare(`SELECT i.symbol AS symbol, i.name AS name, i.exchange_code AS exchangeCode,
      l.board AS board, a.provider_symbol AS yahoo
    FROM holding_lots l
    JOIN instruments i ON i.id = l.instrument_id
    LEFT JOIN instrument_aliases a ON a.instrument_id = i.id AND a.provider_id = 'yahoo'
    WHERE l.workspace_id = ? AND l.archived_at IS NULL
    ORDER BY i.name, i.symbol, a.provider_symbol`).all(workspaceId);
}

function openReadonly(databasePath) {
  try {
    return new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new Error(`无法只读打开数据库 ${databasePath}。${error?.message || error}`);
  }
}

function writeMaterials(file, materials) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(materials, null, 2)}\n`);
}

export async function main(argvEnv = process.env) {
  loadInstanceEnvironment({ repositoryRoot: root, env: argvEnv });
  const config = resolveInstanceConfig({ repositoryRoot: root, env: argvEnv });
  const date = arg('date') || '2026-10-12';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date 需要 YYYY-MM-DD');
  const fetchAgain = process.argv.includes('--fetch');
  const paths = experimentPaths(date, root);
  const output = arg('output') ? path.resolve(arg('output')) : paths.materials;
  const database = openReadonly(config.databasePath);
  let stored;
  let holdings = [];
  try {
    stored = loadDigestMaterials(database, 'local', date);
    if (fetchAgain) holdings = listDiscussionHoldings(database, 'local');
  } finally {
    database.close();
  }
  if (stored.stored && !fetchAgain) {
    writeMaterials(output, stored.materials);
    console.log(`已从数据库只读导出 ${date} 的原始帖子：${output}`);
    return { output, source: 'database' };
  }
  if (!fetchAgain) {
    const error = new Error([
      stored.reason,
      '必须重新抓取。这次抓取只写 JSON，不写日摘表。',
      `node scripts/experiments/export-investor-discussion.mjs --date ${date} --fetch`,
    ].join('\n'));
    error.code = 'refetch_required';
    throw error;
  }
  const runtime = investorDigestRuntimeConfig(argvEnv);
  const themes = resolveInvestorThemes(argvEnv);
  const built = buildDiscussionTargets({ holdings, themes });
  console.log(`重新抓取 ${date}，标的 ${built.targets.length} 个。只写 JSON，不写日摘表。`);
  const client = createXueqiuStockDiscussionClient({
    browserRuntime: createConfiguredBrowserRuntime({ env: argvEnv }),
    intervalMs: runtime.intervalMs,
    intervalJitterMs: runtime.intervalJitterMs,
    retries: runtime.retries,
    maxPages: runtime.maxPages,
    maxCommentPages: runtime.maxCommentPages,
    commentPosts: runtime.commentPosts,
  });
  const results = await client.collectAll(built.targets, discussionDayWindow(date, runtime.timeZone));
  const materials = materialsFromCollection(date, built.targets, results, 'xueqiu-refetch');
  if (built.unmapped.length) {
    materials.targets.push(...built.unmapped.map((item) => ({
      kind: 'holding',
      key: item.key,
      name: item.name,
      posts: [],
      comments: [],
      failed: true,
      reason: item.reason,
    })));
  }
  writeMaterials(output, materials);
  const posts = materials.targets.reduce((sum, target) => sum + target.posts.length, 0);
  const comments = materials.targets.reduce((sum, target) => sum + target.comments.length, 0);
  console.log(`已写入 ${output}。帖子 ${posts}，评论 ${comments}。`);
  return { output, source: 'xueqiu-refetch', posts, comments };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = error?.code === 'refetch_required' ? 2 : 1;
  });
}
