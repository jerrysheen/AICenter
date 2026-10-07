import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client';
import { tokenUsageProjectionDefinition as projection } from '../node_modules/@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js';

import { usageFixture } from './fixtures/harness-token-usage.js';

test('installed native client reports a normal complete turn', () => {
  const events = usageFixture().filter(event => !['assistant/attempt', 'llm/retry', 'llm/retry-started'].includes(event.type));
  assert.equal(deriveTurnTokenUsage(events).totalTokens, 17);
});

test('installed native client folds failed attempt plus same-step retry, once each', () => {
  const events = usageFixture();
  assert.deepEqual(deriveTurnTokenUsage(events), { uncachedInputTokens: 20, outputTokens: 6, totalTokens: 32, cacheReadTokens: 6, cacheWriteTokens: 0 });
  const state = events.reduce((state, event) => projection.apply(state, event), projection.init());
  assert.deepEqual(projection.wire.view(state), { uncachedInputTokens: 20, outputTokens: 6, cacheReadTokens: 6, cacheWriteTokens: 0 });
});

test('native disclosure stays undefined for missing usage, lifecycle and conflicting totals', () => {
  assert.equal(deriveTurnTokenUsage(usageFixture({ missing: true })), undefined);
  assert.equal(deriveTurnTokenUsage(usageFixture().slice(1)), undefined);
  assert.equal(deriveTurnTokenUsage(usageFixture().slice(0, -1)), undefined);
  const events = usageFixture(); events[5].data.usage.totalTokens = 1;
  assert.equal(deriveTurnTokenUsage(events), undefined);
});

test('native projection replaces a settlement sample before retry-started', () => {
  const events = usageFixture();
  const first = events[2], final = { ...events[5], data: { ...events[5].data, usage: first.data.stream[0].chunk.usage } };
  const state = [first, final].reduce((state, event) => projection.apply(state, event), projection.init());
  assert.equal(projection.wire.view(state).outputTokens, 2);
});
