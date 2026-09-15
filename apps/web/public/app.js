import {
  askPrompts, assetClasses, channels, feedItems, globalAssets, holdings,
  platformFilters, portfolioSummary, reportSections, stockBoards, stockMarkets,
  subscriptions, tools, tradeLedger, tradeTabs,
} from './mock.js';

const platformLabels = { manual: '手工', bilibili: 'B站', x: 'X' };
const processingLabels = { subtitle: '字幕处理中', ai: 'AI 加工中' };

const state = {
  session: null,
  posts: [],
  pairing: null,
  stream: null,
  channel: 'all',
  platform: 'all',
  quoteMarket: 'cn',
  assetClass: 'all',
  holdingsMarket: 'cn',
  tradePane: 'stocks',
  stockBoard: 'overview',
  stockGroup: '全部',
  changeSort: 'none',
  marketFilter: '',
  markets: { overview: null, us: null, asia: null },
  marketLoading: false,
  extras: { us: [], asia: [] },
  notes: [],
  knowledge: [],
  wantAi: false,
  includeFeedInAsk: false,
};

const navItems = [
  { id: 'feed', label: '信息', icon: 'M12 5a7 7 0 1 1-4.95 2.05M12 9v3l2 1' },
  { id: 'trade', label: '交易', icon: 'M5 16l3-5 4 3 7-9M5 19h14' },
  { id: 'tools', label: '工具', icon: 'M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z' },
  { id: 'ask', label: '问答', icon: 'M5 7h14v9H8l-3 3z' },
  { id: 'report', label: '日报', icon: 'M7 4h10v16H7zM9 8h6M9 12h6M9 16h4' },
];

const viewCopy = {
  feed: { title: '信息', subtitle: '外部信息与手工发布的统一入口' },
  trade: { title: '交易', subtitle: '股票、全球资产与持仓' },
  tools: { title: '工具', subtitle: '灵感和知识库' },
  inspire: { title: '灵感', subtitle: '马上写下来，默认只保存原文' },
  knowledge: { title: '知识库', subtitle: '可长期复用的规范内容' },
  ask: { title: '问答', subtitle: '默认检索知识库，并带来源' },
  report: { title: '日报', subtitle: '跨模块汇总，先定结构' },
  settings: { title: '设置', subtitle: '设备、连接器和账户' },
};

const elements = Object.fromEntries([
  'connection-state', 'server-name', 'session-description', 'pairing-panel', 'pairing-qr',
  'network-address', 'pairing-code', 'refresh-pairing', 'unpaired-panel', 'authorized-content',
  'authorized-feed', 'page-title', 'page-subtitle', 'post-form', 'post-title', 'post-body',
  'form-message', 'feed', 'feed-count', 'metrics-panel', 'metric-devices', 'metric-opens',
  'metric-published', 'metric-details', 'device-list', 'post-dialog', 'dialog-title',
  'dialog-body', 'dialog-tags', 'dialog-source', 'dialog-time', 'toast', 'channel-tabs',
  'platform-filters', 'follow-toolbar', 'quote-filters', 'quote-list', 'tool-grid',
  'ask-prompts', 'ask-form', 'ask-include-feed', 'compose-dialog', 'open-compose', 'open-settings',
  'side-nav-list', 'bottom-tab', 'trade-tabs', 'holdings-list', 'holdings-filters', 'asset-filters',
  'asset-list', 'ledger-list', 'search-dialog', 'symbol-search', 'search-results',
  'note-form', 'note-body', 'note-ai-toggle', 'note-list', 'knowledge-list', 'portfolio-summary',
  'report-list', 'open-subscriptions', 'subscriptions-dialog', 'subscription-list',
  'holding-dialog', 'holding-title', 'holding-meta', 'holding-metrics',
  'stock-boards', 'market-status', 'market-overview', 'market-head', 'market-table-scroll', 'market-sort', 'market-filter', 'market-filter-wrap',
].map((id) => [id, document.getElementById(id)]));

function iconSvg(path) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"></path></svg>`;
}

function renderNav() {
  elements['side-nav-list'].replaceChildren(...navItems.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item';
    button.dataset.nav = item.id;
    button.innerHTML = `${iconSvg(item.icon)}<span>${item.label}</span>`;
    return button;
  }));
  elements['bottom-tab'].replaceChildren(...navItems.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab-item';
    button.dataset.nav = item.id;
    button.innerHTML = `${iconSvg(item.icon)}<span>${item.label}</span>`;
    return button;
  }));
}

function resolveView(name) {
  if (name === 'market') return 'trade';
  if (name === 'account') return 'settings';
  return viewCopy[name] ? name : 'feed';
}

