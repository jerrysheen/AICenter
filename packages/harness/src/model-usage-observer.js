import { createHash } from 'node:crypto';
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client';
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream';
import { emptyTokenUsage, normalizeTokenUsage } from '../../contracts/src/model-usage.js';
import { modelUsageContext } from '../../runtime/src/model-usage-context.js';

const relevant = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'assistant/attempt', 'assistant/message', 'llm/retry', 'llm/retry-started']);
const identity = value => createHash('sha256').update(value).digest('hex');
// Only accounting fields survive observation. Prompts, tool inputs, text and errors never enter the index.
function accountingEvent(event) {
  if (!relevant.has(event?.type) || !Number.isSafeInteger(event.seq) || !Number.isSafeInteger(event.data?.turn)) return null;
  const data = { turn: event.data.turn, ...(event.data.step === undefined ? {} : { step: event.data.step }) };
  if (event.type.startsWith('assistant/')) {
    const usage = event.data.usage ?? lastAssistantStreamChunk(event.data.stream || [], 'usage')?.usage;
    data.stream = usage ? [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }] : [];
    if (event.type === 'assistant/message') {
      data.usage = usage;
      data.message = { source: { provider: String(event.data.message?.source?.provider || ''), model: String(event.data.message?.source?.model || '') } };
    }
  }
  if (event.type === 'turn/end') {
    const failure = event.data.reason?.error || event.data.reason?.failure;
    const status = Number(failure?.status ?? failure?.statusCode);
    const code = Number(failure?.code);
    const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status
      : Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
    const timeout = /ModelExecutionTimeout|TimeoutError|模型执行超时/.test(`${event.data.reason?.kind || ''} ${event.data.reason?.reason?.name || ''} ${event.data.reason?.reason?.message || ''} ${failure?.message || ''}`);
    data.reason = { kind: event.data.reason?.kind, ...(httpStatus ? { httpStatus } : timeout ? { httpStatus: 408 } : {}) };
  }
  return { type: event.type, seq: event.seq, time: event.time, data };
}

