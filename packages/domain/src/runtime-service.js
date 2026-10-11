import { open } from 'node:fs/promises';
import { TRANSLATION_MAX_ATTEMPTS } from '../../database/src/translation-retry.js';
import {
  ActiveAgentRunSchema,
  AgentRunStatusViewSchema,
  AgentRunProgressStepSchema,
  ARTICLE_ANALYSIS_JOB_TYPE,
  ArticleAnalysisRunViewSchema,
  AUDIO_TRANSCRIBE_JOB_TYPE,
  AudioTranscriptionCreateSchema,
  AudioTranscriptionJobInputSchema,
  AudioTranscriptionViewSchema,
  QUANT_PREPARE_JOB_TYPE,
  QUANT_RUN_JOB_TYPE,
  INVESTOR_DISCUSSION_JOB_TYPE,
  QuantRunOptionsSchema,
  ValidationError,
  parseContract,
  FeedValueRefreshInputSchema,
  GenerateHourlyDigestInputSchema,
  FeedTranslationJobInputSchema,
} from '../../contracts/src/index.js';
import { describeAudioTranscription, readWavInfo, resolveAudioFile } from './audio-transcription.js';
import { randomUUID } from 'node:crypto';
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

function presentSelectedSkills(selectedSkills, analysisSkillCatalog) {
  if (!Array.isArray(selectedSkills) || !selectedSkills.length) return [];
  return selectedSkills.slice(0, 1).flatMap((item) => {
    const known = analysisSkillCatalog?.describe?.(item);
    const id = String(known?.id || item?.id || '').trim();
    const version = String(known?.version || item?.version || '').trim();
    const name = String(known?.name || id).trim();
    if (!id || !version || !name) return [];
    return [{ id, version, name }];
  });
}

function acceptedAnalysisSkills(selectedSkills, analysisSkillCatalog) {
  if (selectedSkills == null || (Array.isArray(selectedSkills) && selectedSkills.length === 0)) return [];
  if (!analysisSkillCatalog?.activate) throw new ValidationError('分析方法目录不可用', ['selectedSkills']);
  return analysisSkillCatalog.activate(selectedSkills).map(({ id, version }) => ({ id, version }));
}

function publicAudioError(error) {
  const message = error?.message || error?.name || '';
  const text = String(message).replace(/AQ\.[A-Za-z0-9_-]+/g, '[redacted]').replace(/\s+/g, ' ').trim();
  return text.slice(0, 500) || '转写失败';
}

