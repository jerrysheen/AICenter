import {z} from 'zod';

export const ARTICLE_VALIDATOR_VERSION='article-normalize-v1';
export const ArticleOutputSchema=z.object({title:z.string().trim().min(1).max(160),tagId:z.string().min(1).max(128).nullable(),summary:z.string().trim().min(1).max(2000),body:z.string().trim().min(1).max(40000)}).strict();
export const FeedNormalizedArticleSchema=ArticleOutputSchema.omit({tagId:true}).extend({nodeId:z.string().min(1).max(2048),generatedAt:z.number().int()}).strict();
export const ArticleResponseSchema=z.union([z.object({status:z.literal('needs_content')}).strict(),ArticleOutputSchema]);
const ReadingDirectionSchema=z.enum(['finance','industry','ai','geopolitics','other','pending']);
const ReadingSubjectSchema=z.enum(['macro_policy','market_asset','company_event','company_security','ai_model_method','ai_application','geopolitics_event','geopolitics_rules','other','unknown']);
export const ReadingClassificationSchema=z.object({
  primaryDirection:ReadingDirectionSchema,
  subjectKind:ReadingSubjectSchema,
  domainTagIds:z.array(z.string().min(1).max(64)).max(8).default([]),
  status:z.enum(['classified','out-of-scope','pending','failed','budget-deferred','invalid-output']),
  promptHash:z.string().min(8).max(128).optional(),
  inputScope:z.enum(['saved-article','saved-body-prefix']).optional(),
  evidenceQuote:z.string().max(240).optional(),
}).strict();
export function normalizeArticleResponse(raw,tags) {
  if(raw?.status!==undefined)return ArticleResponseSchema.parse(raw);
  const result=ArticleOutputSchema.parse({title:raw?.title,tagId:tags.has(raw?.tagId) ? raw.tagId : null,summary:raw?.summary,body:raw?.body});
  const reading=ReadingClassificationSchema.safeParse({...raw,domainTagIds:Array.isArray(raw?.domainTagIds) ? raw.domainTagIds : [],status:raw?.classificationStatus || (raw?.primaryDirection==='other' ? 'out-of-scope' : raw?.primaryDirection==='pending' ? 'pending' : 'classified')});
  return {title:result.title,text:result.summary.replace(/\s*\n+\s*/g,' '),body:result.body,tagId:result.tagId,...(reading.success ? {readingClassification:reading.data} : {})};
}
export function projectTreeInput(i,id=i.id) {return {id,title:i.title,text:i.text,tagId:i.tagId};}
export const TreeLayerSchema=z.enum(['information','hourly','daily']);
const id=z.string().min(1).max(2048);
const tagId=z.string().min(1).max(128).nullable();
// Compatibility for a malformed pre-v3.1 cache only; normal prose is never classified by a keyword.
export const isUnavailableTreeText=text=>String(text).trim()==='needs_content';
export const TREE_VALIDATOR_VERSION='tree-response-v3.1.0';
export const InformationOutputSchema=z.object({title:z.string().trim().min(1).max(160),text:z.string().trim().min(1).max(2000),tagId}).strip();
export const InformationResponseSchema=z.union([z.object({status:z.literal('needs_content')}).strict(),InformationOutputSchema]);
export const TreeModulesOutputSchema=z.object({modules:z.array(InformationOutputSchema.extend({inputIds:z.array(id).min(1)}).strip()).min(1)}).strip();
export function treeResponseProtocol(stage) {
  if(stage==='article')return '仅返回JSON {"title":"中文标题","tagId":null,"summary":"短摘要","body":"中文洗练正文，可分段","primaryDirection":"finance|industry|ai|geopolitics|other|pending","subjectKind":"macro_policy|market_asset|company_event|company_security|ai_model_method|ai_application|geopolitics_event|geopolitics_rules|other|unknown","domainTagIds":[],"classificationStatus":"classified|out-of-scope|pending"}；缺内容返回{"status":"needs_content"}。分类只根据材料主旨，不写应命中或建议保留。';
  if(stage==='classification')return '只根据已保存标题和提炼稿的主旨选择目录中的一个主Tag，不能改写正文。仅返回JSON {"tagId":null}，或提供的有效ID。';
  return stage==='information'
    ? '仅返回一个JSON对象。完成格式：{"title":"短标题","text":"一段提炼稿","tagId":null}；tagId可为目录有效ID或JSON null。缺内容只返回{"status":"needs_content"}，不放进text。'
    : '仅返回JSON：{"modules":[{"title":"主题标题","text":"浓缩短段落","tagId":null,"inputIds":["n1"]}]}。tagId为提供的阅读分类ID或JSON null。inputIds必须覆盖全部直接输入，恰好一次。';
}
export function normalizeInformationResponse(raw,tags) {
  if(raw?.status!==undefined) return z.object({status:z.literal('needs_content')}).strict().parse(raw);
  return InformationOutputSchema.parse({...raw,text:typeof raw?.text==='string' ? raw.text.replace(/\s*\n+\s*/g,' ') : raw?.text,tagId:tags.has(raw?.tagId) ? raw.tagId : null});
}
const PendingSchema=z.object({id,reason:z.enum(['needs-content','retryable-model-error','queue-timeout','execution-timeout','budget-deferred','lease-conflict','invalid-output','information-not-ready','stale-policy']),retryable:z.boolean(),retryAt:z.number().int().nullable(),sourceVersion:z.string().optional(),queueMs:z.number().optional(),executionMs:z.number().optional()});
export const TreeNodeSchema=InformationOutputSchema.extend({body:z.string().trim().min(1).max(40000).optional(),formatVersion:z.literal(ARTICLE_VALIDATOR_VERSION).optional(),id,layer:TreeLayerSchema,version:z.string().length(64),children:z.array(id),articleIds:z.array(id),
  window:z.object({startAt:z.number().int(),endAt:z.number().int()}),generatedAt:z.number().int(),eventAt:z.number().int().optional(),sourceUpdatedAt:z.number().int().optional(),sourceId:id.optional(),sourceRefs:z.array(z.object({type:z.string(),id,at:z.number().nullable().optional()})).optional(),
  draftKey:z.string().optional(),sourceVersion:z.string().optional(),effectivePromptHash:z.string().optional(),validatorVersion:z.string().optional(),catalogVersion:z.string().optional(),inputScope:z.enum(['full','excerpt']).optional(),
  classification:z.object({source:z.enum(['model','manual-lock','reclassified','legacy-control']),ruleVersion:z.string()}).optional(),readingClassification:ReadingClassificationSchema.optional(),safePassthrough:z.boolean().optional()}).strict().superRefine((n,ctx)=>{if(n.formatVersion && (n.layer!=='information' || !n.body))ctx.addIssue({code:'custom',message:'新版文章必须有正文，且只属于信息层'});if(n.body && !n.formatVersion)ctx.addIssue({code:'custom',message:'正文必须带明确文章协议版本'});if(n.body && n.layer!=='information')ctx.addIssue({code:'custom',message:'上层不能保存文章正文'});});
