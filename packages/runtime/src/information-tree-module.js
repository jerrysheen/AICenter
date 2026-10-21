import {PrepareTreeInformationInputSchema} from '../../contracts/src/information-tree.js';
import {hourlyFailureCatchupLimit,hourlyRefreshAvailableAt,hourlyReportDisabled} from './report-module.js';
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
export function materialStamp(node) {
  return `${node?.sourceId || node?.id || ''}\0${node?.sourceVersion || ''}`;
}

// A published edition covering this material batch is not queued again.
// A non-terminal attempt (429, timeout, truncation) still retries the same materials.
export function editionCoversMaterials(edition, hourNodes, lookup) {
  if(!edition || !hourNodes?.length) return false;
  const ids=new Set(edition.inputIds || []);
  if(hourNodes.every(node=>ids.has(node.id))) return true;
  if(typeof lookup!=='function' || !edition.inputIds?.length) return false;
  const stamps=new Set();
  for(const id of edition.inputIds) {
    let node=null;
    try { node=lookup(id); } catch { return false; }
    if(!node?.sourceId) return false;
    stamps.add(materialStamp(node));
  }
  return hourNodes.every(node=>node?.sourceId && stamps.has(materialStamp(node)));
}

export function enqueuePreparedHourRefreshes(store,service,workspaceId,nodes,at=Date.now(),{minute=null,env=process.env}={}) {
  if(hourlyReportDisabled(env) || !store?.createJob || !nodes.length)return [];
  const latest=Math.floor(at/HOUR)*HOUR-HOUR;
  const hours=[...new Set(nodes.map(n=>n.window.startAt))].filter(h=>h<=latest && h>=latest-23*HOUR).sort((a,b)=>b-a);
  const queued=store.listOpenJobs('report.hourly.extract').filter(j=>j.workspaceId===workspaceId && j.status==='queued');
  const jobs=[];
  for(const hourStart of hours) {
    const hourNodes=nodes.filter(n=>n.window.startAt===hourStart);
    const slot=service.list(workspaceId,{startAt:hourStart,endAt:hourStart+HOUR}).hours[0];
    const published=slot?.edition;
    const attempt=slot?.attempt;
    const lookup=id=>service.node?.(workspaceId,id);
    if(editionCoversMaterials(published,hourNodes,lookup))continue;
    if(attempt?.terminal && editionCoversMaterials(attempt,hourNodes,lookup))continue;
    // A running hour may already have frozen its inputs; retain one queued follow-up.
    if(queued.some(j=>j.input.hourStart===hourStart && !j.input.snapshotId && j.input.mode!=='rewrite'))continue;
    jobs.push(store.createJob({type:'report.hourly.extract',workspaceId,priority:hourStart===latest ? 10 : -5,maxAttempts:2,availableAt:hourlyRefreshAvailableAt(at,minute),input:{workspaceId,hourStart}}));
    // One historical catch-up per preparation batch; other saved nodes remain available
    // to the existing hourly rotation instead of flooding the single report lane.
    break;
  }
  return jobs;
}

// A failed hour is due when a saved failure still says it can be retried and that time has arrived.
export function attemptRetryDue(attempt, at) {
  if (!attempt || attempt.terminal === true || attempt.status !== 'failed') return false;
  const records = [...(attempt.groupFailures || []), ...(attempt.pending || [])];
  return records.some((record) => record?.retryable === true && Number.isFinite(Number(record.retryAt)) && Number(record.retryAt) <= at);
}

// New material is a node the failed attempt does not already cover. Empty hours have nothing new.
export function hourHasNewMaterial(attempt, nodes, lookup) {
  if (!nodes?.length) return false;
  return !editionCoversMaterials(attempt, nodes, lookup);
}

// Older due hours fill the cap first. The latest ended hour only uses a slot that is still free,
// so a failing current hour cannot keep 10:00 and 11:00 off the queue.
// A failed attempt that does not cover the current nodes is still due. The prepare path
// queues only the newest hour, so treating that gap as "new material" left a middle hour
// off both paths.
export function dueFailedHourCatchupPlan({at, rows = [], openHourStarts = new Set(), limit = 2, windowHours = 24} = {}) {
  const cap = Number.isInteger(limit) && limit >= 1 && limit <= 4 ? limit : 2;
  const span = Number.isInteger(windowHours) && windowHours >= 1 && windowHours <= 24 ? windowHours : 24;
  if (!Number.isFinite(at)) return [];
  const latest = Math.floor(at / HOUR) * HOUR - HOUR;
  const oldest = latest - (span - 1) * HOUR;
  const older = [];
  let current = false;
  const seen = new Set();
  for (const row of rows) {
    const hourStart = Number(row?.hourStart);
    if (!Number.isFinite(hourStart) || hourStart > latest || hourStart < oldest || seen.has(hourStart)) continue;
    seen.add(hourStart);
    if (openHourStarts.has(hourStart)) continue;
    if (!attemptRetryDue(row.attempt, at)) continue;
    if (hourStart === latest) current = true;
    else older.push(hourStart);
  }
  older.sort((a, b) => a - b);
  const selected = older.slice(0, cap);
  if (current && selected.length < cap) selected.push(latest);
  return selected.map((hourStart) => ({hourStart, priority: hourStart === latest ? 0 : -1}));
}

