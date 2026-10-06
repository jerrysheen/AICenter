import { z } from 'zod';

const ProbabilitySchema = z.number().finite().min(0).max(1);
export const FeedQualityScoresSchema = z.object({
  reading_value: ProbabilitySchema,
  advertising: ProbabilitySchema,
  specific_content: ProbabilitySchema,
  sufficient_information: ProbabilitySchema,
  topic_relevance: ProbabilitySchema,
  missing_context: ProbabilitySchema,
}).strict();

export const FeedQualityInputSchema = z.object({
  title: z.string().default(''),
  body: z.string().default(''),
  comments: z.string().default(''),
  unavailableMedia: z.array(z.string()).default([]),
  bodyMissing: z.boolean().default(false),
  truncated: z.boolean().default(false),
  keyContextMissing: z.boolean().default(false),
}).strict();

export const FeedQualityDecisionSchema = z.object({
  decision: z.enum(['KEEP', 'DROP', 'REVIEW']),
  reason: z.enum(['qualified', 'outside-scope', 'no-substance', 'empty-promotion',
    'body-missing', 'input-truncated', 'context-missing', 'input-too-large',
    'invalid-input', 'invalid-scores', 'scope-unavailable', 'jev-unavailable',
    'jev-failed', 'borderline']),
  profile: z.enum(['conservative', 'balanced', 'strict']),
}).strict();
