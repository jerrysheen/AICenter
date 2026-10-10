import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStore } from '../packages/database/src/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import {
  YI,
  aggregatePool,
  roundDigits,
  sumFlow,
} from '../packages/domain/src/etf-whale/calculate.js';
import {
  compareEtfDay,
  compareFixedSample,
  largestDiscrepancies,
  summarizeComparisons,
} from '../packages/domain/src/etf-whale/parity.js';
import { FIXED_HISTORY_SAMPLE, REFERENCE_BOARD_URL, REFERENCE_HOME_URL } from '../packages/domain/src/etf-whale/reference-samples.js';
import { ETF_WHALE_UNIVERSE, referencePool } from '../packages/domain/src/etf-whale/universe.js';
import { probeSzseJsonAgainstXlsx, recomputeEtfWhale, syncEtfWhale } from '../packages/runtime/src/etf-whale-sync.js';

const root = process.cwd();
const instance = resolveInstanceConfig({ repositoryRoot: root });
const startDate = arg('--start', '2024-01-02');
const endDate = arg('--end', shanghaiToday());
const runId = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const runDir = path.join(root, '.ai-data', 'etf-whale-parity', runId);
const pool = referencePool();
const poolCodes = pool.map((item) => item.code);

const store = createStore(instance.databasePath);
const repository = store.repositories.etfWhale;
await mkdir(runDir, { recursive: true });
console.log(`run ${runId}`);
console.log(`range ${startDate} ${endDate}`);

const recomputeOnly = process.argv.includes('--recompute');
const sync = recomputeOnly
  ? { probes: [] }
  : await syncEtfWhale({
    repository,
    dataDirectory: instance.dataDirectory,
    startDate,
    endDate,
    onProgress: (line) => console.log(line),
  });

const eastmoney = await probeEastmoney();
const szCodes = ETF_WHALE_UNIVERSE.filter((item) => item.exchange === 'SZ').map((item) => item.code);
const szSample = repository.listShares(szCodes, 'szse-xlsx').filter((row) => row.trade_date === '2026-07-31');
const szseJson = szSample.length
  ? await probeSzseJsonAgainstXlsx('2026-07-31', szSample.map((row) => ({ code: row.code, tradeDate: row.trade_date, shares: row.shares })))
  : { probe: null, compared: [], note: '2026-07-31 深交所份额尚未入库，不能做 JSON 对照' };
const codeProbe = await probeSzseCode('159919', '2026-07-31');
if (codeProbe.row?.current_size) {
  const jsonShares = Number(String(codeProbe.row.current_size).replaceAll(',', '')) * 10_000;
  const xlsx = szSample.find((row) => row.code === '159919');
  codeProbe.jsonShares = jsonShares;
  codeProbe.xlsxShares = xlsx?.shares ?? null;
  codeProbe.shareDiff = xlsx ? jsonShares - xlsx.shares : null;
  codeProbe.unitNote = 'JSON current_size 为万份，XLSX 为份。差额应落在 0.01 万份（100 份）的截断范围内。';
}

const reference = await fetchReference(poolCodes);
const computed = recomputeEtfWhale(repository);
const comparisons = [];
for (const code of poolCodes) {
  const series = reference.etfs[code]?.series || [];
  for (const item of series) {
    if (item.date < startDate || item.date > endDate) continue;
    const ours = computed.rows.find((row) => row.code === code && row.tradeDate === item.date);
    if (!ours && !item.qfq_total_units_yi) continue;
    const compared = compareEtfDay(ours, item);
    comparisons.push({ ...compared, code, tradeDate: item.date });
  }
}
const summary = summarizeComparisons(comparisons);
const fixed = compareFixedSample(computed.rows);
const day = '2026-07-31';
const groupRows = groupReport(computed.rows, day);
const week = sumFlow(computed.rows, { codes: poolCodes, startDate: '2026-07-27', endDate: day });
const coverage = repository.coverage();
const disclosures = saveDisclosures(reference);
const focus = focusDays(reference, comparisons);
const top = largestDiscrepancies(comparisons, 10);
const answer = buildAnswers({ summary, fixed, week, groupRows, coverage, comparisons, eastmoney, szseJson });