function setView(name) {
  const view = resolveView(name);
  document.body.dataset.view = view;
  document.querySelectorAll('[data-view-panel]').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.viewPanel === view);
  });
  document.querySelectorAll('.nav-item, .tab-item').forEach((control) => {
    control.classList.toggle('is-active', control.dataset.nav === view);
  });
  elements['page-title'].textContent = viewCopy[view].title;
  elements['page-subtitle'].textContent = viewCopy[view].subtitle;
  updateHeaderAction(view);
  if (view === 'inspire') loadNotes().catch((error) => showToast(error.message));
  if (view === 'knowledge') loadKnowledge().catch((error) => showToast(error.message));
  if (view === 'trade') loadMarket().catch((error) => showToast(error.message));
  const nextHash = `#${view}`;
  if (location.hash !== nextHash) history.replaceState({}, '', `${location.pathname}${location.search}${nextHash}`);
}

function updateHeaderAction(view) {
  const button = elements['open-compose'];
  if (view === 'trade') {
    button.dataset.action = 'search';
    button.setAttribute('aria-label', '搜索标的');
    button.innerHTML = iconSvg('M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15zm9.5 3-4.2-4.2');
    return;
  }
  button.dataset.action = 'compose';
  button.setAttribute('aria-label', '快速发布');
  button.textContent = '+';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function setConnection(kind, label) {
  elements['connection-state'].className = `connection-state ${kind}`;
  elements['connection-state'].querySelector('span').textContent = label;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove('visible'), 2600);
}

function logBehavior(name, metadata = {}) {
  api('/api/v1/behavior', { method: 'POST', body: JSON.stringify({ name, metadata }) }).catch(() => {});
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(timestamp);
}

function liveAsItem(post) {
  return {
    id: post.id,
    live: true,
    platform: 'manual',
    author: post.createdByDevice ? '手机' : '本机',
    handle: '',
    time: formatTime(post.createdAt),
    title: post.title,
    body: post.body || '无正文',
    tags: post.tags || [],
    sourceUrl: post.sourceUrl,
    processing: '',
    following: false,
    createdAt: post.createdAt,
  };
}

function matchesPlatform(item) {
  return state.platform === 'all' || item.platform === state.platform;
}

function visibleFeedItems() {
  const live = state.posts.map(liveAsItem).filter(matchesPlatform);
  const demo = feedItems.filter((item) => matchesPlatform(item) && (state.channel === 'all' || item.following));
  if (state.channel === 'following') return demo;
  return [...live, ...demo];
}

