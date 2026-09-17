import { z } from 'zod';
import {
  CurrencySchema,
  DecimalStringSchema,
  EntityIdSchema,
  EpochMillisSchema,
  MetadataSchema,
  NonNegativeDecimalStringSchema,
  WorkspaceIdSchema,
} from './common.js';

export const AssetClassSchema = z.enum([
  'equity', 'index', 'fx', 'rate', 'metal', 'energy', 'future', 'crypto', 'fund', 'cash',
]);
export const MarketSchema = z.enum(['cn', 'hk', 'us', 'global']);

export const InstrumentSchema = z.object({
  id: EntityIdSchema,
  canonicalKey: z.string().trim().min(3).max(128),
  symbol: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(256),
  assetClass: AssetClassSchema,
  market: MarketSchema,
  exchangeCode: z.string().trim().max(32).default(''),
  currency: CurrencySchema,
  metadata: MetadataSchema,
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const InstrumentAliasSchema = z.object({
  instrumentId: EntityIdSchema,
  providerId: z.string().trim().min(1).max(64),
  providerSymbol: z.string().trim().min(1).max(128),
  metadata: MetadataSchema,
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const QuoteSnapshotSchema = z.object({
  id: z.union([EntityIdSchema, z.number().int().positive()]),
  instrumentId: EntityIdSchema,
  providerId: z.string().trim().min(1).max(64),
  price: DecimalStringSchema,
  previousClose: DecimalStringSchema.nullable(),
  currency: CurrencySchema,
  quality: z.enum(['realtime', 'delayed', 'close', 'estimated', 'unknown']),
  session: z.enum(['pre', 'regular', 'post', 'closed', 'unknown']),
  marketTime: EpochMillisSchema.nullable(),
  createdAt: EpochMillisSchema,
}).strict();

export const PortfolioSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  name: z.string().trim().min(1).max(128),
  marketScope: z.enum(['cn', 'hk', 'us', 'global', 'mixed']),
  baseCurrency: CurrencySchema,
  initialCapital: NonNegativeDecimalStringSchema,
  archivedAt: EpochMillisSchema.nullable(),
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const TransactionTypeSchema = z.enum([
  'buy', 'sell', 'dividend', 'fee', 'deposit', 'withdraw', 'split', 'transfer', 'adjustment',
]);

export const TransactionSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  portfolioId: EntityIdSchema,
  instrumentId: EntityIdSchema.nullable(),
  type: TransactionTypeSchema,
  quantity: DecimalStringSchema,
  price: NonNegativeDecimalStringSchema,
  cashAmount: DecimalStringSchema,
  currency: CurrencySchema,
  fees: NonNegativeDecimalStringSchema,
  note: z.string().max(2_000).default(''),
  occurredAt: EpochMillisSchema,
  createdAt: EpochMillisSchema,
}).strict();

export const UpsertInstrumentInputSchema = InstrumentSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({ id: EntityIdSchema.optional() }).strict();

export const UpsertInstrumentAliasInputSchema = InstrumentAliasSchema.omit({
  createdAt: true,
  updatedAt: true,
}).strict();

export const CreatePortfolioInputSchema = PortfolioSchema.omit({
  id: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
}).extend({ id: EntityIdSchema.optional() }).strict();

export const AppendTransactionInputSchema = TransactionSchema.omit({
  id: true,
  createdAt: true,
}).extend({ id: EntityIdSchema.optional() }).strict();

export const PersonalAssetAllocationKeySchema = z.enum([
  'equity', 'housingFund', 'other', 'crypto', 'cash', 'fund',
]);

export const PersonalAssetPointSchema = z.object({
  label: z.string().trim().min(1).max(32),
  total: DecimalStringSchema,
  equity: DecimalStringSchema,
  housingFund: DecimalStringSchema,
  increase: DecimalStringSchema,
  increaseRate: DecimalStringSchema,
}).strict();

export const PersonalAssetAllocationSchema = z.object({
  key: PersonalAssetAllocationKeySchema,
  name: z.string().trim().min(1).max(32),
  value: DecimalStringSchema,
}).strict();

export const PersonalAssetDividendItemSchema = z.object({
  name: z.string().trim().min(1).max(64),
  value: DecimalStringSchema,
}).strict();

export const PersonalAssetDashboardSchema = z.object({
  source: z.literal('workbook'),
  currency: CurrencySchema,
  points: z.array(PersonalAssetPointSchema),
  allocation: z.array(PersonalAssetAllocationSchema),
  dividend: z.object({
    total: DecimalStringSchema,
    items: z.array(PersonalAssetDividendItemSchema),
  }).strict(),
  latest: z.object({
    label: z.string().trim().max(32),
    total: DecimalStringSchema,
    equity: DecimalStringSchema,
    housingFund: DecimalStringSchema,
    increase: DecimalStringSchema,
    increaseRate: DecimalStringSchema,
    cumulativeGrowthRate: DecimalStringSchema,
    firstLabel: z.string().trim().max(32),
    firstTotal: DecimalStringSchema,
  }).strict(),
  updatedAt: EpochMillisSchema,
  note: z.string().max(240).default(''),
}).strict();

export const HoldingBoardSchema = z.enum(['a_share', 'hk_connect', 'b_sh', 'b_sz']);

export const HoldingLotSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  portfolioId: EntityIdSchema,
  instrumentId: EntityIdSchema,
  board: HoldingBoardSchema,
  quantity: DecimalStringSchema,
  costPrice: NonNegativeDecimalStringSchema,
  listingCurrency: CurrencySchema,
  note: z.string().max(2_000).default(''),
  archivedAt: EpochMillisSchema.nullable(),
  openedAt: EpochMillisSchema.nullable(),
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const HoldingCashSchema = z.object({
  portfolioId: EntityIdSchema,
  currency: CurrencySchema,
  amount: DecimalStringSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const UpsertHoldingLotInputSchema = HoldingLotSchema.omit({
  createdAt: true,
  updatedAt: true,
}).extend({
  id: EntityIdSchema.optional(),
  archivedAt: EpochMillisSchema.nullable().optional(),
  openedAt: EpochMillisSchema.nullable().optional(),
}).strict();

export const UpsertHoldingCashInputSchema = z.object({
  portfolioId: EntityIdSchema,
  currency: CurrencySchema,
  amount: DecimalStringSchema,
}).strict();

export const AddHoldingLotInputSchema = z.object({
  portfolioId: EntityIdSchema,
  board: HoldingBoardSchema,
  symbol: z.string().trim().max(64).default(''),
  name: z.string().trim().max(256).default(''),
  yahoo: z.string().trim().min(1).max(128),
  quantity: DecimalStringSchema,
  costPrice: NonNegativeDecimalStringSchema,
  openedAt: EpochMillisSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (!value.symbol && !value.yahoo) {
    context.addIssue({ code: 'custom', path: ['symbol'], message: '证券代码不能为空' });
  }
});

export const PortfolioImportAliasSchema = z.object({
  providerId: z.string().trim().min(1).max(64),
  providerSymbol: z.string().trim().min(1).max(128),
  metadata: MetadataSchema,
}).strict();

export const PortfolioImportAccountSchema = z.object({
  id: EntityIdSchema,
  name: z.string().trim().min(1).max(128),
  marketScope: z.enum(['cn', 'hk', 'us', 'global', 'mixed']),
  baseCurrency: CurrencySchema,
  initialCapital: NonNegativeDecimalStringSchema.default('0'),
}).strict();

export const PortfolioImportPositionSchema = z.object({
  id: EntityIdSchema,
  portfolioId: EntityIdSchema,
  board: HoldingBoardSchema,
  quantity: DecimalStringSchema,
  costPrice: NonNegativeDecimalStringSchema,
  listingCurrency: CurrencySchema,
  note: z.string().max(2_000).default(''),
  openedAt: EpochMillisSchema.nullable().default(null),
  instrument: UpsertInstrumentInputSchema,
  aliases: z.array(PortfolioImportAliasSchema).max(16).default([]),
}).strict();

export const PortfolioImportCashSchema = z.object({
  portfolioId: EntityIdSchema,
  currency: CurrencySchema,
  amount: DecimalStringSchema,
}).strict();

export const PortfolioImportSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  mode: z.literal('merge').default('merge'),
  accounts: z.array(PortfolioImportAccountSchema).max(1_000),
  positions: z.array(PortfolioImportPositionSchema).max(100_000),
  cash: z.array(PortfolioImportCashSchema).max(10_000),
}).strict().superRefine((value, context) => {
  const accountIds = new Set();
  for (const [index, account] of value.accounts.entries()) {
    if (accountIds.has(account.id)) {
      context.addIssue({ code: 'custom', path: ['accounts', index, 'id'], message: '账户 id 不能重复' });
    }
    accountIds.add(account.id);
  }

  const positionIds = new Set();
  for (const [index, position] of value.positions.entries()) {
    if (positionIds.has(position.id)) {
      context.addIssue({ code: 'custom', path: ['positions', index, 'id'], message: '持仓批次 id 不能重复' });
    }
    positionIds.add(position.id);
    if (!accountIds.has(position.portfolioId)) {
      context.addIssue({ code: 'custom', path: ['positions', index, 'portfolioId'], message: '持仓引用的账户不存在' });
    }
    const aliasKeys = new Set();
    for (const [aliasIndex, alias] of position.aliases.entries()) {
      const key = `${alias.providerId}:${alias.providerSymbol}`;
      if (aliasKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['positions', index, 'aliases', aliasIndex],
          message: '同一持仓的供应商别名不能重复',
        });
      }
      aliasKeys.add(key);
    }
  }

  const cashKeys = new Set();
  for (const [index, item] of value.cash.entries()) {
    if (!accountIds.has(item.portfolioId)) {
      context.addIssue({ code: 'custom', path: ['cash', index, 'portfolioId'], message: '现金引用的账户不存在' });
    }
    const key = `${item.portfolioId}:${item.currency}`;
    if (cashKeys.has(key)) {
      context.addIssue({ code: 'custom', path: ['cash', index], message: '账户现金币种不能重复' });
    }
    cashKeys.add(key);
  }
});

