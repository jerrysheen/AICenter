// Compare Bamboo StartLux with optional JEV scores on real local news.
// Run on the server, where BAMBOO_API_KEY is already in .env. This file never
// asks for, prints, or invents a key.
//
// node --env-file=.env scripts/bamboo-news-compare.mjs --limit 50 --out data/bamboo-news-compare.json

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createBambooStartLuxClient } from '../packages/connectors/src/bamboo-startlux.js';
import { createTypeSafeSystemOneClient } from '../packages/connectors/src/typesafe-system-one.js';
import { hitsAt, labelMetrics, labelMetricsAtThresholds, labelSetDiff, selectComparisonItems } from '../packages/domain/src/bamboo-label-eval.js';
import { resolveJevEnabled } from '../packages/domain/src/jev-enabled.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const questionsFile = JSON.parse(readFileSync(path.join(root, 'config/bamboo-label-questions.json'), 'utf8'));
const fixturesFile = JSON.parse(readFileSync(path.join(root, 'config/bamboo-label-fixtures.json'), 'utf8'));

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function integer(name, fallback) {
  const raw = arg(name, '');
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 需要非负整数`);
  return value;
}

function questions() {
  return Object.fromEntries(questionsFile.questions.map((question) => [question.id, {
    type: 'noul',
    instructions: question.instructions,
    criteria: { true: question.criteria.true, false: question.criteria.false },
  }]));
}

function loadLabels(file) {
  if (!file) return new Map();
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const map = new Map();
  if (Array.isArray(parsed)) {
    for (const row of parsed) map.set(String(row.id), Array.isArray(row.human) ? row.human : []);
    return map;
  }
  if (Array.isArray(parsed.items)) {
    for (const row of parsed.items) map.set(String(row.id), Array.isArray(row.human) ? row.human : []);
    return map;
  }
  for (const [id, human] of Object.entries(parsed)) {
    if (id === 'version' || id === 'note') continue;
    map.set(id, Array.isArray(human) ? human : []);
  }
  return map;
}

function loadNews(databasePath, workspace, pool) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database.prepare(`SELECT ci.id, ci.title, ci.summary, substr(ci.body, 1, 1500) AS body,
        COALESCE(c.provider, '') AS provider
      FROM content_items ci
      LEFT JOIN captures c ON c.id = ci.capture_id
      WHERE ci.workspace_id = ?
      ORDER BY ci.created_at DESC
      LIMIT ?`).all(workspace, pool);
  } finally {
    database.close();
  }
}

function scoresOf(answers, ids) {
  const scores = {};
  for (const id of ids) scores[id] = answers?.[id]?.noul;
  return scores;
}

async function callProvider(client, state, ids) {
  const started = Date.now();
  try {
    const response = await client.evaluate({ state, questions: questions() });
    const usage = response.usage || {};
    return {
      model: response.model || client.modelId || '',
      scores: scoresOf(response.answers, ids),
      ms: Date.now() - started,
      usage: {
        inputTokens: Number.isFinite(Number(usage.input_tokens)) ? Number(usage.input_tokens) : null,
        outputTokens: Number.isFinite(Number(usage.output_tokens)) ? Number(usage.output_tokens) : null,
      },
      category: 'ok',
      requestId: response.requestId || '',
    };
  } catch (error) {
    return {
      model: client.modelId || '',
      scores: {},
      ms: Date.now() - started,
      usage: { inputTokens: null, outputTokens: null },
      category: error?.code || 'error',
      http: Number.isInteger(error?.status) ? error.status : null,
      requestId: '',
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markdown(report) {
  const lines = [
    `# Bamboo 对照（阈值 ${report.threshold}，演示用）`,
    '',
    report.note,
    '',
    '| ID | 标题 | 人工标签 | Bamboo 原始分 | Bamboo 结果 | JEV 原始分 | JEV 结果 | 差异 | 耗时 | usage |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of report.items) {
    lines.push(`| ${cell(row.id)} | ${cell(row.title)} | ${cell(labelText(row.human))} | ${cell(scoreText(row.bamboo.scores))} | ${cell((row.bamboo.hits || []).join(',') || row.bamboo.category)} | ${cell(row.jev.reason === 'ok' ? scoreText(row.jev.scores) : row.jev.reason)} | ${cell(row.jev.reason === 'ok' ? (row.jev.hits || []).join(',') : '')} | ${cell(diffText(row.diff))} | ${row.bamboo.ms ?? ''}ms | ${cell(usageText(row.bamboo.usage))} |`);
  }
  lines.push('', '## 逐标签', '');
  for (const [tag, metric] of Object.entries(report.metrics.bamboo || {})) {
    if (metric.reason) lines.push(`- ${tag}：${metric.reason}（已标 ${metric.labeled}）`);
    else lines.push(`- ${tag}：P=${round(metric.precision)} R=${round(metric.recall)} F1=${round(metric.f1)}，正例 ${metric.positives}，错例 ${metric.misses.slice(0, 5).map((item) => `${item.id}:${item.kind}`).join('、') || '无'}`);
  }
  lines.push('', '## 不同阈值（准确率 / 召回率）', '');
  lines.push('准确率 = (tp + tn) / 已标条数。精确率 = tp / (tp + fp)。召回率 = tp / 正例。用来之后重估信息流 0.60 和阅读小时 0.5。');
  lines.push('', '| 阈值 | 标签 | 准确率 | 召回率 | 精确率 | F1 |', '| --- | --- | --- | --- | --- | --- |');
  for (const row of report.thresholdSweep || []) {
    for (const [tag, metric] of Object.entries(row.metrics || {})) {
      if (metric.reason) lines.push(`| ${row.threshold} | ${tag} | ${metric.reason} | | | |`);
      else lines.push(`| ${row.threshold} | ${tag} | ${round(metric.accuracy)} | ${round(metric.recall)} | ${round(metric.precision)} | ${round(metric.f1)} |`);
    }
  }
  lines.push('', '小样本。没有人工正例的标签不算分。合成样例不计入上表。');
  return lines.join('\n');
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function labelText(human) {
  if (!Array.isArray(human)) return '';
  return human.join(',') || '（已标为空）';
}

