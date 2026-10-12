import { parseContract, GenerateDailyBriefInputSchema, GenerateDailyReportInputSchema } from '../../contracts/src/index.js';
import { dailySlotOnInstant } from '../../domain/src/zoned-time.js';
import {GenerateHourlyDigestInputSchema} from '../../contracts/src/report.js';
import {resolveDailyConfig,resolveDailyWindow,resolveReportDate} from '../../domain/src/daily-window.js';
import {condenseJobFailure, describeCondenseFailure} from '../../domain/src/information-tree-policy.js';

export const REPORT_DAILY_JOB_TYPE = 'report.daily.generate';
export const REPORT_DAILY_BRIEF_JOB_TYPE = 'report.daily.brief.generate';
export const REPORT_HOURLY_JOB_TYPE = 'report.hourly.extract';
export const DAILY_REPORT_SCHEDULE_KEY = 'report.daily.default';
export const DAILY_BRIEF_CATCHUP_DELAY_MS = 30 * 60 * 1000;

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
  capabilities: ['report.daily.generate', 'report.daily.brief.generate', REPORT_HOURLY_JOB_TYPE],
  jobTypes: [REPORT_DAILY_JOB_TYPE, REPORT_DAILY_BRIEF_JOB_TYPE, REPORT_HOURLY_JOB_TYPE],
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

export function createReportJobHandlers({ reportService, briefService = null, informationService=null, treeService=null, readingHour=null, beforeHourly=null, dailyConfig=resolveDailyConfig() }) {
  if (!reportService?.generateDailyReport) throw new Error('daily report jobs require reportService');
  return {
    [REPORT_HOURLY_JOB_TYPE]: async (rawInput,context) => {
      if(!informationService) throw new Error('小时摘选服务未配置');
      const input=parseContract(GenerateHourlyDigestInputSchema,rawInput || {});
      await beforeHourly?.(input,context);
      const digests=await informationService.generateHourlyDigests(input);
      const hourMs=3600000;
      const windows=input.hourStart!==undefined ? [{startAt:input.hourStart,endAt:input.hourStart+hourMs}] : digests.map(item=>item?.window).filter(item=>Number.isFinite(item?.startAt) && Number.isFinite(item?.endAt));
      const readingErrors=[];
      if(readingHour?.enabled) {
        for(const window of windows) {
          try {const saved=await readingHour.scoreWindow({workspace: input.workspaceId || 'local', window}); if(saved?.readingErrors?.length) readingErrors.push(...saved.readingErrors.map(error=>({...error,window})));}
          catch(error) {readingErrors.push({window,reason:String(error?.message || error).slice(0,180)});}
        }
      }
      if(treeService) {
        if(digests[0]?.status==='failed' && digests[0].groupFailures?.some(p=>p.retryable)) {
          const failures=digests[0].groupFailures;
          console.error(`[worker] 小时浓缩临时失败 groups=${failures.length} retryable=${failures.filter(p=>p.retryable).length} ${failures.map(p=>`tag=${p.tagId ?? 'null'} reason=${p.reason} queueMs=${p.queueMs ?? '-'} executionMs=${p.executionMs ?? '-'}`).join('; ')}`);
          throw rememberReportFailure(new Error('小时浓缩临时失败；成功分类及检查点已保留'), digests[0]);
        }
        const main=digests[0];
        return {snapshotIds:digests.map(d=>d.id),editionId:main?.id,status:main?.status,published:main?.published===true,
          window:main?.window,pendingCount:main?.pendingIds.length || 0,groupFailureCount:main?.groupFailures?.length || 0,
          readingFailed:readingErrors.length>0,readingErrors,
          backgroundIncomplete:digests.slice(1).filter(d=>d.status!=='ready').map(d=>d.window.startAt)};
      }
      const failed=(rawInput?.hourStart!==undefined ? digests : digests.slice(0,1)).filter(d=>d.editorial?.status==='failed');
      if(failed.length) throw new Error(`${failed.length} 个小时主题整理未完成；提炼底稿已保存，可继续重试。`);
      return {snapshotIds:digests.map(d=>d.id),itemCount:digests.reduce((s,d)=>s+d.items.length,0),
        readingFailed:readingErrors.length>0,readingErrors,
        backgroundIncomplete:rawInput?.hourStart===undefined ? digests.slice(1).filter(d=>d.editorial?.status==='failed').map(d=>d.window.startAt) : []};
    },
    [REPORT_DAILY_JOB_TYPE]: async (rawInput, context) => {
      const input = parseContract(GenerateDailyReportInputSchema, rawInput || {});
      if(treeService) {
        try {
          const reportDate=input.reportDate || resolveReportDate(Date.now(),dailyConfig);
          const window=resolveDailyWindow({reportDate,...dailyConfig});
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

export function ensureHourlyDigestSchedule(store,now=Date.now(),{minute=0}={}) {
  if(!Number.isInteger(minute) || minute<0 || minute>59)throw new Error("invalid hourly schedule minute");
  const prior=store.getJobSchedule?.('local','report.hourly.default');
  const resetNextRunAt=Boolean(prior && prior.nextRunAt%3600000!==minute*60000);
  return store.upsertJobSchedule({resetNextRunAt,workspaceId:'local',key:'report.hourly.default',jobType:REPORT_HOURLY_JOB_TYPE,
    enabled:true,schedule:{kind:'interval',intervalMinutes:60},input:{},priority:0,maxAttempts:2,
    nextRunAt:Math.floor(now/3600000)*3600000+minute*60000+(now>=Math.floor(now/3600000)*3600000+minute*60000 ? 3600000 : 0)});
}
