import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseContract, AgentResearchProfileSchema, ValidationError } from '../packages/contracts/src/index.js';
import { createStore } from '../packages/database/src/index.js';
import { createRuntimeService, resolveResearchProfile } from '../packages/domain/src/index.js';
import { modelIdForProfile } from '../packages/connectors/src/agent-model-profile.js';
import { createAgentRuntime, toolsVisibleForResearchProfile } from '../packages/runtime/src/agent-runtime.js';
import { createToolRegistry } from '../packages/runtime/src/tool-registry.js';
import { buildAgentSystemInstruction } from '../packages/runtime/src/agent-prompt.js';

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'ai-center-research-'));
}

test('research profile defaults to standard and opens reserved research hooks', () => {
  assert.deepEqual(resolveResearchProfile(), {
    mode: 'standard',
    modelProfile: 'default',
    methodKeywords: [],
    extraToolIds: [],
    thinking: 'standard',
  });
  assert.deepEqual(resolveResearchProfile('research', {
    methodKeywords: [' 文献综述 ', '文献综述', '', 'triangulation'],
    extraToolIds: ['research.notes', 'research.notes'],
  }), {
    mode: 'research',
    modelProfile: 'research',
    methodKeywords: ['文献综述', 'triangulation'],
    extraToolIds: ['research.notes'],
    thinking: 'deliberate',
  });
  assert.equal(resolveResearchProfile('other').mode, 'standard');
  assert.throws(() => parseContract(AgentResearchProfileSchema, {
    mode: 'research',
    modelProfile: 'grok-huge',
    methodKeywords: [],
    extraToolIds: [],
    thinking: 'deliberate',
  }), ValidationError);
});

test('runtime service persists the resolved research profile on the job', () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  try {
    const runtime = createRuntimeService({ runtimeRepository: store });
    const job = runtime.requestAgentRun({
      message: '拆一下供给',
      webMode: 'fallback',
      researchMode: 'research',
      workspaceId: 'local',
    });
    assert.equal(job.input.researchMode, 'research');
    assert.deepEqual(job.input.researchProfile, {
      mode: 'research',
      modelProfile: 'research',
      methodKeywords: [],
      extraToolIds: [],
      thinking: 'deliberate',
    });
    const stored = store.getJob(job.id);
    assert.equal(stored.input.researchProfile.modelProfile, 'research');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('research-only tools stay hidden until extraToolIds names them', () => {
  const tools = [
    { id: 'knowledge.search' },
    { id: 'research.notes', researchOnly: true },
  ];
  assert.deepEqual(toolsVisibleForResearchProfile(tools).map((tool) => tool.id), ['knowledge.search']);
  assert.deepEqual(
    toolsVisibleForResearchProfile(tools, { extraToolIds: ['research.notes'] }).map((tool) => tool.id),
    ['knowledge.search', 'research.notes'],
  );
});

test('research mode reaches the model request and prompt without inventing methods', async () => {
  let seen;
  const tools = createToolRegistry();
  tools.register({
    id: 'knowledge.search', effect: 'read', description: 'search',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ data: {}, refs: [], observedAt: 1, warnings: [] }),
  });
  tools.register({
    id: 'research.notes', effect: 'read', description: 'reserved notes',
    researchOnly: true,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ data: {}, refs: [], observedAt: 1, warnings: [] }),
  });
  const runtime = createAgentRuntime({
    tools,
    llm: {
      respond: async (request) => {
        seen = request;
        return { text: '先界定未知项', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  await runtime.run({
    message: '研究一下供给',
    workspaceId: 'local',
    researchMode: 'research',
  });
  assert.equal(seen.researchMode, 'research');
  assert.equal(seen.researchProfile.modelProfile, 'research');
  assert.match(seen.systemInstruction, /专业研究模式/);
  assert.equal(seen.tools.some((tool) => tool.id === 'research.notes'), false);
  assert.match(buildAgentSystemInstruction('off', {
    mode: 'research',
    methodKeywords: ['对照实验'],
  }), /对照实验/);
});

test('model profile only switches when a research model id is configured', () => {
  assert.equal(modelIdForProfile('grok-4.6', '', { modelProfile: 'research' }), 'grok-4.6');
  assert.equal(modelIdForProfile('grok-4.6', 'grok-research', { modelProfile: 'research' }), 'grok-research');
  assert.equal(modelIdForProfile('grok-4.6', 'grok-research', { modelProfile: 'default' }), 'grok-4.6');
});