function scoreText(scores) {
  return Object.entries(scores || {}).map(([id, value]) => `${id}:${typeof value === 'number' ? value.toFixed(3) : '-'}`).join(' ');
}

function diffText(diff) {
  if (!diff) return '';
  const parts = [];
  if (diff.onlyLeft?.length) parts.push(`仅Bamboo:${diff.onlyLeft.join(',')}`);
  if (diff.onlyRight?.length) parts.push(`仅JEV:${diff.onlyRight.join(',')}`);
  return parts.join(' ') || '相同';
}

function usageText(usage) {
  if (!usage) return '';
  return `in:${usage.inputTokens ?? '-'} out:${usage.outputTokens ?? '-'}`;
}

function round(value) {
  return typeof value === 'number' ? value.toFixed(3) : '-';
}

function thresholdsOf() {
  const raw = arg('--thresholds', '0.4,0.5,0.6,0.7');
  const values = String(raw).split(',').map((item) => Number(item.trim())).filter((item) => Number.isFinite(item));
  if (!values.length) throw new Error('--thresholds 需要 0 到 1 的数字，用逗号分开');
  return values;
}

const limit = integer('--limit', 50);
const pool = integer('--pool', 400);
const threshold = Number(arg('--threshold', '0.5'));
const thresholds = thresholdsOf();
const intervalMs = integer('--interval-ms', 500);
const workspace = arg('--workspace', 'local');
const outFile = path.resolve(root, arg('--out', 'data/bamboo-news-compare.json'));
const dryRun = flag('--dry-run');
const withJev = flag('--jev');
const ids = questionsFile.questions.map((question) => question.id);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('--threshold 需要 0 到 1 的数字');
if (thresholds.some((value) => value < 0 || value > 1)) throw new Error('--thresholds 里的每一项都要在 0 到 1');

