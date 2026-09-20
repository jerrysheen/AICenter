import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  emptyPersonalAssetDashboard,
  parseContract,
  PersonalAssetDashboardSchema,
  PersonalAssetImportSchema,
} from '../../contracts/src/index.js';
import { readWorkbookSheets } from './xlsx-workbook.js';

const ASSET_SHEET_NAME = '资产明细';
const DIVIDEND_SHEET_NAME = '分红所得';
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

const ALLOCATION = [
  { key: 'equity', name: '股票(A+B股)', column: 6 },
  { key: 'housingFund', name: '公积金', column: 15 },
  { key: 'other', name: '其他额外', column: 18 },
  { key: 'crypto', name: '数字货币', column: 14 },
  { key: 'cash', name: '银行及现金' },
  { key: 'fund', name: '基金与支付宝', column: 13 },
];

const IMPORT_COLUMNS = [
  { index: 3, typeKey: 'bank' },
  { index: 4, typeKey: 'bank' },
  { index: 5, typeKey: 'bank' },
  { index: 6, typeKey: 'investment', source: 'holdings' },
  { index: 12, typeKey: 'cash' },
  { index: 13, typeKey: 'fund' },
  { index: 14, typeKey: 'crypto' },
  { index: 15, typeKey: 'housing_fund' },
  { index: 18, typeKey: 'extra' },
];

const TYPE_NAMES = {
  bank: '银行卡',
  cash: '现金',
  investment: '投资',
  fund: '基金与余额',
  crypto: '数字货币',
  housing_fund: '公积金',
  extra: '额外资金',
};

const GENERIC_TOKEN = /银行及现金|银行卡|银行|现金|股票总额|股票|基金|支付宝|数字货币|公积金|其他额外|其他|额外|年份|日期|总计|合计|总和|增长|余额|总额/g;

export function toDecimalString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Object.is(value, -0)) return '0';
    const text = value.toFixed(8).replace(/\.?0+$/, '');
    return text === '-0' ? '0' : text;
  }
  if (value === null || value === undefined || value === '') return '0';
  const parsed = Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(parsed)) return '0';
  return toDecimalString(parsed);
}

export function toNumber(value) {
  return Number(toDecimalString(value));
}

