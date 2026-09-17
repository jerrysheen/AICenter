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
