import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { emptyPersonalAssetDashboard, parseContract, PersonalAssetDashboardSchema } from '../../contracts/src/index.js';
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
    },
    updatedAt: now,
    note,
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

  return Object.freeze({
    async getDashboard() {
      const timestamp = now();
      if (!workbookPath || !exists(workbookPath)) {
        return emptyPersonalAssetDashboard(timestamp, '未找到个人资产工作簿。把「收支草记.xlsx」放到 data/imports/personal-assets.xlsx，或设置 AI_CENTER_ASSET_WORKBOOK。');
      }
      const stats = options.stat ? options.stat(workbookPath) : statSync(workbookPath);
      if (cache && cache.mtimeMs === stats.mtimeMs && cache.size === stats.size) return cache.dashboard;
      const sheets = readWorkbookSheets(readFile(workbookPath));
      const assetRows = (sheets[ASSET_SHEET_NAME] || []).slice(1);
      const dividendRows = (sheets[DIVIDEND_SHEET_NAME] || []).slice(1);
      const dashboard = buildPersonalAssetDashboard({
        assetRows,
        dividendRows,
        now: timestamp,
        note: '数据来源：收支草记',
      });
      cache = { mtimeMs: stats.mtimeMs, size: stats.size, dashboard };
      return dashboard;
    },
  });
}
