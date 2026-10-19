import {FeedValueRefreshInputSchema,FeedValueScoresSchema} from '../../contracts/src/feed-value.js';
import {createFeedValueEvaluator,normalizeFeedValueText,feedValuePolicyHash,FEED_VALUE_RULE,feedValueRuleHash,FEED_VALUE_VERSION} from './feed-value.js';
import {createFeedValueReviewService} from './feed-value-review-service.js';
import {isFlashSource} from './flash-sources.js';
import {decideFeedAdmissionFallback} from './feed-filter.js';
import {isJevOutage} from './jev-enabled.js';

function saveFallbackCapture(feedRepository, workspaceId, row, decision, reason, result, runId) {
  let capture = null;
  if (String(row.id).startsWith('feed:')) {
    const item = feedRepository.getContentItem(workspaceId, row.id.slice(5));
    if (!item) return false;
    capture = feedRepository.getCapture(workspaceId, item.provider, item.externalId);
  } else if (String(row.id).startsWith('media:')) {
    capture = feedRepository.getCapture(workspaceId, 'media', row.id.slice(6));
  }
  if (!capture) return false;
  const metadata = {
    ...capture.metadata,
    filterDecision: decision,
    filterReason: reason,
    filterReviewKind: decision === 'KEEP' ? 'none' : 'technical',
    filterScores: null,
    filterMode: 'enforce',
    filterApplied: decision !== 'KEEP',
    filterRule: FEED_VALUE_RULE,
    filterRuleHash: feedValueRuleHash(FEED_VALUE_RULE),
    filterVersion: FEED_VALUE_VERSION,
    filterErrorCode: result?.errorCode || capture.metadata.filterErrorCode || '',
    filterErrorStatus: Number.isInteger(result?.errorStatus) ? result.errorStatus : (capture.metadata.filterErrorStatus ?? null),
    ...(decision === 'KEEP' ? { fallbackAt: new Date().toISOString() } : {}),
    ...(runId ? { filterRefreshRunId: runId } : {}),
    filterEvaluatedAt: Date.now(),
  };
  feedRepository.saveCapture({
    ...capture,
    status: decision === 'DROP' ? 'ignored' : decision === 'REVIEW' ? 'captured' : 'ready',
    metadata,
  });
  return true;
}

export function resolveBambooRefresh(env = process.env, provider = 'typesafe') {
  const enabled = provider === 'bamboo' && String(env?.AI_CENTER_BAMBOO_REFRESH ?? '').trim() === '1';
  const raw = String(env?.AI_CENTER_BAMBOO_REFRESH_MAX ?? '').trim();
  let max = 200;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) max = parsed;
  }
  return { enabled, max };
}

