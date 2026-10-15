const title = document.querySelector('#title');
const status = document.querySelector('#status');
const fresh = document.querySelector('#fresh');
const cards = document.querySelector('#cards');
const groups = document.querySelector('#groups');
const seriesBody = document.querySelector('#series');
const seriesNote = document.querySelector('#series-note');
const meta = document.querySelector('#meta');
const codeInput = document.querySelector('#code');
const signals = document.querySelector('#signals');
const dailyBody = document.querySelector('#daily');
const dailyStatus = document.querySelector('#daily-status');
const indicesBody = document.querySelector('#indices');
const futuresBody = document.querySelector('#futures');

const LEVELS = { strong: '强疑似', suspected: '疑似', watch: '观察', none: '无' };

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(value) {
  const number = numberOrNull(value);
  if (number == null) return '缺失';
  const text = number.toFixed(2);
  return `<span class="${number < 0 ? 'down' : 'up'}">${text}</span>`;
}

function cell(value) {
  return value == null || value === '' ? '缺失' : String(value);
}

function yi(value) {
  const number = numberOrNull(value);
  if (number == null) return '缺失';
  return money(number / 1e8);
}

function pct(value) {
  const number = numberOrNull(value);
  if (number == null) return '缺失';
  return `${(number * 100).toFixed(2)}%`;
}

function percentile(value) {
  const number = numberOrNull(value);
  if (number == null) return '缺失';
  return number.toFixed(1);
}

function multiple(value) {
  const number = numberOrNull(value);
  if (number == null) return '缺失';
  return `${number.toFixed(2)} 倍`;
}

function indexMetric(item, field) {
  if (!item?.method) return '数据不足';
  if (field === 'tailPct' && item.method === 'daily-approx') return '数据不足';
  return pct(item[field]);
}

function indexHit(item) {
  if (!item?.method) return '数据不足';
  const hit = item.hit ? '命中' : '未命中';
  if (item.method === 'daily-approx') return `${hit}（日线近似）`;
  return hit;
}

function flag(value) {
  if (value === 'red') return '<span class="flag-red">红</span>';
  if (value === 'yellow') return '<span class="flag-yellow">黄</span>';
  return '';
}

function card(label, value) {
  return `<article class="card"><span>${label}</span><strong>${value}</strong></article>`;
}

async function readJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  return { response, payload };
}

function showFresh(overview) {
  const pending = overview?.pendingDates || [];
  fresh.textContent = [
    `份额截至 ${overview?.sharesLatest || '缺失'}`,
    `行情截至 ${overview?.quotesLatest || '缺失'}`,
    pending.length ? `待补份额 ${pending.join('、')}` : '没有待补份额',
  ].join('。') + '。';
}

async function loadOverview() {
  const { payload } = await readJson('/api/v1/etf-whale/overview');
  const overview = payload.overview;
  showFresh(overview);
  if (!overview?.ready) {
    title.textContent = '份额结果还不能展示';
    status.textContent = overview?.reason === 'no_complete_day'
      ? '20 只核心 ETF 还没有一个日期同时具备份额和价格。下面只保留覆盖状态，不用空数字充页面。'
      : '读取失败。';
    meta.textContent = JSON.stringify(overview?.coverage || overview, null, 2);
    return;
  }
  title.textContent = `${overview.latest} 核心观察池`;
  status.textContent = overview.recentComplete
    ? `近 5 个完整交易日自 ${overview.recentStart} 起。`
    : '近端区间仍有缺失日期，累计金额不作为完整结果。';
  cards.innerHTML = [
    card('统计日期', overview.latest),
    card('当日净申赎（亿元）', money(overview.pool.flowYi)),
    card('近 5 日净申赎（亿元）', money(overview.recentFlowYi)),
    card('完整交易日', String(overview.completeDays)),
  ].join('');
  groups.innerHTML = overview.groups.map((item) => `<tr><td>${item.group}</td><td>${item.covered}/${item.expected}</td><td>${item.inflowCount}</td><td>${item.outflowCount}</td><td>${cell(item.deltaYi)}</td><td>${money(item.flowYi)}</td></tr>`).join('');
  meta.textContent = JSON.stringify({ coverage: overview.coverage, report: overview.report }, null, 2);
}

function componentCell(stage, key, field) {
  if (Array.isArray(stage.insufficient) && stage.insufficient.includes(key)) return '数据不足';
  return cell(stage[field]);
}

function indexScoreCell(stage) {
  if (Array.isArray(stage.insufficient) && stage.insufficient.includes('index')) return '数据不足';
  const value = cell(stage.sIndex);
  if (stage.indexMethod === 'daily-approx') return `${value}（日线近似）`;
  if (stage.indexMethod === 'mixed') return `${value}（含日线近似）`;
  return value;
}