export const PortfolioImportResultSchema = z.object({
  accountsMerged: z.number().int().nonnegative(),
  positionsMerged: z.number().int().nonnegative(),
  cashMerged: z.number().int().nonnegative(),
}).strict();

export const HoldingsPositionSchema = z.object({
  lotId: EntityIdSchema,
  portfolioId: EntityIdSchema,
  board: HoldingBoardSchema,
  instrumentId: EntityIdSchema,
  symbol: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(256),
  quantity: DecimalStringSchema,
  costPrice: DecimalStringSchema,
  lastPrice: DecimalStringSchema.nullable(),
  previousClose: DecimalStringSchema.nullable(),
  listingCurrency: CurrencySchema,
  fxToCny: DecimalStringSchema,
  marketValueListing: DecimalStringSchema.nullable(),
  marketValueCny: DecimalStringSchema.nullable(),
  costCny: DecimalStringSchema,
  positionPnlCny: DecimalStringSchema.nullable(),
  positionPnlPct: DecimalStringSchema.nullable(),
  dayPnlCny: DecimalStringSchema.nullable(),
  dayPnlPct: DecimalStringSchema.nullable(),
  quoteStatus: z.enum(['live', 'missing']),
}).strict();

export const HoldingsMoveSchema = z.object({
  id: z.enum(['day', 'week', 'month']),
  label: z.string().trim().min(1).max(16),
  pnlCny: DecimalStringSchema.nullable(),
  pnlPct: DecimalStringSchema.nullable(),
  addedPnlCny: DecimalStringSchema.nullable(),
  addedPnlPct: DecimalStringSchema.nullable(),
  sampleLabel: z.string().trim().max(16),
  samplePnlCny: DecimalStringSchema.nullable(),
  samplePnlPct: DecimalStringSchema.nullable(),
  sampleAddedPnlCny: DecimalStringSchema.nullable(),
  sampleAddedPnlPct: DecimalStringSchema.nullable(),
  backcast: z.boolean(),
}).strict();

