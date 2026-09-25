import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const EXPERIMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function experimentFolder(root, experimentId) {
  if (!EXPERIMENT_ID.test(String(experimentId || ''))) return null;
  const folder = path.resolve(root, 'experiments', experimentId);
  const experiments = path.resolve(root, 'experiments');
  if (folder !== path.join(experiments, experimentId)) return null;
  return folder;
}

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
}

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function createQuantLabService({ quantRoot, listJobs = () => [] }) {
  const root = quantRoot ? path.resolve(quantRoot) : '';

  function overview() {
    const manifest = root ? readJson(path.join(root, 'manifest.json')) : null;
    return {
      module: 'quant-lab-v0',
      ready: Boolean(manifest),
      sampleLabel: manifest?.sample_label || '教学小样本／存在选样偏差',
      sampleNote: manifest?.sample_note || '固定名单不是历史指数成分，不能当作盈利证据。',
      source: manifest?.source || null,
      dateRange: manifest?.date_range || null,
      stockCount: manifest?.stock_count ?? null,
      benchmark: manifest?.benchmark?.qlib || null,
      segments: manifest?.segments || null,
      adjustment: manifest?.adjustment || null,
      units: manifest?.units || null,
      pool: manifest?.pool || null,
      qlibVersion: manifest?.qlib_version || '0.9.7',
      fetchedAt: manifest?.fetched_at || null,
      cache: manifest?.cache || null,
      roundtrip: manifest?.roundtrip
        ? { symbol: manifest.roundtrip.symbol, date: manifest.roundtrip.date, matched: true }
        : null,
      baseline: {
        features: 'Alpha158',
        model: 'LGBModel',
        strategy: 'TopkDropoutStrategy',
        frequency: 'day',
        device: 'cpu',
        configFile: 'quant/src/aicenter_quant/run_experiment.py',
      },
    };
  }

  function experimentsFromDisk() {
    const directory = root ? path.join(root, 'experiments') : '';
    if (!directory || !existsSync(directory)) return [];
    return readdirSync(directory).flatMap((name) => {
      const folder = experimentFolder(root, name);
      if (!folder || !existsSync(folder)) return [];
      const summary = readJson(path.join(folder, 'summary.json'));
      const status = readJson(path.join(folder, 'status.json'));
      const updatedAt = statSync(folder).mtimeMs;
      return [{
        experimentId: name,
        status: summary?.status || status?.status || 'unknown',
        topk: summary?.topk ?? status?.topk ?? null,
        nDrop: summary?.n_drop ?? status?.n_drop ?? null,
        createdAt: summary?.created_at || null,
        updatedAt,
        predictionRows: summary?.prediction_rows ?? null,
        positionDays: summary?.position_days ?? null,
        error: summary?.error || status?.error || null,
        metrics: Array.isArray(summary?.metrics) ? summary.metrics : [],
        graphErrors: Array.isArray(summary?.graph_errors) ? summary.graph_errors : [],
        assumptions: summary?.assumptions || null,
        testDates: Array.isArray(summary?.test_dates) ? summary.test_dates : [],
        segments: summary?.segments || null,
        hasReport: existsSync(path.join(folder, 'report.html')),
      }];
    });
  }

  function list() {
    const disk = new Map(experimentsFromDisk().map((item) => [item.experimentId, item]));
    const jobs = listJobs().filter((job) => job.type === 'quant.lab.prepare' || job.type === 'quant.lab.run');
    for (const job of jobs) {
      const experimentId = job.input?.experimentId;
      if (!experimentId) continue;
      const current = disk.get(experimentId);
      if (current && (current.status === 'completed' || current.status === 'failed')) continue;
      disk.set(experimentId, {
        experimentId,
        status: job.status,
        topk: job.input?.topk ?? current?.topk ?? null,
        nDrop: job.input?.nDrop ?? current?.nDrop ?? null,
        createdAt: current?.createdAt || new Date(job.createdAt).toISOString(),
        updatedAt: job.updatedAt,
        predictionRows: current?.predictionRows ?? null,
        positionDays: current?.positionDays ?? null,
        error: job.error?.message || current?.error || null,
        metrics: current?.metrics || [],
        graphErrors: current?.graphErrors || [],
        assumptions: current?.assumptions || null,
        testDates: current?.testDates || [],
        segments: current?.segments || null,
        hasReport: current?.hasReport || false,
        jobId: job.id,
      });
    }
    return {
      overview: overview(),
      prepareJobs: jobs.filter((job) => job.type === 'quant.lab.prepare').map((job) => ({
        jobId: job.id,
        status: job.status,
        error: job.error?.message || null,
        createdAt: job.createdAt,
      })),
      experiments: [...disk.values()].sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || ''))),
    };
  }

  function day(experimentId, date) {
    const folder = experimentFolder(root, experimentId);
    if (!folder || !existsSync(folder)) return null;
    const predictions = existsSync(path.join(folder, 'export', 'predictions.csv'))
      ? parseCsv(readFileSync(path.join(folder, 'export', 'predictions.csv'), 'utf8'))
      : [];
    const positions = existsSync(path.join(folder, 'export', 'positions.csv'))
      ? parseCsv(readFileSync(path.join(folder, 'export', 'positions.csv'), 'utf8'))
      : [];
    const dates = [...new Set(predictions.map((row) => row.date))].sort();
    const signalDate = dates.filter((item) => item < date).at(-1) || null;
    const scores = predictions.filter((row) => row.date === signalDate).map((row) => ({
      instrument: row.instrument,
      score: numberOrNull(row.score),
      rank: numberOrNull(row.rank),
      label: numberOrNull(row.label),
    }));
    const holdings = positions.filter((row) => row.date === date).map((row) => ({
      instrument: row.instrument,
      amount: numberOrNull(row.amount),
      weight: numberOrNull(row.weight),
      amountMeaning: 'Qlib 复权数量，不是券商股数。还原股数约等于该数量乘以当日 factor',
    }));
    return {
      experimentId,
      date,
      signalDate,
      timing: '持仓日使用前一交易日的预测分数，在持仓日收盘价成交。分数和持仓不是同一天生成的。',
      scores,
      holdings,
      missing: {
        scores: scores.length ? null : (signalDate ? `${signalDate} 没有预测分数` : '没有更早的信号日'),
        holdings: holdings.length ? null : '这一天没有回测持仓。框架没有逐笔成交，这里只展示持仓快照',
      },
    };
  }

  function reportPath(experimentId) {
    const folder = experimentFolder(root, experimentId);
    if (!folder) return null;
    const file = path.resolve(folder, 'report.html');
    if (!file.startsWith(`${folder}${path.sep}`) || !existsSync(file)) return null;
    return file;
  }

  return Object.freeze({ overview, list, day, reportPath });
}