export function createRuntimeService({ runtimeRepository, agentProgressPort, restartPort, dailyConfig = null, feedFilterConfig=null, analysisSkillCatalog = null, dataDirectory = null, env = process.env }) {
  if (!runtimeRepository) throw new Error('runtimeRepository is required');

  return Object.freeze({
    requestTranslation(input) {
      const value = FeedTranslationJobInputSchema.parse(input);
      const open = runtimeRepository.listOpenJobs?.('feed.translation.run')?.find(job => job.workspaceId === value.workspaceId && JSON.stringify(job.input) === JSON.stringify(value));
      return open || runtimeRepository.createJob({ type: 'feed.translation.run', workspaceId: value.workspaceId, input: value, maxAttempts: TRANSLATION_MAX_ATTEMPTS });
    },
    requestHourlyDigest(input={}) {
      const value=GenerateHourlyDigestInputSchema.parse(input),workspaceId=value.workspaceId || 'local';
      const open=runtimeRepository.listOpenJobs?.('report.hourly.extract')?.find(j=>j.workspaceId===workspaceId && j.input?.hourStart===value.hourStart
        && j.input?.mode===value.mode && j.input?.snapshotId===value.snapshotId);
      return open || runtimeRepository.createJob({type:'report.hourly.extract',workspaceId,input:value,maxAttempts:2});
    },
    requestFeedQualityRefresh(input={}) {
      const value=FeedValueRefreshInputSchema.parse(input);
      const open=runtimeRepository.listOpenJobs?.('feed.quality.refresh')?.find(j=>j.workspaceId===value.workspaceId);
      if(open) return open;
      return runtimeRepository.createJob({type:'feed.quality.refresh',workspaceId:value.workspaceId,input:value,maxAttempts:1});
    },
    requestMediaProbe({workspaceId='local',sourceKeys=[],policyReviewed=false}={}) {
      if (!Array.isArray(sourceKeys) || sourceKeys.length > 30 || sourceKeys.some(key=>typeof key!=='string' || !/^[a-z0-9]+$/.test(key))) throw new ValidationError('探针来源集合不合法',['sourceKeys']);
      return runtimeRepository.createJob({type:'media.sources.probe',workspaceId,input:{workspaceId,sourceKeys,policyReviewed:policyReviewed===true},maxAttempts:1});
    },
    requestTrendforceSync({workspaceId='local'}={}) {
      return runtimeRepository.createJob({type:'feed.trendforce.sync',workspaceId,input:{workspaceId},maxAttempts:2});
    },
    requestTrendforceMigration({workspaceId='local'}={}) {
      return runtimeRepository.createJob({type:'feed.trendforce.migrate',workspaceId,input:{workspaceId},maxAttempts:2});
    },
    requestMediaSync({ workspaceId = 'local', channel = '' } = {}) {
      if (!['','tech','macro'].includes(channel)) throw new ValidationError('未知媒体频道',['channel']);
      return runtimeRepository.createJob({ type: 'media.sources.sync', workspaceId, input: { workspaceId, channel, force: true }, maxAttempts: 1 });
    },
    requestMediaBodies({ workspaceId = 'local', externalIds = [], repair = false } = {}) {
      if (!Array.isArray(externalIds) || externalIds.length > 40 || externalIds.some(id => typeof id !== 'string' || id.length > 512 || !id)) throw new ValidationError('正文ID集合不合法',['externalIds']);
      if (repair && !externalIds.length) throw new ValidationError('修复必须提供明确的正文ID集合',['externalIds']);
      return runtimeRepository.createJob({ type: 'media.index.enrich', workspaceId, input: { workspaceId, externalIds, repair: Boolean(repair) }, maxAttempts: 1 });
    },
    getStatus() {
      return {...runtimeRepository.getRuntimeStatus(),...(feedFilterConfig?{feedFilter:feedFilterConfig}:{})};
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
      const workspaceId=input.workspaceId || 'local';
      const open=runtimeRepository.listOpenJobs?.('report.daily.generate')?.find(j=>j.workspaceId===workspaceId && j.input?.reportDate===reportDate);
      if(open) return open;
      return runtimeRepository.createJob({
        type: 'report.daily.generate',
        workspaceId: input.workspaceId || 'local',
        maxAttempts: 2,
        input: {
          workspaceId,
          requestKey:randomUUID(),
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
      const mode=input.mode || 'resume';
      const open=runtimeRepository.listOpenJobs?.('report.daily.brief.generate')?.find(j=>j.workspaceId===workspaceId && j.input?.reportId===reportId && (j.input?.mode || 'resume')===mode);
      if(open) return open;
      return runtimeRepository.createJob({
        type: 'report.daily.brief.generate',
        workspaceId,
        maxAttempts: 2,
        input: { workspaceId, reportId, mode,requestKey:randomUUID(),...(input.sourceReportUpdatedAt ? {sourceReportUpdatedAt:input.sourceReportUpdatedAt} : {}) },
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
    listSelectableAnalysisSkills() {
      return analysisSkillCatalog?.listSelectable?.() || [];
    },
    assertAnalysisSkills(selectedSkills) {
      acceptedAnalysisSkills(selectedSkills, analysisSkillCatalog);
    },
    requestAgentRun(input) {
      const researchProfile = resolveResearchProfile(input.researchMode, input.researchProfile);
      const selectedSkills = acceptedAnalysisSkills(input.selectedSkills, analysisSkillCatalog);
      return runtimeRepository.createJob({
        type: 'ai.agent.run',
        input: {
          ...input,
          researchMode: researchProfile.mode,
          researchProfile,
          selectedSkills,
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
    async requestAudioTranscription(input) {
      if (!dataDirectory) throw new Error('audio transcription requires a data directory');
      const parsed = parseContract(AudioTranscriptionCreateSchema, input);
      const absolute = resolveAudioFile(dataDirectory, parsed.path);
      const file = await open(absolute, 'r');
      let durationMs = 0;
      try {
        const size = (await file.stat()).size;
        const length = Math.min(size, 1024 * 1024);
        const header = Buffer.alloc(length);
        const { bytesRead } = await file.read(header, 0, length, 0);
        durationMs = readWavInfo(header.subarray(0, bytesRead), size).durationMs;
      } finally {
        await file.close();
      }
      if (durationMs <= 0) throw new ValidationError('音频时长无效', ['path']);
      const plan = await describeAudioTranscription(env, durationMs);
      const value = parseContract(AudioTranscriptionJobInputSchema, {
        ...parsed,
        workspaceId: input.workspaceId || 'local',
        plan,
      });
      const openJob = runtimeRepository.listOpenJobs?.(AUDIO_TRANSCRIBE_JOB_TYPE)?.find((job) => (
        job.workspaceId === value.workspaceId && job.input?.path === value.path
      ));
      return openJob || runtimeRepository.createJob({
        type: AUDIO_TRANSCRIBE_JOB_TYPE,
        workspaceId: value.workspaceId,
        input: value,
        maxAttempts: 1,
      });
    },
    getAudioTranscription(id, workspaceId) {
      const job = runtimeRepository.getJob(id);
      if (!job || job.type !== AUDIO_TRANSCRIBE_JOB_TYPE || job.workspaceId !== workspaceId) return null;
      const output = job.output || {};
      return parseContract(AudioTranscriptionViewSchema, {
        runId: job.id,
        workspaceId: job.workspaceId,
        status: job.status,
        path: job.input?.path || '',
        updatedAt: job.updatedAt,
        plan: output.plan || job.input?.plan,
        text: output.text || '',
        segments: output.segments || [],
        ...(job.status === 'failed' ? { error: publicAudioError(job.error) } : {}),
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
    requestInvestorDiscussion(input = {}) {
      const digestDate = String(input.digestDate || '').trim();
      const open = (runtimeRepository.listOpenJobs?.(INVESTOR_DISCUSSION_JOB_TYPE) || []).find((job) => {
        const jobDate = String(job.input?.digestDate || '');
        return !digestDate || !jobDate || jobDate === digestDate;
      });
      if (open) return open;
      return runtimeRepository.createJob({
        type: INVESTOR_DISCUSSION_JOB_TYPE,
        workspaceId: 'local',
        maxAttempts: 2,
        input: digestDate ? { digestDate } : {},
      });
    },
    requestQuantPrepare() {
      return runtimeRepository.createJob({
        type: QUANT_PREPARE_JOB_TYPE,
        workspaceId: 'local',
        maxAttempts: 1,
        input: {},
      });
    },
    requestQuantRun(input = {}) {
      const options = parseContract(QuantRunOptionsSchema, {
        topk: input.topk == null || input.topk === '' ? 5 : Number(input.topk),
        nDrop: input.nDrop == null || input.nDrop === '' ? 1 : Number(input.nDrop),
      });
      return runtimeRepository.createJob({
        type: QUANT_RUN_JOB_TYPE,
        workspaceId: 'local',
        maxAttempts: 1,
        input: {
          experimentId: randomUUID(),
          topk: options.topk,
          nDrop: options.nDrop,
        },
      });
    },
    listActiveAgentRuns(workspaceId) {
      const jobs = runtimeRepository.listActiveAgentJobs
        ? runtimeRepository.listActiveAgentJobs(workspaceId)
        : runtimeRepository.listJobs(200).filter((job) => (
          job.workspaceId === workspaceId
          && job.type === 'ai.agent.run'
          && (job.status === 'queued' || job.status === 'running')
        ));
      return jobs.map((job) => {
        const selectedSkills = job.type === 'ai.agent.run'
          ? presentSelectedSkills(job.input?.selectedSkills, analysisSkillCatalog)
          : [];
        return parseContract(ActiveAgentRunSchema, {
          runId: job.id,
          sessionId: job.input?.sessionId || '',
          status: job.status,
          question: articleAnalysisQuestion(job.input),
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          ...(job.type === ARTICLE_ANALYSIS_JOB_TYPE ? { agentMode: 'article-analysis' } : {}),
          ...(selectedSkills.length ? { selectedSkills } : {}),
        });
      });
    },
    listEvents(afterId, limit, workspaceId) {
      return runtimeRepository.listEvents(afterId, limit, workspaceId);
    },
    latestEventId() {
      return runtimeRepository.latestEventId();
    },
  });
}
