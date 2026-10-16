import { readFileSync } from 'node:fs';
import { z } from 'zod';

const EntrySchema = z.object({
  slug: z.string().trim().min(1).max(256),
  group: z.string().trim().min(1).max(64),
  alertProfile: z.enum(['binary', 'multi', 'geopolitics']),
  seriesId: z.string().trim().max(64).default(''),
}).strict();

const AlertProfileSchema = z.object({
  move1hPp: z.number().positive().optional(),
  move24hPp: z.number().positive().optional(),
  levels: z.array(z.number().gt(0).lt(1)).max(8).optional(),
  hysteresisPp: z.number().positive().optional(),
  leadChange: z.boolean().optional(),
}).strict();

export const PolymarketWatchlistConfigSchema = z.object({
  fixed: z.array(EntrySchema).min(1).max(200),
  months: z.array(z.string().trim().min(1)).length(12),
  rollingSeries: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    tag: z.string().trim().min(1).max(64),
    seriesSlug: z.string().trim().min(1).max(128).optional(),
    titleTemplate: z.string().trim().min(1).max(200),
    hold: z.number().int().min(1).max(2),
  }).strict()).max(20).default([]),
  discovery: z.object({
    whitelistTags: z.array(z.string().trim().min(1)).min(1),
    excludeTags: z.array(z.string().trim().min(1)).default([]),
    excludeTitlePattern: z.string().trim().min(1),
    minVolume24hUsd: z.number().nonnegative(),
    minTotalVolumeUsd: z.number().nonnegative(),
    scanIntervalMinutes: z.number().int().min(1).default(60),
    pageLimit: z.number().int().min(1).max(200).default(100),
  }).strict(),
  alerts: z.object({
    illiquidLiquidityUsd: z.number().nonnegative(),
    cooldownMinutes: z.number().int().min(1),
    profiles: z.object({
      binary: AlertProfileSchema,
      geopolitics: AlertProfileSchema,
      multi: AlertProfileSchema,
    }).strict(),
  }).strict(),
  fetch: z.object({
    batchSize: z.number().int().min(1).max(20).default(10),
    minIntervalMs: z.number().int().min(0).default(800),
    intervalMinutes: z.number().int().min(1).default(5),
    releaseIntervalMinutes: z.number().int().min(1).default(1),
    pointIntervalMinutes: z.number().int().min(1).default(5),
    releasePointIntervalMinutes: z.number().int().min(1).default(1),
    downsampleAfterDays: z.number().int().min(1).default(30),
    staleAfterMinutes: z.number().int().min(1).default(20),
  }).strict(),
  releaseCalendar: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timeZone: z.string().trim().min(1),
    slugs: z.array(z.string().trim().min(1)).min(1),
  }).strict()).default([]),
}).strict();

export function polymarketLegacyEnabled(env = process.env) {
  const source = env || process.env;
  return /^(1|true|yes)$/i.test(String(source.AI_CENTER_POLYMARKET_LEGACY || '').trim());
}

export function loadPolymarketWatchlist(filePath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Polymarket 观察清单无法读取：${error instanceof Error ? error.message : error}`);
  }
  const parsed = PolymarketWatchlistConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Polymarket 观察清单配置不正确：${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).slice(0, 6).join('，')}`);
  }
  const slugs = parsed.data.fixed.map((entry) => entry.slug);
  if (new Set(slugs).size !== slugs.length) throw new Error('Polymarket 观察清单有重复 slug');
  return parsed.data;
}

export function fixedEntries(config) {
  return config.fixed.map((entry, index) => ({ ...entry, seriesId: entry.seriesId || '', sortOrder: index }));
}