const manifest = {
  runId,
  startDate,
  endDate,
  algorithm: 'etf-whale-qfq-typical-v1',
  coverage,
  fetches: coverage.fetches,
  blobNote: '原始响应在实例 data/blobs/etf-whale/，数据库保存相对路径和 SHA-256。',
};
await writeFile(path.join(runDir, 'source-probes.json'), JSON.stringify({
  sync: sync.probes.filter((item) => item.status !== 200 || item.error || item.rowCount === 0).slice(0, 200),
  syncCount: sync.probes.length,
  eastmoney,
  szseJson,
  codeProbe,
}, null, 2));
await writeFile(path.join(runDir, 'raw-data-manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(path.join(runDir, 'reference-samples.json'), JSON.stringify({
  fixed: FIXED_HISTORY_SAMPLE,
  home: REFERENCE_HOME_URL,
  board: REFERENCE_BOARD_URL,
  universe: reference.universe,
  refreshedAt: reference.refreshedAt,
  disclosures,
  focus,
}, null, 2));
await writeFile(path.join(runDir, 'etf-daily-comparison.csv'), csv(comparisons));
await writeFile(path.join(runDir, 'group-comparison.csv'), csv(groupRows));
await writeFile(path.join(runDir, 'discrepancies.json'), JSON.stringify({ top, notComparable: comparisons.filter((row) => row.status === 'NOT_COMPARABLE').slice(0, 50) }, null, 2));
await writeFile(path.join(runDir, 'summary.json'), JSON.stringify({ summary, fixed, week: publicWeek(week), groups: groupRows, answer }, null, 2));
const html = renderHtml({ runId, summary, fixed, week, groupRows, top, answer, coverage, eastmoney, szseJson });
await writeFile(path.join(runDir, 'report.html'), html);
await writeFile(path.join(runDir, 'report.md'), renderMarkdown({ runId, summary, fixed, week, groupRows, top, answer, coverage }));
console.log(answer.headline);
console.log(runDir);

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

async function probeEastmoney() {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.510300&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=0&beg=20260731&end=20260731';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Referer: 'https://quote.eastmoney.com/' } });
    const text = await response.text();
    return { url, status: response.status, bytes: text.length, ok: response.ok, head: text.slice(0, 180) };
  } catch (error) {
    return { url, status: 0, ok: false, error: error.message || String(error) };
  }
}

async function probeSzseCode(code, tradeDate) {
  const url = new URL('https://www.szse.cn/api/report/ShowReport/data');
  url.searchParams.set('SHOWTYPE', 'JSON');
  url.searchParams.set('CATALOGID', 'scsj_fund_jjgm');
  url.searchParams.set('TABKEY', 'tab1');
  url.searchParams.set('txtStart', tradeDate);
  url.searchParams.set('txtEnd', tradeDate);
  url.searchParams.set('jjlb', 'ETF');
  url.searchParams.set('txtDm', code);
  try {
    const response = await fetch(url, { headers: { Referer: 'https://www.szse.cn/market/fund/volume/etf/index.html' }, signal: AbortSignal.timeout(20000) });
    const payload = await response.json();
    const block = Array.isArray(payload) ? payload[0] : payload;
    const row = (block?.data || []).find((item) => String(item.fund_code || '').includes(code)) || block?.data?.[0] || null;
    return { url: url.toString(), status: response.status, recordCount: block?.metadata?.recordcount ?? null, pageSize: block?.metadata?.pagesize ?? null, row };
  } catch (error) {
    return { url: url.toString(), status: 0, error: error.message || String(error) };
  }
}

