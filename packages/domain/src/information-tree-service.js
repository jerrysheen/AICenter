import {randomUUID} from 'node:crypto';
import {validateTreeModules,repairTreeModuleAttribution,normalizeInformationResponse,treeResponseProtocol,TREE_VALIDATOR_VERSION,TreeNodeSchema,normalizeArticleResponse,ArticleOutputSchema,ARTICLE_VALIDATOR_VERSION,projectTreeInput,FeedNormalizedArticleSchema,TreeIndexEditionSchema,TreeIndexInformationSchema} from '../../contracts/src/information-tree.js';
import {materialHash,prepareDailyMaterials} from './daily-materials.js';
import {needsZhLocalization} from './localize-texts.js';
import {runBounded} from './daily-analysis.js';
import {treeCatalog,treeSource,treeFailure,formatCondenseFailureLog,formatTreeHourlyCallLog,describeCondenseFailure,isTerminalPendingReason} from './information-tree-policy.js';
import {readingClassKeyEnvs} from './reading-hour-service.js';
import {isFlashSource} from './flash-sources.js';
import {boundedInt,isAttributionValidationError,isRetryableUpstreamStatus,modelRetryDelayMs,nextHourlyAttempt,sameIdSet,upstreamHttpStatus} from './report-reliability.js';

const HOUR=3600000;
function orderHourlyModels(models, rank) {
  if (models.length < 2 || typeof rank !== 'function') return models;
  let ranked;
  try { ranked = rank(models); } catch { return models; }
  if (!Array.isArray(ranked) || ranked.length !== models.length) return models;
  const seen = new Set();
  for (const model of ranked) {
    if (typeof model !== 'string' || !models.includes(model) || seen.has(model)) return models;
  }
  return ranked;
}
const stable=rows=>[...rows].sort((a,b)=>a.id.localeCompare(b.id));
const parse=text=>JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
function boundedParagraphs(paragraphs,maxBytes) {
  return paragraphs.flatMap(p=>{
    if(Buffer.byteLength(JSON.stringify(p))+3<=maxBytes)return [p];
    const characters=Array.from(p.text),parts=[];let at=0;
    while(at<characters.length) {
      let lo=1,hi=characters.length-at,fit=0;
      while(lo<=hi) {
        const count=Math.floor((lo+hi)/2),candidate={...p,text:characters.slice(at,at+count).join('')};
        if(Buffer.byteLength(JSON.stringify(candidate))+3<=maxBytes){fit=count;lo=count+1;}else hi=count-1;
      }
      if(!fit)throw new Error('内容块元数据超过预算');
      parts.push({...p,text:characters.slice(at,at+fit).join('')});at+=fit;
    }
    return parts;
  });
}
export function packTreeInputs(rows,maxBytes) {
  const batches=[];let batch=[],bytes=2;
  for(const row of rows) {
    const size=Buffer.byteLength(JSON.stringify(row))+1;
    if(size+2>maxBytes) throw new Error('单条输入超过预算，须在信息阶段处理完整内容块');
    if(bytes+size>maxBytes && batch.length) {batches.push(batch);batch=[];bytes=2;}
    batch.push(row);bytes+=size;
  }
  if(batch.length) batches.push(batch);return batches;
}

function indexIssue(error) {
  const issue=error.issues?.[0];
  return issue ? `${issue.path.join('.') || 'value'}: ${issue.message}` : 'invalid';
}
function acceptIndexEdition(value,kind) {
  if(!value) return null;
  const parsed=TreeIndexEditionSchema.safeParse(value);
  if(parsed.success) return parsed.data;
  console.warn(`[information-tree] view=index dropped ${kind} ${value.id || 'unknown'}: ${indexIssue(parsed.error)}`);
  return null;
}
function acceptIndexSlots(slots) {
  const kept=[];
  for(const slot of slots || []) {
    const edition=acceptIndexEdition(slot?.edition,'edition');
    const attempt=acceptIndexEdition(slot?.attempt,'attempt');
    if(edition || attempt) kept.push({edition,attempt});
  }
  return kept;
}
function acceptIndexInformation(rows) {
  const kept=[];
  for(const row of rows || []) {
    const parsed=TreeIndexInformationSchema.safeParse(row);
    if(parsed.success) kept.push(parsed.data);
    else console.warn(`[information-tree] view=index dropped information ${row?.id || 'unknown'}: ${indexIssue(parsed.error)}`);
  }
  return kept;
}
export function pickNodeTime(node, childTimes = []) {
  const start = Number(node?.window?.startAt);
  const windowStamp = Number.isFinite(start) && start > 0 ? start : 0;
  const ok = (at) => Number.isFinite(at) && at > 0 && at !== windowStamp;
  for (const value of [node?.publishedAt, node?.firstIngestedAt, node?.eventAt]) {
    const at = Number(value);
    if (ok(at)) return at;
  }
  const refAt = (Array.isArray(node?.sourceRefs) ? node.sourceRefs : [])
    .map((ref) => Number(ref?.at))
    .find((at) => ok(at));
  if (refAt) return refAt;
  const times = (Array.isArray(childTimes) ? childTimes : []).map(Number).filter(ok);
  return times.length ? Math.max(...times) : 0;
}

function projectNodeTime(repository, workspace, node, seen = new Set(), depth = 0) {
  if (!node || depth > 4) return 0;
  const id = node.id ? String(node.id) : '';
  if (id && seen.has(id)) return 0;
  if (id) seen.add(id);
  const own = pickNodeTime(node, []);
  if (own) return own;
  const childTimes = [];
  if (depth < 4 && Array.isArray(node.children) && typeof repository?.getNode === 'function') {
    for (const childId of node.children) {
      const child = repository.getNode(workspace, childId);
      const at = projectNodeTime(repository, workspace, child, seen, depth + 1);
      if (at) childTimes.push(at);
    }
  }
  return pickNodeTime({ window: node.window }, childTimes);
}

