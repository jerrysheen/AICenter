import test from 'node:test';
import assert from 'node:assert/strict';
import { createElucidGrokAgentClient } from '../packages/connectors/src/elucid-grok-agent.js';

test('Elucid Grok adapter uses Responses tool calls and continues with function output', async () => {
  const requests = [];
  const client = createElucidGrokAgentClient({
    apiKey: 'test-key', apiRoot: 'https://example.test/v1', model: 'grok-test',
    fetch: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      const call = requests.length === 1;
      return new Response(JSON.stringify(call
        ? { id: 'resp-1', output: [{ type: 'function_call', name: 'assets_get', arguments: '{}', call_id: 'call-1' }] }
        : { id: 'resp-2', output_text: '已读取资产。', output: [] }), { status: 200 });
    },
  });
  const tools = [{ id: 'assets.get', name: 'assets_get', description: '读取资产', parameters: { type: 'object', properties: {} } }];
  const first = await client.respond({
    contents: [{ role: 'user', parts: [{ text: '我的资产' }] }],
    tools,
    budgetNote: 'Tool budget: used 0, remaining 12, max 12.',
  });
  assert.equal(first.toolCalls[0].callId, 'call-1');
  assert.match(requests[0].instructions, /remaining 12/);
  const second = await client.respond({
    contents: [
      { role: 'user', parts: [{ text: '我的资产' }] },
      first.modelContent,
      { role: 'user', parts: [{ functionResponse: { name: 'assets_get', callId: 'call-1', response: { result: { total: '1' } } } }] },
    ], tools,
  });
  assert.equal(second.text, '已读取资产。');
  assert.equal(requests[0].tools[0].name, 'assets_get');
  assert.equal(requests[1].previous_response_id, undefined);
  assert.equal(requests[1].input.find((item) => item.type === 'function_call').call_id, 'call-1');
  assert.equal(requests[1].input.find((item) => item.type === 'function_call_output').call_id, 'call-1');
});

test('Elucid Grok adapter sends the current follow-up with prior assistant semantics', async () => {
  let body;
  const client = createElucidGrokAgentClient({
    apiKey: 'test-key', apiRoot: 'https://example.test/v1', model: 'grok-test',
    fetch: async (_url, request) => {
      body = JSON.parse(request.body);
      return new Response(JSON.stringify({ output_text: '第二只是招商银行。', output: [] }), { status: 200 });
    },
  });
  await client.respond({ contents: [
    { role: 'user', parts: [{ text: '列出三只持仓' }] },
    { role: 'model', parts: [{ text: '第一只五粮液，第二只招商银行，第三只贵州茅台。' }] },
    { role: 'user', parts: [{ text: '第二只呢？' }] },
  ] });
  assert.deepEqual(body.input, [
    { role: 'user', content: '列出三只持仓' },
    { role: 'assistant', content: '第一只五粮液，第二只招商银行，第三只贵州茅台。' },
    { role: 'user', content: '第二只呢？' },
  ]);
});

test('Elucid Grok adapter preserves provider state and matches parallel results by callId', async () => {
  let body;
  const client = createElucidGrokAgentClient({
    apiKey: 'test-key', apiRoot: 'https://example.test/v1', model: 'grok-test',
    fetch: async (_url, request) => {
      body = JSON.parse(request.body);
      return new Response(JSON.stringify({ output_text: '完成', output: [] }), { status: 200 });
    },
  });
  const providerOutput = [
    { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'opaque' },
    { type: 'function_call', name: 'knowledge_get', arguments: '{"knowledgeId":"a"}', call_id: 'call-a' },
    { type: 'function_call', name: 'knowledge_get', arguments: '{"knowledgeId":"b"}', call_id: 'call-b' },
  ];
  await client.respond({ contents: [
    { role: 'user', parts: [{ text: '比较两份知识' }] },
    { role: 'model', provider: 'elucid-responses', output: providerOutput },
    { role: 'user', parts: [
      { functionResponse: { name: 'knowledge_get', callId: 'call-a', response: { result: { id: 'a' } } } },
      { functionResponse: { name: 'knowledge_get', callId: 'call-b', response: { result: { id: 'b' } } } },
    ] },
  ] });
  assert.equal(body.input.find((item) => item.type === 'reasoning').encrypted_content, 'opaque');
  assert.deepEqual(body.input.filter((item) => item.type === 'function_call_output').map((item) => [item.call_id, JSON.parse(item.output).id]), [
    ['call-a', 'a'], ['call-b', 'b'],
  ]);
});

test('Elucid Grok adapter appends budgetNote and does not send tool_choice in AUTO mode', async () => {
  let body;
  const client = createElucidGrokAgentClient({
    apiKey: 'test-key', apiRoot: 'https://example.test/v1', model: 'grok-test',
    fetch: async (_url, request) => {
      body = JSON.parse(request.body);
      return new Response(JSON.stringify({
        output: [{ type: 'function_call', name: 'web_search', arguments: '{"query":"FOMC"}', call_id: 'call-w' }],
      }), { status: 200 });
    },
  });
  await client.respond({
    contents: [{ role: 'user', parts: [{ text: '帮我搜今天加息' }] }],
    tools: [
      { name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } },
      { name: 'feed_search', description: 'local', parameters: { type: 'object', properties: {} } },
    ],
    systemInstruction: '固定系统提示',
    budgetNote: 'Tool budget: used 0, remaining 12, max 12.',
  });
  assert.match(body.instructions, /固定系统提示/);
  assert.match(body.instructions, /remaining 12/);
  assert.equal(body.tool_choice, undefined);
  assert.equal(body.tools[0].name, 'public_web_search');
  assert.equal(body.tools[1].name, 'feed_search');
});
