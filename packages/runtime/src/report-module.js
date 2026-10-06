import { parseContract, GenerateDailyBriefInputSchema, GenerateDailyReportInputSchema } from '../../contracts/src/index.js';
import { dailySlotOnInstant } from '../../domain/src/zoned-time.js';
import {GenerateHourlyDigestInputSchema} from '../../contracts/src/report.js';

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

export function createReportJobHandlers({ reportService, briefService = null, informationService=null }) {
  if (!reportService?.generateDailyReport) throw new Error('daily report jobs require reportService');
  return {
    [REPORT_HOURLY_JOB_TYPE]: async rawInput => {
      if(!informationService) throw new Error('小时摘选服务未配置');
      const digests=await informationService.generateHourlyDigests(parseContract(GenerateHourlyDigestInputSchema,rawInput || {}));
      const failed=(rawInput?.hourStart!==undefined ? digests : digests.slice(0,1)).filter(d=>d.editorial?.status==='failed');
      if(failed.length) throw new Error(`${failed.length} 个小时主题整理未完成；提炼底稿已保存，可继续重试。`);
      return {snapshotIds:digests.map(d=>d.id),itemCount:digests.reduce((s,d)=>s+d.items.length,0),
        backgroundIncomplete:rawInput?.hourStart===undefined ? digests.slice(1).filter(d=>d.editorial?.status==='failed').map(d=>d.window.startAt) : []};
    },
    [REPORT_DAILY_JOB_TYPE]: async (rawInput, context) => {
      const input = parseContract(GenerateDailyReportInputSchema, rawInput || {});
      if(!input.requestKey && context?.job?.id) input.requestKey=context.job.id;
      const report = await reportService.generateDailyReport(input);
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
    minute: config.cutoffMinute,
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
      minute: config.cutoffMinute,
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

export function ensureHourlyDigestSchedule(store,now=Date.now()) {
  return store.upsertJobSchedule({workspaceId:'local',key:'report.hourly.default',jobType:REPORT_HOURLY_JOB_TYPE,
    enabled:true,schedule:{kind:'interval',intervalMinutes:60},input:{},priority:0,maxAttempts:2,
    nextRunAt:(Math.floor(now/3600000)+1)*3600000});
}