function renderChipTabs(target, items, current, onSelect) {
  target.replaceChildren(...items.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chip-tab${item.id === current ? ' is-active' : ''}`;
    button.textContent = item.label;
    button.addEventListener('click', () => onSelect(item.id));
    return button;
  }));
}

function renderChannels() {
  elements['channel-tabs'].replaceChildren(...channels.map((channel) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `channel-tab${channel.id === state.channel ? ' is-active' : ''}`;
    button.textContent = channel.label;
    button.addEventListener('click', () => {
      state.channel = channel.id;
      renderChannels();
      renderPlatformFilters();
      renderPosts();
    });
    return button;
  }));
  elements['follow-toolbar'].classList.toggle('hidden', state.channel !== 'following');
}

function renderPlatformFilters() {
  renderChipTabs(elements['platform-filters'], platformFilters, state.platform, (id) => {
    state.platform = id;
    renderPlatformFilters();
    renderPosts();
  });
}

function renderPosts() {
  const items = visibleFeedItems();
  elements.feed.replaceChildren();
  elements['feed-count'].textContent = `${items.length} 条`;
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = state.channel === 'following'
      ? '还没有关注对象的内容。添加账号后会出现在这里。'
      : '这个筛选下还没有信息。';
    elements.feed.append(empty);
    return;
  }
  for (const post of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'post-card';
    card.addEventListener('click', () => openPost(post));
    const meta = document.createElement('div');
    meta.className = 'post-meta';
    const avatar = document.createElement('span');
    avatar.className = 'post-author';
    avatar.textContent = post.author.slice(0, 1);
    const author = document.createElement('span');
    author.textContent = post.author;
    const platform = document.createElement('span');
    platform.className = 'status-pill';
    platform.textContent = platformLabels[post.platform] || post.platform;
    const time = document.createElement('span');
    time.textContent = post.time;
    meta.append(avatar, author, platform, time);
    if (post.processing) {
      const processing = document.createElement('span');
      processing.className = 'status-pill warning';
      processing.textContent = processingLabels[post.processing] || '处理中';
      meta.append(processing);
    }
    const title = document.createElement('h3');
    title.textContent = post.title;
    const body = document.createElement('p');
    body.textContent = post.body;
    card.append(meta, title, body);
    if (post.sourceUrl) {
      const foot = document.createElement('div');
      foot.className = 'post-foot';
      foot.append(Object.assign(document.createElement('span'), { textContent: '打开原文' }));
      card.append(foot);
    }
    elements.feed.append(card);
  }
}

function openPost(post) {
  const live = state.posts.find((item) => item.id === post.id);
  const payload = live || {
    id: post.id,
    title: post.title,
    body: post.body,
    tags: post.tags || [],
    sourceUrl: post.sourceUrl || '',
    createdAt: Date.now(),
  };
  elements['dialog-title'].textContent = payload.title;
  elements['dialog-body'].textContent = payload.body || '无正文';
  elements['dialog-tags'].replaceChildren(...(payload.tags || []).map((tag) => {
    const chip = document.createElement('span');
    chip.textContent = tag;
    return chip;
  }));
  elements['dialog-source'].classList.toggle('hidden', !payload.sourceUrl);
  elements['dialog-source'].href = payload.sourceUrl || '#';
  elements['dialog-time'].textContent = live
    ? `发布于 ${new Date(payload.createdAt).toLocaleString('zh-CN')}`
    : post.processing
      ? '示例卡片：字幕或 AI 完成后会更新，不阻塞信息流'
      : '示例内容，用于确认信息架构，尚未写入本地数据库';
  elements['post-dialog'].showModal();
  if (live) logBehavior('post.opened', { postId: payload.id });
}

function renderTradeTabs() {
  elements['trade-tabs'].replaceChildren(...tradeTabs.map((tab) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `text-tab${tab.id === state.tradePane ? ' is-active' : ''}`;
    button.textContent = tab.label;
    button.addEventListener('click', () => setTradePane(tab.id));
    return button;
  }));
}

function setTradePane(id) {
  state.tradePane = id;
  document.querySelectorAll('[data-trade-pane]').forEach((pane) => {
    pane.classList.toggle('is-active', pane.dataset.tradePane === id);
  });
  renderTradeTabs();
  if (id === 'stocks') loadMarket().catch((error) => showToast(error.message));
}

function appendMetric(target, label, value, tone = '') {
  const item = document.createElement('div');
  const strong = document.createElement('strong');
  strong.className = tone;
  strong.textContent = value;
  const span = document.createElement('span');
  span.textContent = label;
  item.append(strong, span);
  target.append(item);
}

function renderPortfolioSummary() {
  const target = elements['portfolio-summary'];
  target.replaceChildren();
  appendMetric(target, `账户基准 ${portfolioSummary.baseCurrency}`, portfolioSummary.baseCurrency);
  appendMetric(target, '总资产', portfolioSummary.nav);
  appendMetric(target, '今日盈亏', portfolioSummary.dayPnl, 'up');
  appendMetric(target, '持仓盈亏', portfolioSummary.positionPnl, 'up');
  appendMetric(target, '累计收益', portfolioSummary.totalReturn, 'up');
  appendMetric(target, '更新时间', portfolioSummary.updatedAt);
}

function renderQuoteRows(target, items, { subtitle, changeText, selectedSymbol, onClick }) {
  target.replaceChildren(...items.map((item) => {
    const change = Number(item.changePct ?? item.positionPnl ?? 0);
    const up = change >= 0;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `quote-row${selectedSymbol === item.symbol ? ' is-active' : ''}`;
    const name = document.createElement('span');
    name.className = 'quote-identity';
    const title = document.createElement('strong');
    title.className = 'quote-name';
    title.textContent = item.name;
    const meta = document.createElement('small');
    meta.className = 'quote-code';
    meta.textContent = subtitle(item);
    name.append(title, meta);
    const metrics = document.createElement('span');
    metrics.className = 'quote-metrics';
    const price = document.createElement('span');
    price.className = `quote-price ${up ? 'up' : 'down'}`;
    price.textContent = item.price || item.last;
    const changeEl = document.createElement('span');
    changeEl.className = `quote-change ${up ? 'up' : 'down'}`;
    changeEl.textContent = changeText(item, up, change);
    metrics.append(price, changeEl);
    button.append(name, metrics);
    button.addEventListener('click', () => onClick(item));
    return button;
  }));
}

function formatPct(up, value) {
  return `${up ? '+' : ''}${Number(value).toFixed(2)}%`;
}

function renderHoldings() {
  renderChipTabs(elements['holdings-filters'], stockMarkets, state.holdingsMarket, (id) => {
    state.holdingsMarket = id;
    renderHoldings();
  });
  const rows = holdings.filter((item) => item.market === state.holdingsMarket);
  renderQuoteRows(elements['holdings-list'], rows, {
    subtitle: (item) => `${item.symbol} · ${item.qty} · 成本 ${item.cost}`,
    changeText: (item, up) => formatPct(up, item.positionPnl),
    onClick: openHolding,
  });
}

function openHolding(item) {
  elements['holding-title'].textContent = item.name;
  elements['holding-meta'].textContent = `${item.symbol} · ${item.market === 'cn' ? 'A股' : '美股'} · 流水放在持仓详情，不再占用顶层页签`;
  const metrics = elements['holding-metrics'];
  metrics.replaceChildren();
  appendMetric(metrics, '现价', item.last);
  appendMetric(metrics, '今日盈亏', formatPct(item.dayPnl >= 0, item.dayPnl), item.dayPnl >= 0 ? 'up' : 'down');
  appendMetric(metrics, '持仓盈亏', formatPct(item.positionPnl >= 0, item.positionPnl), item.positionPnl >= 0 ? 'up' : 'down');
  elements['ledger-list'].replaceChildren(...tradeLedger.map((row) => {
    const article = document.createElement('article');
    article.className = 'ledger-item';
    article.append(
      Object.assign(document.createElement('small'), { textContent: row.time }),
      Object.assign(document.createElement('strong'), { textContent: row.title }),
      Object.assign(document.createElement('p'), { textContent: row.detail }),
    );
    return article;
  }));
  elements['holding-dialog'].showModal();
}

function renderAssets() {
  renderChipTabs(elements['asset-filters'], assetClasses, state.assetClass, (id) => {
    state.assetClass = id;
    renderAssets();
  });
  const rows = globalAssets.filter((item) => state.assetClass === 'all' || item.assetClass === state.assetClass);
  renderQuoteRows(elements['asset-list'], rows, {
    subtitle: (item) => `${item.symbol} · ${assetClasses.find((entry) => entry.id === item.assetClass)?.label || item.assetClass}${item.expiry ? ` · ${item.expiry}` : ''}`,
    changeText: (item, up) => formatPct(up, item.changePct),
    selectedSymbol: null,
    onClick: () => showToast('全球资产复用同一套行情列表。真实供应商尚未接入'),
  });
}

const extraKeys = { us: 'ai-center:us-watchlist', asia: 'ai-center:asia-watchlist' };

function readExtras(board) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(extraKeys[board]) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeExtras(board, symbols) {
  state.extras[board] = symbols;
  window.localStorage.setItem(extraKeys[board], JSON.stringify(symbols));
}

function formatPrice(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatVolume(value) {
  if (value === null || value === undefined) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return String(value);
}

function sessionLabel(session) {
  if (session === 'regular') return '盘中';
  if (session === 'pre') return '盘前';
  if (session === 'post') return '盘后';
  return '休市';
}

function sparkSvg(points, changePct) {
  if (!points || points.length < 2) return '<span class="spark empty">—</span>';
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(max - min, 1e-6);
  const d = points.map((point, index) => {
    const x = (index / (points.length - 1)) * 100;
    const y = 26 - ((point - min) / span) * 22;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
  const tone = changePct !== null && changePct < 0 ? 'down' : 'up';
  return `<svg class="spark ${tone}" viewBox="0 0 100 28" aria-hidden="true"><path d="${d}"></path></svg>`;
}

function extraQuery() {
  const us = state.extras.us.join(',');
  const asia = state.extras.asia.join(',');
  const params = new URLSearchParams({ board: state.stockBoard });
  if (us) params.set('extraUs', us);
  if (asia) params.set('extraAsia', asia);
  return `/api/v1/markets?${params}`;
}

async function loadMarket() {
  if (!state.session) return;
  state.marketLoading = true;
  renderMarketStatus();
  try {
    const payload = await api(extraQuery());
    state.markets[payload.market.board] = payload.market;
    if (payload.market.board === 'overview') {
      state.markets.overview = payload.market;
    }
    renderMarket();
  } finally {
    state.marketLoading = false;
    renderMarketStatus();
  }
}

function currentMarket() {
  return state.markets[state.stockBoard];
}

function renderStockBoards() {
  renderChipTabs(elements['stock-boards'], stockBoards, state.stockBoard, (id) => {
    state.stockBoard = id;
    state.stockGroup = '全部';
    state.marketFilter = '';
    if (elements['market-filter']) elements['market-filter'].value = '';
    renderStockBoards();
    loadMarket().catch((error) => showToast(error.message));
  });
}

function renderMarketStatus() {
  const market = currentMarket();
  const mode = market?.mode === 'live' ? '实时快照' : market ? '部分数据' : '';
  const loading = state.marketLoading ? '刷新中…' : mode;
  const session = market ? sessionLabel(market.session) : '';
  elements['market-status'].textContent = [loading, session, market?.note || '正在连接 Yahoo Finance 公开行情'].filter(Boolean).join(' · ');
}

function renderIndexScroller(indices) {
  const scroller = document.createElement('div');
  scroller.className = 'index-scroller';
  for (const item of indices || []) {
    const card = document.createElement('article');
    card.className = 'index-card';
    const up = (item.changePct ?? 0) >= 0;
    card.innerHTML = `<header><span>${item.name}</span><small>${item.symbol}</small></header>
      <strong class="${up ? 'up' : 'down'}">${formatPrice(item.lastPrice)}</strong>
      <b class="${up ? 'up' : 'down'}">${item.changePct === null ? '—' : formatPct(up, item.changePct)}</b>
      ${sparkSvg(item.sparkline, item.changePct)}`;
    scroller.append(card);
  }
  return scroller;
}

function renderOverview(market) {
  const root = elements['market-overview'];
  root.replaceChildren();
  for (const section of market?.sections || []) {
    const wrap = document.createElement('section');
    wrap.className = 'market-section';
    const heading = document.createElement('div');
    heading.className = 'market-section-title';
    heading.append(
      Object.assign(document.createElement('h2'), { textContent: section.title }),
      Object.assign(document.createElement('small'), { textContent: `${sessionLabel(section.session)} · ${section.mode === 'live' ? '实时快照' : '部分数据'}` }),
    );
    const brief = document.createElement('div');
    brief.className = 'market-brief';
    renderBreadth(brief, section.breadth, '观察池宽度');
    brief.append(renderMovers(section.gainers, '领涨'), renderMovers(section.losers, '领跌'));
    wrap.append(heading, renderIndexScroller(section.indices), brief);
    root.append(wrap);
  }
}

function renderBreadth(target, breadth, title) {
  if (!breadth || breadth.advancers === undefined) return;
  const total = breadth.advancers + breadth.decliners + breadth.unchanged;
  const advance = total ? (breadth.advancers / total) * 100 : 50;
  const article = document.createElement('article');
  article.className = 'breadth-card';
  article.innerHTML = `<h3>${title}</h3>
    <strong>${advance.toFixed(0)}<small>%</small></strong>
    <span>上涨占比</span>
    <div class="breadth-track"><i style="width:${advance}%"></i></div>
    <p>${breadth.advancers} 涨 · ${breadth.unchanged} 平 · ${breadth.decliners} 跌</p>`;
  target.append(article);
}

function renderMovers(list, title) {
  const article = document.createElement('article');
  article.className = 'mover-card';
  const heading = document.createElement('h3');
  heading.textContent = title;
  article.append(heading);
  for (const item of list || []) {
    const row = document.createElement('div');
    row.className = 'mover-row';
    const up = (item.changePct ?? 0) >= 0;
    row.innerHTML = `<span>${item.symbol}</span><small>${item.summary || item.name}</small><b class="${up ? 'up' : 'down'}">${item.changePct === null ? '—' : formatPct(up, item.changePct)}</b>`;
    article.append(row);
  }
  if (!(list || []).length) {
    article.append(Object.assign(document.createElement('p'), { textContent: '暂无' }));
  }
  return article;
}

function visibleWatchlist(market) {
  const needle = state.marketFilter.trim().toLowerCase();
  const filtered = (market.watchlist || []).filter((item) => {
    const groupOk = state.stockGroup === '全部' || item.group === state.stockGroup;
    const text = `${item.name} ${item.symbol} ${item.summary || ''}`.toLowerCase();
    return groupOk && (!needle || text.includes(needle));
  });
  if (state.changeSort === 'none') return filtered;
  return [...filtered].sort((a, b) => {
    const left = a.changePct;
    const right = b.changePct;
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return state.changeSort === 'desc' ? right - left : left - right;
  });
}

function updateChangeSortControl() {
  const button = elements['market-sort'];
  const labels = {
    none: { icon: '↕', aria: '按涨跌幅排序' },
    desc: { icon: '↓', aria: '当前涨幅从高到低，再次点击改为从低到高' },
    asc: { icon: '↑', aria: '当前涨幅从低到高，再次点击恢复默认顺序' },
  };
  const next = labels[state.changeSort];
  button.classList.toggle('is-active', state.changeSort !== 'none');
  button.setAttribute('aria-label', next.aria);
  button.innerHTML = `涨跌幅 <i>${next.icon}</i>`;
}

function renderWatchRows(rows) {
  if (!rows.length) {
    elements['quote-list'].replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state',
      textContent: '没有符合筛选的标的。',
    }));
    return;
  }
  elements['quote-list'].replaceChildren(...rows.map((item) => {
    const up = (item.changePct ?? 0) >= 0;
    const row = document.createElement('div');
    row.className = 'market-row';
    row.innerHTML = `<span class="quote-identity">
        <strong class="quote-name">${item.name}</strong>
        ${item.summary ? `<em class="quote-blurb">${item.summary}</em>` : ''}
        <small class="quote-code">${item.symbol} · ${item.group}</small>
      </span>
      <span class="market-spark">${sparkSvg(item.sparkline, item.changePct)}</span>
      <span class="quote-price ${up ? 'up' : 'down'}">${formatPrice(item.lastPrice)}</span>
      <span class="quote-change ${up ? 'up' : 'down'}">${item.changePct === null ? '—' : formatPct(up, item.changePct)}</span>
      <span class="market-meta"><span>量 ${formatVolume(item.volume)}</span><span class="market-range">${formatPrice(item.low)} – ${formatPrice(item.high)}</span></span>`;
    if (item.group === '自选') {
      const identity = row.querySelector('.quote-identity');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'text-button market-remove';
      remove.textContent = '移除';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        const board = state.stockBoard === 'asia' ? 'asia' : 'us';
        writeExtras(board, state.extras[board].filter((symbol) => symbol !== item.symbol));
        loadMarket().catch((error) => showToast(error.message));
      });
      identity.append(remove);
    }
    return row;
  }));
}

function renderMarket() {
  renderStockBoards();
  const market = currentMarket();
  const isOverview = state.stockBoard === 'overview';
  renderMarketStatus();
  elements['market-filter-wrap'].classList.toggle('hidden', isOverview);
  elements['market-table-scroll'].classList.toggle('hidden', isOverview);
  updateChangeSortControl();
  if (isOverview) {
    elements['quote-filters'].replaceChildren();
    renderOverview(market);
    elements['quote-list'].replaceChildren();
    return;
  }
  elements['market-overview'].replaceChildren();
  const groups = (market?.groups || []).map((label) => ({ id: label, label }));
  renderChipTabs(elements['quote-filters'], groups, state.stockGroup, (id) => {
    state.stockGroup = id;
    renderMarket();
  });
  renderWatchRows(market ? visibleWatchlist(market) : []);
}

async function renderSearch(query = '') {
  const keyword = query.trim();
  if (!keyword) {
    elements['search-results'].replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state',
      textContent: '输入名称或代码，例如 NVDA / 海力士',
    }));
    return;
  }
  try {
    const payload = await api(`/api/v1/markets/search?q=${encodeURIComponent(keyword)}`);
    const rows = payload.items || [];
    if (!rows.length) {
      elements['search-results'].replaceChildren(Object.assign(document.createElement('div'), {
        className: 'empty-state',
        textContent: '没有匹配的股票或 ETF。',
      }));
      return;
    }
    elements['search-results'].replaceChildren(...rows.map((item) => {
      const row = document.createElement('div');
      row.className = 'search-row';
      const copy = document.createElement('div');
      copy.append(
        Object.assign(document.createElement('strong'), { textContent: item.name }),
        Object.assign(document.createElement('small'), { textContent: `${item.symbol} · ${item.exchange} · ${item.type}` }),
      );
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'text-button';
      add.textContent = '加入自选';
      add.addEventListener('click', () => {
        const board = state.stockBoard === 'asia' ? 'asia' : 'us';
        if (state.extras[board].includes(item.symbol)) {
          showToast(`${item.symbol} 已在自选`);
          return;
        }
        writeExtras(board, [...state.extras[board], item.symbol]);
        state.stockBoard = board;
        state.stockGroup = '自选';
        elements['search-dialog'].close();
        loadMarket().catch((error) => showToast(error.message));
      });
      row.append(copy, add);
      return row;
    }));
  } catch (error) {
    showToast(error.message);
  }
}

function renderSubscriptions() {
  elements['subscription-list'].replaceChildren(...subscriptions.map((item) => {
    const row = document.createElement('div');
    row.className = 'search-row';
    const copy = document.createElement('div');
    copy.append(
      Object.assign(document.createElement('strong'), { textContent: item.displayName }),
      Object.assign(document.createElement('small'), { textContent: `${platformLabels[item.platform]} · ${item.handle} · ${item.lastSyncLabel}` }),
    );
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    for (const [label, message] of [
      [item.paused ? '恢复' : '暂停', '订阅状态会在接口就绪后写入'],
      ['同步', '手工同步将交给 Worker，本轮只确认入口'],
      ['删除', '删除关注不会在本轮改数据库'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = label;
      button.addEventListener('click', () => showToast(message));
      actions.append(button);
    }
    row.append(copy, actions);
    return row;
  }));
}

function renderTools() {
  elements['tool-grid'].replaceChildren(...tools.map((tool) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool-item';
    button.disabled = !tool.ready;
    button.innerHTML = `<span class="tool-icon">${tool.title.slice(0, 1)}</span><strong>${tool.title}</strong><small>${tool.desc}</small>`;
    button.addEventListener('click', () => {
      if (tool.action === 'compose') return openCompose();
      if (tool.action === 'settings') return setView('settings');
      if (tool.action === 'inspire' || tool.action === 'knowledge') return setView(tool.action);
      showToast('这项能力将在闭环稳定后接入');
    });
    return button;
  }));
}

function renderAsk() {
  elements['ask-prompts'].replaceChildren(...askPrompts.map((prompt) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = prompt;
    button.addEventListener('click', () => {
      elements['ask-form'].question.value = prompt;
      elements['ask-form'].requestSubmit();
    });
    return button;
  }));
}

function renderReport() {
  elements['report-list'].replaceChildren(...reportSections.map((section) => {
    const card = document.createElement('article');
    card.className = 'note-card';
    card.append(
      Object.assign(document.createElement('strong'), { textContent: section.title }),
      Object.assign(document.createElement('p'), { textContent: section.body }),
    );
    return card;
  }));
}

function renderNotes() {
  elements['note-list'].replaceChildren();
  if (!state.notes.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有灵感。写一条就能看见。';
    elements['note-list'].append(empty);
    return;
  }
  for (const note of state.notes) {
    const card = document.createElement('article');
    card.className = 'note-card';
    const time = document.createElement('small');
    time.textContent = formatTime(note.createdAt);
    const body = document.createElement('p');
    body.textContent = note.body;
    card.append(time, body);
    if (note.aiReply) {
      const reply = document.createElement('div');
      reply.className = 'post-quote';
      reply.textContent = `AI 结果（与原文分开）：\n${note.aiReply}`;
      card.append(reply);
    }
    const archive = document.createElement('button');
    archive.type = 'button';
    archive.className = 'text-button';
    archive.textContent = '转入知识库';
    archive.addEventListener('click', async () => {
      try {
        await api(`/api/v1/notes/${note.id}/archive`, { method: 'POST' });
        showToast('已放到知识库 · 待整理');
        await Promise.all([loadNotes(), loadKnowledge()]);
      } catch (error) {
        showToast(error.message);
      }
    });
    card.append(archive);
    elements['note-list'].append(card);
  }
}

function renderKnowledge() {
  elements['knowledge-list'].replaceChildren();
  if (!state.knowledge.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '知识库还是空的。从灵感里转入第一条吧。';
    elements['knowledge-list'].append(empty);
    return;
  }
  for (const item of state.knowledge) {
    const card = document.createElement('article');
    card.className = 'note-card';
    const time = document.createElement('small');
    time.textContent = `${item.source === 'inspiration' ? '来自灵感' : '手动'} · ${formatTime(item.createdAt)}`;
    const title = document.createElement('strong');
    title.textContent = item.title;
    const body = document.createElement('p');
    body.textContent = item.body;
    card.append(time, title, body);
    elements['knowledge-list'].append(card);
  }
}

async function loadNotes() {
  if (!state.session) return;
  const payload = await api('/api/v1/notes?status=inbox');
  state.notes = payload.notes;
  renderNotes();
}

async function loadKnowledge() {
  if (!state.session) return;
  const payload = await api('/api/v1/knowledge');
  state.knowledge = payload.items;
  renderKnowledge();
}

function openSearch() {
  renderSearch('');
  elements['symbol-search'].value = '';
  elements['search-dialog'].showModal();
  elements['symbol-search'].focus();
}

function openHeaderAction() {
  if (elements['open-compose'].dataset.action === 'search') {
    openSearch();
    return;
  }
  openCompose();
}

function openCompose() {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  elements['compose-dialog'].showModal();
}

async function loadPosts() {
  const payload = await api('/api/v1/posts');
  state.posts = payload.posts;
  renderPosts();
  logBehavior('feed.loaded', { count: state.posts.length });
}

async function loadPairing() {
  const payload = await api('/api/v1/pairing');
  state.pairing = payload;
  elements['network-address'].replaceChildren(...payload.candidates.map((candidate, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = candidate.baseUrl;
    return option;
  }));
  updatePairingCandidate();
}

function updatePairingCandidate() {
  const candidate = state.pairing?.candidates[Number(elements['network-address'].value || 0)];
  if (!candidate) {
    elements['pairing-qr'].removeAttribute('src');
    elements['pairing-code'].textContent = '未发现局域网地址';
    return;
  }
  elements['pairing-qr'].src = candidate.qrDataUrl;
  elements['pairing-code'].textContent = state.pairing.code;
}

async function loadMetrics() {
  if (state.session?.role !== 'desktop') return;
  const [{ metrics }, { devices }] = await Promise.all([api('/api/v1/metrics'), api('/api/v1/devices')]);
  elements['metric-devices'].textContent = metrics.activeDevices;
  elements['metric-opens'].textContent = metrics.appOpens;
  elements['metric-published'].textContent = metrics.published;
  elements['metric-details'].textContent = metrics.detailsOpened;
  elements['device-list'].replaceChildren(...devices.filter((device) => !device.revokedAt).map((device) => {
    const row = document.createElement('div');
    const copy = document.createElement('span');
    copy.textContent = `${device.name} · ${formatTime(device.lastSeenAt)}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '撤销';
    button.addEventListener('click', async () => {
      await api(`/api/v1/devices/${device.id}`, { method: 'DELETE' });
      await loadMetrics();
    });
    row.append(copy, button);
    return row;
  }));
}

