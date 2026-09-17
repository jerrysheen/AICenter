import { parseContract, PortfolioImportSchema } from '../../contracts/src/index.js';

// Compatibility-only empty exports. Personal holdings must live in an ignored
// instance import file or SQLite, never in the connector package.
export const HOLDING_ACCOUNTS = Object.freeze([]);
export const HOLDING_LOTS = Object.freeze([]);

function canonicalKey(lot) {
  if (lot.canonicalKey) return lot.canonicalKey;
  const market = lot.market === 'hk' ? 'HK:XHKG' : `CN:${lot.exchangeCode}`;
  return `${market}:${lot.symbol}`;
}

export function legacyHoldingsBookToPortfolioImport(legacyBook = {}) {
  const legacyAccounts = legacyBook.accounts || [];
  const accounts = legacyAccounts.map((account) => ({
    id: account.id,
    name: account.name,
    marketScope: account.marketScope || 'mixed',
    baseCurrency: account.baseCurrency,
    initialCapital: account.initialCapital || '0',
  }));
  const positions = (legacyBook.lots || []).map((lot) => ({
    id: lot.id,
    portfolioId: lot.portfolioId,
    board: lot.board,
    quantity: String(lot.quantity),
    costPrice: String(lot.costPrice),
    listingCurrency: lot.listingCurrency,
    note: lot.note || '',
    openedAt: lot.openedAt ?? null,
    instrument: {
      ...(lot.instrumentId ? { id: lot.instrumentId } : {}),
      canonicalKey: canonicalKey(lot),
      symbol: lot.symbol,
      name: lot.name,
      assetClass: lot.assetClass || 'equity',
      market: lot.market,
      exchangeCode: lot.exchangeCode || '',
      currency: lot.listingCurrency,
      metadata: { board: lot.board },
    },
    aliases: [
      ...(Array.isArray(lot.aliases) ? lot.aliases : []),
      ...(lot.yahoo ? [{ providerId: 'yahoo', providerSymbol: lot.yahoo, metadata: {} }] : []),
    ],
  }));
  const cash = legacyAccounts.flatMap((account) => (account.cash || []).map((item) => ({
    portfolioId: account.id,
    currency: item.currency,
    amount: String(item.amount),
  })));
  return parseContract(PortfolioImportSchema, {
    schemaVersion: 1,
    mode: 'merge',
    accounts,
    positions,
    cash,
  });
}

// Phase-1 compatibility name. It preserves the former { accounts, lots }
// return shape without restoring personal data or startup seeding.
export function createManualHoldingsBook(legacyBook = {}) {
  return Object.freeze({
    accounts: legacyBook.accounts || HOLDING_ACCOUNTS,
    lots: legacyBook.lots || HOLDING_LOTS,
  });
}
