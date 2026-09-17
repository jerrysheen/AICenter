import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../packages/database/src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('portfolio import CLI merges a validated file into the selected instance database', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'ai-center-portfolio-import-'));
  const dataDirectory = path.join(temporaryRoot, 'data');
  const importFile = path.join(temporaryRoot, 'portfolio.json');
  writeFileSync(importFile, JSON.stringify({
    schemaVersion: 1,
    mode: 'merge',
    accounts: [{
      id: 'portfolio-demo',
      name: '演示账户',
      marketScope: 'cn',
      baseCurrency: 'CNY',
      initialCapital: '1000',
    }],
    positions: [],
    cash: [{ portfolioId: 'portfolio-demo', currency: 'CNY', amount: '1000' }],
  }));

  try {
    const output = execFileSync(process.execPath, ['scripts/import-portfolio.mjs', importFile], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AI_CENTER_INSTANCE_DIR: temporaryRoot,
        AI_CENTER_INSTANCE_ID: 'cli-test',
        AI_CENTER_DATA_DIR: dataDirectory,
      },
    });
    assert.deepEqual(JSON.parse(output), {
      instanceId: 'cli-test',
      accountsMerged: 1,
      positionsMerged: 0,
      cashMerged: 1,
    });

    const store = createStore(path.join(dataDirectory, 'ai-center.db'));
    try {
      assert.equal(store.repositories.trading.listPortfolios('local').length, 1);
      assert.equal(store.repositories.trading.listWorkspaceCash('local').length, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
