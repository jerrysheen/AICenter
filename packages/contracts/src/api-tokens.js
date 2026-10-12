import { z } from 'zod';

export const API_TOKEN_PREFIX = 'aic_';

export const CreateApiTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
}).strict();

export const ApiTokenViewSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(40),
  prefix: z.string().trim().min(4).max(16),
  createdAt: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative().nullable(),
  revokedAt: z.number().int().nonnegative().nullable(),
}).strict();
