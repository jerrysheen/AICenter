import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';
import { createStore } from '../packages/database/src/index.js';
import { createTradingService } from '../packages/domain/src/trading-service.js';
import { buildPersonalAssetImport } from '../packages/connectors/src/personal-asset-workbook.js';
import { buildLedgerDashboard } from '../packages/domain/src/personal-asset-ledger.js';

function temporaryStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-asset-ledger-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    directory,
    store,
    remove() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function sampleImport() {
  return buildPersonalAssetImport({
    headerRow: ['年份', '总计', '', '交通银行'],
    recordedAt: 1_000,
    assetRows: [
      ['2022/9', 100_000, 0, 1000, 0, 0, 40_000, 0, 0, 0, 0, 0, 2000, 3000, 4000, 20_000, 0, 0, 5000, '', 0, 0],
      ['2023/1', 110_000, 0, 1500, 0, 0, 50_000, 0, 0, 0, 0, 0, 2500, 3500, 4500, 22_000, 0, 0, 6000, '', 10_000, 0.1],
    ],
  });
}

function quietQuotes() {
  return {
    async read(sourceId) {
      if (sourceId === 'market.quotes') return { data: [] };
      if (sourceId === 'market.history') return { data: [] };
      return { data: [] };
    },
  };
}

test('fresh store reaches personal asset ledger schema', () => {
  const temporary = temporaryStore();
  try {
    assert.equal(temporary.store.getRuntimeStatus().schemaVersion, latestSchemaVersion());
    assert.equal(latestSchemaVersion(), 32);
    temporary.store.repositories.trading.ensurePersonalAssetTypes('local');
    assert.equal(temporary.store.repositories.trading.listPersonalAssetTypes('local').length, 7);
  } finally {
    temporary.remove();
  }
});

test('imported ledger keeps recorded totals and changes only the live side', async () => {
  const temporary = temporaryStore();
  try {
    const service = createTradingService({
      tradingRepository: temporary.store.repositories.trading,
      sourcePort: quietQuotes(),
    });
    temporary.store.repositories.trading.mergePersonalAssetImport('local', sampleImport());
    const first = await service.getPersonalAssetDashboard();
    assert.equal(first.source, 'ledger');
    assert.equal(first.latest.total, '110000');
    assert.equal(first.latest.recordedTotal, '110000');
    assert.equal(first.latest.equity, '50000');
    assert.equal(first.points[0].total, '100000');
    assert.equal(first.points.at(-1).label, '2023/1');
    assert.equal(first.accounts.find((item) => item.note === '交通银行').typeKey, 'bank');

    const bank = first.accounts.find((item) => item.id === 'paacct:bank:col3');
    const updated = await service.updatePersonalAssetAccount(bank.id, { amount: '3500' });
    assert.equal(updated.dashboard.latest.total, '112000');
    assert.equal(updated.dashboard.latest.recordedTotal, '110000');
    assert.equal(updated.dashboard.points.find((item) => item.label === '2023/1').total, '110000');
    assert.equal(updated.dashboard.points.at(-1).label, '2023/1');
    assert.equal(updated.dashboard.points.at(-1).recorded, true);
    assert.ok(!updated.dashboard.points.some((item) => item.label === '现在'));

    const recorded = await service.recordPersonalAssetSnapshot({ label: '2023/2' });
    assert.equal(recorded.dashboard.latest.recordedLabel, '2023/2');
    assert.equal(recorded.dashboard.latest.recordedTotal, '112000');
    assert.ok(!recorded.dashboard.points.some((item) => item.label === '现在'));
  } finally {
    temporary.remove();
  }
});

