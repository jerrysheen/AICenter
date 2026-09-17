import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadInstanceEnvironment, resolveInstanceConfig } from '../packages/instance/src/index.js';

function temporaryRepository() {
  return mkdtempSync(path.join(os.tmpdir(), 'ai-center-instance-'));
}

test('legacy layout preserves all existing single-user paths', () => {
  const repositoryRoot = temporaryRepository();
  try {
    const config = resolveInstanceConfig({ repositoryRoot, env: {} });
    assert.equal(config.instanceId, 'local');
    assert.equal(config.port, 8787);
    assert.equal(config.instanceRoot, repositoryRoot);
    assert.equal(config.legacyLayout, true);
    assert.equal(config.dataDirectory, path.join(repositoryRoot, 'data'));
    assert.equal(config.databasePath, path.join(repositoryRoot, 'data', 'ai-center.db'));
    assert.equal(config.knowledgeDirectory, path.join(repositoryRoot, 'knowledge'));
    assert.equal(config.configDirectory, path.join(repositoryRoot, 'config'));
    assert.equal(config.importsDirectory, path.join(repositoryRoot, 'data', 'imports'));
    assert.equal(config.runtimeDirectory, path.join(repositoryRoot, '.ai-data'));
    assert.equal(config.tagCatalogPath, path.join(repositoryRoot, 'config', 'tags.json'));
    assert.equal(config.marketCatalogPath, path.join(repositoryRoot, 'config', 'markets.json'));
    assert.equal(config.taxonomyCatalogPath, path.join(repositoryRoot, 'config', 'taxonomy.json'));
    assert.equal(config.assetWorkbookPath, path.join(repositoryRoot, 'data', 'imports', 'personal-assets.xlsx'));
    assert.equal(config.repositoryEnvPath, path.join(repositoryRoot, '.env'));
    assert.equal(config.instanceEnvPath, path.join(repositoryRoot, '.env'));
    assert.equal(config.browserId, '');
    assert.equal(Object.isFrozen(config), true);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('explicit instance root uses the instance directory layout', () => {
  const repositoryRoot = temporaryRepository();
  try {
    const config = resolveInstanceConfig({
      repositoryRoot,
      env: {
        AI_CENTER_INSTANCE_DIR: 'instances/lily',
        AI_CENTER_INSTANCE_ID: 'primary',
        AI_CENTER_BROWSER_ID: 'chrome-lily',
      },
    });
    const instanceRoot = path.join(repositoryRoot, 'instances', 'lily');
    assert.equal(config.instanceRoot, instanceRoot);
    assert.equal(config.legacyLayout, false);
    assert.equal(config.instanceId, 'primary');
    assert.equal(config.browserId, 'chrome-lily');
    assert.equal(config.dataDirectory, path.join(instanceRoot, 'data'));
    assert.equal(config.knowledgeDirectory, path.join(instanceRoot, 'knowledge'));
    assert.equal(config.configDirectory, path.join(instanceRoot, 'config'));
    assert.equal(config.importsDirectory, path.join(instanceRoot, 'imports'));
    assert.equal(config.runtimeDirectory, path.join(instanceRoot, 'runtime'));
    assert.equal(config.assetWorkbookPath, path.join(instanceRoot, 'imports', 'personal-assets.xlsx'));
    assert.equal(config.instanceEnvPath, path.join(instanceRoot, '.env'));
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('environment loading uses explicit, process, instance, repository precedence', () => {
  const repositoryRoot = temporaryRepository();
  const instanceRoot = path.join(repositoryRoot, 'instances', 'from-repository');
  mkdirSync(instanceRoot, { recursive: true });
  writeFileSync(path.join(repositoryRoot, '.env'), [
    'AI_CENTER_INSTANCE_DIR=instances/from-repository',
    'AI_CENTER_DATA_DIR=repository-data',
    'AI_CENTER_KNOWLEDGE_DIR=repository-knowledge',
    'REPOSITORY_ONLY=repository',
    'SHARED=repository',
    'EMPTY_PROCESS=repository-fallback',
    'SECRET_TOKEN=repository-secret',
  ].join('\n'));
  writeFileSync(path.join(instanceRoot, '.env'), [
    'AI_CENTER_INSTANCE_DIR=instances/must-not-relocate',
    'AI_CENTER_DATA_DIR=instance-data',
    'AI_CENTER_KNOWLEDGE_DIR=instance-knowledge',
    'INSTANCE_ONLY=instance',
    'SHARED=instance',
    'SECRET_TOKEN=instance-secret',
  ].join('\n'));
  const env = {
    AI_CENTER_DATA_DIR: 'process-data',
    SHARED: 'process',
    EMPTY_PROCESS: '',
  };
  try {
    const loaded = loadInstanceEnvironment({
      repositoryRoot,
      env,
      overrides: { SHARED: 'explicit' },
    });
    assert.equal(loaded.instanceRoot, instanceRoot);
    assert.equal(loaded.legacyLayout, false);
    assert.equal(env.AI_CENTER_INSTANCE_DIR, 'instances/from-repository');
    assert.equal(env.AI_CENTER_DATA_DIR, 'process-data');
    assert.equal(env.AI_CENTER_KNOWLEDGE_DIR, 'instance-knowledge');
    assert.equal(env.REPOSITORY_ONLY, 'repository');
    assert.equal(env.INSTANCE_ONLY, 'instance');
    assert.equal(env.SHARED, 'explicit');
    assert.equal(env.EMPTY_PROCESS, 'repository-fallback');
    assert.equal(env.SECRET_TOKEN, 'instance-secret');
    assert.equal(JSON.stringify(loaded).includes('repository-secret'), false);
    assert.equal(JSON.stringify(loaded).includes('instance-secret'), false);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('explicit config overrides win while legacy path environment overrides remain supported', () => {
  const repositoryRoot = temporaryRepository();
  try {
    const config = resolveInstanceConfig({
      repositoryRoot,
      env: {
        AI_CENTER_DATA_DIR: 'environment-data',
        AI_CENTER_KNOWLEDGE_DIR: 'environment-knowledge',
        AI_CENTER_ASSET_WORKBOOK: 'environment-assets.xlsx',
      },
      overrides: {
        dataDirectory: 'explicit-data',
        instanceId: 'test-instance',
        browserId: 'test-browser',
      },
    });
    assert.equal(config.dataDirectory, path.join(repositoryRoot, 'explicit-data'));
    assert.equal(config.knowledgeDirectory, path.join(repositoryRoot, 'environment-knowledge'));
    assert.equal(config.assetWorkbookPath, path.join(repositoryRoot, 'environment-assets.xlsx'));
    assert.equal(config.instanceId, 'test-instance');
    assert.equal(config.browserId, 'test-browser');
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('process instance root overrides repository bootstrap and instance env cannot relocate it', () => {
  const repositoryRoot = temporaryRepository();
  const processRoot = path.join(repositoryRoot, 'instances', 'from-process');
  mkdirSync(processRoot, { recursive: true });
  writeFileSync(path.join(repositoryRoot, '.env'), 'AI_CENTER_INSTANCE_DIR=instances/from-repository\n');
  writeFileSync(path.join(processRoot, '.env'), 'AI_CENTER_INSTANCE_DIR=instances/from-instance-env\n');
  const env = { AI_CENTER_INSTANCE_DIR: 'instances/from-process' };
  try {
    const config = resolveInstanceConfig({ repositoryRoot, env });
    assert.equal(config.instanceRoot, processRoot);
    assert.equal(config.instanceEnvPath, path.join(processRoot, '.env'));
    assert.equal(env.AI_CENTER_INSTANCE_DIR, 'instances/from-process');
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('port follows explicit, process, instance, repository, default precedence', () => {
  const repositoryRoot = temporaryRepository();
  const instanceRoot = path.join(repositoryRoot, 'instances', 'ports');
  mkdirSync(instanceRoot, { recursive: true });
  writeFileSync(path.join(repositoryRoot, '.env'), [
    'AI_CENTER_INSTANCE_DIR=instances/ports',
    'AI_CENTER_PORT=8787',
  ].join('\n'));
  writeFileSync(path.join(instanceRoot, '.env'), 'AI_CENTER_PORT=8788\n');
  try {
    assert.equal(resolveInstanceConfig({ repositoryRoot, env: {} }).port, 8788);
    assert.equal(resolveInstanceConfig({
      repositoryRoot,
      env: { AI_CENTER_INSTANCE_DIR: 'instances/ports', AI_CENTER_PORT: '8789' },
    }).port, 8789);
    assert.equal(resolveInstanceConfig({
      repositoryRoot,
      env: { AI_CENTER_INSTANCE_DIR: 'instances/ports', AI_CENTER_PORT: '8789' },
      overrides: { port: 8790 },
    }).port, 8790);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
