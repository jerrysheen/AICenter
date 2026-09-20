import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalAssetDashboardSchema, PersonalAssetImportSchema, parseContract, ValidationError } from '../packages/contracts/src/index.js';
import {
  buildPersonalAssetDashboard,
  buildPersonalAssetImport,
  createPersonalAssetService,
  formatPeriodLabel,
  zipStore,
} from '../packages/connectors/src/index.js';
import { createTradingService } from '../packages/domain/src/trading-service.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

function cell(ref, value, type) {
  if (type === 's') return `<c r="${ref}" t="s"><v>${value}</v></c>`;
  return `<c r="${ref}"><v>${value}</v></c>`;
}

function sheetXml(rows) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

function fixtureWorkbook() {
  const shared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>2022/9</t></si>
  <si><t>招商银行</t></si>
  <si><t>总计</t></si>
</sst>`;
  const assets = sheetXml(`
    <row r="1">${cell('A1', '年份')}</row>
    <row r="2">${cell('A2', 0, 's')}${cell('B2', 100000)}${cell('D2', 1000)}${cell('G2', 40000)}${cell('M2', 2000)}${cell('N2', 3000)}${cell('O2', 4000)}${cell('P2', 20000)}${cell('S2', 5000)}</row>
    <row r="3">${cell('A3', 46235)}${cell('B3', 110000)}${cell('D3', 1500)}${cell('G3', 50000)}${cell('M3', 2500)}${cell('N3', 3500)}${cell('O3', 4500)}${cell('P3', 22000)}${cell('S3', 6000)}${cell('U3', 10000)}${cell('V3', 0.1)}</row>
  `);
  const dividends = sheetXml(`
    <row r="1">${cell('A1', '股票名')}</row>
    <row r="2">${cell('A2', 1, 's')}${cell('D2', 128)}</row>
    <row r="3">${cell('A3', 2, 's')}${cell('D3', 128)}</row>
  `);
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="资产明细" sheetId="1" r:id="rId1"/>
    <sheet name="分红所得" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`;
  return zipStore({
    'xl/sharedStrings.xml': shared,
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': rels,
    'xl/worksheets/sheet1.xml': assets,
    'xl/worksheets/sheet2.xml': dividends,
  });
}

test('excel serial dates become period labels', () => {
  assert.equal(formatPeriodLabel(46235), '2026/8.1');
  assert.equal(formatPeriodLabel('2026/7.8'), '2026/7.8');
});

test('personal asset dashboard maps workbook columns like the original screen', () => {
  const dashboard = buildPersonalAssetDashboard({
    now: 1,
    note: '数据来源：收支草记',
    assetRows: [
      ['2022/9', 100_000, 0, 1000, 0, 0, 40_000, 0, 0, 0, 0, 0, 2000, 3000, 4000, 20_000, 0, 0, 5000, '', 0, 0],
      ['2023/1', 110_000, 0, 1500, 0, 0, 50_000, 0, 0, 0, 0, 0, 2500, 3500, 4500, 22_000, 0, 0, 6000, '', 10_000, 0.1],
    ],
    dividendRows: [
      ['招商银行', 3200, 2, 128],
      ['', '', '', 128],
    ],
  });
  assert.equal(dashboard.latest.label, '2023/1');
  assert.equal(dashboard.latest.total, '110000');
  assert.equal(dashboard.latest.cumulativeGrowthRate, '0.1');
  assert.equal(dashboard.allocation.find((item) => item.key === 'cash').value, '4000');
  assert.equal(dashboard.dividend.total, '128');
  assert.equal(dashboard.dividend.items[0].name, '招商银行');
  parseContract(PersonalAssetDashboardSchema, dashboard);
});

test('workbook import splits bank columns and keeps recorded totals', () => {
  const imported = buildPersonalAssetImport({
    headerRow: ['年份', '总计', '', '交通银行', '', '', '股票(A+B股)'],
    recordedAt: 10,
    assetRows: [
      ['2022/9', 100_000, 0, 1000, 0, 0, 40_000, 0, 0, 0, 0, 0, 2000, 3000, 4000, 20_000, 0, 0, 5000, '', 0, 0],
      ['2023/1', 110_000, 0, 1500, 0, 0, 50_000, 0, 0, 0, 0, 0, 2500, 3500, 4500, 22_000, 0, 0, 6000, '', 10_000, 0.1],
    ],
    dividendRows: [['招商银行', 3200, 2, 128]],
  });
  parseContract(PersonalAssetImportSchema, imported);
  const bank = imported.accounts.find((item) => item.id === 'paacct:bank:col3');
  assert.equal(bank.name, '银行卡1');
  assert.equal(bank.note, '交通银行');
  assert.equal(imported.accounts.find((item) => item.source === 'holdings').id, 'paacct:investment:holdings');
  assert.equal(imported.snapshots.at(-1).total, '110000');
  const lineSum = imported.snapshots.at(-1).lines.reduce((sum, line) => sum + Number(line.amount), 0);
  assert.equal(lineSum, 110000);
  assert.deepEqual(imported.dividends, []);
});

