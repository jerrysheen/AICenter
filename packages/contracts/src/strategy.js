import { z } from 'zod';
import { EntityIdSchema, EpochMillisSchema, WorkspaceIdSchema } from './common.js';

const NullableFiniteSchema = z.number().finite().nullable();
const UnitSchema = z.number().min(0).max(1);

export const DIVIDEND_STRATEGY_KEY = 'cn.dividend.value';

export const DividendRegimeSchema = z.enum([
  'NORMAL',
  'VALUE_HIGH',
  'VALUE_LOW',
  'VALUE_HIGH_PAIN_HIGH',
  'VALUE_NORMAL_PAIN_HIGH',
  'VALUE_LOW_PAIN_HIGH',
  'UNKNOWN',
]);

export const DividendStrategyFactorsSchema = z.object({
  value: z.object({
    dividendYield: NullableFiniteSchema,
    dividendYieldPercentile5y: NullableFiniteSchema,
    peTtm: NullableFiniteSchema,
    pePercentile5y: NullableFiniteSchema,
    pb: NullableFiniteSchema,
    pbPercentile5y: NullableFiniteSchema,
  }).strict(),
  pain: z.object({
    return20d: NullableFiniteSchema,
    return60d: NullableFiniteSchema,
    return120d: NullableFiniteSchema,
    return252d: NullableFiniteSchema,
    drawdown252d: NullableFiniteSchema,
    distanceToMA20: NullableFiniteSchema,
    distanceToMA60: NullableFiniteSchema,
    distanceToMA120: NullableFiniteSchema,
    distanceToMA250: NullableFiniteSchema,
    breadthAboveMA20: NullableFiniteSchema,
    breadthAboveMA60: NullableFiniteSchema,
  }).strict(),
  dataQuality: z.object({
    constituentCount: z.number().int().nonnegative(),
    coverage: UnitSchema,
    earningsCoverage: UnitSchema,
    negativePeWeight: UnitSchema,
    missingWeight: UnitSchema,
    adjustedPrice: z.boolean(),
  }).strict(),
  regime: DividendRegimeSchema,
}).strict();

export const BasketStatisticsSchema = z.object({
  index: z.string().regex(/^\d{6}$/),
  name: z.string().max(64),
  range: z.string().trim().min(1).max(16),
  asOf: EpochMillisSchema.nullable(),
  tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  status: z.enum(['ready', 'partial', 'unavailable']),
  constituentCount: z.number().int().nonnegative(),
  value: DividendStrategyFactorsSchema.shape.value,
  pain: DividendStrategyFactorsSchema.shape.pain,
  dataQuality: DividendStrategyFactorsSchema.shape.dataQuality,
  warnings: z.array(z.string().trim().min(1).max(500)).max(30),
}).strict();

export const StrategySnapshotSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  strategyKey: z.literal(DIVIDEND_STRATEGY_KEY),
  asOf: EpochMillisSchema,
  status: z.enum(['ready', 'partial', 'unavailable']),
  factors: DividendStrategyFactorsSchema,
  warnings: z.array(z.string().trim().min(1).max(500)).max(30),
  createdAt: EpochMillisSchema,
}).strict();

export const StrategySnapshotJobInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
  scheduledFor: EpochMillisSchema.optional(),
  scheduleKey: z.string().trim().min(1).max(128).optional(),
}).strict();
