import {FeedValueRefreshInputSchema} from '../../contracts/src/feed-value.js';
export const FEED_VALUE_REFRESH_JOB_TYPE='feed.quality.refresh';
export const feedValueRefreshManifest=Object.freeze({id:'feed.quality.refresh',version:'1.0.0',capabilities:['feed.quality.refresh'],jobTypes:[FEED_VALUE_REFRESH_JOB_TYPE]});
export function createFeedValueRefreshJobHandlers({service,onProgress=()=>{}}={}) {
  return {[FEED_VALUE_REFRESH_JOB_TYPE]:async(input,context)=>service.refresh(FeedValueRefreshInputSchema.parse(input || {}),{runId:context.job.id,signal:context.signal,onProgress})};
}
