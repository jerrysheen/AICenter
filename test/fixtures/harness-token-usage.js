export function usageFixture({ missing = false } = {}) {
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 15 };
  const events = [
    ['turn/start', {}], ['step/start', { step: 1 }],
    ['assistant/attempt', { step: 1, stream: missing ? [] : [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage } }] }],
    ['llm/retry', { step: 1 }], ['llm/retry-started', { step: 1 }],
    ['assistant/message', { step: 1, usage: { ...usage, outputTokens: 4, totalTokens: 17 }, stream: [], message: { id: 'fixture-message', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'fixture' }] } }],
    ['step/end', { step: 1 }], ['turn/end', { reason: { kind: 'completed' } }],
  ];
  return events.map(([type, data], seq) => ({ type, seq, time: seq, data: { turn: 1, ...data }, ...(type === 'assistant/message' ? { surfaceOp: 'append' } : {}) }));
}
