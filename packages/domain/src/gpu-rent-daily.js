import { addCalendarDays, formatYmd, zonedLocalToUtc, zonedParts } from './zoned-time.js';
import { normalizeGpuRentRow } from './gpu-rent-normalization.js';

export const GPU_RENT_DAILY_SINCE = '2026-10-11';
export const GPU_RENT_TIME_ZONE = 'Asia/Shanghai';
export const ORNN_TIME_ZONE = 'America/New_York';
const MODEL_ORDER = ['h100', 'h200', 'b200', 'b300', 'gb200'];
const TIER_ORDER = ['guaranteed', 'community', 'median', 'index'];
const SOURCE_ORDER = ['runpod', 'vast', 'ccir', 'gpueconomy', 'bargo', 'ornn'];

export function beijingDay(utcMs) {
  return formatYmd(zonedParts(utcMs, GPU_RENT_TIME_ZONE));
}

export function beijingDayStart(day) {
  const [year, month, date] = String(day).split('-').map(Number);
  return zonedLocalToUtc(year, month, date, 0, 0, GPU_RENT_TIME_ZONE);
}

export function easternDay(utcMs) {
  return formatYmd(zonedParts(utcMs, ORNN_TIME_ZONE));
}

export function previousIsoDay(day) {
  return shiftIsoDay(day, -1);
}

export function shiftIsoDay(day, delta) {
  const [year, month, date] = String(day).split('-').map(Number);
  return formatYmd(addCalendarDays(year, month, date, delta));
}

export function eachIsoDay(start, end) {
  const days = [];
  let cursor = start;
  while (cursor <= end) {
    days.push(cursor);
    cursor = shiftIsoDay(cursor, 1);
    if (days.length > 400) break;
  }
  return days;
}

export function inclusiveIsoDays(start, end) {
  const [year, month, date] = String(start).split('-').map(Number);
  const [endYear, endMonth, endDate] = String(end).split('-').map(Number);
  const span = Math.round((Date.UTC(endYear, endMonth - 1, endDate) - Date.UTC(year, month - 1, date)) / 86_400_000);
  return span + 1;
}

export function seriesKey(row) {
  return `${row.sourceKey}\u0000${row.variant}\u0000${row.lane}`;
}

export function indexDailyRows(rows) {
  const state = new Map();
  for (const row of rows || []) state.set(seriesKey(row), row);
  return state;
}