test('holdings stock value rolls into investment with broker cash', () => {
  const dashboard = buildLedgerDashboard({
    now: 8,
    types: [
      { key: 'investment', workspaceId: 'local', name: '投资', sortOrder: 30, hiddenAt: null, createdAt: 1, updatedAt: 1 },
      { key: 'bank', workspaceId: 'local', name: '银行卡', sortOrder: 10, hiddenAt: null, createdAt: 1, updatedAt: 1 },
    ],
    accounts: [
      {
        id: 'paacct:investment:holdings', workspaceId: 'local', typeKey: 'investment', name: '持仓合计',
        note: '', source: 'holdings', amount: '50000', currency: 'CNY', sortOrder: 6,
        archivedAt: null, createdAt: 1, updatedAt: 1,
      },
      {
        id: 'paacct:bank:col3', workspaceId: 'local', typeKey: 'bank', name: '银行卡1',
        note: '交通银行', source: 'manual', amount: '1500', currency: 'CNY', sortOrder: 3,
        archivedAt: null, createdAt: 1, updatedAt: 1,
      },
    ],
    snapshots: [{
      id: 'pasnap:2023/1', workspaceId: 'local', label: '2023/1', total: '51500',
      increase: '0', increaseRate: '0', recordedAt: 1, createdAt: 1,
      lines: [
        { accountId: 'paacct:investment:holdings', typeKey: 'investment', amount: '50000' },
        { accountId: 'paacct:bank:col3', typeKey: 'bank', amount: '1500' },
      ],
    }],
    holdings: {
      positions: [{ lotId: 'lot-1' }],
      summary: { aShareCny: '80000', bShareCny: '2000', cashCny: '9999' },
    },
  });
  assert.equal(dashboard.latest.equity, '91999');
  assert.equal(dashboard.latest.total, '93499');
  assert.equal(dashboard.latest.recordedTotal, '51500');
  assert.equal(dashboard.accounts.find((item) => item.source === 'holdings').displayAmount, '91999');
  assert.equal(dashboard.accounts.find((item) => item.source === 'holdings').readOnly, true);
  assert.equal(dashboard.points.at(-1).label, '2023/1');
  assert.equal(dashboard.points.at(-1).total, '51500');
  assert.ok(!dashboard.points.some((item) => item.label === '现在'));
});

test('analysis page exposes typed accounts and period recording', () => {
  const html = readFileSync(path.join('apps', 'web', 'public', 'index.html'), 'utf8');
  const js = readFileSync(path.join('apps', 'web', 'public', 'app.js'), 'utf8');
  assert.match(html, /id="analysis-ledger"/);
  assert.match(js, /\/api\/v1\/assets\/personal\/accounts/);
  assert.match(js, /\/api\/v1\/assets\/personal\/snapshots/);
  assert.match(js, /记本期/);
  assert.match(js, /来源记录/);
  assert.match(js, /function donutSlicePath/);
  assert.doesNotMatch(js, /stroke-dasharray/);
  assert.doesNotMatch(html, /analysis-dividend/);
});

test('duplicate period labels stay as separate recorded points', async () => {
  const temporary = temporaryStore();
  try {
    const service = createTradingService({
      tradingRepository: temporary.store.repositories.trading,
      sourcePort: quietQuotes(),
    });
    const imported = buildPersonalAssetImport({
      headerRow: ['年份', '总计', '', '交通银行'],
      recordedAt: 1_000,
      assetRows: [
        ['2024/3', 100_000, 0, 1000, 0, 0, 40_000, 0, 0, 0, 0, 0, 2000, 3000, 4000, 20_000, 0, 0, 5000, '', 0, 0],
        ['2024/3', 110_000, 0, 1500, 0, 0, 50_000, 0, 0, 0, 0, 0, 2500, 3500, 4500, 22_000, 0, 0, 6000, '', 10_000, 0.1],
      ],
    });
    assert.equal(imported.snapshots.length, 2);
    assert.equal(imported.snapshots[0].label, '2024/3');
    assert.equal(imported.snapshots[1].label, '2024/3');
    assert.notEqual(imported.snapshots[0].id, imported.snapshots[1].id);
    temporary.store.repositories.trading.mergePersonalAssetImport('local', imported);
    const first = await service.getPersonalAssetDashboard();
    assert.equal(first.points.filter((item) => item.label === '2024/3').length, 2);
    assert.equal(first.latest.recordedTotal, '110000');
    const recorded = await service.recordPersonalAssetSnapshot({ label: '2024/3' });
    assert.equal(recorded.dashboard.points.filter((item) => item.label === '2024/3').length, 3);
  } finally {
    temporary.remove();
  }
});
