import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElucidGrokAgentClient } from '../packages/connectors/src/elucid-grok-agent.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function summarizeOutput(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  return {
    status: payload?.status || null,
    outputTypes: output.map((item) => item?.type || typeof item),
    functionCalls: output.filter((item) => item?.type === 'function_call').map((item) => ({
      name: item.name,
      arguments: String(item.arguments || '').slice(0, 300),
    })),
    text: String(payload?.output_text || '').slice(0, 200),
  };
}

resolveInstanceConfig({ repositoryRoot });

const probe = String(process.argv[2] || 'A').toUpperCase();
const webSearchTool = {
  name: 'web_search',
  description: 'Search the public web for titles, URLs and snippets. This is AI Center public_web_search, not a built-in provider search.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

const probes = {
  A: {
    message: '回复 OK',
    tools: [],
    toolChoice: null,
    timeoutMs: 60_000,
  },
  B: {
    message: 'Call public_web_search for today US Federal Reserve rate decision.',
    tools: [webSearchTool],
    toolChoice: null,
    timeoutMs: 60_000,
  },
  C: {
    message: 'Search today US Federal Reserve rate decision.',
    tools: [webSearchTool],
    toolChoice: { mode: 'required', names: ['web_search'] },
    timeoutMs: 60_000,
  },
};

const spec = probes[probe];
if (!spec) {
  console.error('Usage: node scripts/elucid-web-search-probes.mjs A|B|C');
  process.exit(1);
}

let captured;
const client = createElucidGrokAgentClient({
  timeoutMs: spec.timeoutMs,
  fetch: async (url, request) => {
    captured = {
      url: String(url),
      bytes: Buffer.byteLength(request.body || '', 'utf8'),
      body: JSON.parse(request.body),
    };
    const started = Date.now();
    const response = await fetch(url, request);
    const raw = await response.text();
    let payload = null;
    try { payload = JSON.parse(raw); } catch { payload = { raw: raw.slice(0, 500) }; }
    captured.httpStatus = response.status;
    captured.elapsedMs = Date.now() - started;
    captured.response = summarizeOutput(payload);
    return new Response(raw, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  },
});

const started = Date.now();
try {
  const result = await client.respond({
    contents: [{ role: 'user', parts: [{ text: spec.message }] }],
    tools: spec.tools,
    toolChoice: spec.toolChoice,
    timeoutMs: spec.timeoutMs,
    systemInstruction: 'You are a tool-using assistant. Never use built-in web_search. If you need the public web, call the public_web_search function.',
  });
  console.log(JSON.stringify({
    probe,
    ok: true,
    elapsedMs: Date.now() - started,
    requestBytes: captured?.bytes,
    toolCount: captured?.body?.tools?.length || 0,
    toolChoice: captured?.body?.tool_choice || null,
    httpStatus: captured?.httpStatus,
    providerElapsedMs: captured?.elapsedMs,
    response: captured?.response,
    parsedToolCalls: result.toolCalls,
    text: String(result.text || '').slice(0, 200),
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    probe,
    ok: false,
    elapsedMs: Date.now() - started,
    requestBytes: captured?.bytes,
    toolCount: captured?.body?.tools?.length || 0,
    toolChoice: captured?.body?.tool_choice || null,
    httpStatus: captured?.httpStatus || null,
    providerElapsedMs: captured?.elapsedMs || null,
    response: captured?.response || null,
    error: String(error.message || error),
  }, null, 2));
  process.exitCode = 1;
}
