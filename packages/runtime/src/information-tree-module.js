import {PrepareTreeInformationInputSchema} from '../../contracts/src/information-tree.js';
export const TREE_PREPARE_JOB_TYPE='report.information.prepare';
export const informationTreeManifest={id:'report.information',version:'3.1.0',capabilities:['report.information.prepare'],jobTypes:[TREE_PREPARE_JOB_TYPE]};
const HOUR=3600000;
export async function prioritizeRecentTreePreparation(store,candidates,workspaceId='local',at=Date.now()) {
  if(!store?.reprioritizeQueuedJobs || !candidates)return [];
  const endAt=(Math.floor(at/HOUR)+1)*HOUR;
  const rows=await candidates(workspaceId,{startAt:endAt-2*HOUR,endAt});
  const priorities=new Map(rows.map(m=>[m.id,m.eventAt>=endAt-HOUR ? 20 : 30]));
  const changes=(store.listOpenJobs(TREE_PREPARE_JOB_TYPE) || []).filter(j=>j.workspaceId===workspaceId && j.status==='queued' && [0,20,30].includes(j.priority)).flatMap(j=>{
    const priority=Math.max(0,...(j.input.sourceIds || []).map(id=>priorities.get(id) || 0));
    return priority===j.priority ? [] : [{id:j.id,priority,expectedPriority:j.priority}];
  });
  return store.reprioritizeQueuedJobs(workspaceId,changes);
}
export function enqueuePreparedHourRefreshes(store,service,workspaceId,nodes,at=Date.now(),{minute=null}={}) {
  if(!store?.createJob || !nodes.length)return [];
  const latest=Math.floor(at/HOUR)*HOUR-HOUR;
  const hours=[...new Set(nodes.map(n=>n.window.startAt))].filter(h=>h<=latest && h>=latest-23*HOUR).sort((a,b)=>b-a);
  const queued=store.listOpenJobs('report.hourly.extract').filter(j=>j.workspaceId===workspaceId && j.status==='queued');
  const jobs=[];
  for(const hourStart of hours) {
    const slot=service.list(workspaceId,{startAt:hourStart,endAt:hourStart+HOUR}).hours[0];
    const published=slot?.edition;
    const attempt=slot?.attempt;
    if(nodes.filter(n=>n.window.startAt===hourStart).every(n=>published?.inputIds.includes(n.id)))continue;
    if(attempt?.terminal && nodes.filter(n=>n.window.startAt===hourStart).every(n=>attempt.inputIds.includes(n.id)))continue;
    // A running hour may already have frozen its inputs; retain one queued follow-up.
    if(queued.some(j=>j.input.hourStart===hourStart && !j.input.snapshotId && j.input.mode!=='rewrite'))continue;
    jobs.push(store.createJob({type:'report.hourly.extract',workspaceId,priority:hourStart===latest ? 10 : -5,maxAttempts:2,availableAt:minute===null ? at+60000 : Math.floor(at/HOUR)*HOUR+minute*60000+(at>=Math.floor(at/HOUR)*HOUR+minute*60000 ? HOUR : 0),input:{workspaceId,hourStart}}));
    // One historical catch-up per preparation batch; other saved nodes remain available
    // to the existing hourly rotation instead of flooding the single report lane.
    break;
  }
  return jobs;
}
export function enqueueTreePreparation(store,workspaceId,sourceIds) {
  if(!store?.createJob)return [];
  // A running preparation may have read the prior body revision. Keep at most one queued follow-up.
  const open=new Set((store.listOpenJobs?.(TREE_PREPARE_JOB_TYPE) || []).filter(j=>j.workspaceId===workspaceId && j.status==='queued').flatMap(j=>j.input.sourceIds || []));
  const wanted=[...new Set(sourceIds)].filter(id=>!open.has(id)),jobs=[];
  // Admit one material at a time so a mixed historical batch cannot hold the preparation lane.
  for(const id of wanted)jobs.push(store.createJob({type:TREE_PREPARE_JOB_TYPE,workspaceId,maxAttempts:1,input:{workspaceId,sourceIds:[id]}}));
  return jobs;
}
export function createInformationTreeJobHandlers(service,{candidates,refreshMinute=null}={}) {
  return {[TREE_PREPARE_JOB_TYPE]:async(raw,context)=>{
    const input=PrepareTreeInformationInputSchema.parse(raw),result=await service.prepareInformation(input);
    enqueuePreparedHourRefreshes(context?.store,service,input.workspaceId,result.nodes,Date.now(),{minute:refreshMinute});
    await prioritizeRecentTreePreparation(context?.store,candidates,input.workspaceId);
    const retry=result.pending.filter(p=>p.retryable);
    if(retry.length && (!input.catchup || retry.some(p=>p.reason==='budget-deferred')) && context?.store?.createJob)context.store.createJob({type:TREE_PREPARE_JOB_TYPE,workspaceId:input.workspaceId,maxAttempts:1,availableAt:Math.min(...retry.map(p=>p.retryAt || Date.now()+30*60000)),input:{workspaceId:input.workspaceId,sourceIds:retry.map(p=>p.id),catchup:true}});
    return {prepared:result.nodes.length,pending:result.pending,calls:result.calls,cacheHits:result.cacheHits};
  }};
}
