import {FeedValueRefreshInputSchema,FeedValueScoresSchema} from '../../contracts/src/feed-value.js';
import {createFeedValueEvaluator,normalizeFeedValueText,feedValuePolicyHash,FEED_VALUE_RULE} from './feed-value.js';
import {createFeedValueReviewService} from './feed-value-review-service.js';

export function createFeedValueRefreshService({feedRepository,mediaRepository,client,model='jev-1.13.0',scoreCache=null}={}) {
  const evaluator=createFeedValueEvaluator({client,model,rule:FEED_VALUE_RULE});
  const cache=new Map();
  if(scoreCache?.policyHash===feedValuePolicyHash() && scoreCache.model===model) for(const r of scoreCache.rows || []) {
    if(r.model===model && !r.errorReason && FeedValueScoresSchema.safeParse(r.scores).success) cache.set(evaluator.cacheKey(r.input),r.scores);
  }
  const review=createFeedValueReviewService({feedRepository,mediaRepository});
  return Object.freeze({async refresh(rawInput={}, {runId='',signal,onProgress=()=>{}}={}) {
    const input=FeedValueRefreshInputSchema.parse(rawInput),{workspaceId}=input;
    const feed=feedRepository.listQualityRefreshItems(workspaceId,input).map(row=>({id:`feed:${row.id}`,
      input:normalizeFeedValueText(row.captureMetadata.originalText || row.body || row.summary || '',{title:row.title,authorName:row.authorName,capture:row.captureMetadata.captureContext || {}}),metadata:row.captureMetadata}));
    const hidden=new Set(feedRepository.listHiddenExternalIds?.(workspaceId,'media') || []);
    const media=(mediaRepository?.listEntries(workspaceId,{limit:10000}) || []).filter(r=>!hidden.has(r.externalId));
    const bodies=new Map((mediaRepository?.latestBodies(workspaceId,media.map(r=>r.externalId)) || []).map(b=>[b.externalId,b]));
    const rows=[...feed,...media.map(r=>({id:`media:${r.externalId}`,
      input:normalizeFeedValueText(bodies.get(r.externalId)?.bodyText || r.summary || '',{title:r.title,capture:{truncated:Boolean(bodies.get(r.externalId)?.truncated)}}),
      metadata:feedRepository.getCapture(workspaceId,'media',r.externalId)?.metadata || {}}))];
    const output={total:rows.length,done:0,KEEP:0,DROP:0,REVIEW:0,reused:0,requested:0,preflight:0,changedInput:0,missing:0,invalid:0,rule:FEED_VALUE_RULE,runId,perSourceLimit:input.perSourceLimit};
    let cursor=0;
    onProgress({...output});
    await Promise.all(Array.from({length:input.concurrency},async()=>{
      while(cursor<rows.length) {
        if(signal?.aborted) throw new Error('Quality refresh interrupted');
        const row=rows[cursor++],key=evaluator.cacheKey(row.input),m=row.metadata;
        const stored=m.filterPolicyHash===feedValuePolicyHash() && m.evaluatorModel===model && m.filterCacheKey===key && FeedValueScoresSchema.safeParse(m.filterScores).success ? m.filterScores : null;
        const scores=stored || cache.get(key);
        let result;
        if(scores) {result={scores,model,errorReason:''};output.reused++;}
        else {result=await evaluator.evaluate(row.input,{signal});if(!result.errorReason || result.errorReason==='jev-failed')output.requested++;else output.preflight++;}
        const applied=review.apply([{...row,...result,scoreOrigin:scores?'identical-input-score-cache':'current-pool-jev'}],{workspaceId,model,runId});
        for(const k of ['KEEP','DROP','REVIEW','changedInput','missing','invalid'])output[k]+=applied[k];
        output.done++;
        if(output.done%50===0 || output.done===output.total)onProgress({...output});
      }
    }));
    return {...output,completedAt:Date.now()};
  }});
}
