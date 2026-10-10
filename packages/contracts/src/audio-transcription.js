import { z } from 'zod';
import { EntityIdSchema, EpochMillisSchema, WorkspaceIdSchema } from './common.js';

export const AUDIO_TRANSCRIBE_JOB_TYPE = 'audio.transcribe';

const LanguageCodeSchema = z.string().trim().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/);

export const AudioTranscriptionChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  lane: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
}).strict();

export const AudioTranscriptionPlanSchema = z.object({
  durationMs: z.number().int().positive(),
  chunkMs: z.number().int().positive(),
  tokensPerSecond: z.number().int().positive(),
  tokensPerMinute: z.number().int().positive(),
  laneCount: z.number().int().positive().max(8),
  keyCount: z.number().int().positive().max(8),
  chunkCount: z.number().int().positive().max(4000),
  estimatedTokens: z.number().int().nonnegative(),
  tokenBudgetMinutes: z.number().int().nonnegative(),
  laneChunkCounts: z.array(z.number().int().nonnegative()).max(8),
  note: z.string().max(500),
  chunks: z.array(AudioTranscriptionChunkSchema).max(4000),
}).strict();

export const AudioTranscriptionCreateSchema = z.object({
  path: z.string().trim().min(1).max(512),
  languageCodes: z.array(LanguageCodeSchema).max(8).default([]),
  mode: z.enum(['SMART', 'VERBATIM']).default('SMART'),
}).strict();

export const AudioTranscriptionJobInputSchema = AudioTranscriptionCreateSchema.extend({
  workspaceId: WorkspaceIdSchema,
  plan: AudioTranscriptionPlanSchema,
}).strict();

export const AudioTranscriptionSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().max(100_000),
}).strict();

export const AudioTranscriptionResultSchema = z.object({
  text: z.string().max(2_000_000),
  segments: z.array(AudioTranscriptionSegmentSchema).max(4000),
  plan: AudioTranscriptionPlanSchema,
}).strict();

export const AudioTranscriptionViewSchema = z.object({
  runId: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  path: z.string().max(512),
  updatedAt: EpochMillisSchema,
  plan: AudioTranscriptionPlanSchema,
  text: z.string().max(2_000_000).default(''),
  segments: z.array(AudioTranscriptionSegmentSchema).max(4000).default([]),
  error: z.string().max(500).optional(),
}).strict();
