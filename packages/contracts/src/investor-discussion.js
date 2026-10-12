import { z } from 'zod';
import { EpochMillisSchema, WorkspaceIdSchema } from './common.js';

export const INVESTOR_DISCUSSION_JOB_TYPE = 'investor.discussion.digest';

export const InvestorDiscussionDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const InvestorDiscussionGenerateInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
  digestDate: InvestorDiscussionDateSchema.optional(),
  scheduledFor: EpochMillisSchema.optional(),
  scheduleKey: z.string().trim().min(1).max(128).optional(),
  retryFailed: z.boolean().optional(),
}).strict();

export const InvestorDiscussionGenerateRequestSchema = z.object({
  date: InvestorDiscussionDateSchema.optional(),
  retryFailed: z.boolean().optional(),
}).strict();
