import {
  askPrompts, assetClasses, bookTabs, channels, feedItems, globalAssets, holdings, marketTabs,
  platformFilters, portfolioSummary, quotes, reportSections, stockBoards as fallbackStockBoards,
  subscriptions, tools, tradeLedger,
} from './mock.js?v=nav-inspire-v1';
import { icon } from './icons.js?v=feed-restore-v1';
import { renderMarkdownInto } from './markdown.js?v=inspire-link-v2';

const platformLabels = { manual: '手工', bilibili: 'B站', x: 'X' };
const processingLabels = { subtitle: '字幕处理中', ai: 'AI 加工中' };
const isHarmonyShell = navigator.userAgent.includes('AI-Center-Harmony/');
const resetConnectionUri = 'aicenter://reset';

const state = {
  session: null,
  posts: [],
  pairing: null,
  stream: null,
  channel: 'all',
  platform: 'all',
  quoteMarket: 'cn',
  assetClass: 'all',
  holdingsMarket: 'all',
  holdingsSort: 'marketValueCny',
  holdingsSortDir: 'desc',
  holdingsBoard: null,
  holdingsError: '',
  holdingsLoading: false,
  holdingsRefreshing: false,
  holdingsMoveGroup: null,
  tradePane: 'stocks',
  stockBoard: 'overview',
  stockGroup: '全部',
  changeSort: 'none',
  marketFilter: '',
  markets: { overview: null, us: null, asia: null },
  marketLoading: false,
  marketError: '',
  marketRequestId: 0,
  assetBoard: null,
  assetLoading: false,
  assetError: '',
  assetRequestId: 0,
  assetFilter: '',
  assetDashboard: null,
  assetDashboardError: '',
  assetDashboardLoading: false,
  bootstrapped: false,
  extras: { us: [], asia: [] },
  xItems: [],
  xFeed: 'for-you',
  xNote: '',
  xLoading: false,
  xRefreshing: false,
  xTranslating: false,
  xTagging: false,
  feedTaggings: {},
  tagCatalog: null,
  bilibiliItems: [],
  bilibiliNote: '',
  bilibiliLoading: false,
  translations: {},
  xSavedUrls: new Set(),
  dialogPost: null,
  feedShown: 12,
  feedRestoreId: '',
  feedAnchorId: '',
  notes: [],
  expandedInspirationIds: new Set(),
  knowledge: [],
  wantAi: false,
  askSubmitting: false,
  askSessions: [],
  askSessionId: '',
  askDetail: null,
  askPending: null,
  referenceDraft: [],
  mentionItems: [],
  mentionIndex: 0,
  mentionRange: null,
  sourceCatalog: [],
  sourceSnapshots: {},
  hubLane: 'overview',
  sourceLoading: false,
  viewReloading: false,
  hiddenFeedIds: new Set(),
  lastOverviewTarget: '',
};

const hubLanes = [
  { id: 'overview', label: '总览', view: 'sources' },
  { id: 'feed', label: '社媒', view: 'feed' },
  { id: 'stocks', label: '股票', view: 'market' },
  { id: 'global', label: '全球资产', view: 'market/global' },
];

const overviewViews = ['sources', 'feed', 'market'];

const futureSourceSlots = [
  { id: 'future.news', title: '新闻与 RSS', category: 'future', providerId: '待选择', viewKind: 'content-feed', description: '网站、RSS 和公开新闻统一进入信息流。' },
  { id: 'future.filings', title: '公司公告', category: 'future', providerId: '待选择', viewKind: 'content-feed', description: '财报、公告和投资者关系材料。' },
  { id: 'future.calendar', title: '宏观日历', category: 'future', providerId: '待选择', viewKind: 'calendar', description: '经济数据、财报日和重要事件日历。' },
];

const navItems = [
  { id: 'sources', label: '总览', icon: 'house' },
  { id: 'inspire', label: '灵感', icon: 'lightbulb' },
  { id: 'ask', label: '问答', icon: 'message-circle' },
  { id: 'assets', label: '资产', icon: 'wallet' },
  { id: 'tools', label: '工具', icon: 'layout-grid' },
];

const viewCopy = {
  sources: { title: '总览', subtitle: '图表、摘选和后续看板' },
  feed: { title: '社媒', subtitle: '外部信息与手工发布的完整信息流' },
  market: { title: '市场', subtitle: '股票观察池与全球资产报价' },
  assets: { title: '资产', subtitle: '持仓账本与个人资产分析' },
  tools: { title: '工具', subtitle: '知识库、日报和连接' },
  inspire: { title: '灵感', subtitle: '马上写下来，默认只保存原文' },
  knowledge: { title: '知识库', subtitle: '可长期复用的规范内容' },
  ask: { title: '问答', subtitle: 'AI 记录，可回溯也可继续' },
  report: { title: '日报', subtitle: '跨模块汇总，先定结构' },
  settings: { title: '设置', subtitle: '设备、连接器和账户' },
};

const elements = Object.fromEntries([
  'connection-state', 'server-name', 'session-description', 'pairing-panel', 'pairing-qr',
  'network-address', 'pairing-code', 'refresh-pairing', 'unpaired-panel', 'unpaired-title',
  'unpaired-message', 'exit-to-pairing', 'retry-session', 'device-repair-panel', 'restart-pairing', 'authorized-content',
  'authorized-feed', 'page-title', 'page-subtitle', 'post-form', 'post-title', 'post-body',
  'form-message', 'feed', 'feed-count', 'metrics-panel', 'metric-devices', 'metric-opens',
  'metric-published', 'metric-details', 'device-list', 'post-dialog', 'dialog-title',
  'dialog-body', 'dialog-translation', 'dialog-tags', 'dialog-source', 'dialog-translate', 'dialog-time', 'toast', 'channel-tabs',
  'platform-filters', 'follow-toolbar', 'bilibili-toolbar', 'bilibili-feed-status', 'bilibili-import-form', 'bilibili-url', 'bilibili-import', 'x-toolbar', 'x-translate-bar', 'x-feed-status', 'x-translate-status', 'x-feed-tabs', 'x-refresh', 'x-translate', 'x-tag', 'quote-filters', 'quote-list', 'tool-grid',
  'ask-records', 'ask-start', 'ask-session-list', 'ask-session-shell', 'ask-back', 'ask-intro', 'ask-prompt-label',
  'ask-thread', 'ask-prompts', 'ask-form', 'ask-send', 'ask-ref-chips', 'ask-mention-menu', 'compose-dialog', 'reload-view', 'open-compose', 'open-settings',
  'side-nav-list', 'bottom-tab', 'market-tabs', 'book-tabs', 'holdings-list', 'holdings-filters', 'asset-filters',
  'asset-list', 'ledger-list', 'search-dialog', 'symbol-search', 'search-results',
  'note-form', 'note-body', 'note-title', 'note-source-url', 'note-source-title', 'note-source-type',
  'note-capture-channel', 'note-source-app', 'note-share-source', 'note-ai-toggle', 'note-list',
  'knowledge-list', 'portfolio-summary',
  'report-list', 'open-subscriptions', 'subscriptions-dialog', 'subscription-list',
  'holding-dialog', 'holding-title', 'holding-meta', 'holding-metrics',
  'stock-boards', 'market-status', 'market-overview', 'market-head', 'market-table-scroll', 'market-sort', 'market-filter', 'market-filter-wrap',
  'asset-sort', 'asset-filter', 'asset-filter-wrap', 'asset-table-scroll',
  'market-sync-hint', 'book-sync-hint', 'analysis-period', 'analysis-kpis', 'analysis-trend', 'analysis-pie',
  'analysis-diagnosis-1', 'analysis-diagnosis-2', 'analysis-dividend-total', 'analysis-dividend', 'analysis-insights',
  'holdings-note', 'holdings-head', 'holdings-moves', 'holdings-overview', 'holdings-group-detail',
  'holdings-group-title', 'holdings-group-moves', 'holdings-group-back', 'holdings-refresh',
  'reference-dock', 'reference-preview', 'reference-preview-title', 'reference-preview-meta', 'reference-preview-body',
  'hub-ticker', 'hub-excerpts', 'overview-subnav',
].map((id) => [id, document.getElementById(id)]));

const TRANSLATION_STORE_KEY = 'ai-center.translations.v1';
const TRANSLATION_STORE_LIMIT = 400;
const TRANSLATE_BATCH_SIZE = 30;
const TAG_BATCH_SIZE = 50;

function hashText(value) {
  let hash = 2166136261;
  const source = String(value || '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function translationStoreKey(post) {
  return `${post.id}::${hashText(post.body || '')}`;
}

function loadTranslationStore() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TRANSLATION_STORE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveTranslationStore(store) {
  const entries = Object.entries(store).sort((left, right) => (right[1]?.at || 0) - (left[1]?.at || 0));
  const trimmed = Object.fromEntries(entries.slice(0, TRANSLATION_STORE_LIMIT));
  window.localStorage.setItem(TRANSLATION_STORE_KEY, JSON.stringify(trimmed));
}

function translationFor(post) {
  if (!post?.id) return null;
  if (state.translations[post.id]) return state.translations[post.id];
  const stored = loadTranslationStore()[translationStoreKey(post)];
  if (!stored?.text) return null;
  state.translations[post.id] = { text: stored.text, engine: stored.engine || '', cached: true };
  return state.translations[post.id];
}

function rememberTranslation(post, translation) {
  state.translations[post.id] = translation;
  const store = loadTranslationStore();
  store[translationStoreKey(post)] = {
    text: translation.text,
    engine: translation.engine || '',
    at: Date.now(),
  };
  saveTranslationStore(store);
}

function postNeedsChineseTranslation(post) {
  const source = String(post?.body || '').trim();
  if (!source) return false;
  const hangul = (source.match(/\p{Script=Hangul}/gu) || []).length;
  const latin = (source.match(/[A-Za-z]/g) || []).length;
  const han = (source.match(/\p{Script=Han}/gu) || []).length;
  if (hangul === 0 && latin === 0) return false;
  const foreign = hangul + latin;
  if (han >= 8 && foreign < Math.max(8, Math.ceil(han * 0.25))) return false;
  return true;
}

function pendingXTranslations(limit = TRANSLATE_BATCH_SIZE) {
  return state.xItems.map(xAsItem)
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
    .filter((post) => postNeedsChineseTranslation(post) && !translationFor(post))
    .slice(0, limit);
}

function taggingFor(resourceId) {
  return state.feedTaggings[String(resourceId || '')] || null;
}

function pendingXTaggings(limit = TAG_BATCH_SIZE) {
  return state.xItems
    .filter((item) => item.resourceId && !taggingFor(item.resourceId))
    .slice(0, limit);
}

function tagNames(tagIds = []) {
  const catalog = new Map((state.tagCatalog?.tags || []).map((tag) => [tag.id, tag.name]));
  return tagIds.map((id) => catalog.get(id) || id);
}

function translateActionLabel(post) {
  if (post?.platform !== 'x') return translationFor(post) ? '已翻译' : '翻译';
  if (state.xTranslating) return '翻译中…';
  const pending = pendingXTranslations().length;
  if (!pending) return translationFor(post) ? '已翻译' : '翻译';
  return `翻译 ${pending} 条`;
}

function setIconButton(element, name) {
  if (element) element.innerHTML = icon(name);
}

function renderNav() {
  elements['side-nav-list'].replaceChildren(...navItems.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `nav-item${item.parent ? ' nav-item-child' : ''}`;
    button.dataset.nav = item.id;
    if (item.parent) button.dataset.navParent = item.parent;
    button.innerHTML = `${icon(item.icon)}<span>${item.label}</span>`;
    return button;
  }));
  elements['bottom-tab'].replaceChildren(...navItems.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab-item';
    button.dataset.nav = item.id;
    button.innerHTML = `${icon(item.icon)}<span>${item.label}</span>`;
    return button;
  }));
}

function isPrimaryNavActive(navId, view) {
  if (navId === 'sources') return overviewViews.includes(view);
  if (navId === 'tools') return view === 'tools' || view === 'knowledge' || view === 'report';
  return navId === view;
}

function resolveView(name) {
  if (name === 'trade') return 'market';
  if (name === 'account') return 'settings';
  return viewCopy[name] ? name : 'sources';
}

function parseLocation(name = (location.hash || '#sources').slice(1)) {
  const raw = String(name || 'sources').replace(/^#/, '');
  const [head, ...rest] = raw.split('/');
  const view = resolveView(head);
  const marketPane = view === 'market' && rest[0] === 'global' ? 'assets' : (view === 'market' ? 'stocks' : '');
  const askSessionId = view === 'ask' && rest[0] ? rest.join('/') : '';
  return { view, askSessionId, marketPane };
}

const OVERVIEW_LANE_KEY = 'ai-center.last-overview';

function readLastOverviewTarget() {
  if (state.lastOverviewTarget) return state.lastOverviewTarget;
  try {
    return sessionStorage.getItem(OVERVIEW_LANE_KEY) || '';
  } catch {
    return '';
  }
}

function rememberOverviewTarget(view, pane = state.tradePane) {
  if (!overviewViews.includes(view)) return;
  const target = view === 'market'
    ? (pane === 'assets' ? 'market/global' : 'market')
    : view;
  state.lastOverviewTarget = target;
  try { sessionStorage.setItem(OVERVIEW_LANE_KEY, target); } catch {}
}

function overviewLane(view = document.body.dataset.view, pane = state.tradePane) {
  if (view === 'feed') return 'feed';
  if (view === 'market') return pane === 'assets' ? 'global' : 'stocks';
  return 'overview';
}

function overviewHash(lane = overviewLane()) {
  if (lane === 'feed') return '#feed';
  if (lane === 'stocks') return '#market';
  if (lane === 'global') return '#market/global';
  return '#sources';
}

function renderOverviewLanes() {
  const target = elements['overview-subnav'];
  if (!target) return;
  target.classList.toggle('is-on', overviewViews.includes(document.body.dataset.view));
  const current = overviewLane();
  target.replaceChildren(...hubLanes.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `text-tab${item.id === current ? ' is-active' : ''}`;
    button.textContent = item.label;
    button.addEventListener('click', () => setView(item.view));
    return button;
  }));
}

function askHash(sessionId = state.askSessionId) {
  return sessionId ? `#ask/${sessionId}` : '#ask';
}

function setView(name, options = {}) {
  const incoming = String(name || '').replace(/^#/, '');
  const requested = options.fromPrimaryNav && incoming === 'sources'
    ? (readLastOverviewTarget() || 'sources')
    : incoming;
  const parsed = parseLocation(requested);
  const view = parsed.view;
  const previous = document.body.dataset.view || '';
  const leaving = previous && previous !== view;
  if (leaving) captureViewScroll(previous);
  state.askSessionId = view === 'ask' ? parsed.askSessionId : '';
  if (view === 'market' && parsed.marketPane) state.tradePane = parsed.marketPane;
  state.hubLane = overviewLane(view, state.tradePane);
  rememberOverviewTarget(view, state.tradePane);
  document.body.dataset.view = view;
  document.body.dataset.askLayer = view === 'ask' && state.askSessionId ? 'session' : 'list';
  document.querySelectorAll('[data-view-panel]').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.viewPanel === view);
  });
  document.querySelectorAll('.nav-item, .tab-item').forEach((control) => {
    control.classList.toggle('is-active', isPrimaryNavActive(control.dataset.nav, view));
    control.classList.toggle('is-parent-active', false);
  });
  if (view === 'market') {
    elements['page-title'].textContent = state.tradePane === 'assets' ? '全球资产' : '股票';
    elements['page-subtitle'].textContent = state.tradePane === 'assets'
      ? '指数、外汇、利率、贵金属、能源与加密'
      : '总览、美股和亚洲观察池';
  } else {
    elements['page-title'].textContent = viewCopy[view].title;
    elements['page-subtitle'].textContent = viewCopy[view].subtitle;
  }
  updateHeaderAction(view);
  renderOverviewLanes();
  if (view === 'inspire') loadNotes().catch((error) => showToast(error.message));
  if (view === 'knowledge') loadKnowledge().catch((error) => showToast(error.message));
  if (view === 'market' || view === 'assets') {
    alignTradePane(view);
    renderTradeTabs();
    if (state.bootstrapped) syncTradePaneData().catch((error) => showToast(error.message));
  }
  if (view === 'sources' && state.bootstrapped) loadSourcesPage().catch((error) => showToast(error.message));
  if (view === 'ask') syncAskView().catch((error) => showToast(error.message));
  renderReferenceUi();
  const nextHash = view === 'ask'
    ? askHash(state.askSessionId)
    : view === 'market'
      ? overviewHash(state.tradePane === 'assets' ? 'global' : 'stocks')
      : `#${view}`;
  if (location.hash !== nextHash) history.replaceState({}, '', `${location.pathname}${location.search}${nextHash}`);
  if (leaving) restoreViewScroll(view);
}

function updateHeaderAction(view) {
  const button = elements['open-compose'];
  button.hidden = view === 'inspire';
  if (view === 'inspire') return;
  if (view === 'market' || view === 'assets') {
    button.dataset.action = 'search';
    button.setAttribute('aria-label', '搜索标的');
    setIconButton(button, 'search');
    return;
  }
  if (view === 'ask') {
    button.dataset.action = 'ask-new';
    button.setAttribute('aria-label', '新的问答');
    setIconButton(button, 'plus');
    return;
  }
  button.dataset.action = 'compose';
  button.setAttribute('aria-label', '快速发布');
  setIconButton(button, 'plus');
}

async function reloadCurrentView() {
  if (state.viewReloading) return;
  const button = elements['reload-view'];
  state.viewReloading = true;
  button?.classList.add('is-spinning');
  button?.setAttribute('aria-busy', 'true');
  try {
    if (!state.session) throw new Error('尚未连接，无法刷新');
    const view = document.body.dataset.view;
    const tasks = [];
    if (view === 'feed' || view === 'sources') {
      tasks.push(loadPosts());
      tasks.push(loadXFeed({ refresh: false }));
      tasks.push(loadBilibiliFeed({ refresh: false }));
    }
    if (view === 'sources') tasks.push(loadSourcesPage());
    if (view === 'inspire') tasks.push(loadNotes());
    if (view === 'ask') tasks.push(syncAskView());
    if (view === 'market') tasks.push(syncTradePaneData());
    if (view === 'assets') {
      tasks.push(state.tradePane === 'holdings' ? loadHoldings({ refresh: true }) : syncTradePaneData());
    }
    if (view === 'knowledge') tasks.push(loadKnowledge());
    if (view === 'tools') {
      tasks.push(loadSourceCatalog());
      tasks.push(loadKnowledge());
    }
    if (view === 'report') renderReport();
    if (view === 'settings' && state.session.role === 'desktop') {
      tasks.push(loadPairing());
      tasks.push(loadMetrics());
    }
    const results = await Promise.allSettled(tasks);
    const failed = results.find((item) => item.status === 'rejected');
    if (failed) throw failed.reason;
    showToast('已更新当前页');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '刷新失败');
  } finally {
    state.viewReloading = false;
    button?.classList.remove('is-spinning');
    button?.removeAttribute('aria-busy');
  }
}

