import { z } from 'zod';

export const X_LIKE_JOB_TYPE = 'feed.x.like';
export const LikeContentInputSchema = z.object({ contentItemId: z.string().uuid() }).strict();
export const LikeRequestSchema = z.object({ confirmed: z.literal(true) }).strict();
export const LikeResultSchema = z.object({
  status: z.enum(['liked', 'already-liked', 'login-required', 'blocked', 'unavailable', 'not-found', 'unconfirmed']),
  accountHandle: z.string().max(32).default(''),
  checkedAt: z.number().int().nonnegative(),
}).strict();
