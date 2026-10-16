const venues = {
  runpod: 'RunPod',
  vast: 'Vast',
  ccir: 'CCIR',
  gpueconomy: 'GPU Economy',
  bargo: 'Bargo',
};
const lanes = {
  secure: '安全云',
  community: '社区云',
  min: '最低',
  median: '中位',
  'hyperscaler-guaranteed': '超大规模 · 保障',
  'neocloud-guaranteed': '新云 · 保障',
  'marketplace-guaranteed': '市场 · 保障',
  'hyperscaler-interruptible': '超大规模 · 可中断',
  'neocloud-interruptible': '新云 · 可中断',
  'marketplace-interruptible': '市场 · 可中断',
  ondemand: '按需',
  spot: '竞价',
  reserved: '预留',
};

export function gpuSourceUrl(venue, gpuKey) {
  if (venue === 'gpueconomy' && gpuKey) return `https://gpueconomy.com/gpu/${gpuKey}`;
  if (venue === 'ccir') return 'https://ccir.io/rates';
  if (venue === 'bargo') return 'https://www.bargo.ai/gpu-prices';
  if (venue === 'runpod') return 'https://www.runpod.io/pricing';
  if (venue === 'vast') return 'https://vast.ai/';
  return '';
}

export function gpuMatchesSource(item, source = 'all') {
  if (!source || source === 'all') return true;
  if (item?.compute?.kind !== 'gpu') return true;
  return item.compute.venue === source;
}

export function computeMarketItems(board, { kind = 'all' } = {}) {
  const tokens = (board?.tokens || []).map((row) => ({
    assetClass: 'compute',
    compute: { kind: 'token' },
    name: row.name,
    symbol: row.modelId,
    group: `每百万 token · 输出 ${row.completionPerMillion} · ${row.quoteDate}`,
    summary: row.modelId,
    lastPrice: row.promptPerMillion,
    priceSuffix: 'USD/1M',
    changePct: row.promptChangePct,
    sparkline: (row.history || []).map((point) => Number(point.promptPerMillion)),
  }));
  const gpus = (board?.gpus || []).filter((row) => row.venue !== 'vast' || Number(row.sampleCount) >= 3).map((row) => {
    const venue = venues[row.venue] || row.venue;
    const lane = lanes[row.lane] || row.lane;
    const count = Number(row.sampleCount) >= 1 ? ` · ${row.sampleCount} 条` : '';
    const sourceUrl = gpuSourceUrl(row.venue, row.gpuKey);
    return {
      assetClass: 'compute',
      compute: { kind: 'gpu', venue: row.venue, sourceUrl },
      name: row.label,
      symbol: venue,
      group: `${venue} · ${lane}${count} · ${row.quoteDate}`,
      summary: `${venue} ${row.label}`,
      lastPrice: row.usdPerHour,
      priceSuffix: 'USD/时',
      changePct: row.changePct,
      sparkline: (row.history || []).map((point) => Number(point.amount)),
    };
  });
  if (kind === 'token') return tokens;
  if (kind === 'gpu') return gpus;
  return [...tokens, ...gpus];
}

const modelLabels = { h100: 'H100', h200: 'H200', b200: 'B200', b300: 'B300', gb200: 'GB200' };
const tierLabels = { guaranteed: '保障', community: '社区', median: '中位', index: '指数' };
const sourceLabels = {
  runpod: 'RunPod',
  vast: 'Vast',
  ccir: 'CCIR',
  gpueconomy: 'GPU Economy',
  bargo: 'Bargo',
  ornn: 'Ornn',
};
const sourceColors = {
  runpod: '#0A59F7',
  vast: '#12A150',
  ccir: '#F59E0B',
  gpueconomy: '#7C6AF7',
  bargo: '#E11D48',
  ornn: '#0F766E',
};
const tierOrder = ['guaranteed', 'community', 'median', 'index'];
const modelOrder = ['h100', 'h200', 'b200', 'b300', 'gb200'];