export function createHarnessUsageObserver({ record, attribution = {}, provider = '', model = '' } = {}) {
  const inherited = modelUsageContext();
  const base = {
    workspaceId: attribution.workspaceId || inherited.workspaceId || 'local',
    jobId: attribution.jobId || inherited.jobId || '', jobAttempt: inherited.jobAttempt ?? null,
    stage: attribution.stage || inherited.stage || 'ask',
    applicationSessionId: attribution.applicationSessionId || '', provider, model,
    supplierAmount: null, supplierCurrency: null,
  };
  const sessions = new Map();
  const projected = new Map(), persisted = new Map(), carriedHttp = new Map();
  const save = value => projected.set(value.id, structuredClone(value));
  function flush() {
    for (const [id, row] of projected) {
      const serialized = JSON.stringify(row);
      if (persisted.get(id) === serialized) continue;
      try { record?.(row); persisted.set(id, serialized); } catch {}
    }
  }
  function reconcile(sessionId) {
    const events = [...sessions.get(sessionId).values()].sort((a, b) => a.seq - b.seq);
    const turns = Map.groupBy(events, event => event.data.turn);
    for (const [turn, events] of turns) {
      let request = null;
      let lastRequest = null;
      const attempts = new Map();
      const newAttempt = event => {
        const step = event.data.step;
        const attempt = (attempts.get(step) || 0) + 1; attempts.set(step, attempt);
        request = { ...base, id: identity(`${base.workspaceId}:${sessionId}:${turn}:${step}:${attempt}`),
          kind: 'request', harnessSessionId: sessionId, turn, step, attempt,
          occurredAt: Number.isSafeInteger(event.time) && event.time >= 0 ? event.time : Date.now(),
          status: 'pending', completeness: 'missing', usage: emptyTokenUsage() };
        save(request);
      };
      for (const event of events) {
        if (event.type === 'step/start' || event.type === 'llm/retry-started') newAttempt(event);
        if (event.type.startsWith('assistant/') && (!request || request.step !== event.data.step)) {
          // Preserve a confirmed settlement without inventing its missing lifecycle.
          request = { ...base, id: identity(`${base.workspaceId}:${sessionId}:${turn}:${event.data.step}:unresolved`),
            kind: 'request', harnessSessionId: sessionId, turn, step: event.data.step ?? null, attempt: null,
            occurredAt: Number.isSafeInteger(event.time) && event.time >= 0 ? event.time : Date.now(),
            status: 'pending', completeness: 'missing', usage: emptyTokenUsage() };
        }
        if (event.type === 'turn/end' && Number.isInteger(event.data.reason?.httpStatus) && lastRequest && lastRequest.httpStatus == null && (lastRequest.status !== 'succeeded' || event.data.reason.httpStatus < 300)) {
          lastRequest.httpStatus = event.data.reason.httpStatus;
          save(lastRequest);
        }
        if (!request) continue;
        if (event.type.startsWith('assistant/')) {
          const sample = event.data.usage ?? lastAssistantStreamChunk(event.data.stream || [], 'usage')?.usage;
          if (sample) {
            request.usage = normalizeTokenUsage(sample);
            const u = request.usage;
            const required = u.inputTokens !== null && u.outputTokens !== null;
            const valid = Object.entries(sample).filter(([key]) => Object.hasOwn(u, key)).every(([, value]) => value === undefined || Number.isSafeInteger(value) && value >= 0);
            const exact = valid && required && (u.totalTokens !== null || (u.cacheReadTokens !== null && u.cacheWriteTokens !== null));
            const knownPrompt = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
            const contradiction = (u.reasoningTokens !== null && u.outputTokens !== null && u.reasoningTokens > u.outputTokens)
              || (u.totalTokens !== null && u.outputTokens !== null && (u.totalTokens < knownPrompt + u.outputTokens
                || (u.cacheReadTokens !== null && u.cacheWriteTokens !== null && u.totalTokens !== knownPrompt + u.outputTokens)));
            request.completeness = exact && !contradiction && Number.isSafeInteger(knownPrompt + (u.outputTokens ?? 0)) && request.attempt !== null ? 'complete' : 'partial';
            if (contradiction) u.totalTokens = null;
            if (exact && u.totalTokens === null && Number.isSafeInteger(knownPrompt + u.outputTokens)) u.totalTokens = knownPrompt + u.outputTokens;
          }
          if (event.data.message?.source?.provider) request.provider = event.data.message.source.provider;
          if (event.data.message?.source?.model) request.model = event.data.message.source.model;
          request.status = event.type === 'assistant/message' ? 'succeeded' : 'failed';
          if (request.status === 'succeeded' && request.httpStatus == null) request.httpStatus = 200;
          save(request);
        }
        if (event.type === 'llm/retry') { request.status = 'failed'; save(request); }
        if (event.type === 'turn/end' && request.status === 'pending') {
          request.status = 'interrupted';
          if (request.httpStatus == null && event.data.reason?.httpStatus === 408) request.httpStatus = 408;
          save(request);
        }
        if (request.kind === 'request') lastRequest = request;
        if (event.type === 'step/end') request = null;
      }
      // Never call the native function with a synthetic or request-local turn.
      const completeLifecycle = events[0]?.type === 'turn/start' && events.at(-1)?.type === 'turn/end';
      let summary;
      if (completeLifecycle) { try { summary = deriveTurnTokenUsage(events); } catch {} }
      const requests = [...projected.values()].filter(row => row.kind === 'request' && row.harnessSessionId === sessionId && row.turn === turn);
      for (const row of requests) {
        if (row.httpStatus == null && carriedHttp.has(row.id)) { row.httpStatus = carriedHttp.get(row.id); save(row); }
        else if (row.httpStatus != null) carriedHttp.set(row.id, row.httpStatus);
      }
      const matchesNative = summary && requests.every(row => row.completeness === 'complete')
        && ['inputTokens', 'outputTokens', 'totalTokens'].every(key => requests.reduce((sum, row) => sum + row.usage[key], 0)
          === summary[key === 'inputTokens' ? 'uncachedInputTokens' : key]);
      const reason = events.at(-1)?.data.reason?.kind;
      const turnStatus = !completeLifecycle ? 'pending' : reason === 'error' ? 'failed' : reason === 'aborted' ? 'interrupted' : 'succeeded';
      const knownHttp = [...requests].reverse().find(row => Number.isInteger(row.httpStatus))?.httpStatus ?? null;
      save({ ...base, id: identity(`${base.workspaceId}:${sessionId}:${turn}:turn`), kind: 'turn',
        harnessSessionId: sessionId, turn, step: null, attempt: null,
        occurredAt: Number.isSafeInteger(events[0]?.time) && events[0].time >= 0 ? events[0].time : Date.now(),
        status: turnStatus,
        httpStatus: knownHttp ?? (turnStatus === 'succeeded' ? 200 : null),
        completeness: summary ? matchesNative ? 'complete' : 'partial' : 'missing',
        usage: summary ? normalizeTokenUsage({ ...summary, inputTokens: summary.uncachedInputTokens }) : emptyTokenUsage(),
      });
    }
  }
  return Object.freeze({
    events(sessionId, values) {
      try {
        if (!sessionId || !Array.isArray(values)) return;
        if (!sessions.has(sessionId)) sessions.set(sessionId, new Map());
        for (const value of values) {
          const event = accountingEvent(value);
          if (event) sessions.get(sessionId).set(event.seq, event);
        }
        reconcile(sessionId);
        flush();
      } catch { /* Includes malformed SDK notifications; business flow is unchanged. */ }
    },
    notification(notification) {
      if (notification?.method === 'session.event') this.events(notification.params?.sessionId, [notification.params?.event]);
    },
    knownTurns(sessionId) { return new Set([...(sessions.get(sessionId)?.values() || [])].map(event => event.data.turn)); },
    hasIncomplete() { return [...projected.values()].some(row => row.completeness !== 'complete'); },
    interrupt() {
      for (const row of projected.values()) if (row.status === 'pending') row.status = 'interrupted';
      flush();
    },
    noteHttpStatus(sessionId, status) {
      const code = Number(status);
      if (!Number.isInteger(code) || code < 100 || code > 599) return;
      const open = [...projected.values()].reverse().filter(row => row.kind === 'request' && row.harnessSessionId === sessionId && row.httpStatus == null);
      const target = code < 300
        ? open.find(row => row.status === 'succeeded') || open.find(row => row.status === 'pending')
        : open.find(row => row.status !== 'succeeded');
      if (!target) return;
      target.httpStatus = code;
      carriedHttp.set(target.id, code);
      flush();
    },
  });
}
