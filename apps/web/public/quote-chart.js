const CANDLE_PANE = 'candle_pane';
const MAIN_INDICATORS = [
  { name: 'MA', label: 'MA' },
  { name: 'BOLL', label: 'BOLL' },
];
const SUB_INDICATORS = [
  { name: 'VOL', label: '成交量' },
  { name: 'MACD', label: 'MACD' },
  { name: 'KDJ', label: 'KDJ' },
];
const DEFAULT_INDICATORS = ['MA', 'VOL', 'MACD'];

export function barsToKLineData(bars) {
  const rows = [];
  for (const bar of bars || []) {
    const timestamp = Number(bar?.at);
    const open = Number(bar?.open);
    const high = Number(bar?.high);
    const low = Number(bar?.low);
    const close = Number(bar?.close);
    if (![timestamp, open, high, low, close].every(Number.isFinite)) continue;
    const row = {
      timestamp,
      open,
      high: Math.max(open, high, low, close),
      low: Math.min(open, high, low, close),
      close,
    };
    if (bar?.volume != null && bar.volume !== '') {
      const volume = Number(bar.volume);
      if (Number.isFinite(volume)) row.volume = volume;
    }
    rows.push(row);
  }
  rows.sort((left, right) => left.timestamp - right.timestamp);
  const unique = [];
  for (const row of rows) {
    const last = unique.at(-1);
    if (last && last.timestamp === row.timestamp) unique[unique.length - 1] = row;
    else unique.push(row);
  }
  return unique;
}

export function aggregateYearlyBars(bars) {
  const groups = new Map();
  for (const bar of bars || []) {
    const at = Number(bar?.at);
    const open = Number(bar?.open);
    const high = Number(bar?.high);
    const low = Number(bar?.low);
    const close = Number(bar?.close);
    if (![at, open, high, low, close].every(Number.isFinite)) continue;
    const year = new Date(at).getFullYear();
    const current = groups.get(year);
    const volume = bar?.volume == null || bar.volume === '' ? null : Number(bar.volume);
    if (!current) {
      const row = { at, open, high, low, close };
      if (Number.isFinite(volume)) row.volume = volume;
      groups.set(year, row);
      continue;
    }
    current.high = Math.max(current.high, high);
    current.low = Math.min(current.low, low);
    current.close = close;
    current.at = at;
    if (Number.isFinite(volume)) current.volume = (current.volume || 0) + volume;
  }
  return [...groups.values()].sort((left, right) => left.at - right.at);
}

export function quotePricePrecision(close) {
  const abs = Math.abs(Number(close));
  if (!Number.isFinite(abs) || abs >= 1) return 2;
  if (abs >= 0.01) return 4;
  return 6;
}

function volumePrecision(data) {
  return data.some((item) => Number.isFinite(item.volume) && !Number.isInteger(item.volume)) ? 2 : 0;
}

