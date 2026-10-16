import { ComputePriceBoardSchema, GpuRentHistoryQuerySchema, GpuRentHistorySchema } from '../../contracts/src/compute-prices.js';
import { parseContract, ValidationError } from '../../contracts/src/index.js';
import { formatYmd, zonedParts } from './zoned-time.js';
import { gpuRentNormalization, normalizeGpuRentRow } from './gpu-rent-normalization.js';
import {
  GPU_RENT_DAILY_SINCE,
  beijingDay,
  catalogModels,
  compareDecimal,
  eachIsoDay,
  easternDay,
  inclusiveIsoDays,
  previousIsoDay,
  rollGpuRentDays,
  shapeGpuRentHistory,
} from './gpu-rent-daily.js';

export const COMPUTE_PRICE_TIME_ZONE = 'Asia/Shanghai';

function scaled(value, scale = 8) {
  const text = String(value || '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const padded = (frac + '0'.repeat(scale)).slice(0, scale);
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt(padded);
}

export function changePercent(next, previous) {
  const current = scaled(next);
  const prior = scaled(previous);
  if (current == null || prior == null || prior === 0n) return null;
  const micro = ((current - prior) * 100_000_000n) / prior;
  const number = Number(micro) / 1_000_000;
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 10_000) / 10_000;
}

function latestPerDate(rows) {
  const byDate = new Map();
  for (const row of rows) byDate.set(row.quoteDate, row);
  return [...byDate.values()];
}

function priorRow(rows, quoteDate) {
  const dated = latestPerDate(rows).filter((row) => row.quoteDate < quoteDate);
  return dated.at(-1) || null;
}

export function quoteDateFor(capturedAt, timeZone = COMPUTE_PRICE_TIME_ZONE) {
  return formatYmd(zonedParts(capturedAt, timeZone));
}

