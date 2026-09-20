import { settleAgentQualityReview } from './agent-quality.js';

export const agentRuntimeManifest = Object.freeze({
  id: 'agent.runtime',
  version: '1.0.0',
  capabilities: ['agent.question-answer'],
  jobTypes: ['ai.agent.run'],
});

async function priorTurnsWithSelectedRefs({ knowledgeService, contextService, workspaceId, sessionId }) {
  const turns = sessionId ? knowledgeService.listSessionTurns(workspaceId, sessionId) : [];
  if (!contextService?.resolveReferences) return turns;
  const result = [];
  for (const turn of turns) {
    if (!turn.selectedRefs?.length) {
      result.push(turn);
      continue;
    }
    const resolved = await contextService.resolveReferences({
      workspaceId,
      references: turn.selectedRefs,
    });
    result.push({
      ...turn,
      inputText: resolved.promptText
        ? `${resolved.promptText}\n\n用户问题：\n${turn.inputText}`
        : turn.inputText,
    });
  }
  return result;
}

export function createAgentJobHandlers({ agentRuntime, knowledgeService, contextService, agentTraceLog, agentQuality }) {
  if (!agentRuntime || !knowledgeService) throw new Error('agent runtime and knowledge service are required');
  return {
    'ai.agent.run': async (input, context) => {
      const workspaceId = context.job.workspaceId || input.workspaceId;
      const trace = agentTraceLog ? (entry) => agentTraceLog.append({
        runId: context.job.id,
        workspaceId,
        ...entry,
      }) : null;
      await trace?.({ event: 'run.started', detail: {
        message: input.message,
        webMode: input.webMode || 'off',
        researchMode: input.researchMode || input.researchProfile?.mode || 'standard',
      } });
      const resolved = contextService?.resolveReferences && input.references?.length
        ? await contextService.resolveReferences({ workspaceId, references: input.references })
        : { items: [], missing: [], promptText: '', refs: [] };
      const priorTurns = await priorTurnsWithSelectedRefs({
        knowledgeService, contextService, workspaceId, sessionId: input.sessionId,
      });
      let result;
      try {
        result = await agentRuntime.run({
          ...input,
          selectedContext: resolved.promptText,
          priorTurns,
          sessionId: input.sessionId || '',
          jobId: context.job.id,
          selectedRefs: input.references || [],
          signal: context.signal,
          trace,
        });
      } catch (error) {
        await trace?.({ event: 'run.failed', detail: { name: error?.name || 'Error', message: error?.message || String(error) } });
        throw error;
      }
      try {
        await settleAgentQualityReview({
          quality: agentQuality,
          input: { ...input, signal: context.signal },
          result,
          record: (event, detail) => trace?.({ event, detail }),
        });
      } catch {}
      const toolRefs = (result.refs || []).map((item) => ({ ...item, origin: item.origin || 'tool' }));
      const warnings = [...(result.warnings || [])];
      if (resolved.missing?.length) {
        warnings.push(`有 ${resolved.missing.length} 条用户引用未能读取`);
      }
      const aiRun = knowledgeService.recordAgentRun({
        jobId: context.job.id,
        workspaceId,
        sessionId: input.sessionId || '',
        message: input.message,
        ...result,
        refs: [...resolved.refs, ...toolRefs],
        warnings,
        output: {
          toolCalls: result.toolCalls,
          warnings,
          evidenceGate: result.evidenceGate || null,
        },
      });
      return {
        answer: result.answer,
        aiRunId: aiRun.id,
        sessionId: aiRun.sessionId,
        providerId: result.providerId,
        modelId: result.modelId,
        warnings,
      };
    },
  };
}