export const TreeEditionSchema=z.object({id,layer:z.enum(['hourly','daily']),window:z.object({startAt:z.number().int(),endAt:z.number().int()}),
  timezone:z.string(),status:z.enum(['ready','partial','failed']),roots:z.array(id),inputIds:z.array(id),pendingIds:z.array(id),pending:z.array(PendingSchema).optional(),groupFailures:z.array(PendingSchema.extend({tagId})).optional(),policyHash:z.string().optional(),missingHours:z.array(z.number().int()),generatedAt:z.number().int()}).strict();
export const PrepareTreeInformationInputSchema=z.object({workspaceId:z.string().default('local'),sourceIds:z.array(id).min(1).max(100),force:z.boolean().default(false),catchup:z.boolean().default(false)}).strict();
export const TreeWindowQuerySchema=z.object({startAt:z.coerce.number().int().nonnegative(),endAt:z.coerce.number().int().positive()}).refine(v=>v.endAt>v.startAt && v.endAt-v.startAt<=7*86400000,'树查询窗口最多七日');
export const TreeNodeQuerySchema=z.object({id}).strict();
export const TreeManifestQuerySchema=TreeWindowQuerySchema.safeExtend({view:z.enum(['reading']).optional()});

// Only whole direct children participate in coverage; never repair omissions by appending source text.
export function validateTreeModules(value,inputs,tags) {
  const output=TreeModulesOutputSchema.parse(value),allowed=new Set(inputs.map(i=>i.id)),seen=new Set();
  for(const m of output.modules) {
    if(m.tagId!==null && !tags.has(m.tagId)) throw new Error('未知主Tag');
    for(const input of m.inputIds) {
      if(!allowed.has(input) || seen.has(input)) throw new Error('未知或重复输入归属');
      seen.add(input);
    }
  }
  if(seen.size!==allowed.size) throw new Error('输入归属不完整');
  return output;
}
