import { parseContract, GenerateDailyBriefInputSchema, GenerateDailyReportInputSchema } from '../../contracts/src/index.js';
import { dailySlotOnInstant, zonedLocalToUtc } from '../../domain/src/zoned-time.js';
import {GenerateHourlyDigestInputSchema} from '../../contracts/src/report.js';
import {resolveDailyConfig,resolveDailyWindow,resolveReportDate} from '../../domain/src/daily-window.js';
import {condenseJobFailure, describeCondenseFailure, isTerminalPendingReason} from '../../domain/src/information-tree-policy.js';
import {enqueueDueFailedHourRefreshes} from './information-tree-module.js';

export const REPORT_DAILY_JOB_TYPE = 'report.daily.generate';
export const REPORT_DAILY_BRIEF_JOB_TYPE = 'report.daily.brief.generate';
export const REPORT_HOURLY_JOB_TYPE = 'report.hourly.extract';
export const HOURLY_FAILURE_CATCHUP_JOB_TYPE = 'report.hourly.failure-catchup';
export const DAILY_REPORT_SCHEDULE_KEY = 'report.daily.default';
export const DAILY_REPORT_CATCHUP_KEY = 'report.daily.catchup';
export const HOURLY_FAILURE_CATCHUP_KEY = 'report.hourly.failure-catchup';
export const DAILY_BRIEF_CATCHUP_DELAY_MS = 30 * 60 * 1000;

export function dailyRunAt(reportDate, config) {
  const match = String(reportDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !config?.timezone) return null;
  const runMinute = config.runMinute ?? config.cutoffMinute;
  return zonedLocalToUtc(Number(match[1]), Number(match[2]), Number(match[3]), config.cutoffHour, runMinute, config.timezone);
}

export function dailyCatchupAllowed(now, config) {
  const reportDate = resolveReportDate(now, config);
  const runAt = dailyRunAt(reportDate, config);
  return Number.isFinite(runAt) && now >= runAt;
}

export function scheduleDailyBriefCatchup(store, input, job, now = Date.now()) {
  if (input?.catchup === true) return null;
  if (!job || job.attemptCount < job.maxAttempts) return null;
  if (!store?.createJob || !store?.listOpenJobs) return null;
  const reportId = String(input?.reportId || '').trim();
  if (!reportId) return null;
  const open = store.listOpenJobs(REPORT_DAILY_BRIEF_JOB_TYPE) || [];
  if (open.some((item) => item.id !== job.id && item.input?.reportId === reportId)) return null;
  return store.createJob({
    type: REPORT_DAILY_BRIEF_JOB_TYPE,
    workspaceId: input.workspaceId || job.workspaceId || 'local',
    maxAttempts: 2,
    availableAt: now + DAILY_BRIEF_CATCHUP_DELAY_MS,
    input: {
      workspaceId: input.workspaceId || 'local',
      reportId,
      catchup: true,
      ...(input.sourceReportUpdatedAt!==undefined ? {sourceReportUpdatedAt:input.sourceReportUpdatedAt} : {}),
      ...(input.mode ? {mode:input.mode} : {}),
      ...(input.requestKey ? {requestKey:input.requestKey} : {}),
    },
  });
}

export const reportDailyManifest = Object.freeze({
  id: 'report.daily',
  version: '1.0.0',
  capabilities: ['report.daily.generate', 'report.daily.brief.generate', REPORT_HOURLY_JOB_TYPE, HOURLY_FAILURE_CATCHUP_JOB_TYPE],
  jobTypes: [REPORT_DAILY_JOB_TYPE, REPORT_DAILY_BRIEF_JOB_TYPE, REPORT_HOURLY_JOB_TYPE, HOURLY_FAILURE_CATCHUP_JOB_TYPE],
});

function rememberReportFailure(error, source) {
  if (!(error instanceof Error) || error.reportFailure) return error;
  const diagnostics = source?.condenseDiagnostics || [];
  const failures = source?.groupFailures || [];
  error.reportFailure = condenseJobFailure(error.message, {
    diagnostics: diagnostics.length || failures.length ? diagnostics : [describeCondenseFailure(error)],
    failures,
  });
  return error;
}

