import { z } from 'zod';
import { EntityIdSchema, EpochMillisSchema, WorkspaceIdSchema } from './common.js';
import { SourceIdSchema } from './source.js';

export const JobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);

export const AgentJobSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  type: z.string().trim().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),
  status: JobStatusSchema,
  input: z.unknown(),
  output: z.unknown().nullable(),
  error: z.unknown().nullable(),
  priority: z.number().int(),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  availableAt: EpochMillisSchema,
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const DomainEventSchema = z.object({
  id: z.number().int().positive(),
  workspaceId: WorkspaceIdSchema,
  name: z.string().trim().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\.v\d+$/),
  schemaVersion: z.number().int().positive(),
  aggregateType: z.string().trim().min(1).max(64),
  aggregateId: EntityIdSchema,
  payload: z.unknown(),
  correlationId: EntityIdSchema.nullable(),
  causationId: EntityIdSchema.nullable(),
  occurredAt: EpochMillisSchema,
  createdAt: EpochMillisSchema,
}).strict();

export const CapabilityManifestSchema = z.object({
  id: z.string().trim().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),
  version: z.string().trim().regex(/^\d+\.\d+\.\d+$/),
  capabilities: z.array(z.string().trim().min(1).max(128)).min(1),
  jobTypes: z.array(z.string().trim()).default([]),
  sourceIds: z.array(SourceIdSchema).default([]),
}).strict();

export const WORK_PACKAGE_DISPATCH_JOB_TYPE = 'work-package.dispatch';

export const WorkerJobConcurrencySchema = z.object({
  defaultLimit: z.number().int().min(1).max(8).default(1),
  workPackageDispatchLimit: z.number().int().min(1).max(8).default(3),
  quantLabLimit: z.number().int().min(1).max(1).default(1),
}).strict();

const JobTypeSchema = z.string().trim().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);

export const DailyScheduleSpecSchema = z.object({
  kind: z.literal('daily'),
  timezone: z.string().trim().min(1).max(64),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
}).strict();

export const IntervalScheduleSpecSchema = z.object({
  kind: z.literal('interval'),
  intervalMinutes: z.number().int().min(1).max(10_080),
}).strict();

export const ScheduleSpecSchema = z.discriminatedUnion('kind', [
  DailyScheduleSpecSchema,
  IntervalScheduleSpecSchema,
]);

export const JobScheduleSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  key: z.string().trim().min(1).max(128),
  jobType: JobTypeSchema,
  enabled: z.boolean(),
  schedule: ScheduleSpecSchema,
  input: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int(),
  maxAttempts: z.number().int().positive().max(10),
  nextRunAt: EpochMillisSchema,
  lastEnqueuedAt: EpochMillisSchema.nullable(),
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();