const instance = resolveInstanceConfig({ repositoryRoot: root });
let news = [];
try {
  news = loadNews(instance.databasePath, workspace, pool);
} catch (error) {
  console.error(`读不到本地新闻库 ${instance.databasePath}：${error?.code || 'error'}`);
  console.error('在放了数据库和 BAMBOO_API_KEY 的服务器上运行。不要把密钥写进命令。');
  process.exitCode = 1;
}

if (!process.exitCode) {
  const selected = selectComparisonItems(news, { limit });
  const labels = loadLabels(arg('--labels', ''));
  const bamboo = dryRun ? null : createBambooStartLuxClient({ env: process.env });
  if (!dryRun && !bamboo.available()) {
    console.error('未配置 BAMBOO_API_KEY。密钥只从环境变量读取，脚本不会索取或伪造。');
    process.exitCode = 1;
  } else {
    let jev = null;
    let jevReason = 'not-run';
    if (withJev) {
      if (!resolveJevEnabled(process.env)) jevReason = 'jev-disabled';
      else {
        jev = createTypeSafeSystemOneClient({ env: process.env, timeoutMs: integer('--jev-timeout-ms', 30_000) });
        if (!jev.available()) {
          jev = null;
          jevReason = 'jev-unconfigured';
        } else jevReason = 'ok';
      }
    }
    const items = [];
    for (const item of selected) {
      const state = { title: item.title || '', summary: item.summary || '', body: item.body || '' };
      const bambooResult = dryRun
        ? { model: '', scores: {}, hits: [], ms: null, usage: {}, category: 'dry-run', requestId: '' }
        : await callProvider(bamboo, state, ids);
      if (!dryRun && intervalMs) await sleep(intervalMs);
      const jevResult = jev
        ? await callProvider(jev, state, ids)
        : { model: '', scores: {}, hits: [], ms: null, usage: {}, category: jevReason, requestId: '' };
      if (jev && intervalMs) await sleep(intervalMs);
      const bambooHits = bambooResult.category === 'ok' ? hitsAt(bambooResult.scores, threshold) : [];
      const jevHits = jevResult.category === 'ok' ? hitsAt(jevResult.scores, threshold) : [];
      items.push({
        id: item.id,
        title: item.title || '',
        provider: item.provider || '',
        human: labels.has(item.id) ? labels.get(item.id) : null,
        bamboo: { ...bambooResult, hits: bambooHits },
        jev: { ...jevResult, reason: jevResult.category, hits: jevHits },
        diff: jevResult.category === 'ok' && bambooResult.category === 'ok' ? labelSetDiff(bambooHits, jevHits) : null,
      });
    }
    const labeled = items.filter((row) => Array.isArray(row.human));
    const bambooLabeled = labeled.map((row) => ({ ...row, scores: row.bamboo.scores }));
    const jevLabeled = labeled.filter((row) => row.jev.reason === 'ok').map((row) => ({ ...row, scores: row.jev.scores }));
    const report = {
      generatedAt: new Date().toISOString(),
      threshold,
      thresholds,
      note: `${questionsFile.note} 本表最多 ${limit} 条真实新闻。config/bamboo-label-fixtures.json 里的合成样例不在表内，也不能当成这 ${limit} 条。thresholdSweep 给出不同阈值下的准确率和召回率，供之后重估 0.60 和 0.5。`,
      model: bamboo?.modelId || '',
      count: items.length,
      items,
      metrics: {
        bamboo: labelMetrics(bambooLabeled, ids, threshold),
        jev: labelMetrics(jevLabeled, ids, threshold),
      },
      thresholdSweep: labelMetricsAtThresholds(bambooLabeled, ids, thresholds),
      jevThresholdSweep: labelMetricsAtThresholds(jevLabeled, ids, thresholds),
      syntheticNotScored: fixturesFile.items.map((item) => ({ id: item.id, title: item.title, human: item.human })),
    };
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(markdown(report));
    console.log(`\n写入 ${outFile}`);
  }
}
