export const REFERENCE_BOARD_URL = 'https://wangwang-etf.com/static/feedback-board';
export const REFERENCE_HOME_URL = 'https://wangwang-etf.com/';

export const FIXED_HISTORY_SAMPLE = Object.freeze({
  id: 'wangwang-feedback-2026-08',
  sourceUrl: REFERENCE_BOARD_URL,
  note: '参考网站留言板公开说明，是四舍五入后的对照样本，不是交易所原始真值。',
  tradeDate: '2026-07-31',
  poolLabel: '20只宽基',
  pool: Object.freeze({
    inflowCount: 9,
    outflowCount: 11,
    deltaSharesYi: -19.105,
    flowYi: -39.5,
  }),
  range: Object.freeze({
    startDate: '2026-07-27',
    endDate: '2026-07-31',
    flowYi: 522.1,
  }),
  etfs: Object.freeze([
    { code: '159845', deltaSharesYi: 5.37, flowYi: 15.9 },
    { code: '510500', deltaSharesYi: 2, flowYi: 15.1 },
    { code: '512100', deltaSharesYi: 0.7, flowYi: 2 },
    { code: '159915', deltaSharesYi: -15.99, flowYi: -54.6 },
    { code: '588080', deltaSharesYi: -5.16, flowYi: -8.8 },
    { code: '159952', deltaSharesYi: -3.842, flowYi: -7.9 },
  ]),
});