export function hourlyReportDisabled(env = process.env) {
  return String(env?.AI_CENTER_HOURLY_DISABLED ?? '') === '1';
}

const HOUR_MS = 3600000;
const HOURLY_FOLLOW_UP_DELAY_MS = 60_000;
const DEFERRED_CLASSIFICATION = new Set(['classification-failed', 'budget-deferred']);

// Before this hour's slot, wait for the slot. Once the slot has passed, the next prepare
// refresh is one minute out so a partial hour is picked up inside the hour.
export function hourlyRefreshAvailableAt(at, minute) {
  if (minute === null || minute === undefined) return at + HOURLY_FOLLOW_UP_DELAY_MS;
  const slot = Math.floor(at / HOUR_MS) * HOUR_MS + minute * 60_000;
  return at >= slot ? at + HOURLY_FOLLOW_UP_DELAY_MS : slot;
}

export function classificationDeferredCount(saved) {
  const items = saved?.snapshot?.items;
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => sum + (DEFERRED_CLASSIFICATION.has(item?.disposition) ? 1 : 0), 0);
}

// The scheduled run condenses the latest hour and then one older backfill hour.
// The 60s follow-up belongs to the hour this run was for: an explicit hourStart, otherwise the first digest.
// A backfill hour that still has old classification failures must not replace that target.
const HOURLY_FOLLOW_UP_REASONS = new Set(['classification-deferred', 'edition-pending', 'edition-pending-sweep']);

export function actionablePendingCount(digest) {
  if (Array.isArray(digest?.pending)) return digest.pending.filter((item) => !isTerminalPendingReason(item?.reason)).length;
  return Array.isArray(digest?.pendingIds) ? digest.pendingIds.length : 0;
}

export function hourlyFollowUpPlan({requestedHour, digests, deferredByStart = new Map(), followUp} = {}) {
  if (HOURLY_FOLLOW_UP_REASONS.has(followUp)) return null;
  const primary = Number.isFinite(requestedHour) ? requestedHour : digests?.[0]?.window?.startAt;
  if (!Number.isFinite(primary)) return null;
  const digest = (digests || []).find((item) => item?.window?.startAt === primary) || null;
  const deferred = Number(deferredByStart.get(primary) || 0);
  const pendingCount = actionablePendingCount(digest);
  if (deferred > 0) return {hourStart: primary, reason: 'classification-deferred', pendingCount, deferred};
  if (pendingCount > 0) return {hourStart: primary, reason: 'edition-pending', pendingCount, deferred: 0};
  return null;
}

function boundedHourlyInt(value, fallback, min, max) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  const raw = Number(text);
  if (!Number.isInteger(raw) || raw < min || raw > max) return fallback;
  return raw;
}

export function hourlySweepHours(env = process.env) {
  return boundedHourlyInt(env?.AI_CENTER_HOURLY_SWEEP_HOURS, 6, 0, 24);
}

export function hourlySweepLimit(env = process.env) {
  return boundedHourlyInt(env?.AI_CENTER_HOURLY_SWEEP_LIMIT, 2, 0, 6);
}

export function hourlyFailureCatchupMinutes(env = process.env) {
  return boundedHourlyInt(env?.AI_CENTER_HOURLY_FAILURE_CATCHUP_MINUTES, 10, 5, 60);
}

export function hourlyFailureCatchupLimit(env = process.env) {
  return boundedHourlyInt(env?.AI_CENTER_HOURLY_FAILURE_CATCHUP_LIMIT, 2, 1, 4);
}

export function hourlyRunningSameVersion(jobs, current = {}) {
  const hour = current.hourStart;
  const workspace = current.workspaceId || 'local';
  return (jobs || []).some((job) => {
    if (job?.type && job.type !== REPORT_HOURLY_JOB_TYPE) return false;
    if (job?.status && job.status !== 'running') return false;
    if (current.id && job?.id === current.id) return false;
    if ((job?.workspaceId || 'local') !== workspace) return false;
    const other = job?.input?.hourStart;
    if (!Number.isFinite(Number(hour)) || !Number.isFinite(Number(other))) return true;
    return Number(other) === Number(hour);
  });
}

