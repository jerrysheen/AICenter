export const channels = [
  { id: 'all', label: '全部' },
  { id: 'following', label: '关注' },
];

export const platformFilters = [
  { id: 'all', label: '全部来源' },
  { id: 'bilibili', label: 'B站' },
  { id: 'x', label: 'X' },
  { id: 'manual', label: '手工' },
];

export const feedItems = [
  {
    id: 'mock-bili-1',
    platform: 'bilibili',
    author: '结构笔记',
    handle: 'mid:472747194',
    time: '8 分钟前',
    title: '新视频已进入信息流，字幕还在后台处理',
    body: '布局示例：B站内容先按标题和封面信息出现在「全部」和「关注」。字幕与总结完成后，再更新卡片状态。',
    sourceUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    processing: 'subtitle',
    following: true,
  },
  {
    id: 'mock-x-1',
    platform: 'x',
    author: '中枢观察',
    handle: '@local-hub',
    time: '22 分钟前',
    title: '关注对象是账号，不是标签',
    body: '布局示例：X 用户时间线进入标准内容后，可设置刷新频率、暂停抓取和同步状态。当前卡片仅用于确认信息架构。',
    sourceUrl: 'https://x.com/example/status/1',
    processing: '',
    following: true,
  },
];

export const subscriptions = [
  {
    id: 'sub-bili-1',
    platform: 'bilibili',
    displayName: '结构笔记',
    handle: 'mid:472747194',
    paused: false,
    lastSyncLabel: '尚未真实同步',
    lastError: '',
  },
  {
    id: 'sub-x-1',
    platform: 'x',
    displayName: '中枢观察',
    handle: '@local-hub',
    paused: true,
    lastSyncLabel: '已暂停',
    lastError: '',
  },
];

export const stockBoards = [
  { id: 'overview', label: '总览' },
  { id: 'us', label: '美股' },
  { id: 'asia', label: '亚洲' },
];

export const stockMarkets = [
  { id: 'cn', label: 'A股' },
  { id: 'us', label: '美股' },
];

export const assetClasses = [
  { id: 'all', label: '全部' },
  { id: 'index', label: '指数' },
  { id: 'fx', label: '外汇' },
  { id: 'rate', label: '利率' },
  { id: 'metal', label: '贵金属' },
  { id: 'energy', label: '能源' },
  { id: 'futures', label: '期货' },
  { id: 'crypto', label: '加密' },
];

export const quotes = [
  { name: '宁德时代', symbol: '300750.SZ', market: 'cn', assetClass: 'equity', price: '252.18', changePct: -0.68, currency: 'CNY' },
  { name: '贵州茅台', symbol: '600519.SH', market: 'cn', assetClass: 'equity', price: '1428.00', changePct: -0.41, currency: 'CNY' },
  { name: '招商银行', symbol: '600036.SH', market: 'cn', assetClass: 'equity', price: '38.12', changePct: 0.29, currency: 'CNY' },
  { name: '生益科技', symbol: '600183.SH', market: 'cn', assetClass: 'equity', price: '150.25', changePct: 2.91, currency: 'CNY' },
  { name: '长江电力', symbol: '600900.SH', market: 'cn', assetClass: 'equity', price: '27.86', changePct: 0.54, currency: 'CNY' },
  { name: 'Apple', symbol: 'AAPL', market: 'us', assetClass: 'equity', price: '227.48', changePct: 0.86, currency: 'USD' },
  { name: 'Tesla', symbol: 'TSLA', market: 'us', assetClass: 'equity', price: '241.05', changePct: -1.12, currency: 'USD' },
  { name: 'Microsoft', symbol: 'MSFT', market: 'us', assetClass: 'equity', price: '428.16', changePct: 0.34, currency: 'USD' },
];

export const globalAssets = [
  { name: '上证指数', symbol: '000001.SH', market: 'cn', assetClass: 'index', price: '3864.28', changePct: -0.54, currency: 'CNY' },
  { name: '标普500', symbol: '^GSPC', market: 'us', assetClass: 'index', price: '5628.40', changePct: 0.21, currency: 'USD' },
  { name: '美元指数', symbol: 'DXY', market: 'global', assetClass: 'fx', price: '101.38', changePct: 0.21, currency: 'USD' },
  { name: '美元兑人民币', symbol: 'USDCNY', market: 'global', assetClass: 'fx', price: '7.18', changePct: -0.08, currency: 'CNY' },
  { name: '十年期美债', symbol: 'US10Y', market: 'us', assetClass: 'rate', price: '4.12', changePct: 0.03, currency: 'USD' },
  { name: '黄金', symbol: 'XAUUSD', market: 'global', assetClass: 'metal', price: '3642.8', changePct: 0.42, currency: 'USD' },
  { name: 'WTI 原油', symbol: 'CL', market: 'us', assetClass: 'energy', price: '71.26', changePct: -1.02, currency: 'USD' },
  { name: 'COMEX 黄金主连', symbol: 'GC', market: 'us', assetClass: 'futures', price: '3648.2', changePct: 0.38, currency: 'USD', expiry: '2026-12' },
  { name: '比特币', symbol: 'BTC-USD', market: 'global', assetClass: 'crypto', price: '111250', changePct: 1.18, currency: 'USD' },
  { name: '以太坊', symbol: 'ETH-USD', market: 'global', assetClass: 'crypto', price: '4286.4', changePct: -0.56, currency: 'USD' },
];

