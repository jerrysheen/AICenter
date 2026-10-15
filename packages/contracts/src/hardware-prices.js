import { z } from 'zod';

// Old parses folded session high/low into the specification (`· 日高點: 19.70`).
// Reads and dedupe use the product name only.
export function canonicalHardwareSpecification(value) {
  return String(value ?? '')
    .replace(/^(?:項目|项目|Item)\s*:\s*/i, '')
    .replace(/\s*·\s*(?:(?:日|盤|盘)?(?:高|低)(?:點|点)|High|Low)\s*:[\s\S]*$/i, '')
    .trim();
}

export function hardwareQuoteIdentity(row) {
  return [row.category || '', row.quoteType || '', canonicalHardwareSpecification(row.specification)].join('\0');
}

export function hardwareQuoteRank(row) {
  const clean = canonicalHardwareSpecification(row.specification);
  const sodimm = /SO-?DIMM/i.test(clean);
  let score = 0;
  if (row.unit) score += 8;
  if (row.period && row.periodStart != null && !String(row.periodKey || '').startsWith('unverified:')) score += 4;
  if (String(row.specification || '') === clean) score += 2;
  if (sodimm && row.unit === 'module') score += 16;
  if (sodimm && row.unit === 'chip') score -= 4;
  return score;
}

export function isSupersededHardwareQuote(row, keeper) {
  if (!keeper || !row || row.id === keeper.id) return false;
  if (hardwareQuoteIdentity(row) !== hardwareQuoteIdentity(keeper)) return false;
  const unverified = String(row.periodKey || '').startsWith('unverified:') || !row.period || row.periodStart == null;
  const keeperDated = Boolean(keeper.period && keeper.periodStart != null && !String(keeper.periodKey || '').startsWith('unverified:'));
  if (unverified) return keeperDated;
  const sameSeries = Boolean(row.seriesKey && keeper.seriesKey && row.seriesKey === keeper.seriesKey);
  if (sameSeries) return false;
  if (!keeper.unit || !keeperDated) return false;
  const clean = canonicalHardwareSpecification(row.specification);
  const dirty = String(row.specification || '') !== clean;
  const sodimmChip = /SO-?DIMM/i.test(clean) && row.unit === 'chip' && keeper.unit === 'module';
  return !row.unit || dirty || sodimmChip;
}

export function preferHardwareQuotes(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = hardwareQuoteIdentity(row);
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  const chosen = [];
  for (const list of groups.values()) {
    const ranked = [...list].sort((a, b) => hardwareQuoteRank(b) - hardwareQuoteRank(a)
      || (b.periodStart ?? -1) - (a.periodStart ?? -1)
      || (b.sourceUpdatedAt ?? -1) - (a.sourceUpdatedAt ?? -1)
      || (b.capturedAt ?? 0) - (a.capturedAt ?? 0));
    chosen.push(ranked[0]);
  }
  return chosen;
}