async function fetchReference(codes) {
  const headers = { 'User-Agent': 'AICenter etf-whale benchmark', Accept: 'application/json' };
  const universeResponse = await fetch(`${REFERENCE_HOME_URL}data/universe.json`, { headers });
  const universeText = await universeResponse.text();
  await writeFile(path.join(runDir, 'universe.json'), universeText);
  const universe = JSON.parse(universeText);
  const etfs = {};
  let refreshedAt = '';
  for (const code of codes) {
    const response = await fetch(`${REFERENCE_HOME_URL}data/etfs/${code}.json`, { headers });
    const text = await response.text();
    const relative = `blobs/etf-whale/benchmark/${code}.json`;
    const absolute = path.join(instance.dataDirectory, ...relative.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
    const payload = JSON.parse(text);
    etfs[code] = payload;
    refreshedAt = payload.meta?.data_refreshed_at || refreshedAt;
    await sleep(150);
  }
  return { universe, etfs, refreshedAt, universeHash: createHash('sha256').update(universeText).digest('hex') };
}

function saveDisclosures(referenceData) {
  const capturedOn = shanghaiToday();
  const rows = [];
  for (const [code, payload] of Object.entries(referenceData.etfs)) {
    for (const item of payload.disclosures || []) {
      const reportEnd = item.report_date || item.date;
      if (!reportEnd) continue;
      rows.push({
        code,
        source: 'wangwang-benchmark',
        reportEnd,
        announcedOn: null,
        capturedOn,
        ratioPct: item.combined_ratio_pct ?? null,
        valueCny: item.combined_value_yi == null ? null : item.combined_value_yi * YI,
        totalShares: item.total_shares_yi_qfq == null ? null : item.total_shares_yi_qfq * YI,
      });
    }
  }
  repository.saveDisclosures(rows);
  return { count: rows.length, announcedOn: null, note: '参考站披露只有报告截止日，没有独立公告日，不能提前用于历史回测。' };
}

function groupReport(rows, tradeDate) {
  const groups = [...new Set(pool.map((item) => item.groupKey))];
  const grouped = groups.map((groupKey) => aggregatePool(rows, {
    codes: pool.filter((item) => item.groupKey === groupKey).map((item) => item.code),
    tradeDate,
    groupKey,
  }));
  grouped.push(aggregatePool(rows, { codes: poolCodes, tradeDate, groupKey: '20只宽基' }));
  return grouped.map((item) => ({
    group: item.groupKey,
    tradeDate,
    expected: item.expected,
    flowCovered: item.flowCovered,
    complete: item.complete,
    inflowCount: item.inflowCount,
    outflowCount: item.outflowCount,
    deltaYi: item.deltaShares == null ? '' : roundDigits(item.deltaShares / YI, 4),
    flowYi: item.flowCny == null ? '' : roundDigits(item.flowCny / YI, 4),
  }));
}

function focusDays(referenceData, rows) {
  const interesting = rows.filter((row) => row.code === '159915' && row.refFlowYi != null);
  const sorted = [...interesting].sort((left, right) => Math.abs(right.refFlowYi) - Math.abs(left.refFlowYi));
  return sorted.slice(0, 8).map((row) => ({ code: row.code, tradeDate: row.tradeDate, refFlowYi: row.refFlowYi, oursFlowYi: row.oursFlowYi, status: row.flowStatus }));
}

function publicWeek(week) {
  return {
    startDate: week.startDate,
    endDate: week.endDate,
    dates: week.dates,
    completeDayCount: week.completeDayCount,
    flowYi: week.flowCny == null ? null : week.flowCny / YI,
    partialFlowYi: week.partialFlowCny / YI,
  };
}

function buildAnswers({ summary: stats, fixed: fixedRows, week: weekFlow, groupRows: groups, coverage: cover, comparisons: rows, eastmoney: em, szseJson: jsonProbe }) {
  const poolRow = groups.find((item) => item.group === '20只宽基');
  const shareRate = stats.sharePassRate == null ? '未知' : `${(stats.sharePassRate * 100).toFixed(1)}%`;
  const direction = stats.directionRate == null ? '未知' : `${(stats.directionRate * 100).toFixed(1)}%`;
  const median = stats.medianAbsFlowRelative == null ? '未知' : `${(stats.medianAbsFlowRelative * 100).toFixed(2)}%`;
  const sse = (cover.fetches || []).filter((item) => item.source === 'sse');
  const sseOk = sse.find((item) => item.status === 'ok')?.runs || 0;
  const sseEmpty = sse.find((item) => item.status === 'empty')?.runs || 0;
  const sseError = sse.find((item) => item.status === 'error')?.runs || 0;
  const sseAttempts = sseOk + sseEmpty + sseError;
  const headline = `完成观察池相关份额回填。上交所已成功返回 ${sseOk} 个日期、空返回 ${sseEmpty} 个、失败 ${sseError} 个。同口径样本 ${stats.shareSample} 条，份额一致率 ${shareRate}，资金方向一致率 ${direction}，大额估算金额相对误差中位数 ${median}。`;
  return {
    headline,
    sseAttempts,
    sseOk,
    sseEmpty,
    sseError,
    sseSuccessRate: sseAttempts ? (sseOk + sseEmpty) / sseAttempts : null,
    shareRate,
    direction,
    median,
    poolFlowYi: poolRow?.flowYi ?? null,
    poolInflow: poolRow?.inflowCount ?? null,
    poolOutflow: poolRow?.outflowCount ?? null,
    weekFlowYi: weekFlow.flowCny == null ? null : weekFlow.flowCny / YI,
    weekComplete: weekFlow.completeDayCount,
    fixedPass: fixedRows.etfs.filter((item) => item.flowStatus === 'PASS' && item.deltaStatus === 'PASS').length,
    fixedCount: fixedRows.etfs.length,
    eastmoneyOk: Boolean(em.ok),
    jsonCompared: jsonProbe.compared?.length || 0,
    comparableRows: rows.length,
  };
}

function csv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [headers.join(','), ...rows.map((row) => headers.map((key) => escapeCell(row[key])).join(','))].join('\n');
}

function escapeCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function renderMarkdown({ runId: id, summary: stats, fixed: fixedRows, week: weekFlow, groupRows: groups, top, answer, coverage: cover }) {
  const lines = [
    `# ETF 鲸鱼资金对账 ${id}`,
    '',
    answer.headline,
    '',
    '参考网站是对照样本。交易所原始份额才是第一层基准。',
    '',
    '## 固定历史样本 2026-07-31',
    '',
    '| 代码 | 我们的份额变化(亿份) | 留言板 | 状态 | 我们的净申赎(亿元) | 留言板 | 状态 |',
    '| --- | ---: | ---: | --- | ---: | ---: | --- |',
    ...fixedRows.etfs.map((item) => `| ${item.code} | ${fmt(item.oursDeltaYi)} | ${fmt(item.refDeltaYi)} | ${item.deltaStatus} | ${fmt(item.oursFlowRoundedYi)} | ${fmt(item.refFlowYi)} | ${item.flowStatus} |`),
    '',
    `20只合计净申赎：${fmt(answer.poolFlowYi)} 亿元；留言板 -39.5 亿元。`,
    `2026-07-27 至 2026-07-31 累计：${fmt(answer.weekFlowYi)} 亿元；留言板 +522.1 亿元。完整天数 ${weekFlow.completeDayCount}/${weekFlow.dates.length}。`,
    '',
    '## 分组',
    '',
    '| 分组 | 覆盖 | 净流入只数 | 净流出只数 | 份额变化(亿份) | 净申赎(亿元) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...groups.map((item) => `| ${item.group} | ${item.flowCovered}/${item.expected} | ${item.inflowCount} | ${item.outflowCount} | ${item.deltaYi} | ${item.flowYi} |`),
    '',
    '## 偏差最大的案例',
    '',
    ...top.map((item, index) => `${index + 1}. ${item.code} ${item.tradeDate} 份额 ${item.shareStatus}，金额差 ${fmt(item.flowDiffYi)} 亿元，原因 ${item.reason || item.flowStatus}`),
    '',
    '## 覆盖',
    '',
    '```json',
    JSON.stringify(cover, null, 2),
    '```',
    '',
    `机器汇总：同口径份额一致率 ${fmtRate(stats.sharePassRate)}，方向一致率 ${fmtRate(stats.directionRate)}，大额 5% 以内比例 ${fmtRate(stats.largeFlowWithin5pct)}。`,
  ];
  return lines.join('\n');
}

