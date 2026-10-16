import { performance } from 'node:perf_hooks';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME_KEY = 'home-bootstrap';
const BOARD_JOB = 'market.boards.snapshot';
const HOME_JOB = 'home.bootstrap.snapshot';

export function parseArgs(argv) {
  const out = {
    db: path.join(root, 'data', 'ai-center.db'),
    hours: 24,
    base: '',
    log: '',
    workspace: '',
  };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--')) throw new Error(`未知参数 ${key}`);
    if (value == null || value.startsWith('--')) throw new Error(`缺少 ${key} 的值`);
    if (key === '--db') out.db = path.resolve(value);
    else if (key === '--hours') out.hours = Number(value);
    else if (key === '--base') out.base = value.replace(/\/$/, '');
    else if (key === '--log') out.log = path.resolve(value);
    else if (key === '--workspace') out.workspace = value;
    else throw new Error(`未知参数 ${key}`);
    index += 1;
  }
  if (!Number.isFinite(out.hours) || out.hours <= 0) throw new Error('--hours 需要正数');
  return out;
}

export function bootstrapSegments(payload) {
  const timings = payload?.timings;
  if (!timings || typeof timings !== 'object') return null;
  const segments = {};
  for (const [name, value] of Object.entries(timings)) {
    const ms = Number(value);
    if (Number.isFinite(ms)) segments[name] = ms;
  }
  return Object.keys(segments).length ? segments : null;
}

export function summarizeBoardJobs(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const completed = list.filter((row) => row.status === 'completed');
  const failed = list.filter((row) => row.status === 'failed');
  const durations = list
    .map((row) => Number(row.completed_at) - Number(row.started_at))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const pick = (ratio) => {
    if (!durations.length) return null;
    const index = Math.min(durations.length - 1, Math.max(0, Math.ceil(ratio * durations.length) - 1));
    return durations[index];
  };
  const terminal = completed.length + failed.length;
  const boardMs = {};
  for (const row of completed) {
    let output = row.output;
    if (!output && row.output_json) {
      try { output = JSON.parse(row.output_json); } catch { output = null; }
    }
    const timings = output?.timings;
    if (!timings || typeof timings !== 'object') continue;
    for (const [board, value] of Object.entries(timings)) {
      const ms = Number(value);
      if (!Number.isFinite(ms)) continue;
      boardMs[board] = boardMs[board] || [];
      boardMs[board].push(ms);
    }
  }
  const boards = {};
  for (const [board, values] of Object.entries(boardMs)) {
    const sorted = [...values].sort((left, right) => left - right);
    boards[board] = {
      n: sorted.length,
      p50: sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.5 * sorted.length) - 1))],
      max: sorted[sorted.length - 1],
    };
  }
  return {
    total: list.length,
    completed: completed.length,
    failed: failed.length,
    running: list.filter((row) => row.status === 'running').length,
    queued: list.filter((row) => row.status === 'queued').length,
    failureRate: terminal ? failed.length / terminal : null,
    durationMs: {
      n: durations.length,
      min: durations[0] ?? null,
      p50: pick(0.5),
      p95: pick(0.95),
      max: durations[durations.length - 1] ?? null,
    },
    boards,
  };
}

export function parseHomeLog(line) {
  const matched = String(line || '').match(/\[worker\] home-bootstrap\s+(.+)$/);
  if (!matched) return null;
  const segments = {};
  for (const part of matched[1].trim().split(/\s+/)) {
    const [name, raw] = part.split('=');
    const ms = Number(String(raw || '').replace(/ms$/, ''));
    if (name && Number.isFinite(ms)) segments[name] = ms;
  }
  return Object.keys(segments).length ? segments : null;
}

export function parseBoardLog(line) {
  const matched = String(line || '').match(/\[market\] boards\s+(.+)$/);
  if (!matched) return null;
  const segments = {};
  let failed = [];
  for (const part of matched[1].trim().split(/\s+/)) {
    const [name, raw] = part.split('=');
    if (name === 'failed') {
      failed = raw && raw !== '0' ? raw.split(',').filter(Boolean) : [];
      continue;
    }
    const ms = Number(String(raw || '').replace(/ms$/, ''));
    if (name && Number.isFinite(ms)) segments[name] = ms;
  }
  return { segments, failed };
}

function percentileText(stats) {
  if (!stats || stats.n === 0) return '没有耗时';
  return `n=${stats.n} min=${stats.min} p50=${stats.p50} p95=${stats.p95} max=${stats.max} ms`;
}

function readSnapshots(database, workspace) {
  const sql = workspace
    ? `SELECT workspace_id, generated_at, payload_json FROM runtime_snapshots
        WHERE snapshot_key = ? AND workspace_id = ? ORDER BY generated_at DESC LIMIT 3`
    : `SELECT workspace_id, generated_at, payload_json FROM runtime_snapshots
        WHERE snapshot_key = ? ORDER BY generated_at DESC LIMIT 3`;
  const params = workspace ? [HOME_KEY, workspace] : [HOME_KEY];
  return database.prepare(sql).all(...params).map((row) => {
    let payload = null;
    try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
    return {
      workspaceId: row.workspace_id,
      generatedAt: row.generated_at,
      segments: bootstrapSegments(payload),
    };
  });
}

