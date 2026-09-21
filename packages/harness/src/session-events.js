import { fromHarnessToolName } from './tool-id.js';
import { isHarnessWebToolId } from './web-infra.js';

function eventType(event) {
  return String(event?.type || event?.event || event?.kind || '').trim();
}

function eventPayload(event) {
  if (event?.event && typeof event.event === 'object') return event.event;
  return event || {};
}

function eventData(event) {
  const payload = eventPayload(event);
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
}

function preview(text, max = 100) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function assistantText(event) {
  const payload = eventData(event);
  if (typeof payload.text === 'string') return payload.text;
  const message = payload.message;
  const content = payload.content || message?.content || payload.blocks;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    return block?.text || block?.content || '';
  }).filter(Boolean).join('');
}

function parseArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function assistantToolCalls(event) {
  const payload = eventData(event);
  const content = payload.message?.content || payload.content || [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === 'tool-call')
    .map((block) => ({
      callId: block.id || null,
      name: fromHarnessToolName(block.name),
      id: fromHarnessToolName(block.name),
      args: parseArguments(block.arguments),
    }));
}

function resultCallId(event) {
  const payload = eventData(event);
  return payload.callId
    || payload.id
    || payload.message?.source?.callId
    || payload.message?.content?.find?.((block) => block?.type === 'tool-result')?.toolCallId
    || null;
}

function resultFailed(event) {
  const payload = eventData(event);
  return Boolean(
    payload.isError === true
    || payload.error
    || payload.message?.content?.some?.((block) => block?.type === 'tool-result' && block.isError === true),
  );
}

function resultErrorMessage(event) {
  const payload = eventData(event);
  const declared = payload.error?.reason || payload.error?.message;
  if (declared) return String(declared);
  const result = payload.message?.content?.find?.((block) => block?.type === 'tool-result');
  const text = Array.isArray(result?.content)
    ? result.content.map((block) => block?.type === 'text' ? block.text : '').filter(Boolean).join(' ')
    : '';
  return text || String(payload.error || '工具失败');
}

function summarizeWebSearch(toolResult) {
  const rows = Array.isArray(toolResult?.data?.results) ? toolResult.data.results : [];
  return {
    available: toolResult?.data?.available !== false && !toolResult?.error,
    resultCount: rows.length,
  };
}

export function notificationToTraceEvents(notification, projector = null) {
  if (notification?.method === 'session.status') {
    return [{ event: 'harness.status', detail: notification.params || {} }];
  }
  if (notification?.method !== 'session.event') return [];
  const event = notification.params?.event || notification.params;
  return projector?.project
    ? projector.project([event])
    : projectHarnessTraceEvents([event]);
}

/**
 * Project Harness session.event notifications onto the existing agent-trace-log
 * vocabulary so the Ask UI can keep using progress steps.
 */
export function createHarnessTraceProjector() {
  let round = -1;
  const calls = new Map();

  return Object.freeze({
    project(events = []) {
      const traces = [];
      for (const event of events) {
        const type = eventType(event);
        const payload = eventData(event);
        if (type === 'step/start') {
          round += 1;
          traces.push({
            event: 'model.requested',
            detail: { round, harnessEvent: type },
          });
          continue;
        }
        if (type === 'tool/call') {
          const id = fromHarnessToolName(payload.name || payload.toolName || payload.tool);
          const callId = payload.callId || payload.id || null;
          const input = parseArguments(payload.arguments || payload.args || payload.input);
          if (callId) calls.set(String(callId), { id, input, round: Math.max(0, round) });
          traces.push({
            event: 'tool.started',
            detail: {
              round: Math.max(0, round),
              callId,
              id,
              input,
            },
          });
          continue;
        }
        if (type === 'tool/result' && resultFailed(event)) {
          const callId = resultCallId(event);
          const call = callId ? calls.get(String(callId)) : null;
          traces.push({
            event: 'tool.failed',
            detail: {
              round: call?.round ?? Math.max(0, round),
              callId,
              id: call?.id || fromHarnessToolName(payload.name || payload.toolName || payload.tool),
              input: call?.input || {},
              error: {
                message: resultErrorMessage(event),
              },
            },
          });
          if (callId) calls.delete(String(callId));
          continue;
        }
        if (type === 'tool/result') {
          const callId = resultCallId(event);
          const call = callId ? calls.get(String(callId)) : null;
          const id = call?.id || fromHarnessToolName(payload.name || payload.toolName || payload.tool);
          if (isHarnessWebToolId(id)) {
            traces.push({
              event: 'tool.completed',
              detail: {
                round: call?.round ?? Math.max(0, round),
                callId,
                id,
                input: call?.input || {},
                data: {},
                refs: [],
                warnings: [],
              },
            });
          }
          if (callId) calls.delete(String(callId));
          continue;
        }
        if (type === 'assistant/message') {
          traces.push({
            event: 'model.responded',
            detail: {
              round: Math.max(0, round),
              answerPreview: preview(assistantText(event)),
              toolCalls: assistantToolCalls(event),
              harnessEvent: type,
            },
          });
        }
      }
      return traces;
    },
  });
}

export function projectHarnessTraceEvents(events = []) {
  return createHarnessTraceProjector().project(events);
}

export function collectToolCallsFromGateway(executions = []) {
  return executions.map((item, index) => ({
    callId: `harness-${index + 1}`,
    id: item.id,
    name: item.id,
    args: item.input || {},
    result: item.result,
    durationMs: item.durationMs,
    ...(item.id === 'web.search' || item.id === 'web.fetch' ? { webSearch: summarizeWebSearch(item.result) } : {}),
  }));
}