function cssColor(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function chartStyles() {
  const up = cssColor('--data-up', '#E84026');
  const down = cssColor('--data-down', '#00B42A');
  const grid = cssColor('--background-tertiary', '#E5E5EA');
  const muted = cssColor('--font-tertiary', '#5c6673');
  const primary = cssColor('--font-primary', '#1b2028');
  const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const candleBar = {
    compareRule: 'previous_close',
    upColor: up,
    downColor: down,
    noChangeColor: muted,
    upBorderColor: up,
    downBorderColor: down,
    noChangeBorderColor: muted,
    upWickColor: up,
    downWickColor: down,
    noChangeWickColor: muted,
  };
  const text = { family: font, color: muted };
  return {
    grid: {
      horizontal: { color: grid, style: 'solid' },
      vertical: { color: grid, style: 'solid' },
    },
    candle: {
      type: 'candle_solid',
      bar: candleBar,
      priceMark: {
        high: { show: false },
        low: { show: false },
        last: {
          compareRule: 'previous_close',
          upColor: up,
          downColor: down,
          noChangeColor: muted,
          text: { family: font },
        },
      },
      tooltip: {
        showRule: 'follow_cross',
        title: { ...text, color: primary },
        legend: text,
      },
    },
    indicator: {
      ohlc: {
        compareRule: 'previous_close',
        upColor: up,
        downColor: down,
        noChangeColor: muted,
      },
      bars: [{
        upColor: up,
        downColor: down,
        noChangeColor: muted,
      }],
      tooltip: {
        showRule: 'follow_cross',
        title: text,
        legend: text,
      },
    },
    xAxis: {
      axisLine: { color: grid },
      tickLine: { color: grid },
      tickText: text,
    },
    yAxis: {
      axisLine: { color: grid },
      tickLine: { color: grid },
      tickText: text,
    },
    separator: { color: grid, activeBackgroundColor: 'rgba(0, 0, 0, 0.04)' },
    crosshair: {
      horizontal: {
        line: { color: muted },
        text: { family: font, backgroundColor: primary, borderColor: primary, color: '#ffffff' },
      },
      vertical: {
        line: { color: muted },
        text: { family: font, backgroundColor: primary, borderColor: primary, color: '#ffffff' },
      },
    },
  };
}

function periodFromInterval(interval) {
  if (interval === '1wk') return { type: 'week', span: 1 };
  if (interval === '1y') return { type: 'year', span: 1 };
  if (interval === '1mo') return { type: 'month', span: 1 };
  return { type: 'day', span: 1 };
}

async function loadLibrary() {
  await import('./klinecharts.js?v=dev');
  const lib = globalThis.klinecharts;
  if (!lib?.init || !lib?.dispose) throw new Error('K线图表没有加载成功');
  return lib;
}

export async function createQuoteChart(host, options = {}) {
  const lib = await loadLibrary();
  const wrap = document.createElement('div');
  wrap.className = 'quote-chart-shell';
  const toolbar = document.createElement('div');
  toolbar.className = 'chip-tabs quote-indicator-tabs';
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', '技术指标');
  const plot = document.createElement('div');
  plot.className = 'quote-chart-plot';
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', options.ariaLabel || 'K线图');
  wrap.append(toolbar, plot);
  host.replaceChildren(wrap);

  const chart = lib.init(plot, {
    locale: 'zh-CN',
    styles: chartStyles(),
    layout: {
      barSpaceLimit: { min: 3, max: 96 },
      yAxis: { gap: { top: 0.08, bottom: 0.06 } },
    },
    formatter: {
      formatDate({ timestamp, type }) {
        const date = new Date(timestamp);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        if (type === 'xAxis') {
          if (interval === '1y') return String(date.getFullYear());
          if (interval === '1wk') return `${String(date.getFullYear()).slice(2)}-${month}`;
          const span = data.length > 1 ? data.at(-1).timestamp - data[0].timestamp : 0;
          if (span > 400 * 24 * 60 * 60 * 1000) return `${String(date.getFullYear()).slice(2)}-${month}`;
          return `${month}-${day}`;
        }
        return `${date.getFullYear()}-${month}-${day}`;
      },
    },
  });
  if (!chart) throw new Error('K线图表没有创建成功');

  const active = new Set(DEFAULT_INDICATORS);
  const buttons = new Map();
  let data = [];
  let symbol = options.symbol || 'QUOTE';
  let interval = options.interval || '1d';
  let period = periodFromInterval(interval);
  let frame = 0;

  function applyPriceAxis() {
    const minLow = data.reduce((min, bar) => Math.min(min, bar.low), Number.POSITIVE_INFINITY);
    chart.overrideYAxis({
      paneId: CANDLE_PANE,
      name: interval === '1y' && minLow > 0 ? 'logarithm' : 'normal',
    });
  }

  function fitLoadedBars() {
    chart.resize();
    const count = data.length;
    if (count < 2) return;
    const usable = Math.max(160, (plot.clientWidth || 320) - 72);
    const space = Math.min(96, Math.max(3, usable / count));
    chart.setBarSpace(space);
    chart.setOffsetRightDistance(16);
    chart.scrollToDataIndex(count - 1, 0);
  }

  chart.setDataLoader({
    getBars({ type, callback }) {
      const next = type === 'init' ? data : [];
      queueMicrotask(() => {
        callback(next, false);
        if (type === 'init') applyPriceAxis();
        requestAnimationFrame(fitLoadedBars);
      });
    },
  });

  function syncButton(name) {
    const button = buttons.get(name);
    if (!button) return;
    const on = active.has(name);
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function paintIndicators() {
    for (const item of [...MAIN_INDICATORS, ...SUB_INDICATORS]) {
      const onCandle = MAIN_INDICATORS.some((main) => main.name === item.name);
      if (active.has(item.name)) {
        const filter = onCandle ? { name: item.name, paneId: CANDLE_PANE } : { name: item.name };
        if (!chart.getIndicators(filter).length) {
          chart.createIndicator(onCandle ? { name: item.name, paneId: CANDLE_PANE } : item.name, true);
        }
      } else {
        chart.removeIndicator({ name: item.name });
      }
      syncButton(item.name);
    }
  }

  for (const item of [...MAIN_INDICATORS, ...SUB_INDICATORS]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip-tab';
    button.textContent = item.label;
    button.addEventListener('click', () => {
      if (active.has(item.name)) active.delete(item.name);
      else active.add(item.name);
      paintIndicators();
    });
    buttons.set(item.name, button);
    toolbar.append(button);
    syncButton(item.name);
  }

  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fitLoadedBars);
  });
  observer.observe(host);
  requestAnimationFrame(fitLoadedBars);

  return {
    setData({ bars = [], interval: nextInterval, symbol: nextSymbol } = {}) {
      data = barsToKLineData(bars);
      if (nextSymbol) symbol = nextSymbol;
      if (nextInterval) {
        interval = nextInterval;
        period = periodFromInterval(interval);
      }
      const last = data.at(-1);
      chart.setSymbol({
        ticker: symbol,
        pricePrecision: quotePricePrecision(last?.close),
        volumePrecision: volumePrecision(data),
      });
      chart.setPeriod(period);
      paintIndicators();
      applyPriceAxis();
    },
    destroy() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      lib.dispose(chart);
    },
  };
}