function scoreLine(label, stage) {
  if (!stage) return `<p>${label}：还没有</p>`;
  const shown = stage.scaled == null ? stage.score : `${Number(stage.score).toFixed(1)} / ${stage.maxScore}，折算 ${Number(stage.scaled).toFixed(1)}`;
  const missing = [['turnover', '成交额'], ['index', '指数']]
    .filter(([key]) => Array.isArray(stage.insufficient) && stage.insufficient.includes(key))
    .map(([, name]) => name);
  const gap = missing.length ? `。${missing.join('、')}数据不足` : '';
  return `<p>${label}：${shown}，${LEVELS[stage.level] || stage.level || '无'}。成交额 ${componentCell(stage, 'turnover', 'sTurnover')}，净申购 ${cell(stage.sFlow)}，同时异常 ${cell(stage.sBreadth)}，指数 ${indexScoreCell(stage)}${gap}</p>`;
}

async function loadSignals() {
  const { response, payload } = await readJson('/api/v1/etf-whale/signals');
  if (!response.ok) {
    signals.textContent = payload.error || '打分读取失败';
    return;
  }
  const latest = payload.signals?.days?.at(-1);
  if (!latest) {
    signals.textContent = '还没有打分。';
    return;
  }
  signals.innerHTML = `<p>${latest.tradeDate}</p>${scoreLine('初判', latest.initial)}${scoreLine('确认', latest.confirmed)}`;
}

async function loadDaily() {
  const { response, payload } = await readJson('/api/v1/etf-whale/daily');
  if (!response.ok) {
    dailyStatus.textContent = payload.error || '明细读取失败';
    return;
  }
  const daily = payload.daily;
  if (!daily?.tradeDate) {
    dailyStatus.textContent = '还没有行情日。';
    return;
  }
  const pool = daily.pool || {};
  dailyStatus.textContent = `${daily.tradeDate} 份额${daily.sharesStatus === 'ok' ? '已到' : '未到'}。参考池成交额 ${pool.amountCny == null ? '缺失' : (pool.amountCny / 1e8).toFixed(2)} 亿元，异常 ${pool.abnormalCount ?? 0} 只，红色 ${pool.redCount ?? 0} 只。`;
  dailyBody.innerHTML = (daily.etfs || []).map((item) => `<tr><td>${item.code}</td><td>${item.name}${item.referencePool ? '' : '（对照）'}</td><td>${cell(item.close)}</td><td>${yi(item.amountCny)}</td><td>${multiple(item.amountMultiple)}</td><td>${percentile(item.amountPercentile)}</td><td>${item.deltaShares == null ? '缺失' : yi(item.deltaShares)}</td><td>${yi(item.flowCny)}</td><td>${percentile(item.flowPercentile)}</td><td>${flag(item.flag)}</td></tr>`).join('');
  indicesBody.innerHTML = (daily.indices || []).map((item) => `<tr><td>${item.name}</td><td>${indexMetric(item, 'lowDropPct')}</td><td>${indexMetric(item, 'reboundPct')}</td><td>${indexMetric(item, 'tailPct')}</td><td>${indexHit(item)}</td></tr>`).join('');
  const products = daily.futures?.products || {};
  futuresBody.innerHTML = Object.entries(products).map(([product, item]) => `<tr><td>${product}</td><td>${cell(item.netShort)}</td><td>${cell(item.change)}</td></tr>`).join('');
}

async function loadSeries() {
  const code = codeInput.value.trim();
  const { response, payload } = await readJson(`/api/v1/etf-whale/etfs/${encodeURIComponent(code)}`);
  if (response.status === 404) {
    seriesNote.textContent = '这个代码不在观察池。';
    seriesBody.innerHTML = '';
    return;
  }
  if (!response.ok) {
    seriesNote.textContent = payload.error || '读取失败';
    seriesBody.innerHTML = '';
    return;
  }
  const series = payload.series;
  seriesNote.textContent = series?.inPool ? `${series.code} 在参考池内。` : `${series?.code || code} 只作对照，不进入打分池。`;
  const points = series?.points || [];
  seriesBody.innerHTML = points.slice(-30).reverse().map((item) => `<tr><td>${item.tradeDate}</td><td>${cell(item.sharesYi)}</td><td>${cell(item.deltaYi)}</td><td>${money(item.flowYi)}</td><td>${cell(item.closePrice)}</td><td>${item.reason}</td></tr>`).join('');
}

document.querySelector('#load').addEventListener('click', () => loadSeries().catch((error) => { status.textContent = error.message; }));
loadOverview()
  .then(() => Promise.all([loadSignals(), loadDaily(), loadSeries()]))
  .catch((error) => { title.textContent = '读取失败'; status.textContent = error.message; });
