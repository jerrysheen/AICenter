import { z } from 'zod';

const probability = z.number().finite().min(0).max(1);
const identity = z.object({ accountId: z.string().default(''), handle: z.string().default('') }).strict();
export const FeedCaptureContextSchema = z.object({
  rootId: z.string().default(''), author: identity.default({}),
  continuations: z.array(z.object({
    id: z.string().min(1), author: identity, replyToId: z.string().default(''),
    relationVerified: z.boolean(), text: z.string(), truncated: z.boolean().default(false),
  }).strict().refine(v=>!v.relationVerified||v.replyToId.length>0,'核验的回复必须有父帖 ID')).default([]),
  references: z.array(z.object({ id: z.string().min(1), referencedById: z.string().min(1),
    relationVerified: z.boolean(), necessary: z.boolean(), text: z.string(),
    truncated: z.boolean().default(false) }).strict()).default([]),
  missingParts: z.array(z.object({ kind: z.enum(['body','thread','reference','image','video','article']),
    critical: z.boolean().nullable(), status: z.enum(['confirmed','suspected']),
    evidence: z.string().min(1) }).strict()).default([]),
  truncated: z.boolean().default(false), threadIncomplete: z.boolean().default(false),
}).strict();
export const FeedValueInputSchema = z.object({
  title: z.string().default(''), body: z.string().default(''),
  continuations: z.array(z.object({ id:z.string(), text:z.string() }).strict()).default([]),
  references: z.array(z.object({ id:z.string(), text:z.string() }).strict()).default([]),
  comments: z.string().default(''), unavailableMedia: z.array(z.string()).default([]),
  missingParts: FeedCaptureContextSchema.shape.missingParts,
  bodyMissing: z.boolean().default(false), truncated: z.boolean().default(false),
  keyContextMissing: z.boolean().default(false), suspectedContinuation: z.boolean().default(false),
  captureInvalid: z.boolean().default(false),
}).strict();
export const FeedValueScoresSchema = z.object({
  reading_value: probability, advertising: probability, specific_content: probability,
  sufficient_information: probability, missing_context: probability,
}).strict();
export const FeedValueRuleSchema = z.enum(['calibrated-value','two-of-three-0.60','all-three-0.60']);
export const FeedValueRefreshInputSchema = z.object({workspaceId:z.string().min(1).default('local'),
  perSourceLimit:z.number().int().min(1).max(200).default(200),concurrency:z.number().int().min(1).max(8).default(6)}).strict();
export const FeedValueReferenceSchema = z.object({
  id:z.string().min(1), split:z.enum(['seen-regression-calibration','first-holdout-diagnostic','fresh-holdout']),
  quality:z.enum(['SUBSTANTIVE','EMPTY','DISPUTED','UNKNOWN','UNREVIEWED']), qualityEvidence:z.string(),
  completeness:z.enum(['COMPLETE','CONFIRMED_MISSING','SUSPECTED_MISSING','UNREVIEWED']), completenessEvidence:z.string(),
  interest:z.enum(['outside-prior-scope','not-reassessed','in-scope','outside-scope','disputed']),
  mainInformationComplete:z.boolean().default(false), mainInformationEvidence:z.string().default(''),
}).refine(v=>v.quality==='UNREVIEWED'||v.qualityEvidence.trim().length>0,'复核质量必须记录依据')
  .refine(v=>!v.mainInformationComplete||v.mainInformationEvidence.trim().length>0,'主信息完整必须记录依据');
export const FeedValueCalibrationSchema = z.object({
  version: z.literal('feed-value-v3.0'), policyHash: z.string().min(1), model: z.string().min(1),
  sampleHash: z.string().min(1), keepAt: probability, dropBelow: probability,
  annotationSource: z.string().min(1), productionQualified: z.boolean(),
}).strict().refine(v=>v.dropBelow<v.keepAt, '保存与淘汰区间必须分离');
export const FeedValueDecisionSchema = z.object({
  decision: z.enum(['KEEP','DROP','REVIEW']),
  reason: z.enum(['substantive','no-saving-value','body-missing','input-truncated','context-missing',
    'context-unconfirmed','invalid-input','invalid-capture','invalid-scores','input-too-large',
    'jev-failed','jev-unavailable','jev-rejected','uncalibrated','calibration-mismatch','borderline','two-of-three','below-two-of-three','all-three','below-all-three']),
  reviewKind: z.enum(['none','technical','missing-content','semantic']),
}).strict();
