import { createTypeSafeSystemOneClient } from '../packages/connectors/src/typesafe-system-one.js';
import { createStore } from '../packages/database/src/index.js';
import { resolveFeedFilterConfig } from '../packages/domain/src/feed-filter.js';
import { loadXFocusConfig } from '../packages/domain/src/x-focus.js';
import { admitHeldCapture, createReplayEvaluator, JEV_REPLAY_REASONS, reevaluateHeldCaptures } from '../packages/domain/src/jev-replay.js';
import { openJevClient, resolveJevEnabled } from '../packages/domain/src/jev-enabled.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';
import { createArticleDedup } from '../packages/domain/src/article-dedup.js';
import { enqueueTreePreparation } from '../packages/runtime/src/information-tree-module.js';
import { FEED_ITEMS_ENRICH_JOB_TYPE } from '../packages/runtime/src/feed-automation-module.js';

const ENRICH_BATCH = 200;

export function enqueueReplayFollowups(store, workspaceId, itemIds = []) {
  const ids = [...new Set(itemIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length || !store?.createJob) return { tree: [], enrich: [] };
  const tree = enqueueTreePreparation(store, workspaceId, ids.map((id) => `feed:${id}`)) || [];
  const enrich = [];
  for (let index = 0; index < ids.length; index += ENRICH_BATCH) {
    enrich.push(store.createJob({
      type: FEED_ITEMS_ENRICH_JOB_TYPE,
      workspaceId,
      maxAttempts: 2,
      input: { workspaceId, resourceIds: ids.slice(index, index + ENRICH_BATCH) },
    }));
  }
  return { tree, enrich };
}

function replayReasons(value) {
  const selected = String(value || 'jev-failed').split(',').map((reason) => reason.trim()).filter((reason) => JEV_REPLAY_REASONS.includes(reason));
  return selected.length ? selected : ['jev-failed'];
}

function arg(name, fallback = '') {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  if (!next || next.startsWith('--')) return 'true';
  return next;
}

function has(name) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runJevCaptureReplay({
  store,
  workspaceId = 'local',
  from = 0,
  to = Number.MAX_SAFE_INTEGER,
  mode = 'fallback',
  dryRun = false,
  concurrency = 1,
  intervalMs = 0,
  limit = 500,
  reasons = ['jev-failed'],
  env = process.env,
  xFocusConfig = null,
  articleDedup = null,
} = {}) {
  const jevEnabled = resolveJevEnabled(env);
  const config = resolveFeedFilterConfig(env);
  const forcedFallback = !jevEnabled || mode !== 'jev';
  let evaluator = null;
  if (!forcedFallback) {
    const client = openJevClient(env, undefined, (options) => createTypeSafeSystemOneClient({ ...options, timeoutMs: 30_000 }));
    evaluator = createReplayEvaluator(client, client?.modelId || '');
    if (!evaluator) throw new Error('AI_CENTER_JEV_ENABLED=false，补评不会创建 TypeSafe 客户端');
  }
  const captures = store.repositories.feed.listJevFailedCaptures(workspaceId, { from, to, limit, reasons });
  const dedup = articleDedup || createArticleDedup({
    mediaRepository: store.repositories.media,
    feedRepository: store.repositories.feed,
  });
  const width = Math.max(1, Math.min(4, Number(concurrency) || 1));
  let cursor = 0;
  const results = [];
  const admitted = [];
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= captures.length) return;
      if (intervalMs > 0) await sleep(intervalMs);
      const [result] = await reevaluateHeldCaptures({
        captures: [captures[index]],
        mode: forcedFallback ? 'fallback' : 'jev',
        jevEnabled,
        xFocusConfig,
        xFocusMin: config.xFocusMin,
        evaluator,
        dryRun,
        onKeep: async (capture, reason, evaluation) => {
          const saved = await admitHeldCapture({
            feedRepository: store.repositories.feed,
            capture,
            reason,
            evaluation,
            articleDedup: dedup,
            transaction: (work) => store.transaction(work),
          });
          if (saved?.item?.id) admitted.push(saved.item.id);
        },
      });
      results[index] = result;
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, captures.length || 1) }, () => worker()));
  const followups = dryRun ? { tree: [], enrich: [] } : enqueueReplayFollowups(store, workspaceId, admitted);
  return {
    mode: forcedFallback ? 'fallback' : 'jev',
    dryRun,
    reasons,
    total: captures.length,
    admitted: admitted.length,
    treeJobs: followups.tree.length,
    enrichJobs: followups.enrich.length,
    results: results.filter(Boolean),
  };
}

async function main() {
  const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
  const store = createStore(instance.databasePath);
  const env = process.env;
  let xFocusConfig = null;
  try { xFocusConfig = loadXFocusConfig(instance.configDirectory); } catch { xFocusConfig = null; }
  try {
    const report = await runJevCaptureReplay({
      store,
      workspaceId: arg('workspace', 'local'),
      from: Number(arg('from', '0')) || 0,
      to: Number(arg('to', String(Number.MAX_SAFE_INTEGER))) || Number.MAX_SAFE_INTEGER,
      mode: has('jev') ? 'jev' : 'fallback',
      dryRun: has('dry-run'),
      concurrency: Number(arg('concurrency', '1')) || 1,
      intervalMs: Number(arg('interval-ms', '0')) || 0,
      limit: Number(arg('limit', '500')) || 500,
      reasons: replayReasons(arg('reasons', 'jev-failed')),
      env,
      xFocusConfig,
    });
    console.log(JSON.stringify({
      jevEnabled: resolveJevEnabled(env),
      ...report,
      kept: report.results.filter((row) => row.action === 'keep').length,
      held: report.results.filter((row) => row.action === 'hold').length,
    }));
  } finally {
    store.close();
  }
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
