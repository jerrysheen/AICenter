import { createHash } from 'node:crypto';
import { FeedValueInputSchema,FeedValueScoresSchema } from '../../contracts/src/feed-value.js';
import { normalizeFeedValueText,decideFeedValue,createFeedValueEvaluator,FEED_VALUE_RULE,feedValueRuleHash,feedValuePolicyHash,FEED_VALUE_VERSION } from './feed-value.js';
import { bodyCompletionFields } from './body-completion.js';
import { hasPersistedModelFocus } from './x-focus.js';

const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

function noteXScoreWritten(onXScoreWritten, workspaceId, capture) {
  if (typeof onXScoreWritten !== 'function' || capture?.provider !== 'x' || !hasPersistedModelFocus(capture.metadata)) return;
  try {
    const pending = onXScoreWritten({ workspaceId });
    if (pending && typeof pending.then === 'function') {
      pending.catch((error) => {
        console.log(`[worker] x-auto-like skipped ${String(error?.message || error).slice(0, 160)}`);
      });
    }
  } catch (error) {
    console.log(`[worker] x-auto-like skipped ${String(error?.message || error).slice(0, 160)}`);
  }
}

// Reuse scores only when the saved current input is identical. Repository writes preserve originals and emit outbox events.
export function createFeedValueReviewService({feedRepository,mediaRepository,onXScoreWritten=null}={}) {
  return Object.freeze({apply(rows,{workspaceId='local',model='jev-1.13.0',runId=''}={}) {
    const result={applied:0,changedInput:0,missing:0,invalid:0,KEEP:0,DROP:0,REVIEW:0};
    for(const row of rows) {
      const p=FeedValueInputSchema.safeParse(row.input);
      if(!p.success || row.model!==model || (!row.errorReason && !FeedValueScoresSchema.safeParse(row.scores).success)) {result.invalid++;continue;}
      let capture,raw,title,author='',context={},media=null,current;
      if(row.id.startsWith('feed:')) {
        const item=feedRepository.getContentItem(workspaceId,row.id.slice(5));
        if(!item) {result.missing++;continue;}
        capture=feedRepository.getCapture(workspaceId,item.provider,item.externalId);
        if(!capture) {result.missing++;continue;}
        raw=capture.metadata.originalText || item.body || item.summary || '';title=item.title;author=item.authorName;
        context=capture.metadata.captureContext || {};
        current=normalizeFeedValueText(raw,{title,authorName:author,capture:context});
      } else if(row.id.startsWith('media:')) {
        media=mediaRepository?.getEntries(workspaceId,[row.id.slice(6)])?.[0];
        if(!media) {result.missing++;continue;}
        const body=mediaRepository.latestBodies(workspaceId,[media.externalId])[0];
        raw=body?.bodyText || media.summary || '';title=media.title;
        context={truncated:Boolean(body?.truncated)};
        current=normalizeFeedValueText(raw,{title,capture:context});
        capture=feedRepository.getCapture(workspaceId,'media',media.externalId);
      } else {result.invalid++;continue;}
      const changed=hash(current)!==hash(p.data);
      if(changed) result.changedInput++;
      // Changed inputs need a fresh score; hold their current capture outside the content pool.
      const decision=decideFeedValue(changed?null:row.scores,{input:current,model,errorReason:changed?'invalid-scores':row.errorReason,rule:FEED_VALUE_RULE});
      if(!capture) {
        const source=feedRepository.upsertSourceAccount({workspaceId,provider:'media',externalId:`media:${media.sourceKey}`,
          displayName:media.publisherName || media.publisherKey || media.sourceKey,profileUrl:media.canonicalUrl,authMode:'public',
          metadata:{sourceId:'content.media.articles',autoRefresh:false,sourceKey:media.sourceKey}});
        capture={workspaceId,provider:'media',externalId:media.externalId,sourceAccountId:source.id,sourceUrl:media.canonicalUrl,
          title,contentHash:media.bodyHash || media.contentHash,rawArtifactPath:null,publishedAt:media.publishedAt,capturedAt:media.observedAt,metadata:{originalText:raw}};
      }
      const history=capture.metadata.filterRule ? [...(capture.metadata.filterHistory || []),{
        rule:capture.metadata.filterRule,decision:capture.metadata.filterDecision,at:capture.metadata.filterEvaluatedAt || null}].slice(-5) : [];
      const previousDecision = String(capture.metadata.filterDecision || '');
      const blocked=decision.decision!=='KEEP';
      const evaluatedAt=Date.now();
      const completion=bodyCompletionFields({...capture.metadata,capturedAt:capture.capturedAt},{truncated:Boolean(decision.bodyPending),now:evaluatedAt});
      feedRepository.saveCapture({...capture,status:decision.decision==='DROP'?'ignored':decision.decision==='REVIEW'?'captured':'ready',metadata:{...capture.metadata,
        filterHistory:history,filterDecision:decision.decision,filterReviewKind:decision.reviewKind,filterReason:decision.reason,
        filterScores:changed?null:row.scores,filterMode:'enforce',filterApplied:blocked,filterRule:FEED_VALUE_RULE,filterRuleHash:feedValueRuleHash(),
        filterVersion:FEED_VALUE_VERSION,filterPolicyHash:feedValuePolicyHash(),evaluatorModel:model,
        filterCacheKey:changed?'':createFeedValueEvaluator({model}).cacheKey(current),
        ...completion,
        ...(runId?{filterRefreshRunId:runId}:{}),
        filterEvaluatedAt:evaluatedAt,scoreOrigin:changed?'input-changed-needs-rescore':row.scoreOrigin || 'frozen-v3-identical-input',wouldIgnore:blocked}});
      if (previousDecision !== decision.decision) noteXScoreWritten(onXScoreWritten, workspaceId, capture);
      result.applied++;result[decision.decision]++;
    }
    return result;
  }});
}
