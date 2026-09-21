import {
  aggregateEvidenceGate,
  applyEvidenceGateToToolResult,
  extractRetrievalHits,
  isEvidenceGateTool,
} from '../../runtime/src/evidence-gate.js';

export async function applyHarnessEvidenceGate({
  quality, toolId, toolResult, input = {}, message = '', signal, record, round = 0, callId = null,
} = {}) {
  if (
    !isEvidenceGateTool(toolId)
    || !quality?.gateEvidence
    || !quality.config?.evidenceGateMode
    || quality.config.evidenceGateMode === 'off'
  ) {
    return { observed: toolResult, gated: null };
  }
  const rawHits = extractRetrievalHits(toolId, toolResult.data);
  await record?.('evidence.gate.started', {
    round, callId, id: toolId, resultCount: rawHits.length, query: input?.query || '',
  });
  const gated = await quality.gateEvidence({
    message,
    query: input?.query || '',
    toolId,
    toolResult,
    signal,
    mode: quality.config.evidenceGateMode,
  });
  if (gated?.status === 'ok') {
    const observed = applyEvidenceGateToToolResult({
      toolId,
      toolResult,
      decision: gated,
      mode: quality.config.evidenceGateMode,
    });
    await record?.('evidence.gate.completed', {
      round, callId, id: toolId,
      mode: gated.mode,
      acceptedCount: gated.accepted?.length || 0,
      rejectedCount: gated.rejected?.length || 0,
      rejectedHosts: (gated.rejected || []).map((hit) => hit.host).filter(Boolean).slice(0, 8),
      confidence: gated.confidence ?? null,
      sufficiency: gated.sufficiency ?? null,
      hint: gated.hint || '',
      durationMs: gated.durationMs ?? null,
    });
    return { observed, gated };
  }
  if (gated?.status === 'skipped') {
    await record?.('evidence.gate.skipped', { round, callId, id: toolId, reason: gated.reason || 'off' });
  } else {
    await record?.('evidence.gate.failed', {
      round, callId, id: toolId,
      message: gated?.error || 'evidence gate failed',
      code: gated?.code || '',
      durationMs: gated?.durationMs ?? null,
    });
  }
  return { observed: toolResult, gated };
}

export { aggregateEvidenceGate };