export function compareDecimal(left, right) {
  const scale = Math.max(fractionLength(left), fractionLength(right));
  const a = scaleDecimal(left, scale);
  const b = scaleDecimal(right, scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function groupObservationsByDay(observations) {
  const byDay = new Map();
  for (const row of observations || []) {
    if (!row || row.sourceKey === 'ornn' || row.sourceKey === 'openrouter') continue;
    const day = beijingDay(row.capturedAt);
    const list = byDay.get(day) || [];
    list.push(row);
    byDay.set(day, list);
  }
  return byDay;
}

export function groupSnapshotsByDay(snapshots) {
  const byDay = new Map();
  for (const snap of snapshots || []) {
    if (!snap?.sourceKey || snap.sourceKey === 'openrouter' || snap.sourceKey === 'ornn') continue;
    const days = new Set();
    if (Number.isFinite(snap.lastCheckedAt)) days.add(beijingDay(snap.lastCheckedAt));
    if (Number.isFinite(snap.capturedAt)) days.add(beijingDay(snap.capturedAt));
    for (const day of days) {
      const list = byDay.get(day) || [];
      list.push(snap);
      byDay.set(day, list);
    }
  }
  return byDay;
}

export function buildGpuRentDay({ day, observations, snapshots, mapping, state }) {
  const observed = new Map();
  for (const row of observations || []) {
    if (row.sourceKey === 'ornn' || row.sourceKey === 'openrouter') continue;
    const list = observed.get(row.sourceKey) || [];
    list.push(row);
    observed.set(row.sourceKey, list);
  }
  const checked = new Set(observed.keys());
  for (const snap of snapshots || []) {
    if (!snap?.sourceKey || snap.sourceKey === 'openrouter' || snap.sourceKey === 'ornn') continue;
    checked.add(snap.sourceKey);
  }
  const rows = [];
  const touched = [];
  for (const source of checked) {
    touched.push(source);
    const list = observed.get(source) || [];
    if (list.length) rows.push(...aggregateSource(day, source, list, mapping));
    else rows.push(...carrySource(day, source, state, checkInstant(snapshots, source, day)));
  }
  return { rows, touched };
}

export function rollGpuRentDays({
  observations,
  snapshots,
  mapping,
  sinceDay,
  throughDay,
  previousRows = [],
  existingByDay = new Map(),
}) {
  const state = indexDailyRows(previousRows);
  const observationsByDay = groupObservationsByDay(observations);
  const snapshotsByDay = groupSnapshotsByDay(snapshots);
  const out = [];
  for (const day of eachIsoDay(sinceDay, throughDay)) {
    const stored = existingByDay.get(day);
    if (stored && day !== throughDay) {
      replaceSourceState(state, [...new Set(stored.map((row) => row.sourceKey))], stored);
      continue;
    }
    const built = buildGpuRentDay({
      day,
      observations: observationsByDay.get(day) || [],
      snapshots: snapshotsByDay.get(day) || [],
      mapping,
      state,
    });
    replaceSourceState(state, built.touched, built.rows);
    out.push(...built.rows);
  }
  return out;
}

export function shapeGpuRentHistory({ rows, grain, coverageModels, presentModels }) {
  const present = presentModels || new Set();
  const coverage = (coverageModels || []).map((model) => ({
    model,
    status: present.has(model) ? 'ok' : 'no_source',
  }));
  const series = grain === 'raw' ? rawSeries(rows) : daySeries(rows);
  return { coverage, series };
}

export function catalogModels(observations, dailyModels, mapping) {
  const present = new Set(dailyModels || []);
  for (const row of observations || []) {
    const normalized = normalizeGpuRentRow(mapping, row);
    if (normalized) present.add(normalized.model);
  }
  return present;
}

function aggregateSource(day, source, list, mapping) {
  const groups = new Map();
  const ordered = [...list].sort((left, right) => left.capturedAt - right.capturedAt || String(left.id || '').localeCompare(String(right.id || '')));
  const lastCapturedAt = ordered.reduce((latest, row) => Math.max(latest, row.capturedAt), 0);
  const specs = new Set();
  for (const row of ordered) {
    if (row.capturedAt !== lastCapturedAt) continue;
    if (!normalizeGpuRentRow(mapping, row)) continue;
    specs.add(`${row.variant}\u0000${row.lane}`);
  }
  for (const row of ordered) {
    const normalized = normalizeGpuRentRow(mapping, row);
    if (!normalized) continue;
    const key = `${row.variant}\u0000${row.lane}`;
    if (!specs.has(key)) continue;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        day,
        sourceKey: source,
        variant: row.variant,
        lane: row.lane,
        model: normalized.model,
        tier: normalized.tier,
        close: row.usdPerHour,
        low: row.usdPerHour,
        high: row.usdPerHour,
        sampleCount: row.sampleCount ?? null,
        lastCapturedAt: row.capturedAt,
        carriedForward: false,
      });
      continue;
    }
    current.close = row.usdPerHour;
    current.sampleCount = row.sampleCount ?? null;
    current.lastCapturedAt = row.capturedAt;
    if (compareDecimal(row.usdPerHour, current.low) < 0) current.low = row.usdPerHour;
    if (compareDecimal(row.usdPerHour, current.high) > 0) current.high = row.usdPerHour;
  }
  return [...groups.values()];
}

function carrySource(day, source, state, lastCapturedAt) {
  const rows = [];
  for (const row of state.values()) {
    if (row.sourceKey !== source) continue;
    const captured = lastCapturedAt ?? row.lastCapturedAt;
    if (captured == null) continue;
    rows.push({
      day,
      sourceKey: source,
      variant: row.variant,
      lane: row.lane,
      model: row.model,
      tier: row.tier,
      close: row.close,
      low: row.close,
      high: row.close,
      sampleCount: row.sampleCount ?? null,
      lastCapturedAt: captured,
      carriedForward: true,
    });
  }
  return rows;
}