async function api(path, options = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  const controller = timeoutMs ? new AbortController() : null;
  const timer = timeoutMs ? window.setTimeout(() => controller.abort(), timeoutMs) : 0;
  try {
    const response = await fetch(path, {
      credentials: 'include',
      ...fetchOptions,
      signal: fetchOptions.signal || controller?.signal,
      headers: { 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `请求失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('请求超时，请稍后重试');
    throw error;
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

function setConnection(kind, label) {
  elements['connection-state'].className = `connection-state ${kind}`;
  elements['connection-state'].querySelector('span').textContent = label;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function openExternalHttpUrl(url, event) {
  const href = String(url || '').trim();
  if (!isHttpUrl(href)) {
    event?.preventDefault();
    return false;
  }
  event?.stopPropagation();
  const bridge = window.AICenterShell;
  if (bridge && typeof bridge.openExternalUrl === 'function') {
    event?.preventDefault();
    try {
      bridge.openExternalUrl(href);
      return true;
    } catch (_error) {
      // 原生桥失败时继续走浏览器新窗口。
    }
  }
  if (event?.target instanceof Element && event.target.closest('a')) return true;
  const opened = window.open(href, '_blank', 'noopener,noreferrer');
  if (!opened) {
    showToast('浏览器拦截了新窗口，请允许弹出后重试');
    return false;
  }
  return true;
}

function appendExternalLink(parent, url, label) {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label;
  link.addEventListener('click', (event) => openExternalHttpUrl(url, event));
  parent.append(link);
  return link;
}

function showToast(message, action) {
  elements.toast.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  elements.toast.append(text);
  if (action?.label && action.onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      elements.toast.classList.remove('visible');
      action.onClick();
    });
    elements.toast.append(button);
  }
  elements.toast.classList.toggle('has-action', Boolean(action?.label));
  elements.toast.classList.add('visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove('visible'), action ? 5200 : 2600);
}

function removePairingCodeFromAddress() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('pair')) return;
  url.searchParams.delete('pair');
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function showUnpairedPage(message, pairingFailed = false) {
  state.session = null;
  state.stream?.close();
  document.body.classList.add('is-unpaired');
  elements['unpaired-panel'].classList.remove('hidden');
  elements['unpaired-title'].textContent = pairingFailed ? '配对没有完成' : '这台设备尚未配对';
  elements['unpaired-message'].textContent = message || '请回到电脑上的 AI Center，刷新二维码后重新扫描。';
  elements['exit-to-pairing'].textContent = isHarmonyShell ? '退出并重新扫码' : '清除连接并重新扫码';
}

function hideUnpairedPage() {
  document.body.classList.remove('is-unpaired');
  elements['unpaired-panel'].classList.add('hidden');
}

async function exitAndRePair() {
  const controls = [elements['exit-to-pairing'], elements['restart-pairing']];
  controls.forEach((control) => {
    control.disabled = true;
  });
  try {
    await api('/api/v1/session/logout', { method: 'POST' });
  } catch (_error) {
    // 即使电脑服务暂不可用，鸿蒙薄壳仍然需要能够清除旧地址。
  }

  if (isHarmonyShell) {
    try {
      if (window.AICenterShell && typeof window.AICenterShell.resetConnection === 'function') {
        window.AICenterShell.resetConnection();
        return;
      }
    } catch (_error) {
      // 原生桥接不可用时继续使用内部 URI 后备协议。
    }
    window.location.href = resetConnectionUri;
    window.setTimeout(() => {
      controls.forEach((control) => {
        control.disabled = false;
      });
      showToast('未能返回扫码页，请重试或重新打开 App');
    }, 1500);
    return;
  }

  showUnpairedPage('当前浏览器连接已清除。请关闭此页面，回到电脑端刷新二维码后重新扫描。');
  controls.forEach((control) => {
    control.disabled = false;
  });
}

function logBehavior(name, metadata = {}) {
  api('/api/v1/behavior', { method: 'POST', body: JSON.stringify({ name, metadata }) }).catch(() => {});
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(timestamp);
}

function formatAskDay(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '更早';
  const today = new Date();
  const startToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const startThat = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startToday - startThat) / 86_400_000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays > 1 && diffDays < 7) return `${diffDays} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(date);
}

function formatAskClock(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

const FEED_PAGE_SIZE = 12;
let pageScrollY = 0;
let feedObserver = null;
let restoringViewScroll = false;
const viewScrollY = Object.fromEntries(Object.keys(viewCopy).map((name) => [name, 0]));

function persistFeedBrowseState() {
  try {
    sessionStorage.setItem('ai-center.feed-browse', JSON.stringify({
      y: viewScrollY.feed || 0,
      anchorId: state.feedAnchorId || '',
      shown: state.feedShown,
    }));
  } catch {}
}

function restorePersistedFeedBrowseState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('ai-center.feed-browse') || 'null');
    if (!saved) return;
    if (Number.isFinite(saved.y)) viewScrollY.feed = saved.y;
    if (saved.anchorId) state.feedAnchorId = saved.anchorId;
    if (Number.isFinite(saved.shown) && saved.shown > state.feedShown) {
      state.feedShown = saved.shown;
    }
  } catch {}
}

function captureViewScroll(view) {
  if (!view || !viewScrollY.hasOwnProperty(view)) return;
  if (document.body.classList.contains('is-dialog-open')) return;
  viewScrollY[view] = window.scrollY;
  if (view !== 'feed') return;
  const cards = [...document.querySelectorAll('#feed .post-card[data-post-id]')];
  const visible = cards.find((card) => card.getBoundingClientRect().bottom > 96);
  state.feedAnchorId = visible?.dataset.postId || '';
  persistFeedBrowseState();
}

function restoreViewScroll(view) {
  const y = Number(viewScrollY[view] || 0);
  const postId = view === 'feed' ? (state.feedAnchorId || '') : '';
  restoringViewScroll = true;
  if (view === 'feed' && postId) {
    const index = visibleFeedItems().findIndex((item) => String(item.id) === String(postId));
    if (index >= 0 && state.feedShown < index + 1) {
      state.feedShown = Math.max(FEED_PAGE_SIZE, index + 1);
      renderPosts();
    }
  }
  const apply = () => {
    window.scrollTo(0, y);
    if (view !== 'feed' || !postId) return;
    if (Math.abs(window.scrollY - y) <= 8) return;
    const selector = `[data-post-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(postId) : postId.replace(/"/g, '')}"]`;
    document.querySelector(selector)?.scrollIntoView({ block: 'start' });
  };
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(() => {
      apply();
      restoringViewScroll = false;
      if (viewScrollY.hasOwnProperty(view) && !document.body.classList.contains('is-dialog-open')) {
        viewScrollY[view] = window.scrollY;
      }
    });
  });
}

function capturePageScroll() {
  if (document.body.classList.contains('is-dialog-open')) return;
  pageScrollY = window.scrollY;
}

function restorePageScroll() {
  const y = pageScrollY;
  const postId = state.feedRestoreId;
  const apply = () => {
    window.scrollTo(0, y);
    if (document.body.dataset.view !== 'feed' || !postId) return;
    if (Math.abs(window.scrollY - y) <= 8) return;
    const selector = `[data-post-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(postId) : postId.replace(/"/g, '')}"]`;
    document.querySelector(selector)?.scrollIntoView({ block: 'nearest' });
  };
  apply();
  requestAnimationFrame(() => requestAnimationFrame(apply));
}

function lockPageScroll(locked) {
  const root = document.documentElement;
  const body = document.body;
  if (locked) {
    root.classList.add('is-dialog-open');
    body.classList.add('is-dialog-open');
    body.style.top = `-${pageScrollY}px`;
    return;
  }
  root.classList.remove('is-dialog-open');
  body.classList.remove('is-dialog-open');
  body.style.top = '';
  restorePageScroll();
}

function openDialog(dialog) {
  capturePageScroll();
  dialog.showModal();
  lockPageScroll(true);
}

function createPostLink(label, onClick) {
  const link = document.createElement('span');
  link.className = 'post-link';
  link.setAttribute('role', 'button');
  link.tabIndex = 0;
  link.textContent = label;
  const run = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  };
  link.addEventListener('click', run);
  link.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') run(event);
  });
  return link;
}

function anyDialogOpen() {
  return ['compose-dialog', 'search-dialog', 'post-dialog', 'subscriptions-dialog', 'holding-dialog', 'reference-preview']
    .some((id) => document.getElementById(id)?.open);
}

function releaseDialogScroll() {
  if (anyDialogOpen()) return;
  if (!document.body.classList.contains('is-dialog-open')) return;
  lockPageScroll(false);
}

function liveAsItem(post) {
  return {
    id: post.id,
    resourceId: post.id,
    resourceType: 'post',
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

function refreshSavedMarks() {
  const urls = new Set();
  for (const note of state.notes) {
    if (note.sourceUrl) urls.add(String(note.sourceUrl));
    const matches = String(note.body || '').match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s]+/gi) || [];
    for (const url of matches) urls.add(url.replace(/[),.;]+$/, ''));
  }
  state.xSavedUrls = urls;
}

function inspirationForPost(post) {
  const url = String(post?.sourceUrl || '').trim();
  const sourceId = String(post?.resourceId || (post?.platform === 'manual' ? post.id : '') || '').trim();
  return state.notes.find((note) => (
    (url && note.sourceUrl === url)
    || (sourceId && note.sourceId === sourceId)
  )) || null;
}

function isPostSaved(post) {
  if (inspirationForPost(post)) return true;
  return Boolean(post.sourceUrl && state.xSavedUrls.has(post.sourceUrl));
}

function inspirationBodyFromPost(post) {
  return [post.author, post.handle, post.body].filter(Boolean).join('\n\n').slice(0, 4000);
}

function clearSharedInspirationDraft() {
  elements['note-title'].value = '';
  elements['note-source-url'].value = '';
  elements['note-source-title'].value = '';
  elements['note-source-type'].value = '';
  elements['note-capture-channel'].value = 'web';
  elements['note-source-app'].value = '';
  elements['note-share-source'].replaceChildren();
  elements['note-share-source'].classList.add('hidden');
}

function receiveHarmonyShare(payload = {}) {
  const body = String(payload.body || '').trim().slice(0, 100_000);
  if (!body) return false;
  const sourceUrl = String(payload.sourceUrl || '').trim().slice(0, 2048);
  const sourceTitle = String(payload.sourceTitle || '').trim().slice(0, 500);
  elements['note-body'].value = body;
  elements['note-title'].value = String(payload.title || '').trim().slice(0, 200);
  elements['note-source-url'].value = sourceUrl;
  elements['note-source-title'].value = sourceTitle;
  elements['note-source-type'].value = 'external-share';
  elements['note-capture-channel'].value = 'harmony-share';
  elements['note-source-app'].value = String(payload.sourceApp || '').trim().slice(0, 200);
  const source = elements['note-share-source'];
  source.replaceChildren(Object.assign(document.createElement('span'), {
    textContent: sourceTitle ? `来自系统分享 · ${sourceTitle}` : '来自 HarmonyOS 系统分享',
  }));
  if (isHttpUrl(sourceUrl)) {
    source.append(' · ');
    appendExternalLink(source, sourceUrl, '查看来源');
  }
  source.classList.remove('hidden');
  setView('inspire');
  requestAnimationFrame(() => elements['note-body'].focus());
  return true;
}

window.AICenterReceiveShare = receiveHarmonyShare;

let harmonyLocalSyncing = false;

function harmonyLocalBridge() {
  const bridge = window.AICenterShell;
  return bridge && typeof bridge.getLocalInspirationOutbox === 'function' ? bridge : null;
}

function harmonyInspirationContentKey(item) {
  return `${String(item.body || '').trim()}\n${String(item.sourceUrl || '').trim().toLowerCase()}`;
}

async function syncHarmonyLocalInspirations() {
  const bridge = harmonyLocalBridge();
  if (!bridge || !state.session || harmonyLocalSyncing) return;
  harmonyLocalSyncing = true;
  try {
    const snapshot = await api('/api/v1/notes?status=all');
    const serverNotes = Array.isArray(snapshot.notes) ? snapshot.notes : [];
    const raw = await Promise.resolve(bridge.getLocalInspirationOutbox());
    const parsed = JSON.parse(String(raw || '[]'));
    const outbox = Array.isArray(parsed) ? parsed : [];
    for (const item of outbox) {
      const clientMutationId = String(item.clientMutationId || '');
      if (!clientMutationId) continue;
      const duplicate = serverNotes.find((note) => (
        note.clientMutationId === clientMutationId ||
        harmonyInspirationContentKey(note) === harmonyInspirationContentKey(item)
      ));
      if (duplicate) {
        bridge.acknowledgeLocalInspiration(clientMutationId, duplicate.id);
        continue;
      }
      try {
        const payload = await api('/api/v1/notes', {
          method: 'POST',
          body: JSON.stringify({
            title: item.title || '',
            body: item.body || '',
            wantAi: false,
            sourceType: item.sourceType || '',
            sourceId: item.sourceId || '',
            sourceUrl: item.sourceUrl || '',
            sourceTitle: item.sourceTitle || '',
            captureChannel: item.captureChannel || 'harmony-local',
            sourceApp: item.sourceApp || '',
            clientMutationId,
            capturedAt: item.capturedAt,
          }),
        });
        bridge.acknowledgeLocalInspiration(clientMutationId, payload.note.id);
        serverNotes.push(payload.note);
      } catch (error) {
        bridge.markLocalInspirationError(clientMutationId, error.message || '同步失败');
      }
    }
    await loadNotes();
  } catch (_error) {
    // 网络或授权恢复后，页面启动、回到前台或定时任务会自动重试。
  } finally {
    harmonyLocalSyncing = false;
  }
}

window.AICenterSyncLocalInspirations = syncHarmonyLocalInspirations;

async function savePostToInspiration(post) {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  let existing = inspirationForPost(post);
  if (!existing && isPostSaved(post)) {
    await loadNotes().catch(() => {});
    existing = inspirationForPost(post);
  }
  if (existing || isPostSaved(post)) {
    if (existing) {
      await api(`/api/v1/notes/${existing.id}`, { method: 'DELETE' });
      state.notes = state.notes.filter((note) => note.id !== existing.id);
    }
    if (post.sourceUrl) state.xSavedUrls.delete(post.sourceUrl);
    showToast('已取消收藏');
    renderPosts();
    loadNotes().catch(() => {});
    return;
  }
  const payload = await api('/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify({
      body: inspirationBodyFromPost(post),
      wantAi: false,
      sourceType: 'content-item',
      sourceId: post.resourceId || post.id,
      sourceUrl: post.sourceUrl || '',
      sourceTitle: post.title || post.author || '',
      captureChannel: 'feed',
    }),
  });
  if (payload.note) {
    state.notes = [payload.note, ...state.notes.filter((note) => note.id !== payload.note.id)];
  }
  if (post.sourceUrl) state.xSavedUrls.add(post.sourceUrl);
  showToast('已加入灵感');
  renderPosts();
  loadNotes().catch(() => {});
}

function insertFeedListItem(list, item, index) {
  const next = list.filter((row) => row.id !== item.id && row.resourceId !== item.resourceId);
  const at = Math.max(0, Math.min(index, next.length));
  next.splice(at, 0, item);
  return next;
}

function stashFeedItem(post) {
  const xIndex = state.xItems.findIndex((item) => item.id === post.id || item.resourceId === post.resourceId);
  const biliIndex = state.bilibiliItems.findIndex((item) => item.id === post.id || item.resourceId === post.resourceId);
  const liveIndex = state.posts.findIndex((item) => item.id === post.id);
  return {
    post,
    xItem: xIndex >= 0 ? state.xItems[xIndex] : null,
    xIndex,
    biliItem: biliIndex >= 0 ? state.bilibiliItems[biliIndex] : null,
    biliIndex,
    liveItem: liveIndex >= 0 ? state.posts[liveIndex] : null,
    liveIndex,
  };
}

function restoreStashedFeedItem(stash) {
  state.hiddenFeedIds.delete(stash.post.id);
  if (stash.post.resourceId) state.hiddenFeedIds.delete(stash.post.resourceId);
  if (stash.xItem) state.xItems = insertFeedListItem(state.xItems, stash.xItem, stash.xIndex);
  if (stash.biliItem) state.bilibiliItems = insertFeedListItem(state.bilibiliItems, stash.biliItem, stash.biliIndex);
  if (stash.liveItem) state.posts = insertFeedListItem(state.posts, stash.liveItem, stash.liveIndex);
}

function dropFeedItemLocally(post) {
  state.hiddenFeedIds.add(post.id);
  if (post.resourceId) state.hiddenFeedIds.add(post.resourceId);
  state.posts = state.posts.filter((item) => item.id !== post.id);
  state.xItems = state.xItems.filter((item) => item.id !== post.id && item.resourceId !== post.resourceId);
  state.bilibiliItems = state.bilibiliItems.filter((item) => item.id !== post.id && item.resourceId !== post.resourceId);
}

