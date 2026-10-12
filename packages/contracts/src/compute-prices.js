import { z } from 'zod';

const decimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const quoteDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const epoch = z.number().int().nonnegative();

export const TokenPriceRowSchema = z.object({
  sortIndex: z.number().int().nonnegative(),
  modelKey: z.string().regex(/^[a-z0-9-]+$/),
  modelId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  promptPerMillion: decimal,
  completionPerMillion: decimal,
  contextLength: z.number().int().positive().nullable(),
}).strict();

export const GpuRentRowSchema = z.object({
  sortIndex: z.number().int().nonnegative(),
  gpuKey: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().trim().min(1).max(120),
  lane: z.enum(['secure', 'community', 'min', 'median']),
  usdPerHour: decimal,
  sampleCount: z.number().int().positive().nullable(),
}).strict();

export const ComputePriceSnapshotInputSchema = z.object({
  sourceKey: z.enum(['openrouter', 'runpod', 'vast']),
  capturedAt: epoch,
  parserVersion: z.string().trim().min(1).max(40),
  warnings: z.array(z.string().max(300)).max(20),
  tokens: z.array(TokenPriceRowSchema).max(40).default([]),
  gpus: z.array(GpuRentRowSchema).max(40).default([]),
}).strict().refine((value) => (
  value.sourceKey === 'openrouter' ? value.gpus.length === 0 : value.tokens.length === 0
), 'token and gpu rows stay on their own source');

const historyPoint = z.object({
  date: quoteDate,
  amount: decimal,
}).strict();

export const TokenPriceViewSchema = z.object({
  modelKey: z.string(),
  modelId: z.string(),
  name: z.string(),
  quoteDate,
  promptPerMillion: decimal,
  completionPerMillion: decimal,
  contextLength: z.number().int().positive().nullable(),
  promptChangePct: z.number().finite().nullable(),
  completionChangePct: z.number().finite().nullable(),
  history: z.array(z.object({
    date: quoteDate,
    promptPerMillion: decimal,
    completionPerMillion: decimal,
  }).strict()).max(180),
  capturedAt: epoch,
}).strict();

export const GpuRentViewSchema = z.object({
  venue: z.enum(['runpod', 'vast']),
  gpuKey: z.string(),
  label: z.string(),
  lane: z.enum(['secure', 'community', 'min', 'median']),
  quoteDate,
  usdPerHour: decimal,
  sampleCount: z.number().int().positive().nullable(),
  changePct: z.number().finite().nullable(),
  history: z.array(historyPoint).max(180),
  capturedAt: epoch,
}).strict();

export const ComputePriceCheckSchema = z.object({
  sourceKey: z.enum(['openrouter', 'runpod', 'vast']),
  quoteDate,
  lastCheckedAt: epoch,
  lastChangedAt: epoch,
  unchanged: z.boolean(),
}).strict();

export const ComputePriceBoardSchema = z.object({
  tokens: z.array(TokenPriceViewSchema).max(40),
  gpus: z.array(GpuRentViewSchema).max(40),
  checks: z.array(ComputePriceCheckSchema).max(8),
}).strict();
