import { parseContract, GenerateDailyBriefInputSchema, GenerateDailyReportInputSchema } from '../../contracts/src/index.js';
import { dailySlotOnInstant } from '../../domain/src/zoned-time.js';

export const REPORT_DAILY_JOB_TYPE = 'report.daily.generate';
export const REPORT_DAILY_BRIEF_JOB_TYPE = 'report.daily.brief.generate';
export const DAILY_REPORT_SCHEDULE_KEY = 'report.daily.default';

export const reportDailyManifest = Object.freeze({
  id: 'report.daily',
  version: '1.0.0',
  capabilities: ['report.daily.generate', 'report.daily.brief.generate'],
  jobTypes: [REPORT_DAILY_JOB_TYPE, REPORT_DAILY_BRIEF_JOB_TYPE],
});

export function createReportJobHandlers({ reportService, briefService = null }) {
  if (!reportService?.generateDailyReport) throw new Error('daily report jobs require reportService');
  return {
    [REPORT_DAILY_JOB_TYPE]: async (rawInput, context) => {
      const input = parseContract(GenerateDailyReportInputSchema, rawInput || {});
      const report = await reportService.generateDailyReport(input);
      context?.store?.createJob?.({
        type: REPORT_DAILY_BRIEF_JOB_TYPE,
        workspaceId: report.workspaceId,
        maxAttempts: 2,
        input: { workspaceId: report.workspaceId, reportId: report.id },
      });
      return { reportId: report.id, reportDate: report.reportDate, status: report.status };
    },
    [REPORT_DAILY_BRIEF_JOB_TYPE]: async (rawInput) => {
      if (!briefService?.generateDailyBrief) throw new Error('daily brief jobs require briefService');
      const input = parseContract(GenerateDailyBriefInputSchema, rawInput || {});
      const brief = await briefService.generateDailyBrief(input);
      return { briefId: brief.id, reportId: brief.reportId, reportDate: brief.reportDate };
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
