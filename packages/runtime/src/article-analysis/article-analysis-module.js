import { ARTICLE_ANALYSIS_JOB_TYPE, ArticleAnalysisJobInputSchema, parseContract } from '../../../contracts/src/index.js';
import { settleAgentQualityReview } from '../agent-quality.js';
import { createArticleAnalysisRunner } from './article-analysis-runner.js';

export const articleAnalysisManifest = Object.freeze({
  id: 'agent.article-analysis',
  version: '1.0.0',
  capabilities: ['agent.article-analysis'],
  jobTypes: [ARTICLE_ANALYSIS_JOB_TYPE],
});

export function createArticleAnalysisJobHandlers({
  articleAnalysisRunner,
  agentRuntime,
  knowledgeService,
  feedService,
  agentTraceLog,
  agentQuality,
} = {}) {
  const runner = articleAnalysisRunner || createArticleAnalysisRunner({
    agentRuntime,
    knowledgeService,
    feedService,
  });
  return {
    [ARTICLE_ANALYSIS_JOB_TYPE]: async (rawInput, context) => {
      const input = parseContract(ArticleAnalysisJobInputSchema, rawInput);
      const workspaceId = context.job.workspaceId || input.workspaceId || 'local';
      const trace = agentTraceLog ? (entry) => agentTraceLog.append({
        runId: context.job.id,
        workspaceId,
        ...entry,
      }) : null;
      try {
        const result = await runner.run({
          source: input.source,
          workspaceId,
          jobId: context.job.id,
          sessionId: input.sessionId || '',
          signal: context.signal,
          trace,
        });
        try {
          await settleAgentQualityReview({
            quality: agentQuality,
            input: {
              message: result.reviewMessage || '',
              webMode: 'always',
              researchMode: 'standard',
              signal: context.signal,
            },
            result,
            record: (event, detail) => trace?.({ event, detail }),
          });
        } catch {}
        await trace?.({ event: 'article.completed', detail: { aiRunId: result.aiRunId, evidenceGate: result.evidenceGate || null } });
        return result;
      } catch (error) {
        await trace?.({
          event: 'article.failed',
          detail: { name: error?.name || 'Error', message: error?.message || String(error) },
        });
        throw error;
      }
    },
  };
}