export function formatPeriodLabel(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return `${value.getUTCFullYear()}/${value.getUTCMonth() + 1}.${value.getUTCDate()}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 30_000 && value < 80_000) {
      const millis = EXCEL_EPOCH + Math.round(value) * 86_400_000;
      return formatPeriodLabel(new Date(millis));
    }
    return String(value);
  }
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\d+(\.0+)?$/.test(text)) return formatPeriodLabel(Number(text));
  return text;
}

function cashFromRow(row) {
  return toNumber(row[3]) + toNumber(row[4]) + toNumber(row[5]) + toNumber(row[12]);
}

function isTotalName(name) {
  return name === '总计' || name === '合计';
}

export function buildPersonalAssetDashboard({ assetRows = [], dividendRows = [], now = Date.now(), note = '' } = {}) {
  const rows = assetRows.filter((row) => formatPeriodLabel(row?.[0]));
  if (!rows.length) {
    return emptyPersonalAssetDashboard(now, '资产明细为空');
  }

  const points = rows.map((row) => ({
    label: formatPeriodLabel(row[0]),
    total: toDecimalString(row[1]),
    equity: toDecimalString(row[6]),
    housingFund: toDecimalString(row[15]),
    increase: toDecimalString(row[20]),
    increaseRate: toDecimalString(row[21]),
    recorded: true,
  }));

  const first = points[0];
  const latestPoint = points[points.length - 1];
  const lastRow = rows[rows.length - 1];
  const firstTotal = toNumber(first.total);
  const latestTotal = toNumber(latestPoint.total);
  const cumulativeGrowthRate = firstTotal ? toDecimalString((latestTotal / firstTotal) - 1) : '0';
  const cash = cashFromRow(lastRow);

  const allocation = ALLOCATION
    .map((item) => ({
      key: item.key,
      name: item.name,
      value: toDecimalString(item.key === 'cash' ? cash : lastRow[item.column]),
    }))
    .filter((item) => item.value !== '0');

  const dividendItems = [];
  let dividendTotal = 0;
  for (const row of dividendRows) {
    const name = String(row?.[0] ?? '').trim();
    const value = toNumber(row?.[3]);
    if (name && !isTotalName(name) && value !== 0) {
      dividendItems.push({ name, value: toDecimalString(value) });
    } else if (isTotalName(name) || (!name && value !== 0 && dividendItems.length)) {
      dividendTotal = value;
    }
  }
  if (dividendTotal === 0 && dividendItems.length) {
    dividendTotal = dividendItems.reduce((sum, item) => sum + toNumber(item.value), 0);
  }

  return parseContract(PersonalAssetDashboardSchema, {
    source: 'workbook',
    currency: 'CNY',
    points,
    allocation,
    types: [],
    accounts: [],
    dividend: {
      total: toDecimalString(dividendTotal),
      items: dividendItems,
    },
    latest: {
      label: latestPoint.label,
      total: latestPoint.total,
      equity: latestPoint.equity,
      housingFund: latestPoint.housingFund,
      increase: latestPoint.increase,
      increaseRate: latestPoint.increaseRate,
      cumulativeGrowthRate,
      firstLabel: first.label,
      firstTotal: first.total,
      recordedLabel: latestPoint.label,
      recordedTotal: latestPoint.total,
    },
    updatedAt: now,
    note,
  });
}

function headerText(headerRow, index) {
  return String(headerRow?.[index] ?? '').trim();
}

function classifyImportColumn(headerRow, spec) {
  const text = headerText(headerRow, spec.index);
  if (spec.source === 'holdings' || /股票|A\s*\+\s*B|持仓/.test(text)) {
    return { typeKey: 'investment', source: 'holdings' };
  }
  if (spec.typeKey === 'fund' || /基金|支付宝/.test(text)) return { typeKey: 'fund', source: 'manual' };
  if (spec.typeKey === 'crypto' || /数字货币|加密|比特币|BTC/.test(text)) return { typeKey: 'crypto', source: 'manual' };
  if (spec.typeKey === 'housing_fund' || /公积金/.test(text)) return { typeKey: 'housing_fund', source: 'manual' };
  if (spec.typeKey === 'extra' || /其他|额外|借出|应收/.test(text)) return { typeKey: 'extra', source: 'manual' };
  if (/现金|钱包|备用/.test(text)) return { typeKey: 'cash', source: 'manual' };
  return { typeKey: spec.typeKey, source: spec.source || 'manual' };
}

function noteFromHeader(headerRow, index) {
  const text = headerText(headerRow, index);
  if (!text) return '';
  const specific = text.replace(GENERIC_TOKEN, '').replace(/[()（）+\s]/g, '');
  if (!specific) return '';
  return text.slice(0, 128);
}

function snapshotId(label, index) {
  return `pasnap:${index}:${String(label).replace(/\s+/g, '')}`.slice(0, 128);
}

export function buildPersonalAssetImport({
  headerRow = [],
  assetRows = [],
  recordedAt = Date.now(),
} = {}) {
  const rows = assetRows.filter((row) => formatPeriodLabel(row?.[0]));
  const typeCounts = new Map();
  const accounts = [];
  const columnAccounts = [];

  for (const spec of IMPORT_COLUMNS) {
    const classified = classifyImportColumn(headerRow, spec);
    const typeName = TYPE_NAMES[classified.typeKey];
    const count = (typeCounts.get(classified.typeKey) || 0) + 1;
    typeCounts.set(classified.typeKey, count);
    const account = {
      id: classified.source === 'holdings' ? 'paacct:investment:holdings' : `paacct:${classified.typeKey}:col${spec.index}`,
      typeKey: classified.typeKey,
      name: classified.source === 'holdings' ? '持仓合计' : `${typeName}${count}`,
      note: classified.source === 'holdings' ? 'A股、B股市值与券商现金' : noteFromHeader(headerRow, spec.index),
      source: classified.source,
      amount: '0',
      currency: 'CNY',
      sortOrder: spec.index,
    };
    accounts.push(account);
    columnAccounts.push({ index: spec.index, account });
  }

  const snapshots = rows.map((row, index) => {
    const label = formatPeriodLabel(row[0]);
    const lines = columnAccounts.map((item) => ({
      accountId: item.account.id,
      amount: toDecimalString(row[item.index]),
    }));
    const mapped = lines.reduce((sum, line) => sum + toNumber(line.amount), 0);
    const total = toDecimalString(row[1]);
    const remainder = toNumber(total) - mapped;
    return {
      id: snapshotId(label, index),
      label,
      total,
      increase: toDecimalString(row[20]),
      increaseRate: toDecimalString(row[21]),
      recordedAt: recordedAt + index,
      lines,
      remainder,
    };
  });

  const last = snapshots[snapshots.length - 1];
  if (last && last.remainder !== 0) {
    const remainderAccount = {
      id: 'paacct:extra:remainder',
      typeKey: 'extra',
      name: `额外资金${(typeCounts.get('extra') || 0) + 1}`,
      note: '导入记录差额',
      source: 'manual',
      amount: toDecimalString(last.remainder),
      currency: 'CNY',
      sortOrder: 90,
    };
    accounts.push(remainderAccount);
    for (const snapshot of snapshots) {
      snapshot.lines.push({
        accountId: remainderAccount.id,
        amount: toDecimalString(snapshot.remainder),
      });
    }
  }
  for (const snapshot of snapshots) delete snapshot.remainder;

  if (last) {
    const latestByAccount = new Map(last.lines.map((line) => [line.accountId, line.amount]));
    for (const account of accounts) {
      account.amount = latestByAccount.get(account.id) || '0';
    }
  }

  return parseContract(PersonalAssetImportSchema, {
    schemaVersion: 1,
    mode: 'merge',
    accounts,
    snapshots,
    dividends: [],
  });
}

export function createPersonalAssetService(options = {}) {
  const env = options.env || process.env;
  const now = options.now || (() => Date.now());
  const readFile = options.readFile || ((filePath) => readFileSync(filePath));
  const exists = options.exists || existsSync;
  const dataDirectory = options.dataDirectory;
  const configured = options.workbookPath || env.AI_CENTER_ASSET_WORKBOOK;
  const workbookPath = configured
    ? path.resolve(configured)
    : dataDirectory
      ? path.join(dataDirectory, 'imports', 'personal-assets.xlsx')
      : '';

  let cache = null;

  function loadSheets(timestamp) {
    if (!workbookPath || !exists(workbookPath)) return null;
    const stats = options.stat ? options.stat(workbookPath) : statSync(workbookPath);
    if (cache && cache.mtimeMs === stats.mtimeMs && cache.size === stats.size) return cache;
    const sheets = readWorkbookSheets(readFile(workbookPath));
    const assetSheet = sheets[ASSET_SHEET_NAME] || [];
    const loaded = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      headerRow: assetSheet[0] || [],
      assetRows: assetSheet.slice(1),
      dividendRows: (sheets[DIVIDEND_SHEET_NAME] || []).slice(1),
      timestamp,
    };
    cache = loaded;
    return loaded;
  }

  return Object.freeze({
    async getDashboard() {
      const timestamp = now();
      const loaded = loadSheets(timestamp);
      if (!loaded) {
        return emptyPersonalAssetDashboard(timestamp, '未找到个人资产工作簿。把「收支草记.xlsx」放到 data/imports/personal-assets.xlsx，或设置 AI_CENTER_ASSET_WORKBOOK。');
      }
      if (loaded.dashboard) return loaded.dashboard;
      const dashboard = buildPersonalAssetDashboard({
        assetRows: loaded.assetRows,
        dividendRows: loaded.dividendRows,
        now: timestamp,
        note: '数据来源：收支草记',
      });
      loaded.dashboard = dashboard;
      return dashboard;
    },
    async parseImport() {
      const timestamp = now();
      const loaded = loadSheets(timestamp);
      if (!loaded) return null;
      if (loaded.importPayload) return loaded.importPayload;
      loaded.importPayload = buildPersonalAssetImport({
        headerRow: loaded.headerRow,
        assetRows: loaded.assetRows,
        recordedAt: timestamp,
      });
      return loaded.importPayload;
    },
  });
}
