import {
  AddHoldingLotInputSchema,
  emptyPersonalAssetDashboard,
  HoldingsBoardSchema,
  parseContract,
  PortfolioImportResultSchema,
  PortfolioImportSchema,
  UpsertHoldingCashInputSchema,
  ValidationError,
} from '../../contracts/src/index.js';
import { buildHoldingsBoard, buildHoldingsMoveGroups, buildHoldingsMoves } from './holdings-board.js';

const BOARD_META = {
  a_share: { listingCurrency: 'CNY', market: 'cn', exchangeCode: 'XSHG' },
  hk_connect: { listingCurrency: 'HKD', market: 'hk', exchangeCode: 'XHKG' },
  b_sh: { listingCurrency: 'USD', market: 'cn', exchangeCode: 'XSHG' },
  b_sz: { listingCurrency: 'HKD', market: 'cn', exchangeCode: 'XSHE' },
};

const DEFAULT_FX_SYMBOLS = ['USDCNY=X', 'HKDCNY=X'];

function exchangeFromYahoo(symbol, fallback) {
  const upper = String(symbol || '').toUpperCase();
  if (upper.endsWith('.SZ')) return 'XSHE';
  if (upper.endsWith('.SS')) return 'XSHG';
  if (upper.endsWith('.HK')) return 'XHKG';
  return fallback;
}

function localSymbol(yahoo, fallback) {
  const raw = String(yahoo || fallback || '').trim().toUpperCase();
  return raw.replace(/\.(SS|SZ|HK)$/i, '') || fallback;
}

function wrapMarketDataPort(marketDataPort) {
  if (!marketDataPort) return null;
  return {
    async read(sourceId, input = {}, context = {}) {
      if (sourceId === 'market.search') return { data: await marketDataPort.search(input.query) };
      if (sourceId === 'market.quotes') {
        return { data: await marketDataPort.fetchQuotes(input.symbols, { refresh: Boolean(context.refresh) }) };
      }
      if (sourceId === 'market.history') {
        const data = typeof marketDataPort.fetchHistory === 'function'
          ? await marketDataPort.fetchHistory(input.symbols, input)
          : [];
        return { data };
      }
      const board = String(sourceId || '').replace(/^market\./, '') || 'overview';
      return { data: await marketDataPort.getBoard({ board, ...input }) };
    },
  };
}

