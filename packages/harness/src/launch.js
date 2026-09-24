import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  HARNESS_PACKAGE_VERSION,
  HARNESS_PROFILE,
} from './constants.js';
import { resolveHarnessLlm } from './llm-route.js';
import { resolveHarnessWebSearchProvider } from './web-search-elucid.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const RELATIVE_PLUGINS = Object.freeze([
  './plugin/src/index.js',
  './plugin/src/web-search-elucid.js',
]);

export function harnessPatchPath() {
  return path.resolve(currentDirectory, '../aicenter.cordis.yml');
}

export function harnessPluginPath() {
  return path.resolve(currentDirectory, '../plugin/src/index.js');
}

export function harnessSearchPluginPath() {
  return path.resolve(currentDirectory, '../plugin/src/web-search-elucid.js');
}

export function harnessDshEntryPath() {
  return path.resolve(currentDirectory, 'dsh-entry.js');
}

export function harnessPluginSpecifier(pluginPath = harnessPluginPath()) {
  return pathToFileURL(pluginPath).href;
}

export function materializeHarnessPatch(sourceText, pluginPath = harnessPluginPath()) {
  const replacements = new Map([
    [RELATIVE_PLUGINS[0], pluginPath],
    [RELATIVE_PLUGINS[1], harnessSearchPluginPath()],
  ]);
  let text = String(sourceText || '');
  for (const relative of RELATIVE_PLUGINS) {
    if (!text.includes(`name: ${relative}`)) {
      throw new Error(`Harness overlay 缺少 ${relative} 插入项`);
    }
    text = text.replaceAll(
      `name: ${relative}`,
      `name: ${JSON.stringify(harnessPluginSpecifier(replacements.get(relative)))}`,
    );
  }
  return text;
}

const CLOSED_CONTEXT_PERSONA = [
  '本任务是封闭材料任务。',
  '只能依据用户消息中的给定材料。',
  '本轮没有开放任何外部工具或互联网能力。',
  '材料没有的信息必须保持未知。',
].join('\n');

/**
 * Closed-context engine overlay: Domain catalog may be empty, and the native
 * web tool package is disabled so the session never registers web search/fetch.
 */
export function materializeClosedContextPatch(sourceText, pluginPath = harnessPluginPath()) {
  let text = materializeHarnessPatch(sourceText, pluginPath).replaceAll('\r\n', '\n');
  text = text.replace(
    /personaPrefix: \|\n(?:[ \t]+.*\n)+/,
    `personaPrefix: |\n${CLOSED_CONTEXT_PERSONA.split('\n').map((line) => `      ${line}`).join('\n')}\n`,
  );
  text = text.replace(/\n[ \t]*- id: web-search-elucid\n[ \t]*name: .+\n/, '\n');
  text = text.replace(
    /# Leave @deepseek-ai\/dsh-tool-web enabled\. Domain tools stay on the Tool Gateway\./,
    '# Closed context disables native web tools. Domain tools stay on the Tool Gateway.',
  );
  text += [
    '',
    '- id: tool-web',
    "  name: '@deepseek-ai/dsh-tool-web'",
    '  disabled: true',
    '',
    '- id: web-search-deepseek',
    "  name: '@deepseek-ai/dsh-web-search-deepseek'",
    '  disabled: true',
    '',
    '- id: web-fetch-http',
    "  name: '@deepseek-ai/dsh-web-fetch-http'",
    '  disabled: true',
    '',
  ].join('\n');
  text = text.split('\n').filter((line) => !/web_search|web_fetch/.test(line)).join('\n');
  if (!/id: tool-web[\s\S]*disabled: true/.test(text)) {
    throw new Error('closed-context overlay 未能禁用 tool-web');
  }
  return text;
}

export function buildHarnessChildEnv({
  env = process.env,
  gateway,
  catalogPath,
  workspaceId,
} = {}) {
  if (!gateway?.url || !gateway?.token) throw new Error('Harness 子进程需要 Tool Gateway');
  if (!catalogPath) throw new Error('Harness 子进程需要工具目录文件');
  return {
    ...env,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_PERMISSION_MODE: 'read-only',
    AI_CENTER_HARNESS_GATEWAY_URL: gateway.url,
    AI_CENTER_HARNESS_GATEWAY_TOKEN: gateway.token,
    AI_CENTER_HARNESS_TOOL_CATALOG_PATH: catalogPath,
    AI_CENTER_HARNESS_WORKSPACE_ID: String(workspaceId || ''),
    DSH_WEB_SEARCH_PROVIDER: resolveHarnessWebSearchProvider(env),
  };
}

export function resolveHarnessLaunch({
  env = process.env,
  runtimeDirectory,
  cwd,
  dshHome,
  gateway,
  catalogPath,
  overlayPath,
  workspaceId,
  researchProfile,
} = {}) {
  const home = dshHome || path.join(runtimeDirectory, 'dsh-home');
  const workspace = cwd || path.join(runtimeDirectory, 'dsh-workspace');
  const llm = resolveHarnessLlm(env, { researchProfile });
  return {
    profile: HARNESS_PROFILE,
    dshBin: harnessDshEntryPath(),
    patches: [overlayPath || harnessPatchPath()],
    dshHome: home,
    cwd: workspace,
    processCwd: workspace,
    provider: llm.provider,
    model: llm.model,
    llm,
    initializeTimeoutMs: Number(env.AI_CENTER_HARNESS_INIT_TIMEOUT_MS) || 120_000,
    env: buildHarnessChildEnv({ env, gateway, catalogPath, workspaceId }),
    packageVersion: HARNESS_PACKAGE_VERSION,
  };
}