export function enqueueDueFailedHourRefreshes(store, service, workspaceId = 'local', at = Date.now(), {limit, env = process.env, windowHours = 24} = {}) {
  if (hourlyReportDisabled(env) || !store?.createJob || !store?.listOpenJobs || typeof service?.list !== 'function') return [];
  const latest = Math.floor(at / HOUR) * HOUR - HOUR;
  const span = Number.isInteger(windowHours) && windowHours >= 1 && windowHours <= 24 ? windowHours : 24;
  const oldest = latest - (span - 1) * HOUR;
  const listed = service.list(workspaceId, {startAt: oldest, endAt: latest + HOUR}) || {};
  const slots = Array.isArray(listed.hours) ? listed.hours : [];
  const rows = [];
  for (const slot of slots) {
    const attempt = slot?.attempt;
    const hourStart = Number(attempt?.window?.startAt);
    if (!Number.isFinite(hourStart)) continue;
    rows.push({hourStart, attempt});
  }
  const openJobs = hourlyWorkspaceJobs(store, workspaceId);
  const covered = hourlyRetryLaneHourStarts(openJobs);
  const cap = Number.isInteger(limit) ? limit : hourlyFailureCatchupLimit(env);
  const jobs = [];
  for (const plan of dueFailedHourCatchupPlan({at, rows, openHourStarts: covered, limit: cap, windowHours: span})) {
    if (covered.has(plan.hourStart)) continue;
    const parked = openJobs.filter((job) => job.status === 'queued' && job.input?.hourStart === plan.hourStart && job.priority < plan.priority);
    if (parked.length) {
      const promoted = promoteParkedHourJobs(store, workspaceId, parked, plan.priority, at);
      for (const job of promoted) {
        covered.add(plan.hourStart);
        jobs.push(job);
      }
      continue;
    }
    const job = store.createJob({
      type: 'report.hourly.extract',
      workspaceId,
      priority: plan.priority,
      maxAttempts: 2,
      availableAt: at,
      input: {workspaceId, hourStart: plan.hourStart},
    });
    covered.add(plan.hourStart);
    jobs.push(job);
  }
  return jobs;
}

function hourlyWorkspaceJobs(store, workspaceId) {
  return (store?.listOpenJobs?.('report.hourly.extract') || []).filter((job) => job?.workspaceId === workspaceId && !job.input?.snapshotId && job.input?.mode !== 'rewrite');
}

// The backfill lane claims priority -1. A running hour, or a queued job already at
// -1 or higher, is covered. A queued -5 job is not: other work keeps that lane from running.
export function hourlyRetryLaneHourStarts(jobs) {
  const hours = new Set();
  for (const job of jobs || []) {
    const hourStart = job?.input?.hourStart;
    if (!Number.isFinite(hourStart)) continue;
    if (job.status === 'running' || (job.status === 'queued' && Number(job.priority) >= -1)) hours.add(hourStart);
  }
  return hours;
}

function promoteParkedHourJobs(store, workspaceId, jobs, priority, at) {
  const changes = jobs.map((job) => ({id: job.id, priority, expectedPriority: job.priority}));
  const changed = new Set(store.reprioritizeQueuedJobs?.(workspaceId, changes) || []);
  const late = jobs.filter((job) => changed.has(job.id) && Number(job.availableAt) > at);
  if (late.length && store.rescheduleQueuedJobs) {
    store.rescheduleQueuedJobs(workspaceId, late.map((job) => ({id: job.id, availableAt: at, expectedAvailableAt: job.availableAt})));
  }
  return jobs.filter((job) => changed.has(job.id)).map((job) => ({...job, priority, availableAt: Math.min(Number(job.availableAt) || at, at)}));
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
export function createInformationTreeJobHandlers(service,{candidates,refreshMinute=null,env=process.env}={}) {
  return {[TREE_PREPARE_JOB_TYPE]:async(raw,context)=>{
    const input=PrepareTreeInformationInputSchema.parse(raw),result=await service.prepareInformation(input);
    enqueuePreparedHourRefreshes(context?.store,service,input.workspaceId,result.nodes,Date.now(),{minute:refreshMinute,env});
    await prioritizeRecentTreePreparation(context?.store,candidates,input.workspaceId);
    const retry=result.pending.filter(p=>p.retryable);
    if(retry.length && (!input.catchup || retry.some(p=>p.reason==='budget-deferred')) && context?.store?.createJob)context.store.createJob({type:TREE_PREPARE_JOB_TYPE,workspaceId:input.workspaceId,maxAttempts:1,availableAt:Math.min(...retry.map(p=>p.retryAt || Date.now()+30*60000)),input:{workspaceId:input.workspaceId,sourceIds:retry.map(p=>p.id),catchup:true}});
    return {prepared:result.nodes.length,pending:result.pending,calls:result.calls,cacheHits:result.cacheHits};
  }};
}