export function createComputePriceService({ repository, timeZone = COMPUTE_PRICE_TIME_ZONE }) {
  return {
    save(workspaceId, input) {
      const explicit = typeof input?.quoteDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.quoteDate)
        ? input.quoteDate
        : '';
      const quoteDate = explicit || quoteDateFor(input.capturedAt, timeZone);
      return repository.save(workspaceId, input, quoteDate);
    },

    list(workspaceId) {
      const tokens = repository.latestTokens(workspaceId).map((row) => {
        const history = latestPerDate(repository.tokenHistory(workspaceId, row.modelKey));
        const previous = priorRow(history, row.quoteDate);
        return {
          modelKey: row.modelKey,
          modelId: row.modelId,
          name: row.name,
          quoteDate: row.quoteDate,
          promptPerMillion: row.promptPerMillion,
          completionPerMillion: row.completionPerMillion,
          contextLength: row.contextLength,
          promptChangePct: previous ? changePercent(row.promptPerMillion, previous.promptPerMillion) : null,
          completionChangePct: previous ? changePercent(row.completionPerMillion, previous.completionPerMillion) : null,
          history: history.slice(-180).map((point) => ({
            date: point.quoteDate,
            promptPerMillion: point.promptPerMillion,
            completionPerMillion: point.completionPerMillion,
          })),
          capturedAt: row.capturedAt,
        };
      });
      const gpus = repository.latestGpus(workspaceId).map((row) => {
        const history = latestPerDate(repository.gpuHistory(workspaceId, row.venue, row.gpuKey, row.lane));
        const previous = priorRow(history, row.quoteDate);
        return {
          venue: row.venue,
          gpuKey: row.gpuKey,
          label: row.label,
          lane: row.lane,
          quoteDate: row.quoteDate,
          usdPerHour: row.usdPerHour,
          sampleCount: row.sampleCount,
          changePct: previous ? changePercent(row.usdPerHour, previous.usdPerHour) : null,
          history: history.slice(-180).map((point) => ({ date: point.quoteDate, amount: point.usdPerHour })),
          capturedAt: row.capturedAt,
        };
      });
      return ComputePriceBoardSchema.parse({
        tokens,
        gpus,
        checks: repository.checks(workspaceId),
      });
    },

    rollup(workspaceId, { sinceDay = GPU_RENT_DAILY_SINCE, throughDay, now: nowMs = Date.now() } = {}) {
      const today = beijingDay(nowMs);
      let end = throughDay || previousIsoDay(today);
      if (end >= today) end = previousIsoDay(today);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDay) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < sinceDay) {
        return { sinceDay, throughDay: end, rows: 0, days: 0, carried: 0 };
      }
      const mapping = gpuRentNormalization();
      const observations = repository.listGpuObservations(workspaceId);
      const snapshots = repository.listGpuSnapshotChecks(workspaceId);
      const existingDays = new Set(repository.listRentDailyDays(workspaceId, sinceDay, end));
      const existingByDay = new Map();
      if (existingDays.size) {
        for (const row of repository.listDailyRange(workspaceId, sinceDay, end)) {
          if (row.sourceKey === 'ornn') continue;
          const list = existingByDay.get(row.day) || [];
          list.push(row);
          existingByDay.set(row.day, list);
        }
      }
      const built = rollGpuRentDays({
        observations,
        snapshots,
        mapping,
        sinceDay,
        throughDay: end,
        previousRows: repository.latestRentDailyBefore(workspaceId, sinceDay),
        existingByDay,
      });
      const byDay = new Map();
      for (const row of built) {
        const list = byDay.get(row.day) || [];
        list.push(row);
        byDay.set(row.day, list);
      }
      let rows = 0;
      let days = 0;
      let carried = 0;
      repository.transaction(() => {
        for (const day of eachIsoDay(sinceDay, end)) {
          if (existingDays.has(day) && day !== end) continue;
          const dayRows = byDay.get(day) || [];
          repository.replaceRentDailyDay(workspaceId, day, dayRows);
          rows += dayRows.length;
          days += 1;
          carried += dayRows.filter((row) => row.carriedForward).length;
        }
      });
      return { sinceDay, throughDay: end, rows, days, carried };
    },

    history(workspaceId, query, nowMs = Date.now()) {
      const parsed = parseHistoryQuery(query);
      const mapping = gpuRentNormalization();
      const today = beijingDay(nowMs);
      const observations = repository.listGpuObservations(workspaceId);
      const stored = repository.listDailyRange(workspaceId, parsed.start, parsed.end);
      const storedRentByDay = new Map();
      for (const row of stored) {
        if (row.sourceKey === 'ornn' || row.day >= today) continue;
        const list = storedRentByDay.get(row.day) || [];
        list.push(row);
        storedRentByDay.set(row.day, list);
      }
      const last = parsed.end < today ? parsed.end : today;
      const needed = parsed.start <= last
        ? eachIsoDay(parsed.start, last).filter((day) => day === today || !storedRentByDay.has(day))
        : [];
      let live = [];
      if (needed.length) {
        const built = rollGpuRentDays({
          observations,
          snapshots: repository.listGpuSnapshotChecks(workspaceId),
          mapping,
          sinceDay: needed[0],
          throughDay: needed[needed.length - 1],
          previousRows: repository.latestRentDailyBefore(workspaceId, needed[0]),
          existingByDay: storedRentByDay,
        });
        const want = new Set(needed);
        live = built.filter((row) => want.has(row.day));
      }
      const rent = [];
      for (const day of parsed.start <= last ? eachIsoDay(parsed.start, last) : []) {
        if (day === today) rent.push(...live.filter((row) => row.day === day));
        else if (storedRentByDay.has(day)) rent.push(...storedRentByDay.get(day));
        else rent.push(...live.filter((row) => row.day === day));
      }
      const rows = [...rent, ...stored.filter((row) => row.sourceKey === 'ornn')];
      const filtered = rows.filter((row) => (
        (!parsed.models || parsed.models.has(row.model))
        && (!parsed.tiers || parsed.tiers.has(row.tier))
        && (!parsed.sources || parsed.sources.has(row.sourceKey))
      ));
      const shaped = shapeGpuRentHistory({
        rows: filtered,
        grain: parsed.grain,
        coverageModels: mapping.coverageModels,
        presentModels: catalogModels(observations, repository.distinctDailyModels(workspaceId), mapping),
      });
      return GpuRentHistorySchema.parse({
        start: parsed.start,
        end: parsed.end,
        grain: parsed.grain,
        ...shaped,
      });
    },

    saveOrnnSeries(workspaceId, entry, points) {
      const mapping = gpuRentNormalization();
      const normalized = normalizeGpuRentRow(mapping, {
        sourceKey: 'ornn',
        variant: entry.variant,
        lane: entry.lane,
        label: entry.path,
      });
      if (!normalized) throw new Error(`Ornn ${entry.path} 无法归入型号和档位`);
      const byDay = new Map();
      for (const point of points || []) {
        const close = point.close;
        const day = easternDay(point.capturedAt);
        const current = byDay.get(day);
        if (!current) {
          byDay.set(day, { day, close, low: close, high: close, lastCapturedAt: point.capturedAt });
          continue;
        }
        if (point.capturedAt >= current.lastCapturedAt) {
          current.close = close;
          current.lastCapturedAt = point.capturedAt;
        }
        if (compareDecimal(close, current.low) < 0) current.low = close;
        if (compareDecimal(close, current.high) > 0) current.high = close;
      }
      const rows = [...byDay.values()].map((item) => ({
        day: item.day,
        sourceKey: 'ornn',
        variant: entry.variant,
        lane: entry.lane,
        model: normalized.model,
        tier: normalized.tier,
        close: item.close,
        low: item.low,
        high: item.high,
        sampleCount: null,
        lastCapturedAt: item.lastCapturedAt,
        carriedForward: false,
      }));
      repository.upsertDailyRows(workspaceId, rows);
      return rows.length;
    },
  };
}