export const marketIndex = {
  cn: { name: '上证指数', value: '3864.28', change: '-21.05', percent: '-0.54%' },
  us: { name: '标普500', value: '5628.40', change: '+11.82', percent: '+0.21%' },
};

export const tradeTabs = [
  { id: 'stocks', label: '股票' },
  { id: 'assets', label: '全球资产' },
  { id: 'holdings', label: '持仓' },
];

export const portfolioSummary = {
  baseCurrency: 'CNY',
  nav: '186,420.55',
  dayPnl: '+1,240.20',
  positionPnl: '+8,320.18',
  totalReturn: '+16,420.55',
  updatedAt: '示例数据，尚未按流水核算',
};

export const holdings = [
  { name: '宁德时代', symbol: '300750.SZ', market: 'cn', qty: '200', cost: '248.60', last: '252.18', dayPnl: -0.68, positionPnl: 1.44, currency: 'CNY' },
  { name: '招商银行', symbol: '600036.SH', market: 'cn', qty: '800', cost: '36.40', last: '38.12', dayPnl: 0.29, positionPnl: 4.73, currency: 'CNY' },
  { name: '生益科技', symbol: '600183.SH', market: 'cn', qty: '500', cost: '142.00', last: '150.25', dayPnl: 2.91, positionPnl: 5.81, currency: 'CNY' },
  { name: 'Apple', symbol: 'AAPL', market: 'us', qty: '20', cost: '214.50', last: '227.48', dayPnl: 0.86, positionPnl: 6.05, currency: 'USD' },
  { name: 'Tesla', symbol: 'TSLA', market: 'us', qty: '8', cost: '248.00', last: '241.05', dayPnl: -1.12, positionPnl: -2.80, currency: 'USD' },
];

export const tradeLedger = [
  { time: '今天 14:12', type: 'adjust', title: '持仓价刷新（示例）', detail: '现价已更新，尚未生成真实流水' },
  { time: '上周 09:31', type: 'buy', title: '买入（示例）', detail: '后续由交易流水计算持仓，而不是直接改数量' },
  { time: '上月 21:08', type: 'deposit', title: '入金（示例）', detail: '总收益会计入入金、出金、分红和费用' },
];

export const searchUniverse = [
  { name: '宁德时代', symbol: '300750.SZ', market: 'cn', kind: 'A股' },
  { name: 'Apple', symbol: 'AAPL', market: 'us', kind: '美股' },
  { name: 'Tesla', symbol: 'TSLA', market: 'us', kind: '美股' },
  { name: '黄金', symbol: 'XAUUSD', market: 'global', kind: '贵金属' },
  { name: '比特币', symbol: 'BTC-USD', market: 'global', kind: '加密' },
];

export const tools = [
  { id: 'inspire', title: '灵感', desc: '马上写、可选 AI', action: 'inspire', ready: true },
  { id: 'knowledge', title: '知识库', desc: '长期可复用内容', action: 'knowledge', ready: true },
  { id: 'publish', title: '快速发布', desc: '写入信息流', action: 'compose', ready: true },
  { id: 'pair', title: '设备与连接', desc: '配对、数据源', action: 'settings', ready: true },
  { id: 'search', title: '信息检索', desc: '后续接入问答', action: '', ready: false },
  { id: 'capture', title: '采集箱', desc: '后续接 Worker', action: '', ready: false },
];

export const askPrompts = [
  '知识库里最近归档了什么？',
  '这条灵感有没有对应的来源？',
  '默认只查知识库，不要带上信息流',
  '如果打开「包含最近信息流」，会多检索什么？',
];

export const reportSections = [
  { id: 'feed', title: '今日信息流', body: '汇总全部和关注中的新增内容。当前只放结构，不生成摘要。' },
  { id: 'subscriptions', title: '关注对象更新', body: '列出今日有新内容或同步失败的账号。' },
  { id: 'holdings', title: '持仓变化', body: '引用持仓快照：今日盈亏、持仓盈亏，不复制全部流水。' },
  { id: 'knowledge', title: '新增知识', body: '今日新晋升或新整理的知识文档。' },
  { id: 'inspire', title: '待处理灵感', body: '尚未加工或尚未归档的灵感。' },
  { id: 'open', title: '未解决事项', body: '失败的同步任务、待确认的 AI 结果。' },
];
