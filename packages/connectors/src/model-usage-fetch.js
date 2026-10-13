import { randomUUID } from 'node:crypto';
import { emptyTokenUsage, normalizeTokenUsage } from '../../contracts/src/model-usage.js';
import { modelUsageContext, observeModelUsage } from '../../runtime/src/model-usage-context.js';

export function providerTokenUsage(payload, provider) {
  if (provider === 'gemini') {
    const u = payload?.usageMetadata;
    if (!u) return emptyTokenUsage();
    return normalizeTokenUsage({ inputTokens: Number.isSafeInteger(u.promptTokenCount) && Number.isSafeInteger(u.cachedContentTokenCount) ? u.promptTokenCount - u.cachedContentTokenCount : undefined,
      outputTokens: Number.isSafeInteger(u.totalTokenCount) && Number.isSafeInteger(u.promptTokenCount) ? u.totalTokenCount - u.promptTokenCount : u.candidatesTokenCount,
      cacheReadTokens: u.cachedContentTokenCount, reasoningTokens: u.thoughtsTokenCount, totalTokens: u.totalTokenCount });
  }
  const u = payload?.usage;
  if (!u) return emptyTokenUsage();
  const input = u.input_tokens ?? u.prompt_tokens;
  const cached = u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens;
  return normalizeTokenUsage({ inputTokens: Number.isSafeInteger(input) && Number.isSafeInteger(cached) ? input - cached : undefined,
    outputTokens: u.output_tokens ?? u.completion_tokens, cacheReadTokens: cached,
    cacheWriteTokens: u.cache_creation_input_tokens,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens,
    totalTokens: u.total_tokens });
}

// One observer per actual HTTP attempt. No URLs, headers, request bodies or response text are persisted.
export function createUsageFetch(fetchImpl, { provider, model, observer, stage = 'direct-model' } = {}) {
  return async (url, init) => {
    const inherited = modelUsageContext();
    let usedModel = init?.usageModel || model || '';
    try { usedModel = JSON.parse(init?.body || '{}').model || usedModel; } catch {}
    const row = { id: randomUUID(), kind: 'request', workspaceId: inherited.workspaceId || 'local',
      jobId: inherited.jobId || '', jobAttempt: inherited.jobAttempt ?? null, stage,
      applicationSessionId: inherited.applicationSessionId || '', harnessSessionId: inherited.harnessSessionId || '',
      turn: inherited.turn ?? null, step: inherited.step ?? null, attempt: null,
      provider, model: usedModel, status: 'pending', completeness: 'missing', usage: emptyTokenUsage(),
      httpStatus: null, occurredAt: Date.now(), supplierAmount: null, supplierCurrency: null };
    await observeModelUsage(row, observer);
    try {
      const response = await fetchImpl(url, init);
      let payload;
      try { payload = await response.clone().json(); } catch {}
      row.usage = providerTokenUsage(payload, provider);
      row.status = response.ok ? 'succeeded' : 'failed';
      row.httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      row.completeness = row.usage.inputTokens !== null && row.usage.outputTokens !== null && row.usage.totalTokens !== null ? 'complete'
        : Object.values(row.usage).some(value => value !== null) ? 'partial' : 'missing';
      await observeModelUsage(row, observer);
      return response;
    } catch (error) {
      row.status = 'interrupted'; await observeModelUsage(row, observer); throw error;
    }
  };
}
