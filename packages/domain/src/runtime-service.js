import {
  ActiveAgentRunSchema,
  AgentRunStatusViewSchema,
  AgentRunProgressStepSchema,
  ARTICLE_ANALYSIS_JOB_TYPE,
  ArticleAnalysisRunViewSchema,
  ValidationError,
  parseContract,
} from '../../contracts/src/index.js';
import { resolveResearchProfile } from './research-profile.js';

function articleAnalysisQuestion(input = {}) {
  const source = input.source;
  if (source?.type === 'inline') {
    return String(source.title || source.body || '文章分析').replace(/\s+/g, ' ').trim().slice(0, 4_000) || '文章分析';
  }
  if (source?.type === 'reference') return '分析已选材料';
  return String(input.message || '').slice(0, 4_000);
}

function articleAnalysisStage(job) {
  if (job.status === 'queued') return 'queued';
  if (job.status === 'completed') return 'completed';
  if (job.status === 'failed' || job.status === 'cancelled') return 'failed';
  return 'running';
}

function agentRunPhase(job, progress = []) {
  if (job.status === 'queued') return 'queued';
  if (job.status === 'completed') return 'completed';
  if (job.status === 'failed' || job.status === 'cancelled') return 'failed';
  const active = [...progress].reverse().find((step) => step.status === 'active');
  const latest = active || progress.at(-1);
  const event = String(latest?.event || '');
  if (event.startsWith('tool.')) return 'tool';
  if (event.startsWith('evidence.gate.')) return 'evidence';
  if (event.startsWith('model.')) return 'model';
  if (event.startsWith('article.')) return 'model';
  if (event === 'run.completed' || (event === 'harness.status' && latest?.status === 'done')) return 'finalizing';
  return 'starting';
}

