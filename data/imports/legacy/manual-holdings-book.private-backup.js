const WORKSPACE_ID = 'local';

export const HOLDING_ACCOUNTS = [
  {
    id: 'portfolio-a-share',
    name: 'A股账户',
    group: 'a',
    marketScope: 'cn',
    baseCurrency: 'CNY',
    cash: [{ currency: 'CNY', amount: '35051' }],
  },
  {
    id: 'portfolio-b-share',
    name: 'B股账户',
    group: 'b',
    marketScope: 'mixed',
    baseCurrency: 'USD',
    cash: [
      { currency: 'USD', amount: '3514.21' },
      { currency: 'HKD', amount: '57919.09' },
    ],
  },
];

function lot({ id, accountId, board, symbol, name, quantity, costPrice, listingCurrency, exchangeCode, market, yahoo, assetClass = 'equity' }) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    portfolioId: accountId,
    board,
    symbol,
    name,
    quantity,
    costPrice,
    listingCurrency,
    exchangeCode,
    market,
    yahoo,
    assetClass,
    canonicalKey: `${market === 'hk' ? 'HK:XHKG' : `CN:${exchangeCode}`}:${symbol}`,
  };
}

export const HOLDING_LOTS = [
  lot({ id: 'lot-b-900923', accountId: 'portfolio-b-share', board: 'b_sh', symbol: '900923', name: '百联B股', quantity: '2700', costPrice: '0.529', listingCurrency: 'USD', exchangeCode: 'XSHG', market: 'cn', yahoo: '900923.SS' }),
  lot({ id: 'lot-b-900926', accountId: 'portfolio-b-share', board: 'b_sh', symbol: '900926', name: '宝信B', quantity: '2300', costPrice: '1.297', listingCurrency: 'USD', exchangeCode: 'XSHG', market: 'cn', yahoo: '900926.SS' }),
  lot({ id: 'lot-b-900936', accountId: 'portfolio-b-share', board: 'b_sh', symbol: '900936', name: '鄂资B股', quantity: '6300', costPrice: '0.737', listingCurrency: 'USD', exchangeCode: 'XSHG', market: 'cn', yahoo: '900936.SS' }),
  lot({ id: 'lot-b-900948', accountId: 'portfolio-b-share', board: 'b_sh', symbol: '900948', name: '伊泰B股', quantity: '7200', costPrice: '1.614', listingCurrency: 'USD', exchangeCode: 'XSHG', market: 'cn', yahoo: '900948.SS' }),
  lot({ id: 'lot-b-200429', accountId: 'portfolio-b-share', board: 'b_sz', symbol: '200429', name: '粤高速B', quantity: '4400', costPrice: '7.613', listingCurrency: 'HKD', exchangeCode: 'XSHE', market: 'cn', yahoo: '200429.SZ' }),
  lot({ id: 'lot-b-200596', accountId: 'portfolio-b-share', board: 'b_sz', symbol: '200596', name: '古井贡B', quantity: '800', costPrice: '75.150', listingCurrency: 'HKD', exchangeCode: 'XSHE', market: 'cn', yahoo: '200596.SZ' }),
  lot({ id: 'lot-b-201872', accountId: 'portfolio-b-share', board: 'b_sz', symbol: '201872', name: '招港B', quantity: '2400', costPrice: '11.107', listingCurrency: 'HKD', exchangeCode: 'XSHE', market: 'cn', yahoo: '201872.SZ' }),

  lot({ id: 'lot-a-516640', accountId: 'portfolio-a-share', board: 'a_share', symbol: '516640', name: '芯片ETF富国', quantity: '46200', costPrice: '1.506', listingCurrency: 'CNY', exchangeCode: 'XSHG', market: 'cn', yahoo: '516640.SS', assetClass: 'fund' }),
  lot({ id: 'lot-a-588940', accountId: 'portfolio-a-share', board: 'a_share', symbol: '588940', name: '科创50ETF富国', quantity: '70000', costPrice: '0.886', listingCurrency: 'CNY', exchangeCode: 'XSHG', market: 'cn', yahoo: '588940.SS', assetClass: 'fund' }),
  lot({ id: 'lot-a-159915', accountId: 'portfolio-a-share', board: 'a_share', symbol: '159915', name: '创业板ETF易方达', quantity: '15800', costPrice: '3.599', listingCurrency: 'CNY', exchangeCode: 'XSHE', market: 'cn', yahoo: '159915.SZ', assetClass: 'fund' }),
  lot({ id: 'lot-a-515050', accountId: 'portfolio-a-share', board: 'a_share', symbol: '515050', name: '通信ETF华夏', quantity: '50500', costPrice: '1.022', listingCurrency: 'CNY', exchangeCode: 'XSHG', market: 'cn', yahoo: '515050.SS', assetClass: 'fund' }),
  lot({ id: 'lot-a-588010', accountId: 'portfolio-a-share', board: 'a_share', symbol: '588010', name: '科创新材料ETF博时', quantity: '38000', costPrice: '1.080', listingCurrency: 'CNY', exchangeCode: 'XSHG', market: 'cn', yahoo: '588010.SS', assetClass: 'fund' }),
  lot({ id: 'lot-a-159558', accountId: 'portfolio-a-share', board: 'a_share', symbol: '159558', name: '半导体设备ETF易方达', quantity: '35000', costPrice: '1.099', listingCurrency: 'CNY', exchangeCode: 'XSHE', market: 'cn', yahoo: '159558.SZ', assetClass: 'fund' }),
  lot({ id: 'lot-a-300346', accountId: 'portfolio-a-share', board: 'a_share', symbol: '300346', name: '南大光电', quantity: '700', costPrice: '53.377', listingCurrency: 'CNY', exchangeCode: 'XSHE', market: 'cn', yahoo: '300346.SZ' }),
  lot({ id: 'lot-a-688300', accountId: 'portfolio-a-share', board: 'a_share', symbol: '688300', name: '联瑞新材', quantity: '200', costPrice: '198.897', listingCurrency: 'CNY', exchangeCode: 'XSHG', market: 'cn', yahoo: '688300.SS' }),
  lot({ id: 'lot-a-603929', accountId: 'portfolio-a-share', board: 'a_share', symbol: '603929', name: '亚翔集成', quantity: '200', costPrice: '158.442', listingCurrency: 'CNY', exchangeCode: 'XSHG', market: 'cn', yahoo: '603929.SS' }),
  lot({ id: 'lot-a-688268', accountId: 'portfolio-a-share', board: 'a_share', symbol: '688268', name: '华特气体', quantity: '200', costPrice: '123.786', listingCurrency: 'CNY', exchangeCode: 'XSHG', market: 'cn', yahoo: '688268.SS' }),
  lot({ id: 'lot-hk-00981', accountId: 'portfolio-a-share', board: 'hk_connect', symbol: '00981', name: '中芯国际', quantity: '500', costPrice: '60.703', listingCurrency: 'HKD', exchangeCode: 'XHKG', market: 'hk', yahoo: '0981.HK' }),
  lot({ id: 'lot-a-300223', accountId: 'portfolio-a-share', board: 'a_share', symbol: '300223', name: '君正股份', quantity: '200', costPrice: '136.520', listingCurrency: 'CNY', exchangeCode: 'XSHE', market: 'cn', yahoo: '300223.SZ' }),
  lot({ id: 'lot-a-002192', accountId: 'portfolio-a-share', board: 'a_share', symbol: '002192', name: '融捷股份', quantity: '400', costPrice: '63.968', listingCurrency: 'CNY', exchangeCode: 'XSHE', market: 'cn', yahoo: '002192.SZ' }),
  lot({ id: 'lot-a-600378', accountId: 'portfolio-a-share', board: 'a_share', symbol: '600378', name: '昊华科技', quantity: '400', costPrice: '53.323', listingCurrency: 'CNY', exchangeCode: 'XSHG', market: 'cn', yahoo: '600378.SS' }),
  lot({ id: 'lot-hk-02498', accountId: 'portfolio-a-share', board: 'hk_connect', symbol: '02498', name: '速腾聚创', quantity: '800', costPrice: '20.655', listingCurrency: 'HKD', exchangeCode: 'XHKG', market: 'hk', yahoo: '2498.HK' }),
  lot({ id: 'lot-a-159178', accountId: 'portfolio-a-share', board: 'a_share', symbol: '159178', name: '消费电子ETF汇添富', quantity: '10000', costPrice: '1.044', listingCurrency: 'CNY', exchangeCode: 'XSHE', market: 'cn', yahoo: '159178.SZ', assetClass: 'fund' }),
  lot({ id: 'lot-hk-02688', accountId: 'portfolio-a-share', board: 'hk_connect', symbol: '02688', name: '新奥能源', quantity: '200', costPrice: '58.430', listingCurrency: 'HKD', exchangeCode: 'XHKG', market: 'hk', yahoo: '2688.HK' }),
  lot({ id: 'lot-a-000858', accountId: 'portfolio-a-share', board: 'a_share', symbol: '000858', name: '五粮液', quantity: '100', costPrice: '320.689', listingCurrency: 'CNY', exchangeCode: 'XSHE', market: 'cn', yahoo: '000858.SZ' }),
  lot({ id: 'lot-hk-07489', accountId: 'portfolio-a-share', board: 'hk_connect', symbol: '07489', name: '岚图汽车', quantity: '2132', costPrice: '7.730', listingCurrency: 'HKD', exchangeCode: 'XHKG', market: 'hk', yahoo: '7489.HK' }),
];

export const HOLDING_FX_SYMBOLS = ['USDCNY=X', 'HKDCNY=X'];

export function createManualHoldingsBook() {
  return Object.freeze({
    workspaceId: WORKSPACE_ID,
    accounts: HOLDING_ACCOUNTS,
    lots: HOLDING_LOTS,
    fxSymbols: HOLDING_FX_SYMBOLS,
  });
}