test('personal asset contract rejects numeric money fields', () => {
  assert.throws(() => parseContract(PersonalAssetDashboardSchema, {
    source: 'workbook',
    currency: 'CNY',
    points: [],
    allocation: [],
    dividend: { total: 0, items: [] },
    latest: {
      label: '', total: '0', equity: '0', housingFund: '0', increase: '0', increaseRate: '0',
      cumulativeGrowthRate: '0', firstLabel: '', firstTotal: '0',
    },
    updatedAt: 1,
    note: '',
  }), ValidationError);
});

test('trading service reads personal assets from an injected port', async () => {
  const service = createTradingService({
    tradingRepository: {},
    sourcePort: { async read() { return { data: [] }; } },
    personalAssetPort: {
      async getDashboard() {
        return buildPersonalAssetDashboard({ now: 8, assetRows: [['2024/1', 1, 0, 0, 0, 0, 1]] });
      },
    },
  });
  const dashboard = await service.getPersonalAssetDashboard();
  assert.equal(dashboard.latest.total, '1');
});

test('workbook adapter and API return the mapped dashboard', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-assets-'));
  const workbookPath = path.join(directory, 'personal-assets.xlsx');
  writeFileSync(workbookPath, fixtureWorkbook());
  const personalAssetService = createPersonalAssetService({
    workbookPath,
    now: () => 42,
  });
  const loaded = await personalAssetService.getDashboard();
  assert.equal(loaded.latest.label, '2026/8.1');
  assert.equal(loaded.latest.equity, '50000');
  assert.equal(loaded.dividend.items[0].name, '招商银行');

  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    personalAssetService,
  });
  const address = await app.listen();
  try {
    const payload = await fetch(`${address.localUrl}/api/v1/assets/personal`).then((response) => response.json());
    assert.equal(payload.ok, true);
    assert.equal(payload.dashboard.source, 'ledger');
    assert.equal(payload.dashboard.latest.total, '110000');
    assert.equal(payload.dashboard.latest.recordedTotal, '110000');
    assert.equal(payload.dashboard.latest.equity, '50000');
    assert.deepEqual(payload.dashboard.dividend.items, []);
    assert.ok(payload.dashboard.accounts.some((item) => item.source === 'holdings'));
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real personal-assets workbook imports all recorded periods', async () => {
  const workbookPath = path.join('data', 'imports', 'personal-assets.xlsx');
  if (!existsSync(workbookPath)) return;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-real-assets-'));
  const personalAssetService = createPersonalAssetService({
    workbookPath,
    now: () => 42,
  });
  const imported = await personalAssetService.parseImport();
  assert.ok(imported);
  assert.equal(imported.snapshots.length, 57);
  assert.equal(imported.snapshots.filter((item) => item.label === '2024/3').length, 2);
  assert.equal(imported.snapshots.filter((item) => item.label === '2024/12').length, 3);
  assert.equal(imported.snapshots.at(-1).label, '2026/8.1');
  assert.equal(imported.snapshots.at(-1).total, '1563354.23');
  assert.deepEqual(imported.dividends, []);
  assert.equal(imported.accounts.find((item) => item.id === 'paacct:bank:col3').note, '光大银行卡');
  assert.equal(imported.accounts.find((item) => item.source === 'holdings').note, 'A股、B股市值与券商现金');

  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    personalAssetService,
  });
  const address = await app.listen();
  try {
    const payload = await fetch(`${address.localUrl}/api/v1/assets/personal`).then((response) => response.json());
    assert.equal(payload.ok, true);
    assert.equal(payload.dashboard.source, 'ledger');
    assert.equal(payload.dashboard.points.filter((item) => item.recorded).length, 57);
    assert.equal(payload.dashboard.latest.recordedTotal, '1563354.23');
    assert.deepEqual(payload.dashboard.dividend.items, []);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