export function createFeedValueRefreshService({feedRepository,mediaRepository,client,model='jev-1.13.0',scoreCache=null,flashSources=null,jevEnabled=true,classificationProvider='typesafe',fallback=true,xFocusConfig=null,xFocusMin=0.7,bambooRefresh=false,bambooRefreshMax=200}={}) {
  const bamboo = classificationProvider === 'bamboo';
  const classify = bamboo ? bambooRefresh === true : jevEnabled !== false;
  const refreshCap = Number.isInteger(bambooRefreshMax) && bambooRefreshMax >= 0 ? bambooRefreshMax : 200;
  let refreshCalls = 0;
  const evaluator=createFeedValueEvaluator({client:classify?client:null,model,rule:FEED_VALUE_RULE});
  const cache=new Map();
  if(scoreCache?.policyHash===feedValuePolicyHash() && scoreCache.model===model) for(const r of scoreCache.rows || []) {
    if(r.model===model && !r.errorReason && FeedValueScoresSchema.safeParse(r.scores).success) cache.set(evaluator.cacheKey(r.input),r.scores);
  }
  const review=createFeedValueReviewService({feedRepository,mediaRepository});
  return Object.freeze({async refresh(rawInput={}, {runId='',signal,onProgress=()=>{}}={}) {
    const input=FeedValueRefreshInputSchema.parse(rawInput),{workspaceId}=input;
    const feed=feedRepository.listQualityRefreshItems(workspaceId,input).filter(row=>!isFlashSource({externalId:row.sourceExternalId,displayName:row.sourceName,publisher:row.sourceName}, flashSources)).map(row=>({id:`feed:${row.id}`,provider:row.provider,sourceExternalId:row.sourceExternalId || '',externalId:row.externalId,
      input:normalizeFeedValueText(row.captureMetadata.originalText || row.body || row.summary || '',{title:row.title,authorName:row.authorName,capture:row.captureMetadata.captureContext || {}}),metadata:row.captureMetadata}));
    const hidden=new Set(feedRepository.listHiddenExternalIds?.(workspaceId,'media') || []);
    const media=(mediaRepository?.listEntries(workspaceId,{limit:10000}) || []).filter(r=>!hidden.has(r.externalId) && !isFlashSource({sourceKey:r.sourceKey,publisher:r.publisherName,id:r.sourceKey}, flashSources));
    const bodies=new Map((mediaRepository?.latestBodies(workspaceId,media.map(r=>r.externalId)) || []).map(b=>[b.externalId,b]));
    const rows=[...feed,...media.map(r=>({id:`media:${r.externalId}`,provider:'media',sourceExternalId:r.sourceKey || '',externalId:r.externalId,
      input:normalizeFeedValueText(bodies.get(r.externalId)?.bodyText || r.summary || '',{title:r.title,capture:{truncated:Boolean(bodies.get(r.externalId)?.truncated)}}),
      metadata:feedRepository.getCapture(workspaceId,'media',r.externalId)?.metadata || {}}))];
    const output={total:rows.length,done:0,KEEP:0,DROP:0,REVIEW:0,reused:0,requested:0,preflight:0,skipped:0,changedInput:0,missing:0,invalid:0,rule:FEED_VALUE_RULE,runId,perSourceLimit:input.perSourceLimit};
    let cursor=0;
    onProgress({...output});
    await Promise.all(Array.from({length:input.concurrency},async()=>{
      while(cursor<rows.length) {
        if(signal?.aborted) throw new Error('Quality refresh interrupted');
        const row=rows[cursor++],key=evaluator.cacheKey(row.input),m=row.metadata || {};
        const parsedScores=FeedValueScoresSchema.safeParse(m.filterScores).success;
        const decided=m.filterDecision==='KEEP' || m.filterDecision==='DROP';
        if(!classify && (parsedScores || decided)) {
          output.reused++;
          output.done++;
          if(output.done%50===0 || output.done===output.total)onProgress({...output});
          continue;
        }
        const stored=m.filterPolicyHash===feedValuePolicyHash() && m.evaluatorModel===model && m.filterCacheKey===key && parsedScores ? m.filterScores : null;
        const scores=classify ? (stored || cache.get(key)) : null;
        let result;
        if(scores) {result={scores,model,errorReason:''};output.reused++;}
        else if(bamboo && classify && refreshCalls>=refreshCap) {
          output.skipped++;
          output.done++;
          if(output.done%50===0 || output.done===output.total)onProgress({...output});
          continue;
        }
        else {
          if(bamboo && classify) refreshCalls++;
          result=await evaluator.evaluate(row.input,{signal});
          if(!result.errorReason || result.errorReason==='jev-failed') output.requested++;
          else output.preflight++;
        }
        const outage=isJevOutage(result);
        const useFallback=outage && (fallback!==false || !jevEnabled) && !scores;
        if(useFallback) {
          const prefix=jevEnabled?'fallback':'jev-disabled';
          const admission=decideFeedAdmissionFallback({provider:row.provider,sourceExternalId:row.sourceExternalId,originalText:row.metadata?.originalText || row.input?.body || '',item:{provider:row.provider,title:row.input?.title,body:row.input?.body,xFocus:row.metadata?.xFocus,sourceExternalId:row.sourceExternalId}},{xFocusConfig,xFocusMin,prefix});
          if(admission.admit || !jevEnabled) {
            const decision=admission.admit?'KEEP':'REVIEW';
            const reason=admission.admit?admission.reason:(jevEnabled?result.errorReason || 'jev-failed':'jev-disabled');
            const saved=saveFallbackCapture(feedRepository,workspaceId,row,decision,reason,result,runId);
            if(!saved) output.missing++; else output[decision]++;
          } else {
            const applied=review.apply([{...row,...result,scoreOrigin:'current-pool-jev'}],{workspaceId,model,runId});
            for(const k of ['KEEP','DROP','REVIEW','changedInput','missing','invalid'])output[k]+=applied[k];
          }
        } else {
          const applied=review.apply([{...row,...result,scoreOrigin:scores?'identical-input-score-cache':'current-pool-jev'}],{workspaceId,model,runId});
          for(const k of ['KEEP','DROP','REVIEW','changedInput','missing','invalid'])output[k]+=applied[k];
        }
        output.done++;
        if(output.done%50===0 || output.done===output.total)onProgress({...output});
      }
    }));
    return {...output,completedAt:Date.now()};
  }});
}