const nullableText = z.string().trim().min(1).max(1000).nullable();
const epoch = z.number().int().nonnegative().nullable();
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/).nullable();
export const HardwareQuoteRowSchema = z.object({
  specification: z.string().trim().min(1).max(1000),
  category: z.enum(['dram', 'nand', 'ssd', 'other-storage']),
  quoteType: z.enum(['spot', 'contract', 'retail', 'unknown']),
  average: decimal, high: decimal, low: decimal,
  averageBasis: nullableText.default(null), highBasis: nullableText.default(null), lowBasis: nullableText.default(null),
  currency: nullableText, unit: nullableText, taxBasis: nullableText,
  period: nullableText, periodStart: epoch, periodEnd: epoch,
  sourceUpdatedAt: epoch, sourceUpdatedRaw: z.string().max(1000),
  reportedChange: nullableText, changeBasis: nullableText,
  tableIndex: z.number().int().nonnegative(), rowIndex: z.number().int().nonnegative(),
  rawCells: z.array(z.string().max(5000)).max(80),
}).strict().refine(r => [r.average, r.high, r.low].some(v => v !== null), 'quote needs a numeric value');
export const HardwarePriceSnapshotInputSchema = z.object({
  sourceKey: z.string().regex(/^[a-z0-9]+$/), pageKey: z.string().min(1).max(100),
  sourceUrl: z.url(), title: z.string().max(1000),
  capturedAt: z.number().int().nonnegative(), parserVersion: z.string().min(1).max(100),
  format: z.enum(['html', 'legacy-text']), raw: z.string().min(1).max(2_097_152),
  rows: z.array(HardwareQuoteRowSchema).max(5000), warnings: z.array(z.string().max(1000)).max(100),
}).strict();
export const HardwarePriceListQuerySchema = z.object({
  category: z.enum(['dram', 'nand', 'ssd', 'other-storage']).optional(),
  snapshotId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
}).strict();
export const HardwareQuoteViewSchema = HardwareQuoteRowSchema.safeExtend({
  id: z.uuid(), seriesKey: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(),
  previousId: z.uuid().nullable(), snapshotId: z.uuid(), capturedAt: z.number().int().nonnegative(), isCurrent: z.boolean(),
  verification: z.enum(['verified','pending']), missing: z.array(z.string()),
  changePct: z.number().finite().nullable(), computedChangeBasis: z.string().nullable(),
  history: z.array(z.object({at:z.number().int().nonnegative(),period:z.string(),average:z.string().regex(/^-?\d+(?:\.\d+)?$/)}).strict()).max(5000).default([]),
});
export const HardwareSnapshotViewSchema = z.object({
  id: z.uuid(), sourceKey: z.string(), pageKey: z.string(), sourceUrl: z.url(), title: z.string(),
  capturedAt: z.number().int().nonnegative(),
  lastCheckedAt: z.number().int().nonnegative(),
  lastChangedAt: z.number().int().nonnegative(),
  format: z.enum(['html','legacy-text']), parserVersion: z.string(), warnings: z.array(z.string()),
}).strict();
export const HardwarePricePageCheckSchema = z.object({
  sourceKey: z.string(), pageKey: z.string(),
  lastCheckedAt: z.number().int().nonnegative(), lastChangedAt: z.number().int().nonnegative(),
  unchanged: z.boolean(),
}).strict();
export const HardwarePriceListViewSchema = z.object({
  items:z.array(HardwareQuoteViewSchema),
  snapshot:HardwareSnapshotViewSchema.nullable(),
  pages:z.array(HardwarePricePageCheckSchema).max(20).default([]),
}).strict();
export const HardwarePriceDetailViewSchema = z.object({current:HardwareQuoteViewSchema,observations:z.array(HardwareQuoteViewSchema),revisions:z.array(HardwareQuoteViewSchema),
  hasHistory:z.boolean(),snapshots:z.array(HardwareSnapshotViewSchema)}).strict();
export const HardwarePriceSnapshotViewSchema = HardwareSnapshotViewSchema.extend({raw:z.string(),items:z.array(HardwareQuoteViewSchema)});
export const ImportedMediaArticleSchema = z.object({
  externalId: z.string().min(1).max(512), title: z.string().max(1000), summary: z.string().max(20000),
  body: z.string().max(2_000_000), sourceUrl: z.url(), publishedAt: epoch,
  articleKind: z.enum(['article', 'report-intro']),
  contentLevel: z.enum(['full', 'partial', 'summary_only', 'title_only']),
  extractorVersion: z.string().max(100), observedAt: z.number().int().nonnegative().optional(),
  paragraphs: z.array(z.object({id:z.string().regex(/^p\d{4,}$/),text:z.string().min(1).max(100000),kind:z.enum(['paragraph','heading','table','list','quote'])}).strict()).max(2000),
}).strict().refine(a => a.articleKind !== 'report-intro' || ['summary_only','title_only'].includes(a.contentLevel), 'report intro cannot be full').refine(a=>a.contentLevel!=='full' || Boolean(a.body.trim() && a.paragraphs.length && a.extractorVersion), 'full body needs saved text, paragraphs and extractor provenance');
