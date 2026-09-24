import { createHash, randomUUID } from 'node:crypto';
import {
  DailyBriefModelOutputSchema,
  DailyBriefSchema,
  parseContract,
} from '../../contracts/src/index.js';
import { buildDailyBriefCandidates } from './daily-brief-candidates.js';

export const DAILY_BRIEF_TASK_INSTRUCTION = [
  '你的任务是做注意力筛选，不是事实发现。',
  '只能使用 Candidate Pool 中的信息。',
  '不要联网。',
  '不要调用工具。',
  '不要引入候选中不存在的人物、数字、原因或事件。',
  '不要写买卖建议。',
  '不要预测涨跌。',
  '不要因为某条新闻标题刺激就放大重要性。',
  '优先关注：',
  '1. 状态发生变化',
  '2. 对市场或投资框架影响较大的官方事实',
  '3. 异常市场变化',
  '4. 临近的重要日程',
  '5. 多条候选中反复出现的共同主题',
  '减少：',
  '1. 重复新闻',
  '2. 普通日常波动',
  '3. 没有新增信息的评论',
  '4. 纯观点和情绪',
  '从候选中选出今天最值得花注意力看的内容，通常 3 到 8 条。',
  '如果候选很弱，可以少于 3 条，并在 overview 写明今天没有明显新增信号。',
  '只返回 JSON，不要 Markdown 说明。字段：overview、items[].candidateId、headline、whyItMatters、watchNext。',
  'candidateId 必须来自候选。不要返回 URL 或数据库 ID。',
].join('\n');

export function parseDailyBriefModelText(text) {
  let raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Daily Brief 模型输出不是 JSON');
  }
  return parseContract(DailyBriefModelOutputSchema, parsed);
}

export function assembleDailyBrief({
  id,
  report,
  candidates,
  modelOutput,
  providerId = '',
  modelId = '',
  generatedAt,
}) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set();
  const items = [];
  for (const item of modelOutput.items || []) {
    if (seen.has(item.candidateId)) continue;
    seen.add(item.candidateId);
    const candidate = byId.get(item.candidateId);
    if (!candidate) throw new Error(`候选不存在: ${item.candidateId}`);
    items.push({
      candidateId: candidate.id,
      type: candidate.type,
      headline: item.headline,
      whyItMatters: item.whyItMatters,
      watchNext: item.watchNext,
      occurredAt: candidate.occurredAt,
      sourceRefs: candidate.sourceRefs,
    });
  }
  return parseContract(DailyBriefSchema, {
    id,
    reportId: report.id,
    reportDate: report.reportDate,
    generatedAt,
    overview: modelOutput.overview,
    items,
    providerId: String(providerId || ''),
    modelId: String(modelId || ''),
    sourceReportUpdatedAt: report.updatedAt,
  });
}

function inputHash(modelInput) {
  return createHash('sha256').update(JSON.stringify(modelInput)).digest('hex');
}

export function createDailyBriefService({
  reportRepository,
  agentRuntime,
  now = () => Date.now(),
}) {
  if (!reportRepository?.getDailyReportById) throw new Error('daily brief service requires report repository');
  if (!agentRuntime?.run) throw new Error('daily brief service requires agent runtime');

  return Object.freeze({
    getDailyBrief(workspaceId, reportDate) {
      return reportRepository.getDailyBriefByDate(workspaceId || 'local', reportDate);
    },
    getLatestDailyBrief(workspaceId) {
      return reportRepository.getLatestDailyBrief(workspaceId || 'local');
    },
    async generateDailyBrief(input = {}) {
      const workspaceId = input.workspaceId || 'local';
      const report = reportRepository.getDailyReportById(workspaceId, input.reportId);
      if (!report) throw new Error('日报不存在');
      const previous = reportRepository.getPreviousDailyReport(workspaceId, report.reportDate);
      const pool = buildDailyBriefCandidates(report, previous);
      const generatedAt = now();
      const result = await agentRuntime.run({
        message: JSON.stringify(pool.modelInput),
        workspaceId,
        closedContext: true,
        webMode: 'off',
        enableAuxiliarySearch: false,
        taskInstruction: DAILY_BRIEF_TASK_INSTRUCTION,
      });
      const modelOutput = parseDailyBriefModelText(result?.answer);
      const existing = reportRepository.getDailyBriefByReportId?.(workspaceId, report.id);
      const brief = assembleDailyBrief({
        id: existing?.id || input.id || randomUUID(),
        report,
        candidates: pool.candidates,
        modelOutput,
        providerId: result?.providerId,
        modelId: result?.modelId,
        generatedAt,
      });
      return reportRepository.upsertDailyBrief({
        id: brief.id,
        workspaceId,
        reportId: report.id,
        reportDate: report.reportDate,
        status: 'ready',
        sourceReportUpdatedAt: report.updatedAt,
        inputHash: inputHash(pool.modelInput),
        inputSnapshot: {
          candidateCount: pool.candidateCount,
          includedCount: pool.includedCount,
          truncated: pool.truncated,
          candidates: pool.candidates,
        },
        brief,
        providerId: brief.providerId,
        modelId: brief.modelId,
      });
    },
  });
}
