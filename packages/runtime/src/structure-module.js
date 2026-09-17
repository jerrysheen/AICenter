import { StructureJobInputSchema, parseContract } from '../../contracts/src/index.js';
import { compileStructuredArtifact } from '../../domain/src/structured-artifact.js';

export const knowledgeStructureManifest = Object.freeze({
  id: 'knowledge.structure',
  version: '1.0.0',
  capabilities: ['knowledge.structure'],
  jobTypes: ['inspiration.from-run', 'knowledge.from-run'],
});

async function completeText(llm, { systemInstruction, prompt, signal }) {
  if (typeof llm.respond === 'function') {
    const response = await llm.respond({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [],
      signal,
      systemInstruction,
    });
    return String(response?.text || '');
  }
  if (typeof llm.ask === 'function') {
    const response = await llm.ask({ message: prompt, tools: [], signal });
    return String(response?.text || response?.answer || '');
  }
  throw new Error('structured compiler requires llm.respond or llm.ask');
}

async function sourceTextForRun({ knowledgeService, contextService, workspaceId, run }) {
  const refs = knowledgeService.listRunContextRefs(workspaceId, run.id)
    .filter((item) => item.origin === 'selected')
    .map((item) => ({
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      ...(item.revision ? { revision: item.revision } : {}),
    }));
  let evidence = '';
  if (refs.length && contextService?.resolveReferences) {
    const resolved = await contextService.resolveReferences({ workspaceId, references: refs });
    evidence = resolved.promptText || '';
  }
  return [
    run.inputText ? `用户问题：\n${run.inputText}` : '',
    `AI 回答：\n${run.outputText || ''}`,
    evidence ? `已固定引用：\n${evidence}` : '',
  ].filter(Boolean).join('\n\n');
}

function createHandler({ llm, knowledgeService, contextService }) {
  return async (rawInput, context) => {
    const input = parseContract(StructureJobInputSchema, rawInput);
    const workspaceId = context.job.workspaceId || input.workspaceId;
    const run = knowledgeService.getAgentRun(workspaceId, input.sourceRunId);
    if (!run) throw new Error('问答记录不存在');
    const catalog = knowledgeService.listTaxonomy(workspaceId);
    const sourceText = await sourceTextForRun({ knowledgeService, contextService, workspaceId, run });
    const artifact = await compileStructuredArtifact({
      catalog,
      target: input.target,
      sourceText,
      instruction: input.instruction,
      question: run.inputText || '',
      generateText: ({ prompt, systemInstruction }) => completeText(llm, {
        prompt,
        systemInstruction,
        signal: context.signal,
      }),
    });
    return knowledgeService.persistStructuredArtifact({
      workspaceId,
      sourceRunId: run.id,
      artifact,
    });
  };
}

export function createStructureJobHandlers({ llm, knowledgeService, contextService }) {
  if (!llm || !knowledgeService) throw new Error('structure jobs require llm and knowledge service');
  const handler = createHandler({ llm, knowledgeService, contextService });
  return {
    'inspiration.from-run': handler,
    'knowledge.from-run': handler,
  };
}
