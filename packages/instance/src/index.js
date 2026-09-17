import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function text(value) {
  return String(value ?? '').trim();
}

function firstText(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return '';
}

function resolveFrom(repositoryRoot, value) {
  const normalized = text(value);
  if (!normalized) return '';
  return path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.resolve(repositoryRoot, normalized);
}

function resolvePort(value, fallback = 8787) {
  const normalized = text(value);
  const port = normalized ? Number(normalized) : fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('AI_CENTER_PORT 必须是 1-65535 的整数');
  }
  return port;
}

function parseDotEnv(source) {
  const values = {};
  for (const line of String(source || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readDotEnv(filePath, { exists, readFile }) {
  if (!exists(filePath)) return {};
  return parseDotEnv(readFile(filePath, 'utf8'));
}

function explicitEnvironment(overrides = {}) {
  const values = { ...(overrides.env || {}) };
  for (const [key, value] of Object.entries(overrides)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) values[key] = value;
  }
  const instanceRoot = firstText(overrides.instanceRoot, overrides.instanceDirectory);
  if (instanceRoot) values.AI_CENTER_INSTANCE_DIR = instanceRoot;
  if (text(overrides.instanceId)) values.AI_CENTER_INSTANCE_ID = overrides.instanceId;
  if (text(overrides.browserId)) values.AI_CENTER_BROWSER_ID = overrides.browserId;
  if (text(overrides.port)) values.AI_CENTER_PORT = overrides.port;
  return values;
}

/**
 * Loads repository and instance .env files into the supplied environment map.
 * Only path metadata is returned; environment values (which may include secrets)
 * remain in the caller-owned map and are never copied into the result.
 */
export function loadInstanceEnvironment(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot || process.cwd());
  const env = options.env || process.env;
  const exists = options.exists || existsSync;
  const readFile = options.readFile || readFileSync;
  const overrides = explicitEnvironment(options.overrides);
  const initialEnvironment = { ...env };
  const repositoryEnvPath = path.join(repositoryRoot, '.env');
  const repositoryValues = readDotEnv(repositoryEnvPath, { exists, readFile });

  // The instance file cannot relocate itself. Its root must be bootstrapped by
  // an explicit override, the process environment, or the repository .env.
  const configuredRoot = firstText(
    overrides.AI_CENTER_INSTANCE_DIR,
    initialEnvironment.AI_CENTER_INSTANCE_DIR,
    repositoryValues.AI_CENTER_INSTANCE_DIR,
  );
  const legacyLayout = !configuredRoot;
  const instanceRoot = configuredRoot
    ? resolveFrom(repositoryRoot, configuredRoot)
    : repositoryRoot;
  const instanceEnvPath = path.join(instanceRoot, '.env');
  const instanceValues = instanceEnvPath === repositoryEnvPath
    ? {}
    : readDotEnv(instanceEnvPath, { exists, readFile });
  delete instanceValues.AI_CENTER_INSTANCE_DIR;

  const merged = {
    ...repositoryValues,
    ...instanceValues,
  };
  for (const [key, value] of Object.entries(initialEnvironment)) {
    if (text(value)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (text(value)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(merged)) {
    if (text(value)) env[key] = String(value);
  }

  if (configuredRoot) env.AI_CENTER_INSTANCE_DIR = configuredRoot;

  return Object.freeze({
    repositoryRoot,
    instanceRoot,
    legacyLayout,
    repositoryEnvPath,
    instanceEnvPath,
  });
}

/**
 * Resolves all single-user instance paths without creating directories or files.
 */
export function resolveInstanceConfig(options = {}) {
  const env = options.env || process.env;
  const overrides = options.overrides || {};
  const loaded = loadInstanceEnvironment({
    repositoryRoot: options.repositoryRoot,
    env,
    overrides,
    exists: options.exists,
    readFile: options.readFile,
  });
  const { repositoryRoot, instanceRoot, legacyLayout } = loaded;

  const dataDirectory = resolveFrom(repositoryRoot, firstText(
    overrides.dataDirectory,
    env.AI_CENTER_DATA_DIR,
    path.join(instanceRoot, 'data'),
  ));
  const knowledgeDirectory = resolveFrom(repositoryRoot, firstText(
    overrides.knowledgeDirectory,
    env.AI_CENTER_KNOWLEDGE_DIR,
    path.join(instanceRoot, 'knowledge'),
  ));
  const configDirectory = resolveFrom(repositoryRoot, firstText(
    overrides.configDirectory,
    path.join(instanceRoot, 'config'),
  ));
  const importsDirectory = resolveFrom(repositoryRoot, firstText(
    overrides.importsDirectory,
    legacyLayout ? path.join(dataDirectory, 'imports') : path.join(instanceRoot, 'imports'),
  ));
  const runtimeDirectory = resolveFrom(repositoryRoot, firstText(
    overrides.runtimeDirectory,
    legacyLayout ? path.join(repositoryRoot, '.ai-data') : path.join(instanceRoot, 'runtime'),
  ));
  const instanceId = firstText(
    overrides.instanceId,
    env.AI_CENTER_INSTANCE_ID,
    legacyLayout ? 'local' : path.basename(instanceRoot),
  );
  const browserId = firstText(overrides.browserId, env.AI_CENTER_BROWSER_ID);
  const port = resolvePort(firstText(overrides.port, env.AI_CENTER_PORT));

  return Object.freeze({
    instanceId,
    port,
    repositoryRoot,
    instanceRoot,
    legacyLayout,
    dataDirectory,
    databasePath: resolveFrom(repositoryRoot, firstText(
      overrides.databasePath,
      path.join(dataDirectory, 'ai-center.db'),
    )),
    knowledgeDirectory,
    configDirectory,
    importsDirectory,
    runtimeDirectory,
    tagCatalogPath: resolveFrom(repositoryRoot, firstText(
      overrides.tagCatalogPath,
      path.join(configDirectory, 'tags.json'),
    )),
    marketCatalogPath: resolveFrom(repositoryRoot, firstText(
      overrides.marketCatalogPath,
      path.join(configDirectory, 'markets.json'),
    )),
    taxonomyCatalogPath: resolveFrom(repositoryRoot, firstText(
      overrides.taxonomyCatalogPath,
      path.join(configDirectory, 'taxonomy.json'),
    )),
    assetWorkbookPath: resolveFrom(repositoryRoot, firstText(
      overrides.assetWorkbookPath,
      env.AI_CENTER_ASSET_WORKBOOK,
      path.join(importsDirectory, 'personal-assets.xlsx'),
    )),
    repositoryEnvPath: loaded.repositoryEnvPath,
    instanceEnvPath: loaded.instanceEnvPath,
    browserId,
  });
}
