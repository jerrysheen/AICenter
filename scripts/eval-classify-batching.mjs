import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { parseGeminiGenerateContent } from '../packages/connectors/src/gemini-grok-task.js';
import {
  countBaselineSources,
  estimateClassifyCalls,
  itemsFromFixture,
  loadRecentClassifications,
  readGeminiUsage,
  renderClassifyBatchReport,
  resolveClassifyBatchModel,
  resolveEvalOptions,
  runClassifyBatchEvaluation,
  selectEvalItems,
} from '../packages/domain/src/reading-classify-batch-eval.js';
import { loadInstanceEnvironment, resolveInstanceConfig } from '../packages/instance/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

function arg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] || '';
  return '';
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nonNegativeInt(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function shanghaiDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function resolveApiKey(env) {
  const named = text(env.AI_CENTER_CLASSIFY_BATCH_KEY_ENV) || text(env.AI_CENTER_HARNESS_HOURLY_KEY_ENV);
  if (named) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(named)) throw new Error('分类评测密钥变量名无效');
    if (!text(env[named])) throw new Error(`未配置 ${named}`);
    return text(env[named]);
  }
  const listed = String(env.AI_CENTER_GEMINI_KEY_ENVS || 'GEMINI_API_KEY,GEMINI_API_KEY2,GEMINI_API_KEY3,GEMINI_API_KEY4,GEMINI_API_KEY5')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const keyEnv = [...listed, 'GOOGLE_API_KEY', 'AI_CENTER_GEMINI_API_KEY'].find((name) => text(env[name]));
  if (!keyEnv) throw new Error('未配置 GEMINI_API_KEY');
  return text(env[keyEnv]);
}

export function createClassifyBatchClient(options = {}) {
  const env = options.env || process.env;
  const model = text(options.model) || resolveClassifyBatchModel(env);
  const apiKey = options.apiKey !== undefined ? text(options.apiKey) : resolveApiKey(env);
  const apiRoot = (text(options.apiRoot) || text(env.AI_CENTER_GEMINI_API_ROOT) || DEFAULT_ROOT).replace(/\/$/, '');
  const fetchImpl = options.fetch || fetch;
  const timeoutMs = options.timeoutMs ?? nonNegativeInt(env.AI_CENTER_CLASSIFY_BATCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxOutputTokens = options.maxOutputTokens ?? nonNegativeInt(env.AI_CENTER_CLASSIFY_BATCH_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
  const schemaEnabled = options.schemaEnabled ?? String(env.AI_CENTER_CLASSIFY_BATCH_SCHEMA ?? '1') !== '0';
  if (!apiKey) throw new Error('未配置 GEMINI_API_KEY');
  return {
    model,
    maxOutputTokens,
    async complete({ system, prompt, schema }) {
      const started = Date.now();
      const response = await fetchImpl(`${apiRoot}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens,
            responseMimeType: 'application/json',
            ...(schemaEnabled && schema ? { responseSchema: schema } : {}),
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      const latencyMs = Date.now() - started;
      if (!response.ok || payload.error) {
        const error = new Error(`Gemini 请求失败（${response.status}）`);
        error.latencyMs = latencyMs;
        throw error;
      }
      return {
        text: parseGeminiGenerateContent(payload),
        latencyMs,
        usage: readGeminiUsage(payload),
        finishReason: payload?.candidates?.[0]?.finishReason || '',
        model,
      };
    },
  };
}

function openReadonly(databasePath) {
  try {
    return new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new Error(`无法只读打开数据库 ${databasePath}。${error?.message || error}`);
  }
}

function loadItems(options, workspace) {
  if (options.input) {
    return itemsFromFixture(JSON.parse(readFileSync(options.input, 'utf8')));
  }
  const database = openReadonly(options.databasePath);
  try {
    const scan = options.baseline === 'stored' ? Math.min(2000, Math.max(options.sampleSize * 5, options.sampleSize)) : options.sampleSize;
    return loadRecentClassifications(database, workspace, scan);
  } finally {
    database.close();
  }
}

export async function main(argvEnv = process.env) {
  loadInstanceEnvironment({ repositoryRoot: root, env: argvEnv });
  const config = resolveInstanceConfig({ repositoryRoot: root, env: argvEnv });
  const options = resolveEvalOptions({
    sample: arg('sample') || '200',
    batches: arg('batches') || '10,20,30',
    baseline: arg('baseline') || 'auto',
  });
  const input = arg('input');
  const workspace = arg('workspace') || 'local';
  const dryRun = process.argv.includes('--dry-run');
  const loaded = loadItems({ ...options, input: input ? path.resolve(input) : '', databasePath: config.databasePath }, workspace);
  const selected = selectEvalItems(loaded, options.sampleSize, options.baseline);
  const unlabeled = selected.filter((item) => !item.baseline).length;
  const estimate = estimateClassifyCalls(selected.length, unlabeled, options.batchSizes, options.baseline);
  console.error(`读入 ${loaded.length} 条，进入候选 ${selected.length} 条。基线模式 ${options.baseline}。预计单条重分 ${estimate.baselineCalls} 次，批量 ${estimate.batchCalls} 次，合计 ${estimate.total} 次。`);
  if (!selected.length) throw new Error('没有可评测的样本');
  if (dryRun) {
    console.error('未调用模型。');
    return { dryRun: true, selected: selected.length, estimate };
  }
  const client = createClassifyBatchClient({ env: argvEnv, model: arg('model') });
  const pauseMs = nonNegativeInt(argvEnv.AI_CENTER_CLASSIFY_BATCH_PAUSE_MS, 0);
  const result = await runClassifyBatchEvaluation({
    items: selected,
    batchSizes: options.batchSizes,
    baselineMode: options.baseline,
    complete: (request) => client.complete(request),
    pauseMs,
    onCall: (event) => {
      if (event.kind === 'single') console.error(`单条基线 ${event.index}`);
      else console.error(`批大小 ${event.batchSize}，第 ${event.index}/${event.total} 次`);
    },
  });
  if (!result.compared.length) throw new Error('没有可对照的基线');
  const report = renderClassifyBatchReport({
    requested: options.sampleSize,
    sampleSize: result.compared.length,
    loaded: loaded.length,
    selected: selected.length,
    excluded: selected.length - result.compared.length,
    baselineCounts: countBaselineSources(result.compared),
    baselineStats: result.baselineStats,
    model: client.model,
    maxOutputTokens: client.maxOutputTokens,
    rows: result.rows,
  });
  const reportPath = arg('output')
    ? path.resolve(arg('output'))
    : path.join(root, 'data', 'experiments', 'classify-batching', shanghaiDate(), 'report.md');
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);
  const samplePath = path.join(path.dirname(reportPath), 'sample.json');
  writeFileSync(samplePath, `${JSON.stringify({ items: result.compared.map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    body: item.body,
    baseline: item.baseline,
  })) }, null, 2)}\n`);
  console.log(report);
  console.error(`报告：${reportPath}`);
  return { reportPath, samplePath, result };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