function connectStream() {
  state.stream?.close();
  state.stream = new EventSource('/api/v1/events/stream');
  state.stream.addEventListener('ready', () => setConnection('online', '实时连接'));
  state.stream.addEventListener('post.created', (event) => {
    const { post } = JSON.parse(event.data);
    state.posts = [post, ...state.posts.filter((item) => item.id !== post.id)];
    renderPosts();
    showToast('收到一条新信息');
    loadMetrics().catch(() => {});
  });
  state.stream.addEventListener('device.paired', () => loadMetrics().catch(() => {}));
  state.stream.onerror = () => setConnection('waiting', '正在重连');
}

async function pairFromUrl() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('pair');
  if (!code) return false;
  const deviceName = /Mobile|HarmonyOS|Android|iPhone/i.test(navigator.userAgent) ? '我的鸿蒙手机' : '浏览器设备';
  setConnection('waiting', '正在配对');
  await api('/api/v1/pair', { method: 'POST', body: JSON.stringify({ code, deviceName }) });
  url.searchParams.delete('pair');
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  showToast('配对成功，以后打开即可连接');
  return true;
}

async function initialize() {
  renderNav();
  renderChannels();
  renderPlatformFilters();
  renderTradeTabs();
  renderStockBoards();
  renderAssets();
  renderPortfolioSummary();
  renderHoldings();
  renderTools();
  renderAsk();
  renderReport();
  renderSubscriptions();
  renderPosts();
  setView((location.hash || '#feed').slice(1));
  try {
    await pairFromUrl();
    const { ok, ...session } = await api('/api/v1/session');
    state.session = session;
    elements['server-name'].textContent = session.serverName;
    elements['session-description'].textContent = session.role === 'desktop'
      ? '本机管理端 · 可生成手机二维码'
      : `${session.device.name} · 已长期授权`;
    elements['unpaired-panel'].classList.add('hidden');
    if (session.role === 'desktop') {
      elements['pairing-panel'].classList.remove('hidden');
      elements['metrics-panel'].classList.remove('hidden');
      await Promise.all([loadPairing(), loadMetrics()]);
    }
    await loadPosts();
    await Promise.all([loadNotes().catch(() => {}), loadKnowledge().catch(() => {})]);
    state.extras.us = readExtras('us');
    state.extras.asia = readExtras('asia');
    if (document.body.dataset.view === 'trade') await loadMarket().catch(() => {});
    window.setInterval(() => {
      if (document.body.dataset.view === 'trade' && state.tradePane === 'stocks' && state.session) {
        loadMarket().catch(() => {});
      }
    }, 30_000);
    logBehavior('app.open', { role: session.role });
    connectStream();
  } catch (error) {
    setConnection('offline', '尚未连接');
    elements['unpaired-panel'].classList.remove('hidden');
    elements['session-description'].textContent = error.message;
    const url = new URL(window.location.href);
    if (url.searchParams.has('pair')) showToast(error.message);
  }
}

