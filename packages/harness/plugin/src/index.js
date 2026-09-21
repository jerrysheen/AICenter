import { readFile } from 'node:fs/promises';
import { toDefineToolParameters } from '../../src/tool-catalog.js';
import { fromHarnessToolName } from '../../src/tool-id.js';

export const name = 'aicenter-tools';
export const inject = ['tools'];

async function loadCatalog() {
  const filePath = String(process.env.AI_CENTER_HARNESS_TOOL_CATALOG_PATH || '').trim();
  if (!filePath) return [];
  const text = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(text);
  return Array.isArray(parsed?.tools) ? parsed.tools : [];
}

async function callGateway(id, input, signal) {
  const url = String(process.env.AI_CENTER_HARNESS_GATEWAY_URL || '').trim();
  const token = String(process.env.AI_CENTER_HARNESS_GATEWAY_TOKEN || '').trim();
  if (!url || !token) throw new Error('AI Center Tool Gateway 未配置');
  const response = await fetch(`${url}/tools/execute`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id, input: input || {} }),
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `Gateway ${response.status}`);
  }
  return body.result;
}

export async function apply(ctx) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  const catalog = await loadCatalog();
  for (const tool of catalog) {
    const id = fromHarnessToolName(tool.id || tool.name);
    if (!id) continue;
    ctx.tools.register(defineTool({
      name: tool.name || id.replaceAll('.', '_'),
      description: tool.description || id,
      parameters: toDefineToolParameters(tool.parameters),
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        return callGateway(id, args, exec?.signal);
      },
    }));
  }
}