export function hourlyOpenHourStarts(store, workspaceId = 'local') {
  const open = store?.listOpenJobs?.(REPORT_HOURLY_JOB_TYPE) || [];
  const hours = new Set();
  for (const job of open) {
    if (job?.workspaceId !== workspaceId) continue;
    if (job.status !== 'queued' && job.status !== 'running') continue;
    const hourStart = job.input?.hourStart;
    if (!Number.isFinite(hourStart) || job.input?.snapshotId || job.input?.mode === 'rewrite') continue;
    hours.add(hourStart);
  }
  return hours;
}

// Scheduled runs only. The primary hour keeps its own follow-up. Eligible older hours inside
// the window rotate with the primary hour, so a limit of 2 does not always take the two newest.
// Hours older than the window are never selected. Follow-ups do not chain.
export function hourlyPendingSweepPlan({scheduled = false, followUp, primaryHour, rows = [], openHourStarts = new Set(), windowHours = 6, limit = 2} = {}) {
  if (!scheduled || HOURLY_FOLLOW_UP_REASONS.has(followUp)) return [];
  if (!Number.isFinite(primaryHour)) return [];
  const span = boundedHourlyInt(windowHours, 6, 0, 24);
  const cap = boundedHourlyInt(limit, 2, 0, 6);
  if (!span || !cap) return [];
  const oldest = primaryHour - (span - 1) * HOUR_MS;
  const byStart = new Map();
  for (const row of rows) {
    const hourStart = row?.hourStart;
    if (Number.isFinite(hourStart)) byStart.set(hourStart, row);
  }
  const eligible = [];
  for (let at = primaryHour - HOUR_MS; at >= oldest; at -= HOUR_MS) {
    if (openHourStarts.has(at)) continue;
    const row = byStart.get(at);
    if (!row) continue;
    const pendingCount = Math.max(0, Number(row.pendingCount) || 0);
    const deferred = Math.max(0, Number(row.deferred) || 0);
    if (pendingCount <= 0 && deferred <= 0) continue;
    eligible.push({hourStart: at, reason: 'edition-pending-sweep', pendingCount, deferred});
  }
  if (!eligible.length) return [];
  const offset = Math.floor(primaryHour / HOUR_MS) % eligible.length;
  return eligible.slice(offset).concat(eligible.slice(0, offset)).slice(0, cap);
}

function hourlySweepRows({informationService, readingHour, workspaceId, primary, windowHours}) {
  const oldest = primary - (windowHours - 1) * HOUR_MS;
  const endAt = primary + HOUR_MS;
  const listed = typeof informationService?.list === 'function' ? informationService.list(workspaceId, {startAt: oldest, endAt}) : null;
  const slots = Array.isArray(listed?.hours) ? listed.hours : [];
  const rows = [];
  const seen = new Set();
  const deferredFor = (startAt) => {
    if (!readingHour?.enabled || typeof readingHour.forWindow !== 'function') return 0;
    return classificationDeferredCount(readingHour.forWindow(workspaceId, {startAt, endAt: startAt + HOUR_MS}, 'hour'));
  };
  for (const slot of slots) {
    const edition = slot?.edition;
    const startAt = edition?.window?.startAt;
    if (!Number.isFinite(startAt) || startAt < oldest || startAt > primary) continue;
    seen.add(startAt);
    rows.push({
      hourStart: startAt,
      pendingCount: actionablePendingCount(edition),
      deferred: deferredFor(startAt),
    });
  }
  if (!slots.length && typeof informationService?.published === 'function') {
    for (let at = oldest; at <= primary; at += HOUR_MS) {
      const edition = informationService.published(workspaceId, 'hourly', {startAt: at, endAt: at + HOUR_MS});
      if (!edition) continue;
      seen.add(at);
      rows.push({
        hourStart: at,
        pendingCount: actionablePendingCount(edition),
        deferred: deferredFor(at),
      });
    }
  }
  if (readingHour?.enabled && typeof readingHour.forWindow === 'function') {
    for (let at = oldest; at <= primary; at += HOUR_MS) {
      if (seen.has(at)) continue;
      const deferred = deferredFor(at);
      if (deferred > 0) rows.push({hourStart: at, pendingCount: 0, deferred});
    }
  }
  return rows;
}

