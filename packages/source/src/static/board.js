import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseContract, StaticSignalBoardSchema } from '../../../contracts/src/index.js';

const focusCatalog = JSON.parse(readFileSync(new URL('./focus-events.json', import.meta.url), 'utf8'));

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
      note: String(snapshot.data.note || snapshot.warnings?.[0] || '').slice(0, 1_000),
    };
  });

  return parseContract(StaticSignalBoardSchema, {
    generatedAt: now(),
    upcoming: dedupeEvents(calendarRows).slice(0, input.limit),
    releases: dedupeReleases(releaseRows).slice(0, input.releaseLimit),
    sourceHealth,
  });
}
