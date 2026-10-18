import { z } from 'zod';

export const X_LIKE_JOB_TYPE = 'feed.x.like';
export const X_UNLIKE_JOB_TYPE = 'feed.x.unlike';
export const LikeContentInputSchema = z.object({
  contentItemId: z.string().uuid(),
  source: z.enum(['manual', 'auto']).optional(),
  tweetId: z.string().regex(/^\d{1,25}$/).optional(),
  focusScore: z.number().min(0).max(1).optional(),
  primaryDir: z.string().max(40).optional(),
  directionLabel: z.string().max(40).optional(),
  reason: z.string().max(80).optional(),
}).strict();
export const LikeRequestSchema = z.object({ confirmed: z.literal(true) }).strict();
export const LikeResultSchema = z.object({
  status: z.enum(['liked', 'already-liked', 'login-required', 'blocked', 'unavailable', 'not-found', 'unconfirmed']),
  accountHandle: z.string().max(32).default(''),
  checkedAt: z.number().int().nonnegative(),
}).strict();
export const UnlikeContentInputSchema = z.object({ contentItemId: z.string().uuid() }).strict();
export const UnlikeRequestSchema = z.object({ confirmed: z.literal(true) }).strict();
export const UnlikeResultSchema = z.object({
  status: z.enum(['unliked', 'not-liked', 'login-required', 'blocked', 'unavailable', 'not-found', 'unconfirmed']),
  accountHandle: z.string().max(32).default(''),
  checkedAt: z.number().int().nonnegative(),
}).strict();
