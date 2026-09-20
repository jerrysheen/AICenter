import { emptyPersonalAssetDashboard, parseContract, PERSONAL_ASSET_TYPE_SEEDS, PersonalAssetDashboardSchema } from '../../contracts/src/index.js';
import { toDecimalNumber, toDecimalString } from './holdings-board.js';

export { PERSONAL_ASSET_TYPE_SEEDS };

function typeNameByKey(types, key) {
  return types.find((item) => item.key === key)?.name || key;
}

export function holdingsInvestmentCny(summary = {}) {
  return toDecimalString(
    toDecimalNumber(summary.aShareCny)
    + toDecimalNumber(summary.bShareCny)
    + toDecimalNumber(summary.cashCny),
  );
}

export function holdingsStockCny(summary = {}) {
  return holdingsInvestmentCny(summary);
}

export function holdingsHasPositions(holdings) {
  return Array.isArray(holdings?.positions) && holdings.positions.length > 0;
}

export function currentAccountAmount(account, holdings) {
  if (account.source === 'holdings' && holdingsHasPositions(holdings)) {
    return holdingsInvestmentCny(holdings.summary || holdings);
  }
  return account.amount;
}

export function defaultSnapshotLabel(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}/${date.getMonth() + 1}.${date.getDate()}`;
}

export function nextAccountName(typeName, existingNames = []) {
  const used = new Set(existingNames);
  let index = 1;
  while (used.has(`${typeName}${index}`)) index += 1;
  return `${typeName}${index}`;
}

function lineAmount(snapshot, predicate) {
  return (snapshot.lines || [])
    .filter(predicate)
    .reduce((sum, line) => sum + toDecimalNumber(line.amount), 0);
}

function snapshotEquity(snapshot, investmentAccountIds) {
  if (investmentAccountIds.size) {
    return toDecimalString(lineAmount(snapshot, (line) => investmentAccountIds.has(line.accountId)));
  }
  return toDecimalString(lineAmount(snapshot, (line) => line.typeKey === 'investment'));
}

function snapshotHousing(snapshot, housingAccountIds) {
  if (housingAccountIds.size) {
    return toDecimalString(lineAmount(snapshot, (line) => housingAccountIds.has(line.accountId)));
  }
  return toDecimalString(lineAmount(snapshot, (line) => line.typeKey === 'housing_fund'));
}

export function buildLedgerDashboard({
  types = [],
  accounts = [],
  snapshots = [],
  dividends = [],
  holdings = null,
  now = Date.now(),
  note = '',
} = {}) {
  const visibleAccounts = accounts.filter((account) => account.archivedAt == null);
  const typeMap = new Map(types.map((item) => [item.key, item]));
  const investmentIds = new Set(visibleAccounts.filter((item) => item.typeKey === 'investment').map((item) => item.id));
  const housingIds = new Set(visibleAccounts.filter((item) => item.typeKey === 'housing_fund').map((item) => item.id));
  const views = visibleAccounts
    .slice()
    .sort((left, right) => (left.sortOrder - right.sortOrder) || left.name.localeCompare(right.name, 'zh'))
    .map((account) => {
      const displayAmount = currentAccountAmount(account, holdings);
      return {
        ...account,
        typeName: typeMap.get(account.typeKey)?.name || account.typeKey,
        readOnly: account.source === 'holdings',
        displayAmount,
      };
    });

  const currentByType = new Map();
  for (const account of views) {
    currentByType.set(account.typeKey, toDecimalNumber(currentByType.get(account.typeKey)) + toDecimalNumber(account.displayAmount));
  }
  const currentTotal = views.reduce((sum, account) => sum + toDecimalNumber(account.displayAmount), 0);
  const currentEquity = toDecimalNumber(currentByType.get('investment'));
  const currentHousing = toDecimalNumber(currentByType.get('housing_fund'));

  const recordedSnapshots = snapshots.slice().sort((left, right) => {
    if (left.recordedAt !== right.recordedAt) return left.recordedAt - right.recordedAt;
    return left.label.localeCompare(right.label, 'zh');
  });
  const points = recordedSnapshots.map((snapshot) => ({
    label: snapshot.label,
    total: snapshot.total,
    equity: snapshotEquity(snapshot, investmentIds),
    housingFund: snapshotHousing(snapshot, housingIds),
    increase: snapshot.increase,
    increaseRate: snapshot.increaseRate,
    recorded: true,
  }));

  const lastRecorded = points[points.length - 1];
  const firstRecorded = points[0];
  const previousTotal = lastRecorded ? toDecimalNumber(lastRecorded.total) : 0;
  const currentIncrease = lastRecorded ? currentTotal - previousTotal : 0;

  if (!points.length && !views.length) {
    return parseContract(PersonalAssetDashboardSchema, {
      ...emptyPersonalAssetDashboard(now, note || '还没有资产记录'),
      source: 'ledger',
    });
  }

  const firstTotal = firstRecorded ? toDecimalNumber(firstRecorded.total) : currentTotal;
  const latestTotal = currentTotal;
  const allocation = PERSONAL_ASSET_TYPE_SEEDS
    .map((seed) => ({
      key: seed.key,
      name: typeNameByKey(types, seed.key),
      value: toDecimalString(currentByType.get(seed.key)),
    }))
    .filter((item) => item.value !== '0');

  const dividendItems = (dividends || []).filter((item) => item.value !== '0');
  const dividendTotal = dividendItems.reduce((sum, item) => sum + toDecimalNumber(item.value), 0);

  return parseContract(PersonalAssetDashboardSchema, {
    source: 'ledger',
    currency: 'CNY',
    points,
    allocation,
    types,
    accounts: views,
    dividend: {
      total: toDecimalString(dividendTotal),
      items: dividendItems,
    },
    latest: {
      label: lastRecorded?.label || '',
      total: toDecimalString(currentTotal),
      equity: toDecimalString(currentEquity),
      housingFund: toDecimalString(currentHousing),
      increase: toDecimalString(currentIncrease),
      increaseRate: previousTotal ? toDecimalString(currentIncrease / previousTotal) : '0',
      cumulativeGrowthRate: firstTotal ? toDecimalString((latestTotal / firstTotal) - 1) : '0',
      firstLabel: firstRecorded?.label || '',
      firstTotal: firstRecorded?.total || toDecimalString(currentTotal),
      recordedLabel: lastRecorded?.label || '',
      recordedTotal: lastRecorded?.total || '0',
    },
    updatedAt: now,
    note,
  });
}
