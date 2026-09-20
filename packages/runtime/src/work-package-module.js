import { parseDispatchWorkPackageJobInput } from '../../contracts/src/index.js';
import { buildCursorSessionPrompt, cursorSessionActor, workPackageTraceId } from '../../connectors/src/cursor-session.js';

export const workPackageDispatchManifest = Object.freeze({
  id: 'work-package.dispatch',
  version: '1.0.0',
  capabilities: ['work-package.dispatch'],
  jobTypes: ['work-package.dispatch'],
});

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function createWorkPackageJobHandlers({
  knowledgeService,
  cursorSessionPort,
  apiBase,
  requestProcessRestart,
  workPackageTracePort,
}) {
  if (!knowledgeService || !cursorSessionPort) {
    throw new Error('work-package jobs require knowledgeService and cursorSessionPort');
  }
  return {
    'work-package.dispatch': async (rawInput, context = {}) => {
      const input = parseDispatchWorkPackageJobInput(rawInput || {});
      const workspaceId = input.workspaceId || 'local';
      const pack = knowledgeService.getWorkPackage(workspaceId, input.workPackageId);
      if (!pack) throw new Error('工作包不存在');
      if (TERMINAL.has(pack.status)) {
        return { skipped: true, reason: pack.status, workPackageId: pack.id };
      }

      const claimed = pack.status === 'claimed' && pack.claimedBy === cursorSessionActor()
        ? pack
        : knowledgeService.claimWorkPackage(workspaceId, {
          id: pack.id,
          claimedBy: cursorSessionActor(),
          leaseMs: 5_400_000,
        });

      try {
        const hashId = workPackageTracePort?.hashId?.(claimed.id) || workPackageTraceId(claimed.id);
        const relativeDir = workPackageTracePort?.relativeDir?.(claimed.id)
          || `.ai-data/logs/work-packages/${hashId}`;
        const files = knowledgeService.resolveAttachmentFiles?.(workspaceId, 'work-package', claimed.id) || [];
        const prompt = buildCursorSessionPrompt(claimed, {
          apiBase,
          trace: { hashId, relativeDir },
          images: files.map((item) => item.relativePath),
        });
        workPackageTracePort?.prepare?.({ workPackage: claimed, prompt });
        const session = await cursorSessionPort.startSession({
          workPackage: claimed,
          prompt,
          imagePaths: files.map((item) => item.absolutePath),
          signal: context.signal,
        });
        knowledgeService.attachCursorSession(workspaceId, claimed.id, {
          cursorAgentId: session.agentId || 'cursor-cli',
          cursorRunId: session.runId || '',
        });
        const latest = knowledgeService.getWorkPackage(workspaceId, claimed.id);
        if (latest?.status === 'claimed') {
          knowledgeService.failWorkPackage(workspaceId, claimed.id, {
            claimedBy: cursorSessionActor(),
            resultSummary: session.stdout
              ? `Cursor CLI 已退出但未上报：${String(session.stdout).slice(0, 400)}`
              : 'Cursor CLI 已退出但未上报',
          });
        }
        const finished = knowledgeService.getWorkPackage(workspaceId, claimed.id);
        const restart = finished?.restartRequired === 'required' && typeof requestProcessRestart === 'function'
          ? requestProcessRestart({
            reason: 'work-package',
            workPackageId: claimed.id,
            scope: finished.restart?.scope,
          })
          : { requested: false };
        return {
          workPackageId: claimed.id,
          agentId: session.agentId || 'cursor-cli',
          status: finished?.status || 'failed',
          restartRequested: Boolean(restart?.requested),
        };
      } catch (error) {
        const latest = knowledgeService.getWorkPackage(workspaceId, claimed.id);
        if (latest?.status === 'claimed' && latest.claimedBy === cursorSessionActor()) {
          knowledgeService.failWorkPackage(workspaceId, claimed.id, {
            claimedBy: cursorSessionActor(),
            resultSummary: error instanceof Error ? error.message : 'Cursor CLI 启动失败',
          });
        }
        throw error;
      }
    },
  };
}