export function createRuntimeService({ runtimeRepository, agentProgressPort, restartPort, dailyConfig = null }) {
  if (!runtimeRepository) throw new Error('runtimeRepository is required');

  return Object.freeze({
    getStatus() {
      return runtimeRepository.getRuntimeStatus();
    },
    requestProcessRestart(input = {}) {
      if (!restartPort?.requestRestart) return { requested: false, reason: 'unavailable' };
      return restartPort.requestRestart(input);
    },
    requestHealthcheck(requestedAt = Date.now()) {
      return runtimeRepository.createJob({
        type: 'system.healthcheck',
        input: { requestedAt },
        maxAttempts: 1,
      });
    },
    requestDailyReport(input = {}) {
      const reportDate = input.reportDate || input.date;
      if (reportDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(reportDate))) {
        throw new ValidationError('日报日期必须是 YYYY-MM-DD', ['date']);
      }
      const config = dailyConfig || {};
      return runtimeRepository.createJob({
        type: 'report.daily.generate',
        workspaceId: input.workspaceId || 'local',
        maxAttempts: 2,
        input: {
          ...(reportDate ? { reportDate } : {}),
          ...(config.timezone ? { timezone: config.timezone } : {}),
          ...(Number.isInteger(config.cutoffHour) ? { cutoffHour: config.cutoffHour } : {}),
          ...(Number.isInteger(config.cutoffMinute) ? { cutoffMinute: config.cutoffMinute } : {}),
        },
      });
    },
    requestDailyBrief(input = {}) {
      const reportId = String(input.reportId || '').trim();
      if (!reportId) throw new ValidationError('缺少日报', ['reportId']);
      const workspaceId = input.workspaceId || 'local';
      return runtimeRepository.createJob({
        type: 'report.daily.brief.generate',
        workspaceId,
        maxAttempts: 2,
        input: { workspaceId, reportId },
      });
    },
    requestDividendSnapshot(input = {}) {
      return runtimeRepository.createJob({
        type: 'strategy.cn-dividend.snapshot',
        workspaceId: input.workspaceId || 'local',
        maxAttempts: 2,
        input: {},
      });
    },
    requestAgentRun(input) {
      const researchProfile = resolveResearchProfile(input.researchMode, input.researchProfile);
      return runtimeRepository.createJob({
        type: 'ai.agent.run',
        input: {
          ...input,
          researchMode: researchProfile.mode,
          researchProfile,
        },
        workspaceId: input.workspaceId,
        maxAttempts: 1,
      });
    },
    requestStructureFromRun(input) {
      return runtimeRepository.createJob({
        type: input.target === 'knowledge' ? 'knowledge.from-run' : 'inspiration.from-run',
        input,
        workspaceId: input.workspaceId,
        maxAttempts: 1,
      });
    },
    requestTagAnalyze(input) {
      return runtimeRepository.createJob({
        type: 'tagging.analyze',
        input,
        workspaceId: input.workspaceId,
        maxAttempts: 3,
      });
    },
    requestArticleAnalysis(input) {
      return runtimeRepository.createJob({
        type: ARTICLE_ANALYSIS_JOB_TYPE,
        input: {
          source: input.source,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
        },
        workspaceId: input.workspaceId,
        maxAttempts: 1,
      });
    },
    requestWorkPackageDispatch(input) {
      return runtimeRepository.createJob({
        type: 'work-package.dispatch',
        input,
        workspaceId: input.workspaceId || 'local',
        maxAttempts: 2,
      });
    },
    getJob(id) {
      return runtimeRepository.getJob(id);
    },
    retryAgentRun(id, workspaceId) {
      const job = runtimeRepository.getJob(id);
      if (!job || job.workspaceId !== workspaceId) {
        throw new ValidationError('Agent 任务不存在', ['runId']);
      }
      if (job.type !== 'ai.agent.run' && job.type !== ARTICLE_ANALYSIS_JOB_TYPE) {
        throw new ValidationError('这类任务不能重新执行', ['runId']);
      }
      if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
        throw new ValidationError('任务仍在排队或执行中', ['runId']);
      }
      return runtimeRepository.createJob({
        type: job.type,
        input: job.input,
        workspaceId,
        maxAttempts: job.maxAttempts,
      });
    },
    async getAgentRun(id) {
      const job = runtimeRepository.getJob(id);
      if (!job) return null;
      const window = { fromAt: job.createdAt, toAt: Date.now() };
      const snapshot = agentProgressPort?.snapshot
        ? await agentProgressPort.snapshot(job.id, window)
        : null;
      const records = snapshot?.progress || (agentProgressPort?.listSteps
        ? await agentProgressPort.listSteps(job.id, window)
        : []);
      const progress = (Array.isArray(records) ? records : [])
        .map((step) => parseContract(AgentRunProgressStepSchema, step));
      return parseContract(AgentRunStatusViewSchema, {
        runId: job.id,
        sessionId: job.input?.sessionId || '',
        status: job.status,
        phase: agentRunPhase(job, progress),
        revision: Number(snapshot?.revision) || progress.length,
        updatedAt: Math.max(job.updatedAt || 0, progress.at(-1)?.at || 0),
        result: job.status === 'completed'
          ? {
            aiRunId: job.output?.aiRunId || null,
            sessionId: job.output?.sessionId || job.input?.sessionId || '',
          }
          : null,
        error: job.status === 'failed' || job.status === 'cancelled' ? job.error : null,
        // Compatibility carrier for the current Web client. New callers use the fields above.
        job,
        progress,
      });
    },
    async getArticleAnalysisRun(id) {
      const job = runtimeRepository.getJob(id);
      if (!job || job.type !== ARTICLE_ANALYSIS_JOB_TYPE) return null;
      const window = { fromAt: job.createdAt, toAt: Date.now() };
      const snapshot = agentProgressPort?.snapshot
        ? await agentProgressPort.snapshot(job.id, window)
        : null;
      const records = snapshot?.progress || (agentProgressPort?.listSteps
        ? await agentProgressPort.listSteps(job.id, window)
        : []);
      const progress = (Array.isArray(records) ? records : [])
        .map((step) => parseContract(AgentRunProgressStepSchema, step));
      const base = {
        runId: job.id,
        workspaceId: job.workspaceId,
        sessionId: job.input?.sessionId || job.output?.sessionId || '',
        status: job.status,
        phase: agentRunPhase(job, progress),
        revision: Number(snapshot?.revision) || progress.length,
        updatedAt: Math.max(job.updatedAt || 0, progress.at(-1)?.at || 0),
        stage: articleAnalysisStage(job),
        progress,
      };
      if (job.status === 'completed') {
        return parseContract(ArticleAnalysisRunViewSchema, {
          ...base,
          aiRunId: job.output?.aiRunId,
          outputText: job.output?.outputText || '',
        });
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        return parseContract(ArticleAnalysisRunViewSchema, { ...base, error: job.error });
      }
      return parseContract(ArticleAnalysisRunViewSchema, base);
    },
    listJobs(limit) {
      return runtimeRepository.listJobs(limit);
    },
    listActiveAgentRuns(workspaceId) {
      const jobs = runtimeRepository.listActiveAgentJobs
        ? runtimeRepository.listActiveAgentJobs(workspaceId)
        : runtimeRepository.listJobs(200).filter((job) => (
          job.workspaceId === workspaceId
          && job.type === 'ai.agent.run'
          && (job.status === 'queued' || job.status === 'running')
        ));
      return jobs.map((job) => parseContract(ActiveAgentRunSchema, {
        runId: job.id,
        sessionId: job.input?.sessionId || '',
        status: job.status,
        question: articleAnalysisQuestion(job.input),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        ...(job.type === ARTICLE_ANALYSIS_JOB_TYPE ? { agentMode: 'article-analysis' } : {}),
      }));
    },
    listEvents(afterId, limit, workspaceId) {
      return runtimeRepository.listEvents(afterId, limit, workspaceId);
    },
    latestEventId() {
      return runtimeRepository.latestEventId();
    },
  });
}
