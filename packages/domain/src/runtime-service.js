import { AgentRunProgressStepSchema, parseContract } from '../../contracts/src/index.js';

export function createRuntimeService({ runtimeRepository, agentProgressPort }) {
  if (!runtimeRepository) throw new Error('runtimeRepository is required');

  return Object.freeze({
    getStatus() {
      return runtimeRepository.getRuntimeStatus();
    },
    requestHealthcheck(requestedAt = Date.now()) {
      return runtimeRepository.createJob({
        type: 'system.healthcheck',
        input: { requestedAt },
        maxAttempts: 1,
      });
    },
    requestAgentRun(input) {
      return runtimeRepository.createJob({
        type: 'ai.agent.run',
        input,
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
    getJob(id) {
      return runtimeRepository.getJob(id);
    },
    async getAgentRun(id) {
      const job = runtimeRepository.getJob(id);
      if (!job) return null;
      const records = agentProgressPort?.listSteps
        ? await agentProgressPort.listSteps(job.id, { fromAt: job.createdAt, toAt: Date.now() })
        : [];
      const progress = (Array.isArray(records) ? records : [])
        .map((step) => parseContract(AgentRunProgressStepSchema, step));
      return {
        runId: job.id,
        sessionId: job.input?.sessionId || '',
        status: job.status,
        job,
        progress,
      };
    },
    listJobs(limit) {
      return runtimeRepository.listJobs(limit);
    },
    listEvents(afterId, limit, workspaceId) {
      return runtimeRepository.listEvents(afterId, limit, workspaceId);
    },
    latestEventId() {
      return runtimeRepository.latestEventId();
    },
  });
}