async function hideFeedItem(post) {
  const contentItemId = post.resourceType === 'content-item' ? post.resourceId : '';
  const isManual = post.platform === 'manual' && post.live;
  if ((contentItemId || isManual) && !state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  const stash = stashFeedItem(post);
  dropFeedItemLocally(post);
  renderPosts();
  try {
    if (contentItemId) {
      await api(`/api/v1/content-items/${contentItemId}/state`, {
        method: 'PATCH',
        body: JSON.stringify({ isHidden: true }),
      });
    } else if (isManual) {
      await api(`/api/v1/posts/${post.id}/state`, {
        method: 'PATCH',
        body: JSON.stringify({ isHidden: true }),
      });
    }
  } catch (error) {
    restoreStashedFeedItem(stash);
    renderPosts();
    showToast(error.message || '删除失败，已恢复');
  }
}

const REFERENCE_TYPE_LABELS = {
  'content-item': '信息',
  post: '手工',
  inspiration: '灵感',
  'knowledge-revision': '知识',
  'ai-run': '回答',
  'web-result': '网页',
  'holdings-board': '持仓',
  'market-board': '市场',
};
const MENTION_KIND_LABELS = {
  framework: '分析框架',
  concept: '概念',
  procedure: '方法',
  fact: '事实',
  mechanism: '机制',
  thesis: '论点',
  case: '案例',
  knowledge: '知识',
};
const MAX_REFERENCE_DRAFT = 8;

function referenceKey(ref) {
  return `${ref.resourceType}:${ref.resourceId}:${ref.revision || ''}`;
}

function isReferenced(ref) {
  const key = referenceKey(ref);
  return state.referenceDraft.some((item) => referenceKey(item) === key);
}

function addReference(ref) {
  if (!ref?.resourceType || !ref?.resourceId) {
    showToast('这条还没有入库，无法引用');
    return false;
  }
  if (isReferenced(ref)) {
    showToast('已经在引用里');
    return true;
  }
  if (state.referenceDraft.length >= MAX_REFERENCE_DRAFT) {
    showToast(`一次最多引用 ${MAX_REFERENCE_DRAFT} 条`);
    return false;
  }
  const label = String(ref.label || '未命名').replace(/\s+/g, ' ').trim().slice(0, 40) || '未命名';
  state.referenceDraft = [...state.referenceDraft, {
    resourceType: ref.resourceType,
    resourceId: ref.resourceId,
    revision: ref.revision,
    label,
    preview: String(ref.preview || '').slice(0, 800),
  }];
  renderReferenceUi();
  renderPosts();
  showToast(`已加入 ref${state.referenceDraft.length - 1}`);
  return true;
}

function toggleReference(ref) {
  if (!ref?.resourceType || !ref?.resourceId) {
    showToast('这条还没有入库，无法引用');
    return false;
  }
  const index = state.referenceDraft.findIndex((item) => referenceKey(item) === referenceKey(ref));
  if (index >= 0) {
    removeReference(index);
    showToast('已取消引用');
    return false;
  }
  return addReference(ref);
}

function removeReference(index) {
  state.referenceDraft = state.referenceDraft.filter((_, current) => current !== index);
  renderReferenceUi();
  renderPosts();
}

function clearReferences() {
  state.referenceDraft = [];
  renderReferenceUi();
}

function draftPayload() {
  return state.referenceDraft.map(({ resourceType, resourceId, revision }) => (
    revision ? { resourceType, resourceId, revision } : { resourceType, resourceId }
  ));
}

function openReferencePreview(ref, index) {
  const token = Number.isInteger(index) ? `ref${index} · ` : '';
  elements['reference-preview-title'].textContent = `${token}${REFERENCE_TYPE_LABELS[ref.resourceType] || ref.resourceType} · ${ref.label || '引用'}`;
  elements['reference-preview-meta'].textContent = ref.resourceId;
  elements['reference-preview-body'].textContent = ref.preview || '没有预览正文。发送后会按当前落库内容读取。';
  openDialog(elements['reference-preview']);
}

function createRefChip(ref, index, { removable = false } = {}) {
  const chip = document.createElement(removable ? 'div' : 'button');
  chip.className = removable ? 'ask-ref-chip' : 'ask-used-chip';
  if (!removable) chip.type = 'button';
  const label = document.createElement('span');
  label.textContent = `ref${index} · ${REFERENCE_TYPE_LABELS[ref.resourceType] || ref.resourceType} · ${ref.label || ''}`;
  chip.append(label);
  const open = (event) => {
    event.stopPropagation();
    openReferencePreview(ref, index);
  };
  if (removable) {
    chip.addEventListener('click', open);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `删除 ref${index}`);
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeReference(index);
    });
    chip.append(remove);
  } else {
    chip.addEventListener('click', open);
  }
  return chip;
}

function flashSourceTarget(node) {
  if (!node) return;
  node.classList.add('is-source-target');
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => node.classList.remove('is-source-target'), 1600);
}

function contentItemAsPost(item) {
  const provider = String(item.provider || '');
  const platform = provider === 'bilibili' || provider === 'x' ? provider : 'manual';
  return {
    id: item.externalId && platform !== 'manual' ? `${platform}:${item.externalId}` : item.id,
    resourceId: item.id,
    resourceType: 'content-item',
    live: true,
    platform,
    author: item.authorName || '',
    handle: '',
    title: item.title,
    body: item.body || item.summary || '无正文',
    tags: tagNames(taggingFor(item.id)?.tags || []),
    sourceUrl: item.sourceUrl || '',
    createdAt: item.publishedAt || item.createdAt || Date.now(),
  };
}

function findFeedPost(ref) {
  const id = String(ref.resourceId || '');
  return [...state.posts, ...state.xItems, ...state.bilibiliItems]
    .find((item) => item.resourceId === id || item.id === id) || null;
}

async function openContextRef(ref) {
  const type = String(ref?.resourceType || '');
  const id = String(ref?.resourceId || '').trim();
  if (!type || !id) {
    showToast('这条来源无法打开');
    return;
  }
  try {
    if (type === 'web-result') {
      if (!openExternalHttpUrl(id)) showToast('只能打开 http 或 https 链接');
      return;
    }
    if (type === 'holdings-board') {
      history.pushState({}, '', `${location.pathname}${location.search}#assets`);
      setView('assets');
      return;
    }
    if (type === 'market-board') {
      const hash = id === 'global' ? '#market/global' : '#market';
      history.pushState({}, '', `${location.pathname}${location.search}${hash}`);
      setView(hash.slice(1));
      return;
    }
    if (type === 'ai-run') {
      const payload = await api(`/api/v1/agent/records/${id}`);
      if (!payload.run?.sessionId) {
        showToast('找不到这条回答所在的会话');
        return;
      }
      openAskSession(payload.run.sessionId);
      return;
    }
    if (type === 'content-item') {
      const existing = findFeedPost(ref);
      if (existing) {
        openPost(existing);
        return;
      }
      const payload = await api(`/api/v1/content-items/${id}`);
      openPost(contentItemAsPost(payload.item));
      return;
    }
    if (type === 'post') {
      const existing = state.posts.find((item) => item.id === id) || findFeedPost(ref);
      if (existing) {
        openPost(existing);
        return;
      }
      const payload = await api(`/api/v1/posts/${id}`);
      openPost({ ...payload.post, resourceType: 'post', live: true, platform: 'manual' });
      return;
    }
    if (type === 'inspiration') {
      history.pushState({}, '', `${location.pathname}${location.search}#inspire`);
      setView('inspire');
      await loadNotes();
      state.expandedInspirationIds.clear();
      state.expandedInspirationIds.add(id);
      const card = document.querySelector(`[data-inspiration-id="${CSS.escape(id)}"]`);
      if (card) {
        setInspirationExpanded(id, true);
        flashSourceTarget(card);
        return;
      }
      const payload = await api(`/api/v1/notes/${id}`);
      openReferencePreview({
        resourceType: 'inspiration',
        resourceId: payload.note.id,
        label: payload.note.title || payload.note.body,
        preview: payload.note.body,
      });
      return;
    }
    if (type === 'knowledge-revision') {
      history.pushState({}, '', `${location.pathname}${location.search}#knowledge`);
      setView('knowledge');
      await loadKnowledge();
      const card = document.querySelector(`[data-knowledge-id="${CSS.escape(id)}"]`);
      if (card) {
        flashSourceTarget(card);
        return;
      }
      const payload = await api(`/api/v1/knowledge/documents/${encodeURIComponent(id)}`);
      openReferencePreview({
        resourceType: 'knowledge-revision',
        resourceId: payload.item.id,
        revision: payload.item.revision,
        label: payload.item.title,
        preview: payload.item.body,
      });
      return;
    }
    showToast('这类来源还不能跳转');
  } catch (error) {
    showToast(error.message || '来源打不开');
  }
}

function appendAskSourceFooter(card, footer) {
  if (!footer?.groups?.length) return;
  const section = document.createElement('section');
  section.className = 'ask-source-footer';
  section.append(Object.assign(document.createElement('span'), {
    className: 'ask-turn-label',
    textContent: '来源',
  }));
  for (const group of footer.groups) {
    const block = document.createElement('div');
    block.className = 'ask-source-group';
    block.append(Object.assign(document.createElement('small'), { textContent: group.label }));
    const list = document.createElement('div');
    list.className = 'ask-source-list';
    for (const item of group.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ask-source-chip';
      const typeName = REFERENCE_TYPE_LABELS[item.resourceType] || item.resourceType;
      button.textContent = item.selected
        ? `${typeName} · ${item.label} · 你指定`
        : `${typeName} · ${item.label}`;
      button.addEventListener('click', () => openContextRef(item));
      list.append(button);
    }
    block.append(list);
    section.append(block);
  }
  if (footer.extraCount) {
    section.append(Object.assign(document.createElement('p'), {
      className: 'ask-source-more',
      textContent: `另有 ${footer.extraCount} 条检索命中未展开`,
    }));
  }
  card.append(section);
}

function renderAskRefChips() {
  const host = elements['ask-ref-chips'];
  if (!host) return;
  host.replaceChildren(...state.referenceDraft.map((ref, index) => createRefChip(ref, index, { removable: true })));
  host.classList.toggle('hidden', !state.referenceDraft.length);
}

function renderReferenceDock() {
  const dock = elements['reference-dock'];
  if (!dock) return;
  const count = state.referenceDraft.length;
  dock.textContent = `引用 ${count} 项`;
  dock.classList.toggle('hidden', count === 0);
}

function renderReferenceUi() {
  renderAskRefChips();
  renderReferenceDock();
}

function mentionQueryAt(value, caret) {
  const text = String(value || '');
  const index = Number.isInteger(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length;
  const before = text.slice(0, index);
  const match = before.match(/(^|[\s，。；;,.!?])@([^\s@]*)$/u);
  if (!match) return null;
  const query = match[2];
  return { start: index - query.length - 1, end: index, query };
}

function hideAskMentions() {
  state.mentionItems = [];
  state.mentionIndex = 0;
  state.mentionRange = null;
  const menu = elements['ask-mention-menu'];
  if (!menu) return;
  menu.replaceChildren();
  menu.classList.add('hidden');
}

function renderAskMentions() {
  const menu = elements['ask-mention-menu'];
  if (!menu) return;
  if (!state.mentionRange) {
    hideAskMentions();
    return;
  }
  const items = state.mentionItems;
  menu.classList.remove('hidden');
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'ask-mention-empty';
    empty.textContent = state.mentionRange.query ? '没有匹配的本地知识' : '还没有可引用的分析框架或知识';
    menu.replaceChildren(empty);
    return;
  }
  menu.replaceChildren(...items.map((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ask-mention-item${index === state.mentionIndex ? ' is-active' : ''}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', index === state.mentionIndex ? 'true' : 'false');
    const title = document.createElement('strong');
    title.textContent = item.label;
    const meta = document.createElement('small');
    meta.textContent = [MENTION_KIND_LABELS[item.kind] || item.kind, item.preview].filter(Boolean).join(' · ');
    button.append(title, meta);
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      applyAskMention(item);
    });
    return button;
  }));
}

let mentionRequest = 0;
async function refreshAskMentions(range) {
  const requestId = mentionRequest + 1;
  mentionRequest = requestId;
  state.mentionRange = range;
  try {
    const query = encodeURIComponent(range.query || '');
    const payload = await api(`/api/v1/knowledge/mentions?q=${query}&limit=8`);
    if (mentionRequest !== requestId) return;
    state.mentionItems = payload.items || [];
    state.mentionIndex = 0;
    renderAskMentions();
  } catch (error) {
    if (mentionRequest !== requestId) return;
    hideAskMentions();
    showToast(error.message);
  }
}

function applyAskMention(item) {
  const input = elements['ask-form']?.elements?.question;
  const range = state.mentionRange;
  if (!input || !range) return;
  if (!addReference({
    resourceType: item.resourceType,
    resourceId: item.resourceId,
    revision: item.revision,
    label: item.label,
    preview: item.preview,
  })) return;
  const token = `@${String(item.label || '').replace(/\s+/g, '')} `;
  input.value = `${input.value.slice(0, range.start)}${token}${input.value.slice(range.end)}`;
  const caret = range.start + token.length;
  input.setSelectionRange(caret, caret);
  hideAskMentions();
  input.focus();
}

function onAskComposerInput() {
  const input = elements['ask-form']?.elements?.question;
  if (!input || state.askSubmitting) {
    hideAskMentions();
    return;
  }
  const range = mentionQueryAt(input.value, input.selectionStart);
  if (!range) {
    hideAskMentions();
    return;
  }
  refreshAskMentions(range);
}

function onAskComposerKeydown(event) {
  const menu = elements['ask-mention-menu'];
  if (!menu || menu.classList.contains('hidden') || !state.mentionItems.length) {
    if (event.key === 'Escape') hideAskMentions();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    state.mentionIndex = (state.mentionIndex + 1) % state.mentionItems.length;
    renderAskMentions();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    state.mentionIndex = (state.mentionIndex - 1 + state.mentionItems.length) % state.mentionItems.length;
    renderAskMentions();
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    applyAskMention(state.mentionItems[state.mentionIndex]);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    hideAskMentions();
  }
}