export function createTradingService({
  tradingRepository,
  sourcePort,
  marketDataPort,
  personalAssetPort,
  workspaceId: configuredWorkspaceId = 'local',
}) {
  const resolvedSourcePort = sourcePort || wrapMarketDataPort(marketDataPort);
  if (!tradingRepository || !resolvedSourcePort) throw new Error('trading ports are required');
  sourcePort = resolvedSourcePort;

  function resolveWorkspaceId(requested) {
    const workspaceId = requested || configuredWorkspaceId;
    if (workspaceId !== configuredWorkspaceId) throw new ValidationError('当前持仓账本不支持该工作区', ['workspaceId']);
    return workspaceId;
  }

  function requirePortfolio(portfolioId, workspaceId = configuredWorkspaceId) {
    const portfolio = tradingRepository.getPortfolio(portfolioId);
    if (!portfolio || portfolio.archivedAt != null || portfolio.workspaceId !== workspaceId) {
      throw new ValidationError('持仓账户不存在或不属于当前工作区', ['portfolioId']);
    }
    return portfolio;
  }

  function accountGroup(portfolio, lots) {
    const boards = new Set(lots.filter((lot) => lot.portfolioId === portfolio.id).map((lot) => lot.board));
    const hasA = [...boards].some((board) => board === 'a_share' || board === 'hk_connect');
    const hasB = [...boards].some((board) => board === 'b_sh' || board === 'b_sz');
    if (hasA && !hasB) return 'a';
    if (hasB && !hasA) return 'b';
    return portfolio.baseCurrency === 'CNY' ? 'a' : 'b';
  }

  return Object.freeze({
    async getBoard(query) {
      const { board = 'overview', ...input } = query || {};
      return (await sourcePort.read(`market.${board}`, input)).data;
    },
    async search(query) {
      return query ? (await sourcePort.read('market.search', { query })).data : [];
    },
    getPersonalAssetDashboard() {
      return personalAssetPort
        ? personalAssetPort.getDashboard()
        : emptyPersonalAssetDashboard(Date.now(), '个人资产端口未配置');
    },
    async getHoldingsBoard(query = {}) {
      const refresh = Boolean(query.refresh);
      const workspaceId = resolveWorkspaceId(query.workspaceId);
      const persistedLots = tradingRepository.listHoldingLots(workspaceId);
      const portfolios = tradingRepository.listPortfolios(workspaceId)
        .filter((portfolio) => portfolio.archivedAt == null);
      const portfolioIds = new Set(portfolios.map((portfolio) => portfolio.id));
      const lots = persistedLots.filter((lot) => portfolioIds.has(lot.portfolioId));
      const instruments = lots.map((lot) => tradingRepository.getInstrument(lot.instrumentId)).filter(Boolean);
      const aliases = tradingRepository.listInstrumentAliases(instruments.map((item) => item.id));
      const cash = tradingRepository.listWorkspaceCash(workspaceId)
        .filter((item) => portfolioIds.has(item.portfolioId));
      const yahooSymbols = [...new Set([
        ...aliases.filter((item) => item.providerId === 'yahoo').map((item) => item.providerSymbol),
        ...DEFAULT_FX_SYMBOLS,
      ])];
      const [quotesSnapshot, historySnapshot] = await Promise.all([
        sourcePort.read('market.quotes', { symbols: yahooSymbols }, { refresh }),
        sourcePort.read('market.history', { symbols: yahooSymbols, range: '3mo', interval: '1d' }, { refresh }),
      ]);
      const quotes = quotesSnapshot.data;
      const series = historySnapshot.data;
      const board = buildHoldingsBoard({
        accounts: portfolios.map((portfolio) => ({
          id: portfolio.id,
          name: portfolio.name,
          group: accountGroup(portfolio, lots),
        })),
        lots,
        instruments,
        aliases,
        cash,
        quotes,
        now: Date.now(),
        note: cash.every((item) => item.amount === '0')
          ? '持仓数量和成本已落盘。账户现金目前为 0，保存现金后会按实时汇率折算。'
          : '持仓按 A 股、B 股沪市、B 股深市分行核算。波动只计原持仓；期间新买入单独列出，导入仓无开仓日时仍按现仓回算。',
      });
      const moveInput = {
        lots,
        aliases,
        cash,
        series,
        positions: board.positions,
        now: board.updatedAt,
        fx: board.fx,
      };
      board.moves = buildHoldingsMoves({
        ...moveInput,
        nowCny: board.summary.totalCny,
      });
      board.moveGroups = buildHoldingsMoveGroups({
        ...moveInput,
        summary: board.summary,
      });
      if (!board.fx.usdCny) board.missingQuotes.push('USDCNY=X');
      if (!board.fx.hkdCny) board.missingQuotes.push('HKDCNY=X');
      board.missingQuotes = [...new Set(board.missingQuotes)];
      if (board.missingQuotes.length) {
        board.note = `${board.note} 缺行情：${board.missingQuotes.join(', ')}`;
      }
      if (board.note.length > 500) board.note = `${board.note.slice(0, 497)}...`;
      return parseContract(HoldingsBoardSchema, board);
    },
    addHoldingLot(input) {
      input = parseContract(AddHoldingLotInputSchema, input);
      const board = input.board;
      const meta = BOARD_META[board];
      if (!meta) throw new Error('不支持的持仓市场');
      requirePortfolio(input.portfolioId);
      const yahoo = String(input.yahoo || '').trim().toUpperCase();
      const symbol = String(input.symbol || localSymbol(yahoo, '')).trim();
      const exchangeCode = exchangeFromYahoo(yahoo, meta.exchangeCode);
      const market = meta.market;
      const canonicalKey = `${market === 'hk' ? 'HK:XHKG' : `CN:${exchangeCode}`}:${symbol}`;
      const instrument = tradingRepository.upsertInstrument({
        canonicalKey,
        symbol,
        name: String(input.name || symbol).trim(),
        assetClass: 'equity',
        market,
        exchangeCode,
        currency: meta.listingCurrency,
        metadata: { board },
      });
      tradingRepository.upsertInstrumentAlias({
        instrumentId: instrument.id,
        providerId: 'yahoo',
        providerSymbol: yahoo,
        metadata: {},
      });
      return tradingRepository.upsertHoldingLot({
        workspaceId: configuredWorkspaceId,
        portfolioId: input.portfolioId,
        instrumentId: instrument.id,
        board,
        quantity: String(input.quantity),
        costPrice: String(input.costPrice),
        listingCurrency: meta.listingCurrency,
        note: '',
        openedAt: input.openedAt === undefined ? Date.now() : input.openedAt,
      });
    },
    archiveHoldingLot(id) {
      const lot = tradingRepository.getHoldingLot(id);
      if (!lot || lot.workspaceId !== configuredWorkspaceId) {
        throw new ValidationError('持仓批次不存在', ['id']);
      }
      return tradingRepository.archiveHoldingLot(id, configuredWorkspaceId);
    },
    upsertPortfolioCash(input) {
      input = parseContract(UpsertHoldingCashInputSchema, input);
      requirePortfolio(input.portfolioId);
      return tradingRepository.upsertPortfolioCash(input);
    },
    importPortfolio(input) {
      input = parseContract(PortfolioImportSchema, input);
      if (typeof tradingRepository.mergePortfolioImport !== 'function') {
        throw new Error('trading repository does not support portfolio import');
      }
      return parseContract(
        PortfolioImportResultSchema,
        tradingRepository.mergePortfolioImport(configuredWorkspaceId, input),
      );
    },
    upsertInstrument(input) {
      return tradingRepository.upsertInstrument(input);
    },
    upsertInstrumentAlias(input) {
      return tradingRepository.upsertInstrumentAlias(input);
    },
    getInstrumentByAlias(providerId, providerSymbol) {
      return tradingRepository.getInstrumentByAlias(providerId, providerSymbol);
    },
    createPortfolio(input) {
      resolveWorkspaceId(input.workspaceId);
      return tradingRepository.createPortfolio(input);
    },
    appendTransaction(input) {
      resolveWorkspaceId(input.workspaceId);
      requirePortfolio(input.portfolioId, input.workspaceId);
      return tradingRepository.appendTransaction(input);
    },
    listTransactions(portfolioId, limit) {
      requirePortfolio(portfolioId);
      return tradingRepository.listTransactions(portfolioId, limit);
    },
  });
}
