import { z } from 'zod';

const NullableFiniteSchema = z.number().finite().nullable();

export const FactorPercentileSchema = z.object({
  percentile: z.number().min(0).max(1).nullable(),
  sampleCount: z.number().int().nonnegative(),
  window: z.string().trim().min(1).max(32),
  requestedWindow: z.string().trim().min(1).max(32),
  actualStartAt: z.number().int().nonnegative().nullable(),
  coverage: z.number().min(0).max(1),
}).strict();

export const FactorMetricSchema = z.object({
  value: NullableFiniteSchema,
  percentile1y: FactorPercentileSchema,
  percentile3y: FactorPercentileSchema,
  percentile5y: FactorPercentileSchema,
  available: FactorPercentileSchema,
}).strict();

export const StockFactorSnapshotSchema = z.object({
  symbol: z.string().trim().min(1).max(64),
  asOf: z.number().int().nonnegative(),
  price: z.object({
    return5d: NullableFiniteSchema,
    return20d: NullableFiniteSchema,
    return60d: NullableFiniteSchema,
    return120d: NullableFiniteSchema,
    return252d: NullableFiniteSchema,
    distanceToMA20: NullableFiniteSchema,
    distanceToMA60: NullableFiniteSchema,
    distanceToMA120: NullableFiniteSchema,
    distanceToMA250: NullableFiniteSchema,
    pricePosition252d: NullableFiniteSchema,
  }).strict(),
  risk: z.object({
    drawdown20d: NullableFiniteSchema,
    drawdown60d: NullableFiniteSchema,
    drawdown252d: NullableFiniteSchema,
    maxDrawdown252d: NullableFiniteSchema,
    realizedVol20: NullableFiniteSchema,
    realizedVol60: NullableFiniteSchema,
  }).strict(),
  valuation: z.object({
    peTtm: FactorMetricSchema,
    pb: FactorMetricSchema,
    dividendYieldTtm: FactorMetricSchema,
  }).strict(),
  liquidity: z.object({
    turnoverRate: z.object({
      value: NullableFiniteSchema,
      percentile20d: FactorPercentileSchema,
      percentile252d: FactorPercentileSchema,
    }).strict(),
    volumeRatio: NullableFiniteSchema,
    volume20dMean: NullableFiniteSchema,
    volume20dRatio: NullableFiniteSchema,
    volume20dZScore: NullableFiniteSchema,
  }).strict(),
  coverage: z.object({
    priceSamples: z.number().int().nonnegative(),
    metricSamples: z.number().int().nonnegative(),
    adjustedPrice: z.boolean(),
  }).strict(),
  warnings: z.array(z.string().trim().min(1).max(500)).max(20),
}).strict();

export const StockStatisticsSchema = z.object({
  instrument: z.object({
    symbol: z.string().trim().min(1).max(64),
    name: z.string().max(256),
  }).strict(),
  range: z.string().trim().min(1).max(16),
  asOf: z.number().int().nonnegative(),
  quote: z.object({
    lastPrice: NullableFiniteSchema,
    changePct: NullableFiniteSchema,
  }).strict(),
  price: z.object({
    return5d: NullableFiniteSchema,
    return20d: NullableFiniteSchema,
    return60d: NullableFiniteSchema,
    return252d: NullableFiniteSchema,
  }).strict(),
  trend: z.object({
    distanceMA20: NullableFiniteSchema,
    distanceMA60: NullableFiniteSchema,
    distanceMA250: NullableFiniteSchema,
  }).strict(),
  risk: z.object({
    realizedVol20: NullableFiniteSchema,
    realizedVol60: NullableFiniteSchema,
    drawdown252: NullableFiniteSchema,
    maxDrawdown252: NullableFiniteSchema,
  }).strict(),
  valuation: z.object({
    peTtm: FactorMetricSchema,
    pb: FactorMetricSchema,
    dividendYieldTtm: FactorMetricSchema,
  }).strict(),
  liquidity: z.object({
    turnoverRate: NullableFiniteSchema,
    turnoverPercentile252: FactorPercentileSchema,
    volumeRatio: NullableFiniteSchema,
  }).strict(),
  coverage: StockFactorSnapshotSchema.shape.coverage,
  warnings: z.array(z.string().trim().min(1).max(500)).max(20),
}).strict();
