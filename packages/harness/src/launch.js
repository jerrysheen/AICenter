import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  HARNESS_PACKAGE_VERSION,
  HARNESS_PROFILE,
} from './constants.js';
import { resolveHarnessLlm } from './llm-route.js';
import {
  HARNESS_ELUCID_SEARCH_PROVIDER_ID,
  resolveHarnessWebSearchProvider,
} from './web-search-elucid.js';

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

function normalizeOverlayNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function applyWebSearchProvider(text, env) {
  const provider = resolveHarnessWebSearchProvider(env);
  if (provider !== HARNESS_ELUCID_SEARCH_PROVIDER_ID) {
    throw new Error(`问答联网搜索只使用 ${HARNESS_ELUCID_SEARCH_PROVIDER_ID}，不会回退到 DeepSeek 搜索`);
  }
  const block = /- id: web\r?\n  name: '@deepseek-ai\/dsh-web'\r?\n  config:\r?\n    searchProvider: \S+\r?\n    fetchProvider: http\r?\n/;
  if (!block.test(text)) throw new Error('Harness overlay 缺少 web.searchProvider 覆盖');
  const next = text.replace(
    /(- id: web\r?\n  name: '@deepseek-ai\/dsh-web'\r?\n  config:\r?\n    searchProvider: )\S+/,
    `$1${provider}`,
  );
  if (!/- id: web-search-deepseek\r?\n  name: '@deepseek-ai\/dsh-web-search-deepseek'\r?\n  disabled: true\r?\n/.test(next)) {
    throw new Error('Harness overlay 未禁用 web-search-deepseek');
  }
  if (/searchProvider:\s*deepseek-official/.test(next)) {
    throw new Error('Harness overlay 仍把 web.searchProvider 写成 deepseek-official');
  }
  return next;
}

export function materializeHarnessPatch(sourceText, pluginPath = harnessPluginPath(), env = process.env) {
  const replacements = new Map([
    [RELATIVE_PLUGINS[0], pluginPath],
    [RELATIVE_PLUGINS[1], harnessSearchPluginPath()],
  ]);
  let text = normalizeOverlayNewlines(sourceText);
  for (const relative of RELATIVE_PLUGINS) {
    if (!text.includes(`name: ${relative}`)) {
      throw new Error(`Harness overlay 缺少 ${relative} 插入项`);
    }
    text = text.replaceAll(
      `name: ${relative}`,
      `name: ${JSON.stringify(harnessPluginSpecifier(replacements.get(relative)))}`,
    );
  }
  return applyWebSearchProvider(text, env);
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
function appendMissingDisabledPlugins(text) {
  const rows = [
    ['tool-web', "'@deepseek-ai/dsh-tool-web'"],
    ['web-search-deepseek', "'@deepseek-ai/dsh-web-search-deepseek'"],
    ['web-fetch-http', "'@deepseek-ai/dsh-web-fetch-http'"],
  ].filter(([id]) => !new RegExp(`- id: ${id}\\n`).test(text));
  if (!rows.length) return text;
  return `${text}${[
    '',
    ...rows.flatMap(([id, name]) => [
      `- id: ${id}`,
      `  name: ${name}`,
      '  disabled: true',
      '',
    ]),
  ].join('\n')}`;
}

export function materializeClosedContextPatch(sourceText, pluginPath = harnessPluginPath(), env = process.env) {
  let text = materializeHarnessPatch(sourceText, pluginPath, env).replaceAll('\r\n', '\n');
  text = text.replace(
    /personaPrefix: \|\n(?:[ \t]+.*\n)+/,
    `personaPrefix: |\n${CLOSED_CONTEXT_PERSONA.split('\n').map((line) => `      ${line}`).join('\n')}\n`,
  );
  text = text.replace(/\n[ \t]*- id: web-search-elucid\n[ \t]*name: .+\n/, '\n');
  text = text.replace(
    /# Leave @deepseek-ai\/dsh-tool-web enabled\. Domain tools stay on the Tool Gateway\./,
    '# Closed context disables native web tools. Domain tools stay on the Tool Gateway.',
  );
  text = appendMissingDisabledPlugins(text);
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
  closedTask,
} = {}) {
  const home = dshHome || path.join(runtimeDirectory, 'dsh-home');
  const workspace = cwd || path.join(runtimeDirectory, 'dsh-workspace');
  const llm = resolveHarnessLlm(env, { researchProfile, closedTask });
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