const HISTORY_MODELS = new Set(['h100', 'h200', 'b200', 'b300', 'gb200']);
const HISTORY_TIERS = new Set(['guaranteed', 'community', 'median', 'index']);
const HISTORY_SOURCES = new Set(['runpod', 'vast', 'ccir', 'gpueconomy', 'bargo', 'ornn']);

function parseHistoryQuery(query) {
  const start = String(query?.start || '');
  const end = String(query?.end || '');
  if (!start || !end) throw new ValidationError('需要 start 和 end');
  const parsed = parseContract(GpuRentHistoryQuerySchema, {
    start,
    end,
    models: query.models || undefined,
    tiers: query.tiers || undefined,
    sources: query.sources || undefined,
    grain: query.grain || undefined,
  }, '起止日期无效');
  if (parsed.start > parsed.end) throw new ValidationError('start 不能晚于 end');
  const span = inclusiveIsoDays(parsed.start, parsed.end);
  if (span > 366) throw new ValidationError('起止日期最多 366 天');
  const grain = parsed.grain || 'day';
  if (grain === 'raw' && span > 31) throw new ValidationError('原始粒度最多 31 天');
  return {
    start: parsed.start,
    end: parsed.end,
    grain,
    models: parseChoice(parsed.models, HISTORY_MODELS, '型号'),
    tiers: parseChoice(parsed.tiers, HISTORY_TIERS, '档位'),
    sources: parseChoice(parsed.sources, HISTORY_SOURCES, '来源'),
  };
}

function parseChoice(value, allowed, label) {
  if (!value) return null;
  const items = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (!items.length) return null;
  for (const item of items) {
    if (!allowed.has(item)) throw new ValidationError(`未知${label}`);
  }
  return new Set(items);
}