function readJobs(database, type, since) {
  return database.prepare(`SELECT status, started_at, completed_at, output_json, created_at
    FROM jobs
    WHERE type = ? AND created_at >= ?
    ORDER BY created_at DESC`).all(type, since);
}

function readLogLines(directory) {
  if (!directory) return [];
  let names = [];
  try { names = readdirSync(directory); } catch { return []; }
  const files = names
    .filter((name) => /worker\.out\..+\.log$/.test(name) || name === 'worker.out.log')
    .sort();
  const lines = [];
  for (const name of files.slice(-2)) {
    const text = readFileSync(path.join(directory, name), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('[worker] home-bootstrap') || line.includes('[market] boards ')) lines.push(line);
    }
  }
  return lines.slice(-40);
}

async function timeRequest(url) {
  const started = performance.now();
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await response.text();
  const elapsed = performance.now() - started;
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { url, status: response.status, ms: Number(elapsed.toFixed(1)), bytes: Buffer.byteLength(text), body };
}

async function timeHttp(base) {
  const bootstrap = await timeRequest(`${base}/api/v1/home/bootstrap`);
  const segments = bootstrapSegments(bootstrap.body);
  const modules = [
    '/api/v1/reports/tree?view=index',
    '/api/v1/reports/reading-hour/index?scope=hour',
    '/api/v1/markets?board=overview',
    '/api/v1/reports/daily/latest/brief',
    '/api/v1/static-signals/board?focus=1&limit=40&releaseLimit=60',
  ];
  const started = performance.now();
  const results = await Promise.all(modules.map((item) => timeRequest(`${base}${item}`)));
  return {
    bootstrap: {
      status: bootstrap.status,
      ms: bootstrap.ms,
      bytes: bootstrap.bytes,
      pending: Boolean(bootstrap.body?.pending),
      segments,
    },
    parallelMs: Number((performance.now() - started).toFixed(1)),
    modules: results.map((item) => ({
      path: item.url.slice(base.length),
      status: item.status,
      ms: item.ms,
      pending: Boolean(item.body?.pending),
    })),
  };
}

export function formatReport({ snapshots, jobs, bootstrapJobs = null, http, logs }) {
  const lines = ['总览性能测量'];
  if (!snapshots.length) lines.push('home-bootstrap 快照：还没有。');
  for (const row of snapshots) {
    const when = Number.isFinite(Number(row.generatedAt)) ? new Date(Number(row.generatedAt)).toISOString() : String(row.generatedAt);
    if (!row.segments) {
      lines.push(`home-bootstrap ${row.workspaceId} ${when}：响应不下发 timings。`);
    } else {
      const parts = Object.entries(row.segments).map(([name, value]) => `${name}=${value}ms`).join(' ');
      lines.push(`home-bootstrap ${row.workspaceId} ${when}：${parts}`);
    }
  }
  if (bootstrapJobs) {
    lines.push(`home.bootstrap.snapshot 耗时：${percentileText(bootstrapJobs.durationMs)}`);
    for (const [name, stats] of Object.entries(bootstrapJobs.boards)) {
      lines.push(`组包 ${name}：n=${stats.n} p50=${stats.p50} max=${stats.max} ms`);
    }
  }
  const rate = jobs.failureRate == null ? '无终态样本' : `${(jobs.failureRate * 100).toFixed(1)}%`;
  lines.push(`market.boards.snapshot：完成 ${jobs.completed}，失败 ${jobs.failed}，运行中 ${jobs.running}，排队 ${jobs.queued}，失败率 ${rate}`);
  lines.push(`任务耗时：${percentileText(jobs.durationMs)}`);
  for (const [board, stats] of Object.entries(jobs.boards)) {
    lines.push(`看板 ${board}：n=${stats.n} p50=${stats.p50} max=${stats.max} ms`);
  }
  if (http) {
    lines.push(`GET /api/v1/home/bootstrap：HTTP ${http.bootstrap.status} ${http.bootstrap.ms} ms ${http.bootstrap.bytes} 字节${http.bootstrap.pending ? ' pending' : ''}`);
    if (http.bootstrap.segments) {
      lines.push(`响应 timings：${Object.entries(http.bootstrap.segments).map(([name, value]) => `${name}=${value}ms`).join(' ')}`);
    } else lines.push('响应不下发 timings。');
    lines.push(`五个模块并行：${http.parallelMs} ms`);
    for (const item of http.modules) {
      lines.push(`  ${item.status} ${item.ms} ms${item.pending ? ' pending' : ''} ${item.path}`);
    }
  }
  if (logs?.length) {
    lines.push('最近日志：');
    for (const line of logs) lines.push(`  ${line.trim()}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const database = new Database(args.db, { readonly: true, fileMustExist: true });
  try {
    const since = Date.now() - args.hours * 3_600_000;
    const snapshots = readSnapshots(database, args.workspace);
    const jobs = summarizeBoardJobs(readJobs(database, BOARD_JOB, since));
    const bootstrapJobs = summarizeBoardJobs(readJobs(database, HOME_JOB, since));
    const http = args.base ? await timeHttp(args.base) : null;
    const logs = readLogLines(args.log);
    console.log(formatReport({ snapshots, jobs, bootstrapJobs, http, logs }));
  } finally {
    database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(`${path.sep}measure-home-perf.mjs`)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
