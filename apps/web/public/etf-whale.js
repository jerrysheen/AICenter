const title = document.querySelector('#title');
const status = document.querySelector('#status');
const cards = document.querySelector('#cards');
const groups = document.querySelector('#groups');
const seriesBody = document.querySelector('#series');
const meta = document.querySelector('#meta');
const codeInput = document.querySelector('#code');

function money(value) {
  if (!Number.isFinite(Number(value))) return '缺失';
  const number = Number(value);
  const text = number.toFixed(2);
  return `<span class="${number < 0 ? 'down' : 'up'}">${text}</span>`;
}

function cell(value) {
  return value == null || value === '' ? '缺失' : String(value);
}

async function loadOverview() {
  const response = await fetch('/api/v1/etf-whale/overview');
  const payload = await response.json();
  const overview = payload.overview;
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
    ['统计日期', overview.latest],
    ['当日净申赎（亿元）', money(overview.pool.flowYi)],
    ['近 5 日净申赎（亿元）', money(overview.recentFlowYi)],
    ['完整交易日', String(overview.completeDays)],
  ].map(([label, value]) => `<article class="card"><span>${label}</span><strong>${value}</strong></article>`).join('');
  groups.innerHTML = overview.groups.map((item) => `<tr><td>${item.group}</td><td>${item.covered}/${item.expected}</td><td>${item.inflowCount}</td><td>${item.outflowCount}</td><td>${cell(item.deltaYi)}</td><td>${money(item.flowYi)}</td></tr>`).join('');
  meta.textContent = JSON.stringify({ coverage: overview.coverage, report: overview.report }, null, 2);
}

async function loadSeries() {
  const code = codeInput.value.trim();
  const response = await fetch(`/api/v1/etf-whale/etfs/${code}`);
  const payload = await response.json();
  const points = payload.series?.points || [];
  seriesBody.innerHTML = points.slice(-30).reverse().map((item) => `<tr><td>${item.tradeDate}</td><td>${cell(item.sharesYi)}</td><td>${cell(item.deltaYi)}</td><td>${money(item.flowYi)}</td><td>${cell(item.closePrice)}</td><td>${item.reason}</td></tr>`).join('');
}

document.querySelector('#load').addEventListener('click', () => loadSeries().catch((error) => { status.textContent = error.message; }));
loadOverview().then(loadSeries).catch((error) => { title.textContent = '读取失败'; status.textContent = error.message; });