function createCiteButton(ref) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-button post-cite${isReferenced(ref) ? ' is-cited' : ''}`;
  button.setAttribute('aria-label', isReferenced(ref) ? '已加入引用' : '引用到问答');
  const markup = icon('corner-up-right');
  if (markup) button.innerHTML = markup;
  else button.textContent = '↗';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleReference(ref);
  });
  return button;
}

function looksLikeMarkdown(value) {
  return /(^|\n)#{1,3}\s+\S|(^|\n)[-*]\s+\S|(^|\n)\d+\.\s+\S/.test(String(value || ''));
}

const FEED_TITLE_MAX = 72;
const FEED_EXCERPT_MAX = 96;

function plainFeedText(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipFeedText(value, max) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}

function firstFeedSentence(value) {
  const text = plainFeedText(value);
  if (!text) return '';
  const take = (source) => source.match(/^.+?(?:[。！？]|[.!?](?:\s|$)|…)/)?.[0]?.trim() || source;
  let first = take(text);
  if (first.length < 12) {
    const rest = text.slice(first.length).trim();
    if (rest) first = `${first} ${take(rest)}`.replace(/\s+/g, ' ').trim();
  }
  return first;
}

function textAfterLead(source, lead) {
  const plain = plainFeedText(source);
  const head = plainFeedText(lead).replace(/[.…]+$/u, '');
  if (!plain) return '';
  if (!head) return plain;
  if (plain === head || plain === plainFeedText(lead)) return '';
  if (plain.startsWith(head)) return plain.slice(head.length).replace(/^[\s.。…]+/u, '');
  return plain;
}

function postDisplayTitle(post) {
  const translated = translationFor(post)?.text;
  if (translated) return clipFeedText(firstFeedSentence(translated) || plainFeedText(translated), FEED_TITLE_MAX);
  const title = String(post?.title || '').trim();
  if (title) return title;
  return clipFeedText(plainFeedText(post?.body), FEED_TITLE_MAX) || '无标题';
}

function postListExcerpt(post) {
  const translated = translationFor(post)?.text;
  if (translated) return clipFeedText(textAfterLead(translated, postDisplayTitle(post)), FEED_EXCERPT_MAX);
  return clipFeedText(textAfterLead(post?.body, post?.title), FEED_EXCERPT_MAX);
}

function fillPostBody(element, value) {
  const text = String(value || '无正文');
  if (looksLikeMarkdown(text)) {
    element.classList.add('post-markdown');
    renderMarkdownInto(element, text);
    return;
  }
  element.classList.remove('post-markdown');
  element.textContent = text;
}

function feedAsItem(item, platform) {
  return {
    id: item.id,
    resourceId: item.resourceId || '',
    resourceType: 'content-item',
    live: true,
    platform,
    author: item.authorName || item.authorHandle || (platform === 'bilibili' ? 'B站' : 'X'),
    handle: item.authorHandle || '',
    time: item.publishedAt ? formatTime(item.publishedAt) : '',
    title: item.title,
    body: item.body || item.summary || '无正文',
    tags: tagNames(taggingFor(item.resourceId)?.tags || []),
    sourceUrl: item.sourceUrl,
    processing: item.processing || '',
    following: false,
    createdAt: item.capturedAt || item.publishedAt || Date.now(),
    translation: item.translation || null,
  };
}

function xAsItem(item) {
  return feedAsItem(item, 'x');
}

function bilibiliAsItem(item) {
  return feedAsItem(item, 'bilibili');
}

function hydrateFeedTranslations(items) {
  for (const item of items || []) {
    if (!item?.id || !item.translation?.text) continue;
    rememberTranslation({ id: item.id, body: item.body || item.summary || '' }, {
      text: item.translation.text,
      engine: item.translation.engine || '',
      cached: true,
    });
  }
}

async function syncLocalTranslationsToServer(items) {
  if (!state.session) return;
  const translations = [];
  for (const item of items || []) {
    if (item?.translation?.text) continue;
    const post = xAsItem(item);
    const local = translationFor(post);
    if (!local?.text) continue;
    translations.push({
      id: post.id,
      sourceText: post.body || '',
      translatedText: local.text,
      engine: local.engine || '',
      targetLang: 'zh',
    });
  }
  const chunkSize = 200;
  for (let offset = 0; offset < translations.length; offset += chunkSize) {
    try {
      await api('/api/v1/feed/translations', {
        method: 'POST',
        body: JSON.stringify({ translations: translations.slice(offset, offset + chunkSize) }),
      });
    } catch {
      break;
    }
  }
}

function matchesPlatform(item) {
  return state.platform === 'all' || item.platform === state.platform;
}

function visibleFeedItems() {
  const live = state.posts.map(liveAsItem).filter(matchesPlatform);
  const xItems = state.xItems.map(xAsItem).filter(matchesPlatform);
  const bilibiliItems = state.bilibiliItems.map(bilibiliAsItem).filter(matchesPlatform);
  const demo = feedItems.filter((item) => {
    if (item.platform === 'x' && state.xItems.length) return false;
    if (item.platform === 'bilibili' && state.bilibiliItems.length) return false;
    return matchesPlatform(item) && (state.channel === 'all' || item.following);
  });
  const items = state.channel === 'following' ? demo : [...bilibiliItems, ...xItems, ...live, ...demo];
  return items
    .filter((item) => !state.hiddenFeedIds.has(item.id) && !state.hiddenFeedIds.has(item.resourceId))
    .sort((left, right) => (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0));
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
      resetFeedWindow();
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
    resetFeedWindow();
    renderPlatformFilters();
    renderXToolbar();
    renderBilibiliToolbar();
    renderPosts();
    if (id === 'x' && !state.xItems.length && !state.xLoading) {
      loadXFeed({ refresh: false }).catch((error) => showToast(error.message));
    }
    if (id === 'bilibili' && !state.bilibiliItems.length && !state.bilibiliLoading) {
      loadBilibiliFeed().catch((error) => showToast(error.message));
    }
  });
}

function renderXToolbar() {
  const toolbar = elements['x-toolbar'];
  if (toolbar) toolbar.classList.toggle('hidden', state.platform !== 'x');
  if (elements['x-feed-status']) {
    elements['x-feed-status'].textContent = state.xLoading
      ? (state.xRefreshing ? '正在用已登录浏览器拉取最多 50 条…' : '正在读取已缓存来源…')
      : (state.xNote || '点拉取会写入 SourceAccount，并按推文 ID 去重保留。');
  }
  if (elements['x-feed-tabs']) {
    renderChipTabs(elements['x-feed-tabs'], [
      { id: 'for-you', label: '为你推荐' },
      { id: 'following', label: '正在关注' },
    ], state.xFeed, (id) => {
      state.xFeed = id;
      renderXToolbar();
    });
  }
  const pending = pendingXTranslations().length;
  const pendingTags = pendingXTaggings().length;
  const busy = state.xLoading || state.xTranslating || state.xTagging;
  const showTranslate = state.platform === 'x' || (state.platform === 'all' && state.xItems.length > 0);
  if (elements['x-translate-bar']) {
    elements['x-translate-bar'].classList.toggle('hidden', !showTranslate);
  }
  if (elements['x-refresh']) {
    elements['x-refresh'].classList.toggle('hidden', state.platform !== 'x');
    elements['x-refresh'].disabled = busy;
    elements['x-refresh'].textContent = state.xRefreshing ? '拉取中…' : '拉取 50 条';
  }
  if (elements['x-translate-status']) {
    elements['x-translate-status'].textContent = state.xTagging
      ? '正在给尚未标注的信息流打 Tag，走 Worker 豆包队列…'
      : state.xTranslating
        ? '正在翻译最新的非中文推文…'
        : (pending
          ? `有 ${pending} 条非中文推文待翻译，从最新开始一次最多 30 条。${pendingTags ? `另有 ${pendingTags} 条待打 Tag。` : ''}`
          : (pendingTags ? `非中文推文都已翻译。有 ${pendingTags} 条待打 Tag。` : '非中文推文都已翻译，当前条目标注也已齐。'));
  }
  if (elements['x-translate']) {
    elements['x-translate'].disabled = busy || pending === 0;
    elements['x-translate'].textContent = state.xTranslating
      ? '翻译中…'
      : (pending ? `翻译 ${pending} 条` : '已全部翻译');
  }
  if (elements['x-tag']) {
    elements['x-tag'].disabled = busy || pendingTags === 0;
    elements['x-tag'].textContent = state.xTagging
      ? '标注中…'
      : (pendingTags ? `打 Tag ${pendingTags} 条` : '已全部标注');
  }
}

function renderBilibiliToolbar() {
  const toolbar = elements['bilibili-toolbar'];
  if (toolbar) toolbar.classList.toggle('hidden', state.platform !== 'bilibili');
  if (elements['bilibili-feed-status']) {
    elements['bilibili-feed-status'].textContent = state.bilibiliLoading
      ? '正在用已登录浏览器读取 AI 中文字幕…'
      : (state.bilibiliNote || '贴链接后只抓 ai-zh。没有 AI 中文字幕就返回没有。');
  }
  if (elements['bilibili-import']) {
    elements['bilibili-import'].disabled = state.bilibiliLoading;
    elements['bilibili-import'].textContent = state.bilibiliLoading ? '拉取中…' : '拉取字幕';
  }
}

function resetFeedWindow() {
  state.feedShown = FEED_PAGE_SIZE;
  state.feedAnchorId = '';
  viewScrollY.feed = 0;
  if (document.body.dataset.view === 'feed' && !document.body.classList.contains('is-dialog-open')) {
    window.scrollTo(0, 0);
  }
}

function revealMoreFeed() {
  const total = visibleFeedItems().length;
  if (state.feedShown >= total) return;
  state.feedShown = Math.min(total, state.feedShown + FEED_PAGE_SIZE);
  renderPosts();
}

function observeFeedSentinel(node, canLoad) {
  feedObserver?.disconnect();
  feedObserver = null;
  if (!canLoad || !node) return;
  feedObserver = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    if (document.body.classList.contains('is-dialog-open')) return;
    if (document.body.dataset.view !== 'feed') return;
    revealMoreFeed();
  }, { rootMargin: '320px 0px' });
  feedObserver.observe(node);
}

function renderPosts() {
  const items = visibleFeedItems();
  if (state.feedShown > items.length) state.feedShown = Math.max(FEED_PAGE_SIZE, items.length);
  const shown = items.slice(0, state.feedShown);
  const keepY = document.body.dataset.view === 'feed'
    && !document.body.classList.contains('is-dialog-open')
    && !restoringViewScroll
    ? window.scrollY
    : null;
  elements.feed.replaceChildren();
  elements['feed-count'].textContent = items.length > shown.length
    ? `已显示 ${shown.length} / ${items.length} 条`
    : `${items.length} 条`;
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = state.channel === 'following'
      ? '还没有关注对象的内容。添加账号后会出现在这里。'
      : '这个筛选下还没有信息。';
    elements.feed.append(empty);
    observeFeedSentinel(null, false);
    return;
  }
  for (const post of shown) {
    const row = document.createElement('div');
    row.className = 'swipe-item feed-swipe-item';
    const actionsRow = document.createElement('div');
    actionsRow.className = 'swipe-actions swipe-actions-single';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'swipe-delete';
    remove.textContent = '删除';
    remove.addEventListener('pointerdown', (event) => event.stopPropagation());
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      hideFeedItem(post).catch((error) => showToast(error.message));
    });
    actionsRow.append(remove);

    const card = document.createElement('article');
    card.className = 'post-card is-compact swipe-front';
    card.dataset.postId = post.id;
    const head = document.createElement('div');
    head.className = 'post-card-head';
    const meta = document.createElement('div');
    meta.className = 'post-meta';
    const avatar = document.createElement('span');
    avatar.className = 'post-author';
    avatar.textContent = post.author.slice(0, 1);
    const author = document.createElement('span');
    author.className = 'post-identity';
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
    const actions = document.createElement('div');
    actions.className = 'post-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = `icon-button post-save${isPostSaved(post) ? ' is-saved' : ''}`;
    save.setAttribute('aria-label', isPostSaved(post) ? '已加入灵感' : '收藏到灵感');
    save.innerHTML = icon(isPostSaved(post) ? 'bookmark-check' : 'bookmark');
    save.addEventListener('click', (event) => {
      event.stopPropagation();
      savePostToInspiration(post).catch((error) => showToast(error.message));
    });
    actions.append(save, createCiteButton({
      resourceType: post.resourceType || (post.live && post.platform !== 'manual' ? 'content-item' : 'post'),
      resourceId: post.resourceId || (post.platform === 'manual' ? post.id : ''),
      label: postDisplayTitle(post),
      preview: translationFor(post)?.text || post.body,
    }));
    head.append(meta, actions);
    const title = document.createElement('h3');
    title.textContent = postDisplayTitle(post);
    card.append(head, title);
    const excerpt = postListExcerpt(post);
    if (excerpt) {
      const preview = document.createElement('p');
      preview.className = translationFor(post) ? 'post-excerpt is-translated' : 'post-excerpt';
      preview.textContent = excerpt;
      card.append(preview);
    }
    attachSwipe(card, FEED_SWIPE_WIDTH, () => openPost(post));
    row.append(actionsRow, card);
    elements.feed.append(row);
  }
  const more = document.createElement('div');
  more.className = 'feed-more';
  more.id = 'feed-sentinel';
  const canLoad = shown.length < items.length;
  more.dataset.done = canLoad ? '0' : '1';
  more.textContent = canLoad ? '下滑显示更多' : '已经到底了';
  elements.feed.append(more);
  observeFeedSentinel(more, canLoad);
  if (keepY !== null) window.scrollTo(0, keepY);
  renderXToolbar();
  renderBilibiliToolbar();
  if (document.body.dataset.view === 'sources') renderHub();
}

function syncDialogTranslation(post) {
  const translation = translationFor(post);
  const box = elements['dialog-translation'];
  if (box) {
    box.textContent = translation?.text || '';
    box.classList.toggle('hidden', !translation?.text);
  }
  elements['post-dialog']?.classList.toggle('has-translation', Boolean(translation?.text));
  if (elements['dialog-translate']) {
    elements['dialog-translate'].classList.toggle('hidden', !post.body);
    elements['dialog-translate'].textContent = translateActionLabel(post);
  }
}

function openPost(post) {
  state.dialogPost = post;
  const live = state.posts.find((item) => item.id === post.id);
  const xItem = state.xItems.find((item) => item.id === post.id);
  const bilibiliItem = state.bilibiliItems.find((item) => item.id === post.id);
  const payload = live || {
    id: post.id,
    title: post.title,
    body: post.body,
    tags: post.tags || [],
    sourceUrl: post.sourceUrl || '',
    createdAt: post.createdAt || Date.now(),
  };
  elements['dialog-title'].textContent = payload.title;
  fillPostBody(elements['dialog-body'], payload.body || '无正文');
  syncDialogTranslation(post);
  elements['dialog-tags'].replaceChildren(...(payload.tags || []).map((tag) => {
    const chip = document.createElement('span');
    chip.textContent = tag;
    return chip;
  }));
  elements['dialog-source'].classList.toggle('hidden', !payload.sourceUrl);
  elements['dialog-time'].textContent = live
    ? `发布于 ${new Date(payload.createdAt).toLocaleString('zh-CN')}`
    : xItem
      ? `X 公开时间线 · ${new Date(payload.createdAt).toLocaleString('zh-CN')}`
      : bilibiliItem
        ? `B站 AI 字幕 · ${new Date(payload.createdAt).toLocaleString('zh-CN')}`
        : post.processing
          ? '示例卡片：字幕或 AI 完成后会更新，不阻塞信息流'
          : '示例内容，用于确认信息架构，尚未写入本地数据库';
  state.feedRestoreId = String(post.id || '');
  openDialog(elements['post-dialog']);
  if (live) logBehavior('post.opened', { postId: payload.id });
}

function renderTradeTabs() {
  const view = document.body.dataset.view;
  const tabs = view === 'assets' ? bookTabs : marketTabs;
  const target = view === 'assets' ? elements['book-tabs'] : elements['market-tabs'];
  if (!target) return;
  target.replaceChildren(...tabs.map((tab) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `text-tab${tab.id === state.tradePane ? ' is-active' : ''}`;
    button.textContent = tab.label;
    button.addEventListener('click', () => setTradePane(tab.id));
    return button;
  }));
}

function tradeHint(id) {
  if (id === 'analysis') return '个人资产分析：读取本地收支草记的资产明细和分红所得，结构与原资产大屏一致。';
  if (id === 'holdings') return '持仓来自本地批次账本。首页看 A 股 / B 股今日；点进去看该组日周年变化。';
  return '';
}

function setTradeHint(text) {
  const el = document.body.dataset.view === 'assets' ? elements['book-sync-hint'] : elements['market-sync-hint'];
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

function isQuotesView(view = document.body.dataset.view) {
  return view === 'market' || view === 'assets';
}

function alignTradePane(view = document.body.dataset.view) {
  if (view === 'assets' && !['holdings', 'analysis'].includes(state.tradePane)) state.tradePane = 'holdings';
  if (view === 'market' && !['stocks', 'assets'].includes(state.tradePane)) state.tradePane = 'stocks';
  document.querySelectorAll('[data-trade-pane]').forEach((pane) => {
    pane.classList.toggle('is-active', pane.dataset.tradePane === state.tradePane);
  });
}

function setTradePane(id) {
  if (id !== 'holdings') state.holdingsMoveGroup = null;
  state.tradePane = id;
  alignTradePane();
  setTradeHint(tradeHint(id));
  renderTradeTabs();
  syncTradePaneData().catch((error) => showToast(error.message));
}

async function syncTradePaneData() {
  if (state.tradePane === 'stocks') {
    await loadMarket();
    return;
  }
  if (state.tradePane === 'assets') {
    await loadGlobalAssets();
    return;
  }
  if (state.tradePane === 'analysis') await loadPersonalAssets();
  if (state.tradePane === 'holdings') await loadHoldings();
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
  const board = state.holdingsBoard;
  const lines = board?.summary?.lines || [
    { id: 'a_share', label: 'A股' },
    { id: 'b_sh', label: 'B股沪市' },
    { id: 'b_sz', label: 'B股深市' },
  ];
  for (const line of lines) {
    const row = document.createElement('article');
    row.className = 'holdings-line';
    const title = document.createElement('h3');
    title.textContent = line.label;
    const metrics = document.createElement('div');
    metrics.className = 'holdings-line-metrics';
    metrics.append(
      holdingsLineMetric('股票', line.stockCny, line.listingCurrency === 'CNY' ? null : line.stockListing, line.listingCurrency),
      holdingsLineMetric('现金', line.cashCny, line.listingCurrency === 'CNY' ? null : line.cashListing, line.listingCurrency),
      holdingsLineMetric('合计', line.totalCny, line.listingCurrency === 'CNY' ? null : line.totalListing, line.listingCurrency),
    );
    const pnl = holdingsLinePnl(line.id);
    if (pnl) {
      metrics.append(
        holdingsSignedMetric('当日', pnl.day),
        holdingsSignedMetric('浮动', pnl.unrealized),
      );
    }
    row.append(title, metrics);
    target.append(row);
  }
  if (board?.summary?.totalCny) {
    const total = document.createElement('p');
    total.className = 'holdings-lines-total';
    total.append(Object.assign(document.createElement('span'), { textContent: '总资产' }));
    total.append(Object.assign(document.createElement('strong'), { textContent: `¥${formatMoneyAmount(board.summary.totalCny, 2)}` }));
    target.append(total);
  }
}

function holdingsLineBoards(lineId) {
  if (lineId === 'a_share') return ['a_share', 'hk_connect'];
  if (lineId === 'b_sh') return ['b_sh'];
  if (lineId === 'b_sz') return ['b_sz'];
  return [];
}

function holdingsLinePnl(lineId) {
  const boards = holdingsLineBoards(lineId);
  const rows = (state.holdingsBoard?.positions || []).filter((item) => boards.includes(item.board));
  if (!rows.length) return null;
  return {
    day: rows.reduce((sum, item) => sum + moneyNumber(item.dayPnlCny), 0),
    unrealized: rows.reduce((sum, item) => sum + moneyNumber(item.positionPnlCny), 0),
  };
}

function holdingsSignedMetric(label, value) {
  const item = document.createElement('div');
  item.className = 'holdings-line-metric';
  const strong = document.createElement('strong');
  const number = moneyNumber(value);
  strong.className = number >= 0 ? 'up' : 'down';
  strong.textContent = formatSignedAmount(number);
  const caption = document.createElement('span');
  caption.textContent = label;
  item.append(strong, caption);
  return item;
}

function holdingsLineMetric(label, cny, nativeAmount, nativeCurrency) {
  const item = document.createElement('div');
  item.className = 'holdings-line-metric';
  const strong = document.createElement('strong');
  strong.textContent = cny == null ? '--' : `¥${formatMoneyAmount(cny, 2)}`;
  const caption = document.createElement('span');
  caption.textContent = label;
  item.append(strong);
  if (nativeAmount != null && nativeCurrency && nativeCurrency !== 'CNY') {
    const native = document.createElement('small');
    native.textContent = formatNativeAmount(nativeAmount, nativeCurrency);
    item.append(native);
  }
  item.append(caption);
  return item;
}

function formatNativeAmount(value, currency) {
  const amount = formatMoneyAmount(value, 2);
  if (currency === 'USD') return `USD ${amount}`;
  if (currency === 'HKD') return `HKD ${amount}`;
  return `${currency} ${amount}`;
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

function formatSignedAmount(value) {
  const number = moneyNumber(value);
  const text = formatMoneyAmount(Math.abs(number), 2);
  if (number > 0) return `+${text}`;
  if (number < 0) return `-${text}`;
  return text;
}

function formatHoldingsClock(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

const holdingFilters = [
  { id: 'all', label: '全部' },
  { id: 'a_share', label: 'A股' },
  { id: 'hk_connect', label: '港股通' },
  { id: 'b_sh', label: 'B股沪' },
  { id: 'b_sz', label: 'B股深' },
];

const boardLabels = {
  a_share: 'A股',
  hk_connect: '港股通',
  b_sh: 'B股沪 · USD',
  b_sz: 'B股深 · HKD',
};

const holdingSortColumns = [
  { id: 'marketValueCny', label: '名称/市值', className: 'holdings-name' },
  { id: 'quantity', label: '持仓数', className: 'holdings-qty' },
  { id: 'costCny', label: '现价/成本', className: 'holdings-px' },
  { id: 'dayPnlCny', label: '当日盈亏', className: 'holdings-day' },
  { id: 'positionPnlPct', label: '盈亏比', className: 'holdings-pct' },
  { id: 'positionPnlCny', label: '盈亏', className: 'holdings-pnl' },
];

function setHoldingsSort(key) {
  if (state.holdingsSort === key) {
    state.holdingsSortDir = state.holdingsSortDir === 'desc' ? 'asc' : 'desc';
  } else {
    state.holdingsSort = key;
    state.holdingsSortDir = 'desc';
  }
  renderHoldings();
}

function sortHoldingRows(rows) {
  const key = state.holdingsSort;
  const dir = state.holdingsSortDir === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const delta = moneyNumber(left[key]) - moneyNumber(right[key]);
    if (delta !== 0) return delta * dir;
    return moneyNumber(right.marketValueCny) - moneyNumber(left.marketValueCny);
  });
}

function renderHoldingsHead() {
  const target = elements['holdings-head'];
  if (!target) return;
  target.replaceChildren(...holdingSortColumns.map((column) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `holdings-sort ${column.className}${state.holdingsSort === column.id ? ' is-active' : ''}`;
    const arrow = state.holdingsSort === column.id ? (state.holdingsSortDir === 'desc' ? ' ↓' : ' ↑') : '';
    button.textContent = `${column.label}${arrow}`;
    button.addEventListener('click', () => setHoldingsSort(column.id));
    return button;
  }));
}

function createHoldingsMoveCard(move, { title, caption, onOpen } = {}) {
  const up = moneyNumber(move.pnlCny) >= 0;
  const card = document.createElement(onOpen ? 'button' : 'article');
  if (onOpen) card.type = 'button';
  card.className = `holdings-move${onOpen ? '' : ' is-static'}`;
  const heading = document.createElement('h3');
  heading.textContent = title || move.label || '今日';
  const strong = document.createElement('strong');
  strong.className = move.pnlCny == null ? '' : (up ? 'up' : 'down');
  strong.textContent = move.pnlCny == null ? '--' : `${formatSignedAmount(move.pnlCny)}  ${move.pnlPct == null ? '' : formatPct(up, moneyNumber(move.pnlPct) * 100)}`.trim();
  const sample = document.createElement('small');
  if (move.samplePnlCny == null) sample.textContent = `${move.sampleLabel || '对照'}暂无采样`;
  else {
    const sampleUp = moneyNumber(move.samplePnlCny) >= 0;
    let text = `${move.sampleLabel} ${formatSignedAmount(move.samplePnlCny)} ${formatPct(sampleUp, moneyNumber(move.samplePnlPct) * 100)}`;
    if (move.sampleAddedPnlCny != null) {
      const addedUp = moneyNumber(move.sampleAddedPnlCny) >= 0;
      text += ` · 新买入 ${formatSignedAmount(move.sampleAddedPnlCny)} ${formatPct(addedUp, moneyNumber(move.sampleAddedPnlPct) * 100)}`;
    }
    sample.textContent = text;
  }
  card.append(heading, strong);
  if (move.addedPnlCny != null) {
    const added = document.createElement('small');
    const addedUp = moneyNumber(move.addedPnlCny) >= 0;
    added.className = addedUp ? 'up' : 'down';
    added.textContent = `新买入 ${formatSignedAmount(move.addedPnlCny)} ${move.addedPnlPct == null ? '' : formatPct(addedUp, moneyNumber(move.addedPnlPct) * 100)}`.trim();
    card.append(added);
  }
  card.append(sample);
  const note = document.createElement('span');
  note.textContent = caption || (move.backcast
    ? '原持仓波动 · 导入仓按现仓回算，未扣转入本金'
    : '原持仓波动');
  card.append(note);
  if (onOpen) card.addEventListener('click', onOpen);
  return card;
}

function renderHoldingsMoves() {
  const target = elements['holdings-moves'];
  if (!target) return;
  const groups = state.holdingsBoard?.moveGroups || [
    { id: 'a_share', label: 'A股', moves: [{ id: 'day' }] },
    { id: 'b_share', label: 'B股', moves: [{ id: 'day' }] },
  ];
  target.replaceChildren(...groups.map((group) => {
    const day = (group.moves || []).find((item) => item.id === 'day') || {};
    return createHoldingsMoveCard(day, {
      title: `${group.label}今日`,
      caption: '当日盈亏按现价对昨收，对齐券商「当日」；点开再看周 / 月市值波动',
      onOpen: () => {
        state.holdingsMoveGroup = group.id;
        renderHoldings();
      },
    });
  }));
}

function renderHoldingsGroupDetail() {
  const group = (state.holdingsBoard?.moveGroups || []).find((item) => item.id === state.holdingsMoveGroup);
  const title = elements['holdings-group-title'];
  const target = elements['holdings-group-moves'];
  if (title) title.textContent = `${group?.label || '持仓'}资产变化`;
  if (!target) return;
  const moves = group?.moves || [
    { id: 'day', label: '今日' },
    { id: 'week', label: '本周' },
    { id: 'month', label: '本月' },
  ];
  target.replaceChildren(...moves.map((move) => createHoldingsMoveCard(move)));
}

function renderHoldings() {
  const showingDetail = Boolean(state.holdingsMoveGroup);
  elements['holdings-overview']?.classList.toggle('hidden', showingDetail);
  elements['holdings-group-detail']?.classList.toggle('hidden', !showingDetail);
  if (showingDetail) renderHoldingsGroupDetail();
  renderChipTabs(elements['holdings-filters'], holdingFilters, state.holdingsMarket, (id) => {
    state.holdingsMarket = id;
    renderHoldings();
  });
  renderPortfolioSummary();
  renderHoldingsMoves();
  renderHoldingsHead();
  const note = elements['holdings-note'];
  const refresh = elements['holdings-refresh'];
  if (refresh) {
    refresh.disabled = state.holdingsLoading;
    refresh.textContent = state.holdingsRefreshing ? '刷新中…' : '刷新行情';
  }
  if (note) {
    if (state.holdingsLoading) note.textContent = state.holdingsRefreshing ? '正在向行情源拉取最新报价，并跳过本地缓存…' : '正在读取持仓和实时汇率…';
    else if (state.holdingsError) note.textContent = state.holdingsError;
    else {
      const base = state.holdingsBoard?.note || '持仓批次落在本地账本，价格和汇率实时刷新。';
      const updated = formatHoldingsClock(state.holdingsBoard?.updatedAt);
      note.textContent = updated ? `${base} 报价 ${updated}` : base;
    }
  }
  const rows = sortHoldingRows((state.holdingsBoard?.positions || []).filter((item) => (
    state.holdingsMarket === 'all' || item.board === state.holdingsMarket
  )));
  elements['holdings-list'].replaceChildren(...rows.map((item) => {
    const up = moneyNumber(item.positionPnlCny) >= 0;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quote-row holdings-row';
    const name = document.createElement('span');
    name.className = 'quote-identity holdings-name';
    const valueText = item.marketValueCny == null ? '--' : `¥${formatMoneyAmount(item.marketValueCny, 0)}`;
    const code = document.createElement('small');
    code.className = 'quote-code';
    code.append(
      Object.assign(document.createElement('span'), {
        className: 'holdings-qty-inline',
        textContent: `${formatMoneyAmount(item.quantity, 0)} · `,
      }),
      document.createTextNode(valueText),
    );
    name.append(
      Object.assign(document.createElement('strong'), { className: 'quote-name', textContent: item.name }),
      code,
    );
    const qty = document.createElement('span');
    qty.className = 'holdings-qty';
    qty.textContent = formatMoneyAmount(item.quantity, 0);
    const price = document.createElement('span');
    price.className = `holdings-px ${up ? 'up' : 'down'}`;
    price.append(
      Object.assign(document.createElement('strong'), {
        textContent: item.lastPrice == null ? '无行情' : item.lastPrice,
      }),
      Object.assign(document.createElement('small'), { textContent: item.costPrice }),
    );
    const dayUp = moneyNumber(item.dayPnlCny) >= 0;
    const day = document.createElement('span');
    day.className = `holdings-day ${item.dayPnlCny == null ? '' : (dayUp ? 'up' : 'down')}`.trim();
    day.append(
      Object.assign(document.createElement('strong'), {
        textContent: item.dayPnlPct == null ? '--' : formatPct(dayUp, moneyNumber(item.dayPnlPct) * 100),
      }),
      Object.assign(document.createElement('small'), {
        textContent: item.dayPnlCny == null ? '--' : formatSignedAmount(item.dayPnlCny),
      }),
      Object.assign(document.createElement('small'), {
        className: `holdings-total ${up ? 'up' : 'down'}`,
        textContent: item.positionPnlCny == null ? '总 --' : `总 ${formatSignedAmount(item.positionPnlCny)}`,
      }),
    );
    const pct = document.createElement('span');
    pct.className = `holdings-pct ${up ? 'up' : 'down'}`;
    pct.textContent = item.positionPnlPct == null ? '--' : formatPct(up, moneyNumber(item.positionPnlPct) * 100);
    const pnl = document.createElement('span');
    pnl.className = `quote-change holdings-pnl ${up ? 'up' : 'down'}`;
    pnl.textContent = item.positionPnlCny == null ? '--' : formatSignedAmount(item.positionPnlCny);
    button.append(name, qty, price, day, pct, pnl);
    button.addEventListener('click', () => openHolding(item));
    return button;
  }));
}

function openHolding(item) {
  elements['holding-title'].textContent = item.name;
  elements['holding-meta'].textContent = `${item.symbol} · ${boardLabels[item.board]} · 报价货币 ${item.listingCurrency}`;
  const metrics = elements['holding-metrics'];
  metrics.replaceChildren();
  appendMetric(metrics, '现价', item.lastPrice || '无行情');
  appendMetric(metrics, '成本', item.costPrice);
  appendMetric(metrics, `市值 ${item.listingCurrency}`, item.marketValueListing || '--');
  appendMetric(metrics, '市值 CNY', formatMoneyAmount(item.marketValueCny, 2));
  appendMetric(metrics, '浮动盈亏', formatMoneyAmount(item.positionPnlCny, 2), moneyNumber(item.positionPnlCny) >= 0 ? 'up' : 'down');
  appendMetric(metrics, '当日盈亏', formatMoneyAmount(item.dayPnlCny, 2), moneyNumber(item.dayPnlCny) >= 0 ? 'up' : 'down');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'text-button';
  remove.textContent = '从账本删除';
  remove.addEventListener('click', async () => {
    await api(`/api/v1/holdings/lots/${encodeURIComponent(item.lotId)}`, { method: 'DELETE' });
    elements['holding-dialog'].close();
    await loadHoldings();
  });
  elements['ledger-list'].replaceChildren(remove);
  openDialog(elements['holding-dialog']);
}

async function loadHoldings({ refresh = false } = {}) {
  state.holdingsLoading = true;
  state.holdingsRefreshing = refresh;
  renderHoldings();
  try {
    const path = refresh ? '/api/v1/holdings?refresh=1' : '/api/v1/holdings';
    const payload = await api(path, { timeoutMs: 35_000 });
    state.holdingsBoard = payload.holdings;
    state.holdingsError = '';
  } catch (error) {
    state.holdingsError = error instanceof Error ? error.message : '持仓加载失败';
  } finally {
    state.holdingsLoading = false;
    state.holdingsRefreshing = false;
    renderHoldings();
  }
}

elements['holdings-refresh']?.addEventListener('click', () => {
  loadHoldings({ refresh: true }).catch((error) => showToast(error.message));
});

elements['holdings-group-back']?.addEventListener('click', () => {
  state.holdingsMoveGroup = null;
  renderHoldings();
});

function renderAssets() {
  renderChipTabs(elements['asset-filters'], assetClasses, state.assetClass, (id) => {
    state.assetClass = id;
    renderAssets();
  });
  if (state.tradePane === 'assets') {
    setTradeHint(state.assetError && !state.assetLoading ? state.assetError : '');
    updateChangeSortControl();
  }
  const rows = visibleAssets();
  if (!rows.length) {
    elements['asset-list'].replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state',
      textContent: state.assetLoading ? '正在加载全球资产…' : (state.assetError || '没有符合筛选的标的。'),
    }));
    if (document.body.dataset.view === 'sources') renderHub();
    return;
  }
  renderWatchRows(elements['asset-list'], rows, { formatValue: formatQuoteNumber });
  if (document.body.dataset.view === 'sources') renderHub();
}

function visibleAssets() {
  const board = state.assetBoard;
  const needle = state.assetFilter.trim().toLowerCase();
  const filtered = (board?.watchlist || []).filter((item) => {
    const classOk = state.assetClass === 'all' || item.assetClass === state.assetClass;
    const text = `${item.name} ${item.symbol} ${item.summary || ''} ${item.group || ''}`.toLowerCase();
    return classOk && (!needle || text.includes(needle));
  });
  return sortByChange(filtered);
}

async function loadGlobalAssets() {
  if (!state.bootstrapped) return;
  const requestId = state.assetRequestId + 1;
  state.assetRequestId = requestId;
  state.assetLoading = true;
  state.assetError = '';
  renderAssets();
  try {
    if (!state.session) throw new Error('此设备尚未配对，无法加载行情');
    const payload = await api('/api/v1/markets?board=global', { timeoutMs: 25_000 });
    if (requestId !== state.assetRequestId) return;
    state.assetBoard = payload.market;
  } catch (error) {
    if (requestId !== state.assetRequestId) return;
    state.assetError = error instanceof Error ? error.message : '全球资产加载失败';
    throw error;
  } finally {
    if (requestId === state.assetRequestId) {
      state.assetLoading = false;
      renderAssets();
    }
  }
}

function moneyNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatMoneyAmount(value, digits = 0) {
  return moneyNumber(value).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatSignedMoneyAmount(value) {
  const number = moneyNumber(value);
  const sign = number > 0 ? '+' : '';
  return `${sign}¥${formatMoneyAmount(number, 2)}`;
}

function formatRatioPercent(value, digits = 1) {
  return `${(moneyNumber(value) * 100).toFixed(digits)}%`;
}

function formatSignedRatioPercent(value) {
  const number = moneyNumber(value);
  const sign = number > 0 ? '+' : '';
  return `${sign}${(number * 100).toFixed(2)}%`;
}

function svgNode(name, attributes = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

function renderTrendChart(target, dashboard) {
  const points = dashboard.points || [];
  target.replaceChildren();
  if (points.length < 2) {
    target.textContent = '记录不足，暂无法绘制增长轨迹。';
    return;
  }
  const width = 640;
  const height = 220;
  const pad = { left: 44, right: 12, top: 16, bottom: 28 };
  const series = [
    { key: 'total', color: '#0A59F7', label: '总资产' },
    { key: 'equity', color: '#7C6AF7', label: '股票金额' },
    { key: 'housingFund', color: '#F59E0B', label: '公积金累计' },
  ];
  const values = points.flatMap((point) => series.map((item) => moneyNumber(point[item.key])));
  const min = Math.min(0, ...values);
  const max = Math.max(...values, 1);
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const x = (index) => pad.left + (points.length === 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
  const y = (value) => pad.top + (1 - ((value - min) / (max - min || 1))) * innerHeight;
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '资产增长轨迹' });
  for (let tick = 0; tick <= 3; tick += 1) {
    const value = min + ((max - min) * tick) / 3;
    const top = y(value);
    svg.append(svgNode('line', {
      x1: pad.left, x2: width - pad.right, y1: top, y2: top, stroke: 'rgba(0,0,0,0.08)',
    }));
    svg.append(svgNode('text', {
      x: 0, y: top + 4, fill: 'rgba(0,0,0,0.4)', 'font-size': '10',
    }, [document.createTextNode(value >= 10000 ? `${Math.round(value / 10000)}万` : String(Math.round(value)))]));
  }
  for (const item of series) {
    const d = points.map((point, index) => `${index ? 'L' : 'M'}${x(index)} ${y(moneyNumber(point[item.key]))}`).join(' ');
    svg.append(svgNode('path', { d, fill: 'none', stroke: item.color, 'stroke-width': item.key === 'total' ? '2.5' : '1.75' }));
  }
  const first = points[0].label;
  const last = points[points.length - 1].label;
  svg.append(svgNode('text', { x: pad.left, y: height - 8, fill: 'rgba(0,0,0,0.4)', 'font-size': '10' }, [document.createTextNode(first)]));
  svg.append(svgNode('text', {
    x: width - pad.right, y: height - 8, fill: 'rgba(0,0,0,0.4)', 'font-size': '10', 'text-anchor': 'end',
  }, [document.createTextNode(last)]));
  const legend = document.createElement('div');
  legend.className = 'analysis-legend';
  legend.replaceChildren(...series.map((item) => {
    const span = document.createElement('span');
    span.append(Object.assign(document.createElement('i'), { style: `background:${item.color}` }), item.label);
    return span;
  }));
  target.append(svg, legend);
}

function renderPieChart(target, slices) {
  target.replaceChildren();
  if (!slices.length) {
    target.textContent = '当前没有可展示的资产结构。';
    return;
  }
  const colors = ['#7C6AF7', '#F59E0B', '#22C55E', '#EAB308', '#0A59F7', '#A78BFA'];
  const total = slices.reduce((sum, item) => sum + moneyNumber(item.value), 0) || 1;
  const size = 200;
  const radius = 58;
  const circumference = 2 * Math.PI * radius;
  const svg = svgNode('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': '当前资产结构' });
  let offset = 0;
  slices.forEach((slice, index) => {
    const portion = moneyNumber(slice.value) / total;
    const dash = portion * circumference;
    svg.append(svgNode('circle', {
      cx: '100',
      cy: '100',
      r: String(radius),
      fill: 'none',
      stroke: colors[index % colors.length],
      'stroke-width': '28',
      'stroke-dasharray': `${dash} ${circumference - dash}`,
      'stroke-dashoffset': String(-offset),
      transform: 'rotate(-90 100 100)',
    }));
    offset += dash;
  });
  const legend = document.createElement('div');
  legend.className = 'analysis-legend';
  legend.replaceChildren(...slices.map((slice, index) => {
    const span = document.createElement('span');
    const ratio = moneyNumber(slice.value) / total;
    span.append(
      Object.assign(document.createElement('i'), { style: `background:${colors[index % colors.length]}` }),
      `${slice.name} ${formatRatioPercent(ratio)}`,
    );
    return span;
  }));
  target.append(svg, legend);
}

function renderDividendBars(target, items) {
  target.replaceChildren();
  if (!items.length) {
    target.textContent = '分红表为空。';
    return;
  }
  const sorted = [...items].sort((left, right) => moneyNumber(right.value) - moneyNumber(left.value));
  const max = Math.max(...sorted.map((item) => moneyNumber(item.value)), 1);
  target.append(...sorted.map((item) => {
    const row = document.createElement('div');
    row.className = 'analysis-bar';
    const name = document.createElement('span');
    name.textContent = item.name;
    const track = document.createElement('div');
    const bar = document.createElement('i');
    bar.style.width = `${(moneyNumber(item.value) / max) * 100}%`;
    track.append(bar);
    const amount = document.createElement('b');
    amount.textContent = `¥${formatMoneyAmount(item.value)}`;
    row.append(name, track, amount);
    return row;
  }));
}

function renderPersonalAssetDashboard() {
  const dashboard = state.assetDashboard;
  const latest = dashboard?.latest || {};
  const period = elements['analysis-period'];
  const kpis = elements['analysis-kpis'];
  kpis.replaceChildren();
  if (state.assetDashboardLoading && !dashboard) {
    period.textContent = '正在读取收支草记…';
    return;
  }
  if (state.assetDashboardError) {
    period.textContent = state.assetDashboardError;
    return;
  }
  if (!dashboard || !dashboard.points?.length) {
    period.textContent = dashboard?.note || '还没有资产记录';
    elements['analysis-trend'].replaceChildren();
    elements['analysis-pie'].replaceChildren();
    elements['analysis-dividend'].replaceChildren();
    elements['analysis-insights'].replaceChildren();
    elements['analysis-dividend-total'].textContent = '--';
    return;
  }
  const labels = dashboard.points.map((point) => point.label);
  period.textContent = `统计周期：${labels[0]} - ${labels[labels.length - 1]} | ${dashboard.note || '数据来源：收支草记'}`;
  appendMetric(kpis, '当前总资产 (人民币)', `¥ ${formatMoneyAmount(latest.total)}`, moneyNumber(latest.increase) >= 0 ? 'up' : 'down');
  appendMetric(kpis, '核心引擎：股票余额', `¥ ${formatMoneyAmount(latest.equity)}`);
  appendMetric(kpis, '累计增长率', formatRatioPercent(latest.cumulativeGrowthRate));
  appendMetric(kpis, '稳定基石：公积金', `¥ ${formatMoneyAmount(latest.housingFund)}`);
  appendMetric(kpis, '最新变动', `${formatSignedMoneyAmount(latest.increase)} / ${formatSignedRatioPercent(latest.increaseRate)}`, moneyNumber(latest.increase) >= 0 ? 'up' : 'down');
  appendMetric(kpis, '起始记录', latest.firstLabel ? `${latest.firstLabel} · ${formatMoneyAmount(latest.firstTotal)}` : '暂无');
  renderTrendChart(elements['analysis-trend'], dashboard);
  renderPieChart(elements['analysis-pie'], dashboard.allocation || []);
  const stockRatio = moneyNumber(latest.total) ? moneyNumber(latest.equity) / moneyNumber(latest.total) : 0;
  const fundRatio = moneyNumber(latest.total) ? moneyNumber(latest.housingFund) / moneyNumber(latest.total) : 0;
  elements['analysis-diagnosis-1'].replaceChildren(
    '当前股票资产约占总资产 ',
    Object.assign(document.createElement('strong'), { textContent: formatRatioPercent(stockRatio) }),
    '，是资产波动和增长的主要来源。',
  );
  elements['analysis-diagnosis-2'].textContent = `公积金约占 ${formatRatioPercent(fundRatio)}，提供相对稳定的长期储蓄底座。`;
  elements['analysis-dividend-total'].textContent = `¥ ${formatMoneyAmount(dashboard.dividend?.total)}`;
  renderDividendBars(elements['analysis-dividend'], dashboard.dividend?.items || []);
  const insights = [
    { title: '增长复盘', body: `最新记录为 ${latest.label}，总资产为 ¥${formatMoneyAmount(latest.total, 2)}，较上一条记录变化 ${formatSignedMoneyAmount(latest.increase)}。` },
    { title: '资产集中度', body: `股票资产占比约 ${formatRatioPercent(stockRatio)}。如果占比长期高于 60%，资产收益弹性强，但净值波动也会更明显。` },
    { title: '记录更新', body: `打开页签时读取本地工作簿。当前读取时间：${new Date(dashboard.updatedAt).toLocaleString('zh-CN')}。` },
  ];
  elements['analysis-insights'].replaceChildren(...insights.map((item) => {
    const article = document.createElement('article');
    article.append(
      Object.assign(document.createElement('h3'), { textContent: item.title }),
      Object.assign(document.createElement('p'), { textContent: item.body }),
    );
    return article;
  }));
}

async function loadPersonalAssets() {
  if (!state.session && !state.bootstrapped) return;
  state.assetDashboardLoading = true;
  renderPersonalAssetDashboard();
  try {
    const payload = await api('/api/v1/assets/personal');
    state.assetDashboard = payload.dashboard;
    state.assetDashboardError = '';
  } catch (error) {
    state.assetDashboardError = error instanceof Error ? error.message : '个人资产加载失败';
  } finally {
    state.assetDashboardLoading = false;
    renderPersonalAssetDashboard();
  }
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

function formatPrice(value, digits = 2) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatAssetPrice(item) {
  return formatQuoteNumber(item, item.lastPrice);
}

function formatQuoteNumber(item, value) {
  if (value === null || value === undefined) return '—';
  if (item.assetClass === 'fx' || item.assetClass === 'rate') return formatPrice(value, 4);
  if (item.assetClass === 'crypto' && Number(value) >= 1000) return formatPrice(value, 0);
  return formatPrice(value);
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
  if (!state.bootstrapped) return;
  const requestId = state.marketRequestId + 1;
  state.marketRequestId = requestId;
  state.marketLoading = true;
  state.marketError = '';
  renderMarketStatus();
  try {
    if (!state.session) throw new Error('此设备尚未配对，无法加载行情');
    const payload = await api(extraQuery(), { timeoutMs: 25_000 });
    if (requestId !== state.marketRequestId) return;
    state.markets[payload.market.board] = payload.market;
    renderMarket();
  } catch (error) {
    if (requestId !== state.marketRequestId) return;
    state.marketError = error instanceof Error ? error.message : '行情加载失败';
    renderMarket();
    throw error;
  } finally {
    if (requestId === state.marketRequestId) {
      state.marketLoading = false;
      renderMarketStatus();
    }
  }
}

function currentMarket() {
  return state.markets[state.stockBoard];
}

function renderStockBoards() {
  const sourceBoards = state.sourceCatalog
    .filter((source) => source.category === 'market' && source.viewKind === 'market-board' && source.id !== 'market.global')
    .map((source) => ({ id: source.id.replace(/^market\./, ''), label: source.title }));
  const boards = sourceBoards.length ? sourceBoards : fallbackStockBoards;
  renderChipTabs(elements['stock-boards'], boards, state.stockBoard, (id) => {
    state.stockBoard = id;
    state.stockGroup = '全部';
    state.marketFilter = '';
    if (elements['market-filter']) elements['market-filter'].value = '';
    renderStockBoards();
    loadMarket().catch((error) => showToast(error.message));
  });
}

async function loadSourceCatalog() {
  const payload = await api('/api/v1/sources');
  state.sourceCatalog = payload.sources || [];
  renderStockBoards();
  renderSources();
}

function openSource(source) {
  if (source.category === 'market') {
    const board = source.id.replace(/^market\./, '');
    if (board === 'global') {
      state.tradePane = 'assets';
    } else {
      state.tradePane = 'stocks';
      state.stockBoard = board;
      state.stockGroup = '全部';
    }
    setView('market');
    renderTradeTabs();
    syncTradePaneData().catch((error) => showToast(error.message));
    return;
  }
  if (source.category === 'content') {
    state.platform = source.providerId;
    resetFeedWindow();
    renderPlatformFilters();
    renderXToolbar();
    renderBilibiliToolbar();
    renderPosts();
    setView('feed');
    return;
  }
  if (source.category === 'search') {
    const select = elements['ask-form']?.elements?.webMode;
    if (select) select.value = 'always';
    setView('ask/new');
  }
}

function hubFeedPicks(limit = 12) {
  const live = state.posts.map(liveAsItem);
  const xItems = state.xItems.map(xAsItem);
  const bilibiliItems = state.bilibiliItems.map(bilibiliAsItem);
  const demo = feedItems.filter((item) => {
    if (item.platform === 'x' && state.xItems.length) return false;
    if (item.platform === 'bilibili' && state.bilibiliItems.length) return false;
    return true;
  });
  return [...bilibiliItems, ...xItems, ...live, ...demo]
    .filter((item) => !state.hiddenFeedIds.has(item.id) && !state.hiddenFeedIds.has(item.resourceId))
    .sort((left, right) => (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0))
    .slice(0, limit);
}

function hubQuotes() {
  const live = [
    ...(state.markets.overview?.sections || []).flatMap((section) => section.indices || []),
    ...(state.markets.us?.watchlist || []).slice(0, 3),
    ...(state.assetBoard?.watchlist || []).slice(0, 4),
  ].filter((item) => item?.symbol);
  const fallback = [...quotes, ...globalAssets].map((item) => ({
    name: item.name,
    symbol: item.symbol,
    lastPrice: Number(String(item.price).replace(/,/g, '')),
    changePct: item.changePct,
  }));
  const seen = new Set();
  return [...live, ...fallback].filter((item) => {
    if (seen.has(item.symbol)) return false;
    seen.add(item.symbol);
    return true;
  }).slice(0, 12);
}

function hubMovers() {
  const live = (state.markets.overview?.sections || []).flatMap((section) => [
    ...(section.gainers || []), ...(section.losers || []),
  ]).filter((item) => item?.symbol);
  if (live.length) {
    const seen = new Set();
    return live.filter((item) => {
      if (seen.has(item.symbol)) return false;
      seen.add(item.symbol);
      return true;
    }).slice(0, 10);
  }
  return hubQuotes().slice(5, 12);
}

function hubStreamItems() {
  if (state.hubLane === 'market') {
    return hubMovers().map((item) => ({ kind: 'market', ...item }));
  }
  return hubFeedPicks().map((item) => ({ kind: 'feed', ...item }));
}

function renderHubTicker() {
  const ticker = elements['hub-ticker'];
  if (!ticker) return;
  const quotesForTick = hubQuotes().slice(0, 5);
  ticker.replaceChildren(...quotesForTick.map((item) => {
    const up = (item.changePct ?? 0) >= 0;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hub-tick';
    button.innerHTML = `<small>${item.name}</small>
      <strong class="${up ? 'up' : 'down'}">${formatPrice(item.lastPrice)}</strong>
      <b class="${up ? 'up' : 'down'}">${item.changePct === null || item.changePct === undefined ? '—' : formatPct(up, item.changePct)}</b>`;
    button.addEventListener('click', () => {
      state.tradePane = 'stocks';
      setView('market');
    });
    return button;
  }));
}

function renderHubExcerpts() {
  const root = elements['hub-excerpts'];
  if (!root) return;
  const excerpts = [
    ...hubFeedPicks(3).map((item) => ({
      label: postDisplayTitle(item),
      onClick: () => openPost(item),
    })),
    ...hubMovers().slice(0, 2).map((item) => ({
      label: `${item.name} ${item.changePct === null || item.changePct === undefined ? '' : formatPct((item.changePct ?? 0) >= 0, item.changePct)}`.trim(),
      onClick: () => setView('market'),
    })),
  ];
  if (!excerpts.length) {
    root.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'hub-excerpt-empty',
      textContent: '摘选位：接入后会放标题、要点或图表注释。',
    }));
    return;
  }
  root.replaceChildren(...excerpts.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hub-excerpt';
    button.textContent = item.label;
    button.addEventListener('click', item.onClick);
    return button;
  }));
}

function renderHub() {
  renderHubTicker();
  renderHubExcerpts();
}

function renderSources() {
  renderHub();
}

async function loadSourcesPage() {
  renderHub();
  const tasks = [];
  if (state.session) {
    if (!state.markets.overview) tasks.push(loadMarket().catch(() => {}));
    if (!state.assetBoard) tasks.push(loadGlobalAssets().catch(() => {}));
  }
  if (tasks.length) await Promise.all(tasks);
  renderHub();
}

function renderMarketStatus() {
  const el = elements['market-status'];
  if (!el) return;
  const error = !state.marketLoading && state.marketError ? state.marketError : '';
  el.textContent = error;
  el.classList.toggle('hidden', !error);
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
    heading.append(Object.assign(document.createElement('h2'), { textContent: section.title }));
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
  const up = breadth.advancers;
  const flat = breadth.unchanged;
  const down = breadth.decliners;
  const total = up + flat + down;
  const share = (count) => (total ? (count / total) * 100 : 0);
  const article = document.createElement('article');
  article.className = 'breadth-card';
  article.innerHTML = `<h3>${title}</h3>
    <strong>${total}<small>家</small></strong>
    <span>已报价</span>
    <div class="breadth-track">
      <i class="up" style="flex-basis:${share(up)}%"></i>
      <i class="flat" style="flex-basis:${share(flat)}%"></i>
      <i class="down" style="flex-basis:${share(down)}%"></i>
    </div>
    <p>${up} 涨 · ${flat} 平 · ${down} 跌</p>`;
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
  return sortByChange(filtered);
}

function sortByChange(items) {
  if (state.changeSort === 'none') return items;
  return [...items].sort((a, b) => {
    const left = a.changePct;
    const right = b.changePct;
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return state.changeSort === 'desc' ? right - left : left - right;
  });
}

function updateChangeSortControl() {
  const labels = {
    none: { icon: 'arrow-up-down', aria: '按涨跌幅排序' },
    desc: { icon: 'arrow-down', aria: '当前涨幅从高到低，再次点击改为从低到高' },
    asc: { icon: 'arrow-up', aria: '当前涨幅从低到高，再次点击恢复默认顺序' },
  };
  const next = labels[state.changeSort];
  for (const button of [elements['market-sort'], elements['asset-sort']]) {
    if (!button) continue;
    button.classList.toggle('is-active', state.changeSort !== 'none');
    button.setAttribute('aria-label', next.aria);
    button.innerHTML = `涨跌幅 ${icon(next.icon)}`;
  }
}

function renderWatchRows(target, rows, { formatValue } = {}) {
  const format = formatValue || ((item, value) => formatPrice(value));
  if (!rows.length) {
    target.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state',
      textContent: '没有符合筛选的标的。',
    }));
    return;
  }
  target.replaceChildren(...rows.map((item) => {
    const up = (item.changePct ?? 0) >= 0;
    const row = document.createElement('div');
    row.className = 'market-row';
    const code = item.expiry ? `${item.symbol} · ${item.group} · ${item.expiry}` : `${item.symbol} · ${item.group}`;
    row.innerHTML = `<span class="quote-identity">
        <strong class="quote-name">${item.name}</strong>
        ${item.summary ? `<em class="quote-blurb">${item.summary}</em>` : ''}
        <small class="quote-code">${code}</small>
      </span>
      <span class="market-spark">${sparkSvg(item.sparkline, item.changePct)}</span>
      <span class="quote-price ${up ? 'up' : 'down'}">${format(item, item.lastPrice)}</span>
      <span class="quote-change ${up ? 'up' : 'down'}">${item.changePct === null ? '—' : formatPct(up, item.changePct)}</span>
      <span class="market-meta"><span>量 ${formatVolume(item.volume)}</span><span class="market-range">${format(item, item.low)} – ${format(item, item.high)}</span></span>`;
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
    if (document.body.dataset.view === 'sources') renderHub();
    return;
  }
  elements['market-overview'].replaceChildren();
  const groups = (market?.groups || []).map((label) => ({ id: label, label }));
  renderChipTabs(elements['quote-filters'], groups, state.stockGroup, (id) => {
    state.stockGroup = id;
    renderMarket();
  });
  renderWatchRows(elements['quote-list'], market ? visibleWatchlist(market) : []);
  if (document.body.dataset.view === 'sources') renderHub();
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
    const mark = tool.icon ? icon(tool.icon) : tool.title.slice(0, 1);
    button.innerHTML = `<span class="tool-icon">${mark}</span><strong>${tool.title}</strong><small>${tool.desc}</small>`;
    button.addEventListener('click', () => {
      if (tool.action === 'compose') return openCompose();
      if (tool.action === 'settings') return setView('settings');
      if (viewCopy[tool.action]) return setView(tool.action);
      showToast('这项能力将在闭环稳定后接入');
    });
    return button;
  }));
}

function askKindLabel(kind) {
  return kind === 'inspiration' ? '灵感加工' : '问答';
}

function syncAskLayer() {
  const inSession = Boolean(state.askSessionId);
  elements['ask-records'].classList.toggle('hidden', inSession);
  elements['ask-session-shell'].classList.toggle('hidden', !inSession);
  const kind = state.askSessionId === 'new' ? 'question-answer' : (state.askDetail?.session?.kind || 'question-answer');
  document.body.dataset.askKind = inSession ? kind : '';
  if (inSession && state.askDetail?.session?.title) {
    elements['page-subtitle'].textContent = state.askDetail.session.title;
  } else if (inSession && state.askSessionId === 'new') {
    elements['page-subtitle'].textContent = '新的问答，使用当前上下文';
  } else {
    elements['page-subtitle'].textContent = viewCopy.ask.subtitle;
  }
}

async function syncAskView() {
  syncAskLayer();
  if (!state.askSessionId) {
    await loadAskSessions();
    return;
  }
  if (state.askSessionId === 'new') {
    state.askDetail = null;
    renderAskSession();
    return;
  }
  await loadAskSession(state.askSessionId);
}

async function loadAskSessions() {
  if (!state.session) {
    elements['ask-session-list'].replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state',
      textContent: '配对后即可查看 AI 记录',
    }));
    return;
  }
  const payload = await api('/api/v1/agent/sessions?limit=50');
  state.askSessions = payload.sessions || [];
  renderAskRecords();
}

async function loadAskSession(sessionId) {
  if (!state.session) return;
  const payload = await api(`/api/v1/agent/sessions/${sessionId}`);
  state.askDetail = { session: payload.session, exchanges: payload.exchanges || [] };
  if (state.askPending?.sessionId && state.askPending.sessionId !== sessionId) state.askPending = null;
  renderAskSession();
  syncAskLayer();
}

function openAskSession(sessionId) {
  setView(`ask/${sessionId}`);
}

function renderAskRecords() {
  const list = elements['ask-session-list'];
  if (!state.askSessions.length) {
    list.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state',
      textContent: '还没有 AI 记录。点上方「开始提问」或右上角 + 开一次新的问答。',
    }));
    return;
  }
  const nodes = [];
  let lastDay = '';
  for (const session of state.askSessions) {
    const stamp = session.updatedAt || session.createdAt;
    const day = formatAskDay(stamp);
    if (day !== lastDay) {
      lastDay = day;
      nodes.push(Object.assign(document.createElement('h3'), {
        className: 'ask-history-day',
        textContent: day,
      }));
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ask-session-item';
    button.append(
      Object.assign(document.createElement('strong'), { textContent: session.title || '未命名记录' }),
      Object.assign(document.createElement('small'), {
        textContent: `${askKindLabel(session.kind)} · ${formatAskClock(stamp)}`,
      }),
    );
    button.addEventListener('click', () => openAskSession(session.id));
    nodes.push(button);
  }
  list.replaceChildren(...nodes);
}

function renderAskPrompts() {
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

function renderAsk() {
  renderAskPrompts();
  renderAskRecords();
}

function clearAskThreadExtras() {
  elements['ask-thread'].querySelectorAll('.ask-exchange').forEach((node) => node.remove());
}

function setAskAnswer(answer, answerText, { pending = false, error = false, progress = [] } = {}) {
  answer.classList.toggle('is-pending', pending);
  answer.classList.toggle('is-error', error);
  if (pending) {
    renderAskProgress(answer, progress, answerText);
    return;
  }
  if (error) {
    answer.textContent = answerText;
    return;
  }
  renderMarkdownInto(answer, answerText);
}

function renderAskProgress(target, steps, fallback) {
  target.replaceChildren();
  if (!steps.length) {
    target.textContent = fallback;
    return;
  }
  const list = document.createElement('ol');
  list.className = 'ask-progress';
  for (const step of steps) {
    const item = document.createElement('li');
    item.className = `ask-progress-item is-${step.status || 'done'}`;
    const label = document.createElement('span');
    label.className = 'ask-progress-label';
    label.textContent = step.label;
    item.append(label);
    if (step.detail) {
      const detail = document.createElement('small');
      detail.className = 'ask-progress-detail';
      detail.textContent = step.detail;
      item.append(detail);
    }
    list.append(item);
  }
  target.append(list);
}

function appendAskExchange(question, answerText, {
  pending = false, error = false, refs = [], runId = '', answer = '', sourceFooter = null,
} = {}) {
  const card = document.createElement('article');
  card.className = 'ask-card ask-exchange';
  const questionBlock = document.createElement('div');
  questionBlock.className = 'ask-turn ask-turn-q';
  questionBlock.append(
    Object.assign(document.createElement('span'), { className: 'ask-turn-label', textContent: '提问' }),
    Object.assign(document.createElement('h2'), { className: 'ask-question', textContent: question || '（无提问原文）' }),
  );
  card.append(questionBlock);
  const selected = (refs || []).filter((item) => !item.origin || item.origin === 'selected');
  if (selected.length) {
    const used = document.createElement('div');
    used.className = 'ask-used-refs';
    used.append(...selected.map((item, index) => createRefChip({
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      revision: item.revision || undefined,
      label: item.label || item.resourceId,
      preview: item.preview || '',
    }, index)));
    card.append(used);
  }
  const answerBlock = document.createElement('div');
  answerBlock.className = 'ask-turn ask-turn-a';
  answerBlock.append(Object.assign(document.createElement('span'), { className: 'ask-turn-label', textContent: '回答' }));
  const answerNode = document.createElement('div');
  answerNode.className = 'ask-answer';
  setAskAnswer(answerNode, answerText, { pending, error });
  answerBlock.append(answerNode);
  card.append(answerBlock);
  if (!pending && !error) appendAskSourceFooter(card, sourceFooter);
  if (!pending && !error && runId) {
    const actions = document.createElement('div');
    actions.className = 'ask-exchange-actions';
    const cite = document.createElement('button');
    cite.type = 'button';
    cite.className = 'text-button';
    cite.textContent = '引用此回答';
    cite.addEventListener('click', () => toggleReference({
      resourceType: 'ai-run',
      resourceId: runId,
      label: question || 'AI 回答',
      preview: answer || answerText,
    }));
    const saveNote = document.createElement('button');
    saveNote.type = 'button';
    saveNote.className = 'text-button';
    saveNote.textContent = '保存为灵感';
    saveNote.addEventListener('click', () => saveAnswerAsInspiration(runId, saveNote));
    const saveKnowledge = document.createElement('button');
    saveKnowledge.type = 'button';
    saveKnowledge.className = 'text-button';
    saveKnowledge.textContent = '沉淀为知识';
    saveKnowledge.addEventListener('click', () => saveAnswerAsKnowledge(runId, saveKnowledge));
    actions.append(cite, saveNote, saveKnowledge);
    card.append(actions);
  }
  elements['ask-prompts'].before(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return answerNode;
}

function formatSavedTaxonomy(taxonomy = []) {
  const items = taxonomy.filter((item) => item.primary);
  const source = items.length ? items : taxonomy;
  return source.map((item) => (
    item.parentName && (item.dimension === 'industry' || item.dimension === 'topic')
      ? `${item.parentName} / ${item.name}`
      : item.name
  )).filter(Boolean).join(' · ');
}

async function waitForStructureJob(jobId) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await wait(650);
    const payload = await api(`/api/v1/knowledge/jobs/${jobId}`, { timeoutMs: 15_000 });
    if (payload.status === 'completed') return payload.job.output || {};
    if (payload.status === 'failed' || payload.status === 'cancelled') {
      throw new Error(payload.job.error?.message || '整理未能完成');
    }
  }
  throw new Error('等待整理超时，请确认 Worker 正在运行');
}

function showStructuredSaveToast(output, view) {
  const path = formatSavedTaxonomy(output.taxonomy || []);
  const message = path ? `已保存到：${path}` : (view === 'inspire' ? '已保存为灵感' : '已沉淀为知识');
  showToast(message, {
    label: '查看',
    onClick: () => setView(view),
  });
}

async function saveAnswerAsInspiration(runId, button) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const created = await api('/api/v1/notes/from-run', {
      method: 'POST',
      body: JSON.stringify({ runId }),
    });
    const output = await waitForStructureJob(created.jobId);
    showStructuredSaveToast(output, 'inspire');
    loadNotes().catch(() => {});
  } catch (error) {
    showToast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveAnswerAsKnowledge(runId, button) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const created = await api('/api/v1/knowledge/from-run', {
      method: 'POST',
      body: JSON.stringify({ runId }),
    });
    const output = await waitForStructureJob(created.jobId);
    showStructuredSaveToast(output, 'knowledge');
    loadKnowledge().catch(() => {});
  } catch (error) {
    showToast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderAskSession() {
  const isNew = state.askSessionId === 'new';
  const exchanges = state.askDetail?.exchanges || [];
  const showIntro = isNew && !exchanges.length && !state.askPending;
  elements['ask-intro'].classList.toggle('hidden', !showIntro);
  elements['ask-prompt-label'].classList.toggle('hidden', !showIntro);
  elements['ask-prompts'].classList.toggle('hidden', !showIntro);
  clearAskThreadExtras();
  for (const exchange of exchanges) {
    appendAskExchange(exchange.question, exchange.answer || '（没有可显示的回答）', {
      refs: exchange.refs || [],
      sourceFooter: exchange.sourceFooter,
      runId: exchange.id,
      answer: exchange.answer || '',
    });
  }
  if (state.askPending && (state.askPending.sessionId === state.askSessionId || isNew)) {
    appendAskExchange(state.askPending.question, state.askPending.text, {
      pending: !state.askPending.error,
      error: Boolean(state.askPending.error),
      refs: state.askPending.refs || [],
    });
  }
  if (showIntro) renderAskPrompts();
  syncAskLayer();
}

function setAskComposerBusy(busy) {
  state.askSubmitting = busy;
  const input = elements['ask-form'].elements.question;
  const webMode = elements['ask-form'].elements.webMode;
  input.disabled = busy;
  if (webMode) webMode.disabled = busy;
  elements['ask-send'].disabled = busy;
  elements['ask-send'].setAttribute('aria-label', busy ? '正在回答' : '发送');
}

function currentWebMode() {
  const value = elements['ask-form']?.elements?.webMode?.value;
  return value === 'always' || value === 'fallback' || value === 'off' ? value : 'fallback';
}

function restoreWebMode() {
  const select = elements['ask-form']?.elements?.webMode;
  if (!select) return;
  try {
    const saved = window.localStorage.getItem('ai-center-web-mode');
    if (saved === 'off' || saved === 'fallback' || saved === 'always') select.value = saved;
  } catch {}
  select.addEventListener('change', () => {
    try { window.localStorage.setItem('ai-center-web-mode', select.value); } catch {}
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForAgentAnswer(runId, answerElement) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await wait(650);
    const payload = await api(`/api/v1/agent/runs/${runId}`, { timeoutMs: 15_000 });
    if (payload.status === 'completed') return payload.job.output?.answer || '模型没有返回可显示的回答。';
    if (payload.status === 'failed' || payload.status === 'cancelled') {
      throw new Error(payload.job.error?.message || '问答任务未能完成');
    }
    const fallback = payload.status === 'running' ? '正在生成回答…' : '正在等待 AI Worker…';
    setAskAnswer(answerElement, fallback, { pending: true, progress: payload.progress || [] });
  }
  throw new Error('等待回答超时，请确认 Worker 正在运行');
}

async function askAgent(question) {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  if (state.askSubmitting) return;
  if (state.askDetail?.session?.kind === 'inspiration') {
    showToast('灵感加工记录请点 + 开新问答');
    return;
  }
  if (!state.askSessionId) openAskSession('new');
  const sessionId = state.askSessionId === 'new' ? undefined : state.askSessionId;
  const sentRefs = state.referenceDraft.slice();
  const references = draftPayload();
  state.askPending = { sessionId: state.askSessionId, question, text: '正在提交问题…', error: false, refs: sentRefs };
  renderAskSession();
  setAskComposerBusy(true);
  try {
    const created = await api('/api/v1/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ message: question, webMode: currentWebMode(), sessionId, references }),
    });
    clearReferences();
    if (created.sessionId && state.askSessionId === 'new') {
      state.askSessionId = created.sessionId;
      state.askPending.sessionId = created.sessionId;
      const nextHash = askHash(created.sessionId);
      if (location.hash !== nextHash) history.replaceState({}, '', `${location.pathname}${location.search}${nextHash}`);
    }
    const answerNode = elements['ask-thread'].querySelector('.ask-exchange:last-of-type .ask-answer');
    const target = answerNode || appendAskExchange(question, '正在等待 AI Worker…', { pending: true });
    state.askPending.text = '正在等待 AI Worker…';
    const answer = await waitForAgentAnswer(created.runId, target);
    state.askPending = null;
    if (created.sessionId) await loadAskSession(created.sessionId);
    else {
      setAskAnswer(target, answer);
    }
    loadAskSessions().catch(() => {});
  } catch (error) {
    const message = `未能回答：${error instanceof Error ? error.message : '未知错误'}`;
    state.askPending = { ...state.askPending, text: message, error: true };
    renderAskSession();
  } finally {
    setAskComposerBusy(false);
  }
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

const NOTE_SWIPE_WIDTH = 168;
const KNOWLEDGE_SWIPE_WIDTH = 72;
const FEED_SWIPE_WIDTH = 72;

const INSPIRATION_TYPE_LABELS = {
  observation: '观察',
  hypothesis: '假设',
  question: '问题',
  idea: '想法',
};

const KNOWLEDGE_TYPE_LABELS = {
  fact: '事实',
  mechanism: '机制',
  thesis: '判断',
  framework: '框架',
  case: '案例',
  procedure: '方法',
};

function closeNoteSwipes(except) {
  document.querySelectorAll('.swipe-front.is-open').forEach((front) => {
    if (front === except) return;
    front.classList.remove('is-open');
    front.style.transform = 'translateX(0)';
  });
}

function attachSwipe(front, width = NOTE_SWIPE_WIDTH, onTap) {
  let startX = 0;
  let startY = 0;
  let origin = 0;
  let dx = 0;
  let tracking = false;
  let axis = '';

  const settle = (event) => {
    const tapped = tracking && !axis;
    tracking = false;
    axis = '';
    front.style.transition = '';
    const open = dx < -(width / 3);
    front.classList.toggle('is-open', open);
    front.style.transform = `translateX(${open ? -width : 0}px)`;
    if (tapped && !open && typeof onTap === 'function') onTap(event);
  };

  front.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest('a, button, input, textarea, select, [role="button"]')) return;
    closeNoteSwipes(front);
    startX = event.clientX;
    startY = event.clientY;
    origin = front.classList.contains('is-open') ? -width : 0;
    dx = origin;
    tracking = true;
    axis = '';
    front.style.transition = 'none';
    front.setPointerCapture(event.pointerId);
  });
  front.addEventListener('pointermove', (event) => {
    if (!tracking) return;
    const moveX = event.clientX - startX;
    const moveY = event.clientY - startY;
    if (!axis) {
      if (Math.abs(moveX) < 8 && Math.abs(moveY) < 8) return;
      axis = Math.abs(moveY) > Math.abs(moveX) ? 'y' : 'x';
      if (axis === 'y') {
        tracking = false;
        front.style.transition = '';
        return;
      }
    }
    dx = Math.min(0, Math.max(-width, origin + moveX));
    front.style.transform = `translateX(${dx}px)`;
  });
  front.addEventListener('pointerup', settle);
  front.addEventListener('pointercancel', () => settle());
}

function attachNoteSwipe(front, onTap) {
  attachSwipe(front, NOTE_SWIPE_WIDTH, onTap);
}

function inspirationCardTitle(note) {
  const explicit = String(note.title || '').replace(/\s+/g, ' ').trim();
  if (explicit) return explicit;
  const source = String(note.sourceTitle || '').replace(/\s+/g, ' ').trim();
  if (source) return source;
  const first = String(note.body || '').trim()
    .split(/\n/)[0]
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (first) return first.length > 72 ? `${first.slice(0, 72)}…` : first;
  return '未命名灵感';
}

function setInspirationExpanded(noteId, open) {
  if (open) {
    state.expandedInspirationIds.clear();
    state.expandedInspirationIds.add(noteId);
  } else {
    state.expandedInspirationIds.delete(noteId);
  }
  document.querySelectorAll('#note-list [data-inspiration-id]').forEach((node) => {
    const expanded = state.expandedInspirationIds.has(node.dataset.inspirationId);
    node.classList.toggle('is-expanded', expanded);
    node.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });
}

function appendResourceTags(card, { typeLabel, taxonomy = [] }) {
  const tags = document.createElement('div');
  tags.className = 'note-tags';
  if (typeLabel) {
    const type = document.createElement('span');
    type.className = 'note-tag is-type';
    type.textContent = typeLabel;
    tags.append(type);
  }
  const names = (taxonomy || [])
    .filter((item) => item.primary)
    .map((item) => item.name)
    .filter(Boolean);
  for (const name of names) {
    const tag = document.createElement('span');
    tag.className = 'note-tag';
    tag.textContent = name;
    tags.append(tag);
  }
  if (tags.childElementCount) card.append(tags);
}

function fillNoteBody(card, text, title = '') {
  const body = document.createElement('div');
  body.className = 'note-body post-markdown';
  let markdown = String(text || '').trim();
  if (title) {
    markdown = markdown.replace(new RegExp(`^#{1,3}\\s+${escapeRegExp(title)}\\s*(?:\\n+|$)`), '');
  }
  renderMarkdownInto(body, markdown);
  body.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (!link || !body.contains(link)) return;
    openExternalHttpUrl(link.href, event);
  });
  card.append(body);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runNoteAction(note, action) {
  try {
    if (action === 'pin') {
      await api(`/api/v1/notes/${note.id}/pin`, { method: 'POST' });
      showToast(note.pinned ? '已取消置顶' : '已置顶');
      await loadNotes();
      return;
    }
    if (action === 'archive') {
      await api(`/api/v1/notes/${note.id}/archive`, { method: 'POST' });
      showToast('已放到知识库 · 待整理');
      await Promise.all([loadNotes(), loadKnowledge()]);
      return;
    }
    await api(`/api/v1/notes/${note.id}`, { method: 'DELETE' });
    showToast('已删除');
    await loadNotes();
  } catch (error) {
    showToast(error.message);
  }
}

