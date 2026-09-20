import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiAgentClient, geminiParameters, geminiToolConfig } from '../packages/connectors/src/gemini-agent.js';

test('geminiParameters keeps required arrays and strips additionalProperties', () => {
  assert.deepEqual(geminiParameters({
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  }), {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  });
});

test('geminiToolConfig forces ANY with allowed function names', () => {
  assert.equal(geminiToolConfig(null), undefined);
  assert.deepEqual(geminiToolConfig({ mode: 'required', names: ['web_search'] }), {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['web_search'] },
  });
});

test('Gemini adapter sends tools in AUTO mode, budgetNote, and ignores thought-only text', async () => {
  let body;
  const client = createGeminiAgentClient({
    apiKey: 'test-key', apiRoot: 'https://example.test/v1beta', model: 'gemini-test',
    fetch: async (_url, request) => {
      body = JSON.parse(request.body);
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { thought: true, text: '先想一下' },
              { functionCall: { name: 'web_search', args: { query: 'FOMC' } } },
            ],
          },
        }],
      }), { status: 200 });
    },
  });
  const result = await client.respond({
    contents: [{ role: 'user', parts: [{ text: '帮我搜今天加息' }] }],
    tools: [{
      name: 'web_search',
      description: 'search',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
    }, {
      name: 'feed_search',
      description: 'local feed',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    }],
    systemInstruction: '固定系统提示',
    budgetNote: 'Tool budget: used 0, remaining 12, max 12.',
  });
  assert.match(body.systemInstruction.parts[0].text, /固定系统提示/);
  assert.match(body.systemInstruction.parts[0].text, /remaining 12/);
  assert.equal(body.toolConfig, undefined);
  assert.equal(body.tools[0].functionDeclarations.length, 2);
  assert.equal(body.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
  assert.equal(result.text, '');
  assert.equal(result.toolCalls[0].name, 'web_search');
});

test('Gemini adapter uses the reserved research model only when configured', async () => {
  const urls = [];
  const client = createGeminiAgentClient({
    apiKey: 'test-key', apiRoot: 'https://example.test/v1beta',
    model: 'gemini-lite', researchModel: 'gemini-research',
    fetch: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      }), { status: 200 });
    },
  });
  const standard = await client.respond({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
  const research = await client.respond({
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    researchProfile: { modelProfile: 'research' },
  });
  assert.match(urls[0], /gemini-lite/);
  assert.match(urls[1], /gemini-research/);
  assert.equal(standard.modelId, 'gemini-lite');
  assert.equal(research.modelId, 'gemini-research');
});