elements['post-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  elements['form-message'].textContent = '正在发布…';
  const data = new FormData(event.currentTarget);
  try {
    const payload = await api('/api/v1/posts', {
      method: 'POST',
      body: JSON.stringify({
        title: data.get('title'), body: data.get('body'), sourceUrl: data.get('sourceUrl'), tags: data.get('tags'),
      }),
    });
    state.posts = [payload.post, ...state.posts.filter((item) => item.id !== payload.post.id)];
    renderPosts();
    event.currentTarget.reset();
    elements['form-message'].textContent = '发布成功';
    showToast('信息已发布');
    elements['compose-dialog'].close();
    setView('feed');
    await loadMetrics();
  } catch (error) {
    elements['form-message'].textContent = error.message;
  }
});

let composerLogged = false;
elements['post-form'].addEventListener('focusin', () => {
  if (composerLogged) return;
  composerLogged = true;
  logBehavior('composer.started');
});
elements['post-form'].addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') elements['post-form'].requestSubmit();
});
elements['network-address'].addEventListener('change', updatePairingCandidate);
elements['refresh-pairing'].addEventListener('click', () => loadPairing().catch((error) => showToast(error.message)));
elements['open-compose'].addEventListener('click', openHeaderAction);
elements['open-settings'].addEventListener('click', () => setView('settings'));
elements['open-subscriptions'].addEventListener('click', () => elements['subscriptions-dialog'].showModal());
elements['ask-include-feed'].addEventListener('change', (event) => {
  state.includeFeedInAsk = event.currentTarget.checked;
  showToast(state.includeFeedInAsk ? '以后可同时检索最近信息流' : '默认只查知识库');
});
for (const id of ['compose-dialog', 'search-dialog', 'post-dialog', 'subscriptions-dialog', 'holding-dialog']) {
  elements[id].querySelector('.dialog-close').addEventListener('click', () => elements[id].close());
}
let searchTimer = 0;
elements['symbol-search'].addEventListener('input', (event) => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => renderSearch(event.target.value), 280);
});
elements['market-filter'].addEventListener('input', (event) => {
  state.marketFilter = event.currentTarget.value;
  const market = currentMarket();
  if (market && state.stockBoard !== 'overview') renderWatchRows(visibleWatchlist(market));
});
elements['market-sort'].addEventListener('click', () => {
  state.changeSort = state.changeSort === 'none' ? 'desc' : state.changeSort === 'desc' ? 'asc' : 'none';
  updateChangeSortControl();
  const market = currentMarket();
  if (market && state.stockBoard !== 'overview') renderWatchRows(visibleWatchlist(market));
});
elements['note-ai-toggle'].addEventListener('click', () => {
  state.wantAi = !state.wantAi;
  elements['note-ai-toggle'].classList.toggle('is-on', state.wantAi);
  elements['note-ai-toggle'].setAttribute('aria-pressed', String(state.wantAi));
});
elements['note-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  try {
    await api('/api/v1/notes', {
      method: 'POST',
      body: JSON.stringify({ body: elements['note-body'].value, wantAi: state.wantAi }),
    });
    elements['note-form'].reset();
    state.wantAi = false;
    elements['note-ai-toggle'].classList.remove('is-on');
    elements['note-ai-toggle'].setAttribute('aria-pressed', 'false');
    showToast('已记下');
    await loadNotes();
  } catch (error) {
    showToast(error.message);
  }
});
elements['ask-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const question = new FormData(event.currentTarget).get('question');
  if (!question) return;
  const note = document.createElement('article');
  note.className = 'ask-card';
  const scope = state.includeFeedInAsk ? '知识库 + 最近信息流' : '仅知识库';
  note.innerHTML = `<h2>${question}</h2><p>已记下问题。检索范围：${scope}。Agent 接入后会在这里返回答案和来源。</p>`;
  elements['ask-prompts'].before(note);
  event.currentTarget.reset();
  showToast('问答仍是结构占位，没有调用模型');
});
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-nav]');
  if (trigger) setView(trigger.dataset.nav);
});

initialize();