function renderNotes() {
  closeNoteSwipes();
  elements['note-list'].replaceChildren();
  if (!state.notes.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有灵感。写一条就能看见。';
    elements['note-list'].append(empty);
    return;
  }
  for (const note of state.notes) {
    const row = document.createElement('div');
    row.className = 'swipe-item';
    const actions = document.createElement('div');
    actions.className = 'swipe-actions';
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'swipe-pin';
    pin.textContent = note.pinned ? '取消置顶' : '置顶';
    pin.addEventListener('click', () => runNoteAction(note, 'pin'));
    const archive = document.createElement('button');
    archive.type = 'button';
    archive.className = 'swipe-archive';
    archive.textContent = '转入知识库';
    archive.addEventListener('click', () => runNoteAction(note, 'archive'));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'swipe-delete';
    remove.textContent = '删除';
    remove.addEventListener('click', () => runNoteAction(note, 'delete'));
    actions.append(pin, archive, remove);

    const card = document.createElement('article');
    card.className = 'note-card swipe-front';
    card.dataset.inspirationId = note.id;
    const expanded = state.expandedInspirationIds.has(note.id);
    card.classList.toggle('is-expanded', expanded);
    card.setAttribute('aria-expanded', expanded ? 'true' : 'false');

    const head = document.createElement('div');
    head.className = 'note-card-head';
    const copy = document.createElement('div');
    copy.className = 'note-card-head-copy';
    copy.append(Object.assign(document.createElement('strong'), { textContent: inspirationCardTitle(note) }));
    const time = document.createElement('small');
    time.textContent = note.pinned ? `置顶 · ${formatTime(note.createdAt)}` : formatTime(note.createdAt);
    copy.append(time);
    const chevron = document.createElement('span');
    chevron.className = 'note-card-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    head.append(copy, chevron);

    const detail = document.createElement('div');
    detail.className = 'note-card-detail';
    appendResourceTags(detail, {
      typeLabel: INSPIRATION_TYPE_LABELS[note.inspirationType] || '',
      taxonomy: note.taxonomy,
    });
    fillNoteBody(detail, note.body, note.title);
    if (note.sourceTitle || note.sourceUrl) {
      const source = document.createElement('div');
      source.className = 'note-source';
      if (isHttpUrl(note.sourceUrl)) {
        appendExternalLink(source, note.sourceUrl, note.sourceTitle || '打开链接');
      } else {
        source.append(Object.assign(document.createElement('span'), {
          textContent: note.sourceTitle || '原始来源',
        }));
      }
      detail.append(source);
    }
    const cite = document.createElement('button');
    cite.type = 'button';
    cite.className = 'card-cite';
    cite.textContent = '引用';
    cite.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleReference({
        resourceType: 'inspiration',
        resourceId: note.id,
        label: note.title || note.body,
        preview: note.body,
      });
    });
    detail.append(cite);
    if (note.aiReply) {
      const reply = document.createElement('div');
      reply.className = 'post-quote';
      reply.textContent = `AI 结果（与原文分开）：\n${note.aiReply}`;
      detail.append(reply);
    }
    card.append(head, detail);
    attachNoteSwipe(card, (event) => {
      if (card.classList.contains('is-open')) {
        closeNoteSwipes();
        return;
      }
      const target = event?.target;
      const onHead = target instanceof Element && Boolean(target.closest('.note-card-head'));
      if (card.classList.contains('is-expanded') && !onHead) return;
      setInspirationExpanded(note.id, !state.expandedInspirationIds.has(note.id));
    });
    row.append(actions, card);
    elements['note-list'].append(row);
  }
}

