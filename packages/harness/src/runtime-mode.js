import { HARNESS_RUNTIME_MODES } from './constants.js';

export function parseAgentRuntimeMode(value, fallback = 'harness') {
  const mode = String(value || '').trim().toLowerCase();
  if (HARNESS_RUNTIME_MODES.includes(mode)) return mode;
  return fallback === 'local' ? 'local' : 'harness';
}

/**
 * Production Ask / article-analysis executor is DeepSeek Harness.
 * Tests that inject a fake LLM client stay on the local loop.
 */
export function resolveAgentRuntimeMode(options = {}, env = process.env) {
  if (options.agentRuntime) return 'injected';
  if (options.agentRuntimeMode) return parseAgentRuntimeMode(options.agentRuntimeMode, 'harness');
  if (options.agentClient && options.forceHarness !== true) return 'local';
  return parseAgentRuntimeMode(env.AI_CENTER_AGENT_RUNTIME, 'harness');
}

export function parseHarnessToolIds(value, fallback = []) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  }
  const text = String(value || '').trim();
  if (!text || text === '*') return [...fallback];
  return [...new Set(text.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean))];
}

export function resolveHarnessToolIds(tools, configured, fallbackIds = []) {
  const explicit = parseHarnessToolIds(configured, []);
  if (explicit.length) return explicit;
  if (fallbackIds.length) return [...fallbackIds];
  const list = typeof tools?.list === 'function' ? tools.list() : [];
  return list.map((tool) => String(tool.id || '').trim()).filter(Boolean);
}
