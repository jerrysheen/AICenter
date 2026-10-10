import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseContract, StaticSignalBoardSchema } from '../../../contracts/src/index.js';

const focusCatalog = JSON.parse(readFileSync(new URL('./focus-events.json', import.meta.url), 'utf8'));
const CHRONIC_UNAVAILABLE_MS = 24 * 60 * 60 * 1000;
const CHRONIC_SEED_IDS = new Set(['calendar.cn.customs', 'calendar.us.bls', 'calendar.us.census']);

function readStreakFile(filePath) {
  const records = new Map();
  if (!filePath) return records;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return records;
    for (const [sourceId, row] of Object.entries(parsed)) {
      if (!row || typeof row !== 'object') continue;
      const failingSince = Number(row.failingSince);
      const lastSuccessAt = Number(row.lastSuccessAt);
      records.set(sourceId, {
        failingSince: Number.isFinite(failingSince) && failingSince > 0 ? failingSince : null,
        lastSuccessAt: Number.isFinite(lastSuccessAt) && lastSuccessAt > 0 ? lastSuccessAt : null,
      });
    }
  } catch {
    // 没有记录时从这一轮开始记。
  }
  return records;
}

export function createFailureStreakStore({ filePath } = {}) {
  const records = readStreakFile(filePath);
  let dirty = false;
  return {
    failingSince(sourceId, status, now) {
      const prior = records.get(sourceId) || null;
      if (status === 'ready' || status === 'partial') {
        if (!prior || prior.failingSince != null) {
          records.set(sourceId, { failingSince: null, lastSuccessAt: now });
          dirty = true;
        }
        return null;
      }
      if (prior?.failingSince) return prior.failingSince;
      const since = !prior && CHRONIC_SEED_IDS.has(sourceId) ? now - CHRONIC_UNAVAILABLE_MS - 1 : now;
      records.set(sourceId, { failingSince: since, lastSuccessAt: prior?.lastSuccessAt ?? null });
      dirty = true;
      return since;
    },
    flush() {
      if (!filePath || !dirty) return;
      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        const payload = Object.fromEntries(records);
        writeFileSync(filePath, `${JSON.stringify(payload)}\n`);
        dirty = false;
      } catch {
        // 记不住连续失败时仍返回本轮看板。
      }
    },
  };
}

const defaultFailureStreaks = createFailureStreakStore();
let installedFailureStreaks = null;

export function installFailureStreakStore(store) {
  installedFailureStreaks = store || null;
}

function activeFailureStreaks(override) {
  return override || installedFailureStreaks || defaultFailureStreaks;
}

const BooleanQuerySchema = z.preprocess((value) => {
  if (value === true || value === '1' || value === 'true') return true;
  if (value === false || value === '0' || value === 'false' || value === undefined) return false;
  return value;
}, z.boolean());

export const StaticSignalBoardInputSchema = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().nonnegative(),
  focus: BooleanQuerySchema.default(false),
  includeUndated: BooleanQuerySchema.default(false),
  limit: z.coerce.number().int().min(1).max(1_000).default(200),
  releaseLimit: z.coerce.number().int().min(1).max(200).default(50),
}).strict().refine((value) => value.from <= value.to, {
  message: 'from 不能晚于 to', path: ['from'],
});

function normalized(value = '') {
  return String(value).normalize('NFKC').toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function dayKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function calendarKey(event) {
  const title = normalized(event.title);
  if (event.country === 'US' && event.scheduledAt !== null && title.includes('fomc')) {
    return `US:fomc:${dayKey(event.scheduledAt)}`;
  }
  return [event.country, title, event.scheduledAt ?? event.status].join(':');
}

function releaseKeys(release) {
  return [
    `url:${release.sourceUrl}`,
    `fact:${normalized(release.authority)}:${normalized(release.title)}:${dayKey(release.publishedAt)}`,
  ];
}

function sourcePriority(sourceId) {
  if (sourceId === 'calendar.us.fomc') return 100;
  if (sourceId === 'calendar.us.fed') return 10;
  return 50;
}

function dedupeEvents(rows) {
  const selected = new Map();
  for (const row of rows) {
    const key = calendarKey(row.event);
    const current = selected.get(key);
    if (!current || sourcePriority(row.sourceId) > sourcePriority(current.sourceId)) selected.set(key, row);
  }
  return [...selected.values()].map((row) => row.event)
    .sort((left, right) => (left.scheduledAt ?? Number.MAX_SAFE_INTEGER) - (right.scheduledAt ?? Number.MAX_SAFE_INTEGER)
      || left.title.localeCompare(right.title));
}

function dedupeReleases(rows) {
  const seen = new Set();
  const releases = [];
  for (const row of rows.sort((left, right) => right.release.publishedAt - left.release.publishedAt)) {
    const keys = releaseKeys(row.release);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    releases.push(row.release);
  }
  return releases;
}

function isFocusEvent(event, sourceId) {
  if ((focusCatalog.alwaysSourceIds || []).includes(sourceId)) return true;
  const title = normalized(event.title);
  return (focusCatalog[event.country] || []).some((keyword) => title.includes(normalized(keyword)));
}

export async function readStaticSignalBoard(sourcePort, rawInput, options = {}) {
  if (!sourcePort?.list || !sourcePort?.read) throw new TypeError('static signal board requires a Source port');
  const input = parseContract(StaticSignalBoardInputSchema, rawInput);
  const now = options.now || (() => Date.now());
  const observedNow = now();
  const streaks = activeFailureStreaks(options.failureStreaks);
  const manifests = sourcePort.list().filter((source) => ['calendar', 'official-release'].includes(source.viewKind));
  const settled = await Promise.all(manifests.map(async (manifest) => {
    try {
      const sourceInput = manifest.viewKind === 'calendar'
        ? { from: input.from, to: input.to, limit: 1_000 }
        : { limit: input.releaseLimit };
      const snapshot = await sourcePort.read(manifest.id, sourceInput, { refresh: Boolean(options.refresh) });
      return { manifest, snapshot, error: null };
    } catch (error) {
      return { manifest, snapshot: null, error };
    }
  }));

  const calendarRows = [];
  const releaseRows = [];
  const sourceHealth = settled.map(({ manifest, snapshot, error }) => {
    if (!snapshot) {
      return {
        sourceId: manifest.id, title: manifest.title, category: manifest.category,
        status: 'unavailable', observedAt: null,
        failingSince: streaks.failingSince(manifest.id, 'unavailable', observedNow),
        note: String(error?.message || error || '读取失败').replace(/\s+/g, ' ').slice(0, 1_000),
      };
    }
    if (manifest.viewKind === 'calendar') {
      for (const event of snapshot.data.events) {
        if (event.scheduledAt === null && !input.includeUndated) continue;
        if (input.focus && !isFocusEvent(event, manifest.id)) continue;
        calendarRows.push({ sourceId: manifest.id, event });
      }
    } else {
      for (const release of snapshot.data.releases) releaseRows.push({ sourceId: manifest.id, release });
    }
    return {
      sourceId: manifest.id, title: manifest.title, category: manifest.category,
      status: snapshot.status, observedAt: snapshot.observedAt,
      failingSince: streaks.failingSince(manifest.id, snapshot.status, observedNow),
      note: String(snapshot.data.note || snapshot.warnings?.[0] || '').slice(0, 1_000),
    };
  });
  streaks.flush();

  return parseContract(StaticSignalBoardSchema, {
    generatedAt: observedNow,
    upcoming: dedupeEvents(calendarRows).slice(0, input.limit),
    releases: dedupeReleases(releaseRows).slice(0, input.releaseLimit),
    sourceHealth,
  });
}