function renderKnowledge() {
  closeNoteSwipes();
  elements['knowledge-list'].replaceChildren();
  if (!state.knowledge.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '知识库还是空的。从灵感里转入第一条吧。';
    elements['knowledge-list'].append(empty);
    return;
  }
  for (const item of state.knowledge) {
    const row = document.createElement('div');
    row.className = 'swipe-item';
    const actions = document.createElement('div');
    actions.className = 'swipe-actions swipe-actions-single';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'swipe-delete';
    remove.textContent = '删除';
    remove.addEventListener('click', () => runKnowledgeAction(item, 'delete'));
    actions.append(remove);

    const card = document.createElement('article');
    card.className = 'note-card swipe-front';
    card.dataset.knowledgeId = item.id;
    const time = document.createElement('small');
    time.textContent = `${item.source === 'inspiration' ? '来自灵感' : (item.source === 'ai-run' || item.source === 'ai-session') ? '来自问答' : '手动'} · ${formatTime(item.createdAt)}`;
    card.append(time);
    card.append(Object.assign(document.createElement('strong'), { textContent: item.title }));
    appendResourceTags(card, {
      typeLabel: KNOWLEDGE_TYPE_LABELS[item.knowledgeType] || '',
      taxonomy: item.taxonomy,
    });
    fillNoteBody(card, item.body, item.title);
    const cite = document.createElement('button');
    cite.type = 'button';
    cite.className = 'card-cite';
    cite.textContent = '引用';
    cite.addEventListener('click', () => toggleReference({
      resourceType: 'knowledge-revision',
      resourceId: item.id,
      label: item.title,
      preview: item.body,
    }));
    card.append(cite);
    attachSwipe(card, KNOWLEDGE_SWIPE_WIDTH);
    row.append(actions, card);
    elements['knowledge-list'].append(row);
  }
}