export function gpuHistoryQuery(now = Date.now(), range = '90') {
  const spans = { '30': 30, '90': 90, all: 366 };
  const end = shanghaiDay(now);
  const span = spans[range] || 90;
  return { start: addIsoDays(end, 1 - span), end, grain: 'day' };
}

export function describeGpuRentHistory(payload, source = 'all') {
  const notes = (payload?.coverage || [])
    .filter((item) => item.status === 'no_source')
    .map((item) => `${modelLabels[item.model] || item.model} 暂无来源`);
  const panels = new Map();
  for (const series of payload?.series || []) {
    if (source && source !== 'all' && series.source !== source) continue;
    const key = `${series.model}\u0000${series.tier}`;
    const panel = panels.get(key) || {
      model: series.model,
      tier: series.tier,
      title: `${modelLabels[series.model] || series.model} · ${tierLabels[series.tier] || series.tier}`,
      series: [],
    };
    panel.series.push({
      source: series.source,
      label: sourceLabels[series.source] || series.source,
      color: sourceColors[series.source] || '#4e5968',
      points: [...(series.points || [])].sort((left, right) => left.day.localeCompare(right.day)),
    });
    panels.set(key, panel);
  }
  const ordered = [...panels.values()].sort((left, right) => (
    modelOrder.indexOf(left.model) - modelOrder.indexOf(right.model)
    || tierOrder.indexOf(left.tier) - tierOrder.indexOf(right.tier)
  ));
  return {
    notes,
    empty: '这段时间没有日租金。',
    panels: ordered,
  };
}

export function renderGpuRentHistory(root, payload, { source = 'all' } = {}) {
  if (!root) return;
  const view = describeGpuRentHistory(payload, source);
  root.replaceChildren();
  if (view.notes.length) {
    const note = document.createElement('p');
    note.className = 'gpu-rent-coverage';
    note.textContent = view.notes.join('，');
    root.append(note);
  }
  if (!view.panels.length) {
    const empty = document.createElement('p');
    empty.className = 'gpu-rent-empty';
    empty.textContent = view.empty;
    root.append(empty);
    return;
  }
  for (const panel of view.panels) root.append(renderHistoryPanel(panel));
}

function renderHistoryPanel(panel) {
  const section = document.createElement('section');
  section.className = 'gpu-rent-panel';
  const title = document.createElement('h3');
  title.textContent = panel.title;
  const latest = document.createElement('p');
  latest.className = 'gpu-rent-latest';
  latest.textContent = panel.series.map((series) => latestText(series)).join(' · ');
  const readout = document.createElement('p');
  readout.className = 'gpu-rent-readout';
  readout.textContent = '点图表查看当天高低价';
  const legend = document.createElement('ul');
  legend.className = 'gpu-rent-legend';
  for (const series of panel.series) {
    const item = document.createElement('li');
    const swatch = document.createElement('i');
    swatch.className = 'gpu-rent-swatch';
    swatch.style.background = series.color;
    item.append(swatch, document.createTextNode(series.label));
    legend.append(item);
  }
  section.append(title, latest, readout, renderHistoryChart(panel, readout), legend);
  if (panel.series.some((series) => series.points.some((point) => point.carriedForward))) {
    const hint = document.createElement('p');
    hint.className = 'gpu-rent-note';
    hint.textContent = '空心点表示当天已检查、价格未变，沿用上次。';
    section.append(hint);
  }
  return section;
}

function latestText(series) {
  const point = series.points.at(-1);
  if (!point) return series.label;
  const carried = point.carriedForward ? '（沿用上次）' : '';
  return `${series.label} ${point.close} 美元/时${carried}`;
}