const INFORMATION_PREPARE_JOB_TYPE = 'report.information.prepare';
const FOLLOW_UP_PREP_PRIORITY = 10;
const CURRENT_HOUR_PREP_PRIORITY = 30;

export function formatHourlyPendingBreakdown({hourStart, followUp, pending = [], prep = {}} = {}) {
  const counts = new Map();
  for (const item of pending) {
    const reason = String(item?.reason || 'unknown');
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  const reasons = [...counts.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([reason, count]) => `${reason}=${count}`).join(' ');
  return `[worker] hourly-pending hourStart=${hourStart} followUp=${followUp} pending=${pending.length}${reasons ? ` ${reasons}` : ''} queued=${prep.queued || 0} running=${prep.running || 0} missing=${prep.missing || 0} enqueued=${prep.enqueued || 0} prioritized=${prep.prioritized || 0}`;
}

function preparationItems(digest) {
  if (Array.isArray(digest?.pending)) return digest.pending;
  return (Array.isArray(digest?.pendingIds) ? digest.pendingIds : []).map((id) => ({id, reason: 'information-not-ready', retryable: false}));
}

// Admit one preparation job per source that is still actionable. Follow-ups stay at priority 10,
// below the current hour's 20/30, so they cannot delay it. Already queued work is only raised
// up to that same ceiling. The worker's informationPreparationLimit still bounds how many run.
export function enqueueHourlyPendingPreparation(store, {workspaceId = 'local', digests = [], followUp} = {}) {
  const stats = {enqueued: 0, prioritized: 0, queued: 0, running: 0, missing: 0};
  if (!store?.createJob || !store?.listOpenJobs) return stats;
  const open = (store.listOpenJobs(INFORMATION_PREPARE_JOB_TYPE) || []).filter((job) => job?.workspaceId === workspaceId && (job.status === 'queued' || job.status === 'running'));
  const running = new Set();
  const queued = new Map();
  for (const job of open) {
    for (const id of job.input?.sourceIds || []) {
      if (job.status === 'running') running.add(id);
      else if (!queued.has(id)) queued.set(id, job);
    }
  }
  const bumps = new Map();
  const seen = new Set();
  digests.forEach((digest, index) => {
    const priority = followUp ? FOLLOW_UP_PREP_PRIORITY : (index === 0 ? CURRENT_HOUR_PREP_PRIORITY : FOLLOW_UP_PREP_PRIORITY);
    for (const item of preparationItems(digest)) {
      if (!item?.id || seen.has(item.id) || isTerminalPendingReason(item.reason)) continue;
      const needsPrep = item.reason === 'information-not-ready' || item.retryable === true || item.reason == null || item.reason === '';
      if (!needsPrep) continue;
      seen.add(item.id);
      if (running.has(item.id)) { stats.running += 1; continue; }
      const queuedJob = queued.get(item.id);
      if (queuedJob) {
        stats.queued += 1;
        if (Number(queuedJob.priority) < priority) {
          const next = Math.max(bumps.get(queuedJob.id) || 0, priority);
          bumps.set(queuedJob.id, next);
        }
        continue;
      }
      stats.missing += 1;
      const availableAt = item.retryable === true && Number(item.retryAt) > Date.now() ? item.retryAt : Date.now();
      store.createJob({
        type: INFORMATION_PREPARE_JOB_TYPE,
        workspaceId,
        priority,
        maxAttempts: 1,
        availableAt,
        input: {workspaceId, sourceIds: [item.id]},
      });
      stats.enqueued += 1;
    }
  });
  if (store.prioritizeQueuedJobs && bumps.size) {
    const byPriority = new Map();
    for (const [id, priority] of bumps) {
      const ids = byPriority.get(priority) || [];
      ids.push(id);
      byPriority.set(priority, ids);
    }
    for (const [priority, ids] of byPriority) stats.prioritized += store.prioritizeQueuedJobs(workspaceId, ids, priority).length;
  }
  return stats;
}

export function enqueueHourlyExtractFollowUp(store, {workspaceId = 'local', hourStart, availableAt, reason = 'classification-deferred', priority = 10, env = process.env} = {}) {
  if (hourlyReportDisabled(env) || !store?.createJob || !store?.listOpenJobs || !Number.isFinite(hourStart)) return null;
  if (hourlyOpenHourStarts(store, workspaceId).has(hourStart)) return null;
  const job = store.createJob({
    type: REPORT_HOURLY_JOB_TYPE,
    workspaceId,
    priority,
    maxAttempts: 2,
    availableAt,
    input: {workspaceId, hourStart, followUp: reason},
  });
  console.log(`[worker] reading-class follow-up hourStart=${hourStart} reason=${reason} availableAt=${availableAt}`);
  return job;
}

// Hold a short reading-classification remainder while this hour can still gain information nodes.
// Terminal content failures do not keep the last items unclassified.
export function hourlyReadingFlushRemainder(digest) {
  if (!digest || typeof digest !== 'object') return true;
  const pending = Array.isArray(digest.pending) ? digest.pending : null;
  const ids = Array.isArray(digest.pendingIds) ? digest.pendingIds : null;
  if (!pending && !ids) return true;
  if ((pending?.length || 0) === 0 && (ids?.length || 0) === 0) return true;
  if (pending?.length) {
    const stillComing = pending.some((item) => {
      const reason = item?.reason;
      return item?.retryable === true || reason === 'information-not-ready' || reason == null || reason === '';
    });
    return !stillComing;
  }
  return false;
}

const HOURLY_SCHEDULE_JOB_TYPES = new Set([REPORT_HOURLY_JOB_TYPE, HOURLY_FAILURE_CATCHUP_JOB_TYPE]);

export function allowHourlyScheduleEnqueue(schedule, env = process.env) {
  return !(HOURLY_SCHEDULE_JOB_TYPES.has(schedule?.jobType) && hourlyReportDisabled(env));
}

export function releaseOpenHourlyJobs(store, env = process.env, now = Date.now()) {
  if (!hourlyReportDisabled(env) || !store?.cancelOpenJobs) return 0;
  let released = 0;
  for (const type of HOURLY_SCHEDULE_JOB_TYPES) released += store.cancelOpenJobs(type, {status: 'skipped', reason: 'hourly-disabled'}, now);
  return released;
}

export function createReportJobHandlers({ reportService, briefService = null, informationService=null, treeService=null, readingHour=null, beforeHourly=null, dailyConfig=resolveDailyConfig(), env=process.env }) {
  if (!reportService?.generateDailyReport) throw new Error('daily report jobs require reportService');
  return {
    [HOURLY_FAILURE_CATCHUP_JOB_TYPE]: async (_raw, context) => {
      if (hourlyReportDisabled(env)) return {status:'skipped', reason:'hourly-disabled'};
      const service = treeService || informationService;
      const jobs = enqueueDueFailedHourRefreshes(context?.store, service, 'local', Date.now(), {env});
      if (jobs.length) console.log(`[worker] hourly-failure-catchup enqueued=${jobs.length} hours=${jobs.map((job) => job.input?.hourStart).join(',')}`);
      return {status:'catchup', enqueued:jobs.length, hours:jobs.map((job) => job.input?.hourStart)};
    },
    [REPORT_HOURLY_JOB_TYPE]: async (rawInput,context) => {
      if (hourlyReportDisabled(env)) return {status:'skipped', reason:'hourly-disabled'};
      if(!informationService) throw new Error('小时摘选服务未配置');
      const input=parseContract(GenerateHourlyDigestInputSchema,rawInput || {});
      const workspaceIdEarly = input.workspaceId || 'local';
      const openHourly = context?.store?.listOpenJobs?.(REPORT_HOURLY_JOB_TYPE) || [];
      if (hourlyRunningSameVersion(openHourly, { id: context?.job?.id, workspaceId: workspaceIdEarly, hourStart: input.hourStart })) {
        return { status: 'skipped', reason: 'already-running' };
      }
      await beforeHourly?.(input,context);
      const digests=await informationService.generateHourlyDigests(input);
      const hourMs=3600000;
      const windows=input.hourStart!==undefined ? [{startAt:input.hourStart,endAt:input.hourStart+hourMs}] : digests.map(item=>item?.window).filter(item=>Number.isFinite(item?.startAt) && Number.isFinite(item?.endAt));
      const readingErrors=[];
      let classificationDeferred=0;
      const deferredByStart=new Map();
      if(readingHour?.enabled) {
        for(const window of windows) {
          const digest=(digests || []).find(item=>item?.window?.startAt===window.startAt) || null;
          try {
            const saved=await readingHour.scoreWindow({workspace: input.workspaceId || 'local', window, flushRemainder: hourlyReadingFlushRemainder(digest)});
            if(saved?.readingErrors?.length) readingErrors.push(...saved.readingErrors.map(error=>({...error,window})));
            const deferred=classificationDeferredCount(saved);
            classificationDeferred+=deferred;
            deferredByStart.set(window.startAt, deferred);
          }
          catch(error) {readingErrors.push({window,reason:String(error?.message || error).slice(0,180)});}
        }
      }
      const workspaceId=input.workspaceId || 'local';
      const followUpPlan=hourlyFollowUpPlan({requestedHour:input.hourStart,digests,deferredByStart,followUp:input.followUp});
      if(followUpPlan) enqueueHourlyExtractFollowUp(context?.store,{workspaceId,hourStart:followUpPlan.hourStart,availableAt:Date.now()+HOURLY_FOLLOW_UP_DELAY_MS,reason:followUpPlan.reason,env});
      let prepStats={enqueued:0,prioritized:0,queued:0,running:0,missing:0};
      try {
        prepStats=enqueueHourlyPendingPreparation(context?.store,{workspaceId,digests,followUp:input.followUp});
      } catch { /* admitting preparation must not fail or delay the hour */ }
      if(input.followUp) {
        const hourStart=Number.isFinite(input.hourStart) ? input.hourStart : digests?.[0]?.window?.startAt;
        const digest=(digests || []).find(item=>item?.window?.startAt===hourStart) || digests?.[0] || {};
        const pending=Array.isArray(digest.pending) ? digest.pending : (Array.isArray(digest.pendingIds) ? digest.pendingIds.map(id=>({id,reason:'information-not-ready'})) : []);
        console.log(formatHourlyPendingBreakdown({hourStart,followUp:input.followUp,pending,prep:prepStats}));
      }
      const primaryHour=Number.isFinite(input.hourStart) ? input.hourStart : digests?.[0]?.window?.startAt;
      const windowHours=hourlySweepHours(env);
      const sweepLimit=hourlySweepLimit(env);
      const scheduled=input.hourStart===undefined && !input.followUp && Number.isFinite(primaryHour) && windowHours>0 && sweepLimit>0;
      if(scheduled) {
        try {
          const openHourStarts=hourlyOpenHourStarts(context?.store, workspaceId);
          if(followUpPlan) openHourStarts.add(followUpPlan.hourStart);
          const sweeps=hourlyPendingSweepPlan({
            scheduled:true, followUp:input.followUp, primaryHour, windowHours, openHourStarts,
            rows:hourlySweepRows({informationService, readingHour, workspaceId, primary:primaryHour, windowHours}),
            limit:sweepLimit,
          });
          for(const plan of sweeps) enqueueHourlyExtractFollowUp(context?.store,{workspaceId,hourStart:plan.hourStart,availableAt:Date.now()+HOURLY_FOLLOW_UP_DELAY_MS,reason:plan.reason,priority:-5,env});
        } catch { /* a sweep lookup must not delay or fail the current hour */ }
      }
      if(treeService) {
        if(digests[0]?.status==='failed' && !digests[0].terminal && digests[0].groupFailures?.some(p=>p.retryable)) {
          const failures=digests[0].groupFailures;
          console.error(`[worker] 小时浓缩临时失败 groups=${failures.length} retryable=${failures.filter(p=>p.retryable).length} ${failures.map(p=>`tag=${p.tagId ?? 'null'} reason=${p.reason} queueMs=${p.queueMs ?? '-'} executionMs=${p.executionMs ?? '-'}`).join('; ')}`);
          throw rememberReportFailure(new Error('小时浓缩临时失败；成功分类及检查点已保留'), digests[0]);
        }
        const main=digests[0];
        return {snapshotIds:digests.map(d=>d.id),editionId:main?.id,status:main?.status,published:main?.published===true,
          window:main?.window,pendingCount:main?.pendingIds.length || 0,groupFailureCount:main?.groupFailures?.length || 0,
          readingFailed:readingErrors.length>0,readingErrors,classificationDeferred,
          backgroundIncomplete:digests.slice(1).filter(d=>d.status!=='ready').map(d=>d.window.startAt)};
      }
      const failed=(rawInput?.hourStart!==undefined ? digests : digests.slice(0,1)).filter(d=>d.editorial?.status==='failed');
      if(failed.length) throw new Error(`${failed.length} 个小时主题整理未完成；提炼底稿已保存，可继续重试。`);
      return {snapshotIds:digests.map(d=>d.id),itemCount:digests.reduce((s,d)=>s+d.items.length,0),
        readingFailed:readingErrors.length>0,readingErrors,classificationDeferred,
        backgroundIncomplete:rawInput?.hourStart===undefined ? digests.slice(1).filter(d=>d.editorial?.status==='failed').map(d=>d.window.startAt) : []};
    },
    [REPORT_DAILY_JOB_TYPE]: async (rawInput, context) => {
      const input = parseContract(GenerateDailyReportInputSchema, rawInput || {});
      if(treeService) {
        try {
          const reportDate=input.reportDate || resolveReportDate(Date.now(),dailyConfig);
          const window=resolveDailyWindow({reportDate,...dailyConfig});
          if(input.scheduleKey===DAILY_REPORT_CATCHUP_KEY) {
            if(!dailyCatchupAllowed(Date.now(), dailyConfig)) return {status:'skipped', reason:'before-run', reportDate};
            const published=treeService.published?.(input.workspaceId || 'local', 'daily', window);
            if(published && published.status!=='failed') return {status:'skipped', reason:'published', reportDate, editionId:published.id};
          }
          const edition=await treeService.generateDaily({workspaceId:input.workspaceId || 'local',window:{startAt:window.startAt,endAt:window.endAt}});
          if(edition.status==='failed') throw rememberReportFailure(new Error('日报浓缩树生成失败，旧刊期继续可读'), edition);
          return {editionId:edition.id,reportDate,status:edition.status};
        } catch (error) {
          throw rememberReportFailure(error);
        }
      }
      if(!input.requestKey && context?.job?.id) input.requestKey=context.job.id;
      let report;
      try {
        report = await reportService.generateDailyReport(input);
      } catch (error) {
        throw rememberReportFailure(error);
      }
      context?.store?.createJob?.({
        type: REPORT_DAILY_BRIEF_JOB_TYPE,
        workspaceId: report.workspaceId,
        maxAttempts: 2,
        input: { workspaceId: report.workspaceId, reportId: report.id,
          ...(report.content?.schemaVersion===2 ? {sourceReportUpdatedAt:report.updatedAt} : {}) },
      });
      return { reportId: report.id, reportDate: report.reportDate, status: report.status };
    },
    [REPORT_DAILY_BRIEF_JOB_TYPE]: async (rawInput, context) => {
      if(treeService) return {status:'superseded',reason:'tree-v3 replaces legacy editorial; daily job reads only saved hourly modules'};
      if (!briefService?.generateDailyBrief) throw new Error('daily brief jobs require briefService');
      const input = parseContract(GenerateDailyBriefInputSchema, rawInput || {});
      try {
        const brief = await briefService.generateDailyBrief(input);
        return { briefId: brief.id, reportId: brief.reportId, reportDate: brief.reportDate };
      } catch (error) {
        scheduleDailyBriefCatchup(context?.store, input, context?.job);
        throw error;
      }
    },
  };
}

export function ensureDailyReportSchedule(store, config, now = Date.now()) {
  const nextRunAt = dailySlotOnInstant(now, {
    timeZone: config.timezone,
    hour: config.cutoffHour,
    minute: config.runMinute ?? config.cutoffMinute,
  });
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: DAILY_REPORT_SCHEDULE_KEY,
    jobType: REPORT_DAILY_JOB_TYPE,
    enabled: true,
    schedule: {
      kind: 'daily',
      timezone: config.timezone,
      hour: config.cutoffHour,
      minute: config.runMinute ?? config.cutoffMinute,
    },
    input: {
      timezone: config.timezone,
      cutoffHour: config.cutoffHour,
      cutoffMinute: config.cutoffMinute,
    },
    priority: 0,
    maxAttempts: 2,
    nextRunAt,
  });
}

