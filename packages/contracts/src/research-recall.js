import { z } from 'zod';
import { TagIdSchema } from './tagging.js';

const phrase = z.string().trim().min(1).max(80);
const textBlock = z.string().trim().min(4).max(800);

export const ResearchQuerySchema = z.object({
  phrase,
  aliases: z.array(phrase).max(16).default([]),
  entities: z.array(phrase).max(24).default([]),
}).strict();

export const ResearchSubquestionSchema = z.object({
  id: TagIdSchema,
  text: z.string().trim().min(4).max(400),
  tagIds: z.array(TagIdSchema).min(1).max(16),
  queries: z.array(ResearchQuerySchema).max(24).default([]),
}).strict();

export const ResearchTagSchema = z.object({
  id: TagIdSchema,
  name: z.string().trim().min(1).max(40),
  definition: textBlock,
  include: textBlock,
  exclude: textBlock,
  keywords: z.array(phrase).max(24).default([]),
  aliases: z.array(phrase).max(16).default([]),
  enabled: z.boolean().default(true),
}).strict();

export const ResearchQuestionSchema = z.object({
  id: TagIdSchema,
  version: z.string().trim().min(1).max(64),
  objective: z.string().trim().min(4).max(800),
  subquestions: z.array(ResearchSubquestionSchema).min(1).max(12),
  queries: z.array(ResearchQuerySchema).max(32).default([]),
  historyLookbackMs: z.number().int().min(0).max(366 * 24 * 3600 * 1000),
  evidence: z.string().trim().min(4).max(1000),
}).strict();

export const ResearchCatalogSchema = z.object({
  kind: z.literal('research-catalog').default('research-catalog'),
  id: TagIdSchema,
  version: z.string().trim().min(1).max(64),
  tags: z.array(ResearchTagSchema).min(1).max(80),
  questions: z.array(ResearchQuestionSchema).min(1).max(20),
}).strict();

export const ResearchAdditionSchema = z.object({
  kind: z.literal('research-addition'),
  version: z.string().trim().min(1).max(64),
  tags: z.array(ResearchTagSchema).max(80).default([]),
  questions: z.array(ResearchQuestionSchema).max(20).default([]),
}).strict();

export const ResearchVerdictSchema = z.enum(['direct', 'background', 'irrelevant', 'insufficient']);
export const ResearchJudgmentStatusSchema = z.enum(['running', 'succeeded', 'failed']);
export const ResearchLaneSchema = z.enum(['information', 'unprepared', 'missing-body', 'prepare-failed']);

const OriginSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  nodeId: z.string().min(1).nullable(),
}).strict();

const EvidenceSchema = z.object({
  fact: z.string(),
  nodeId: z.string().nullable(),
  originType: z.string(),
  originId: z.string(),
}).strict();

export const ResearchReportSchema = z.object({
  id: z.string().min(8),
  releaseId: z.string().min(1),
  contentHash: z.string().length(64),
  labelVersion: z.string().min(1),
  questionId: z.string().min(1),
  questionHash: z.string().length(64),
  window: z.object({ startAt: z.number().int(), endAt: z.number().int() }).strict(),
  status: z.enum(['ready', 'partial', 'failed']),
  statusNote: z.string().min(1),
  conclusion: z.string().min(1),
  overview: z.string().min(1),
  sections: z.array(z.object({
    subquestionId: z.string().min(1),
    heading: z.string().min(1),
    paragraphs: z.array(z.string()),
    supporting: z.array(EvidenceSchema),
    opposing: z.array(EvidenceSchema),
    unresolved: z.array(EvidenceSchema),
  }).strict()),
  relations: z.array(z.object({
    type: z.enum(['co-occurrence', 'conflict', 'unverified-link']),
    eventIds: z.array(z.string()),
    note: z.string().min(1),
  }).strict()),
  pack: z.object({
    poolId: z.string().min(1),
    historyPoolId: z.string().nullable(),
    events: z.array(z.object({
      eventId: z.string().min(1),
      title: z.string(),
      facts: z.array(z.string()),
      bucket: z.enum(['current', 'background', 'unverified']),
      origins: z.array(OriginSchema),
      hits: z.object({
        tag: z.array(z.string()),
        query: z.array(z.string()),
        relevance: z.array(z.enum(['direct', 'background'])),
      }).strict(),
    }).strict()),
    buckets: z.object({
      current: z.array(z.string()),
      background: z.array(z.string()),
      unverified: z.array(z.string()),
    }).strict(),
    evidence: z.array(z.object({
      fact: z.string(),
      eventId: z.string(),
      sources: z.array(OriginSchema),
    }).strict()),
  }).strict(),
  coverage: z.object({
    denominator: z.number().int().nonnegative(),
    information: z.number().int().nonnegative(),
    unprepared: z.number().int().nonnegative(),
    missingBody: z.number().int().nonnegative(),
    prepareFailed: z.number().int().nonnegative(),
    usable: z.number().int().nonnegative(),
    judged: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    inflight: z.number().int().nonnegative(),
    recalled: z.number().int().nonnegative(),
    byPath: z.object({
      tag: z.number().int().nonnegative(),
      query: z.number().int().nonnegative(),
      relevance: z.number().int().nonnegative(),
    }).strict(),
    checkedComplete: z.boolean(),
    note: z.string().min(1),
    unjudged: z.object({
      count: z.number().int().nonnegative(),
      fromOrdinal: z.number().int().nullable(),
      toOrdinal: z.number().int().nullable(),
      sampleIds: z.array(z.string()),
    }).strict(),
    historyNotStarted: z.number().int().nonnegative(),
    stoppedReason: z.string().nullable(),
    discardedTagIds: z.array(z.string()),
    cacheHits: z.number().int().nonnegative(),
  }).strict(),
  states: z.object({
    definitionLoaded: z.object({
      releaseId: z.string(),
      contentHash: z.string().length(64),
      labelVersion: z.string(),
    }).strict(),
    windowBackfill: z.object({
      status: z.enum(['complete', 'partial', 'not-started']),
      judged: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }).strict(),
    reportUsed: z.object({
      reportId: z.string(),
      releaseId: z.string(),
      contentHash: z.string().length(64),
      questionHash: z.string().length(64),
      status: z.enum(['ready', 'partial', 'failed']),
    }).strict(),
  }).strict(),
  usage: z.object({
    requests: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cost: z.null(),
    elapsedMs: z.number().int().nonnegative(),
    model: z.string(),
  }).strict(),
  judgmentSnapshot: z.array(z.object({
    resourceType: z.string(),
    resourceId: z.string(),
    sourceVersion: z.string(),
    kind: z.enum(['tag', 'relevance']),
    key: z.string(),
    status: ResearchJudgmentStatusSchema,
    matched: z.boolean().nullable(),
    verdict: z.string(),
    inputHash: z.string(),
    definitionHash: z.string(),
  }).strict()),
  runId: z.string().min(1),
  generatedAt: z.number().int(),
}).strict();