export function checkInstant(snapshots, source, day) {
  let latest = null;
  for (const snap of snapshots || []) {
    if (snap.sourceKey !== source) continue;
    if (!Number.isFinite(snap.lastCheckedAt) || beijingDay(snap.lastCheckedAt) !== day) continue;
    if (latest == null || snap.lastCheckedAt > latest) latest = snap.lastCheckedAt;
  }
  return latest;
}

function replaceSourceState(state, sources, rows) {
  const touched = new Set(sources);
  for (const [key, row] of state) {
    if (touched.has(row.sourceKey)) state.delete(key);
  }
  for (const row of rows) {
    if (touched.has(row.sourceKey)) state.set(seriesKey(row), row);
  }
}

function daySeries(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.model}\u0000${row.tier}\u0000${row.sourceKey}`;
    const group = groups.get(key) || { model: row.model, tier: row.tier, source: row.sourceKey, byDay: new Map() };
    const list = group.byDay.get(row.day) || [];
    list.push(row);
    group.byDay.set(row.day, list);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    model: group.model,
    tier: group.tier,
    source: group.source,
    dayBasis: group.source === 'ornn' ? 'ET' : 'Beijing',
    points: [...group.byDay.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([day, list]) => ({
      day,
      close: medianDecimal(list.map((row) => row.close)),
      low: list.map((row) => row.low).reduce((best, value) => (compareDecimal(value, best) < 0 ? value : best)),
      high: list.map((row) => row.high).reduce((best, value) => (compareDecimal(value, best) > 0 ? value : best)),
      sampleCount: sumSamples(list),
      carriedForward: list.every((row) => row.carriedForward),
    })),
  })).filter((series) => series.points.length).sort(compareSeries);
}

function rawSeries(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.model}\u0000${row.tier}\u0000${row.sourceKey}\u0000${row.variant}\u0000${row.lane}`;
    const group = groups.get(key) || {
      model: row.model,
      tier: row.tier,
      source: row.sourceKey,
      variant: row.variant,
      lane: row.lane,
      dayBasis: row.sourceKey === 'ornn' ? 'ET' : 'Beijing',
      points: [],
    };
    group.points.push({
      day: row.day,
      close: row.close,
      low: row.low,
      high: row.high,
      sampleCount: row.sampleCount ?? null,
      carriedForward: Boolean(row.carriedForward),
    });
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    points: group.points.sort((left, right) => left.day.localeCompare(right.day)),
  })).sort(compareSeries);
}

function compareSeries(left, right) {
  return orderIndex(MODEL_ORDER, left.model) - orderIndex(MODEL_ORDER, right.model)
    || orderIndex(TIER_ORDER, left.tier) - orderIndex(TIER_ORDER, right.tier)
    || orderIndex(SOURCE_ORDER, left.source) - orderIndex(SOURCE_ORDER, right.source)
    || String(left.variant || '').localeCompare(String(right.variant || ''))
    || String(left.lane || '').localeCompare(String(right.lane || ''));
}

function orderIndex(list, value) {
  const index = list.indexOf(value);
  return index === -1 ? list.length : index;
}

function sumSamples(rows) {
  let total = 0;
  let any = false;
  for (const row of rows) {
    if (row.sampleCount == null) continue;
    any = true;
    total += row.sampleCount;
  }
  return any ? total : null;
}

function medianDecimal(values) {
  const sorted = [...values].sort(compareDecimal);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return averageDecimal(sorted[mid - 1], sorted[mid]);
}

function averageDecimal(left, right) {
  const scale = Math.max(fractionLength(left), fractionLength(right)) + 1;
  const sum = scaleDecimal(left, scale) + scaleDecimal(right, scale);
  const half = sum / 2n;
  const unit = 10n ** BigInt(scale);
  const whole = half / unit;
  const frac = String(half % unit).padStart(scale, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

function fractionLength(value) {
  return String(value).split('.')[1]?.length || 0;
}

function scaleDecimal(value, scale) {
  const [whole, frac = ''] = String(value).split('.');
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt((frac + '0'.repeat(scale)).slice(0, scale));
}