function renderHtml(model) {
  const rows = [
    ...model.fixed.etfs.map((item) => ['固定样本份额变化 ' + item.code, fmt(item.oursDeltaYi), fmt(item.refDeltaYi), fmt(item.deltaDiffYi), item.deltaStatus, item.deltaStatus === 'PASS' ? '' : '展示亿份差额']),
    ...model.fixed.etfs.map((item) => ['固定样本净申赎 ' + item.code, fmt(item.oursFlowRoundedYi), fmt(item.refFlowYi), fmt(item.flowDiffYi), item.flowStatus, '亿元，四舍五入到 1 位']),
    ['20只 2026-07-31 净申赎', fmt(model.answer.poolFlowYi), '-39.5', fmt(model.answer.poolFlowYi == null ? null : model.answer.poolFlowYi + 39.5), model.answer.poolFlowYi == null ? 'MISSING_OURS' : 'SEE_DIFF', '留言板一位小数'],
    ['20只 7/27-7/31 累计', fmt(model.answer.weekFlowYi), '522.1', fmt(model.answer.weekFlowYi == null ? null : model.answer.weekFlowYi - 522.1), model.week.completeDayCount === model.week.dates.length ? 'SEE_DIFF' : 'INCOMPLETE', `完整 ${model.week.completeDayCount}/${model.week.dates.length}`],
    ...model.top.map((item) => [`${item.code} ${item.tradeDate}`, fmt(item.oursFlowYi), fmt(item.refFlowYi), fmt(item.flowDiffYi), item.flowStatus, item.reason || item.shareStatus]),
  ];
  const body = rows.map((item) => `<tr><td>${esc(item[0])}</td><td>${esc(item[1])}</td><td>${esc(item[2])}</td><td>${esc(item[3])}</td><td class="${esc(item[4])}">${esc(item[4])}</td><td>${esc(item[5])}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ETF 鲸鱼对账 ${esc(model.runId)}</title>
<style>body{font-family:sans-serif;margin:24px;color:#17211b}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}td:nth-child(n+2):nth-child(-n+4){text-align:right}.FAIL{color:#9b1c1c;font-weight:700}.PASS{color:#176b3a;font-weight:700}.NOT_COMPARABLE,.MISSING_OURS,.INCOMPLETE{color:#8a5a00;font-weight:700}</style>
<h1>ETF 鲸鱼资金对账</h1><p>${esc(model.answer.headline)}</p>
<p>东方财富日线：${model.eastmoney.ok ? '成功' : '失败'}。深交所 JSON/XLSX 对照 ${model.szseJson.compared?.length || 0} 条。</p>
<table><thead><tr><th>指标</th><th>我们的结果</th><th>参考网站</th><th>差异</th><th>是否通过</th><th>差异原因</th></tr></thead><tbody>${body}</tbody></table>
<h2>分组</h2><pre>${esc(JSON.stringify(model.groupRows, null, 2))}</pre>`;
}

function fmt(value) {
  return Number.isFinite(Number(value)) ? String(roundDigits(Number(value), 4)) : '缺失';
}

function fmtRate(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '未知';
}

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