export const HoldingsMoveGroupSchema = z.object({
  id: z.enum(['a_share', 'b_share']),
  label: z.string().trim().min(1).max(16),
  moves: z.array(HoldingsMoveSchema),
}).strict();

export const HoldingsBoardSchema = z.object({
  baseCurrency: z.literal('CNY'),
  fx: z.object({
    usdCny: DecimalStringSchema.nullable(),
    hkdCny: DecimalStringSchema.nullable(),
  }).strict(),
  summary: z.object({
    aShareCny: DecimalStringSchema,
    bShareCny: DecimalStringSchema,
    cashCny: DecimalStringSchema,
    totalCny: DecimalStringSchema,
    lines: z.array(z.object({
      id: z.enum(['a_share', 'b_sh', 'b_sz']),
      label: z.string().trim().min(1).max(32),
      listingCurrency: CurrencySchema,
      stockListing: DecimalStringSchema.nullable(),
      stockCny: DecimalStringSchema,
      cashListing: DecimalStringSchema,
      cashCny: DecimalStringSchema.nullable(),
      totalListing: DecimalStringSchema.nullable(),
      totalCny: DecimalStringSchema,
    }).strict()),
  }).strict(),
  accounts: z.array(z.object({
    id: EntityIdSchema,
    name: z.string(),
    group: z.enum(['a', 'b']),
    cash: z.array(z.object({
      currency: CurrencySchema,
      amount: DecimalStringSchema,
      amountCny: DecimalStringSchema.nullable(),
    }).strict()),
    marketValueCny: DecimalStringSchema,
    totalCny: DecimalStringSchema,
  }).strict()),
  positions: z.array(HoldingsPositionSchema),
  moves: z.array(HoldingsMoveSchema).default([]),
  moveGroups: z.array(HoldingsMoveGroupSchema).default([]),
  missingQuotes: z.array(z.string()),
  updatedAt: EpochMillisSchema,
  note: z.string().max(500).default(''),
}).strict();

export function emptyPersonalAssetDashboard(updatedAt = 0, note = '') {
  return {
    source: 'workbook',
    currency: 'CNY',
    points: [],
    allocation: [],
    dividend: { total: '0', items: [] },
    latest: {
      label: '',
      total: '0',
      equity: '0',
      housingFund: '0',
      increase: '0',
      increaseRate: '0',
      cumulativeGrowthRate: '0',
      firstLabel: '',
      firstTotal: '0',
    },
    updatedAt,
    note,
  };
}