function renderHistoryChart(panel, readout) {
  const width = 360;
  const height = 188;
  const pad = { left: 46, right: 10, top: 14, bottom: 28 };
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.classList.add('gpu-rent-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('tabindex', '0');
  const days = [...new Set(panel.series.flatMap((series) => series.points.map((point) => point.day)))].sort();
  const values = panel.series.flatMap((series) => series.points.flatMap((point) => [Number(point.low), Number(point.high)]));
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return svg;
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const xOf = (day) => {
    const index = days.indexOf(day);
    if (days.length <= 1) return pad.left + innerWidth / 2;
    return pad.left + (index / (days.length - 1)) * innerWidth;
  };
  const yOf = (value) => pad.top + (1 - ((value - min) / (max - min))) * innerHeight;
  const make = (tag, attributes) => {
    const node = document.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    svg.append(node);
    return node;
  };
  for (let tick = 0; tick <= 2; tick += 1) {
    const value = min + ((max - min) * tick) / 2;
    const y = yOf(value);
    make('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, stroke: 'rgba(0,0,0,0.08)' });
    const label = make('text', { x: 4, y: y + 4, fill: '#5c6673', 'font-size': 11 });
    label.textContent = value.toFixed(2);
  }
  const first = make('text', { x: pad.left, y: height - 8, fill: '#5c6673', 'font-size': 11 });
  first.textContent = shortDay(days[0]);
  const last = make('text', { x: width - pad.right, y: height - 8, fill: '#5c6673', 'font-size': 11, 'text-anchor': 'end' });
  last.textContent = shortDay(days.at(-1));
  for (const series of panel.series) {
    const commands = series.points.map((point) => `${xOf(point.day)},${yOf(Number(point.close))}`).join(' ');
    if (series.points.length > 1) {
      make('polyline', { points: commands, fill: 'none', stroke: series.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    }
    for (const point of series.points) {
      make('circle', {
        cx: xOf(point.day),
        cy: yOf(Number(point.close)),
        r: point.carriedForward ? 3.5 : 2.5,
        fill: point.carriedForward ? '#ffffff' : series.color,
        stroke: series.color,
        'stroke-width': 1.5,
      });
    }
  }
  const guide = make('line', { x1: 0, x2: 0, y1: pad.top, y2: height - pad.bottom, stroke: '#5c6673', 'stroke-dasharray': '3 4', visibility: 'hidden' });
  let selected = days.length - 1;
  const select = (index) => {
    selected = Math.max(0, Math.min(days.length - 1, index));
    const day = days[selected];
    guide.setAttribute('x1', xOf(day));
    guide.setAttribute('x2', xOf(day));
    guide.setAttribute('visibility', 'visible');
    const parts = panel.series.map((series) => {
      const point = series.points.find((item) => item.day === day);
      if (!point) return '';
      const carried = point.carriedForward ? '，沿用上次' : '';
      return `${series.label} 收 ${point.close}，低 ${point.low}，高 ${point.high}${carried}`;
    }).filter(Boolean);
    readout.textContent = `${monthDay(day)} ${parts.join('；')}`;
    svg.setAttribute('aria-label', `${panel.title}，${readout.textContent}`);
  };
  const pick = (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const px = ((event.clientX - rect.left) / rect.width) * width;
    select(days.reduce((best, day, index) => (Math.abs(xOf(day) - px) < Math.abs(xOf(days[best]) - px) ? index : best), 0));
  };
  svg.addEventListener('pointerdown', pick);
  svg.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse' || event.buttons) pick(event);
  });
  svg.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    select(selected + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  select(selected);
  return svg;
}

function shanghaiDay(ms) {
  const shifted = new Date(Number(ms) + 8 * 60 * 60 * 1000);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

function addIsoDays(day, delta) {
  const [year, month, date] = day.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date + delta));
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${utc.getUTCFullYear()}-${mm}-${dd}`;
}

function shortDay(day) {
  return String(day || '').slice(5);
}

function monthDay(day) {
  const [, month, date] = String(day || '').split('-');
  return `${Number(month)}月${Number(date)}日`;
}
