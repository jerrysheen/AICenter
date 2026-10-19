import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createInvestorAbModel } from '../../packages/connectors/src/investor-digest-ab-model.js';
import {
  DEFAULT_BATCH_SIZE_B,
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_CALLS_B,
  DEFAULT_RETRIES,
  estimateAbCalls,
  flattenMaterials,
  loadDigestMaterials,
  normalizeMaterials,
  resolveBatchSize,
  resolvePositiveInt,
  resolveSchemeSelection,
  runInvestorDigestAb,
} from '../../packages/domain/src/investor-digest-ab.js';
import { loadJevQuestionSet } from '../../packages/domain/src/investor-jev.js';
import { loadInstanceEnvironment, resolveInstanceConfig } from '../../packages/instance/src/index.js';
import { isMain } from '../../packages/runtime/src/is-main.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function arg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] || '';
  return '';
}

export function experimentPaths(date, repositoryRoot = root) {
  const dir = path.join(repositoryRoot, 'data', 'experiments', 'investor-digest-ab', date || 'undated');
  return { dir, materials: path.join(dir, 'materials.json'), report: path.join(dir, 'report.md') };
}

function readMaterialsFile(file) {
  return normalizeMaterials(JSON.parse(readFileSync(file, 'utf8')));
}

function openReadonly(databasePath) {
  try {
    return new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new Error(`无法只读打开数据库 ${databasePath}。${error?.message || error}`);
  }
}

export function materialsForDate(databasePath, date) {
  const database = openReadonly(databasePath);
  try {
    return loadDigestMaterials(database, 'local', date);
  } finally {
    database.close();
  }
}

function refetchHint(date) {
  return [
    `${date} 的日摘没有可重跑的原始帖子和评论。必须重新抓取。`,
    `node scripts/experiments/export-investor-discussion.mjs --date ${date} --fetch`,
  ].join('\n');
}

export async function main(argvEnv = process.env) {
  loadInstanceEnvironment({ repositoryRoot: root, env: argvEnv });
  const config = resolveInstanceConfig({ repositoryRoot: root, env: argvEnv });
  const input = arg('input');
  const date = arg('date');
  if (!input && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('需要 --input=<materials.json> 或 --date=YYYY-MM-DD');
  }
  let materials;
  if (input) {
    materials = readMaterialsFile(path.resolve(input));
  } else {
    const loaded = materialsForDate(config.databasePath, date);
    if (!loaded.stored) {
      const error = new Error(`${loaded.reason}\n${refetchHint(date)}`);
      error.code = 'refetch_required';
      throw error;
    }
    materials = loaded.materials;
  }
  const selection = resolveSchemeSelection(arg('only'));
  const questionSet = loadJevQuestionSet({ env: argvEnv, repositoryRoot: root });
  const batchSizeA = resolveBatchSize(
    argvEnv.AI_CENTER_INVESTOR_DIGEST_AB_BATCH_A || argvEnv.AI_CENTER_INVESTOR_DIGEST_AB_BATCH,
    questionSet.batch.size,
  );
  const batchSizeB = resolveBatchSize(argvEnv.AI_CENTER_INVESTOR_DIGEST_AB_BATCH_B, DEFAULT_BATCH_SIZE_B);
  const maxCallsA = resolvePositiveInt(argvEnv.AI_CENTER_INVESTOR_DIGEST_AB_MAX_CALLS_A, DEFAULT_MAX_CALLS, 500);
  const maxCallsB = resolvePositiveInt(argvEnv.AI_CENTER_INVESTOR_DIGEST_AB_MAX_CALLS_B, DEFAULT_MAX_CALLS_B, 500);
  const retries = resolvePositiveInt(argvEnv.AI_CENTER_INVESTOR_DIGEST_AB_RETRIES, DEFAULT_RETRIES, 5);
  const includeComments = String(argvEnv.AI_CENTER_INVESTOR_DIGEST_AB_INCLUDE_COMMENTS ?? '1') !== '0';
  const items = flattenMaterials(materials, { includeComments });
  const estimate = estimateAbCalls(items.length, batchSizeA, batchSizeB);
  if (selection.a && selection.b) {
    console.log(`预计调用：A ${estimate.perA} 次（每批 ${batchSizeA}，上限 ${maxCallsA}），B ${estimate.perB} 次（每批 ${batchSizeB}，上限 ${maxCallsB}），合计 ${estimate.total} 次。`);
  } else if (selection.b) {
    console.log(`只跑方案 B。预计调用 ${estimate.perB} 次。每批 ${batchSizeB} 条，上限 ${maxCallsB}。`);
  } else {
    console.log(`只跑方案 A。预计调用 ${estimate.perA} 次。每批 ${batchSizeA} 条，上限 ${maxCallsA}。`);
  }
  if ((selection.a && estimate.perA > maxCallsA) || (selection.b && estimate.perB > maxCallsB)) {
    console.log('预计调用超过本次上限。超出的条目会记入覆盖缺口，不再继续打标签。');
  }
  const model = createInvestorAbModel({ env: argvEnv });
  const { report, result } = await runInvestorDigestAb({
    materials,
    complete: (request) => model.complete(request),
    batchSize: batchSizeA,
    batchSizeB,
    maxCallsA,
    maxCallsB,
    retries,
    includeComments,
    only: arg('only'),
    model: model.model,
    questionSet,
    jevSingleAttempts: resolvePositiveInt(
      argvEnv.AI_CENTER_INVESTOR_DIGEST_JEV_ATTEMPTS,
      questionSet.batch.singleAttempts,
      6,
    ),
  });
  const paths = experimentPaths(materials.date || date, root);
  const reportPath = arg('output') ? path.resolve(arg('output')) : paths.report;
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);
  console.log(`报告：${reportPath}`);
  console.log(`A 调用 ${result.schemeA.usage.calls} 次，token ${result.schemeA.usage.totalTokens}，耗时 ${result.schemeA.durationMs} 毫秒。`);
  console.log(`B 调用 ${result.schemeB.usage.calls} 次，token ${result.schemeB.usage.totalTokens}，耗时 ${result.schemeB.durationMs} 毫秒。`);
  return { reportPath, result };
}

const isDirect = isMain(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = error?.code === 'refetch_required' ? 2 : 1;
  });
}