async function runKnowledgeAction(item, action) {
  try {
    if (action !== 'delete') return;
    await api(`/api/v1/knowledge/${item.id}`, { method: 'DELETE' });
    showToast('已从知识库删除');
    await loadKnowledge();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadNotes() {
  if (!state.session) return;
  const payload = await api('/api/v1/notes?status=inbox');
  state.notes = payload.notes;
  refreshSavedMarks();
  renderNotes();
  renderPosts();
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
  openDialog(elements['search-dialog']);
  elements['symbol-search'].focus();
}

function openHeaderAction() {
  if (elements['open-compose'].dataset.action === 'search') {
    openSearch();
    return;
  }
  if (elements['open-compose'].dataset.action === 'ask-new') {
    openAskSession('new');
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
  openDialog(elements['compose-dialog']);
}

async function requestTranslate(post) {
  if (post?.platform === 'x') {
    await translateXBatch();
    return;
  }
  await translatePost(post);
}

async function translateXBatch() {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  if (state.xTranslating) return;
  const pending = pendingXTranslations();
  if (!pending.length) return;
  state.xTranslating = true;
  renderXToolbar();
  try {
    const payload = await api('/api/v1/translate/batch', {
      method: 'POST',
      timeoutMs: 120_000,
      body: JSON.stringify({
        targetLang: 'zh',
        items: pending.map((post) => ({ id: post.id, text: post.body })),
      }),
    });
    const byId = new Map((payload.translations || []).map((row) => [row.id, row]));
    for (const post of pending) {
      const translation = byId.get(post.id);
      if (!translation?.translatedText) continue;
      rememberTranslation(post, {
        text: translation.translatedText,
        engine: translation.engine || '',
        cached: Boolean(translation.cached),
      });
    }
    renderPosts();
    renderXToolbar();
    if (state.dialogPost) syncDialogTranslation(state.dialogPost);
    const count = pending.filter((post) => translationFor(post)).length;
    if (count) showToast(`已翻译 ${count} 条`);
    else showToast('这次没有译出新内容，可再点一次翻译');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '翻译失败');
  } finally {
    state.xTranslating = false;
    renderXToolbar();
  }
}

async function translatePost(post) {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  if (!post.body) {
    showToast('这条没有可翻译的正文');
    return;
  }
  if (translationFor(post) || !postNeedsChineseTranslation(post)) return;
  const payload = await api('/api/v1/translate', {
    method: 'POST',
    body: JSON.stringify({ id: post.id, text: post.body, targetLang: 'zh' }),
  });
  const translation = payload.translation || {};
  rememberTranslation(post, {
    text: translation.translatedText || '',
    engine: translation.engine || '',
    cached: Boolean(translation.cached),
  });
  renderPosts();
  if (state.dialogPost?.id === post.id) syncDialogTranslation(post);
  if (translation.engine === 'gemini') {
    showToast('已用 Gemini 翻译');
    return;
  }
  showToast(translation.engine === 'deepl' ? '已用 DeepL 翻译' : '已翻译');
}

async function ensureTagCatalog() {
  if (state.tagCatalog) return state.tagCatalog;
  const payload = await api('/api/v1/tags');
  state.tagCatalog = payload.catalog || { version: '', tags: [] };
  return state.tagCatalog;
}

async function loadFeedTaggings(items = []) {
  const ids = [...new Set((items || []).map((item) => String(item?.resourceId || '').trim()).filter(Boolean))];
  if (!ids.length) return;
  await ensureTagCatalog();
  const params = new URLSearchParams({ resourceType: 'content-item' });
  for (const id of ids) params.append('resourceId', id);
  const payload = await api(`/api/v1/tagging?${params}`);
  const rows = payload.items || (payload.tagging ? [payload.tagging] : []);
  const next = { ...state.feedTaggings };
  for (const id of ids) {
    const row = rows.find((item) => item.resourceId === id);
    if (row) next[id] = row;
  }
  state.feedTaggings = next;
}

async function waitForTaggingJob(jobId) {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    await wait(1_000);
    const payload = await api(`/api/v1/tagging/jobs/${jobId}`, { timeoutMs: 15_000 });
    if (payload.status === 'completed') return payload.job.output || {};
    if (payload.status === 'failed' || payload.status === 'cancelled') {
      throw new Error(payload.job.error?.message || '标注未能完成');
    }
  }
  throw new Error('标注仍在进行，豆包还没停就请再等一会，或看 Worker 是否还在跑');
}

async function tagXBatch() {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  if (state.xTagging) return;
  const pending = pendingXTaggings();
  if (!pending.length) return;
  state.xTagging = true;
  renderXToolbar();
  try {
    const created = await api('/api/v1/tagging/analyze', {
      method: 'POST',
      body: JSON.stringify({
        resourceType: 'content-item',
        resourceIds: pending.map((item) => item.resourceId),
        limit: TAG_BATCH_SIZE,
      }),
    });
    const output = await waitForTaggingJob(created.jobId);
    await loadFeedTaggings(pending);
    renderPosts();
    renderXToolbar();
    const saved = Array.isArray(output.saved) ? output.saved.length : pending.filter((item) => taggingFor(item.resourceId)).length;
    if (saved) showToast(`已标注 ${saved} 条`);
    else showToast('这次没有新的 Tag，可再点一次');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '标注失败');
  } finally {
    state.xTagging = false;
    renderXToolbar();
  }
}

