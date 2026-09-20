import { randomUUID } from 'node:crypto';
import {
  AppendTransactionInputSchema,
  CreatePortfolioInputSchema,
  parseContract,
  PERSONAL_ASSET_TYPE_SEEDS,
  PersonalAssetAccountSchema,
  PersonalAssetImportSchema,
  UpsertPersonalAssetAccountInputSchema,
  PersonalAssetImportResultSchema,
  PersonalAssetSnapshotSchema,
  PersonalAssetTypeSchema,
  PortfolioImportSchema,
  UpsertHoldingCashInputSchema,
  UpsertHoldingLotInputSchema,
  UpsertInstrumentAliasInputSchema,
  UpsertInstrumentInputSchema,
  ValidationError,
} from '../../../contracts/src/index.js';

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function mapInstrument(row) {
  return {
    id: row.id,
    canonicalKey: row.canonical_symbol,
    symbol: row.symbol,
    name: row.name,
    assetClass: row.asset_class,
    market: row.market,
    exchangeCode: row.exchange_code,
    currency: row.currency,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPortfolio(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    marketScope: row.market_scope,
    baseCurrency: row.base_currency,
    initialCapital: row.initial_capital_decimal,
    archivedAt: row.archived_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransaction(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    portfolioId: row.portfolio_id,
    instrumentId: row.instrument_id || null,
    type: row.transaction_type,
    quantity: row.quantity_decimal,
    price: row.price_decimal,
    cashAmount: row.cash_amount_decimal,
    currency: row.currency,
    fees: row.fees_decimal,
    note: row.note,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function mapCash(row) {
  return {
    portfolioId: row.portfolio_id,
    currency: row.currency,
    amount: row.amount_decimal,
    updatedAt: row.updated_at,
  };
}

function mapHoldingLot(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    portfolioId: row.portfolio_id,
    instrumentId: row.instrument_id,
    board: row.board,
    quantity: row.quantity_decimal,
    costPrice: row.cost_price_decimal,
    listingCurrency: row.listing_currency,
    note: row.note || '',
    archivedAt: row.archived_at ?? null,
    openedAt: row.opened_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPersonalAssetType(row) {
  return parseContract(PersonalAssetTypeSchema, {
    key: row.key,
    workspaceId: row.workspace_id,
    name: row.name,
    sortOrder: row.sort_order,
    hiddenAt: row.hidden_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapPersonalAssetAccount(row) {
  return parseContract(PersonalAssetAccountSchema, {
    id: row.id,
    workspaceId: row.workspace_id,
    typeKey: row.type_key,
    name: row.name,
    note: row.note || '',
    source: row.source,
    amount: row.amount_decimal,
    currency: row.currency,
    sortOrder: row.sort_order,
    archivedAt: row.archived_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapPersonalAssetSnapshot(row, lines = []) {
  return parseContract(PersonalAssetSnapshotSchema, {
    id: row.id,
    workspaceId: row.workspace_id,
    label: row.label,
    total: row.total_decimal,
    increase: row.increase_decimal,
    increaseRate: row.increase_rate_decimal,
    recordedAt: row.recorded_at,
    createdAt: row.created_at,
    lines,
  });
}

export function createTradingRepository(database, emitEvent) {
  const repository = {
    upsertInstrument(value) {
      const input = parseContract(UpsertInstrumentInputSchema, value);
      const now = Date.now();
      const id = input.id || randomUUID();
      database.prepare(`INSERT INTO instruments
        (id, canonical_symbol, symbol, name, asset_class, market, exchange_code, currency,
         metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canonical_symbol) DO UPDATE SET
          symbol = excluded.symbol,
          name = excluded.name,
          asset_class = excluded.asset_class,
          market = excluded.market,
          exchange_code = excluded.exchange_code,
          currency = excluded.currency,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`)
        .run(id, input.canonicalKey, input.symbol, input.name, input.assetClass, input.market,
          input.exchangeCode, input.currency, JSON.stringify(input.metadata), now, now);
      return mapInstrument(database.prepare('SELECT * FROM instruments WHERE canonical_symbol = ?')
        .get(input.canonicalKey));
    },

    upsertInstrumentAlias(value) {
      const input = parseContract(UpsertInstrumentAliasInputSchema, value);
      const now = Date.now();
      database.prepare(`INSERT INTO instrument_aliases
        (instrument_id, provider_id, provider_symbol, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider_id, provider_symbol) DO UPDATE SET
          instrument_id = excluded.instrument_id,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`)
        .run(input.instrumentId, input.providerId, input.providerSymbol,
          JSON.stringify(input.metadata), now, now);
      return { ...input, createdAt: now, updatedAt: now };
    },

    getInstrumentByAlias(providerId, providerSymbol) {
      const row = database.prepare(`SELECT i.* FROM instrument_aliases a
        JOIN instruments i ON i.id = a.instrument_id
        WHERE a.provider_id = ? AND a.provider_symbol = ?`).get(providerId, providerSymbol);
      return row ? mapInstrument(row) : null;
    },

    createPortfolio(value) {
      const input = parseContract(CreatePortfolioInputSchema, value);
      const now = Date.now();
      const id = input.id || randomUUID();
      database.transaction(() => {
        database.prepare(`INSERT INTO portfolios
          (id, workspace_id, name, market_scope, base_currency, initial_capital,
           initial_capital_decimal, archived_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
          .run(id, input.workspaceId, input.name, input.marketScope, input.baseCurrency,
            Number(input.initialCapital), input.initialCapital, now, now);
        emitEvent('trading.portfolio.created.v1', 'portfolio', id, { portfolioId: id }, input.workspaceId);
      })();
      return mapPortfolio(database.prepare('SELECT * FROM portfolios WHERE id = ?').get(id));
    },

    appendTransaction(value) {
      const input = parseContract(AppendTransactionInputSchema, value);
      if (['buy', 'sell', 'split'].includes(input.type) && !input.instrumentId) {
        throw new ValidationError('证券交易必须指定 instrumentId', ['instrumentId']);
      }
      const now = Date.now();
      const id = input.id || randomUUID();
      database.transaction(() => {
        database.prepare(`INSERT INTO transactions
          (id, workspace_id, portfolio_id, instrument_id, transaction_type, quantity, price,
           currency, fees, note, occurred_at, created_at, quantity_decimal, price_decimal,
           cash_amount_decimal, fees_decimal)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, input.workspaceId, input.portfolioId, input.instrumentId, input.type,
            Number(input.quantity), Number(input.price), input.currency, Number(input.fees), input.note,
            input.occurredAt, now, input.quantity, input.price, input.cashAmount, input.fees);
        emitEvent('trading.transaction.appended.v1', 'transaction', id,
          { transactionId: id, portfolioId: input.portfolioId }, input.workspaceId);
      })();
      return mapTransaction(database.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
    },

    listTransactions(portfolioId, limit = 100) {
      return database.prepare(`SELECT * FROM transactions WHERE portfolio_id = ?
        ORDER BY occurred_at DESC, created_at DESC LIMIT ?`)
        .all(portfolioId, Math.max(1, Math.min(Number(limit) || 100, 500))).map(mapTransaction);
    },

    getInstrument(id) {
      const row = database.prepare('SELECT * FROM instruments WHERE id = ?').get(id);
      return row ? mapInstrument(row) : null;
    },

    getInstrumentByKey(canonicalKey) {
      const row = database.prepare('SELECT * FROM instruments WHERE canonical_symbol = ?').get(canonicalKey);
      return row ? mapInstrument(row) : null;
    },

    getPortfolio(id) {
      const row = database.prepare('SELECT * FROM portfolios WHERE id = ?').get(id);
      return row ? mapPortfolio(row) : null;
    },

    listPortfolios(workspaceId) {
      return database.prepare('SELECT * FROM portfolios WHERE workspace_id = ? ORDER BY created_at')
        .all(workspaceId).map(mapPortfolio);
    },

    listHoldingLots(workspaceId) {
      return database.prepare(`SELECT * FROM holding_lots
        WHERE workspace_id = ? AND archived_at IS NULL
        ORDER BY board, id`)
        .all(workspaceId).map(mapHoldingLot);
    },

    getHoldingLot(id) {
      const row = database.prepare('SELECT * FROM holding_lots WHERE id = ?').get(id);
      return row ? mapHoldingLot(row) : null;
    },

    upsertHoldingLot(value) {
      const input = parseContract(UpsertHoldingLotInputSchema, value);
      const now = Date.now();
      const id = input.id || randomUUID();
      database.transaction(() => {
        database.prepare(`INSERT INTO holding_lots
          (id, workspace_id, portfolio_id, instrument_id, board, quantity_decimal, cost_price_decimal,
           listing_currency, note, archived_at, opened_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            portfolio_id = excluded.portfolio_id,
            instrument_id = excluded.instrument_id,
            board = excluded.board,
            quantity_decimal = excluded.quantity_decimal,
            cost_price_decimal = excluded.cost_price_decimal,
            listing_currency = excluded.listing_currency,
            note = excluded.note,
            archived_at = excluded.archived_at,
            opened_at = COALESCE(excluded.opened_at, holding_lots.opened_at),
            updated_at = excluded.updated_at`)
          .run(id, input.workspaceId, input.portfolioId, input.instrumentId, input.board,
            input.quantity, input.costPrice, input.listingCurrency, input.note || '',
            input.archivedAt ?? null, input.openedAt ?? null, now, now);
        emitEvent('trading.holding-lot.upserted.v1', 'holding-lot', id,
          { lotId: id, portfolioId: input.portfolioId }, input.workspaceId);
      })();
      return mapHoldingLot(database.prepare('SELECT * FROM holding_lots WHERE id = ?').get(id));
    },

    archiveHoldingLot(id, workspaceId) {
      const now = Date.now();
      database.transaction(() => {
        database.prepare('UPDATE holding_lots SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
          .run(now, now, id);
        emitEvent('trading.holding-lot.archived.v1', 'holding-lot', id, { lotId: id }, workspaceId);
      })();
      return this.getHoldingLot(id);
    },

    listPortfolioCash(portfolioId) {
      return database.prepare('SELECT * FROM portfolio_cash WHERE portfolio_id = ? ORDER BY currency')
        .all(portfolioId).map(mapCash);
    },

    listWorkspaceCash(workspaceId) {
      return database.prepare(`SELECT c.* FROM portfolio_cash c
        JOIN portfolios p ON p.id = c.portfolio_id
        WHERE p.workspace_id = ? ORDER BY p.id, c.currency`)
        .all(workspaceId).map(mapCash);
    },

    listInstrumentAliases(instrumentIds = []) {
      const ids = [...new Set(instrumentIds.filter(Boolean))];
      if (!ids.length) return [];
      const placeholders = ids.map(() => '?').join(',');
      return database.prepare(`SELECT * FROM instrument_aliases WHERE instrument_id IN (${placeholders})`)
        .all(...ids).map((row) => ({
          instrumentId: row.instrument_id,
          providerId: row.provider_id,
          providerSymbol: row.provider_symbol,
          metadata: parseJson(row.metadata_json),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
    },

    upsertPortfolioCash(value) {
      const input = parseContract(UpsertHoldingCashInputSchema, value);
      const portfolio = this.getPortfolio(input.portfolioId);
      if (!portfolio) throw new ValidationError('账户不存在', ['portfolioId']);
      const now = Date.now();
      database.transaction(() => {
        database.prepare(`INSERT INTO portfolio_cash (portfolio_id, currency, amount_decimal, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(portfolio_id, currency) DO UPDATE SET
            amount_decimal = excluded.amount_decimal,
            updated_at = excluded.updated_at`)
          .run(input.portfolioId, input.currency, input.amount, now);
        emitEvent('trading.portfolio-cash.upserted.v1', 'portfolio', input.portfolioId,
          { portfolioId: input.portfolioId, currency: input.currency }, portfolio.workspaceId);
      })();
      return mapCash(database.prepare('SELECT * FROM portfolio_cash WHERE portfolio_id = ? AND currency = ?')
        .get(input.portfolioId, input.currency));
    },

    mergePortfolioImport(workspaceId, value) {
      const input = parseContract(PortfolioImportSchema, value);
      for (const account of input.accounts) {
        const existing = this.getPortfolio(account.id);
        if (existing && existing.workspaceId !== workspaceId) {
          throw new ValidationError('导入账户已属于其他工作区', ['accounts', account.id]);
        }
        if (existing?.archivedAt != null) {
          throw new ValidationError('不能向已归档账户导入持仓', ['accounts', account.id]);
        }
      }
      for (const position of input.positions) {
        const existing = this.getHoldingLot(position.id);
        if (existing && existing.workspaceId !== workspaceId) {
          throw new ValidationError('导入持仓批次已属于其他工作区', ['positions', position.id]);
        }
      }

      const merge = database.transaction(() => {
        for (const account of input.accounts) {
          const existing = this.getPortfolio(account.id);
          if (!existing) {
            this.createPortfolio({ ...account, workspaceId });
            continue;
          }
          const unchanged = existing.name === account.name
            && existing.marketScope === account.marketScope
            && existing.baseCurrency === account.baseCurrency
            && existing.initialCapital === account.initialCapital;
          if (!unchanged) {
            const now = Date.now();
            database.prepare(`UPDATE portfolios SET
              name = ?, market_scope = ?, base_currency = ?, initial_capital = ?,
              initial_capital_decimal = ?, updated_at = ?
              WHERE id = ? AND workspace_id = ?`)
              .run(account.name, account.marketScope, account.baseCurrency,
                Number(account.initialCapital), account.initialCapital, now, account.id, workspaceId);
            emitEvent('trading.portfolio.updated.v1', 'portfolio', account.id,
              { portfolioId: account.id }, workspaceId);
          }
        }

        for (const position of input.positions) {
          const instrument = this.upsertInstrument(position.instrument);
          for (const alias of position.aliases) {
            this.upsertInstrumentAlias({ ...alias, instrumentId: instrument.id });
          }
          this.upsertHoldingLot({
            id: position.id,
            workspaceId,
            portfolioId: position.portfolioId,
            instrumentId: instrument.id,
            board: position.board,
            quantity: position.quantity,
            costPrice: position.costPrice,
            listingCurrency: position.listingCurrency,
            note: position.note,
            openedAt: position.openedAt,
          });
        }
        for (const cash of input.cash) this.upsertPortfolioCash(cash);

        return {
          accountsMerged: input.accounts.length,
          positionsMerged: input.positions.length,
          cashMerged: input.cash.length,
        };
      });
      return merge();
    },

    ensurePersonalAssetTypes(workspaceId) {
      const now = Date.now();
      const existing = new Set(this.listPersonalAssetTypes(workspaceId).map((item) => item.key));
      database.transaction(() => {
        for (const seed of PERSONAL_ASSET_TYPE_SEEDS) {
          if (existing.has(seed.key)) continue;
          database.prepare(`INSERT INTO personal_asset_types
            (workspace_id, key, name, sort_order, hidden_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?)`)
            .run(workspaceId, seed.key, seed.name, seed.sortOrder, now, now);
        }
      })();
      return this.listPersonalAssetTypes(workspaceId);
    },

    listPersonalAssetTypes(workspaceId) {
      return database.prepare(`SELECT * FROM personal_asset_types
        WHERE workspace_id = ? ORDER BY sort_order, key`)
        .all(workspaceId).map(mapPersonalAssetType);
    },

    listPersonalAssetAccounts(workspaceId) {
      return database.prepare(`SELECT * FROM personal_asset_accounts
        WHERE workspace_id = ? ORDER BY sort_order, name`)
        .all(workspaceId).map(mapPersonalAssetAccount);
    },

    getPersonalAssetAccount(id) {
      const row = database.prepare('SELECT * FROM personal_asset_accounts WHERE id = ?').get(id);
      return row ? mapPersonalAssetAccount(row) : null;
    },

    upsertPersonalAssetAccount(value) {
      const input = parseContract(UpsertPersonalAssetAccountInputSchema, value);
      const now = Date.now();
      const existing = this.getPersonalAssetAccount(input.id);
      database.transaction(() => {
        database.prepare(`INSERT INTO personal_asset_accounts
          (id, workspace_id, type_key, name, note, source, amount_decimal, currency, sort_order,
           archived_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            type_key = excluded.type_key,
            name = excluded.name,
            note = excluded.note,
            source = excluded.source,
            amount_decimal = excluded.amount_decimal,
            currency = excluded.currency,
            sort_order = excluded.sort_order,
            archived_at = excluded.archived_at,
            updated_at = excluded.updated_at`)
          .run(
            input.id, input.workspaceId, input.typeKey, input.name, input.note || '',
            input.source, input.amount, input.currency, input.sortOrder,
            input.archivedAt ?? null, existing?.createdAt || now, now,
          );
        emitEvent('trading.personal-asset.account.upserted.v1', 'personal-asset-account', input.id,
          { accountId: input.id, typeKey: input.typeKey }, input.workspaceId);
      })();
      return this.getPersonalAssetAccount(input.id);
    },

    listPersonalAssetSnapshots(workspaceId) {
      const rows = database.prepare(`SELECT * FROM personal_asset_snapshots
        WHERE workspace_id = ? ORDER BY recorded_at, label`)
        .all(workspaceId);
      const lines = database.prepare(`SELECT l.* FROM personal_asset_snapshot_lines l
        JOIN personal_asset_snapshots s ON s.id = l.snapshot_id
        WHERE s.workspace_id = ?`)
        .all(workspaceId);
      const linesBySnapshot = new Map();
      for (const line of lines) {
        const list = linesBySnapshot.get(line.snapshot_id) || [];
        list.push({
          accountId: line.account_id,
          typeKey: line.type_key,
          amount: line.amount_decimal,
        });
        linesBySnapshot.set(line.snapshot_id, list);
      }
      return rows.map((row) => mapPersonalAssetSnapshot(row, linesBySnapshot.get(row.id) || []));
    },

    upsertPersonalAssetSnapshot(workspaceId, snapshot) {
      const input = parseContract(PersonalAssetSnapshotSchema.omit({
        workspaceId: true,
        createdAt: true,
      }).extend({
        id: PersonalAssetSnapshotSchema.shape.id.optional(),
        workspaceId: PersonalAssetSnapshotSchema.shape.workspaceId.optional(),
        createdAt: PersonalAssetSnapshotSchema.shape.createdAt.optional(),
      }), { ...snapshot, workspaceId });
      const now = Date.now();
      const existing = input.id
        ? database.prepare('SELECT * FROM personal_asset_snapshots WHERE id = ?').get(input.id)
        : null;
      const id = existing?.id || input.id || randomUUID();
      database.transaction(() => {
        database.prepare(`INSERT INTO personal_asset_snapshots
          (id, workspace_id, label, total_decimal, increase_decimal, increase_rate_decimal, recorded_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            total_decimal = excluded.total_decimal,
            increase_decimal = excluded.increase_decimal,
            increase_rate_decimal = excluded.increase_rate_decimal,
            recorded_at = excluded.recorded_at`)
          .run(id, workspaceId, input.label, input.total, input.increase, input.increaseRate,
            input.recordedAt, existing?.created_at || now);
        database.prepare('DELETE FROM personal_asset_snapshot_lines WHERE snapshot_id = ?').run(id);
        const insertLine = database.prepare(`INSERT INTO personal_asset_snapshot_lines
          (snapshot_id, account_id, type_key, amount_decimal) VALUES (?, ?, ?, ?)`);
        for (const line of input.lines) {
          insertLine.run(id, line.accountId, line.typeKey, line.amount);
        }
        emitEvent('trading.personal-asset.snapshot.upserted.v1', 'personal-asset-snapshot', id,
          { snapshotId: id, label: input.label }, workspaceId);
      })();
      return this.listPersonalAssetSnapshots(workspaceId).find((item) => item.id === id);
    },

    listPersonalAssetDividends(workspaceId) {
      return database.prepare(`SELECT * FROM personal_asset_dividends
        WHERE workspace_id = ? ORDER BY sort_order, name`)
        .all(workspaceId).map((row) => ({
          name: row.name,
          value: row.value_decimal,
        }));
    },

    mergePersonalAssetImport(workspaceId, value) {
      const input = parseContract(PersonalAssetImportSchema, value);
      const types = this.ensurePersonalAssetTypes(workspaceId);
      const typeKeys = new Set(types.map((item) => item.key));
      for (const account of input.accounts) {
        if (!typeKeys.has(account.typeKey)) {
          throw new ValidationError('导入账户引用了未知资产类型', ['accounts', account.id, 'typeKey']);
        }
        const existing = this.getPersonalAssetAccount(account.id);
        if (existing && existing.workspaceId !== workspaceId) {
          throw new ValidationError('导入资产账户已属于其他工作区', ['accounts', account.id]);
        }
      }
      const merge = database.transaction(() => {
        for (const account of input.accounts) {
          const existing = this.getPersonalAssetAccount(account.id);
          this.upsertPersonalAssetAccount({
            id: account.id,
            workspaceId,
            typeKey: account.typeKey,
            name: existing?.name || account.name,
            note: existing ? existing.note : account.note,
            source: account.source,
            amount: existing && existing.source === 'manual' && existing.updatedAt > (existing.createdAt || 0)
              ? existing.amount
              : account.amount,
            currency: account.currency,
            sortOrder: existing?.sortOrder ?? account.sortOrder,
            archivedAt: existing?.archivedAt ?? null,
          });
        }
        const accountById = new Map(this.listPersonalAssetAccounts(workspaceId).map((item) => [item.id, item]));
        for (const snapshot of input.snapshots) {
          this.upsertPersonalAssetSnapshot(workspaceId, {
            id: snapshot.id,
            label: snapshot.label,
            total: snapshot.total,
            increase: snapshot.increase,
            increaseRate: snapshot.increaseRate,
            recordedAt: snapshot.recordedAt,
            lines: snapshot.lines.map((line) => ({
              accountId: line.accountId,
              typeKey: accountById.get(line.accountId)?.typeKey || 'extra',
              amount: line.amount,
            })),
          });
        }
        emitEvent('trading.personal-asset.imported.v1', 'personal-asset-ledger', workspaceId,
          { accountsMerged: input.accounts.length, snapshotsMerged: input.snapshots.length }, workspaceId);
        return parseContract(PersonalAssetImportResultSchema, {
          typesEnsured: types.length,
          accountsMerged: input.accounts.length,
          snapshotsMerged: input.snapshots.length,
          dividendsMerged: 0,
        });
      });
      return merge();
    },
  };
  return Object.freeze(repository);
}