export function ensureDailyReportCatchupSchedule(store, config, now = Date.now()) {
  const minutes = Number.isInteger(config.catchupIntervalMinutes) ? config.catchupIntervalMinutes : 120;
  const prior = store.getJobSchedule?.('local', DAILY_REPORT_CATCHUP_KEY);
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: DAILY_REPORT_CATCHUP_KEY,
    jobType: REPORT_DAILY_JOB_TYPE,
    enabled: true,
    schedule: { kind: 'interval', intervalMinutes: minutes },
    input: {
      timezone: config.timezone,
      cutoffHour: config.cutoffHour,
      cutoffMinute: config.cutoffMinute,
    },
    priority: 0,
    maxAttempts: 1,
    nextRunAt: !prior && dailyCatchupAllowed(now, config) ? now : now + minutes * 60_000,
  });
}

export function ensureHourlyFailureCatchupSchedule(store, now = Date.now(), {env = process.env} = {}) {
  if (hourlyReportDisabled(env)) return store.getJobSchedule?.('local', HOURLY_FAILURE_CATCHUP_KEY) || null;
  const minutes = hourlyFailureCatchupMinutes(env);
  const prior = store.getJobSchedule?.('local', HOURLY_FAILURE_CATCHUP_KEY);
  const sameInterval = prior?.schedule?.kind === 'interval' && prior.schedule.intervalMinutes === minutes;
  return store.upsertJobSchedule({
    resetNextRunAt: !sameInterval,
    workspaceId: 'local',
    key: HOURLY_FAILURE_CATCHUP_KEY,
    jobType: HOURLY_FAILURE_CATCHUP_JOB_TYPE,
    enabled: true,
    schedule: {kind: 'interval', intervalMinutes: minutes},
    input: {},
    priority: 0,
    maxAttempts: 1,
    nextRunAt: now,
  });
}

export function ensureHourlyDigestSchedule(store,now=Date.now(),{minute=0,env=process.env}={}) {
  if (hourlyReportDisabled(env)) return store.getJobSchedule?.('local', 'report.hourly.default') || null;
  if(!Number.isInteger(minute) || minute<0 || minute>59)throw new Error("invalid hourly schedule minute");
  const prior=store.getJobSchedule?.('local','report.hourly.default');
  const resetNextRunAt=Boolean(prior && prior.nextRunAt%3600000!==minute*60000);
  return store.upsertJobSchedule({resetNextRunAt,workspaceId:'local',key:'report.hourly.default',jobType:REPORT_HOURLY_JOB_TYPE,
    enabled:true,schedule:{kind:'interval',intervalMinutes:60},input:{},priority:0,maxAttempts:2,
    nextRunAt:Math.floor(now/3600000)*3600000+minute*60000+(now>=Math.floor(now/3600000)*3600000+minute*60000 ? 3600000 : 0)});
}