async function loadXFeed({ refresh = false } = {}) {
  if (!state.session) return;
  state.xLoading = true;
  state.xRefreshing = refresh;
  renderXToolbar();
  try {
    const params = new URLSearchParams({ platform: 'x', feed: state.xFeed, limit: '50' });
    if (refresh) params.set('refresh', '1');
    const payload = await api(`/api/v1/feed/x?${params}`, { timeoutMs: refresh ? 180_000 : 15_000 });
    state.xItems = payload.feed?.items || [];
    state.xFeed = payload.feed?.feed || state.xFeed;
    state.xNote = payload.feed?.note || '';
    hydrateFeedTranslations(state.xItems);
    await syncLocalTranslationsToServer(state.xItems);
    await loadFeedTaggings(state.xItems);
    renderPosts();
    renderXToolbar();
  } catch (error) {
    state.xNote = error instanceof Error ? error.message : 'X 时间线加载失败';
    renderXToolbar();
    throw error;
  } finally {
    state.xLoading = false;
    state.xRefreshing = false;
    renderXToolbar();
  }
}

async function loadBilibiliFeed({ url = '', refresh = false } = {}) {
  if (!state.session) return;
  state.bilibiliLoading = true;
  renderBilibiliToolbar();
  try {
    let payload;
    if (refresh && url) {
      payload = await api('/api/v1/feed/bilibili', {
        method: 'POST',
        body: JSON.stringify({ url }),
        timeoutMs: 180_000,
      });
    } else {
      payload = await api('/api/v1/feed/bilibili', { timeoutMs: 15_000 });
    }
    state.bilibiliItems = payload.feed?.items || [];
    state.bilibiliNote = payload.feed?.note || '';
    await loadFeedTaggings(state.bilibiliItems);
    renderPosts();
    renderBilibiliToolbar();
    if (refresh) {
      if (payload.feed?.mode === 'unavailable' || payload.feed?.note === '没有') {
        showToast('没有');
      } else if (payload.feed?.mode === 'live' && payload.feed?.items?.length) {
        showToast(`已写入 ${payload.feed.items[0].title || 'B站视频'}`);
      } else if (payload.feed?.mode === 'error') {
        showToast(payload.feed.note || 'B 站抓取失败');
      }
    }
  } catch (error) {
    state.bilibiliNote = error instanceof Error ? error.message : 'B 站抓取失败';
    renderBilibiliToolbar();
    throw error;
  } finally {
    state.bilibiliLoading = false;
    renderBilibiliToolbar();
  }
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

function refreshAfterStreamGap() {
  loadPosts().catch(() => {});
  loadXFeed({ refresh: false }).catch(() => {});
  loadBilibiliFeed({ refresh: false }).catch(() => {});
  loadNotes().catch(() => {});
  loadKnowledge().catch(() => {});
  if (document.body.dataset.view === 'ask') syncAskView().catch(() => {});
  if (state.session?.role === 'desktop') loadMetrics().catch(() => {});
  if (isQuotesView()) syncTradePaneData().catch(() => {});
}

function connectStream() {
  state.stream?.close();
  state.stream = new EventSource('/api/v1/events/stream');
  state.stream.addEventListener('ready', (event) => {
    setConnection('online', '实时连接');
    try {
      const payload = JSON.parse(event.data || '{}');
      if (payload.snapshotRequired) refreshAfterStreamGap();
    } catch {
      /* ready 帧损坏时仍保持在线，下次重连再对齐 */
    }
  });
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
  setIconButton(elements['open-settings'], 'settings');
  setIconButton(elements['reload-view'], 'refresh-cw');
  setIconButton(elements['ask-send'], 'send-horizontal');
  setIconButton(elements['open-compose'], 'plus');
  updateChangeSortControl();
  renderNav();
  renderChannels();
  renderPlatformFilters();
  renderXToolbar();
  renderBilibiliToolbar();
  renderTradeTabs();
  renderStockBoards();
  renderAssets();
  renderPortfolioSummary();
  renderHoldings();
  renderTools();
  renderSources();
  renderAsk();
  renderReport();
  renderSubscriptions();
  renderPosts();
  renderReferenceUi();
  restorePersistedFeedBrowseState();
  setView((location.hash || '#sources').slice(1));
  try {
    await pairFromUrl();
    const { ok, ...session } = await api('/api/v1/session');
    state.session = session;
    elements['server-name'].textContent = session.serverName;
    elements['session-description'].textContent = session.role === 'desktop'
      ? '本机管理端 · 可生成手机二维码'
      : `${session.device.name} · 已长期授权`;
    hideUnpairedPage();
    elements['device-repair-panel'].classList.toggle('hidden', session.role === 'desktop');
    if (session.role === 'desktop') {
      elements['pairing-panel'].classList.remove('hidden');
      elements['metrics-panel'].classList.remove('hidden');
    }
    state.extras.us = readExtras('us');
    state.extras.asia = readExtras('asia');
    state.bootstrapped = true;
    connectStream();
    logBehavior('app.open', { role: session.role });
    window.setInterval(() => {
      syncHarmonyLocalInspirations().catch(() => {});
      if (isQuotesView() && state.session) {
        if (state.tradePane === 'stocks') loadMarket().catch(() => {});
        if (state.tradePane === 'assets') loadGlobalAssets().catch(() => {});
        if (state.tradePane === 'holdings') loadHoldings().catch(() => {});
      }
    }, 30_000);
    const startupLoads = [
      syncHarmonyLocalInspirations().catch(() => {}),
      loadSourceCatalog().catch(() => {}),
      loadPosts().catch((error) => showToast(error.message)),
      loadXFeed({ refresh: false }).catch(() => {}),
      loadBilibiliFeed().catch(() => {}),
      loadNotes().catch(() => {}),
      loadKnowledge().catch(() => {}),
    ];
    if (document.body.dataset.view === 'ask') {
      startupLoads.push(syncAskView().catch((error) => showToast(error.message)));
    }
    if (session.role === 'desktop') {
      startupLoads.push(loadPairing().catch((error) => showToast(error.message)));
      startupLoads.push(loadMetrics().catch(() => {}));
    }
    if (isQuotesView()) {
      startupLoads.push(syncTradePaneData().catch((error) => showToast(error.message)));
    }
    if (document.body.dataset.view === 'sources') {
      startupLoads.push(loadSourcesPage().catch(() => {}));
    }
    await Promise.all(startupLoads);
    if (document.body.dataset.view === 'feed') restoreViewScroll('feed');
  } catch (error) {
    state.bootstrapped = true;
    setConnection('offline', '尚未连接');
    elements['session-description'].textContent = error.message;
    const url = new URL(window.location.href);
    const pairingFailed = url.searchParams.has('pair');
    if (pairingFailed) removePairingCodeFromAddress();
    showUnpairedPage(error.message, pairingFailed);
    if (isQuotesView()) {
      state.marketError = error.message || '此设备尚未配对，无法加载行情';
      renderMarketStatus();
    }
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
elements['exit-to-pairing'].addEventListener('click', () => exitAndRePair());
elements['restart-pairing'].addEventListener('click', () => exitAndRePair());
elements['retry-session'].addEventListener('click', () => window.location.reload());
elements['open-compose'].addEventListener('click', openHeaderAction);
elements['reload-view']?.addEventListener('click', () => {
  reloadCurrentView().catch((error) => showToast(error.message));
});
elements['open-settings'].addEventListener('click', () => setView('settings'));
elements['x-refresh']?.addEventListener('click', () => loadXFeed({ refresh: true }).catch((error) => showToast(error.message)));
elements['bilibili-import-form']?.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = String(elements['bilibili-url']?.value || '').trim();
  if (!url) {
    showToast('请先粘贴 B 站链接');
    return;
  }
  loadBilibiliFeed({ url, refresh: true }).catch((error) => showToast(error.message));
});
elements['x-translate']?.addEventListener('click', () => {
  translateXBatch().catch((error) => showToast(error.message));
});
elements['x-tag']?.addEventListener('click', () => {
  tagXBatch().catch((error) => showToast(error.message));
});
function bindPostLink(element, onClick) {
  if (!element) return;
  const run = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  };
  element.addEventListener('click', run);
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') run(event);
  });
}
bindPostLink(elements['dialog-source'], () => {
  const url = state.dialogPost?.sourceUrl;
  if (url) openExternalHttpUrl(url);
});
bindPostLink(elements['dialog-translate'], () => {
  if (!state.dialogPost) return;
  requestTranslate(state.dialogPost).catch((error) => showToast(error.message));
});
for (const id of ['compose-dialog', 'search-dialog', 'post-dialog', 'subscriptions-dialog', 'holding-dialog', 'reference-preview']) {
  const dialog = elements[id];
  dialog.querySelector('.dialog-close').addEventListener('click', () => {
    dialog.close();
    releaseDialogScroll();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (id === 'post-dialog') state.dialogPost = null;
    releaseDialogScroll();
    if (id === 'post-dialog') {
      window.setTimeout(() => { state.feedRestoreId = ''; }, 400);
    }
  });
  dialog.addEventListener('cancel', () => {
    window.setTimeout(releaseDialogScroll, 0);
  });
  new MutationObserver(() => {
    if (id === 'post-dialog' && !dialog.open) state.dialogPost = null;
    releaseDialogScroll();
  }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
}
let searchTimer = 0;
elements['symbol-search'].addEventListener('input', (event) => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => renderSearch(event.target.value), 280);
});
elements['market-filter'].addEventListener('input', (event) => {
  state.marketFilter = event.currentTarget.value;
  const market = currentMarket();
  if (market && state.stockBoard !== 'overview') renderWatchRows(elements['quote-list'], visibleWatchlist(market));
});
elements['asset-filter']?.addEventListener('input', (event) => {
  state.assetFilter = event.currentTarget.value;
  renderAssets();
});
function cycleChangeSort() {
  state.changeSort = state.changeSort === 'none' ? 'desc' : state.changeSort === 'desc' ? 'asc' : 'none';
  updateChangeSortControl();
  const market = currentMarket();
  if (state.tradePane === 'stocks' && market && state.stockBoard !== 'overview') {
    renderWatchRows(elements['quote-list'], visibleWatchlist(market));
  }
  if (state.tradePane === 'assets') renderAssets();
}
elements['market-sort'].addEventListener('click', cycleChangeSort);
elements['asset-sort']?.addEventListener('click', cycleChangeSort);
elements['note-ai-toggle'].addEventListener('click', () => {
  state.wantAi = !state.wantAi;
  elements['note-ai-toggle'].classList.toggle('is-on', state.wantAi);
  elements['note-ai-toggle'].setAttribute('aria-pressed', String(state.wantAi));
});
document.addEventListener('pointerdown', (event) => {
  const item = event.target.closest('.swipe-item');
  closeNoteSwipes(item?.querySelector('.swipe-front') || undefined);
});
elements['note-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  try {
    const captureChannel = elements['note-capture-channel'].value || 'web';
    await api('/api/v1/notes', {
      method: 'POST',
      body: JSON.stringify({
        title: elements['note-title'].value,
        body: elements['note-body'].value,
        wantAi: state.wantAi,
        sourceType: elements['note-source-type'].value,
        sourceUrl: elements['note-source-url'].value,
        sourceTitle: elements['note-source-title'].value,
        captureChannel,
        sourceApp: elements['note-source-app'].value,
      }),
    });
    elements['note-form'].reset();
    clearSharedInspirationDraft();
    state.wantAi = false;
    elements['note-ai-toggle'].classList.remove('is-on');
    elements['note-ai-toggle'].setAttribute('aria-pressed', 'false');
    showToast('已记下');
    await loadNotes();
    if (captureChannel === 'harmony-share' && typeof window.AICenterShareHost?.closeShare === 'function') {
      window.AICenterShareHost.closeShare();
    }
  } catch (error) {
    showToast(error.message);
  }
});
elements['ask-start'].addEventListener('click', () => openAskSession('new'));
elements['ask-back'].addEventListener('click', () => setView('ask'));
elements['reference-dock'].addEventListener('click', () => openAskSession('new'));
elements['ask-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  hideAskMentions();
  const form = event.currentTarget;
  const question = String(new FormData(form).get('question') || '').trim();
  if (!question) return;
  form.elements.question.value = '';
  void askAgent(question);
});
elements['ask-form'].elements.question.addEventListener('input', onAskComposerInput);
elements['ask-form'].elements.question.addEventListener('keydown', onAskComposerKeydown);
elements['ask-form'].elements.question.addEventListener('blur', () => {
  window.setTimeout(() => hideAskMentions(), 120);
});
restoreWebMode();
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncHarmonyLocalInspirations().catch(() => {});
});
window.addEventListener('scroll', () => {
  const view = document.body.dataset.view;
  if (!restoringViewScroll && view && viewScrollY.hasOwnProperty(view) && !document.body.classList.contains('is-dialog-open')) {
    viewScrollY[view] = window.scrollY;
  }
  const sentinel = document.getElementById('feed-sentinel');
  if (!sentinel || sentinel.dataset.done === '1') return;
  if (document.body.dataset.view !== 'feed') return;
  if (document.body.classList.contains('is-dialog-open')) return;
  if (sentinel.getBoundingClientRect().top < window.innerHeight + 160) revealMoreFeed();
}, { passive: true });
document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-nav]');
  if (trigger) setView(trigger.dataset.nav, { fromPrimaryNav: true });
});

initialize();