function shanghaiReportDate(endAt) {
  const end = Number(endAt);
  if (!Number.isFinite(end)) return '';
  const shifted = end + 8 * 3600000;
  const dayMs = 86400000;
  const tod = ((shifted % dayMs) + dayMs) % dayMs;
  const instant = tod === 0 ? shifted - 1 : shifted;
  const date = new Date(instant);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function latestDailyCard(head, editorial, nodes) {
  if (!head?.id || !head.window) return null;
  const articles = Array.isArray(editorial?.articles) ? editorial.articles : [];
  const fromArticles = articles.slice(0, 5).flatMap((article) => {
    const sentence = String(article?.lead || article?.title || '').trim();
    if (!sentence) return [];
    return [{ id: String(article.direction || article.title || sentence), sentence, occurredAt: null }];
  });
  const fromNodes = fromArticles.length ? [] : (nodes || []).slice(0, 5).flatMap((node) => {
    const sentence = String(node?.text || node?.title || '').trim();
    const id = String(node?.id || '').trim();
    if (!id || !sentence) return [];
    return [{ id, sentence, occurredAt: Number(node.eventAt) || null }];
  });
  const informationItems = fromArticles.length ? fromArticles : fromNodes;
  const reportDate = String(editorial?.reportDate || shanghaiReportDate(head.window.endAt) || '');
  if (!reportDate) return null;
  const declared = Number(editorial?.coverage?.informationNodeCount);
  return {
    reportDate,
    ...(Number(editorial?.generatedAt || head.generatedAt) ? { generatedAt: Number(editorial?.generatedAt || head.generatedAt) } : {}),
    overview: String(editorial?.overview || ''),
    informationItemCount: Number.isFinite(declared) && declared > 0 ? declared : informationItems.length,
    informationItems,
    editionId: head.id,
    window: head.window,
    hasEditorial: Boolean(editorial),
  };
}

export function createInformationTreeReader({repository,timezone='Asia/Shanghai',pipeline='legacy',catalog={}}) {
  return {
    hourlyTitles(workspace, sourceIds) {
      const ids = [...new Set((sourceIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
      const out = new Map();
      if (!ids.length) return out;
      const rows = typeof repository.informationHeads === 'function'
        ? repository.informationHeads(workspace, ids)
        : ids.map((id) => {
          const head = repository.informationHead?.(workspace, id);
          return head ? { sourceId: id, ...head } : null;
        }).filter(Boolean);
      for (const row of rows || []) {
        const title = String(row.node?.title || '').trim();
        if (title && !needsZhLocalization(title)) out.set(row.sourceId, title);
      }
      return out;
    },
    normalizedArticle(workspace,sourceId,sourceVersion) {
      if(pipeline!=='tree-v3' || !sourceVersion)return null;
      const head=repository.informationHead(workspace,sourceId),node=head?.node;
      if(head?.sourceVersion!==String(sourceVersion) || node?.sourceId!==sourceId || node.sourceVersion!==String(sourceVersion) || node.layer!=='information' || node.formatVersion!==ARTICLE_VALIDATOR_VERSION)return null;
      const result=FeedNormalizedArticleSchema.safeParse({nodeId:node.id,title:node.title,summary:node.text,body:node.body,generatedAt:node.generatedAt});
      return result.success ? result.data : null;
    },
    normalizedArticles(workspace,specs) {
      const out=new Map();
      if(pipeline!=='tree-v3') return out;
      const wanted=(specs || []).filter(spec=>spec?.sourceId && spec.sourceVersion);
      if(!wanted.length) return out;
      const rows=typeof repository.informationHeads==='function'
        ? repository.informationHeads(workspace,wanted.map(spec=>spec.sourceId))
        : wanted.map(spec=>{const head=repository.informationHead?.(workspace,spec.sourceId);return head?{sourceId:spec.sourceId,...head}:null;}).filter(Boolean);
      const bySource=new Map(rows.map(row=>[row.sourceId,row]));
      for(const spec of wanted) {
        const head=bySource.get(spec.sourceId),node=head?.node,version=String(spec.sourceVersion);
        const match=head?.sourceVersion===version && node?.sourceId===spec.sourceId && node.sourceVersion===version && node.layer==='information' && node.formatVersion===ARTICLE_VALIDATOR_VERSION;
        const result=match ? FeedNormalizedArticleSchema.safeParse({nodeId:node.id,title:node.title,summary:node.text,body:node.body,generatedAt:node.generatedAt}) : null;
        out.set(spec.sourceId,result?.success ? result.data : null);
      }
      return out;
    },
    list(workspace,window) {
      if(window.view==='index') return {timezone,pipeline,directions:catalog.reading?.directionByTag || {},information:window.information==='1' ? acceptIndexInformation(repository.listInformationIndex(workspace,window)) : [],hours:acceptIndexSlots(repository.listEditionIndex(workspace,window.startAt,window.endAt,'hourly')),days:acceptIndexSlots(repository.listEditionIndex(workspace,window.startAt,window.endAt,'daily'))};
      return {timezone,pipeline,directions:catalog.reading?.directionByTag || {},information:repository.listInformation(workspace,window).map(({body,...summary})=>window.view==='reading' ? {id:summary.id,eventAt:summary.eventAt,window:summary.window,validatorVersion:summary.validatorVersion} : summary),hours:repository.list(workspace,window.startAt,window.endAt,'hourly'),days:repository.list(workspace,window.startAt,window.endAt,'daily')};
    },
    edition(workspace,id) {
      const edition=repository.getEdition(workspace,id);
      return edition ? {edition,nodes:edition.roots.map(id=>this.node(workspace,id))} : null;
    },
    node(workspace,id) {
      const node=repository.getNode(workspace,id);
      if(!node) return null;
      const eventAt=projectNodeTime(repository,workspace,node);
      const timed=eventAt ? {...node,eventAt} : node;
      return {...timed,articleCount:node.articleIds.length,ref:node.children.length ? node.id : null};
    },
    published(workspace,layer,window) {
      const id=repository.head?.(workspace,layer,window);
      return id ? repository.getEdition(workspace,id) : null;
    },
    latestDaily(workspace, now = Date.now()) {
      const load = () => {
        const slot = repository.latestDailySlot?.(workspace);
        const head = slot?.edition || null;
        if (!head) return null;
        const editorial = head.hasEditorial ? (repository.editorialForWindow?.(workspace, head.window) || null) : null;
        const full = editorial ? null : repository.getEdition?.(workspace, head.id);
        const roots = (full?.roots || []).slice(0, 5);
        const nodes = editorial ? [] : roots.map((id) => repository.getNode?.(workspace, id)).filter(Boolean);
        return latestDailyCard(head, editorial, nodes);
      };
      return typeof repository.readLatestDaily === 'function' ? repository.readLatestDaily(workspace, load, now) : load();
    },
    children(workspace,id) {
      const node=repository.getNode(workspace,id);
      return node ? node.children.map(id=>this.node(workspace,id)) : null;
    },
  };
}

export function createInformationTreeService({repository,reportRepository,feedService,mediaPort,agentRuntime,skills,
  cacheNamespace='',articleStrategy=false,budgetReady=null,catalog={tags:[]},primaryTag=null,tagHints=null,classificationOverrideForReplay=null,candidatePort=null,materialPort=null,generationConfig={},timezone='Asia/Shanghai',now=()=>Date.now(),budget={},
  hourlyModels:configuredHourlyModels=[],rankHourlyModels,upstreamRetries:configuredUpstreamRetries,upstreamRetryBaseMs,upstreamRetryMaxMs,sleep:configuredSleep,hourlyAttemptCap:configuredHourlyAttemptCap,prepAttemptCap:configuredPrepAttemptCap,flashSources=null,env=process.env,log=console.log}={}) {
  const validatorVersion=articleStrategy ? ARTICLE_VALIDATOR_VERSION : TREE_VALIDATOR_VERSION;
  const config={articleRequestBytes:100000,batchBytes:12000,maxCalls:80,totalMs:20*60000,timeoutMs:180000,dailyTimeoutMs:360000,dailyTotalMs:60*60000,queueTimeoutMs:120000,...budget};
  const hourlyModels=Array.isArray(configuredHourlyModels) ? configuredHourlyModels.map(model=>String(model || '').trim()).filter(Boolean) : [];
  const upstreamRetries=boundedInt(configuredUpstreamRetries, 3, 0, 6);
  const retryBaseMs=boundedInt(upstreamRetryBaseMs, 1000, 0, 60_000);
  const retryMaxMs=boundedInt(upstreamRetryMaxMs, 8000, retryBaseMs || 0, 120_000);
  const sleep=configuredSleep || (ms=>new Promise(resolve=>{setTimeout(resolve, ms);}));
  const hourlyAttemptCap=boundedInt(configuredHourlyAttemptCap, 4, 1, 20);
  const prepAttemptCap=boundedInt(configuredPrepAttemptCap ?? env?.AI_CENTER_INFORMATION_PREP_ATTEMPTS, 3, 1, 10);
  const hourlyKeyEnvs=readingClassKeyEnvs(env);
  let hourlyKeyCursor=0;
  const tagNames=new Map(catalog.tags.map(t=>[t.id,t.name]));
  const classification=treeCatalog(catalog),modelTags=classification.ids;
  const route=stage=>generationConfig[stage] || generationConfig[stage==='daily' ? 'daily-analysis' : 'hourly-brief'] || {};
  const generationVersion=stage=>materialHash(cacheNamespace ? {...route(stage),cacheNamespace} : route(stage));
  const policyHash=materialHash({skills:Object.fromEntries(Object.entries(skills).map(([key,value])=>[key,{version:value.version,compatiblePromptHashes:value.compatiblePromptHashes || []}])),
    validator:validatorVersion,passthrough:'validated-short-independent-v2',timeGrouping:'first-ingested-v1',generationConfig,groups:classification.groupVersion,catalog:classification.classificationVersion,reclassification:catalog.reading?.reclassification});
  const activated=new Set();
  const ensurePolicy=workspace=>{if(!activated.has(workspace)){repository.activatePolicy(workspace,policyHash);activated.add(workspace);}};
  ensurePolicy('local');
  const reader=createInformationTreeReader({repository,timezone,pipeline:'tree-v3',catalog});
  const reusableInformation=node=>(!articleStrategy || node?.formatVersion===ARTICLE_VALIDATOR_VERSION && Boolean(node.body)) && node?.validatorVersion===validatorVersion && [skills.information.version,...(skills.information.compatiblePromptHashes || [])].includes(node.effectivePromptHash);
  async function classified(node,m,s) {
    let assigned;
    try {assigned=primaryTag?.(s.workspaceId,m);} catch {}
    let tagId=node.tagId,source=node.classification?.source==='reclassified' ? 'reclassified' : 'model';
    if(!assigned?.locked && !classificationOverrideForReplay && ['manual-lock','legacy-control'].includes(node.classification?.source)) {
      const base=repository.getNode(s.workspaceId,`i:${node.draftKey}`);
      if(base)tagId=base.tagId;
    }
    if(assigned?.locked===true){tagId=modelTags.has(assigned.tagId) ? assigned.tagId : null;source='manual-lock';}
    else if(classificationOverrideForReplay){tagId=classificationOverrideForReplay(m);source='legacy-control';}
    else if(!articleStrategy && node.catalogVersion!==classification.classificationVersion && classification.needsReclassification(node)) {
      const output=await model('classification',{title:node.title,text:node.text,tags:classification.tags},raw=>({tagId:modelTags.has(raw?.tagId) ? raw.tagId : null}),s);
      tagId=output.tagId;source='reclassified';
    }
    if(!modelTags.has(tagId))tagId=null;
    if(tagId===node.tagId && node.catalogVersion===classification.classificationVersion && node.classification?.source===source)return node;
    const version=materialHash({draftKey:node.draftKey || node.version,sourceVersion:node.sourceVersion,tagId,catalog:classification.classificationVersion,source});
    return repository.saveNode(s.workspaceId,{...node,id:`i:${version}`,version,tagId,catalogVersion:classification.classificationVersion,classification:{source,ruleVersion:classification.classificationVersion}});
  }
  function session(priority=0,totalMs=config.totalMs) {return {started:Date.now(),totalMs,calls:0,priority};}
  async function model(stage,payload,check,s,renew=()=>{}) {
    const skill=skills[stage] || skills.information;
    const instruction=stage==='classification' ? treeResponseProtocol(stage) : skill.injected || skill.instruction+'\n'+treeResponseProtocol(stage==='information' && articleStrategy ? 'article' : stage);
    const effectivePromptHash=stage==='classification' ? materialHash({instruction,validator:TREE_VALIDATOR_VERSION,skill:skill.version}) : skill.version;
    const key=materialHash({stage,payload,effectivePromptHash,generationVersion:generationVersion(stage)});
    const period='tree-cache',cached=reportRepository.getAnalysisStage(s.workspaceId,period,key,key);
    if(cached?.status==='completed') {try{s.cacheHits=(s.cacheHits || 0)+1;return articleStrategy && stage==='information' ? check(cached.output.status ? cached.output : {title:cached.output.title,tagId:cached.output.tagId,summary:cached.output.text,body:cached.output.body}) : check(cached.output);}catch{reportRepository.saveAnalysisStage(s.workspaceId,period,key,key,{stage,effectivePromptHash},null,'failed','invalid-output: cached response no longer valid');}}
    const owner=randomUUID();
    if(!repository.acquire(s.workspaceId,key,owner,Date.now())) throw Object.assign(new Error('同版本加工中'),{code:'lease-conflict'});
    const heartbeat=()=>{repository.renew(s.workspaceId,key,owner,Date.now());renew();};
    const shape=treeResponseProtocol(stage==='information' && articleStrategy ? 'article' : stage);
    let correction='',lastAnswer='',checkpoint=articleStrategy ? cached?.input?.checkpoint || null : null;
    const articleMessage=()=>{
      if(checkpoint){const missing=['title','tagId','summary','body'].filter(k=>checkpoint[k]===undefined);return {completed:checkpoint,missing,...(!checkpoint.body ? {source:payload.source} : {}),tags:payload.tags,correction:'只补missing中的字段，返回JSON；保留completed，不重写成功项。'};}
      if(lastAnswer)return {response:lastAnswer,correction:'只修复JSON语法，保留原有内容。'+shape};
      return payload;
    };
    let timing,sentMessage='';const stageInput=()=>({stage,effectivePromptHash,validatorVersion,executionTiming:timing,...(checkpoint ? {checkpoint} : {}),...(lastAnswer ? {lastAnswer} : {})});
    const acceptOutput=(result)=>{
      lastAnswer=result.answer;
      const parsed=parse(result.answer);
      const output=checkpoint ? {...parsed,...checkpoint} : parsed;
      if(articleStrategy && stage==='information' && output.status===undefined){
        const partial={};
        for(const [k,v] of Object.entries(output))if(ArticleOutputSchema.shape[k]?.safeParse(v).success)partial[k]=v;
        checkpoint=Object.keys(partial).length ? partial : checkpoint;
      }
      const value=check(output);
      const allowed=stage==='information' ? (articleStrategy ? ['title','summary','body','tagId','status'] : ['title','text','tagId','status']) : stage==='classification' ? ['tagId'] : ['modules'];
      const discardedFields=Object.keys(output).filter(k=>!allowed.includes(k));
      reportRepository.saveAnalysisStage(s.workspaceId,period,key,key,{...stageInput(),discardedFields,...(articleStrategy ? {rawAnswer:result.answer,...(output.tagId!==null && !modelTags.has(output.tagId) ? {tagDiagnostic:'unknown-tag-downgraded-to-null'} : {})} : {})},value,'completed');
      return value;
    };
    try {
      const models=stage==='hourly' && hourlyModels.length ? orderHourlyModels(hourlyModels, rankHourlyModels) : [undefined];
      const callTimeout=stage==='daily' ? config.dailyTimeoutMs : config.timeoutMs;
      let lastError;
      modelLoop: for(let modelIndex=0;modelIndex<models.length;modelIndex++) {
        const googleModel=models[modelIndex];
        if(modelIndex) correction='';
        for(let attempt=0;attempt<2;attempt++) {
          let transport=0;
          let keySwitch=0;
          let keysTried=0;
          while(true) {
            const remaining=s.totalMs-(Date.now()-s.started);
            if(remaining<=0 || s.calls>=config.maxCalls) throw Object.assign(new Error('浓缩树预算耗尽'),{code:'budget-deferred'});
            s.calls++;
            s.allowAttributionRepair=stage==='hourly' && attempt===1;
            reportRepository.saveAnalysisStage(s.workspaceId,period,key,key,stageInput(),null,'running');
            let result;
            const keyEnv=stage==='hourly' && hourlyKeyEnvs.length ? hourlyKeyEnvs[hourlyKeyCursor++ % hourlyKeyEnvs.length] : '';
            if(keyEnv) keysTried++;
            const startedAt=Date.now();
            let callError=null;
            let callResult=null;
            try {
              const message=JSON.stringify(articleStrategy && stage==='information' ? articleMessage() : {...payload,...(attempt ? {correction:`上一响应未通过校验：${correction}。${shape}不增加事实。`} : {})});
              sentMessage=message;
              try {
                result=await runBounded(agentRuntime,{workspaceId:s.workspaceId,usageStage:`tree-${stage}`,closedContext:true,
                  closedTask:stage==='information' && articleStrategy ? 'article-normalize' : stage==='daily' ? 'daily-analysis' : 'hourly-brief',allowedToolIds:[],webMode:'off',enableAuxiliarySearch:false,executionPriority:s.priority,
                  taskInstruction:instruction,
                  ...(typeof googleModel==='string' ? {googleModel} : {}),
                  ...(keyEnv ? {googleKeyEnv: keyEnv} : {}),
                  message},
                  Math.min(callTimeout,remaining),heartbeat,30000,{queueTimeoutMs:config.queueTimeoutMs,totalTimeoutMs:remaining,onTiming:value=>{timing=value;reportRepository.saveAnalysisStage(s.workspaceId,period,key,key,stageInput(),null,'running');}});
                callResult=result;
              } catch(error) {
                callError=error;
                throw error;
              } finally {
                if(stage==='hourly') {
                  try {
                    log(formatTreeHourlyCallLog({
                      error:callError,result:callResult,keyEnv:keyEnv || callError?.googleKeyEnv || '',
                      model:googleModel || route('hourly').model,inputBytes:Buffer.byteLength(sentMessage || ''),
                      latencyMs:Date.now()-startedAt,finishReason:callError?.finishReason || callResult?.finishReason || timing?.finishReason,
                    }));
                  } catch { /* a log failure must not change the condense call */ }
                }
              }
            } catch(error) {
              const status=upstreamHttpStatus(error);
              const quota=error?.code==='budget-deferred' || error?.quotaExhausted===true || Number(error?.status)===429 || Number(error?.upstreamStatus)===429;
              // Configured Google keys: one different key for a non-quota failure, including upstream 5xx. Quota may walk the remaining keys.
              if(stage==='hourly' && hourlyKeyEnvs.length>1 && !quota && keySwitch<1) {
                keySwitch++;
                continue;
              }
              if(stage==='hourly' && hourlyKeyEnvs.length>1 && quota && keysTried<hourlyKeyEnvs.length) continue;
              if(stage==='hourly' && !(hourlyKeyEnvs.length>1 && !quota) && isRetryableUpstreamStatus(status) && transport<upstreamRetries) {
                transport++;
                await sleep(modelRetryDelayMs(transport-1,{baseMs:retryBaseMs,maxMs:retryMaxMs}));
                continue;
              }
              lastError=error;
              if(stage==='hourly' && modelIndex<models.length-1 && (isRetryableUpstreamStatus(status) || (quota && typeof googleModel==='string'))) continue modelLoop;
              throw error;
            }
            // Transport errors and aborted turns propagate; only completed malformed output gets one format repair.
            try {return acceptOutput(result);}
            catch(error) {
              if(articleStrategy && !/[}\]]\s*$/.test(String(result.answer).trim().replace(/```$/, '').trim()))throw Object.assign(new Error('响应中止或截断；不当作完整JSON修复'),{code:'invalid-output'});
              if(attempt) {
                lastError=Object.assign(error,{code:error.code || 'invalid-output'});
                if(!lastError.upstreamBody && lastAnswer) lastError.upstreamBody=String(lastAnswer).slice(0,400);
                if(stage==='hourly' && modelIndex<models.length-1) continue modelLoop;
                throw lastError;
              }
              correction=String(error.message).slice(0,1200);
              break;
            }
          }
        }
      }
      if(lastError) throw lastError;
    } catch(error) {
      if(error && typeof error==='object') {
        if(!Number.isFinite(error.inputChars)) error.inputChars=sentMessage.length;
        if(!Number.isFinite(error.inputBytes)) error.inputBytes=Buffer.byteLength(sentMessage);
      }
      error.timing=timing;reportRepository.saveAnalysisStage(s.workspaceId,period,key,key,{...stageInput(),failure:treeFailure(error,key,'',now())},null,'failed',error.message);throw error;
    } finally {repository.release(s.workspaceId,key,owner);}
  }
  async function information(m,window,s) {
    const node=await informationDraft(m,window,s),eventAt=m.eventAt ?? m.publishedAt ?? window.startAt;
    return groupInformation(s.workspaceId,node,window,eventAt);
  }
  function groupInformation(workspaceId,node,window,eventAt) {
    if(node.window.startAt===window.startAt && node.window.endAt===window.endAt && node.eventAt===eventAt)return node;
    // Reuse validated prose; changing the grouping clock creates an immutable revision.
    const version=materialHash({nodeId:node.id,window,eventAt});
    return repository.saveNode(workspaceId,{...node,id:`i:${version}`,version,window,eventAt});
  }
  async function informationDraft(m,window,s) {
    const source=treeSource(m),sourceHash=materialHash(source),sourceVersion=String(m.version || m.updatedAt || sourceHash);
    // This prompt revision only clarifies titles; completed, validated text remains reusable.
    const head=repository.informationHead(s.workspaceId,m.id)?.node;
    if(head?.sourceVersion===sourceVersion && reusableInformation(head) && head.draftKey===materialHash({source,skill:head.effectivePromptHash,generationVersion:generationVersion('information')})) {s.cacheHits=(s.cacheHits || 0)+1;return classified(head,m,s);}
    const version=materialHash({source,skill:skills.information.version,generationVersion:generationVersion('information')}),id=`i:${version}`;
    const stateKey=`${articleStrategy ? 'article' : 'information'}:${m.id}`,previous=reportRepository.getAnalysisStage(s.workspaceId,'tree-preparation',stateKey,sourceHash);
    const saved=repository.getNode(s.workspaceId,id);
    if(previous?.output?.pending && (!articleStrategy || previous.input?.generationVersion===generationVersion('information')) && previous.output.pending.sourceVersion===sourceVersion && (!previous.output.pending.retryable || previous.output.pending.retryAt>now()) && !s.force && !(previous.output.pending.reason==='budget-deferred' && budgetReady?.()) && !(saved?.catalogVersion===classification.classificationVersion && saved?.validatorVersion===TREE_VALIDATOR_VERSION))throw Object.assign(new Error(previous.output.pending.reason),{code:previous.output.pending.reason,cachedPending:previous.output.pending});
    if(saved) {
      s.cacheHits=(s.cacheHits || 0)+1;
      const revisionVersion=materialHash({draftKey:version,sourceVersion});
      const revision=saved.sourceVersion===sourceVersion ? saved : repository.saveNode(s.workspaceId,{...saved,id:`i:${revisionVersion}`,version:revisionVersion,sourceVersion,sourceUpdatedAt:m.updatedAt ?? m.obtainedAt ?? m.publishedAt ?? window.startAt});
      return classified(revision,m,s);
    }
    if(!source.paragraphs.length || !source.paragraphs.some(p=>/[\p{L}\p{N}]/u.test(p.text)) || (m.missing?.includes('title_only') && !source.paragraphs.some(p=>p.role==='body')))throw Object.assign(new Error('保存材料无独立内容'),{code:'needs-content'});
    const check=raw=>{
      return articleStrategy ? normalizeArticleResponse(raw,modelTags) : normalizeInformationResponse(raw,modelTags);
    };
    const tags=classification.tags;
    const modelSource={...Object.fromEntries(Object.entries(source).filter(([key])=>key!=='id')),sourceVersion};
    let output;
    if(articleStrategy) {
      const payload={tags:tags.map(({id,name})=>({id,name})),source:modelSource};
      const request=(skills.information.requestPrefix || skills.information.injected)+'\n\n'+JSON.stringify(payload);
      if(Buffer.byteLength(request)>config.articleRequestBytes)throw Object.assign(new Error('完整请求超过文章整理预算；保留原文待处理'),{code:'budget-deferred'});
      output=await model('information',payload,check,s);
    }
    else if(Buffer.byteLength(JSON.stringify(modelSource))<config.batchBytes) output=await model('information',{source:modelSource,tags,tagHints:tagHints?.(s.workspaceId,m) || []},check,s);
    else {
      // Internal consecutive blocks are checkpoints, never additional information nodes.
      const blockBytes=Math.max(3000,config.batchBytes-2500);
      const blocks=packTreeInputs(boundedParagraphs(source.paragraphs,blockBytes),blockBytes);
      let condensed=[];
      for(const [n,paragraphs] of blocks.entries()) {
        const part=await model('information',{source:{...modelSource,paragraphs},block:{index:n,total:blocks.length},tags},check,s);
        if(part.status==='needs_content')throw Object.assign(new Error('长文块缺独立内容'),{code:'needs-content'});
        condensed.push({role:'summary',text:part.text});
      }
      while(Buffer.byteLength(JSON.stringify(condensed))>config.batchBytes-2500) {
        const batches=packTreeInputs(condensed,config.batchBytes-2500),next=[];
        for(const paragraphs of batches) {
          const part=await model('information',{source:{...modelSource,paragraphs},tags},check,s);
          if(part.status==='needs_content')throw Object.assign(new Error('长文块缺独立内容'),{code:'needs-content'});
          next.push({role:'summary',text:part.text});
        }
        if(next.length>=condensed.length) throw new Error('长文内部合并未收敛');condensed=next;
      }
      output=await model('information',{source:{...modelSource,paragraphs:condensed},tags},check,s);
    }
    if(output.status==='needs_content')throw Object.assign(new Error('保存材料不足以提炼'),{code:'needs-content'});
    const node=repository.saveNode(s.workspaceId,{...output,id,version,layer:'information',children:[],articleIds:[m.id],sourceId:m.id,
      sourceRefs:m.sourceRefs || [],window,eventAt:m.eventAt ?? m.publishedAt ?? window.startAt,sourceUpdatedAt:m.updatedAt ?? m.obtainedAt ?? m.publishedAt ?? window.startAt,generatedAt:now(),
      draftKey:version,sourceVersion,effectivePromptHash:skills.information.version,validatorVersion,catalogVersion:classification.classificationVersion,...(articleStrategy ? {formatVersion:ARTICLE_VALIDATOR_VERSION} : {}),inputScope:source.inputScope,
      classification:{source:'model',ruleVersion:classification.classificationVersion},...(output.readingClassification ? {readingClassification:output.readingClassification} : {}),safePassthrough:Array.from(output.text).length<=80 && !/你身边|附近的停车场|敬请|点击|不容错过/u.test(output.text)});
    return classified(node,m,s);
  }
  async function condense(layer,inputs,window,s) {
    const groups=new Map();
    for(const input of stable(inputs)) {
      const tag=classification.group(input.tagId);
      const rows=groups.get(tag) || [];rows.push(input);groups.set(tag,rows);
    }
    const result=[];result.failures=[];result.diagnostics=[];
    for(const [tagId,rows] of groups) {
      const version=materialHash({layer,inputs:rows.map(i=>({id:i.id,version:i.version})),tagId,window,skill:skills[layer].version,generationVersion:generationVersion(layer),groups:classification.groupVersion});
      const stageKey=`tree-${layer}:${version}`,cached=reportRepository.getAnalysisStage(s.workspaceId,'tree-cache',stageKey,version);
      try {
      const manualTransientRetry=s.retryTransient===true && cached?.input?.failure?.reason==='retryable-model-error';
      if(cached?.status==='failed' && cached.input?.failure?.retryAt>now() && !manualTransientRetry) {
        const pending=cached.input.failure;
        throw Object.assign(new Error(pending.reason),{code:pending.reason,cachedPending:pending,priorError:cached.error || '',...(Number.isFinite(pending.queueMs) || Number.isFinite(pending.executionMs) ? {timing:{queueMs:pending.queueMs,executionMs:pending.executionMs}} : {})});
      }
      if(cached?.status==='completed') {
        try {const nodes=cached.output.ids.map(id=>TreeNodeSchema.parse(repository.getNode(s.workspaceId,id)));validateTreeModules({modules:nodes.map(n=>({...n,inputIds:n.children}))},rows,modelTags);s.cacheHits=(s.cacheHits || 0)+1;result.push(...nodes);continue;}catch{/* Locally rebuild the invalid group; other completed caches remain. */}
      }
      const project=(rows)=>rows.map((i,n)=>({...projectTreeInput(i,`n${n+1}`),tagId,...(layer==='daily' ? {window:i.window} : {})}));
      async function merge(rows,depth=0) {
        if(depth>12) throw new Error('分批合并未收敛');
        const projection=project(rows),batches=packTreeInputs(projection,config.batchBytes);
        if(batches.length===1) {
          const value=await model(layer,{inputs:projection,tagId,tagName:tagNames.get(tagId) || '未分类'},raw=>{
            try {
              const output=validateTreeModules(raw,projection,modelTags);
              if(output.modules.some(m=>m.tagId!==tagId)) throw new Error('模块主Tag与固定分组不符');
              return output;
            } catch(error) {
              if(!s.allowAttributionRepair || !isAttributionValidationError(error)) throw error;
              const repaired=repairTreeModuleAttribution(raw,projection,modelTags,{tagId});
              if(!repaired) throw error;
              return repaired;
            }
          },s);
          return value.modules.map(m=>({...m,inputIds:m.inputIds.flatMap(alias=>rows[Number(alias.slice(1))-1].directIds)}));
        }
        const intermediate=[];
        let offset=0;
        for(const batch of batches) {
          const subset=rows.slice(offset,offset+batch.length);offset+=batch.length;
          intermediate.push(...(await merge(subset,depth+1)).map((m,n)=>({...m,id:`batch${offset}-${n}`,directIds:m.inputIds})));
        }
        if(Buffer.byteLength(JSON.stringify(project(intermediate)))>=Buffer.byteLength(JSON.stringify(projection))) throw new Error('同层批次合并未压缩，等待修复');
        return merge(intermediate,depth+1);
      }
      // A single already-short input may be reused verbatim; this does not invent a model output or delete facts.
      const output=rows.length===1 && rows[0].safePassthrough===true && rows[0].validatorVersion===TREE_VALIDATOR_VERSION
        && (rows[0].layer==='information' ? reusableInformation(rows[0]) : rows[0].effectivePromptHash===skills.hourly.version) && Array.from(rows[0].text).length<=80
        ? [{title:rows[0].title,text:rows[0].text,tagId,inputIds:[rows[0].id]}]
        : await merge(rows.map(i=>({...i,directIds:[i.id]})));
      // Flattened internal batches still belong to the original immediate previous layer.
      validateTreeModules({modules:output},rows,modelTags);
      const nodes=output.map(m=>{
        const children=stable(m.inputIds.map(id=>rows.find(i=>i.id===id)));
        const nodeVersion=materialHash({version,title:m.title,text:m.text,children:children.map(i=>i.id)});
        return repository.saveNode(s.workspaceId,{title:m.title,text:m.text,tagId:m.tagId,id:`${layer[0]}:${nodeVersion}`,version:nodeVersion,layer,
          children:children.map(i=>i.id),articleIds:[...new Set(children.flatMap(i=>i.articleIds))].sort(),window,generatedAt:now(),effectivePromptHash:skills[layer].version,validatorVersion:TREE_VALIDATOR_VERSION,safePassthrough:Array.from(m.text).length<=80});
      });
      reportRepository.saveAnalysisStage(s.workspaceId,'tree-cache',stageKey,version,{stage:layer},{ids:nodes.map(n=>n.id)},'completed');result.push(...nodes);
      } catch(error) {
        const selected=route(layer) || {};
        const meta={layer,task:layer==='daily' ? 'daily-analysis' : 'hourly-brief',tagId,tagName:tagNames.get(tagId) || '未分类',windowStart:window?.startAt,
          elapsedMs:Date.now()-s.started,provider:selected.provider,model:selected.model};
        try {
          const projection=rows.map((row,index)=>({...projectTreeInput(row,`n${index+1}`),tagId,...(layer==='daily' ? {window:row.window} : {})}));
          console.error(formatCondenseFailureLog(error,{...meta,inputCount:rows.length,inputBytes:Buffer.byteLength(JSON.stringify(projection)),
            skillBytes:Buffer.byteLength(String(skills[layer]?.instruction || '')),calls:s.calls}));
        } catch { /* 诊断日志失败不能挡住失败分组落库 */ }
        try { result.diagnostics.push(describeCondenseFailure(error,meta)); } catch { /* 诊断字段失败不能挡住失败分组落库 */ }
        const failure={...(error.cachedPending || treeFailure(error,stageKey,'',now())),tagId};result.failures.push(failure);
        if(!error.cachedPending) result.freshFailure=true;
        reportRepository.saveAnalysisStage(s.workspaceId,'tree-cache',stageKey,version,{stage:layer,failure,inputs:rows.map(n=>n.id)},null,'failed',String(error.message).slice(0,1200));
      }
    }
    return result;
  }
  function priorEdition(layer,window,workspaceId) {
    return repository.list(workspaceId,window.startAt,window.endAt,layer).find(row=>row.attempt?.window?.startAt===window.startAt)?.attempt || null;
  }
  async function edition(layer,inputs,window,s,{pendingIds=[],pending=[],missingHours=[]}={}) {
    const expectedHead=repository.head(s.workspaceId,layer,window);
    const modules=await condense(layer,inputs,window,s),failed=modules.failures.length>0;
    let status=failed ? 'failed' : pendingIds.length || pending.length || missingHours.length ? 'partial' : 'ready';
    let inputRows=inputs;
    if(layer==='daily' && failed && modules.length) {
      const covered=new Set(modules.flatMap(node=>node.children));
      inputRows=inputs.filter(node=>covered.has(node.id));
      status=inputRows.length ? 'partial' : 'failed';
    }
    let attemptMeta={};
    if(layer==='hourly' && status==='failed') {
      const prior=priorEdition(layer,window,s.workspaceId);
      const next=nextHourlyAttempt({prior,inputIds:inputs.map(node=>node.id),freshFailure:modules.freshFailure===true,cap:hourlyAttemptCap});
      if(next.terminal) for(const failure of modules.failures) {failure.retryable=false;failure.retryAt=null;}
      attemptMeta={attemptCount:next.attemptCount,terminal:next.terminal};
    }
    const value={layer,window,timezone,status,roots:modules.map(n=>n.id),inputIds:inputRows.map(n=>n.id).sort(),pendingIds,pending,groupFailures:modules.failures,policyHash,missingHours,generatedAt:now(),...attemptMeta};
    const saved=repository.publish(s.workspaceId,{...value,id:`edition:${materialHash({...value,generatedAt:undefined})}`},{expectedHead});
    if(modules.diagnostics.length) Object.defineProperty(saved,'condenseDiagnostics',{value:modules.diagnostics,enumerable:false});
    return saved;
  }
  async function prepareInformation({workspaceId='local',materials,sourceIds,force=false,priority=0,totalMs}={}) {
    ensurePolicy(workspaceId);
    materials ||= await materialPort?.(workspaceId,sourceIds || []) || [];
    const s={...session(priority,totalMs),workspaceId,force},nodes=[],pending=[];
    for(const id of sourceIds || [])if(!materials.some(m=>m.id===id)) {
      const failure={id,reason:'needs-content',retryable:false,retryAt:null,sourceVersion:'unavailable'};pending.push(failure);
      reportRepository.saveAnalysisStage(workspaceId,'tree-preparation',`information:${id}`,materialHash({id,unavailable:true}),{sourceId:id,sourceVersion:'unavailable'},{pending:failure},'failed','来源未就绪或不在允许处理范围');
    }
    for(const m of stable(materials)) {
      const at=m.eventAt ?? m.publishedAt ?? now(),window={startAt:Math.floor(at/HOUR)*HOUR,endAt:(Math.floor(at/HOUR)+1)*HOUR},sourceHash=materialHash(treeSource(m)),sourceVersion=String(m.version || m.updatedAt || sourceHash);
      if(isFlashSource({id:m.id,sourceId:m.sourceId,publisher:m.publisher,displayName:m.publisher}, flashSources)) {
        pending.push({id:m.id,reason:'flash-source',retryable:false,retryAt:null,sourceVersion});
        continue;
      }
      const stageKey=`${articleStrategy ? 'article' : 'information'}:${m.id}`;
      try {
        const node=await information(m,window,s);
        if(!repository.setInformationHead(workspaceId,node,policyHash))throw Object.assign(new Error('已过期生成策略'),{code:'stale-policy'});
        nodes.push(node);reportRepository.saveAnalysisStage(workspaceId,'tree-preparation',stageKey,sourceHash,{sourceId:m.id,sourceVersion,effectivePromptHash:skills.information.version,...(articleStrategy ? {generationVersion:generationVersion('information')} : {})},{nodeId:node.id},'completed');
      } catch(error) {
        const failure=error.cachedPending ? {...error.cachedPending} : treeFailure(error,m.id,sourceVersion,now());
        if(!error.cachedPending) {
          const previous=reportRepository.getAnalysisStage(workspaceId,'tree-preparation',stageKey,sourceHash);
          const prior=Number(previous?.output?.pending?.attempts);
          const attempts=Number.isInteger(prior) && prior>0 ? prior+1 : 1;
          failure.attempts=attempts;
          if(attempts>=prepAttemptCap && failure.retryable && failure.reason!=='information-not-ready') {
            failure.reason='prep-exhausted';
            failure.retryable=false;
            failure.retryAt=null;
          }
        }
        pending.push(failure);
        reportRepository.saveAnalysisStage(workspaceId,'tree-preparation',stageKey,sourceHash,{sourceId:m.id,sourceVersion,effectivePromptHash:skills.information.version,...(articleStrategy ? {generationVersion:generationVersion('information')} : {})},{pending:failure},'failed',failure.reason);
      }
    }
    return {nodes,pending,calls:s.calls,cacheHits:s.cacheHits || 0};
  }
  async function generateHour({workspaceId='local',hourStart,materials,coverage=[],priority=10,totalMs,prepare=false,retryTransient=false}={}) {
    if(hourStart>now())throw new Error('目标小时尚未开始；拒绝把未来零材料窗口发布成ready');
    if(hourStart+HOUR>now())throw new Error('目标小时尚未结束；请在整小时结束后生成正式刊期');
    ensurePolicy(workspaceId);
    const window={startAt:hourStart,endAt:hourStart+HOUR},s={...session(priority,totalMs),workspaceId,retryTransient};
    // Explicit migration/replay input may prepare; the normal Worker path never reads full materials.
    let prepared;
    if(materials)prepared=await prepareInformation({workspaceId,materials,priority,totalMs:config.informationMs ?? s.totalMs*0.6});
    else if(prepare){const frozen=await prepareDailyMaterials({feedService,mediaPort,workspaceId,time:{contentWindow:window},frozenAt:now()});coverage=frozen.coverage;prepared=await prepareInformation({workspaceId,materials:frozen.materials,priority,totalMs:s.totalMs*0.6});}
    const candidates=materials || await candidatePort?.(workspaceId,window) || [];
    // Upgrade only matching, already validated heads using candidate metadata. No original
    // reads or AI calls are needed when first-ingestion grouping replaces publication grouping.
    for(const candidate of candidates) {
      if(!Number.isFinite(candidate.eventAt) || candidate.eventAt<window.startAt || candidate.eventAt>=window.endAt)continue;
      const head=repository.informationHead(workspaceId,candidate.id)?.node;
      if(!head || !reusableInformation(head) || head.sourceVersion!==String(candidate.version || candidate.updatedAt || ''))continue;
      const grouped=groupInformation(workspaceId,head,window,candidate.eventAt);
      if(grouped.id!==head.id)repository.setInformationHead(workspaceId,grouped,policyHash);
    }
    const ready=repository.listInformation(workspaceId,window),nodes=[],pending=[...(prepared?.pending || [])];
    const wanted=new Map(candidates.map(m=>[m.id,String(m.version || m.updatedAt || '')]));
    for(const n of ready) {
      if((materials!==undefined || candidatePort) && !wanted.has(n.sourceId))continue;
      if(wanted.get(n.sourceId) && wanted.get(n.sourceId)!==n.sourceVersion)continue;
      if(!reusableInformation(n))continue;
      try {
        const current=await classified(n,{id:n.sourceId},s);
        if(!repository.setInformationHead(workspaceId,current,policyHash))throw Object.assign(new Error('已过期生成策略'),{code:'stale-policy'});
        nodes.push(current);
      }catch(error){pending.push(treeFailure(error,n.sourceId,n.sourceVersion,now()));}
    }
    const states=reportRepository.listTreePreparationStates?.(workspaceId,[...wanted.keys()]) || [];
    for(const [id,sourceVersion] of wanted)if(!nodes.some(n=>n.sourceId===id) && !pending.some(p=>p.id===id)) {
      const state=states.find(row=>row.input?.sourceId===id && row.input.sourceVersion===sourceVersion);
      pending.push(settlePreparationPending(id,sourceVersion,state));
    }
    for(const c of coverage)if(c.omitted || c.failed)pending.push({id:`source:${c.sourceId}:incomplete`,reason:'budget-deferred',retryable:true,retryAt:now()+30*60000});
    const prior=priorEdition('hourly',window,workspaceId);
    if(prior?.terminal && sameIdSet(prior.inputIds, nodes.map(node=>node.id))) return prior;
    const pendingIds=pending.filter(item=>!isTerminalPendingReason(item.reason)).map(item=>item.id);
    return edition('hourly',nodes,window,s,{pendingIds,pending});
  }
  function settlePreparationPending(id,sourceVersion,state) {
    const recorded=state?.output?.pending;
    if(!recorded || state?.input?.sourceId!==id || state?.input?.sourceVersion!==sourceVersion) return {id,reason:'information-not-ready',retryable:false,retryAt:null,sourceVersion};
    const attempts=Number(recorded.attempts);
    if(Number.isInteger(attempts) && attempts>=prepAttemptCap && recorded.retryable===true && recorded.reason!=='information-not-ready') {
      return {...recorded,id,reason:'prep-exhausted',retryable:false,retryAt:null,attempts};
    }
    return {...recorded,id};
  }
  async function generateDaily({workspaceId='local',window,hours}={}) {
    ensurePolicy(workspaceId);
    hours ||= repository.list(workspaceId,Math.floor(window.startAt/HOUR)*HOUR,window.endAt,'hourly').map(r=>r.edition).filter(Boolean);
    const s={...session(0, config.dailyTotalMs),workspaceId};
    // Non-integral cutoffs reuse saved information through an explicit boundary hourly module.
    // The daily model itself continues to see hourly modules only.
    for(const at of [...new Set([Math.floor(window.startAt/HOUR)*HOUR,Math.floor((window.endAt-1)/HOUR)*HOUR])]) {
      const boundary={startAt:Math.max(at,window.startAt),endAt:Math.min(at+HOUR,window.endAt)};
      if(boundary.startAt===at && boundary.endAt===at+HOUR)continue;
      const full=hours.find(h=>h.window.startAt===at && h.window.endAt===at+HOUR && h.status==='ready');
      if(!full)continue;
      const nodes=full.roots.flatMap(id=>repository.getNode(workspaceId,id).children).map(id=>repository.getNode(workspaceId,id));
      if(nodes.some(n=>!Number.isFinite(n.eventAt)))continue;
      const subset=nodes.filter(n=>n.eventAt>=boundary.startAt && n.eventAt<boundary.endAt);
      const boundaryHour=await edition('hourly',subset,boundary,s);
      hours=[...hours.filter(h=>h.id!==full.id),boundaryHour];
    }
    const missingHours=[];
    for(let at=Math.floor(window.startAt/HOUR)*HOUR;at<window.endAt;at+=HOUR) {
      const hour=hours.find(h=>h.window.startAt===Math.max(at,window.startAt) && h.window.endAt===Math.min(at+HOUR,window.endAt));
      if(!hour || hour.status!=='ready') missingHours.push(at);
    }
    const inputs=hours.filter(h=>h.status!=='failed' && h.window.startAt>=window.startAt && h.window.endAt<=window.endAt)
      .flatMap(h=>h.roots.map(id=>repository.getNode(workspaceId,id)));
    return edition('daily',inputs,window,s,{missingHours});
  }
  return {...reader,prepareInformation,generateHour,generateDaily,editorial(workspace,window){return repository.editorialForWindow?.(workspace,window) || null;},policyHash,effectivePromptHashes:Object.fromEntries(Object.entries(skills).map(([stage,value])=>[stage,value.version])),async generateHourlyDigests({workspaceId='local',hourStart,mode,snapshotId}={}) {
    if(mode==='rewrite' || snapshotId)throw new Error('历史稿重编请使用legacy；浓缩树不把旧事实底稿当作单篇信息');
    const latest=Math.floor(now()/HOUR)*HOUR-HOUR;
    if(hourStart!==undefined) return [await generateHour({workspaceId,hourStart,retryTransient:mode==='resume',priority:hourStart===latest ? 10 : -10,
      ...(hourStart!==latest ? {totalMs:8*60000} : {})})];
    const result=[await generateHour({workspaceId,hourStart:latest})];
    // Reuse original latest-first scheduling; one older window per run, no replacement scheduler.
    const prior=repository.list(workspaceId,latest-23*HOUR,latest,'hourly');
    const target=Array.from({length:23},(_,i)=>latest-(i+1)*HOUR).find(at=>{
      const row=prior.find(r=>r.attempt?.window.startAt===at),attempt=row?.attempt;
      if(!attempt)return true;
      if(attempt.terminal) return repository.listInformation(workspaceId,{startAt:at,endAt:at+HOUR}).some(n=>!attempt.inputIds.includes(n.id));
      if((attempt.groupFailures || []).some(p=>p.retryable && p.retryAt<=now()))return true;
      if((attempt.pending || []).some(p=>p.retryable && p.retryAt<=now() && repository.informationHead(workspaceId,p.id)))return true;
      return repository.listInformation(workspaceId,{startAt:at,endAt:at+HOUR}).some(n=>!attempt.inputIds.includes(n.id));
    });
    if(target!==undefined) result.push(await generateHour({workspaceId,hourStart:target,priority:-10,totalMs:8*60000}));
    else if(prior.every(r=>r.edition?.status==='ready')) {
      const at=latest-(Math.floor(now()/HOUR)%23+1)*HOUR;
      result.push(await generateHour({workspaceId,hourStart:at,priority:-10,totalMs:8*60000}));
    }
    return result;
  }};
}
