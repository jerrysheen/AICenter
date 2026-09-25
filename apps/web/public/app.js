import {
  askPrompts, assetClasses, bookTabs, channels, feedItems, globalAssets, holdings, marketTabs,
  platformFilters, portfolioSummary, reportSections, stockBoards as fallbackStockBoards,
  subscriptions, tools, tradeLedger,
} from './mock.js?v=dev';
import { icon } from './icons.js?v=dev';
import { renderMarkdownInto } from './markdown.js?v=dev';
import { renderQuantLab } from './quant-lab.js?v=dev';

const platformLabels = { manual: '手工', bilibili: 'B站', x: 'X', xueqiu: '雪球', trendforce: 'TrendForce' };
const processingLabels = { subtitle: '字幕处理中', ai: 'AI 加工中' };
const isHarmonyShell = navigator.userAgent.includes('AI-Center-Harmony/');
const resetConnectionUri = 'aicenter://reset';

const state = {
  session: null,
  loginAvailable: false,
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
  markets: { overview: null, us: null, asia: null, cn: null },
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
  assetLedgerBusy: false,
  bootstrapped: false,
  extras: { us: [], asia: [], cn: [] },
  xItems: [],
  xFeed: 'following',
  xNote: '',
  xLoading: false,
  xRefreshing: false,
  xTranslating: false,
  xTagging: false,
  xPipeline: false,
  feedTaggings: {},
  tagCatalog: null,
  bilibiliItems: [],
  bilibiliNote: '',
  bilibiliLoading: false,
  trendforceItems: [],
  trendforceNote: '',
  trendforceLoading: false,
  trendforceRefreshing: false,
  xueqiuItems: [],
  xueqiuFeed: 'following',
  xueqiuNote: '',
  xueqiuLoading: false,
  xueqiuRefreshing: false,
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
  composeTarget: 'inspiration',
  dispatchAttachments: [],
  attachmentBlobUrls: {},
  taskContinueAttachments: [],
  taskContinuePackId: '',
  askSubmitting: false,
  askSessions: [],
  askSessionId: '',
  askDetail: null,
  askJobs: [],
  askProgressExpanded: new Set(),
  askComposerCompact: false,
  askThreadLastScrollTop: 0,
  referenceDraft: [],
  mentionItems: [],
  mentionIndex: 0,
  mentionRange: null,
  sourceCatalog: [],
  sourceSnapshots: {},
  staticBoard: null,
  staticBoardWindow: 'today',
  staticReleaseCountry: 'all',
  staticBoardLoading: false,
  staticBoardError: '',
  sourceLocalizations: {},
  sourceLocalizing: false,
  marketNativeBoard: null,
  marketNativeLoading: false,
  marketNativeError: '',
  hubLane: 'overview',
  overviewPane: 'home',
  overviewTimeline: 'latest',
  noteFilter: 'all',
  inspirePane: 'notes',
  taskFilter: 'all',
  selectedWorkPackageId: '',
  workPackages: [],
  workPackageTraces: {},
  workPackageProgressTimer: 0,
  workPackageProgressWatchId: '',
  workPackageProgressBusy: false,
  workPackageProgressFingerprint: '',
  taskContinueSelection: null,
  askMaterialTab: 'feed',
  sourceCatalogKind: 'all',
  sourceCatalogQuery: '',
  sourceLoading: false,
  viewReloading: false,
  hiddenFeedIds: new Set(),
  hiddenSourceIds: new Set(),
  focusIds: new Set(),
  focusItems: {},
  recentItems: {},
  lastOverviewTarget: '',
  feedQuery: '',
  showHeaderSearch: false,
  feedSort: 'captured',
  feedRange: 'all',
  feedPlatform: 'all',
  expandedFeedIds: new Set(),
  readerLang: 'translation',
  privacy: false,
  quotePeriod: '1d',
  quoteChart: null,
  quoteHistoryRequestId: 0,
  settingsPane: 'hub',
  pageKind: '',
  pageId: '',
  trail: [],
  originalBodies: {},
  officialBodies: {},
  articleAnalysis: {},
  runtimeJobs: [],
  runtimeJobsError: '',
};

const pageKinds = {
  article: { nav: 'sources', title: '阅读' },
  event: { nav: 'sources', title: '日程详情' },
  source: { nav: 'sources', title: '信源' },
  quote: { nav: 'market', title: '行情' },
  tasks: { nav: 'tools', title: '采集与处理' },
  task: { nav: 'tools', title: '任务详情' },
  note: { nav: 'inspire', title: '灵感详情' },
  account: { nav: 'assets', title: '账户明细' },
  holding: { nav: 'assets', title: '持仓详情' },
  automation: { nav: 'tools', title: '自动任务配置' },
  publish: { nav: 'tools', title: '快速发布' },
};

const hubLanes = [
  { id: 'overview', label: '总览', view: 'sources' },
  { id: 'feed', label: '信息流', view: 'feed' },
  { id: 'stocks', label: '股票', view: 'market' },
  { id: 'global', label: '全球行情', view: 'market/global' },
];

const overviewViews = ['sources', 'feed', 'market'];

const navItems = [
  { id: 'sources', label: '总览', icon: 'house' },
  { id: 'inspire', label: '灵感', icon: 'lightbulb' },
  { id: 'ask', label: '问答', icon: 'message-circle' },
  { id: 'assets', label: '资产', icon: 'wallet' },
  { id: 'tools', label: '工具', icon: 'layout-grid' },
];

const viewCopy = {
  sources: { title: '总览', subtitle: '行情、即将发生，以及已发布内容' },
  feed: { title: '信息流', subtitle: '已收录内容的统一时间线' },
  market: { title: '市场', subtitle: '股票观察池与全球行情报价' },
  assets: { title: '资产', subtitle: '持仓账本与个人资产分析' },
  tools: { title: '工具', subtitle: '知识库、日报和连接' },
  inspire: { title: '灵感', subtitle: '留下尚未完成的思考' },
  knowledge: { title: '知识库', subtitle: '可长期复用的规范内容' },
  ask: { title: '问答', subtitle: '研究记录，可回溯也可继续' },
  report: { title: '日报', subtitle: '跨模块汇总，先定结构' },
  quant: { title: '量化实验室', subtitle: 'Qlib 研究基线，不连接真实交易' },
  settings: { title: '设备与连接', subtitle: '信源、任务、自动化和配对' },
  page: { title: '详情', subtitle: '' },
};

const elements = Object.fromEntries([
  'connection-state', 'server-name', 'session-description', 'pairing-panel', 'pairing-qr',
  'network-address', 'pairing-code', 'refresh-pairing', 'unpaired-panel', 'unpaired-title',
  'unpaired-message', 'unpaired-hint', 'unpaired-actions', 'login-form', 'login-username', 'login-password', 'login-message', 'login-submit',
  'exit-to-pairing', 'retry-session', 'device-repair-panel', 'restart-pairing', 'request-process-restart', 'authorized-content',
  'authorized-feed', 'page-title', 'page-subtitle', 'post-form', 'post-title', 'post-body',
  'form-message', 'feed', 'feed-count', 'metrics-panel', 'metric-devices', 'metric-opens',
  'metric-published', 'metric-details', 'device-list', 'post-dialog', 'dialog-title',
  'dialog-body', 'dialog-translation', 'dialog-tags', 'dialog-source', 'dialog-save', 'dialog-cite', 'dialog-translate', 'dialog-time', 'dialog-notice', 'dialog-language', 'toast', 'channel-tabs',
  'platform-filters', 'follow-toolbar', 'bilibili-toolbar', 'bilibili-feed-status', 'bilibili-import-form', 'bilibili-url', 'bilibili-import', 'bilibili-more', 'x-toolbar', 'x-more', 'x-translate-bar', 'x-feed-status', 'x-translate-status', 'x-feed-tabs', 'x-refresh', 'x-translate', 'x-tag', 'xueqiu-toolbar', 'xueqiu-feed-tabs', 'xueqiu-feed-status', 'xueqiu-action-bar', 'xueqiu-action-status', 'xueqiu-refresh', 'trendforce-toolbar', 'trendforce-feed-status', 'trendforce-more', 'trendforce-action-bar', 'trendforce-action-status', 'trendforce-refresh', 'quote-filters', 'quote-list', 'tool-grid', 'strategy-inspect',
  'ask-records', 'ask-start', 'ask-session-list', 'ask-session-shell', 'ask-intro', 'ask-prompt-label',
  'ask-thread', 'ask-prompts', 'ask-materials', 'ask-material-tabs', 'ask-form', 'ask-send', 'ask-ref-chips', 'ask-ref-actions', 'ask-ref-export', 'ask-ref-task', 'ask-mention-menu', 'ask-live-chip', 'compose-dialog', 'reload-view', 'open-compose', 'open-settings', 'global-search',
  'side-nav-list', 'bottom-tab', 'market-tabs', 'book-tabs', 'holdings-list', 'holdings-filters', 'asset-filters',
  'asset-list', 'ledger-list', 'search-dialog', 'symbol-search', 'search-results',
  'static-source-groups', 'static-schedule-tabs', 'static-upcoming', 'static-schedule-list',
  'static-board-note', 'source-dialog', 'source-dialog-title', 'source-dialog-meta', 'source-dialog-items',
  'overview-home', 'overview-schedule', 'overview-catalog', 'overview-timeline', 'overview-timeline-tabs', 'overview-timeline-day',
  'open-source-catalog', 'open-full-schedule', 'schedule-back', 'catalog-back', 'source-catalog-filter', 'source-catalog-tabs',
  'inspire-subnav', 'inspire-notes-pane', 'inspire-tasks-pane',
  'note-filters', 'note-focus-entry', 'note-focus-hint',
  'task-filters', 'task-list', 'task-list-pane', 'task-detail-pane',
  'dispatch-plus', 'dispatch-plus-menu', 'dispatch-image', 'dispatch-target', 'dispatch-target-label',
  'dispatch-target-menu', 'dispatch-send',
  'source-tasks-dialog', 'source-tasks-title', 'source-tasks-meta', 'source-tasks-body',
  'market-native-predictions', 'market-native-derivatives', 'market-native-liquidity', 'market-native-note',
  'global-native-note',
  'note-form', 'note-body', 'note-title', 'note-source-url', 'note-source-title', 'note-source-type',
  'note-capture-channel', 'note-source-app', 'note-share-source', 'note-ai-toggle', 'note-list',
  'note-attachments', 'note-image-input',
  'knowledge-list', 'portfolio-summary',
  'report-list', 'open-subscriptions', 'subscriptions-dialog', 'subscription-list',
  'holding-dialog', 'holding-title', 'holding-meta', 'holding-metrics',
  'stock-boards', 'market-status', 'market-overview', 'market-head', 'market-table-scroll', 'market-sort', 'market-filter', 'market-filter-wrap',
  'asset-sort', 'asset-filter', 'asset-filter-wrap', 'asset-table-scroll',
  'market-sync-hint', 'book-sync-hint',   'analysis-period', 'analysis-kpis', 'analysis-ledger', 'analysis-trend', 'analysis-pie',
  'analysis-diagnosis-1', 'analysis-diagnosis-2',
  'holdings-note', 'holdings-head', 'holdings-moves', 'holdings-overview', 'holdings-group-detail',
  'holdings-group-title', 'holdings-group-moves', 'holdings-group-back', 'holdings-refresh', 'holdings-privacy',
  'reference-dock', 'reference-preview', 'reference-preview-title', 'reference-preview-meta', 'reference-preview-body',
  'reference-pack', 'reference-pack-meta', 'reference-pack-chips', 'reference-pack-ask', 'reference-pack-task',
  'reference-pack-export', 'reference-pack-clear',
  'share-image-dialog', 'share-image-preview', 'share-image-save',
  'hub-ticker', 'overview-subnav', 'nav-back', 'toggle-search', 'feed-filter', 'feed-open-calendar',
  'feed-filter-dialog', 'feed-filter-body', 'open-all-quotes', 'open-full-feed', 'hub-market-note',
  'page-root', 'settings-hub', 'settings-connections',
].map((id) => [id, document.getElementById(id)]));

const TRANSLATION_STORE_KEY = 'ai-center.translations.v1';
const TRANSLATION_STORE_LIMIT = 400;
const TRANSLATE_BATCH_SIZE = 30;
const TAG_BATCH_SIZE = 50;
const HIDDEN_SOURCES_KEY = 'ai-center.hidden-sources.v1';
const HIDDEN_FEED_KEY = 'ai-center.hidden-feed.v1';
const FOCUS_KEY = 'ai-center.focus-ids.v1';
const FOCUS_ITEMS_KEY = 'ai-center.focus-items.v1';
const RECENT_ITEMS_KEY = 'ai-center.recent-items.v1';
const RECENT_ITEMS_LIMIT = 80;
const AUTO_DRAFT_KEY = 'ai-center.automation-draft.v1';
const TASK_COMPOSE_DRAFT_KEY = 'ai-center.task-compose-draft.v1';
const TASK_CONTINUE_DRAFT_KEY = 'ai-center.task-continue-draft.v1';
const WORK_PACKAGE_PROGRESS_POLL_MS = 2500;
const INSPIRATION_BODY_MAX = 100_000;

function readJsonSet(key) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

function writeJsonSet(key, values) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...values]));
  } catch {}
}

function readJsonMap(key) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeJsonMap(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value || {}));
  } catch {}
}

state.hiddenSourceIds = readJsonSet(HIDDEN_SOURCES_KEY);
state.hiddenFeedIds = readJsonSet(HIDDEN_FEED_KEY);
state.focusIds = readJsonSet(FOCUS_KEY);
state.focusItems = readJsonMap(FOCUS_ITEMS_KEY);
state.recentItems = readJsonMap(RECENT_ITEMS_KEY);

function isFocused(id) {
  return state.focusIds.has(String(id || ''));
}

function itemIsFocused(item) {
  return isFocused(item?.id) || isFocused(item?.resourceId);
}

function isFeedFocusItem(item) {
  return Boolean(item && (
    item.kind === 'social'
    || item.kind === 'official'
    || item.release
    || item.platform
    || item.resourceType === 'content-item'
    || item.resourceType === 'official-release'
    || item.resourceType === 'post'
  ));
}

function snapshotFocusItem(item) {
  return {
    id: item.id,
    resourceId: item.resourceId || '',
    resourceType: item.resourceType || '',
    live: Boolean(item.live),
    kind: item.kind || 'social',
    platform: item.platform || '',
    externalId: item.externalId || '',
    author: item.author || '',
    handle: item.handle || '',
    time: item.time || '',
    title: item.title || '',
    body: item.body || '',
    excerpt: item.excerpt || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    sourceUrl: item.sourceUrl || '',
    processing: item.processing || '',
    createdAt: item.createdAt || 0,
    publishedAt: item.publishedAt || 0,
    isRead: Boolean(item.isRead),
    release: item.release || null,
  };
}

function persistFocusItems() {
  writeJsonMap(FOCUS_ITEMS_KEY, state.focusItems);
}

function rememberFocusItem(item) {
  if (!isFeedFocusItem(item) || !item.id) return;
  state.focusItems[String(item.id)] = snapshotFocusItem(item);
  persistFocusItems();
}

function forgetFocusItem(itemOrId) {
  const keys = new Set();
  if (itemOrId && typeof itemOrId === 'object') {
    for (const value of [itemOrId.id, itemOrId.resourceId]) {
      if (value) keys.add(String(value));
    }
  } else if (itemOrId) {
    keys.add(String(itemOrId));
  }
  let changed = false;
  for (const [id, snap] of Object.entries(state.focusItems)) {
    if (keys.has(id) || keys.has(String(snap?.id || '')) || keys.has(String(snap?.resourceId || ''))) {
      delete state.focusItems[id];
      changed = true;
    }
  }
  if (changed) persistFocusItems();
}

function toggleFocus(id, render, item) {
  const key = String(id || '');
  if (!key) return;
  if (state.focusIds.has(key)) {
    state.focusIds.delete(key);
    if (item?.resourceId) state.focusIds.delete(String(item.resourceId));
    forgetFocusItem(item || key);
  } else {
    state.focusIds.add(key);
    if (item) rememberFocusItem(item);
  }
  writeJsonSet(FOCUS_KEY, state.focusIds);
  if (typeof render === 'function') render();
}

function removeFocusItem(post) {
  for (const key of [post?.id, post?.resourceId]) {
    if (key) state.focusIds.delete(String(key));
  }
  forgetFocusItem(post);
  writeJsonSet(FOCUS_KEY, state.focusIds);
}

function persistRecentItems() {
  writeJsonMap(RECENT_ITEMS_KEY, state.recentItems);
}

function pruneRecentItems() {
  const rows = Object.entries(state.recentItems)
    .sort((left, right) => (Number(right[1]?.viewedAt) || 0) - (Number(left[1]?.viewedAt) || 0));
  if (rows.length <= RECENT_ITEMS_LIMIT) return;
  state.recentItems = Object.fromEntries(rows.slice(0, RECENT_ITEMS_LIMIT));
}

function rememberRecentItem(item) {
  if (!isFeedFocusItem(item) || !item.id) return;
  state.recentItems[String(item.id)] = {
    ...snapshotFocusItem(item),
    isRead: true,
    viewedAt: Date.now(),
  };
  pruneRecentItems();
  persistRecentItems();
}

function removeRecentItem(post) {
  for (const [id, snap] of Object.entries(state.recentItems)) {
    if (id === String(post?.id) || snap?.id === post?.id || (post?.resourceId && snap?.resourceId === post.resourceId)) {
      delete state.recentItems[id];
    }
  }
  persistRecentItems();
}

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
  if (post.translation?.text) {
    state.translations[post.id] = {
      text: post.translation.text,
      engine: post.translation.engine || '',
      cached: true,
    };
    return state.translations[post.id];
  }
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

function textNeedsZhView(sourceText) {
  const source = String(sourceText || '').trim();
  if (!source) return false;
  const hangul = (source.match(/\p{Script=Hangul}/gu) || []).length;
  const latin = (source.match(/[A-Za-z]/g) || []).length;
  const han = (source.match(/\p{Script=Han}/gu) || []).length;
  if (hangul === 0 && latin === 0) return false;
  const foreign = hangul + latin;
  if (hangul >= 2 && hangul >= han && hangul >= latin) return true;
  if (han >= 12) return false;
  if (han >= 8 && foreign < Math.max(8, Math.ceil(han * 0.25))) return false;
  return latin >= 8 || hangul >= 2;
}

function postNeedsChineseTranslation(post) {
  return textNeedsZhView(post?.body);
}

function mergeLocalizations(payload) {
  const incoming = payload?.localizations;
  if (!incoming || typeof incoming !== 'object') return;
  state.sourceLocalizations = { ...state.sourceLocalizations, ...incoming };
}

function postIsTranslating(post) {
  if (!postNeedsChineseTranslation(post) || translationFor(post)) return false;
  return Boolean(post?.platform === 'x' && state.xTranslating);
}

function localizedCopy(id, fallback = '') {
  const row = state.sourceLocalizations[id];
  if (row?.text) return row.text;
  if (row?.pending && state.sourceLocalizing) return '正在翻译…';
  return fallback || '';
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
    .sort((left, right) => (right.capturedAt || right.createdAt || right.publishedAt || 0)
      - (left.capturedAt || left.createdAt || left.publishedAt || 0))
    .slice(0, limit);
}

function xTaskBusy() {
  return state.xLoading || state.xTranslating || state.xTagging || state.xPipeline;
}

function tagNames(tagIds = []) {
  const catalog = new Map((state.tagCatalog?.tags || []).map((tag) => [tag.id, tag.name]));
  return tagIds.map((id) => catalog.get(id) || id);
}

function postTagging(item) {
  return taggingFor(item?.resourceId) || taggingFor(item?.id);
}

function postTagNames(item) {
  const row = postTagging(item);
  if (row && Array.isArray(row.tags)) return tagNames(row.tags);
  return (Array.isArray(item?.tags) ? item.tags : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
}

function createTagRow(names) {
  const labels = [...new Set((names || []).map((name) => String(name || '').trim()).filter(Boolean))];
  if (!labels.length) return null;
  const row = document.createElement('div');
  row.className = 'tags';
  for (const name of labels) {
    row.append(Object.assign(document.createElement('span'), { textContent: name }));
  }
  return row;
}

const triedTagHydration = new Set();

function ensurePostTags(post) {
  const id = String(post?.resourceId || '').trim();
  if (!id || postTagging(post) || triedTagHydration.has(id)) return;
  triedTagHydration.add(id);
  loadFeedTaggings([post]).then(() => {
    if (state.pageKind === 'article') renderArticlePage();
    renderPosts();
    if (typeof renderOverviewTimeline === 'function') renderOverviewTimeline();
  }).catch(() => {});
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
  renderAskLiveUi();
}

function isPrimaryNavActive(navId, view) {
  if (view === 'page') {
    const mapped = pageKinds[state.pageKind]?.nav || 'sources';
    if (navId === 'sources') return mapped === 'sources';
    if (navId === 'tools') return mapped === 'tools';
    return navId === mapped;
  }
  if (navId === 'sources') return overviewViews.includes(view);
  if (navId === 'tools') return view === 'tools' || view === 'knowledge' || view === 'report' || view === 'settings' || view === 'quant';
  return navId === view;
}

function resolveView(name) {
  if (name === 'trade') return 'market';
  if (name === 'account') return 'settings';
  if (pageKinds[name]) return 'page';
  return viewCopy[name] ? name : 'sources';
}

function parseLocation(name = (location.hash || '#sources').slice(1)) {
  const raw = String(name || 'sources').replace(/^#/, '');
  const [head, ...rest] = raw.split('/');
  const view = resolveView(head);
  const marketPane = view === 'market' && rest[0] === 'global' ? 'assets' : (view === 'market' ? 'stocks' : '');
  const askSessionId = view === 'ask' && rest[0] ? rest.join('/') : '';
  const sourcesPane = view === 'sources' && ['catalog', 'schedule'].includes(rest[0]) ? rest[0] : 'home';
  const settingsPane = view === 'settings' && rest[0] === 'connections' ? 'connections' : (view === 'settings' ? 'hub' : '');
  const inspirePane = view === 'inspire' && rest[0] === 'tasks' ? 'tasks' : (view === 'inspire' ? 'notes' : '');
  const selectedWorkPackageId = view === 'inspire' && rest[0] === 'tasks' && /^[0-9a-f-]{36}$/i.test(rest[1] || '')
    ? rest[1]
    : '';
  const pageKind = pageKinds[head] ? head : '';
  const pageId = pageKind ? rest.join('/') : '';
  return { view, askSessionId, marketPane, sourcesPane, settingsPane, inspirePane, selectedWorkPackageId, pageKind, pageId };
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

function pageHash(kind = state.pageKind, id = state.pageId) {
  return id ? `#${kind}/${id}` : `#${kind}`;
}

function openPage(kind, id = '', { back = false } = {}) {
  if (!back && (document.body.dataset.view !== 'page' || state.pageKind !== kind || state.pageId !== String(id || ''))) {
    state.trail.push(location.hash || '#sources');
  }
  setView(id ? `${kind}/${id}` : kind, { back });
}

function goBack() {
  const previous = state.trail.pop();
  if (previous) {
    setView(previous.replace(/^#/, ''), { back: true });
    return;
  }
  setView('sources', { back: true });
}

function leaveArticle() {
  if (state.trail.length) {
    goBack();
    return;
  }
  setView('feed', { back: true });
}

function syncHeaderSearch() {
  document.body.classList.toggle('search-open', Boolean(state.showHeaderSearch));
  if (elements['toggle-search']) {
    elements['toggle-search'].hidden = document.body.dataset.view === 'ask';
    setIconButton(elements['toggle-search'], state.showHeaderSearch ? 'x' : 'search');
  }
  if (elements['nav-back']) {
    const showBack = document.body.dataset.view === 'page'
      || (document.body.dataset.view === 'settings' && state.settingsPane === 'connections')
      || (document.body.dataset.view === 'sources' && state.overviewPane !== 'home')
      || (document.body.dataset.view === 'inspire' && Boolean(state.selectedWorkPackageId))
      || (document.body.dataset.view === 'ask' && Boolean(state.askSessionId));
    elements['nav-back'].classList.toggle('hidden', !showBack);
    setIconButton(elements['nav-back'], 'chevron-left');
  }
}

function setView(name, options = {}) {
  persistTaskDraftsFromDom();
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
  if (view === 'sources') state.overviewPane = parsed.sourcesPane || 'home';
  if (view === 'settings') state.settingsPane = parsed.settingsPane || 'hub';
  if (view === 'inspire') state.inspirePane = parsed.inspirePane || 'notes';
  state.selectedWorkPackageId = view === 'inspire' ? (parsed.selectedWorkPackageId || '') : '';
  if (view === 'inspire' && previous !== 'inspire' && !state.selectedWorkPackageId) {
    state.composeTarget = state.inspirePane === 'tasks' ? 'task' : 'inspiration';
  }
  state.pageKind = view === 'page' ? parsed.pageKind : '';
  state.pageId = view === 'page' ? parsed.pageId : '';
  if ((view !== 'page' || parsed.pageKind !== 'article') && !elements['post-dialog']?.open) {
    state.dialogPost = null;
  }
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
    elements['page-title'].textContent = state.tradePane === 'assets' ? '全球行情' : '股票';
    elements['page-subtitle'].textContent = state.tradePane === 'assets'
      ? '指数、外汇、利率、国债、贵金属、能源与加密'
      : '总览工作日白天看 A 股/港股，17:00 后到次日 05:00 看美股；亚洲观察池仍单独成页';
  } else if (view === 'page') {
    elements['page-title'].textContent = pageKinds[state.pageKind]?.title || '详情';
    elements['page-subtitle'].textContent = '';
  } else if (view === 'settings') {
    elements['page-title'].textContent = state.settingsPane === 'connections' ? '设备连接' : '设备与连接';
    elements['page-subtitle'].textContent = viewCopy.settings.subtitle;
  } else if (view === 'inspire') {
    elements['page-title'].textContent = state.selectedWorkPackageId ? '任务详情' : '灵感';
    elements['page-subtitle'].textContent = state.selectedWorkPackageId
      ? ''
      : state.inspirePane === 'tasks'
        ? '每条任务在本机 Cursor 开独立窗口，完成后自己写回这里'
        : viewCopy.inspire.subtitle;
    syncInspirePanes();
  } else if (view === 'ask') {
    applyAskHeaderCopy();
  } else {
    elements['page-title'].textContent = viewCopy[view].title;
    elements['page-subtitle'].textContent = viewCopy[view].subtitle;
  }
  syncWorkPackageProgressWatch();
  updateHeaderAction(view);
  renderOverviewLanes();
  syncHeaderSearch();
  if (view === 'inspire') loadNotes().catch((error) => showToast(error.message));
  if (view === 'knowledge') loadKnowledge().catch((error) => showToast(error.message));
  if (view === 'market' || view === 'assets') {
    alignTradePane(view);
    renderTradeTabs();
    if (state.bootstrapped) syncTradePaneData().catch((error) => showToast(error.message));
  }
  if (view === 'sources') syncOverviewPanes();
  if (view === 'sources' && state.bootstrapped) loadSourcesPage().catch((error) => showToast(error.message));
  if (view === 'feed' && state.bootstrapped && !state.staticBoard) {
    loadStaticSignalBoard().catch((error) => showToast(error.message));
  }
  if (view === 'ask') syncAskView().catch((error) => showToast(error.message));
  if (view === 'tools' && state.bootstrapped) loadDividendInspection().catch((error) => showToast(error.message));
  if (view === 'quant') renderQuantPage().catch((error) => showToast(error.message));
  if (view === 'settings') renderSettingsHub();
  if (view === 'page') renderPage();
  renderAskLiveUi();
  renderReferenceUi();
  const nextHash = view === 'ask'
    ? askHash(state.askSessionId)
    : view === 'market'
      ? overviewHash(state.tradePane === 'assets' ? 'global' : 'stocks')
      : view === 'sources' && state.overviewPane !== 'home'
        ? `#sources/${state.overviewPane}`
        : view === 'settings' && state.settingsPane === 'connections'
          ? '#settings/connections'
          : view === 'page'
            ? pageHash()
            : view === 'inspire' && state.inspirePane === 'tasks'
              ? (state.selectedWorkPackageId ? `#inspire/tasks/${state.selectedWorkPackageId}` : '#inspire/tasks')
              : `#${view}`;
  if (location.hash !== nextHash) history.replaceState({}, '', `${location.pathname}${location.search}${nextHash}`);
  if (leaving) restoreViewScroll(view);
  persistFeedBrowseState();
  syncAskKeyboard();
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

function bootUiRevision() {
  return document.querySelector('meta[name="ai-center-ui-revision"]')?.getAttribute('content') || '';
}

async function fetchUiRevision() {
  const payload = await api('/api/v1/ui/revision');
  return String(payload.revision || '');
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function settleUiRevision(read = fetchUiRevision) {
  let last = await read();
  let stable = 1;
  for (let i = 1; i < 8 && stable < 3; i += 1) {
    await sleep(450);
    const next = await read().catch(() => last);
    if (next === last) stable += 1;
    else {
      last = next;
      stable = 1;
    }
  }
  return last;
}

function forceReloadShell(revision, { bust = false } = {}) {
  const base = String(revision || '').trim() || String(Date.now());
  const next = bust ? `${base}-${Date.now()}` : base;
  try {
    if (!bust && sessionStorage.getItem('ai-center.ui-reload') === next) return false;
    sessionStorage.setItem('ai-center.ui-reload', bust ? base : next);
  } catch {
    // sessionStorage 不可用时仍整页重载。
  }
  window.aiCenterUiReloading = true;
  const url = new URL(location.href);
  url.searchParams.set('v', next);
  location.replace(`${url.pathname}${url.search}${location.hash}`);
  return true;
}

let shellReloadPending = null;

async function reloadShellWhenStable(revision) {
  if (window.aiCenterUiReloading) return false;
  if (shellReloadPending) return shellReloadPending;
  const hinted = String(revision || '').trim();
  if (hinted && hinted === bootUiRevision()) return false;
  showToast('界面已更新，正在加载新版本');
  shellReloadPending = (async () => {
    try {
      const local = bootUiRevision();
      const remote = await settleUiRevision();
      if (window.aiCenterUiReloading) return false;
      if (!remote || remote === local) return false;
      return forceReloadShell(remote);
    } finally {
      if (!window.aiCenterUiReloading) shellReloadPending = null;
    }
  })();
  return shellReloadPending;
}

async function maybeReloadStaleShell() {
  if (window.aiCenterUiBoot) {
    const boot = await window.aiCenterUiBoot.catch(() => null);
    if (boot?.reloading || window.aiCenterUiReloading) return true;
  }
  const remote = await fetchUiRevision().catch(() => '');
  const local = bootUiRevision();
  if (!remote || !local || remote === local) return false;
  return reloadShellWhenStable(remote);
}

async function reloadCurrentView({ forceShell = false } = {}) {
  if (state.viewReloading) return;
  const button = elements['reload-view'];
  state.viewReloading = true;
  button?.classList.add('is-spinning');
  button?.setAttribute('aria-busy', 'true');
  try {
    const remote = await fetchUiRevision().catch(() => '');
    const local = bootUiRevision();
    if (forceShell) {
      showToast('正在强制更新界面');
      forceReloadShell(remote || local, { bust: true });
      return;
    }
    if (remote && local && remote !== local) {
      await reloadShellWhenStable(remote);
      return;
    }
    if (!state.session) throw new Error('尚未连接，无法刷新');
    const view = document.body.dataset.view;
    const tasks = [];
    if (view === 'feed' || view === 'sources') {
      tasks.push(loadPosts());
      tasks.push(loadXFeed({ refresh: false }));
      tasks.push(loadXueqiuFeed({ refresh: false }));
      tasks.push(loadBilibiliFeed({ refresh: false }));
    }
    if (view === 'sources') tasks.push(loadSourcesPage({ refresh: true }));
    if (view === 'inspire') tasks.push(loadNotes());
    if (view === 'ask') tasks.push(syncAskView());
    if (view === 'market') tasks.push(syncTradePaneData({ refresh: true }));
    if (view === 'assets') {
      tasks.push(state.tradePane === 'holdings' ? loadHoldings({ refresh: true }) : syncTradePaneData());
    }
    if (view === 'knowledge') tasks.push(loadKnowledge());
    if (view === 'tools') {
      tasks.push(loadSourceCatalog());
      tasks.push(loadKnowledge());
      tasks.push(loadDividendInspection());
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

function forgetLegacyDeviceGrant() {
  try {
    window.localStorage.removeItem('ai-center.device-token');
    window.sessionStorage.removeItem('ai-center.device-token');
  } catch (_error) {
    // 旧退路留下的本地 token 清不掉也不影响 Cookie 登录。
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
      error.payload = payload;
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
  persistFeedBrowseState();
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

function renderQuantPage() {
  const root = document.getElementById('quant-lab');
  if (!root) return Promise.resolve();
  if (renderQuantPage.timer) {
    window.clearInterval(renderQuantPage.timer);
    renderQuantPage.timer = 0;
  }
  return renderQuantLab(root, {
    api,
    showToast,
    onLive(live) {
      if (!live || document.body.dataset.view !== 'quant') return;
      renderQuantPage.timer = window.setInterval(() => {
        if (document.body.dataset.view !== 'quant') {
          window.clearInterval(renderQuantPage.timer);
          renderQuantPage.timer = 0;
          return;
        }
        renderQuantPage().catch((error) => showToast(error.message));
      }, 4000);
    },
  });
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

function guessDeviceName() {
  return /Mobile|HarmonyOS|Android|iPhone/i.test(navigator.userAgent) ? '我的鸿蒙手机' : '浏览器设备';
}

function showUnpairedPage(message, pairingFailed = false, options = {}) {
  state.session = null;
  state.stream?.close();
  const loginAvailable = Boolean(options.loginAvailable);
  state.loginAvailable = loginAvailable;
  document.body.classList.add('is-unpaired');
  document.body.classList.remove('is-ready');
  elements['unpaired-panel'].classList.remove('hidden');
  if (elements['unpaired-actions']) elements['unpaired-actions'].classList.remove('hidden');
  elements['unpaired-panel'].querySelector('.connection-gate-card')?.classList.toggle('has-login', loginAvailable);
  if (elements['login-form']) elements['login-form'].classList.toggle('hidden', !loginAvailable);
  if (elements['login-message']) {
    elements['login-message'].classList.add('hidden');
    elements['login-message'].textContent = '';
  }
  if (pairingFailed) {
    elements['unpaired-title'].textContent = '配对没有完成';
    elements['unpaired-message'].textContent = message || '请回到电脑上的 AI Center，刷新二维码后重新扫描。';
  } else if (loginAvailable) {
    elements['unpaired-title'].textContent = '登录 AI Center';
    elements['unpaired-message'].textContent = message || '输入账号密码，或回到电脑端扫描二维码。';
  } else {
    elements['unpaired-title'].textContent = '这台设备尚未配对';
    elements['unpaired-message'].textContent = message || '请回到电脑上的 AI Center，刷新二维码后重新扫描。';
  }
  elements['exit-to-pairing'].textContent = isHarmonyShell ? '退出并重新扫码' : '清除连接并重新扫码';
  if (elements['unpaired-hint']) {
    elements['unpaired-hint'].textContent = loginAvailable
      ? '账号登录与扫码配对都会签发同一份设备授权。'
      : '二维码 10 分钟内有效且只能使用一次。';
  }
}

async function revealUnpairedPage(message, pairingFailed = false) {
  let loginAvailable = state.loginAvailable === true;
  try {
    await api('/api/v1/session');
  } catch (error) {
    if (error?.payload && typeof error.payload === 'object' && 'loginAvailable' in error.payload) {
      loginAvailable = Boolean(error.payload.loginAvailable);
    }
  }
  showUnpairedPage(message, pairingFailed, { loginAvailable });
}

function hideUnpairedPage() {
  document.body.classList.remove('is-unpaired');
  document.body.classList.add('is-ready');
  elements['unpaired-panel'].classList.add('hidden');
  if (elements['unpaired-actions']) elements['unpaired-actions'].classList.add('hidden');
  elements['unpaired-panel'].querySelector('.connection-gate-card')?.classList.remove('has-login');
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
  forgetLegacyDeviceGrant();

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

  await revealUnpairedPage('当前浏览器连接已清除。可直接登录，或回到电脑端刷新二维码后重新扫描。');
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
const FEED_BROWSE_KEY = 'ai-center.feed-browse';
const LAST_LOCATION_KEY = 'ai-center.last-location';
let pageScrollY = 0;
let feedObserver = null;
let restoringViewScroll = false;
let pendingFeedDialogId = '';
const viewScrollY = Object.fromEntries(Object.keys(viewCopy).map((name) => [name, 0]));

function persistFeedBrowseState() {
  try {
    const view = document.body.dataset.view || '';
    if (view === 'feed' && !document.body.classList.contains('is-dialog-open')) {
      viewScrollY.feed = window.scrollY;
      const cards = [...document.querySelectorAll('#feed .post-card[data-post-id]')];
      const visible = cards.find((card) => card.getBoundingClientRect().bottom > 96);
      if (visible?.dataset.postId) state.feedAnchorId = visible.dataset.postId;
    }
    window.localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({
      hash: location.hash || '#sources',
      platform: state.feedPlatform || state.platform,
      xFeed: state.xFeed,
      xueqiuFeed: state.xueqiuFeed,
      channel: state.channel,
    }));
    window.localStorage.setItem(FEED_BROWSE_KEY, JSON.stringify({
      y: viewScrollY.feed || 0,
      anchorId: state.feedAnchorId || '',
      restoreId: state.feedRestoreId || '',
      dialogPostId: state.dialogPost?.id || '',
      shown: state.feedShown,
      platform: state.feedPlatform || state.platform,
      channel: state.channel,
      xFeed: state.xFeed,
      xueqiuFeed: state.xueqiuFeed,
    }));
  } catch {}
}

function restorePersistedFeedBrowseState() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FEED_BROWSE_KEY)
      || window.sessionStorage.getItem(FEED_BROWSE_KEY)
      || 'null');
    if (!saved) return null;
    if (Number.isFinite(saved.y)) viewScrollY.feed = saved.y;
    if (saved.anchorId) state.feedAnchorId = saved.anchorId;
    if (saved.restoreId) state.feedRestoreId = saved.restoreId;
    if (Number.isFinite(saved.shown) && saved.shown > state.feedShown) {
      state.feedShown = saved.shown;
    }
    if (saved.platform) {
      state.platform = saved.platform;
      state.feedPlatform = saved.platform;
    }
    if (saved.channel) state.channel = saved.channel;
    if (saved.xFeed) state.xFeed = saved.xFeed;
    if (saved.xueqiuFeed) state.xueqiuFeed = saved.xueqiuFeed;
    pendingFeedDialogId = saved.dialogPostId || pendingFeedDialogId;
    return saved;
  } catch {
    return null;
  }
}

function restoreLastLocationHash() {
  if (location.hash && location.hash !== '#') return location.hash;
  try {
    const saved = JSON.parse(window.localStorage.getItem(LAST_LOCATION_KEY) || 'null');
    return saved?.hash || '#sources';
  } catch {
    return '#sources';
  }
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

function restoreOpenFeedItem() {
  pendingFeedDialogId = '';
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
  return ['compose-dialog', 'search-dialog', 'post-dialog', 'subscriptions-dialog', 'holding-dialog', 'reference-preview', 'reference-pack', 'feed-filter-dialog', 'source-tasks-dialog']
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
    kind: 'social',
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
    publishedAt: post.createdAt,
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
  const body = translationFor(post)?.text || post.body;
  const parts = [post.author, post.handle, body].filter(Boolean);
  return parts.join('\n\n');
}

function clipInspirationBody(body) {
  const text = String(body || '').trim();
  if (text.length <= INSPIRATION_BODY_MAX) return { body: text, clipped: false };
  return { body: text.slice(0, INSPIRATION_BODY_MAX), clipped: true };
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
  state.composeTarget = 'inspiration';
  setView('inspire');
  syncDispatchComposer();
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
      showToast('已保存为灵感，打开查看。取消收藏不会删除原文。');
      setView('inspire');
      setInspirationExpanded(existing.id, true);
      return;
    }
    showToast('已保存过这条内容。删除请进入灵感后单独确认。');
    setView('inspire');
    return;
  }
  const clipped = clipInspirationBody(inspirationBodyFromPost(post));
  const payload = await api('/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify({
      body: clipped.body,
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
  showToast(clipped.clipped ? '已加入灵感。正文超过存储上限，已保存前 10 万字；完整内容看来源链接。' : '已加入灵感');
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
  const trendforceIndex = state.trendforceItems.findIndex((item) => item.id === post.id || item.resourceId === post.resourceId);
  const xueqiuIndex = state.xueqiuItems.findIndex((item) => item.id === post.id || item.resourceId === post.resourceId);
  const liveIndex = state.posts.findIndex((item) => item.id === post.id);
  return {
    post,
    xItem: xIndex >= 0 ? state.xItems[xIndex] : null,
    xIndex,
    biliItem: biliIndex >= 0 ? state.bilibiliItems[biliIndex] : null,
    biliIndex,
    trendforceItem: trendforceIndex >= 0 ? state.trendforceItems[trendforceIndex] : null,
    trendforceIndex,
    xueqiuItem: xueqiuIndex >= 0 ? state.xueqiuItems[xueqiuIndex] : null,
    xueqiuIndex,
    liveItem: liveIndex >= 0 ? state.posts[liveIndex] : null,
    liveIndex,
  };
}

function feedHideKeys(post) {
  const platform = String(post?.platform || '').trim();
  const externalId = String(post?.externalId || '').trim();
  return [
    post?.id,
    post?.resourceId,
    externalId && platform ? `${platform}:${externalId}` : '',
    externalId && !platform ? externalId : '',
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function isHiddenFeedItem(item) {
  return feedHideKeys(item).some((key) => state.hiddenFeedIds.has(key));
}

function persistHiddenFeedIds() {
  writeJsonSet(HIDDEN_FEED_KEY, state.hiddenFeedIds);
}

function restoreStashedFeedItem(stash) {
  for (const key of feedHideKeys(stash.post)) state.hiddenFeedIds.delete(key);
  persistHiddenFeedIds();
  if (stash.xItem) state.xItems = insertFeedListItem(state.xItems, stash.xItem, stash.xIndex);
  if (stash.biliItem) state.bilibiliItems = insertFeedListItem(state.bilibiliItems, stash.biliItem, stash.biliIndex);
  if (stash.trendforceItem) state.trendforceItems = insertFeedListItem(state.trendforceItems, stash.trendforceItem, stash.trendforceIndex);
  if (stash.xueqiuItem) state.xueqiuItems = insertFeedListItem(state.xueqiuItems, stash.xueqiuItem, stash.xueqiuIndex);
  if (stash.liveItem) state.posts = insertFeedListItem(state.posts, stash.liveItem, stash.liveIndex);
}

function dropFeedItemLocally(post) {
  for (const key of feedHideKeys(post)) state.hiddenFeedIds.add(key);
  persistHiddenFeedIds();
  state.posts = state.posts.filter((item) => item.id !== post.id);
  state.xItems = state.xItems.filter((item) => item.id !== post.id && item.resourceId !== post.resourceId);
  state.bilibiliItems = state.bilibiliItems.filter((item) => item.id !== post.id && item.resourceId !== post.resourceId);
  state.trendforceItems = state.trendforceItems.filter((item) => item.id !== post.id && item.resourceId !== post.resourceId);
  state.xueqiuItems = state.xueqiuItems.filter((item) => item.id !== post.id && item.resourceId !== post.resourceId);
}

function markFeedItemRead(post) {
  if (!post?.id) return;
  rememberRecentItem(post);
  if (post.isRead) return;
  post.isRead = true;
  for (const list of [state.xItems, state.bilibiliItems, state.trendforceItems, state.xueqiuItems, state.posts]) {
    const hit = list.find((item) => item.id === post.id || (post.resourceId && item.resourceId === post.resourceId));
    if (hit) hit.isRead = true;
  }
  const snap = state.focusItems[post.id] || (post.resourceId && state.focusItems[post.resourceId]);
  if (snap) {
    snap.isRead = true;
    persistFocusItems();
  }
  const contentItemId = post.resourceType === 'content-item' ? post.resourceId : '';
  if (!contentItemId || !state.session) return;
  api(`/api/v1/content-items/${contentItemId}/state`, {
    method: 'PATCH',
    body: JSON.stringify({ isRead: true }),
  }).catch(() => {});
}

async function hideFeedItem(post) {
  if (itemIsFocused(post)) rememberFocusItem(post);
  if (state.recentItems[post?.id] || (post?.resourceId && Object.values(state.recentItems).some((item) => item.resourceId === post.resourceId))) {
    rememberRecentItem(post);
  }
  const contentItemId = post.resourceType === 'content-item' ? post.resourceId : '';
  const isManual = post.platform === 'manual' && post.live;
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
    showToast(error.message || '已从本机信息流删除');
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
  const platform = provider === 'bilibili' || provider === 'x' || provider === 'trendforce' || provider === 'xueqiu' ? provider : 'manual';
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
    tags: postTagNames({ ...item, resourceId: item.id }),
    sourceUrl: item.sourceUrl || '',
    createdAt: item.publishedAt || item.createdAt || Date.now(),
  };
}

function findFeedPost(ref) {
  const id = String(ref.resourceId || '');
  return [...state.posts, ...state.xItems, ...state.bilibiliItems, ...state.trendforceItems, ...state.xueqiuItems]
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
  if (footer.evidence) {
    const bits = [];
    if (Number.isFinite(Number(footer.evidence.confidence))) {
      bits.push(`证据置信 ${Number(footer.evidence.confidence).toFixed(2)}`);
    }
    if (Number.isFinite(Number(footer.evidence.sufficiency))) {
      bits.push(`充分度 ${Number(footer.evidence.sufficiency).toFixed(2)}`);
    }
    const accepted = Number(footer.evidence.acceptedCount);
    const rejected = Number(footer.evidence.rejectedCount);
    if (Number.isFinite(accepted) || Number.isFinite(rejected)) {
      bits.push(`采用 ${Number.isFinite(accepted) ? accepted : 0}，筛掉 ${Number.isFinite(rejected) ? rejected : 0}`);
    }
    if (bits.length) {
      section.append(Object.assign(document.createElement('p'), {
        className: 'ask-source-evidence',
        textContent: bits.join(' · '),
      }));
    }
  }
  card.append(section);
}

function renderAskRefChips() {
  const host = elements['ask-ref-chips'];
  if (!host) return;
  host.replaceChildren(...state.referenceDraft.map((ref, index) => createRefChip(ref, index, { removable: true })));
  host.classList.toggle('hidden', !state.referenceDraft.length);
  elements['ask-ref-actions']?.classList.toggle('hidden', !state.referenceDraft.length);
}

function renderReferenceDock() {
  const dock = elements['reference-dock'];
  if (!dock) return;
  const count = state.referenceDraft.length;
  dock.textContent = count ? `材料 ${count} 条` : '材料 0 条';
  dock.classList.toggle('hidden', count === 0);
}

function renderReferencePackDialog() {
  const chips = elements['reference-pack-chips'];
  const meta = elements['reference-pack-meta'];
  if (chips) {
    chips.replaceChildren(...state.referenceDraft.map((ref, index) => createRefChip(ref, index, { removable: true })));
  }
  if (meta) {
    meta.textContent = state.referenceDraft.length
      ? `已选 ${state.referenceDraft.length} 条。同一组可以导出、发给任务或带去问答。`
      : '还没有材料。信息流或灵感里点引用即可加入。';
  }
}

function renderReferenceUi() {
  renderAskRefChips();
  renderReferenceDock();
  if (elements['reference-pack']?.open) renderReferencePackDialog();
}

function openReferencePack() {
  if (!state.referenceDraft.length) {
    showToast('先在信息流或灵感里点引用');
    return;
  }
  renderReferencePackDialog();
  openDialog(elements['reference-pack']);
}

function closeReferencePack() {
  elements['reference-pack']?.close();
  releaseDialogScroll();
}

async function fetchReferencePack() {
  if (!state.referenceDraft.length) {
    showToast('先选几条材料');
    return null;
  }
  const payload = await api('/api/v1/context/pack', {
    method: 'POST',
    body: JSON.stringify({ references: draftPayload() }),
  });
  if (!payload?.pack?.markdown) {
    showToast('这组材料现在读不出来');
    return null;
  }
  if (payload.pack.missing?.length) {
    showToast(`有 ${payload.pack.missing.length} 条已经找不到，先导出能读到的`);
  }
  return payload.pack;
}

async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* 下面用 execCommand 兜住 */ }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function packDownloadName(title) {
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = String(title || '材料包').replace(/[\\/:*?"<>|]+/g, '').slice(0, 24) || '材料包';
  return `${slug}-${stamp}.md`;
}

async function exportReferencePack() {
  try {
    const pack = await fetchReferencePack();
    if (!pack) return;
    const copied = await copyTextToClipboard(pack.markdown);
    downloadTextFile(packDownloadName(pack.title), pack.markdown);
    closeReferencePack();
    showToast(copied ? '已复制并下载材料包' : '已下载材料包');
  } catch (error) {
    showToast(error.message || '导出失败');
  }
}

async function sendReferencePackToTask() {
  try {
    const pack = await fetchReferencePack();
    if (!pack) return;
    const current = String(elements['note-body']?.value || '').trim();
    const instruction = current && !current.includes('----- 材料 -----')
      ? current
      : '请根据下面这组材料：';
    const next = `${instruction}\n\n----- 材料 -----\n${pack.markdown}`.trim();
    persistTaskComposerDraft(next);
    if (elements['note-body']) elements['note-body'].value = next;
    closeReferencePack();
    setComposeTarget('task');
    elements['note-body']?.focus();
    resizeDispatchComposer();
    showToast('材料已放入任务框，补一句指令再投递');
  } catch (error) {
    showToast(error.message || '发给任务失败');
  }
}

function sendReferencePackToAsk() {
  closeReferencePack();
  openAskSession(state.askSessionId || 'new');
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
  setAskComposerCompact(false);
  resizeAskComposer();
  syncAskKeyboard();
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
  if (postIsTranslating(post)) return '正在翻译…';
  const title = String(post?.title || '').trim();
  if (title) return title;
  return clipFeedText(plainFeedText(post?.body), FEED_TITLE_MAX) || '无标题';
}

function postListExcerpt(post) {
  const translated = translationFor(post)?.text;
  if (translated) return clipFeedText(textAfterLead(translated, postDisplayTitle(post)), FEED_EXCERPT_MAX);
  if (postIsTranslating(post)) return '';
  return clipFeedText(textAfterLead(post?.body, post?.title), FEED_EXCERPT_MAX);
}

function postViewBody(post) {
  const translated = translationFor(post)?.text;
  if (translated) return translated;
  if (postIsTranslating(post)) return '正在翻译…';
  return post?.body || post?.summary || '无正文';
}

function fillPostBody(element, value) {
  const text = String(value || '无正文');
  if (looksLikeMarkdown(text)) {
    element.classList.add('post-markdown');
    renderMarkdownInto(element, text);
  } else {
    element.classList.remove('post-markdown');
    element.textContent = text;
  }
}

function feedAsItem(item, platform) {
  const publishedAt = item.publishedAt || item.capturedAt || Date.now();
  const createdAt = item.capturedAt || item.publishedAt || Date.now();
  return {
    id: item.id,
    resourceId: item.resourceId || '',
    resourceType: 'content-item',
    live: true,
    kind: 'social',
    platform,
    externalId: item.externalId || '',
    author: item.authorName || item.authorHandle || (platform === 'bilibili' ? 'B站' : platform === 'trendforce' ? 'TrendForce' : platform === 'xueqiu' ? '雪球' : 'X'),
    handle: item.authorHandle || '',
    time: item.publishedAt ? formatTime(item.publishedAt) : '',
    title: item.title,
    body: item.body || item.summary || '无正文',
    tags: postTagNames(item),
    sourceUrl: item.sourceUrl,
    processing: item.processing || '',
    following: false,
    createdAt,
    publishedAt,
    isRead: Boolean(item.isRead),
    translation: item.translation || null,
  };
}

function xAsItem(item) {
  return feedAsItem(item, 'x');
}

function bilibiliAsItem(item) {
  return feedAsItem(item, 'bilibili');
}

function trendforceAsItem(item) {
  return feedAsItem(item, 'trendforce');
}

function xueqiuAsItem(item) {
  return feedAsItem(item, 'xueqiu');
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
  const platform = state.feedPlatform || state.platform;
  return platform === 'all' || item.platform === platform;
}

function officialAsItem(release) {
  const publishedAt = release.publishedAt || release.observedAt || Date.now();
  return {
    id: release.releaseId,
    resourceId: release.releaseId,
    resourceType: 'official-release',
    live: true,
    kind: 'official',
    platform: 'official',
    author: release.authority || '官方',
    handle: '',
    time: release.publishedAt ? formatTime(release.publishedAt) : '',
    title: localizedCopy(release.releaseId, release.title),
    body: '',
    excerpt: [release.authority, release.documentNumber].filter(Boolean).join(' · '),
    tags: [],
    sourceUrl: release.sourceUrl || '',
    processing: '',
    following: false,
    createdAt: release.observedAt || publishedAt,
    publishedAt,
    complete: false,
    release,
  };
}

function socialFeedItems(options = {}) {
  const live = state.posts.map(liveAsItem).filter(matchesPlatform);
  const xItems = state.xItems.map(xAsItem).filter(matchesPlatform);
  const bilibiliItems = state.bilibiliItems.map(bilibiliAsItem).filter(matchesPlatform);
  const trendforceItems = state.trendforceItems.map(trendforceAsItem).filter(matchesPlatform);
  const xueqiuItems = state.xueqiuItems.map(xueqiuAsItem).filter(matchesPlatform);
  const demo = feedItems.filter((item) => {
    if (item.platform === 'x' && state.xItems.length) return false;
    if (item.platform === 'bilibili' && state.bilibiliItems.length) return false;
    if (item.platform === 'trendforce' && state.trendforceItems.length) return false;
    if (item.platform === 'xueqiu' && state.xueqiuItems.length) return false;
    return matchesPlatform({ ...item, kind: 'social' });
  }).map((item) => ({ ...item, kind: 'social', createdAt: item.createdAt || Date.now(), publishedAt: item.publishedAt || item.createdAt || Date.now() }));
  return [...bilibiliItems, ...trendforceItems, ...xueqiuItems, ...xItems, ...live, ...demo]
    .filter((item) => options.includeHidden || !isHiddenFeedItem(item));
}

function officialFeedItems(options = {}) {
  const hidden = state.hiddenSourceIds;
  return (state.staticBoard?.releases || [])
    .filter((item) => !hidden.has(`policy.${item.authority}`))
    .map(officialAsItem)
    .filter((item) => options.includeHidden || !isHiddenFeedItem(item));
}

function focusedFeedItems() {
  const live = [
    ...socialFeedItems({ includeHidden: true }),
    ...officialFeedItems({ includeHidden: true }),
  ];
  const byId = new Map();
  for (const item of live) {
    if (itemIsFocused(item)) byId.set(item.id, item);
  }
  for (const [id, snap] of Object.entries(state.focusItems)) {
    if (!isFeedFocusItem(snap)) continue;
    if (!isFocused(id) && !itemIsFocused(snap)) continue;
    const key = snap.id || id;
    const current = byId.get(key);
    if (!current) {
      byId.set(key, { ...snap, isRead: Boolean(snap.isRead) });
      continue;
    }
    if (snap.isRead && !current.isRead) byId.set(key, { ...current, isRead: true });
  }
  return [...byId.values()];
}

function recentFeedItems() {
  return Object.values(state.recentItems)
    .filter(isFeedFocusItem)
    .sort((left, right) => (Number(right.viewedAt) || 0) - (Number(left.viewedAt) || 0));
}

function matchesFeedQuery(item, query) {
  if (!query) return true;
  const haystack = [
    item.title,
    item.author,
    item.body,
    item.excerpt,
    postDisplayTitle(item),
    translationFor(item)?.text,
    postListExcerpt(item),
    item.release?.title,
    postTagNames(item).join(' '),
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

function matchesFeedRange(item) {
  if (state.feedRange === 'all') return true;
  const at = state.channel === 'recent'
    ? Number(item.viewedAt || item.publishedAt || item.createdAt || 0)
    : Number(item.publishedAt || item.createdAt || 0);
  if (!at) return state.feedRange !== 'today';
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (state.feedRange === 'today') return at >= start.getTime();
  if (state.feedRange === '7d') return at >= start.getTime() - 6 * 24 * 60 * 60 * 1000;
  return true;
}

function sortFeedItems(items) {
  if (state.channel === 'recent') {
    return [...items].sort((left, right) => (Number(right.viewedAt) || 0) - (Number(left.viewedAt) || 0));
  }
  const key = state.feedSort === 'published' ? 'publishedAt' : 'createdAt';
  return [...items].sort((left, right) => Number(Boolean(left.isRead)) - Number(Boolean(right.isRead))
    || (Number(right[key]) || 0) - (Number(left[key]) || 0));
}

function visibleFeedItems() {
  const social = socialFeedItems();
  const official = officialFeedItems();
  let items = state.channel === 'focus' ? focusedFeedItems()
    : state.channel === 'recent' ? recentFeedItems()
    : state.channel === 'official' ? official
      : state.channel === 'social' ? social
        : [...social, ...official];
  const query = String(state.feedQuery || '').trim().toLowerCase();
  items = items.filter((item) => matchesFeedQuery(item, query) && matchesFeedRange(item));
  return sortFeedItems(items);
}

function bindHorizontalTabScroll(root = document) {
  root.querySelectorAll('.chip-tabs, .channel-tabs, .market-tabs').forEach((scroller) => {
    if (scroller.dataset.chipScrollBound === '1') return;
    scroller.dataset.chipScrollBound = '1';
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startLeft = 0;
    let pointerId = null;
    const releaseCapture = () => {
      if (pointerId == null) return;
      try { scroller.releasePointerCapture(pointerId); } catch { /* already released */ }
      pointerId = null;
    };
    scroller.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch' || event.button !== 0) return;
      dragging = true;
      moved = false;
      startX = event.clientX;
      startLeft = scroller.scrollLeft;
    });
    scroller.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      if (!moved && Math.abs(dx) <= 6) return;
      moved = true;
      if (pointerId == null) {
        try {
          scroller.setPointerCapture(event.pointerId);
          pointerId = event.pointerId;
        } catch { /* some WebViews reject capture */ }
      }
      scroller.scrollLeft = startLeft - dx;
    });
    const stopDrag = () => {
      dragging = false;
      releaseCapture();
    };
    scroller.addEventListener('pointerup', stopDrag);
    scroller.addEventListener('pointercancel', stopDrag);
    scroller.addEventListener('click', (event) => {
      if (!moved) return;
      event.preventDefault();
      event.stopPropagation();
      moved = false;
    }, true);
    scroller.addEventListener('wheel', (event) => {
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (horizontal) return;
      if (!event.deltaY) return;
      event.preventDefault();
      scroller.scrollLeft += event.deltaY;
    }, { passive: false });
  });
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
  bindHorizontalTabScroll();
}

const feedSourceTabs = [
  { id: 'x', label: 'X' },
  { id: 'xueqiu', label: '雪球' },
  { id: 'bilibili', label: 'B站' },
  { id: 'trendforce', label: 'TrendForce' },
];

function isSourceFeedScope(id) {
  return id === 'x' || id === 'xueqiu' || id === 'bilibili' || id === 'trendforce';
}

function currentFeedScopeId() {
  return isSourceFeedScope(state.feedPlatform) ? state.feedPlatform : state.channel;
}

function applyFeedPlatform(id) {
  const next = id || 'all';
  state.feedPlatform = next;
  state.platform = next;
  if (isSourceFeedScope(next)) state.channel = 'social';
  resetFeedWindow();
  renderChannels();
  renderPlatformFilters();
  renderXToolbar();
  renderXueqiuToolbar();
  renderBilibiliToolbar();
  renderTrendForceToolbar();
  renderPosts();
  if (next === 'x' && !state.xItems.length && !state.xLoading) {
    loadXFeed({ refresh: false }).catch((error) => showToast(error.message));
  }
  if (next === 'xueqiu' && !state.xueqiuItems.length && !state.xueqiuLoading) {
    loadXueqiuFeed({ refresh: false }).catch((error) => showToast(error.message));
  }
  if (next === 'bilibili' && !state.bilibiliItems.length && !state.bilibiliLoading) {
    loadBilibiliFeed().catch((error) => showToast(error.message));
  }
  if (next === 'trendforce' && !state.trendforceItems.length && !state.trendforceLoading) {
    loadTrendForceFeed({ refresh: false }).catch((error) => showToast(error.message));
  }
}

function selectFeedScope(id) {
  if (isSourceFeedScope(id)) {
    applyFeedPlatform(id);
    return;
  }
  state.channel = id;
  applyFeedPlatform('all');
}

function renderFeedActionButton() {
  const button = elements['feed-filter'];
  if (!button) return;
  button.classList.remove('is-source-more');
  button.setAttribute('aria-label', isSourceFeedScope(state.feedPlatform)
    ? (state.feedPlatform === 'x' ? 'X 来源任务'
      : state.feedPlatform === 'xueqiu' ? '雪球来源任务'
        : state.feedPlatform === 'bilibili' ? 'B站来源任务' : 'TrendForce 来源任务')
    : '信息流筛选');
  setIconButton(button, 'list-filter');
}

function renderChannels() {
  const current = currentFeedScopeId();
  const tabs = [...channels, ...feedSourceTabs];
  if (elements['channel-tabs']) {
    elements['channel-tabs'].setAttribute('aria-label', '信息范围与信源');
  }
  elements['channel-tabs'].replaceChildren(...tabs.map((tab) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `channel-tab${tab.id === current ? ' is-active' : ''}`;
    button.textContent = tab.label;
    button.addEventListener('click', () => {
      if (tab.id === current) return;
      selectFeedScope(tab.id);
    });
    return button;
  }));
  const active = elements['channel-tabs']?.querySelector('.channel-tab.is-active');
  const scroller = elements['channel-tabs'];
  if (active && scroller) {
    const left = Math.max(0, active.offsetLeft - 16);
    const right = active.offsetLeft + active.offsetWidth;
    if (left < scroller.scrollLeft || right > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = left;
    }
  }
  elements['follow-toolbar']?.classList.add('hidden');
  renderFeedActionButton();
}

function renderPlatformFilters() {
  elements['platform-filters']?.classList.add('hidden');
}

function xFeedLabel(feed = state.xFeed) {
  return feed === 'following' ? '正在关注' : '为你推荐';
}

function xCaptureActionLabel(feed = state.xFeed) {
  return feed === 'following' ? '抓取关注 50 条' : '抓取推荐 50 条';
}

function xCaptureScopeNote(feed = state.xFeed) {
  return feed === 'following'
    ? '当前范围：正在关注。抓你已关注账号的时间线，不是算法推荐。跳过已入库内容，尽量补满 50 条新的，然后翻译并打 Tag。'
    : '当前范围：为你推荐。抓首页推荐时间线。跳过已入库内容，尽量补满 50 条新的，然后翻译并打 Tag。';
}

function setXFeed(feed, { reload = false } = {}) {
  const next = feed === 'following' ? 'following' : 'for-you';
  if (state.xFeed === next) return false;
  state.xFeed = next;
  state.xItems = [];
  state.xNote = '';
  resetFeedWindow();
  persistFeedBrowseState();
  renderXToolbar();
  renderPosts();
  if (reload && state.feedPlatform === 'x') {
    loadXFeed({ refresh: false }).catch((error) => showToast(error.message));
  }
  return true;
}

function renderXToolbar() {
  const toolbar = elements['x-toolbar'];
  if (toolbar) toolbar.classList.toggle('hidden', state.feedPlatform !== 'x');
  if (elements['x-feed-status']) {
    const status = state.xPipeline && !state.xLoading
      ? (state.xTagging ? '正在给新内容打 Tag…' : state.xTranslating ? '正在翻译新内容…' : '抓取后处理中…')
      : state.xLoading
        ? (state.xRefreshing ? `正在拉取最多 50 条${xFeedLabel()}…` : '正在读取已缓存来源…')
        : (state.xNote || `${state.xItems.length} 条 · ${xFeedLabel()}`);
    elements['x-feed-status'].textContent = status;
    elements['x-feed-status'].classList.toggle('hidden', state.feedPlatform !== 'x');
  }
  elements['x-more']?.classList.add('hidden');
  if (elements['x-feed-tabs']) {
    renderChipTabs(elements['x-feed-tabs'], [
      { id: 'following', label: '正在关注' },
      { id: 'for-you', label: '为你推荐' },
    ], state.xFeed, (id) => {
      setXFeed(id, { reload: true });
    });
  }
  const pending = pendingXTranslations().length;
  const pendingTags = pendingXTaggings().length;
  const busy = xTaskBusy();
  const showTranslate = false;
  if (elements['x-translate-bar']) {
    elements['x-translate-bar'].classList.toggle('hidden', !showTranslate);
  }
  if (elements['x-refresh']) {
    elements['x-refresh'].classList.toggle('hidden', state.feedPlatform !== 'x');
    elements['x-refresh'].disabled = busy;
    elements['x-refresh'].textContent = state.xRefreshing ? '拉取中…' : (state.xFeed === 'following' ? '拉取关注 50 条' : '拉取推荐 50 条');
  }
  if (elements['x-translate-status']) {
    elements['x-translate-status'].textContent = state.xTagging
      ? '正在给尚未标注的信息流打 Tag…'
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

function xueqiuFeedLabel(feed = state.xueqiuFeed) {
  if (feed === 'featured') return '精选';
  if (feed === 'livenews') return '7x24';
  return '关注';
}

function setXueqiuFeed(feed, { reload = false } = {}) {
  const next = feed === 'featured' || feed === 'livenews' ? feed : 'following';
  if (state.xueqiuFeed === next) return false;
  state.xueqiuFeed = next;
  state.xueqiuItems = [];
  state.xueqiuNote = '';
  resetFeedWindow();
  persistFeedBrowseState();
  renderXueqiuToolbar();
  renderPosts();
  if (reload && state.feedPlatform === 'xueqiu') {
    loadXueqiuFeed({ refresh: false }).catch((error) => showToast(error.message));
  }
  return true;
}

function renderXueqiuToolbar() {
  const toolbar = elements['xueqiu-toolbar'];
  if (toolbar) toolbar.classList.toggle('hidden', state.feedPlatform !== 'xueqiu');
  if (elements['xueqiu-feed-status']) {
    elements['xueqiu-feed-status'].textContent = state.xueqiuLoading
      ? (state.xueqiuRefreshing ? `正在抓取最多 50 条${xueqiuFeedLabel()}…` : '正在读取已缓存来源…')
      : (state.xueqiuNote || `${state.xueqiuItems.length} 条 · ${xueqiuFeedLabel()}`);
    elements['xueqiu-feed-status'].classList.toggle('hidden', state.feedPlatform !== 'xueqiu');
  }
  if (elements['xueqiu-feed-tabs']) {
    renderChipTabs(elements['xueqiu-feed-tabs'], [
      { id: 'following', label: '关注' },
      { id: 'featured', label: '精选' },
      { id: 'livenews', label: '7x24' },
    ], state.xueqiuFeed, (id) => {
      setXueqiuFeed(id, { reload: true });
    });
  }
  if (elements['xueqiu-action-bar']) {
    elements['xueqiu-action-bar'].classList.toggle('hidden', state.feedPlatform !== 'xueqiu');
  }
  if (elements['xueqiu-action-status']) {
    elements['xueqiu-action-status'].textContent = state.xueqiuFeed === 'livenews'
      ? '7x24 走雪球快讯接口。关注和精选需要采集浏览器已登录雪球。'
      : `当前范围：${xueqiuFeedLabel()}。在 BrowserSkill 已登录的雪球页里打时间线接口，不扒首页 DOM。`;
  }
  if (elements['xueqiu-refresh']) {
    elements['xueqiu-refresh'].disabled = state.xueqiuLoading;
    elements['xueqiu-refresh'].textContent = state.xueqiuRefreshing
      ? '抓取中…'
      : `抓取${xueqiuFeedLabel()} 50 条`;
  }
}

function renderBilibiliToolbar() {
  const toolbar = elements['bilibili-toolbar'];
  if (toolbar) toolbar.classList.toggle('hidden', state.feedPlatform !== 'bilibili');
  elements['bilibili-more']?.classList.add('hidden');
  if (elements['bilibili-import-form']) elements['bilibili-import-form'].classList.add('hidden');
  if (elements['bilibili-feed-status']) {
    elements['bilibili-feed-status'].textContent = state.bilibiliLoading
      ? '正在读取已保存字幕…'
      : (state.bilibiliNote || `${state.bilibiliItems.length} 条已保存`);
  }
  if (elements['bilibili-import']) {
    elements['bilibili-import'].disabled = state.bilibiliLoading;
    elements['bilibili-import'].textContent = state.bilibiliLoading ? '拉取中…' : '拉取字幕';
  }
}

function renderTrendForceToolbar() {
  const toolbar = elements['trendforce-toolbar'];
  if (toolbar) toolbar.classList.toggle('hidden', state.feedPlatform !== 'trendforce');
  elements['trendforce-more']?.classList.add('hidden');
  if (elements['trendforce-feed-status']) {
    elements['trendforce-feed-status'].textContent = state.trendforceLoading
      ? (state.trendforceRefreshing ? '正在抓取公开洞察、报告索引和价表…' : '正在读取已缓存来源…')
      : (state.trendforceNote || `${state.trendforceItems.length} 条已保存`);
  }
  if (elements['trendforce-action-bar']) {
    elements['trendforce-action-bar'].classList.toggle('hidden', state.feedPlatform !== 'trendforce');
  }
  if (elements['trendforce-action-status']) {
    elements['trendforce-action-status'].textContent = state.trendforceRefreshing
      ? '正在抓取公开页…'
      : '免费洞察和价表抓全文；会员报告只收标题和介绍。';
  }
  if (elements['trendforce-refresh']) {
    elements['trendforce-refresh'].disabled = state.trendforceLoading;
    elements['trendforce-refresh'].textContent = state.trendforceRefreshing ? '抓取中…' : '抓取公开页';
  }
}

function sortLabel() {
  return state.feedSort === 'published' ? '按发布时间' : '按收录顺序';
}

function rangeLabel() {
  if (state.feedRange === 'today') return '今天';
  if (state.feedRange === '7d') return '近 7 天';
  return '全部日期';
}

function feedKindLabel(item) {
  if (item.kind === 'official' || item.platform === 'official') return '官方';
  if (item.platform === 'bilibili') return '字幕';
  if (item.platform === 'trendforce') return '洞察';
  if (item.platform === 'xueqiu') return '雪球';
  if (item.platform === 'manual') return '手工';
  return '社媒';
}

function isOfficialItem(item) {
  return item?.kind === 'official' || item?.platform === 'official' || Boolean(item?.release);
}

function officialDayKey(item) {
  const value = item?.publishedAt || item?.createdAt;
  if (value == null) return '时间待公布';
  return new Date(value).toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  });
}

function officialEventMeta(post) {
  return [
    post.author,
    post.release?.documentNumber,
    post.release?.documentType,
    post.release?.authority && post.release.authority !== post.author ? post.release.authority : '',
  ].filter(Boolean).join(' · ');
}

function appendOfficialStar(target, post, onToggle) {
  const star = document.createElement('button');
  star.type = 'button';
  star.className = `icon-button ghost focus-btn${itemIsFocused(post) ? ' on' : ''}`;
  star.setAttribute('aria-label', itemIsFocused(post) ? '取消重点' : '标为重点');
  star.innerHTML = icon('star');
  star.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFocus(post.id, onToggle, post);
  });
  target.append(star);
}

function appendOfficialEvent(list, post, onToggle) {
  const item = document.createElement('li');
  item.className = `official-event${itemIsFocused(post) ? ' is-focus' : ''}`;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'official-event-body';
  open.append(Object.assign(document.createElement('time'), {
    dateTime: post.publishedAt ? new Date(post.publishedAt).toISOString() : '',
    textContent: overviewClock(post.publishedAt || post.createdAt),
  }));
  open.append(Object.assign(document.createElement('strong'), { textContent: postDisplayTitle(post) }));
  const meta = officialEventMeta(post);
  if (meta) open.append(Object.assign(document.createElement('small'), { textContent: meta }));
  attachGuardedOpen(open, () => openArticle(post));
  item.append(open);
  appendOfficialStar(item, post, onToggle);
  list.append(item);
}

function renderOfficialTimeline(root, items, { emptyText = '这个筛选下还没有官方信息。' } = {}) {
  root.replaceChildren();
  if (!items.length) {
    root.append(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: emptyText }));
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'official-timeline';
  const groups = [];
  const index = new Map();
  for (const post of items) {
    const key = officialDayKey(post);
    if (!index.has(key)) {
      const group = { key, items: [] };
      index.set(key, group);
      groups.push(group);
    }
    index.get(key).items.push(post);
  }
  const refresh = () => {
    if (document.body.dataset.view === 'feed') renderPosts();
    renderOverviewTimeline();
  };
  for (const group of groups) {
    const day = document.createElement('section');
    day.className = 'official-day';
    day.append(Object.assign(document.createElement('h3'), {
      className: 'official-day-label',
      textContent: group.key,
    }));
    const list = document.createElement('ol');
    list.className = 'official-day-list';
    group.items.forEach((post) => appendOfficialEvent(list, post, refresh));
    day.append(list);
    wrap.append(day);
  }
  root.append(wrap);
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
  const restoreSwipeId = document.querySelector('#feed .swipe-front.is-open')?.dataset.postId || '';
  const items = visibleFeedItems();
  if (state.feedShown > items.length) state.feedShown = Math.max(FEED_PAGE_SIZE, items.length);
  const shown = items.slice(0, state.feedShown);
  const keepY = document.body.dataset.view === 'feed'
    && !document.body.classList.contains('is-dialog-open')
    && !restoringViewScroll
    ? window.scrollY
    : null;
  elements.feed.replaceChildren();
  elements['feed-count'].textContent = state.channel === 'recent'
    ? (items.length > shown.length
      ? `按浏览时间 · 已显示 ${shown.length} / ${items.length} 条`
      : `按浏览时间 · ${items.length} 条`)
    : (items.length > shown.length
      ? `${sortLabel()} · ${rangeLabel()} · 已显示 ${shown.length} / ${items.length} 条`
      : `${sortLabel()} · ${rangeLabel()} · ${items.length} 条`);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = state.feedQuery
      ? '没有匹配的已收录内容。清除搜索后再看。'
      : state.channel === 'recent'
        ? '打开一条就会出现在这里，方便找回看过的内容。'
        : '这个筛选下还没有信息。';
    elements.feed.append(empty);
    observeFeedSentinel(null, false);
    return;
  }
  if (state.channel === 'official') {
    renderOfficialTimeline(elements.feed, shown, {
      emptyText: state.staticBoardLoading ? '正在读取官方信息…' : '这个筛选下还没有官方信息。',
    });
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
      if (state.channel === 'focus') {
        removeFocusItem(post);
        renderPosts();
        renderOverviewTimeline();
        return;
      }
      if (state.channel === 'recent') {
        removeRecentItem(post);
        renderPosts();
        renderOverviewTimeline();
        return;
      }
      hideFeedItem(post).catch((error) => showToast(error.message));
    });
    actionsRow.append(remove);

    if (isOfficialItem(post)) {
      const card = document.createElement('article');
      card.className = `official-event swipe-front${itemIsFocused(post) ? ' is-focus' : ''}`;
      card.dataset.postId = post.id;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'official-event-body';
      open.append(Object.assign(document.createElement('time'), {
        dateTime: post.publishedAt ? new Date(post.publishedAt).toISOString() : '',
        textContent: officialDayKey(post),
      }));
      open.append(Object.assign(document.createElement('strong'), { textContent: postDisplayTitle(post) }));
      const meta = officialEventMeta(post);
      if (meta) open.append(Object.assign(document.createElement('small'), { textContent: meta }));
      card.append(open);
      appendOfficialStar(card, post, () => {
        renderPosts();
        renderOverviewTimeline();
      });
      attachSwipe(card, FEED_SWIPE_WIDTH, () => openArticle(post));
      row.append(actionsRow, card);
      elements.feed.append(row);
      continue;
    }

    const card = document.createElement('article');
    const readFade = state.channel === 'focus' && post.isRead;
    card.className = `post-card is-compact swipe-front${readFade ? ' is-read' : ''}${itemIsFocused(post) ? ' is-focus' : ''}`;
    card.dataset.postId = post.id;
    const meta = document.createElement('div');
    meta.className = 'post-meta';
    const kind = document.createElement('span');
    kind.className = `kind-tag${post.kind === 'official' ? ' official' : ''}`;
    kind.textContent = feedKindLabel(post);
    const author = document.createElement('span');
    author.className = 'post-identity';
    author.textContent = post.author;
    const time = document.createElement('span');
    time.className = 'post-time';
    time.textContent = post.time || overviewClock(post.publishedAt || post.createdAt);
    meta.append(kind, author, time);
    const content = document.createElement('div');
    content.className = 'feed-content';
    const title = document.createElement('h3');
    title.textContent = postDisplayTitle(post);
    content.append(title);
    const excerpt = post.excerpt || postListExcerpt(post);
    const expanded = state.expandedFeedIds.has(post.id);
    if (expanded) {
      const full = document.createElement('div');
      full.className = 'post-body';
      fillPostBody(full, postViewBody(post));
      content.append(full);
    } else if (excerpt) {
      const preview = document.createElement('p');
      preview.className = translationFor(post) ? 'post-excerpt is-translated' : 'post-excerpt';
      preview.textContent = excerpt;
      content.append(preview);
    }
    const feedTags = createTagRow(postTagNames(post));
    if (feedTags) content.append(feedTags);
    const star = document.createElement('button');
    star.type = 'button';
    star.className = `icon-button ghost focus-btn${itemIsFocused(post) ? ' on' : ''}`;
    star.setAttribute('aria-label', itemIsFocused(post) ? '取消重点' : '标为重点');
    star.innerHTML = icon('star');
    star.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleFocus(post.id, () => {
        renderPosts();
        renderOverviewTimeline();
      }, post);
    });
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'feed-expand';
    expand.textContent = expanded ? '收起' : '原地展开全文';
    expand.addEventListener('click', (event) => {
      event.stopPropagation();
      if (state.expandedFeedIds.has(post.id)) state.expandedFeedIds.delete(post.id);
      else state.expandedFeedIds.add(post.id);
      renderPosts();
    });
    card.append(meta, content, star, expand);
    attachSwipe(card, FEED_SWIPE_WIDTH, () => openArticle(post));
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
  if (restoreSwipeId) {
    const front = elements.feed.querySelector(`.swipe-front[data-post-id="${restoreSwipeId}"]`);
    if (front) setSwipeOpen(front, true, FEED_SWIPE_WIDTH);
  }
  if (keepY !== null) window.scrollTo(0, keepY);
  renderXToolbar();
  renderBilibiliToolbar();
  if (document.body.dataset.view === 'sources') renderHub();
}

function syncDialogTranslation(post) {
  const box = elements['dialog-translation'];
  if (box) {
    box.textContent = '';
    box.classList.add('hidden');
  }
  elements['post-dialog']?.classList.remove('has-translation');
  elements['dialog-translate']?.classList.add('hidden');
}

function openArticle(post) {
  if (!post) return;
  if (post.release || post.kind === 'official') {
    openPage('article', `official/${post.release?.releaseId || post.id}`);
    return;
  }
  openPage('article', post.id);
}

function findUnifiedItem(id) {
  const key = String(id || '');
  return visibleFeedItems().find((item) => item.id === key || item.resourceId === key)
    || socialFeedItems({ includeHidden: true }).find((item) => item.id === key || item.resourceId === key)
    || officialFeedItems({ includeHidden: true }).find((item) => item.id === key || item.resourceId === key)
    || Object.values(state.focusItems).find((item) => item.id === key || item.resourceId === key)
    || state.focusItems[key]
    || Object.values(state.recentItems).find((item) => item.id === key || item.resourceId === key)
    || state.recentItems[key]
    || null;
}

function openPost(post) {
  openArticle(post);
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
  if (id === 'analysis') return '投资随持仓现价同步。其他来源是静态记录，改完需点「记本期」。';
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

async function syncTradePaneData({ refresh = false } = {}) {
  if (state.tradePane === 'stocks') {
    await loadMarket();
    return;
  }
  if (state.tradePane === 'assets') {
    await Promise.all([
      loadGlobalAssets(),
      loadMarketNativeBoard({ refresh }).catch((error) => {
        state.marketNativeError = error instanceof Error ? error.message : '市场原生数据读取失败';
      }),
    ]);
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
  if (board?.summary?.totalCny) {
    const total = document.createElement('p');
    total.className = 'holdings-lines-total asset-top';
    total.append(Object.assign(document.createElement('span'), { textContent: '账户合计' }));
    total.append(Object.assign(document.createElement('strong'), { className: 'total-value', textContent: privacyText(`¥${formatMoneyAmount(board.summary.totalCny, 2)}`) }));
    target.append(total);
  }
  for (const line of lines) {
    const row = document.createElement('article');
    row.className = 'holdings-line account-panel';
    const head = document.createElement('div');
    head.className = 'holdings-line-head';
    head.append(Object.assign(document.createElement('h3'), { textContent: line.label }));
    head.append(Object.assign(document.createElement('strong'), {
      textContent: line.totalCny == null ? '--' : privacyText(`¥${formatMoneyAmount(line.totalCny, 2)}`),
    }));
    const metrics = document.createElement('div');
    metrics.className = 'holdings-line-metrics';
    const pnl = holdingsLinePnl(line.id);
    metrics.append(
      holdingsLineMetric('股票市值', line.stockCny),
      holdingsLineMetric('现金', line.cashCny),
      holdingsSignedMetric('当日盈亏', pnl?.day),
      holdingsSignedMetric('持仓浮动', pnl?.unrealized),
    );
    row.append(head, metrics);
    if (line.listingCurrency && line.listingCurrency !== 'CNY') {
      const native = document.createElement('small');
      native.className = 'holdings-native';
      native.textContent = `原币 ${line.listingCurrency} · 股票 ${formatNativeAmount(line.stockListing, line.listingCurrency)} / 现金 ${formatNativeAmount(line.cashListing, line.listingCurrency)}`;
      row.append(native);
    }
    row.addEventListener('click', () => openPage('account', line.id));
    target.append(row);
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
  item.className = 'holdings-line-metric account-fact';
  const strong = document.createElement('strong');
  strong.className = 'day-amount';
  if (value == null) {
    strong.textContent = '--';
  } else {
    const number = moneyNumber(value);
    strong.classList.add(number >= 0 ? 'up' : 'down');
    strong.textContent = formatSignedAmount(number);
  }
  const caption = document.createElement('small');
  caption.textContent = label;
  item.append(caption, strong);
  return item;
}

function holdingsLineMetric(label, cny) {
  const item = document.createElement('div');
  item.className = 'holdings-line-metric account-fact';
  const strong = document.createElement('strong');
  strong.textContent = cny == null ? '--' : `¥${formatMoneyAmount(cny, 2)}`;
  const caption = document.createElement('small');
  caption.textContent = label;
  item.append(caption, strong);
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
        textContent: item.lastPrice == null ? '无行情' : formatPrice(item.lastPrice),
      }),
      Object.assign(document.createElement('small'), { textContent: formatPrice(item.costPrice) }),
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
  openPage('holding', item.lotId);
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
      textContent: state.assetLoading ? '正在加载全球行情…' : (state.assetError || '没有符合筛选的标的。'),
    }));
    if (document.body.dataset.view === 'sources') renderHub();
    return;
  }
  renderWatchRows(elements['asset-list'], rows, { formatValue: formatQuoteNumber });
  renderMarketNativeBoard();
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
    state.assetError = error instanceof Error ? error.message : '全球行情加载失败';
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

function donutSlicePath(cx, cy, innerRadius, outerRadius, startDeg, endDeg) {
  const point = (radius, deg) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
  };
  const sweep = Math.min(360, Math.max(0, endDeg - startDeg));
  if (sweep < 0.01) return '';
  if (sweep >= 359.99) {
    const [ox, oy] = point(outerRadius, 0);
    const [ix, iy] = point(innerRadius, 0);
    const [ox2, oy2] = point(outerRadius, 180);
    const [ix2, iy2] = point(innerRadius, 180);
    return [
      `M${ox} ${oy}`,
      `A${outerRadius} ${outerRadius} 0 1 1 ${ox2} ${oy2}`,
      `A${outerRadius} ${outerRadius} 0 1 1 ${ox} ${oy}`,
      `L${ix} ${iy}`,
      `A${innerRadius} ${innerRadius} 0 1 0 ${ix2} ${iy2}`,
      `A${innerRadius} ${innerRadius} 0 1 0 ${ix} ${iy}`,
      'Z',
    ].join(' ');
  }
  const large = sweep > 180 ? 1 : 0;
  const [ox1, oy1] = point(outerRadius, startDeg);
  const [ox2, oy2] = point(outerRadius, endDeg);
  const [ix2, iy2] = point(innerRadius, endDeg);
  const [ix1, iy1] = point(innerRadius, startDeg);
  return [
    `M${ox1} ${oy1}`,
    `A${outerRadius} ${outerRadius} 0 ${large} 1 ${ox2} ${oy2}`,
    `L${ix2} ${iy2}`,
    `A${innerRadius} ${innerRadius} 0 ${large} 0 ${ix1} ${iy1}`,
    'Z',
  ].join(' ');
}

function renderPieChart(target, slices) {
  target.replaceChildren();
  if (!slices.length) {
    target.textContent = '当前没有可展示的资产结构。';
    return;
  }
  const colors = ['#7C6AF7', '#F59E0B', '#22C55E', '#EAB308', '#0A59F7', '#A78BFA', '#14B8A6'];
  const total = slices.reduce((sum, item) => sum + moneyNumber(item.value), 0) || 1;
  const svg = svgNode('svg', {
    viewBox: '0 0 200 200',
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': '当前资产结构',
  });
  let angle = 0;
  slices.forEach((slice, index) => {
    const portion = moneyNumber(slice.value) / total;
    const start = angle;
    const end = index === slices.length - 1 ? 360 : angle + (portion * 360);
    const path = donutSlicePath(100, 100, 44, 72, start, end < 360 ? Math.min(end + 0.25, 360) : end);
    if (path) {
      svg.append(svgNode('path', { d: path, fill: colors[index % colors.length] }));
    }
    angle = end;
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

function applyPersonalAssetDashboard(dashboard) {
  state.assetDashboard = dashboard;
  state.assetDashboardError = '';
  renderPersonalAssetDashboard();
}

function renderPersonalAssetLedger(dashboard) {
  const target = elements['analysis-ledger'];
  if (!target) return;
  target.replaceChildren();
  if (!dashboard) return;
  const accounts = dashboard.accounts || [];
  const types = dashboard.types || [];
  const heading = document.createElement('div');
  heading.className = 'analysis-ledger-toolbar';
  heading.append(Object.assign(document.createElement('h2'), { textContent: '来源记录' }));
  const record = document.createElement('button');
  record.type = 'button';
  record.className = 'text-button';
  record.textContent = '记本期';
  record.disabled = state.assetLedgerBusy || !accounts.length;
  record.addEventListener('click', () => recordPersonalAssetSnapshot());
  heading.append(record);
  target.append(heading);

  const add = document.createElement('div');
  add.className = 'analysis-ledger-add';
  const typeSelect = document.createElement('select');
  for (const type of types.filter((item) => !item.hiddenAt)) {
    typeSelect.append(new Option(type.name, type.key));
  }
  if (!typeSelect.options.length) {
    typeSelect.append(new Option('银行卡', 'bank'));
  }
  const noteInput = Object.assign(document.createElement('input'), {
    type: 'text',
    placeholder: '备注，如交通银行',
    maxlength: 128,
  });
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'text-button';
  addButton.textContent = '添加账户';
  addButton.disabled = state.assetLedgerBusy;
  addButton.addEventListener('click', () => createPersonalAssetAccount({
    typeKey: typeSelect.value,
    note: noteInput.value.trim(),
  }));
  add.append(typeSelect, noteInput, addButton);
  target.append(add);

  const groups = document.createElement('div');
  groups.className = 'analysis-ledger-groups';
  const grouped = new Map();
  for (const account of accounts) {
    const list = grouped.get(account.typeKey) || [];
    list.push(account);
    grouped.set(account.typeKey, list);
  }
  for (const type of types) {
    const list = grouped.get(type.key);
    if (!list?.length) continue;
    const group = document.createElement('section');
    group.className = 'analysis-ledger-group';
    group.append(Object.assign(document.createElement('h3'), { textContent: type.name }));
    for (const account of list) {
      const row = document.createElement('div');
      row.className = 'analysis-ledger-row';
      const name = document.createElement('div');
      name.className = 'analysis-ledger-name';
      name.append(Object.assign(document.createElement('strong'), {
        textContent: account.note ? `${account.name} · ${account.note}` : account.name,
      }));
      if (account.readOnly) {
        name.append(Object.assign(document.createElement('small'), { textContent: '由持仓页股票市值与券商现金加总' }));
      }
      const noteField = Object.assign(document.createElement('input'), {
        type: 'text',
        value: account.note,
        placeholder: '备注',
        maxlength: 128,
        disabled: state.assetLedgerBusy,
      });
      noteField.addEventListener('change', () => updatePersonalAssetAccount(account.id, { note: noteField.value.trim() }));
      const amountField = Object.assign(document.createElement('input'), {
        type: 'text',
        value: account.displayAmount,
        inputMode: 'decimal',
        disabled: state.assetLedgerBusy || account.readOnly,
      });
      amountField.addEventListener('change', () => updatePersonalAssetAccount(account.id, { amount: amountField.value.trim() }));
      row.append(name, noteField, amountField);
      group.append(row);
    }
    groups.append(group);
  }
  target.append(groups);
}

function renderPersonalAssetDashboard() {
  const dashboard = state.assetDashboard;
  const latest = dashboard?.latest || {};
  const period = elements['analysis-period'];
  const kpis = elements['analysis-kpis'];
  kpis.replaceChildren();
  if (state.assetDashboardLoading && !dashboard) {
    period.textContent = '正在读取个人资产账本…';
    elements['analysis-ledger']?.replaceChildren();
    return;
  }
  if (state.assetDashboardError) {
    period.textContent = state.assetDashboardError;
    elements['analysis-ledger']?.replaceChildren();
    return;
  }
  if (!dashboard || (!dashboard.points?.length && !dashboard.accounts?.length)) {
    period.textContent = dashboard?.note || '还没有资产记录';
    renderPersonalAssetLedger(dashboard);
    elements['analysis-trend'].replaceChildren();
    elements['analysis-pie'].replaceChildren();
    return;
  }
  const labels = dashboard.points.map((point) => point.label);
  const recorded = latest.recordedLabel
    ? `记录 ${latest.recordedLabel} · ¥${formatMoneyAmount(latest.recordedTotal)}`
    : '';
  period.textContent = labels.length
    ? `统计周期：${labels[0]} - ${labels[labels.length - 1]}${recorded ? ` | ${recorded}` : ''} | ${dashboard.note || '个人资产账本'}`
    : (dashboard.note || '个人资产账本');
  appendMetric(kpis, '当前总资产', `¥ ${formatMoneyAmount(latest.total)}`, moneyNumber(latest.increase) >= 0 ? 'up' : 'down');
  appendMetric(kpis, '投资（含券商现金）', `¥ ${formatMoneyAmount(latest.equity)}`);
  appendMetric(kpis, '累计增长率', formatRatioPercent(latest.cumulativeGrowthRate));
  appendMetric(kpis, '公积金', `¥ ${formatMoneyAmount(latest.housingFund)}`);
  appendMetric(kpis, '最新变动', `${formatSignedMoneyAmount(latest.increase)} / ${formatSignedRatioPercent(latest.increaseRate)}`, moneyNumber(latest.increase) >= 0 ? 'up' : 'down');
  appendMetric(kpis, '起始记录', latest.firstLabel ? `${latest.firstLabel} · ${formatMoneyAmount(latest.firstTotal)}` : '暂无');
  renderTrendChart(elements['analysis-trend'], dashboard);
  renderPieChart(elements['analysis-pie'], dashboard.allocation || []);
  const stockRatio = moneyNumber(latest.total) ? moneyNumber(latest.equity) / moneyNumber(latest.total) : 0;
  const fundRatio = moneyNumber(latest.total) ? moneyNumber(latest.housingFund) / moneyNumber(latest.total) : 0;
  elements['analysis-diagnosis-1']?.replaceChildren(
    '投资约占 ',
    Object.assign(document.createElement('strong'), { textContent: formatRatioPercent(stockRatio) }),
    '，含持仓股票市值和券商现金。',
  );
  if (elements['analysis-diagnosis-2']) {
    elements['analysis-diagnosis-2'].textContent = `公积金约占 ${formatRatioPercent(fundRatio)}。银行等静态账户改完需点「记本期」。`;
  }
  renderPersonalAssetLedger(dashboard);
}

async function mutatePersonalAsset(path, options, fallback) {
  if (state.assetLedgerBusy) return;
  state.assetLedgerBusy = true;
  renderPersonalAssetLedger(state.assetDashboard);
  try {
    const payload = await api(path, options);
    applyPersonalAssetDashboard(payload.dashboard);
  } catch (error) {
    state.assetDashboardError = error instanceof Error ? error.message : fallback;
    renderPersonalAssetDashboard();
  } finally {
    state.assetLedgerBusy = false;
    renderPersonalAssetLedger(state.assetDashboard);
  }
}

function createPersonalAssetAccount(body) {
  return mutatePersonalAsset('/api/v1/assets/personal/accounts', {
    method: 'POST',
    body: JSON.stringify(body),
  }, '添加资产账户失败');
}

function updatePersonalAssetAccount(id, body) {
  return mutatePersonalAsset(`/api/v1/assets/personal/accounts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }, '更新资产账户失败');
}

function recordPersonalAssetSnapshot() {
  return mutatePersonalAsset('/api/v1/assets/personal/snapshots', {
    method: 'POST',
    body: JSON.stringify({}),
  }, '记录本期资产失败');
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

const extraKeys = { us: 'ai-center:us-watchlist', asia: 'ai-center:asia-watchlist', cn: 'ai-center:cn-watchlist' };

function extrasBoardFor(symbol) {
  const code = String(symbol || '').toUpperCase();
  if (/^\d{6}\.(SS|SZ)$/.test(code)) return 'cn';
  if (/\.(KS|KQ|TWO|TW|T)$/.test(code)) return 'asia';
  if (state.stockBoard === 'asia') return 'asia';
  return 'us';
}

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
  if (value === null || value === undefined || value === '') return '—';
  const raw = String(value).replace(/,/g, '').trim();
  const number = Number(raw);
  if (!Number.isFinite(number)) return '—';
  const sourceFrac = raw.includes('.')
    ? (raw.split('.')[1] || '').replace(/0+$/, '').length
    : 0;
  const maxDigits = Math.min(8, Math.max(digits, sourceFrac));
  return number.toLocaleString('zh-CN', {
    minimumFractionDigits: Math.min(digits, maxDigits),
    maximumFractionDigits: maxDigits,
    useGrouping: false,
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

function extraQuery(board = state.stockBoard) {
  const us = state.extras.us.join(',');
  const asia = state.extras.asia.join(',');
  const cn = state.extras.cn.join(',');
  const params = new URLSearchParams({ board });
  if (us) params.set('extraUs', us);
  if (asia) params.set('extraAsia', asia);
  if (cn) params.set('extraCn', cn);
  return `/api/v1/markets?${params}`;
}

async function loadMarket({ board = state.stockBoard } = {}) {
  if (!state.bootstrapped) return;
  const isActiveBoard = board === state.stockBoard;
  const requestId = isActiveBoard ? state.marketRequestId + 1 : state.marketRequestId;
  if (isActiveBoard) {
    state.marketRequestId = requestId;
    state.marketLoading = true;
    state.marketError = '';
    renderMarketStatus();
  }
  try {
    if (!state.session) throw new Error('此设备尚未配对，无法加载行情');
    const payload = await api(extraQuery(board), { timeoutMs: 40_000 });
    if (isActiveBoard && requestId !== state.marketRequestId) return;
    state.markets[payload.market.board] = payload.market;
    if (isActiveBoard) renderMarket();
    else if (document.body.dataset.view === 'sources' || state.stockBoard === 'overview') {
      if (state.stockBoard === 'overview') renderMarket();
      else renderHub();
    }
    scheduleOverviewFocusWatch();
  } catch (error) {
    if (isActiveBoard) {
      if (requestId !== state.marketRequestId) return;
      state.marketError = error instanceof Error ? error.message : '行情加载失败';
      renderMarket();
    }
    throw error;
  } finally {
    if (isActiveBoard && requestId === state.marketRequestId) {
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
    renderXueqiuToolbar();
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
  const trendforceItems = state.trendforceItems.map(trendforceAsItem);
  const xueqiuItems = state.xueqiuItems.map(xueqiuAsItem);
  const demo = feedItems.filter((item) => {
    if (item.platform === 'x' && state.xItems.length) return false;
    if (item.platform === 'bilibili' && state.bilibiliItems.length) return false;
    if (item.platform === 'trendforce' && state.trendforceItems.length) return false;
    if (item.platform === 'xueqiu' && state.xueqiuItems.length) return false;
    return true;
  });
  return [...bilibiliItems, ...trendforceItems, ...xueqiuItems, ...xItems, ...live, ...demo]
    .filter((item) => !isHiddenFeedItem(item))
    .sort((left, right) => (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0))
    .slice(0, limit);
}

function shanghaiClock(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  return {
    weekday: parts.find((part) => part.type === 'weekday')?.value || '',
    minutes: Number(parts.find((part) => part.type === 'hour')?.value || 0) * 60
      + Number(parts.find((part) => part.type === 'minute')?.value || 0),
  };
}

function preferredOverviewFocus(nowMs = Date.now()) {
  const { weekday, minutes } = shanghaiClock(nowMs);
  if (weekday !== 'Sat' && weekday !== 'Sun' && minutes >= 5 * 60 && minutes < 17 * 60) return 'cn';
  return 'us';
}

function nextOverviewFocusChangeMs(nowMs = Date.now()) {
  const current = preferredOverviewFocus(nowMs);
  const step = 30_000;
  for (let offset = step; offset <= 36 * 60 * 60 * 1000; offset += step) {
    if (preferredOverviewFocus(nowMs + offset) !== current) return nowMs + offset;
  }
  return nowMs + 60 * 60 * 1000;
}

function overviewFocusIsStale(board = state.markets.overview, nowMs = Date.now()) {
  return !board || board.focus !== preferredOverviewFocus(nowMs);
}

function overviewIndices() {
  const live = (state.markets.overview?.sections || [])
    .flatMap((section) => section.indices || [])
    .filter((item) => item?.symbol);
  if (live.length) return live;
  const focus = preferredOverviewFocus();
  return globalAssets
    .filter((item) => item.assetClass === 'index' && (focus === 'cn' ? item.market === 'cn' || item.market === 'hk' : item.market === 'us'))
    .map((item) => ({
      name: item.name,
      symbol: item.symbol,
      lastPrice: Number(String(item.price).replace(/,/g, '')),
      changePct: item.changePct,
    }));
}

function hubQuotes() {
  return overviewIndices();
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
  const quotesForTick = hubQuotes().slice(0, 6);
  ticker.replaceChildren(...quotesForTick.map((item) => {
    const up = (item.changePct ?? 0) >= 0;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hub-tick';
    button.innerHTML = `<small>${item.name}</small>
      <strong class="num ${up ? 'up' : 'down'}">${formatPrice(item.lastPrice)}</strong>
      <b class="${up ? 'up' : 'down'}">${item.changePct === null || item.changePct === undefined ? '—' : formatPct(up, item.changePct)}</b>`;
    button.addEventListener('click', () => openPage('quote', item.symbol));
    return button;
  }));
  if (elements['hub-market-note']) {
    const board = state.assetBoard || state.markets.overview;
    const updated = board?.fetchedAt || board?.updatedAt;
    const live = Boolean(board && !state.marketError && !state.assetError);
    elements['hub-market-note'].textContent = state.marketLoading || state.assetLoading
      ? '正在读取行情…'
      : (state.marketError || state.assetError || (live
        ? `行情已连接 · 更新 ${updated ? formatTime(updated) : '刚刚'}`
        : '行情连接后显示更新时间'));
  }
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
  renderOverviewTimeline();
}

function syncOverviewPanes() {
  const pane = state.overviewPane || 'home';
  elements['overview-home']?.classList.toggle('hidden', pane !== 'home');
  elements['overview-schedule']?.classList.toggle('hidden', pane !== 'schedule');
  elements['overview-catalog']?.classList.toggle('hidden', pane !== 'catalog');
}

function setOverviewPane(pane) {
  state.overviewPane = pane;
  syncOverviewPanes();
  const nextHash = pane === 'home' ? '#sources' : `#sources/${pane}`;
  if (location.hash !== nextHash) history.replaceState({}, '', `${location.pathname}${location.search}${nextHash}`);
  if (pane === 'catalog') renderStaticSourceCatalog();
  if (pane === 'schedule') renderStaticSignalBoard();
}

function renderSources() {
  syncOverviewPanes();
  renderHub();
  renderStaticSignalBoard();
  renderMarketNativeBoard();
  renderStaticSourceCatalog();
}

function sourceKind(source) {
  if (source.category === 'calendar' || source.viewKind === 'calendar') return 'calendar';
  if (source.category === 'policy' || source.viewKind === 'official-release') return 'release';
  if (source.category === 'market' || source.viewKind === 'market-board') return 'market';
  return 'content';
}

function sourceGroupLabel(kind) {
  return { content: '社媒', calendar: '日程', release: '官方发布', market: '行情' }[kind] || kind;
}

function sourceDisplayTitle(source) {
  if (source.id === 'market.global' || source.title === '全球资产') return '全球行情';
  return source.title;
}

function renderStaticSourceCatalog() {
  const root = elements['static-source-groups'];
  if (!root) return;
  if (elements['source-catalog-tabs']) {
    renderChipTabs(elements['source-catalog-tabs'], [
      { id: 'all', label: '全部' },
      { id: 'content', label: '社媒' },
      { id: 'calendar', label: '日程' },
      { id: 'release', label: '官方' },
      { id: 'market', label: '行情' },
    ], state.sourceCatalogKind, (id) => {
      state.sourceCatalogKind = id;
      renderStaticSourceCatalog();
    });
  }
  const query = state.sourceCatalogQuery.trim().toLowerCase();
  const social = [
    { id: 'x', title: 'X', category: 'content', viewKind: 'content-feed', letter: 'X', note: '首页时间线' },
    { id: 'xueqiu', title: '雪球', category: 'content', viewKind: 'content-feed', letter: '雪', note: '关注、精选和 7x24' },
    { id: 'bilibili', title: 'B站', category: 'content', viewKind: 'content-feed', letter: 'B', note: '已采集字幕' },
    { id: 'trendforce', title: 'TrendForce', category: 'content', viewKind: 'content-feed', letter: 'T', note: '公开洞察与价表' },
    { id: 'manual', title: '手工发布', category: 'content', viewKind: 'content-feed', letter: '手', note: '自己保存的资料' },
  ];
  const official = state.sourceCatalog.filter((source) => ['calendar', 'policy'].includes(source.category));
  const market = state.sourceCatalog.filter((source) => source.category === 'market' && source.viewKind === 'market-board');
  const sources = [...social, ...official, ...market].filter((source) => {
    const kind = sourceKind(source);
    if (state.sourceCatalogKind !== 'all' && kind !== state.sourceCatalogKind) return false;
    if (query && !`${sourceDisplayTitle(source)} ${source.id} ${source.note || ''}`.toLowerCase().includes(query)) return false;
    return true;
  });
  if (!sources.length) {
    root.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'section-desc', textContent: state.sourceLoading ? '正在读取信源目录…' : '没有符合筛选的信源。',
    }));
    return;
  }
  const healthById = new Map((state.staticBoard?.sourceHealth || []).map((item) => [item.sourceId, item]));
  const groups = ['content', 'calendar', 'release', 'market'];
  const nodes = [];
  for (const group of groups) {
    const rows = sources.filter((source) => sourceKind(source) === group);
    if (!rows.length) continue;
    nodes.push(Object.assign(document.createElement('h2'), {
      className: 'source-group-name',
      textContent: `${sourceGroupLabel(group)} · ${rows.length}`,
    }));
    for (const source of rows) {
      const health = healthById.get(source.id);
      const hidden = state.hiddenSourceIds.has(source.id);
      const status = health?.status || (source.id === 'manual' ? 'ready' : 'unchecked');
      const row = document.createElement('div');
      row.className = 'source-line';
      const letter = Object.assign(document.createElement('span'), {
        className: 'source-mark',
        textContent: source.letter || sourceDisplayTitle(source).slice(0, 1),
      });
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'source-title';
      copy.append(
        Object.assign(document.createElement('strong'), { textContent: sourceDisplayTitle(source) }),
        Object.assign(document.createElement('small'), {
          textContent: health?.note || source.note || source.id,
        }),
        Object.assign(document.createElement('span'), {
          className: `status source-state ${status}`,
          textContent: status === 'ready' ? '最近检查成功' : status === 'partial' ? '部分可用' : status === 'unavailable' ? '暂不可用' : '尚未检查',
        }),
      );
      copy.addEventListener('click', () => openPage('source', source.id));
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'icon-button ghost';
      more.setAttribute('aria-label', `${sourceDisplayTitle(source)}的更多操作`);
      more.innerHTML = icon('settings');
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        openSourceMenu(source);
      });
      row.append(letter, copy, more);
      nodes.push(row);
    }
  }
  root.replaceChildren(...nodes);
}

const staticScheduleWindows = [
  { id: 'today', label: '今天' },
  { id: 'tomorrow', label: '明天' },
  { id: '7d', label: '未来 7 天' },
  { id: 'all', label: '全部日程' },
];

const staticReleaseCountries = [
  { id: 'all', label: '全部' },
  { id: 'CN', label: '中国' },
  { id: 'US', label: '美国' },
];

function staticBoardRange(windowId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  const end = new Date(today);
  if (windowId === 'tomorrow') {
    start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() + 2);
  } else if (windowId === '7d') {
    end.setDate(end.getDate() + 7);
  } else if (windowId === 'all') {
    end.setDate(end.getDate() + 400);
  } else {
    end.setDate(end.getDate() + 1);
  }
  return { from: start.getTime(), to: end.getTime() - 1 };
}

async function loadStaticSignalBoard({ refresh = false } = {}) {
  if (!state.session || state.staticBoardLoading) return;
  state.staticBoardLoading = true;
  state.staticBoardError = '';
  renderStaticSignalBoard();
  try {
    const range = staticBoardRange(state.staticBoardWindow);
    const params = new URLSearchParams({
      from: String(range.from), to: String(range.to), limit: '300', releaseLimit: '60',
      focus: state.staticBoardWindow === 'all' ? '0' : '1',
      includeUndated: state.staticBoardWindow === 'all' ? '1' : '0',
    });
    if (refresh) params.set('refresh', '1');
    const payload = await api(`/api/v1/static-signals/board?${params}`, { timeoutMs: 45_000 });
    state.staticBoard = payload.board;
    mergeLocalizations(payload);
    autoLocalizeSources().catch(() => {});
  } catch (error) {
    state.staticBoardError = error instanceof Error ? error.message : '静态信号读取失败';
    throw error;
  } finally {
    state.staticBoardLoading = false;
    renderStaticSignalBoard();
    renderStaticSourceCatalog();
    renderOverviewTimeline();
    renderPosts();
  }
}

function renderStaticSignalBoard() {
  if (elements['static-schedule-tabs']) {
    renderChipTabs(elements['static-schedule-tabs'], staticScheduleWindows, state.staticBoardWindow, (id) => {
      if (id === state.staticBoardWindow || state.staticBoardLoading) return;
      state.staticBoardWindow = id;
      loadStaticSignalBoard().catch((error) => showToast(error.message));
    });
  }

  const board = state.staticBoard;
  const upcoming = board?.upcoming || [];
  const fill = (root, rows, viewKind, emptyText) => {
    if (!root) return;
    if (!rows.length) {
      root.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'empty-state',
        textContent: state.staticBoardLoading ? '正在读取官方来源…' : emptyText,
      }));
      return;
    }
    root.replaceChildren();
    rows.forEach((item) => appendStaticSignalItem(root, item, viewKind));
  };
  fill(elements['static-upcoming'], upcoming.slice(0, 2), 'calendar', '近期暂无日程。');
  fill(elements['static-schedule-list'], upcoming, 'calendar', '这个时间范围内暂无默认关注日程。');
  if (elements['static-board-note']) {
    elements['static-board-note'].textContent = state.staticBoardError
      || (state.staticBoardLoading ? '正在同步官方来源…' : board ? `生成于 ${formatTime(board.generatedAt)} · 仅陈列公开事实` : '等待同步官方来源');
  }
}

function overviewClock(value) {
  if (value == null) return '—';
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderOverviewTimeline() {
  const root = elements['overview-timeline'];
  if (!root) return;
  if (elements['overview-timeline-tabs']) {
    renderChipTabs(elements['overview-timeline-tabs'], [
      { id: 'latest', label: '全部' },
      { id: 'focus', label: '重点' },
      { id: 'recent', label: '最近' },
      { id: 'social', label: '社媒' },
      { id: 'official', label: '官方' },
    ], state.overviewTimeline === 'latest' ? 'latest' : state.overviewTimeline, (id) => {
      state.overviewTimeline = id;
      renderOverviewTimeline();
    });
  }
  const previousChannel = state.channel;
  state.channel = state.overviewTimeline === 'latest' ? 'all' : state.overviewTimeline;
  const rows = visibleFeedItems().slice(0, 7);
  state.channel = previousChannel;
  if (elements['overview-timeline-day']) {
    elements['overview-timeline-day'].textContent = '';
  }
  if (!rows.length) {
    root.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state',
      textContent: state.staticBoardLoading ? '正在读取内容…' : '这个筛选下还没有已发布内容。',
    }));
    return;
  }
  if (state.overviewTimeline === 'official') {
    renderOfficialTimeline(root, rows, {
      emptyText: state.staticBoardLoading ? '正在读取官方信息…' : '这个筛选下还没有官方信息。',
    });
    return;
  }
  root.replaceChildren(...rows.map((post) => {
    if (isOfficialItem(post)) {
      const row = document.createElement('article');
      row.className = `official-event${itemIsFocused(post) ? ' is-focus' : ''}`;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'official-event-body';
      open.append(Object.assign(document.createElement('time'), {
        textContent: officialDayKey(post),
      }));
      open.append(Object.assign(document.createElement('strong'), { textContent: postDisplayTitle(post) }));
      const officialMeta = officialEventMeta(post);
      if (officialMeta) open.append(Object.assign(document.createElement('small'), { textContent: officialMeta }));
      attachGuardedOpen(open, () => openArticle(post));
      row.append(open);
      appendOfficialStar(row, post, () => {
        renderOverviewTimeline();
        renderPosts();
      });
      return row;
    }
    const row = document.createElement('article');
    row.className = `post-card is-compact timeline-row${itemIsFocused(post) ? ' is-focus' : ''}`;
    const meta = document.createElement('div');
    meta.className = 'post-meta';
    const kind = Object.assign(document.createElement('span'), {
      className: `kind-tag${post.kind === 'official' ? ' official' : ''}`,
      textContent: feedKindLabel(post),
    });
    const author = Object.assign(document.createElement('span'), { className: 'post-identity', textContent: post.author });
    const time = Object.assign(document.createElement('span'), {
      className: 'post-time',
      textContent: post.time || overviewClock(post.publishedAt || post.createdAt),
    });
    meta.append(kind, author, time);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'feed-content';
    open.append(Object.assign(document.createElement('h3'), { textContent: postDisplayTitle(post) }));
    const excerpt = post.excerpt || postListExcerpt(post);
    if (excerpt) open.append(Object.assign(document.createElement('p'), { className: 'post-excerpt', textContent: excerpt }));
    const timelineTags = createTagRow(postTagNames(post));
    if (timelineTags) open.append(timelineTags);
    attachGuardedOpen(open, () => openArticle(post));
    const star = document.createElement('button');
    star.type = 'button';
    star.className = `icon-button ghost focus-btn${itemIsFocused(post) ? ' on' : ''}`;
    star.setAttribute('aria-label', itemIsFocused(post) ? '取消重点' : '标为重点');
    star.innerHTML = icon('star');
    star.addEventListener('click', () => toggleFocus(post.id, () => {
      renderOverviewTimeline();
      renderPosts();
    }, post));
    row.append(meta, open, star);
    return row;
  }));
}

function openOfficialRelease(item) {
  state.dialogPost = null;
  elements['dialog-title'].textContent = localizedCopy(item.releaseId, item.title);
  fillPostBody(elements['dialog-body'], [
    `机构：${item.authority}`,
    item.documentType ? `类型：${item.documentType}` : '',
    item.documentNumber ? `文号：${item.documentNumber}` : '',
    `发布：${staticSignalTime(item, 'official-release')}`,
    `观测：${formatTime(item.observedAt)}`,
  ].filter(Boolean).join('\n'));
  if (elements['dialog-notice']) {
    elements['dialog-notice'].textContent = '当前契约只有元数据，没有文件正文。摘要不能冒充全文。请打开原始链接核对。';
    elements['dialog-notice'].classList.remove('hidden');
  }
  elements['dialog-translation']?.classList.add('hidden');
  elements['dialog-tags']?.replaceChildren();
  elements['dialog-translate']?.classList.add('hidden');
  if (elements['dialog-source']) {
    elements['dialog-source'].classList.toggle('hidden', !item.sourceUrl);
    elements['dialog-source'].onclick = () => openExternalHttpUrl(item.sourceUrl);
  }
  if (elements['dialog-save']) {
    elements['dialog-save'].onclick = () => saveOfficialAsInspiration(item);
  }
  if (elements['dialog-cite']) {
    elements['dialog-cite'].classList.add('hidden');
  }
  elements['dialog-time'].textContent = '官方文件 · 元数据';
  openDialog(elements['post-dialog']);
}

async function saveOfficialAsInspiration(item) {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    return;
  }
  const body = [
    item.title,
    `来源：${item.authority}`,
    item.documentNumber ? `文号：${item.documentNumber}` : '',
    item.sourceUrl ? `来源：${item.sourceUrl}` : '',
    '说明：保存的是官方元数据，不是已采集全文。',
  ].filter(Boolean).join('\n');
  await api('/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify({
      body,
      wantAi: false,
      sourceType: 'official-release',
      sourceId: item.releaseId,
      sourceUrl: item.sourceUrl || '',
      sourceTitle: item.title,
      captureChannel: 'feed',
    }),
  });
  showToast('已存为带来源的灵感，可再引用到问答');
  loadNotes().catch(() => {});
}

function marketNativeAmount(value, { currency = true } = {}) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const prefix = currency ? '$' : '';
  if (Math.abs(number) >= 1e12) return `${prefix}${(number / 1e12).toFixed(2)}T`;
  if (Math.abs(number) >= 1e9) return `${prefix}${(number / 1e9).toFixed(2)}B`;
  if (Math.abs(number) >= 1e6) return `${prefix}${(number / 1e6).toFixed(1)}M`;
  if (Math.abs(number) >= 1e3) return `${prefix}${(number / 1e3).toFixed(1)}K`;
  return `${prefix}${number.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

function predictionShare(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, number));
}

function formatPredictionShare(value) {
  const share = predictionShare(value);
  return share == null ? '—' : `${(share * 100).toFixed(1)}%`;
}

function predictionPrice(value) {
  return formatPredictionShare(value);
}

function marketNativeEmpty(root, text) {
  if (!root) return;
  root.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: text }));
}

function appendPredictionQuote(root, quote) {
  const article = document.createElement('article');
  article.className = 'prediction-quote';
  const yes = predictionShare(quote.midPrice);
  const last = predictionShare(quote.lastPrice);
  const no = yes == null ? null : 1 - yes;
  const outcome = String(quote.outcome || 'Yes');
  const title = Object.assign(document.createElement('b'), { textContent: localizedCopy(quote.quoteId, quote.marketQuestion) });
  const sides = document.createElement('div');
  sides.className = 'prediction-sides';
  const yesCol = document.createElement('div');
  yesCol.className = 'prediction-side is-yes';
  yesCol.append(
    Object.assign(document.createElement('span'), { textContent: outcome }),
    Object.assign(document.createElement('strong'), { textContent: formatPredictionShare(yes) }),
  );
  const noCol = document.createElement('div');
  noCol.className = 'prediction-side is-no';
  noCol.append(
    Object.assign(document.createElement('span'), { textContent: '对立' }),
    Object.assign(document.createElement('strong'), { textContent: formatPredictionShare(no) }),
  );
  sides.append(yesCol, noCol);
  const bar = document.createElement('div');
  bar.className = 'prediction-bar';
  const fill = document.createElement('i');
  fill.style.width = yes == null ? '0%' : `${(yes * 100).toFixed(1)}%`;
  bar.append(fill);
  const moved = last != null && yes != null && Math.abs(yes - last) >= 0.005;
  const detail = [
    moved ? `上次 ${formatPredictionShare(last)}` : '',
    quote.venue,
    quote.endAt ? `截止 ${formatTime(quote.endAt)}` : '',
    quote.volume24h ? `24h ${marketNativeAmount(quote.volume24h)}` : '',
  ].filter(Boolean).join(' · ');
  article.append(title, sides, bar, Object.assign(document.createElement('small'), { textContent: detail }));
  attachGuardedOpen(article, () => openExternalHttpUrl(quote.sourceUrl));
  root.append(article);
}

function appendDerivativeQuote(root, quote) {
  const article = document.createElement('article');
  article.className = 'market-native-row derivative-row';
  const mark = Number(quote.markPrice);
  const prev = Number(quote.previousDayPrice);
  const change = Number.isFinite(mark) && Number.isFinite(prev) && prev !== 0 ? ((mark - prev) / prev) * 100 : null;
  const up = (change ?? 0) >= 0;
  const symbol = Object.assign(document.createElement('strong'), { className: 'market-native-symbol', textContent: quote.symbol });
  const body = document.createElement('div');
  const title = Object.assign(document.createElement('b'), {
    textContent: `Mark ${formatPrice(quote.markPrice, Number(quote.markPrice) >= 1000 ? 0 : 2)}`,
  });
  const funding = quote.fundingRate == null ? '—' : `${(Number(quote.fundingRate) * 100).toFixed(4)}%`;
  const detail = Object.assign(document.createElement('small'), {
    textContent: `Funding ${funding} · OI ${marketNativeAmount(quote.openInterest, { currency: false })} ${quote.symbol} · 24h ${marketNativeAmount(quote.volume24h)}`,
  });
  body.append(title, detail);
  const changeEl = Object.assign(document.createElement('strong'), {
    className: `quote-change ${change == null ? '' : (up ? 'up' : 'down')}`.trim(),
    textContent: change == null ? '—' : formatPct(up, change),
  });
  article.append(symbol, body, changeEl);
  attachGuardedOpen(article, () => openExternalHttpUrl(quote.sourceUrl));
  root.append(article);
}

function appendLiquidityMetric(root, metric, primary = false) {
  const article = document.createElement('article');
  article.className = `market-native-row liquidity-row${primary ? ' is-primary' : ''}`;
  const body = document.createElement('div');
  const title = Object.assign(document.createElement('b'), { textContent: metric.label });
  const detail = Object.assign(document.createElement('small'), {
    textContent: `1d ${marketNativeAmount(metric.change1dUsd)} · 7d ${marketNativeAmount(metric.change7dUsd)} · 30d ${marketNativeAmount(metric.change30dUsd)}`,
  });
  body.append(title, detail);
  const amount = Object.assign(document.createElement('strong'), { className: 'market-native-supply', textContent: marketNativeAmount(metric.supplyUsd) });
  article.append(body, amount);
  root.append(article);
}

function syncGlobalNativeSection() {
  const section = document.getElementById('global-native-section');
  if (!section) return;
  const onGlobal = document.body.dataset.view === 'market' && state.tradePane === 'assets';
  const showCrypto = onGlobal && (state.assetClass === 'all' || state.assetClass === 'crypto');
  section.classList.toggle('hidden', !showCrypto);
}

function renderMarketNativeBoard() {
  const board = state.marketNativeBoard;
  const loadingText = state.marketNativeLoading ? '正在读取公开市场数据…' : '当前没有可用数据。';
  const predictions = elements['market-native-predictions'];
  if (predictions) {
    predictions.replaceChildren();
    if (board?.predictionMarkets?.length) board.predictionMarkets.forEach((quote) => appendPredictionQuote(predictions, quote));
    else marketNativeEmpty(predictions, loadingText);
  }

  const derivatives = elements['market-native-derivatives'];
  if (derivatives) {
    derivatives.replaceChildren();
    if (board?.cryptoDerivatives?.length) board.cryptoDerivatives.forEach((quote) => appendDerivativeQuote(derivatives, quote));
    else marketNativeEmpty(derivatives, loadingText);
  }

  const liquidity = elements['market-native-liquidity'];
  if (liquidity) {
    liquidity.replaceChildren();
    if (board?.stablecoinLiquidity) {
      appendLiquidityMetric(liquidity, board.stablecoinLiquidity.total, true);
      board.stablecoinLiquidity.assets.forEach((metric) => appendLiquidityMetric(liquidity, metric));
      board.stablecoinLiquidity.chains.forEach((metric) => appendLiquidityMetric(liquidity, metric));
    } else marketNativeEmpty(liquidity, loadingText);
  }

  const noteText = state.marketNativeError
    || (state.marketNativeLoading ? '正在同步市场原生来源…' : board
      ? `生成于 ${formatTime(board.generatedAt)} · 场所报价，不是综合概率${(board.sourceHealth || []).some((item) => item.status === 'unavailable') ? ' · 部分来源暂不可用' : ''}`
      : '等待同步市场原生来源');
  if (elements['market-native-note']) elements['market-native-note'].textContent = noteText;
  if (elements['global-native-note']) elements['global-native-note'].textContent = noteText;
  syncGlobalNativeSection();
}

async function loadMarketNativeBoard({ refresh = false } = {}) {
  if (!state.session || state.marketNativeLoading) return;
  if (state.marketNativeBoard && !refresh) {
    renderMarketNativeBoard();
    return;
  }
  state.marketNativeLoading = true;
  state.marketNativeError = '';
  renderMarketNativeBoard();
  try {
    const params = new URLSearchParams({ predictionLimit: '10' });
    if (refresh) params.set('refresh', '1');
    const payload = await api(`/api/v1/market-native/board?${params}`, { timeoutMs: 45_000 });
    state.marketNativeBoard = payload.board;
    mergeLocalizations(payload);
    autoLocalizeSources().catch(() => {});
  } catch (error) {
    state.marketNativeError = error instanceof Error ? error.message : '市场原生数据读取失败';
    throw error;
  } finally {
    state.marketNativeLoading = false;
    renderMarketNativeBoard();
  }
}

function staticSignalTime(item, viewKind) {
  const value = viewKind === 'calendar' ? item.scheduledAt : item.publishedAt;
  if (value === null || value === undefined) {
    if (item.status === 'suspended') return '已暂停';
    if (item.status === 'cancelled') return '已取消';
    if (item.status === 'tba') return '待公布';
    return '时间待公布';
  }
  const date = new Date(value);
  const releaseIsDateOnly = viewKind !== 'calendar' && date.getHours() === 0 && date.getMinutes() === 0;
  const options = item.timePrecision === 'date' || releaseIsDateOnly
    ? { year: 'numeric', month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return date.toLocaleString('zh-CN', options);
}

function staticSignalLinkLabel(item, viewKind) {
  if (viewKind !== 'calendar') return '官方文件 ↗';
  return item.scheduleBasis === 'official-rule' ? '规则依据 ↗' : '官方日程 ↗';
}

function appendStaticSignalItem(root, item, viewKind) {
  const article = document.createElement('article');
  article.className = viewKind === 'calendar' ? 'agenda-row' : 'static-source-item';
  const time = document.createElement('time');
  time.textContent = staticSignalTime(item, viewKind);
  const title = document.createElement('strong');
  title.textContent = localizedCopy(viewKind === 'calendar' ? item.eventId : item.releaseId, item.title);
  const meta = document.createElement('small');
  const facts = viewKind === 'calendar'
    ? [item.country, item.authority, item.referencePeriod, item.scheduleBasis === 'official-rule' ? '规则生成 · 待官网逐日确认' : '官方日历']
    : [item.country, item.authority, item.documentType, item.documentNumber];
  meta.textContent = facts.filter(Boolean).join(' · ');
  const source = document.createElement('button');
  source.type = 'button';
  source.className = 'text-button static-source-link';
  source.textContent = staticSignalLinkLabel(item, viewKind);
  source.addEventListener('click', () => openExternalHttpUrl(item.sourceUrl));
  article.addEventListener('click', () => {
    if (viewKind === 'calendar') openPage('event', item.eventId);
    else openArticle(officialAsItem(item));
  });
  root.append(article);
}

async function openStaticSource(source) {
  elements['source-dialog-title'].textContent = source.title;
  elements['source-dialog-meta'].textContent = '正在读取官方来源…';
  elements['source-dialog-items'].replaceChildren();
  openDialog(elements['source-dialog']);
  try {
    const params = new URLSearchParams({ limit: source.viewKind === 'calendar' ? '200' : '50' });
    if (source.viewKind === 'calendar') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      params.set('from', String(today.getTime()));
      params.set('to', String(today.getTime() + 400 * 86_400_000));
    }
    const payload = await api(`/api/v1/sources/${source.id}?${params}`, { timeoutMs: 30_000 });
    const snapshot = payload.snapshot;
    state.sourceSnapshots[source.id] = snapshot;
    mergeLocalizations(payload);
    autoLocalizeSources().catch(() => {});
    const rows = source.viewKind === 'calendar' ? snapshot.data.events : snapshot.data.releases;
    const status = snapshot.status === 'ready' ? '可用' : snapshot.status === 'partial' ? '部分可用' : '暂不可用';
    elements['source-dialog-meta'].textContent = [status, snapshot.data.note, `观测于 ${formatTime(snapshot.observedAt)}`].filter(Boolean).join(' · ');
    if (!rows.length) {
      elements['source-dialog-items'].replaceChildren(Object.assign(document.createElement('div'), {
        className: 'empty-state', textContent: snapshot.status === 'unavailable' ? '官方来源当前无法读取。' : '所选范围内暂无条目。',
      }));
      return;
    }
    elements['source-dialog-items'].replaceChildren();
    rows.forEach((item) => appendStaticSignalItem(elements['source-dialog-items'], item, source.viewKind));
  } catch (error) {
    elements['source-dialog-meta'].textContent = error.message;
    elements['source-dialog-items'].replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state', textContent: '读取失败，请稍后重试。',
    }));
  }
}

async function loadSourcesPage({ refresh = false } = {}) {
  renderHub();
  const tasks = [];
  if (state.session) {
    if (refresh || overviewFocusIsStale()) tasks.push(loadMarket({ board: 'overview' }).catch(() => {}));
    if (!state.assetBoard) tasks.push(loadGlobalAssets().catch(() => {}));
    if (!state.staticBoard || refresh) tasks.push(loadStaticSignalBoard({ refresh }));
    if (!state.marketNativeBoard || refresh) tasks.push(loadMarketNativeBoard({ refresh }));
  }
  if (tasks.length) await Promise.all(tasks);
  renderSources();
  scheduleOverviewFocusWatch();
}

let overviewFocusTimer = 0;

function scheduleOverviewFocusWatch() {
  if (overviewFocusTimer) window.clearTimeout(overviewFocusTimer);
  const delay = Math.min(Math.max(nextOverviewFocusChangeMs() - Date.now() + 750, 1_000), 2_000_000_000);
  overviewFocusTimer = window.setTimeout(() => {
    overviewFocusTimer = 0;
    if (state.session && (document.body.dataset.view === 'sources' || (isQuotesView() && state.tradePane === 'stocks') || overviewFocusIsStale())) {
      loadMarket({ board: 'overview' }).catch(() => {});
      if (state.stockBoard !== 'overview' && isQuotesView() && state.tradePane === 'stocks') {
        loadMarket().catch(() => {});
      }
    }
    scheduleOverviewFocusWatch();
  }, delay);
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
  if (market?.note) {
    root.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: market.note }));
  }
  for (const section of market?.sections || []) {
    const wrap = document.createElement('section');
    wrap.className = 'market-section';
    const heading = document.createElement('div');
    heading.className = 'market-section-title';
    heading.append(Object.assign(document.createElement('h2'), { textContent: section.title }));
    if (section.session) {
      heading.append(Object.assign(document.createElement('small'), { className: 'muted', textContent: sessionLabel(section.session) }));
    }
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
  const article = document.createElement('article');
  article.className = 'breadth-card';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const strong = document.createElement('strong');
  const unit = document.createElement('small');
  unit.textContent = '家';
  strong.append(String(total), unit);
  const caption = document.createElement('span');
  caption.textContent = '已报价';
  const track = document.createElement('div');
  track.className = 'breadth-track';
  const summaryText = `${up} 涨 · ${flat} 平 · ${down} 跌`;
  const svg = svgNode('svg', {
    viewBox: '0 0 1000 10',
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': summaryText,
  });
  let x = 0;
  for (const [name, count] of [['up', up], ['flat', flat], ['down', down]]) {
    const width = total ? (count / total) * 1000 : 0;
    if (width <= 0) continue;
    svg.append(svgNode('rect', {
      x: String(x),
      y: '0',
      width: String(width),
      height: '10',
      class: name,
    }));
    x += width;
  }
  track.append(svg);
  const summary = document.createElement('p');
  summary.textContent = summaryText;
  article.append(heading, strong, caption, track, summary);
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
    row.innerHTML = `<span class="quote-identity identity">
        <strong class="quote-name">${item.name}</strong>
        <small class="quote-code">${code}</small>
      </span>
      <span class="market-spark">${sparkSvg(item.sparkline, item.changePct)}</span>
      <span class="q-price">
        <strong class="quote-price ${up ? 'up' : 'down'}">${format(item, item.lastPrice)}</strong>
        <b class="quote-change ${up ? 'up' : 'down'}">${item.changePct === null ? '—' : formatPct(up, item.changePct)}</b>
      </span>`;
    if (item.group === '自选') {
      const identity = row.querySelector('.quote-identity');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'text-button market-remove';
      remove.textContent = '移除';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        const board = extrasBoardFor(item.symbol);
        writeExtras(board, state.extras[board].filter((symbol) => symbol !== item.symbol));
        loadMarket().catch((error) => showToast(error.message));
      });
      identity.append(remove);
    }
    row.addEventListener('click', () => openPage('quote', item.symbol));
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
        const board = extrasBoardFor(item.symbol);
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

function openSourceTasks(sourceId = 'all') {
  const dialog = elements['source-tasks-dialog'];
  if (!dialog) {
    showToast('来源任务入口尚未就绪');
    return;
  }
  if (elements['source-tasks-title']) {
    elements['source-tasks-title'].textContent = sourceId === 'x'
      ? 'X 来源任务'
      : sourceId === 'xueqiu'
        ? '雪球来源任务'
        : sourceId === 'bilibili'
          ? 'B站来源任务'
          : sourceId === 'trendforce'
            ? 'TrendForce 来源任务'
            : '后台任务';
  }
  if (elements['source-tasks-meta']) {
    elements['source-tasks-meta'].textContent = sourceId === 'x'
      ? '先选正在关注或为你推荐，再抓取。抓取会立刻跑采集、翻译和打 Tag。下面的自动化草案不会启动定时任务。'
      : sourceId === 'xueqiu'
        ? '关注和精选需要采集浏览器已登录雪球。7x24 走快讯接口。不扒首页 DOM。'
        : sourceId === 'trendforce'
          ? '公开洞察和价表抓全文。会员研报只收标题与介绍，不下载 PDF。'
          : '维护入口。自动化草案不会启动后台调度。';
  }
  const body = elements['source-tasks-body'];
  body.replaceChildren();
  const addAction = (label, detail, onClick, { primary = false } = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = primary ? 'primary-button task-run' : 'task-row';
    if (primary) {
      button.textContent = label;
    } else {
      button.append(
        Object.assign(document.createElement('span'), {
          innerHTML: `<strong>${label}</strong><small>${detail}</small>`,
        }),
      );
    }
    button.addEventListener('click', onClick);
    body.append(button);
    if (primary && detail) {
      body.append(Object.assign(document.createElement('p'), {
        className: 'page-note task-run-note',
        textContent: detail,
      }));
    }
  };
  if (sourceId === 'x' || sourceId === 'all') {
    if (state.xFeed !== 'following') setXFeed('following', { reload: true });
    const scopeTabs = document.createElement('div');
    scopeTabs.className = 'chip-tabs';
    scopeTabs.setAttribute('role', 'tablist');
    scopeTabs.setAttribute('aria-label', 'X 时间线');
    body.append(scopeTabs);
    const captureButton = document.createElement('button');
    captureButton.type = 'button';
    captureButton.className = 'primary-button task-run';
    captureButton.addEventListener('click', () => {
      runXCapturePipeline().catch((error) => showToast(error.message));
    });
    body.append(captureButton);
    const captureNote = document.createElement('p');
    captureNote.className = 'page-note task-run-note';
    body.append(captureNote);
    const paintScope = () => {
      renderChipTabs(scopeTabs, [
        { id: 'following', label: '正在关注' },
        { id: 'for-you', label: '为你推荐' },
      ], state.xFeed, (id) => {
        setXFeed(id, { reload: true });
        paintScope();
      });
      captureButton.textContent = xCaptureActionLabel();
      captureNote.textContent = xCaptureScopeNote();
    };
    paintScope();
    addAction('补翻译未完成条目', '抓取后会自动走 Gemini；这里只补失败项，一次最多 30 条', () => {
      dialog.close();
      translateXBatch().catch((error) => showToast(error.message));
    });
    addAction('标注未标注内容', '走已注册 Worker 标注任务', () => {
      dialog.close();
      tagXBatch().catch((error) => showToast(error.message));
    });
  }
  if (sourceId === 'xueqiu' || sourceId === 'all') {
    const scopeTabs = document.createElement('div');
    scopeTabs.className = 'chip-tabs';
    scopeTabs.setAttribute('role', 'tablist');
    scopeTabs.setAttribute('aria-label', '雪球栏目');
    body.append(scopeTabs);
    const captureButton = document.createElement('button');
    captureButton.type = 'button';
    captureButton.className = 'primary-button task-run';
    captureButton.addEventListener('click', () => {
      dialog.close();
      loadXueqiuFeed({ refresh: true }).catch((error) => showToast(error.message));
    });
    body.append(captureButton);
    const captureNote = document.createElement('p');
    captureNote.className = 'page-note task-run-note';
    body.append(captureNote);
    const paintScope = () => {
      renderChipTabs(scopeTabs, [
        { id: 'following', label: '关注' },
        { id: 'featured', label: '精选' },
        { id: 'livenews', label: '7x24' },
      ], state.xueqiuFeed, (id) => {
        setXueqiuFeed(id, { reload: true });
        paintScope();
      });
      captureButton.textContent = `抓取${xueqiuFeedLabel()} 50 条`;
      captureNote.textContent = state.xueqiuFeed === 'livenews'
        ? '抓雪球 7x24 快讯。'
        : `抓${xueqiuFeedLabel()}时间线。请先在采集浏览器登录 https://xueqiu.com/ 。`;
    };
    paintScope();
  }
  if (sourceId === 'bilibili' || sourceId === 'all') {
    const form = document.createElement('form');
    form.className = 'task-control-panel';
    form.innerHTML = '<label class="task-field">B站视频链接<input name="url" placeholder="https://www.bilibili.com/video/..."></label><button class="primary-button" type="submit">采集字幕</button>';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const url = String(new FormData(form).get('url') || '').trim();
      if (!url) return showToast('请输入视频链接');
      loadBilibiliFeed({ url, refresh: true }).catch((error) => showToast(error.message));
    });
    body.append(form);
  }
  if (sourceId === 'trendforce' || sourceId === 'all') {
    addAction('抓取公开页', '洞察全文、会员报告索引、最新 DRAM/NAND 价表', () => {
      dialog.close();
      loadTrendForceFeed({ refresh: true }).catch((error) => showToast(error.message));
    }, { primary: true });
  }
  const auto = document.createElement('div');
  auto.className = 'auto-chain';
  let draft = {};
  try { draft = JSON.parse(window.localStorage.getItem(AUTO_DRAFT_KEY) || '{}'); } catch { draft = {}; }
  auto.innerHTML = `<strong>自动化设置（草案）</strong>
    <p>这里只记本机偏好，保存后不会启动定时任务。要真正抓取，请用上面的抓取按钮。</p>
    <label>频率 <select name="freq"><option ${draft.freq === 'manual' ? 'selected' : ''} value="manual">仅手动</option><option ${draft.freq === 'hourly' ? 'selected' : ''} value="hourly">每小时（未启用）</option></select></label>
    <button class="secondary" type="button" id="save-auto-draft">保存草案</button>
    <p id="auto-draft-status">${draft.saved ? '草案已保存，自动化未启用' : '尚未保存草案'}</p>`;
  auto.querySelector('#save-auto-draft')?.addEventListener('click', () => {
    const freq = auto.querySelector('select')?.value || 'manual';
    window.localStorage.setItem(AUTO_DRAFT_KEY, JSON.stringify({ freq, saved: true, savedAt: Date.now() }));
    const status = auto.querySelector('#auto-draft-status');
    if (status) status.textContent = '草案已保存，自动化未启用';
    showToast('草案已保存，自动化未启用');
  });
  body.append(auto);
  openDialog(dialog);
}

function pageRoot() {
  return elements['page-root'];
}

function htmlToNode(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  return wrap;
}

function renderPage() {
  const root = pageRoot();
  if (!root) return;
  const kind = state.pageKind;
  if (kind !== 'quote') destroyQuoteChart();
  if (kind === 'article') renderArticlePage();
  else if (kind === 'event') renderEventPage();
  else if (kind === 'source') renderSourcePage();
  else if (kind === 'quote') renderQuotePage();
  else if (kind === 'tasks' || kind === 'task') renderTasksPage();
  else if (kind === 'note') renderNotePage();
  else if (kind === 'account') renderAccountPage();
  else if (kind === 'holding') renderHoldingPage();
  else if (kind === 'automation') renderAutomationPage();
  else if (kind === 'publish') renderPublishPage();
  else root.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '找不到这个页面。' }));
  syncHeaderSearch();
}

function readerLangLabel() {
  return state.readerLang === 'original' ? '原文' : state.readerLang === 'compare' ? '对照' : '译文';
}

async function loadOriginalBody(post) {
  const id = post.resourceId || post.id;
  if (state.originalBodies[id]) return state.originalBodies[id];
  try {
    const payload = await api(`/api/v1/feed/items/${encodeURIComponent(id)}/original`);
    state.originalBodies[id] = payload.original?.body || payload.original?.text || post.body || '';
  } catch {
    state.originalBodies[id] = post.body || '';
  }
  return state.originalBodies[id];
}

function createDetailAction({ iconName, label, primary = false, pressed = false, onClick }) {
  const button = document.createElement('button');
  button.type = 'button';
  if (primary) button.classList.add('is-primary');
  if (pressed) button.classList.add('is-focus-on');
  button.innerHTML = `${icon(iconName)}<span>${label}</span>`;
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

function renderArticlePage() {
  const root = pageRoot();
  const id = state.pageId || '';
  const official = id.startsWith('official/');
  const itemId = official ? id.slice('official/'.length) : id;
  const post = official
    ? officialFeedItems().find((item) => item.id === itemId || item.resourceId === itemId)
    : findUnifiedItem(itemId);
  if (!post) {
    root.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '这条内容已不在当前列表里。' }));
    return;
  }
  state.dialogPost = post;
  markFeedItemRead(post);
  persistFeedBrowseState();
  const translated = translationFor(post)?.text;
  const hasTranslation = Boolean(translated);
  const shell = document.createElement('article');
  shell.className = 'page-article detail-shell';
  const head = document.createElement('header');
  head.className = 'detail-head reader-head';
  head.innerHTML = `<h2 class="detail-title"></h2><div class="detail-meta reader-meta"></div>`;
  head.querySelector('h2').textContent = postDisplayTitle(post);
  const meta = head.querySelector('.reader-meta');
  meta.append(
    Object.assign(document.createElement('button'), { className: 'text-button', textContent: `${post.author} ›` }),
    Object.assign(document.createElement('span'), { textContent: `${post.time || formatTime(post.publishedAt)} 发布` }),
    Object.assign(document.createElement('span'), { className: 'kind-tag', textContent: feedKindLabel(post) }),
  );
  const completeLabel = post.complete === false ? '仅索引' : '正文完整';
  if (isHttpUrl(post.sourceUrl)) {
    const source = appendExternalLink(meta, post.sourceUrl, completeLabel);
    source.className = 'kind-tag official';
    source.setAttribute('aria-label', `打开原文（${completeLabel}）`);
  } else {
    meta.append(Object.assign(document.createElement('span'), { className: 'kind-tag official', textContent: completeLabel }));
  }
  meta.querySelector('button').addEventListener('click', () => {
    if (post.platform === 'official') openPage('source', `policy.${post.author}`);
    else openPage('source', post.platform === 'manual' ? 'manual' : post.platform);
  });
  const body = document.createElement('div');
  if (post.kind === 'official' && post.complete === false) {
    const fetched = state.officialBodies[post.id];
    const status = fetched?.status || 'idle';
    const metaGrid = document.createElement('dl');
    metaGrid.className = 'metadata-grid';
    metaGrid.innerHTML = `<dt>收录内容</dt><dd>发布索引，尚无正文</dd>
      <dt>发布机构</dt><dd></dd>
      <dt>原始链接</dt><dd></dd>`;
    metaGrid.querySelectorAll('dd')[1].textContent = post.author;
    metaGrid.querySelectorAll('dd')[2].textContent = post.sourceUrl || '未提供';
    const stateBox = document.createElement('section');
    stateBox.className = 'body-state detail-surface';
    if (status === 'loading') {
      stateBox.innerHTML = '<strong>正在获取全文</strong><p>走现有官方详情 Source，不把标题当成正文。</p>';
    } else if (status === 'ready' && fetched?.text) {
      stateBox.replaceChildren();
      const content = document.createElement('div');
      content.className = 'reader-content';
      fillPostBody(content, fetched.text);
      body.append(metaGrid, content);
    } else if (status === 'failed') {
      stateBox.innerHTML = '<strong>正文获取失败</strong><p></p><button class="primary-button" type="button">重新获取全文</button>';
      stateBox.querySelector('p').textContent = fetched?.error || '当前索引契约没有正文。';
      stateBox.querySelector('button').addEventListener('click', () => fetchOfficialBody(post));
    } else {
      stateBox.innerHTML = '<strong>仅收录索引，正文未抓取</strong><p>不能把标题或摘要当作全文。获取会调用官方详情 Source。</p><button class="primary-button" type="button">获取全文</button>';
      stateBox.querySelector('button').addEventListener('click', () => fetchOfficialBody(post));
    }
    if (status !== 'ready') body.append(metaGrid, stateBox);
  } else {
    if (hasTranslation) {
      const tabs = document.createElement('div');
      tabs.className = 'dense-tabs reader-tabs';
      renderChipTabs(tabs, [
        { id: 'translation', label: '译文' },
        { id: 'original', label: '原文' },
        { id: 'compare', label: '对照' },
      ], state.readerLang, (id) => {
        state.readerLang = id;
        renderArticlePage();
        if (id !== 'translation') loadOriginalBody(post).then(() => renderArticlePage());
      });
      body.append(tabs);
    }
    const content = document.createElement('div');
    content.className = 'reader-content detail-body';
    const original = state.originalBodies[post.resourceId || post.id] || post.body;
    const viewText = state.readerLang === 'original' ? original : (translated || original);
    fillPostBody(content, viewText);
    if (state.readerLang === 'compare' && translated) {
      content.append(Object.assign(document.createElement('h3'), { className: 'lang-label', textContent: '原文' }));
      const orig = document.createElement('div');
      fillPostBody(orig, original);
      content.append(orig);
    }
    body.append(content);
    const articleTags = createTagRow(postTagNames(post));
    if (articleTags) {
      articleTags.classList.add('detail-tags');
      body.append(articleTags);
    }
    ensurePostTags(post);
  }
  const bar = document.createElement('div');
  bar.className = 'detail-actions reader-bar';
  const save = createDetailAction({
    iconName: 'bookmark',
    label: isPostSaved(post) ? '查看灵感' : '存入灵感',
    onClick: () => {
      if (post.release) saveOfficialAsInspiration(post.release);
      else savePostToInspiration(post).catch((error) => showToast(error.message));
    },
  });
  const cite = createDetailAction({
    iconName: 'corner-up-right',
    label: '引用',
    onClick: () => toggleReference({
      resourceType: post.resourceType || 'content-item',
      resourceId: post.resourceId || post.id,
      label: postDisplayTitle(post),
      preview: post.body,
    }),
  });
  const focused = itemIsFocused(post);
  const star = createDetailAction({
    iconName: 'star',
    label: focused ? '取消重点' : '重点',
    pressed: focused,
    onClick: () => toggleFocus(post.id, () => renderArticlePage(), post),
  });
  star.setAttribute('aria-label', focused ? '取消重点' : '加入重点');
  const analyze = createDetailAction({
    iconName: 'search',
    label: '分析',
    primary: true,
    onClick: () => startArticleAnalysis(post).catch((error) => showToast(error.message)),
  });
  bar.append(save, cite, analyze, star);
  const analysis = renderArticleAnalysisPanel(post);
  if (analysis) shell.append(head, body, analysis, bar);
  else shell.append(head, body, bar);
  root.replaceChildren(shell);
  if (postNeedsChineseTranslation(post) && !translationFor(post)) {
    requestTranslate(post).catch((error) => showToast(error.message));
  }
}

async function fetchOfficialBody(post) {
  const sourceUrl = post.sourceUrl;
  if (!sourceUrl) {
    showToast('这条索引没有官方链接');
    return;
  }
  state.officialBodies[post.id] = { status: 'loading' };
  renderArticlePage();
  try {
    const payload = await api(`/api/v1/official-detail?sourceUrl=${encodeURIComponent(sourceUrl)}`, { timeoutMs: 45_000 });
    const data = payload.snapshot?.data || payload.detail || {};
    if (!data.available || !data.bodyText) {
      state.officialBodies[post.id] = { status: 'failed', error: data.note || '官方页面没有可展示正文' };
    } else {
      state.officialBodies[post.id] = { status: 'ready', text: data.bodyText };
    }
  } catch (error) {
    state.officialBodies[post.id] = { status: 'failed', error: error instanceof Error ? error.message : '获取失败' };
  }
  renderArticlePage();
}

function formatArticleProgressText(progress) {
  const steps = Array.isArray(progress) ? progress : [];
  const active = [...steps].reverse().find((step) => step.status === 'active') || steps.at(-1);
  if (!active) return '';
  return [active.label, active.detail].filter(Boolean).join(' · ');
}

function articleAnalysisKey(post) {
  return String(post.resourceId || post.id || '');
}

function articleAnalysisSource(post) {
  const resourceType = post.resourceType || (post.platform === 'manual' ? 'post' : 'content-item');
  const resourceId = post.resourceId || (resourceType === 'content-item' ? post.id : '');
  if (resourceId && (resourceType === 'content-item' || resourceType === 'post' || resourceType === 'inspiration')) {
    return { type: 'reference', reference: { resourceType, resourceId } };
  }
  const fetched = state.officialBodies[post.id]?.text || '';
  const body = String(fetched || post.body || translationFor(post)?.text || '').trim();
  return {
    type: 'inline',
    title: postDisplayTitle(post),
    body,
    sourceUrl: isHttpUrl(post.sourceUrl) ? post.sourceUrl : undefined,
  };
}

function renderArticleAnalysisPanel(post) {
  const record = state.articleAnalysis[articleAnalysisKey(post)];
  if (!record) return null;
  const section = document.createElement('section');
  section.className = 'detail-section';
  const title = document.createElement('h3');
  title.className = 'detail-section-title';
  title.textContent = record.status === 'completed' ? '研究结果' : '研究';
  const surface = document.createElement('div');
  surface.className = 'detail-surface article-analysis';
  section.append(title, surface);
  if (record.status === 'running' || record.status === 'queued') {
    const status = document.createElement('p');
    status.className = 'page-note';
    status.textContent = record.stageLabel || '正在分析这份材料';
    surface.append(status);
    return section;
  }
  if (record.status === 'failed') {
    const status = document.createElement('p');
    status.className = 'page-note';
    status.textContent = record.error || '分析未能完成';
    surface.append(status);
    return section;
  }
  const answer = document.createElement('div');
  answer.className = 'article-analysis-answer';
  renderMarkdownInto(answer, record.outputText || '分析已完成');
  surface.append(answer);
  return section;
}

async function pollArticleAnalysis(key, runId) {
  try {
    const payload = await api(`/api/v1/article-analysis/runs/${runId}`, { timeoutMs: 15_000 });
    const current = state.articleAnalysis[key] || {};
    state.articleAnalysis[key] = {
      ...current,
      runId,
      status: payload.status,
      stage: payload.stage,
      stageLabel: payload.status === 'completed'
        ? '分析已完成'
        : (formatArticleProgressText(payload.progress) || current.stageLabel || '正在分析这份材料'),
      outputText: payload.outputText || '',
      error: payload.error?.message || payload.error || '',
    };
    if (state.pageKind === 'article') renderArticlePage();
    if (payload.status === 'queued' || payload.status === 'running') {
      window.setTimeout(() => pollArticleAnalysis(key, runId), 1_200);
    }
  } catch (error) {
    state.articleAnalysis[key] = {
      ...(state.articleAnalysis[key] || {}),
      runId,
      status: 'failed',
      error: error.message || '分析查询失败',
    };
    if (state.pageKind === 'article') renderArticlePage();
  }
}

async function startArticleAnalysis(post) {
  const key = articleAnalysisKey(post);
  const source = articleAnalysisSource(post);
  if (source.type === 'inline' && !source.body) {
    showToast('这条材料没有可分析正文');
    return;
  }
  state.articleAnalysis[key] = { status: 'queued', stage: 'queued', stageLabel: '正在阅读材料' };
  renderArticlePage();
  const created = await api('/api/v1/article-analysis/runs', {
    method: 'POST',
    body: JSON.stringify({ source }),
  });
  state.articleAnalysis[key] = {
    ...state.articleAnalysis[key],
    runId: created.runId,
    status: 'queued',
  };
  pollArticleAnalysis(key, created.runId);
}

function renderEventPage() {
  const root = pageRoot();
  const event = (state.staticBoard?.upcoming || []).find((item) => String(item.eventId || item.id) === state.pageId);
  if (!event) {
    root.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '这条日程已不在当前窗口。' }));
    return;
  }
  const wrap = document.createElement('article');
  wrap.innerHTML = `<div class="event-label"></div><h2 class="event-card-title"></h2><div class="event-time"></div>
    <dl class="metadata-grid"></dl><p class="page-note"></p><div class="content-tools"></div>`;
  wrap.querySelector('.event-card-title').textContent = localizedCopy(event.eventId, event.title);
  wrap.querySelector('.event-time').textContent = `${staticSignalTime(event, 'calendar')}`;
  const grid = wrap.querySelector('.metadata-grid');
  const rows = [
    ['发布机构', event.authority || event.sourceId],
    ['国家', event.country === 'CN' ? '中国' : event.country === 'US' ? '美国' : event.country || '未提供'],
    ['状态', event.status === 'tentative' ? '暂定' : event.status === 'cancelled' ? '已取消' : event.status || '官方日程'],
    ['时间精度', event.timePrecision === 'exact' ? '精确到分钟' : event.timePrecision === 'date' ? '仅日期；不补写时刻' : '时间待公布'],
    ['日程依据', event.scheduleBasis === 'official-rule' ? '官方规则生成，待逐日确认' : '官网逐项日程'],
    ['参考期', event.referencePeriod || '来源未提供'],
    ['来源观测', formatTime(event.observedAt)],
  ];
  for (const [dt, dd] of rows) {
    grid.append(Object.assign(document.createElement('dt'), { textContent: dt }), Object.assign(document.createElement('dd'), { textContent: dd }));
  }
  wrap.querySelector('.page-note').textContent = event.note || event.description || '';
  const save = document.createElement('button');
  save.className = 'text-button';
  save.type = 'button';
  save.textContent = '存为灵感';
  save.addEventListener('click', () => saveEventAsInspiration(event));
  const source = document.createElement('button');
  source.className = 'text-button';
  source.type = 'button';
  source.textContent = '查看信源';
  source.addEventListener('click', () => openPage('source', event.sourceId));
  wrap.querySelector('.content-tools').append(save, source);
  root.replaceChildren(wrap);
}

async function saveEventAsInspiration(event) {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    return;
  }
  await api('/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify({
      body: [event.title, event.authority, event.note].filter(Boolean).join('\n'),
      wantAi: false,
      sourceType: 'scheduled-event',
      sourceId: event.eventId || event.id,
      sourceUrl: event.sourceUrl || '',
      sourceTitle: event.title,
      captureChannel: 'feed',
    }),
  });
  showToast('已存为带来源的灵感');
  loadNotes().catch(() => {});
}

function renderSourcePage() {
  const root = pageRoot();
  const id = state.pageId;
  const def = [{ id: 'x', title: 'X' }, { id: 'xueqiu', title: '雪球' }, { id: 'bilibili', title: 'B站' }, { id: 'trendforce', title: 'TrendForce' }, { id: 'manual', title: '手工发布' }]
    .find((item) => item.id === id)
    || state.sourceCatalog.find((item) => item.id === id);
  if (!def) {
    root.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '未知信源。' }));
    return;
  }
  elements['page-title'].textContent = sourceDisplayTitle(def);
  const wrap = document.createElement('div');
  const health = (state.staticBoard?.sourceHealth || []).find((item) => item.sourceId === id);
  wrap.innerHTML = `<div class="health-line mini-status"><span></span><button class="text-button" type="button">自动任务 ›</button></div>`;
  wrap.querySelector('span').textContent = health
    ? `${health.status === 'ready' ? '最近检查成功' : health.note || health.status} · ${health.observedAt ? formatTime(health.observedAt) : ''}`
    : '只读已保存结果，新采集在右上角任务里发起';
  wrap.querySelector('button').addEventListener('click', () => openPage('automation', id));
  if (id === 'x' || id === 'xueqiu' || id === 'bilibili' || id === 'trendforce' || id === 'manual') {
    state.feedPlatform = id === 'manual' ? 'manual' : id;
    state.platform = state.feedPlatform;
    const list = document.createElement('div');
    list.className = 'source-feed';
    const rows = socialFeedItems().filter((item) => item.platform === (id === 'manual' ? 'manual' : id)
      && (id !== 'x' || !item.mode || item.mode === state.xFeed));
    if (!rows.length) list.append(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '当前信源尚无已存内容。' }));
    else rows.slice(0, 40).forEach((post) => {
      const card = document.createElement('article');
      card.className = 'post-card is-compact';
      card.innerHTML = `<div class="post-meta"><span class="post-identity"></span><span class="post-time"></span></div><button class="feed-content" type="button"><h3></h3></button>`;
      card.querySelector('.post-identity').textContent = post.author;
      card.querySelector('.post-time').textContent = post.time;
      card.querySelector('h3').textContent = postDisplayTitle(post);
      attachGuardedOpen(card.querySelector('.feed-content'), () => openArticle(post));
      list.append(card);
    });
    const more = document.createElement('button');
    more.className = 'text-button';
    more.type = 'button';
    more.textContent = '采集与处理 ›';
    more.addEventListener('click', () => openSourceTasks(id));
    wrap.append(list, more);
  } else if (sourceKind(def) === 'calendar') {
    const events = (state.staticBoard?.upcoming || []).filter((item) => item.sourceId === id);
    if (!events.length) wrap.append(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '该信源在当前窗口没有日程。' }));
    events.forEach((event) => wrap.append(scheduleRow(event)));
  } else if (sourceKind(def) === 'release') {
    const rows = officialFeedItems().filter((item) => item.release?.sourceId === id || `policy.${item.author}` === id);
    if (!rows.length) wrap.append(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '此信源当前没有发布索引。' }));
    rows.forEach((post) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'post-card is-compact';
      button.innerHTML = '<h3></h3>';
      button.querySelector('h3').textContent = postDisplayTitle(post);
      button.addEventListener('click', () => openArticle(post));
      wrap.append(button);
    });
  } else {
    const go = document.createElement('button');
    go.className = 'primary-button';
    go.type = 'button';
    go.textContent = id === 'market.global' ? '打开全球行情' : '打开股票看板';
    go.addEventListener('click', () => setView(id === 'market.global' ? 'market/global' : 'market'));
    wrap.append(go);
  }
  root.replaceChildren(wrap);
}

function scheduleRow(event) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'schedule-mini agenda-row';
  button.innerHTML = `<time></time><div><strong></strong><small></small></div>`;
  button.querySelector('time').textContent = staticSignalTime(event, 'calendar');
  button.querySelector('strong').textContent = localizedCopy(event.eventId, event.title);
  button.querySelector('small').textContent = event.authority || event.sourceId;
  button.addEventListener('click', () => openPage('event', event.eventId || event.id));
  return button;
}

function findQuote(symbol) {
  const lists = [
    ...(state.markets.us?.watchlist || []),
    ...(state.markets.asia?.watchlist || []),
    ...(state.markets.cn?.watchlist || []),
    ...(state.assetBoard?.watchlist || []),
    ...hubQuotes(),
  ];
  return lists.find((item) => item.symbol === symbol) || { symbol, name: symbol, lastPrice: null, changePct: null };
}

const quotePeriods = [
  { id: '1d', label: '日K', range: '2y', interval: '1d' },
  { id: '1wk', label: '周K', range: '5y', interval: '1wk' },
  { id: '1y', label: '年K', range: 'max', interval: '1mo' },
];

function destroyQuoteChart() {
  state.quoteChart?.destroy?.();
  state.quoteChart = null;
}

function renderQuotePage() {
  const root = pageRoot();
  const quote = findQuote(state.pageId);
  const symbol = quote.symbol || state.pageId;
  const up = (quote.changePct ?? 0) >= 0;
  destroyQuoteChart();
  const wrap = document.createElement('article');
  wrap.className = 'detail-shell quote-detail';
  wrap.innerHTML = `<header class="detail-head">
      <h2 class="detail-title"></h2>
      <div class="detail-meta"></div>
    </header>
    <div class="detail-body">
      <div class="quote-last-row">
        <strong class="last num"></strong>
        <b class="change"></b>
      </div>
      <div class="chip-tabs quote-period-tabs" role="tablist" aria-label="K线周期"></div>
      <div class="quote-chart-host" id="quote-chart-host"></div>
    </div>`;
  wrap.querySelector('.detail-title').textContent = quote.name || symbol;
  wrap.querySelector('.detail-meta').textContent = `${symbol}${quote.group ? ` · ${quote.group}` : ''}${quote.assetClass ? ` · ${quote.assetClass}` : ''}`;
  wrap.querySelector('.last').textContent = quote.lastPrice == null ? '—' : formatPrice(quote.lastPrice);
  wrap.querySelector('.last').classList.add(up ? 'up' : 'down');
  wrap.querySelector('.change').textContent = quote.changePct == null ? '—' : formatPct(up, quote.changePct);
  wrap.querySelector('.change').classList.add(up ? 'up' : 'down');
  const tabs = wrap.querySelector('.quote-period-tabs');
  quotePeriods.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chip-tab${state.quotePeriod === item.id ? ' is-active' : ''}`;
    button.textContent = item.label;
    button.addEventListener('click', () => {
      state.quotePeriod = item.id;
      renderQuotePage();
    });
    tabs.append(button);
  });
  root.replaceChildren(wrap);
  loadQuoteHistory(symbol, wrap.querySelector('#quote-chart-host')).catch((error) => showToast(error.message));
}

function paintQuotePrintFromBars(host, bars) {
  const detail = host.closest('.quote-detail');
  const lastEl = detail?.querySelector('.last');
  const changeEl = detail?.querySelector('.change');
  if (!lastEl || lastEl.textContent !== '—') return;
  const close = Number(bars.at(-1)?.close);
  const previous = Number(bars.at(-2)?.close);
  if (!Number.isFinite(close)) return;
  const up = Number.isFinite(previous) ? close >= previous : true;
  const digits = Math.abs(close) >= 1 ? 2 : Math.abs(close) >= 0.01 ? 4 : 6;
  lastEl.textContent = formatPrice(close.toFixed(digits));
  lastEl.classList.toggle('up', up);
  lastEl.classList.toggle('down', !up);
  if (!changeEl || !Number.isFinite(previous) || previous === 0) return;
  changeEl.textContent = formatPct(up, ((close - previous) / Math.abs(previous)) * 100);
  changeEl.classList.toggle('up', up);
  changeEl.classList.toggle('down', !up);
}

async function loadQuoteHistory(symbol, host) {
  if (!host) return;
  const requestId = state.quoteHistoryRequestId + 1;
  state.quoteHistoryRequestId = requestId;
  host.textContent = '正在加载 K 线…';
  const { createQuoteChart, aggregateYearlyBars } = await import('./quote-chart.js?v=dev');
  if (requestId !== state.quoteHistoryRequestId) return;
  const period = quotePeriods.find((item) => item.id === state.quotePeriod) || quotePeriods[0];
  const payload = await api(`/api/v1/markets/history?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(period.range)}&interval=${encodeURIComponent(period.interval)}`, {
    timeoutMs: 25_000,
  });
  if (requestId !== state.quoteHistoryRequestId) return;
  const bars = period.id === '1y' ? aggregateYearlyBars(payload.history?.bars || []) : (payload.history?.bars || []);
  if (!bars.length) {
    host.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'empty-state',
      textContent: '这只标的暂时没有 K 线。股票、期货、利率和全球资产都走同一套历史行情。',
    }));
    return;
  }
  paintQuotePrintFromBars(host, bars);
  const chart = await createQuoteChart(host, {
    ariaLabel: `${symbol} K线`,
    symbol,
    interval: period.id,
  });
  if (requestId !== state.quoteHistoryRequestId) {
    chart.destroy();
    return;
  }
  state.quoteChart = chart;
  chart.setData({ bars, interval: period.id, symbol });
}

function localTaskRows() {
  const rows = [];
  if (state.xLoading) rows.push({ id: 'local-x', title: '读取 X 缓存', status: 'running', detail: state.xNote || '进行中', scope: 'x', time: formatTime(Date.now()) });
  if (state.xTranslating) rows.push({ id: 'local-x-tr', title: '翻译非中文内容', status: 'running', detail: 'Gemini', scope: 'x', time: formatTime(Date.now()) });
  if (state.xTagging) rows.push({ id: 'local-x-tag', title: '标注待处理内容', status: 'running', detail: 'Worker 打 Tag', scope: 'x', time: formatTime(Date.now()) });
  if (state.bilibiliLoading) rows.push({ id: 'local-bili', title: '读取 B站字幕', status: 'running', detail: state.bilibiliNote || '进行中', scope: 'bilibili', time: formatTime(Date.now()) });
  for (const job of state.runtimeJobs || []) {
    rows.push({
      id: job.id || job.jobId,
      title: job.title || job.capability || job.type || '后台任务',
      status: job.status || 'queued',
      detail: job.detail || job.error || '',
      scope: job.scope || 'all',
      time: formatTime(job.updatedAt || job.createdAt),
      job,
    });
  }
  return rows;
}

function renderTasksPage() {
  const root = pageRoot();
  const filter = state.taskFilter || '全部';
  const jobs = localTaskRows().filter((item) => filter === '全部'
    || (filter === '进行中' && ['queued', 'running'].includes(item.status))
    || (filter === '失败' && item.status === 'failed'));
  const wrap = document.createElement('div');
  const tabs = document.createElement('div');
  tabs.className = 'dense-tabs';
  renderChipTabs(tabs, [{ id: '全部', label: '全部' }, { id: '进行中', label: '进行中' }, { id: '失败', label: '失败' }], filter, (id) => {
    state.taskFilter = id;
    renderTasksPage();
  });
  wrap.append(tabs);
  if (!jobs.length) wrap.append(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '暂无该筛选下的任务。采集与翻译走已注册的 Worker，不在页面里模拟成功。' }));
  jobs.forEach((job) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'task-item';
    button.innerHTML = `<div class="row between"><strong></strong><span class="task-status ${job.status}"></span></div><p></p><small class="muted"></small>`;
    button.querySelector('strong').textContent = job.title;
    button.querySelector('.task-status').textContent = job.status;
    button.querySelector('p').textContent = job.detail || '';
    button.querySelector('small').textContent = job.time;
    button.addEventListener('click', () => {
      if (job.job) openPage('task', job.id);
      else showToast('这是当前页的进行中操作，完成后会从列表消失');
    });
    wrap.append(button);
  });
  const auto = document.createElement('button');
  auto.type = 'button';
  auto.className = 'setting-row';
  auto.innerHTML = '<span><strong>自动任务配置</strong><small>频率、翻译和标签规则；保存后仍是本机草案</small></span>';
  auto.addEventListener('click', () => openPage('automation', 'x'));
  wrap.append(auto);
  root.replaceChildren(wrap);
  loadRuntimeJobs().catch(() => {});
}

async function loadRuntimeJobs() {
  try {
    const payload = await api('/api/v1/runtime/jobs?limit=50');
    state.runtimeJobs = payload.jobs || [];
    state.runtimeJobsError = '';
    if (state.pageKind === 'tasks') renderTasksPage();
  } catch (error) {
    state.runtimeJobsError = error instanceof Error ? error.message : '无法读取本机任务';
  }
}

function inspirationDetailTitle(note) {
  const explicit = String(note.title || '').replace(/\s+/g, ' ').trim();
  if (explicit) return explicit;
  return INSPIRATION_TYPE_LABELS[note.inspirationType] || '随记';
}

function inspirationDetailMeta(note) {
  const source = String(note.sourceTitle || '').replace(/\s+/g, ' ').trim();
  const when = formatTime(note.createdAt);
  return source ? `来自 ${source} · ${when}` : when;
}

function renderNotePage() {
  const root = pageRoot();
  const note = state.notes.find((item) => item.id === state.pageId);
  if (!note) {
    root.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '找不到这条灵感。' }));
    return;
  }
  const wrap = document.createElement('article');
  wrap.className = 'detail-shell';
  wrap.innerHTML = `<header class="detail-head"><h2 class="detail-title"></h2><div class="detail-meta"></div></header>
    <div class="detail-body reader-content"></div>
    <div class="detail-actions is-inline"></div>`;
  wrap.querySelector('.detail-title').textContent = inspirationDetailTitle(note);
  wrap.querySelector('.detail-meta').textContent = inspirationDetailMeta(note);
  fillPostBody(wrap.querySelector('.detail-body'), note.body);
  const pictures = renderAttachmentView(note.attachments);
  if (pictures) wrap.querySelector('.detail-body').after(pictures);
  wrap.querySelector('.detail-actions').append(createDetailAction({
    iconName: 'message-circle',
    label: '接着研究',
    primary: true,
    onClick: () => continueWithInspiration(note),
  }));
  root.replaceChildren(wrap);
}

function renderAccountPage() {
  const root = pageRoot();
  const line = (state.holdingsBoard?.summary?.lines || []).find((item) => item.id === state.pageId);
  if (!line) {
    root.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '找不到这个账户。' }));
    return;
  }
  const wrap = document.createElement('div');
  wrap.append(accountCardNode(line));
  const rows = (state.holdingsBoard?.positions || []).filter((item) => holdingsLineBoards(line.id).includes(item.board));
  rows.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quote-row holdings-row';
    button.textContent = `${item.name} · ${privacyText(item.lastPrice)}`;
    button.addEventListener('click', () => openPage('holding', item.lotId));
    wrap.append(button);
  });
  root.replaceChildren(wrap);
}

function accountCardNode(line) {
  const row = document.createElement('article');
  row.className = 'holdings-line account-panel';
  row.innerHTML = `<div class="holdings-line-head"><h3></h3><strong class="total-value num"></strong></div>`;
  row.querySelector('h3').textContent = line.label;
  row.querySelector('strong').textContent = privacyText(line.totalCny == null ? '--' : `¥${formatMoneyAmount(line.totalCny, 2)}`);
  return row;
}

function privacyText(value) {
  return state.privacy ? '••••••' : value;
}

function renderHoldingPage() {
  const root = pageRoot();
  const item = (state.holdingsBoard?.positions || []).find((row) => row.lotId === state.pageId);
  if (!item) {
    root.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '找不到这只持仓。' }));
    return;
  }
  const wrap = document.createElement('article');
  wrap.innerHTML = `<header class="reader-head"><h2></h2><p class="page-note"></p></header><dl class="metadata-grid"></dl>`;
  wrap.querySelector('h2').textContent = item.name;
  wrap.querySelector('p').textContent = `${boardLabels[item.board] || item.board} · 批次账本`;
  const grid = wrap.querySelector('.metadata-grid');
  for (const [dt, dd] of [
    ['持仓数量', privacyText(formatMoneyAmount(item.quantity, 0))],
    ['现价 / 成本', `${item.lastPrice == null ? '无行情' : formatPrice(item.lastPrice)} / ${formatPrice(item.costPrice)}`],
    ['市值 CNY', privacyText(formatMoneyAmount(item.marketValueCny, 2))],
    ['当日盈亏', privacyText(formatSignedAmount(item.dayPnlCny))],
    ['持仓浮动盈亏', privacyText(formatSignedAmount(item.positionPnlCny))],
  ]) {
    grid.append(Object.assign(document.createElement('dt'), { textContent: dt }), Object.assign(document.createElement('dd'), { textContent: dd }));
  }
  root.replaceChildren(wrap);
}

function renderAutomationPage() {
  const root = pageRoot();
  const id = state.pageId || 'x';
  const draft = JSON.parse(window.localStorage.getItem(AUTO_DRAFT_KEY) || '{}');
  const wrap = document.createElement('div');
  wrap.innerHTML = `<header class="reader-head"><h2></h2><p class="page-note">保存后仍是本机草案，不会启动真实定时任务。</p></header>
    ${id === 'x' ? `<button class="primary-button" type="button" id="run-x-capture">${xCaptureActionLabel()}</button><p class="page-note">${xCaptureScopeNote()} 这不是定时任务。</p>` : ''}
    <label class="check-line"><span>启用自动任务</span><input id="auto-enabled" type="checkbox"></label>
    <label class="field"><span>采集频率</span><select id="auto-interval">
      <option value="30">每 30 分钟</option>
      <option value="60">每 60 分钟</option>
      <option value="360">每 6 小时</option>
      <option value="manual">仅手动</option>
    </select></label>
    <label class="check-line"><span>新内容入库后翻译非中文部分</span><input id="auto-translate" type="checkbox"></label>
    <label class="check-line"><span>新内容入库后按已有标签标注</span><input id="auto-tag" type="checkbox"></label>
    <button class="primary-button" type="button" id="save-auto-rule">保存草案</button>
    <p class="endnote">未接入持久化调度前，不得显示「自动运行中」。</p>`;
  wrap.querySelector('h2').textContent = id === 'x' ? 'X' : id;
  wrap.querySelector('#run-x-capture')?.addEventListener('click', () => {
    runXCapturePipeline().catch((error) => showToast(error.message));
  });
  wrap.querySelector('#auto-enabled').checked = Boolean(draft.enabled);
  wrap.querySelector('#auto-interval').value = draft.interval || draft.freq || '60';
  wrap.querySelector('#auto-translate').checked = Boolean(draft.translate);
  wrap.querySelector('#auto-tag').checked = Boolean(draft.tag);
  wrap.querySelector('#save-auto-rule').addEventListener('click', () => {
    const next = {
      enabled: wrap.querySelector('#auto-enabled').checked,
      interval: wrap.querySelector('#auto-interval').value,
      translate: wrap.querySelector('#auto-translate').checked,
      tag: wrap.querySelector('#auto-tag').checked,
      saved: true,
      savedAt: Date.now(),
    };
    window.localStorage.setItem(AUTO_DRAFT_KEY, JSON.stringify(next));
    showToast('草案已保存，自动化未启用');
  });
  root.replaceChildren(wrap);
}

function renderPublishPage() {
  openCompose();
  goBack();
}

function renderSettingsHub() {
  const hub = elements['settings-hub'];
  const connections = elements['settings-connections'];
  if (!hub || !connections) return;
  const showHub = state.settingsPane !== 'connections';
  hub.classList.toggle('hidden', !showHub);
  connections.classList.toggle('hidden', showHub);
  if (!showHub) return;
  hub.replaceChildren();
  const rows = [
    ['sources', '信源', '查看来源内容与可用状态', () => setOverviewPane('catalog')],
    ['tasks', '采集与处理', '手工拉取、翻译、标注及任务记录', () => openPage('tasks')],
    ['automation', '自动任务', '规则只是草案；X 的抓取关注/推荐在来源任务里', () => openPage('automation', 'x')],
    ['connections', '设备连接', '配对与授权入口', () => setView('settings/connections')],
  ];
  for (const [id, title, desc, onClick] of rows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'setting-row';
    button.innerHTML = `<span><strong></strong><small></small></span>`;
    button.querySelector('strong').textContent = title;
    button.querySelector('small').textContent = desc;
    button.addEventListener('click', onClick);
    hub.append(button);
  }
}

function openSourceMenu(source) {
  const actions = [];
  if (source.id === 'x') {
    actions.push([xCaptureActionLabel(), xCaptureScopeNote(), () => {
      runXCapturePipeline().catch((error) => showToast(error.message));
    }]);
  }
  actions.push(
    ['查看内容', '只读已保存结果', () => openPage('source', source.id)],
    ['任务记录', '进行中、成功与失败', () => openPage('tasks')],
    ['自动任务', '规则只是本机草案，不会定时跑', () => openPage('automation', source.id)],
    [state.hiddenSourceIds.has(source.id) ? '显示信源' : '隐藏信源', '只影响本机目录投影', () => {
      if (state.hiddenSourceIds.has(source.id)) state.hiddenSourceIds.delete(source.id);
      else state.hiddenSourceIds.add(source.id);
      writeJsonSet(HIDDEN_SOURCES_KEY, state.hiddenSourceIds);
      renderStaticSourceCatalog();
    }],
  );
  modalSheet(`${sourceDisplayTitle(source)} · 采集与处理`, actions);
}

function modalSheet(title, actions) {
  const dialog = elements['source-tasks-dialog'] || elements['feed-filter-dialog'];
  if (!dialog) {
    showToast(title);
    return;
  }
  if (elements['source-tasks-title']) elements['source-tasks-title'].textContent = title;
  const body = elements['source-tasks-body'];
  if (!body) return;
  body.replaceChildren(...actions.map(([label, desc, onClick]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'setting-row';
    button.innerHTML = `<span><strong></strong><small></small></span>`;
    button.querySelector('strong').textContent = label;
    button.querySelector('small').textContent = desc;
    button.addEventListener('click', () => {
      dialog.close();
      onClick();
    });
    return button;
  }));
  openDialog(dialog);
}

function renderFeedFilterDialog() {
  const body = elements['feed-filter-body'];
  if (!body) return;
  body.replaceChildren();
  const add = (label, options, current, onSelect) => {
    body.append(Object.assign(document.createElement('p'), { className: 'filter-label', textContent: label }));
    const row = document.createElement('div');
    row.className = 'dense-tabs';
    renderChipTabs(row, options, current, onSelect);
    body.append(row);
  };
  add('排序方式', [
    { id: 'captured', label: '收录顺序' },
    { id: 'published', label: '发布时间' },
  ], state.feedSort, (id) => {
    state.feedSort = id;
    renderPosts();
    renderFeedFilterDialog();
  });
  add('日期范围', [
    { id: 'today', label: '今天' },
    { id: '7d', label: '近 7 天' },
    { id: 'all', label: '全部' },
  ], state.feedRange, (id) => {
    state.feedRange = id;
    renderPosts();
    renderFeedFilterDialog();
  });
  add('平台', platformFilters, state.feedPlatform, (id) => {
    applyFeedPlatform(id);
    renderFeedFilterDialog();
  });
  const calendar = document.createElement('button');
  calendar.type = 'button';
  calendar.className = 'setting-row';
  calendar.innerHTML = '<span><strong>查看未来日程</strong><small>不混进最新发布</small></span>';
  calendar.addEventListener('click', () => {
    elements['feed-filter-dialog'].close();
    setOverviewPane('schedule');
    setView('sources/schedule');
  });
  const catalog = document.createElement('button');
  catalog.type = 'button';
  catalog.className = 'setting-row';
  catalog.innerHTML = '<span><strong>打开信源目录</strong><small>社媒、日程、官方与行情</small></span>';
  catalog.addEventListener('click', () => {
    elements['feed-filter-dialog'].close();
    setOverviewPane('catalog');
    setView('sources/catalog');
  });
  body.append(calendar, catalog);
}

const DIVIDEND_REGIME_LABELS = {
  NORMAL: '常态',
  VALUE_HIGH: '价值偏高',
  VALUE_LOW: '价值偏低',
  VALUE_HIGH_PAIN_HIGH: '价值偏高，回撤偏高',
  VALUE_NORMAL_PAIN_HIGH: '回撤偏高',
  VALUE_LOW_PAIN_HIGH: '价值偏低，回撤偏高',
  UNKNOWN: '状态不明',
};

const DIVIDEND_STATUS_LABELS = {
  ready: '数据齐全',
  partial: '部分可用',
  unavailable: '暂不可用',
};

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) return '—';
  const percent = value * 100;
  const digits = Math.abs(percent) >= 10 ? 1 : 2;
  const text = `${percent.toFixed(digits)}%`;
  return percent > 0 ? `+${text}` : text;
}

function formatPercentile(value) {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

function formatMultiple(value) {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(2);
}

function formatShanghaiDate(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(timestamp);
}

function dividendWarningLabel(warning) {
  if (warning === 'indexWeightHistoryShort') return '成分权重历史太短';
  if (warning === 'priceSeriesAdjusted=false') return '价格未复权';
  return warning;
}

function renderDividendInspection(snapshot, error) {
  const host = elements['strategy-inspect'];
  if (!host) return;
  host.replaceChildren();
  const head = document.createElement('div');
  head.className = 'strategy-inspect-head';
  const title = document.createElement('h2');
  title.textContent = '中证红利';
  const meta = document.createElement('span');
  head.append(title, meta);
  if (error) {
    const note = document.createElement('p');
    note.className = 'strategy-inspect-note';
    note.textContent = error;
    host.append(head, note);
    return;
  }
  if (!snapshot) {
    meta.textContent = '尚无快照';
    const note = document.createElement('p');
    note.className = 'strategy-inspect-note';
    note.textContent = '收盘后写入价值与回撤状态。这里只检视状态，不含目标仓位和买卖。';
    host.append(head, note);
    return;
  }
  const factors = snapshot.factors || {};
  const value = factors.value || {};
  const pain = factors.pain || {};
  const quality = factors.dataQuality || {};
  meta.textContent = formatShanghaiDate(snapshot.asOf);
  const regime = document.createElement('p');
  regime.className = 'strategy-inspect-regime';
  regime.textContent = DIVIDEND_REGIME_LABELS[factors.regime] || '状态不明';
  const status = document.createElement('p');
  status.className = 'strategy-inspect-status';
  const coverage = Number.isFinite(quality.coverage) ? `覆盖 ${formatPercentile(quality.coverage)}` : '';
  const count = Number.isInteger(quality.constituentCount) ? `${quality.constituentCount} 只成分` : '';
  status.textContent = [DIVIDEND_STATUS_LABELS[snapshot.status] || snapshot.status, count, coverage].filter(Boolean).join(' · ');
  const metrics = document.createElement('dl');
  metrics.className = 'strategy-inspect-metrics';
  const rows = [
    ['股息率', formatSignedPercent(value.dividendYield), `5年分位 ${formatPercentile(value.dividendYieldPercentile5y)}`],
    ['市盈率', formatMultiple(value.peTtm), `5年分位 ${formatPercentile(value.pePercentile5y)}`],
    ['20日收益', formatSignedPercent(pain.return20d), '近20个交易日'],
    ['252日回撤', formatSignedPercent(pain.drawdown252d), '近252个交易日'],
  ];
  for (const [label, main, hint] of rows) {
    const item = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    const strong = document.createElement('strong');
    strong.textContent = main;
    const small = document.createElement('small');
    small.textContent = hint;
    detail.append(strong, small);
    item.append(term, detail);
    metrics.append(item);
  }
  const note = document.createElement('p');
  note.className = 'strategy-inspect-note';
  const warnings = (snapshot.warnings || []).map(dividendWarningLabel).filter(Boolean);
  note.textContent = warnings.length
    ? warnings.join('；')
    : '只读当日价值与回撤状态，不含目标仓位和买卖。';
  host.append(head, regime, status, metrics, note);
}

async function loadDividendInspection() {
  try {
    const payload = await api('/api/v1/strategies/cn-dividend');
    renderDividendInspection(payload.snapshot || null);
  } catch (error) {
    const message = error instanceof Error ? error.message : '策略快照读取失败';
    renderDividendInspection(null, message);
    throw error;
  }
}

function renderTools() {
  const items = tools.map((tool) => ({
    ...tool,
    ready: tool.ready,
  }));
  elements['tool-grid'].replaceChildren(...items.map((tool) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool-item';
    button.disabled = !tool.ready;
    const mark = tool.icon ? icon(tool.icon) : tool.title.slice(0, 1);
    button.innerHTML = `<span class="tool-icon">${mark}</span><strong>${tool.title}</strong><small>${tool.desc}</small>`;
    button.addEventListener('click', () => {
      if (!tool.ready) return;
      if (tool.action === 'compose') return openPage('publish');
      if (tool.action === 'settings') return setView('settings');
      if (viewCopy[tool.action]) return setView(tool.action);
      showToast('这项能力将在闭环稳定后接入');
    });
    return button;
  }));
}

function askKindLabel(kind) {
  if (kind === 'inspiration') return '灵感加工';
  if (kind === 'article-analysis') return '文章分析';
  return '问答';
}

function liveAskJobs() {
  return state.askJobs.filter((job) => job.status === 'queued' || job.status === 'running');
}

function sessionAskJobs(sessionId) {
  if (!sessionId) return liveAskJobs();
  return liveAskJobs().filter((job) => job.sessionId === sessionId || (sessionId === 'new' && job.sessionId === 'new'));
}

function upsertAskJob(next) {
  const index = state.askJobs.findIndex((job) => job.runId === next.runId);
  const current = index >= 0 ? state.askJobs[index] : {
    runId: next.runId,
    sessionId: next.sessionId || '',
    question: next.question || '',
    status: 'queued',
    progress: [],
    text: '正在等待 AI Worker…',
    error: false,
    refs: [],
  };
  const merged = { ...current, ...next };
  if (index >= 0) state.askJobs[index] = merged;
  else state.askJobs.push(merged);
  return merged;
}

function removeAskJob(runId) {
  state.askJobs = state.askJobs.filter((job) => job.runId !== runId);
}

function askStatusLabel(status) {
  if (status === 'running') return '正在回答';
  if (status === 'queued') return '排队等待';
  if (status === 'failed') return '未能完成';
  return '';
}

function renderAskLiveUi() {
  const live = liveAskJobs();
  const count = live.length;
  document.querySelectorAll('.nav-item[data-nav="ask"], .tab-item[data-nav="ask"]').forEach((node) => {
    node.classList.toggle('has-live', count > 0);
  });
  const chip = elements['ask-live-chip'];
  if (!chip) return;
  const onAsk = document.body.dataset.view === 'ask';
  chip.classList.toggle('hidden', !count || onAsk);
  if (!count) return;
  const running = live.some((job) => job.status === 'running');
  const head = live.find((job) => job.status === 'running') || live[0];
  chip.textContent = count > 1
    ? `${running ? '问答进行中' : '问答排队中'} · ${count} 条`
    : `${askStatusLabel(head.status)}：${String(head.question || '未命名').slice(0, 18)}`;
}

function adoptPendingRuns(runs = [], { replaceLive = false } = {}) {
  for (const run of runs) {
    if (!run?.runId) continue;
    upsertAskJob({
      runId: run.runId,
      sessionId: run.sessionId || '',
      question: run.question || run.input?.message || '',
      status: run.status,
      ...(run.agentMode ? { agentMode: run.agentMode } : {}),
    });
  }
  if (replaceLive) {
    const liveIds = new Set(runs.map((run) => run.runId));
    state.askJobs = state.askJobs.filter((job) => {
      if (job.status !== 'queued' && job.status !== 'running') return true;
      if (String(job.runId).startsWith('local-')) return true;
      return liveIds.has(job.runId);
    });
  }
  if (liveAskJobs().length) ensureAskPoller();
  renderAskLiveUi();
}

let askPollTimer = 0;
let askPollInFlight = false;
function ensureAskPoller() {
  if (askPollTimer) return;
  askPollTimer = window.setInterval(() => {
    void pollAskJobs();
  }, 800);
}

function stopAskPollerIfIdle() {
  if (liveAskJobs().length) return;
  if (askPollTimer) {
    window.clearInterval(askPollTimer);
    askPollTimer = 0;
  }
}

function updateAskProgressNode(job) {
  const answer = elements['ask-thread']?.querySelector(`[data-run-id="${job.runId}"] .ask-answer`);
  if (!answer) return;
  if (job.error) {
    setAskAnswer(answer, job.text, { error: true });
    return;
  }
  if (job.status === 'queued' || job.status === 'running') {
    setAskAnswer(answer, job.text, {
      pending: true,
      progress: job.progress || [],
      progressKey: job.runId,
    });
  }
}

async function finishAskJob(job, payload) {
  removeAskJob(job.runId);
  state.askProgressExpanded.delete(job.runId);
  renderAskLiveUi();
  const viewing = document.body.dataset.view === 'ask' && state.askSessionId && state.askSessionId === job.sessionId;
  if (viewing) await loadAskSession(job.sessionId);
  else if (document.body.dataset.view === 'ask' && !state.askSessionId) await loadAskSessions();
  else loadAskSessions().catch(() => {});
  if (payload?.status === 'failed' || payload?.status === 'cancelled') {
    showToast(payload.error?.message || payload.job?.error?.message || '问答任务未能完成');
  }
  stopAskPollerIfIdle();
}

async function pollAskJobs() {
  if (askPollInFlight) return;
  const jobs = liveAskJobs();
  if (!jobs.length) {
    stopAskPollerIfIdle();
    renderAskLiveUi();
    return;
  }
  askPollInFlight = true;
  try {
    await Promise.all(jobs.map(async (job) => {
      try {
        const path = job.agentMode === 'article-analysis'
          ? `/api/v1/article-analysis/runs/${job.runId}`
          : `/api/v1/agent/runs/${job.runId}`;
        const payload = await api(path, { timeoutMs: 15_000 });
        if (payload.status === 'completed') {
          await finishAskJob(job, payload);
          return;
        }
        if (payload.status === 'failed' || payload.status === 'cancelled') {
          const failed = upsertAskJob({
            runId: job.runId,
            sessionId: payload.sessionId || job.sessionId,
            status: payload.status,
            error: true,
            text: payload.error?.message || payload.job?.error?.message || '问答任务未能完成',
          });
          updateAskProgressNode(failed);
          renderAskLiveUi();
          showToast(failed.text);
          return;
        }
        const updated = upsertAskJob({
          runId: job.runId,
          sessionId: payload.sessionId || job.sessionId,
          status: payload.status,
          progress: payload.progress || [],
          text: payload.status === 'running'
            ? (job.agentMode === 'article-analysis'
              ? (formatArticleProgressText(payload.progress) || '正在分析材料…')
              : '正在生成回答…')
            : '正在等待 AI Worker…',
        });
        updateAskProgressNode(updated);
      } catch {
        /* 单次轮询失败不打断后台任务 */
      }
    }));
    renderAskLiveUi();
    if (document.body.dataset.view === 'ask' && !state.askSessionId) renderAskRecords();
    stopAskPollerIfIdle();
  } finally {
    askPollInFlight = false;
  }
}

async function loadActiveAskRuns() {
  if (!state.session) return;
  try {
    const payload = await api('/api/v1/agent/runs');
    adoptPendingRuns(payload.runs || [], { replaceLive: true });
  } catch {
    /* 尚未连接时忽略 */
  }
}

function onAgentJobEvent(event) {
  let payload = {};
  try { payload = JSON.parse(event.data || '{}'); } catch { payload = {}; }
  const runId = payload.jobId || payload.runId || payload.job?.id;
  if (runId && liveAskJobs().some((job) => job.runId === runId)) {
    void pollAskJobs();
    return;
  }
  void loadActiveAskRuns();
}

function askSessionTitle() {
  if (!state.askSessionId) return viewCopy.ask.title;
  if (state.askSessionId === 'new') return '新提问';
  return String(
    state.askDetail?.session?.title
    || state.askSessions.find((item) => item.id === state.askSessionId)?.title
    || '',
  ).trim() || '问答';
}

function applyAskHeaderCopy() {
  const inSession = Boolean(state.askSessionId);
  elements['page-title'].textContent = askSessionTitle();
  elements['page-subtitle'].textContent = inSession ? '' : viewCopy.ask.subtitle;
}

function syncAskLayer() {
  const inSession = Boolean(state.askSessionId);
  elements['ask-records'].classList.toggle('hidden', inSession);
  elements['ask-session-shell'].classList.toggle('hidden', !inSession);
  const kind = state.askSessionId === 'new' ? 'question-answer' : (state.askDetail?.session?.kind || 'question-answer');
  document.body.dataset.askKind = inSession ? kind : '';
  applyAskHeaderCopy();
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
    focusAskComposer();
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
  adoptPendingRuns(payload.pendingRuns || [], { replaceLive: true });
  renderAskRecords();
}

async function loadAskSession(sessionId) {
  if (!state.session) return;
  const payload = await api(`/api/v1/agent/sessions/${sessionId}`);
  state.askDetail = { session: payload.session, exchanges: payload.exchanges || [] };
  const pending = (payload.exchanges || [])
    .filter((item) => item.status === 'queued' || item.status === 'running')
    .map((item) => ({
      runId: item.id,
      jobId: item.jobId || item.id,
      sessionId,
      question: item.question,
      status: item.status,
      ...(item.agentMode ? { agentMode: item.agentMode } : {}),
    }));
  const pendingIds = new Set(pending.map((item) => item.runId));
  state.askJobs = state.askJobs.filter((job) => (
    job.sessionId !== sessionId
    || (job.status !== 'queued' && job.status !== 'running')
    || pendingIds.has(job.runId)
  ));
  adoptPendingRuns(pending);
  applySessionAgentMode(payload.session?.kind);
  renderAskSession();
  syncAskLayer();
}

function resizeAskComposer() {
  const input = elements['ask-form']?.elements?.question;
  if (!input) return;
  if (state.askComposerCompact) {
    input.style.height = '28px';
    return;
  }
  input.style.height = 'auto';
  input.style.height = `${Math.min(120, Math.max(22, input.scrollHeight))}px`;
}

function setAskComposerCompact(compact) {
  const form = elements['ask-form'];
  const input = form?.elements?.question;
  const next = Boolean(compact)
    && document.body.dataset.view === 'ask'
    && document.body.dataset.askLayer === 'session'
    && document.activeElement !== input;
  if (state.askComposerCompact === next) return;
  state.askComposerCompact = next;
  form?.classList.toggle('is-compact', next);
  document.body.classList.toggle('is-ask-composer-compact', next);
  resizeAskComposer();
}

function onAskThreadScroll() {
  const thread = elements['ask-thread'];
  if (!thread) return;
  const top = thread.scrollTop;
  const scrollingDown = top > state.askThreadLastScrollTop + 4;
  state.askThreadLastScrollTop = top;
  if (scrollingDown && top > 24) setAskComposerCompact(true);
}

function syncAskKeyboard() {
  const input = elements['ask-form']?.elements?.question;
  const typing = Boolean(input) && document.activeElement === input
    && document.body.dataset.view === 'ask'
    && document.body.dataset.askLayer === 'session';
  const viewport = window.visualViewport;
  const covered = viewport
    ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
    : 0;
  const keyboard = typing && covered > 48;
  document.body.classList.toggle('is-ask-keyboard', keyboard);
  document.documentElement.style.setProperty('--ask-kb', `${keyboard ? covered : 0}px`);
}

function focusAskComposer() {
  const input = elements['ask-form']?.elements?.question;
  if (!input) return;
  setAskComposerCompact(false);
  const run = () => {
    if (elements['ask-session-shell']?.classList.contains('hidden')) return;
    try { input.focus({ preventScroll: true }); } catch { input.focus(); }
    resizeAskComposer();
    input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    syncAskKeyboard();
  };
  run();
  window.setTimeout(run, 50);
  window.setTimeout(run, 240);
}

function openAskSession(sessionId) {
  setAskComposerCompact(false);
  state.askThreadLastScrollTop = 0;
  setView(`ask/${sessionId}`);
  if (sessionId === 'new') focusAskComposer();
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
    const live = sessionAskJobs(session.id);
    const liveHead = live.find((job) => job.status === 'running') || live[0];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ask-session-item${live.length ? ' is-live' : ''}`;
    button.append(
      Object.assign(document.createElement('strong'), { textContent: session.title || '未命名记录' }),
      Object.assign(document.createElement('p'), {
        className: 'session-preview',
        textContent: liveHead
          ? `${askStatusLabel(liveHead.status)}：${liveHead.question}`
          : String(session.preview || '').trim()
            ? `回答预览：${session.preview}`
            : '还没有保存的回答预览。',
      }),
    );
    const foot = document.createElement('div');
    foot.className = 'session-bottom';
    foot.append(
      Object.assign(document.createElement('span'), {
        textContent: live.length
          ? `${askStatusLabel(liveHead.status)} · ${live.length} 条进行中 · ${formatAskClock(stamp)}`
          : `${session.runCount || 0} 轮讨论 · ${askKindLabel(session.kind)} · ${formatAskClock(stamp)}`,
      }),
      Object.assign(document.createElement('span'), {
        className: 'resume',
        textContent: live.length ? '查看进度 →' : '继续研究 →',
      }),
    );
    button.append(foot);
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
      resizeAskComposer();
      focusAskComposer();
    });
    return button;
  }));
}

function renderAsk() {
  renderAskPrompts();
  renderAskRecords();
}

function renderAskMaterials() {
  const root = elements['ask-materials'];
  const tabs = elements['ask-material-tabs'];
  if (!root || !tabs) return;
  const show = state.askSessionId === 'new' && !(state.askDetail?.exchanges || []).length && !sessionAskJobs(state.askSessionId).length;
  root.classList.toggle('hidden', !show);
  tabs.classList.toggle('hidden', !show);
  if (!show) return;
  renderChipTabs(tabs, [
    { id: 'feed', label: '信息流' },
    { id: 'inspire', label: '灵感' },
    { id: 'knowledge', label: '知识库' },
    { id: 'holdings', label: '持仓' },
  ], state.askMaterialTab, (id) => {
    state.askMaterialTab = id;
    renderAskMaterials();
  });
  const feed = visibleFeedItems().slice(0, 12).map((item) => ({
    id: item.resourceId || item.id,
    type: item.resourceType || (item.live ? 'content-item' : 'post'),
    title: postDisplayTitle(item),
    meta: `${platformLabels[item.platform] || item.platform} · ${item.time || ''}`.trim(),
    preview: item.body,
    post: item,
  }));
  const notes = regularNotes().slice(0, 12).map((note) => ({
    id: note.id,
    type: 'inspiration',
    title: inspirationCardTitle(note),
    meta: note.sourceTitle || '我的随记',
    preview: note.body,
  }));
  const frames = state.mentionItems.filter((item) => item.resourceType === 'knowledge-revision').slice(0, 12);
  const knowledge = (frames.length ? frames : state.knowledge).slice(0, 12).map((item) => ({
    id: item.resourceId || item.id,
    type: item.resourceType || 'knowledge-revision',
    title: item.label || item.title,
    meta: item.parentName || '知识库',
    preview: item.preview || item.body,
    revision: item.revision,
  }));
  const holdings = (state.holdingsBoard?.positions || []).slice(0, 12).map((item) => ({
    id: item.lotId,
    type: 'holdings-board',
    title: `询问 ${item.name} 的持仓与当日盈亏`,
    meta: `${boardLabels[item.board] || item.board} · 持仓工具`,
    preview: '作为问题意图交给现有持仓工具，发送前不声称已读取。',
  }));
  const rows = state.askMaterialTab === 'inspire' ? notes
    : state.askMaterialTab === 'knowledge' ? knowledge
      : state.askMaterialTab === 'holdings' ? holdings
        : feed;
  const status = document.createElement('div');
  status.className = 'mini-status';
  status.innerHTML = `<span>近期材料 · 点正文预览</span><span class="material-count">已选 ${state.referenceDraft.length} / 8</span>`;
  if (!rows.length) {
    root.replaceChildren(status, Object.assign(document.createElement('p'), {
      className: 'empty-state',
      textContent: '这一组暂时没有可选材料，也可以直接提问。',
    }));
    return;
  }
  root.replaceChildren(status, ...rows.map((item) => {
    const selected = isReferenced({ resourceType: item.type, resourceId: item.id });
    const row = document.createElement('div');
    row.className = 'material-row';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'material-copy';
    copy.append(
      Object.assign(document.createElement('h3'), { textContent: item.title }),
      Object.assign(document.createElement('div'), { className: 'material-meta', textContent: item.meta }),
    );
    copy.addEventListener('click', () => {
      if (item.post) openPost(item.post);
      else openReferencePreview({
        resourceType: item.type,
        resourceId: item.id,
        label: item.title,
        preview: item.preview,
      }, 0);
    });
    const select = document.createElement('button');
    select.type = 'button';
    select.className = `select-material${selected ? ' is-on' : ''}`;
    select.setAttribute('aria-label', selected ? '取消引用' : '加入引用');
    select.textContent = selected ? '✓' : '+';
    select.addEventListener('click', () => {
      toggleReference({
        resourceType: item.type,
        resourceId: item.id,
        revision: item.revision,
        label: item.title,
        preview: item.preview,
      });
      renderAskMaterials();
    });
    row.append(copy, select);
    return row;
  }));
}

function clearAskThreadExtras() {
  elements['ask-thread'].querySelectorAll('.ask-conversation, .ask-exchange').forEach((node) => node.remove());
}

function setAskAnswer(answer, answerText, {
  pending = false, error = false, progress = [], progressKey = '',
} = {}) {
  answer.classList.toggle('is-pending', pending);
  answer.classList.toggle('is-error', error);
  if (pending) {
    renderRunProgress(answer, progress, answerText, progressKey);
    return;
  }
  if (error) {
    answer.textContent = answerText;
    return;
  }
  renderMarkdownInto(answer, answerText);
}

function renderRunProgress(target, steps, fallback, progressKey = '') {
  target.replaceChildren();
  if (!steps.length) {
    target.textContent = fallback;
    return;
  }
  const resolvedCurrentIndex = steps.length - 1;
  const current = steps[resolvedCurrentIndex];
  const previous = steps.filter((_step, index) => index !== resolvedCurrentIndex);
  if (previous.length) {
    const history = document.createElement('details');
    history.className = 'ask-progress-history';
    history.open = state.askProgressExpanded.has(progressKey);
    history.addEventListener('toggle', () => {
      if (!progressKey) return;
      if (history.open) state.askProgressExpanded.add(progressKey);
      else state.askProgressExpanded.delete(progressKey);
    });
    history.append(Object.assign(document.createElement('summary'), {
      textContent: `之前 ${previous.length} 步`,
    }));
    history.append(createRunProgressList(previous));
    target.append(history);
  }
  const currentWrap = document.createElement('div');
  currentWrap.className = 'ask-progress-now';
  currentWrap.append(Object.assign(document.createElement('small'), {
    textContent: '当前进度',
  }));
  const currentList = createRunProgressList([current]);
  currentList.classList.add('ask-progress-current');
  currentWrap.append(currentList);
  target.append(currentWrap);
}

function createRunProgressList(steps) {
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
  return list;
}

function appendAskExchange(question, answerText, {
  pending = false, error = false, refs = [], runId = '', jobId = '', answer = '',
  sourceFooter = null, progress = [], scroll = false, container = null,
} = {}) {
  const card = document.createElement('article');
  card.className = 'ask-exchange';
  if (runId) card.dataset.runId = runId;
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
  answerBlock.className = 'ask-turn ask-turn-a detail-surface';
  answerBlock.append(Object.assign(document.createElement('span'), { className: 'ask-turn-label', textContent: '回答' }));
  const answerNode = document.createElement('div');
  answerNode.className = 'ask-answer';
  setAskAnswer(answerNode, answerText, {
    pending,
    error,
    progress,
    progressKey: jobId || runId,
  });
  answerBlock.append(answerNode);
  card.append(answerBlock);
  if (!pending && progress.length) {
    const trace = document.createElement('details');
    trace.className = 'ask-run-trace';
    trace.append(Object.assign(document.createElement('summary'), {
      textContent: `运行记录 · ${progress.length} 步`,
    }));
    trace.append(createRunProgressList(progress));
    card.append(trace);
  }
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
    const shareImage = document.createElement('button');
    shareImage.type = 'button';
    shareImage.className = 'text-button';
    shareImage.textContent = '分享';
    shareImage.addEventListener('click', () => shareAskExchange(card, shareImage));
    actions.append(cite, saveNote, saveKnowledge, shareImage);
    if (jobId) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'text-button';
      retry.textContent = '重新做';
      retry.addEventListener('click', () => {
        void retryAgentJob(jobId, question, retry);
      });
      actions.append(retry);
    }
    card.append(actions);
  }
  if (container) container.append(card);
  else elements['ask-prompts'].before(card);
  if (scroll) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return answerNode;
}

async function retryAgentJob(jobId, question, button) {
  if (!jobId || button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const created = await api(`/api/v1/agent/runs/${jobId}/retry`, {
      method: 'POST',
      body: '{}',
    });
    const job = upsertAskJob({
      runId: created.runId,
      sessionId: created.sessionId || state.askSessionId,
      question: question || '重新执行',
      status: created.status || 'queued',
      text: '正在等待 AI Worker…',
      progress: [],
      ...(created.agentMode === 'article-analysis' ? { agentMode: 'article-analysis' } : {}),
    });
    renderAskSession();
    updateAskProgressNode(job);
    ensureAskPoller();
  } catch (error) {
    showToast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
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

function closeShareImagePreview() {
  const preview = state.shareImagePreview;
  state.shareImagePreview = null;
  if (preview?.url?.startsWith('blob:')) URL.revokeObjectURL(preview.url);
  const image = elements['share-image-preview'];
  if (image) image.removeAttribute('src');
}

async function openShareImagePreview({ blob, filename, title, previewUrl }) {
  closeShareImagePreview();
  const url = previewUrl || '';
  if (!url) throw new Error('图片预览失败');
  state.shareImagePreview = { blob, filename, title, url };
  const image = elements['share-image-preview'];
  if (image) {
    image.src = url;
    image.alt = title || '问答分享图';
  }
  const dialog = elements['share-image-dialog'];
  if (!dialog) throw new Error('找不到分享预览');
  openDialog(dialog);
}

async function saveShareImagePreview() {
  const preview = state.shareImagePreview;
  if (!preview?.blob) return;
  const { downloadBlob } = await import('./share-card.js?v=dev');
  downloadBlob(preview.filename, preview.blob);
}

async function shareAskExchange(card, button) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const { exportAskSharePng } = await import('./share-card.js?v=dev');
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const result = await exportAskSharePng(card, { deliver: false });
    await openShareImagePreview(result);
  } catch (error) {
    showToast(error.message || '分享失败');
  } finally {
    if (button) button.disabled = false;
  }
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
  const live = [
    ...sessionAskJobs(state.askSessionId),
    ...state.askJobs.filter((job) => job.sessionId === state.askSessionId && job.error),
  ];
  const showIntro = isNew && !exchanges.length && !live.length;
  elements['ask-intro'].classList.toggle('hidden', !showIntro);
  elements['ask-prompt-label'].classList.toggle('hidden', !showIntro);
  elements['ask-prompts'].classList.toggle('hidden', !showIntro);
  clearAskThreadExtras();
  const conversation = !showIntro ? document.createElement('section') : null;
  if (conversation) {
    conversation.className = 'ask-conversation';
    elements['ask-prompts'].before(conversation);
  }
  const seen = new Set();
  for (const exchange of exchanges) {
    const job = state.askJobs.find((item) => item.runId === exchange.id);
    const pending = exchange.status === 'queued' || exchange.status === 'running';
    const error = Boolean(job?.error) || exchange.status === 'failed' || exchange.status === 'cancelled';
    seen.add(exchange.id);
    appendAskExchange(exchange.question, error
      ? (job?.text || '问答任务未能完成')
      : (pending ? (job?.text || '正在等待 AI Worker…') : (exchange.answer || '（没有可显示的回答）')), {
      pending: pending && !error,
      error,
      progress: job?.progress || exchange.progress || [],
      refs: exchange.refs || [],
      sourceFooter: exchange.sourceFooter,
      runId: exchange.id,
      jobId: exchange.jobId || '',
      answer: exchange.answer || '',
      container: conversation,
    });
  }
  for (const job of live) {
    if (seen.has(job.runId)) continue;
    appendAskExchange(job.question, job.text, {
      pending: !job.error,
      error: Boolean(job.error),
      progress: job.progress || [],
      refs: job.refs || [],
      runId: job.runId,
      jobId: job.jobId || job.runId,
      container: conversation,
    });
  }
  if (showIntro) {
    renderAskPrompts();
    if (!state.notes.length) loadNotes().catch(() => {});
    if (!state.knowledge.length) loadKnowledge().catch(() => {});
    renderAskMaterials();
  } else {
    elements['ask-materials']?.classList.add('hidden');
    elements['ask-material-tabs']?.classList.add('hidden');
  }
  syncAskLayer();
}

function setAskComposerBusy(busy) {
  state.askSubmitting = busy;
  elements['ask-send'].disabled = busy;
  elements['ask-send'].setAttribute('aria-label', busy ? '正在提交' : '发送');
}

function currentWebMode() {
  const value = elements['ask-form']?.elements?.webMode?.value;
  return value === 'always' || value === 'fallback' || value === 'off' ? value : 'fallback';
}

function currentResearchMode() {
  return elements['ask-form']?.elements?.researchMode?.checked ? 'research' : 'standard';
}

function currentAgentMode() {
  return elements['ask-form']?.elements?.agentMode?.value === 'article-analysis' ? 'article-analysis' : 'ask';
}

function syncAgentModeComposer() {
  const mode = currentAgentMode();
  document.body.dataset.agentMode = mode;
  const input = elements['ask-form']?.elements?.question;
  if (input) {
    input.maxLength = mode === 'article-analysis' ? 20_000 : 4_000;
    input.placeholder = mode === 'article-analysis'
      ? '粘贴文章，或 @ 选择一条材料…'
      : '发消息，或 @ 选择资料…';
  }
}

function syncResearchModeSwitch(input) {
  if (!input) return;
  input.setAttribute('aria-checked', input.checked ? 'true' : 'false');
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

function restoreResearchMode() {
  const input = elements['ask-form']?.elements?.researchMode;
  if (!input) return;
  try {
    input.checked = window.localStorage.getItem('ai-center-research-mode') === 'research';
  } catch {}
  syncResearchModeSwitch(input);
  input.addEventListener('change', () => {
    syncResearchModeSwitch(input);
    try { window.localStorage.setItem('ai-center-research-mode', input.checked ? 'research' : 'standard'); } catch {}
  });
}

function applySessionAgentMode(kind) {
  const select = elements['ask-form']?.elements?.agentMode;
  if (!select) return;
  if (kind === 'article-analysis' && select.value !== 'article-analysis') {
    select.value = 'article-analysis';
    syncAgentModeComposer();
  }
}

function restoreAgentMode() {
  const select = elements['ask-form']?.elements?.agentMode;
  if (!select) return;
  try {
    if (window.localStorage.getItem('ai-center-agent-mode') === 'article-analysis') select.value = 'article-analysis';
  } catch {}
  syncAgentModeComposer();
  select.addEventListener('change', () => {
    syncAgentModeComposer();
    try { window.localStorage.setItem('ai-center-agent-mode', currentAgentMode()); } catch {}
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function askAgent(question) {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  if (state.askSubmitting) return;
  if (state.askDetail?.session?.kind === 'inspiration' || state.askDetail?.session?.kind === 'article-analysis') {
    showToast('这条记录请点 + 开新问答');
    return;
  }
  if (!state.askSessionId) openAskSession('new');
  const sessionId = state.askSessionId === 'new' ? undefined : state.askSessionId;
  const sentRefs = state.referenceDraft.slice();
  const references = draftPayload();
  const tempId = `local-${Date.now()}`;
  upsertAskJob({
    runId: tempId,
    sessionId: state.askSessionId,
    question,
    status: 'queued',
    text: '正在提交问题…',
    refs: sentRefs,
  });
  renderAskSession();
  setAskComposerBusy(true);
  try {
    const created = await api('/api/v1/agent/runs', {
      method: 'POST',
      body: JSON.stringify({
        message: question,
        webMode: currentWebMode(),
        researchMode: currentResearchMode(),
        sessionId,
        references,
      }),
    });
    clearReferences();
    removeAskJob(tempId);
    if (created.sessionId && state.askSessionId === 'new') {
      state.askSessionId = created.sessionId;
      const nextHash = askHash(created.sessionId);
      if (location.hash !== nextHash) history.replaceState({}, '', `${location.pathname}${location.search}${nextHash}`);
    }
    upsertAskJob({
      runId: created.runId,
      sessionId: created.sessionId || state.askSessionId,
      question,
      status: created.job?.status || 'queued',
      text: '正在等待 AI Worker…',
      refs: sentRefs,
    });
    renderAskSession();
    elements['ask-thread']?.querySelector(`[data-run-id="${created.runId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    renderAskLiveUi();
    ensureAskPoller();
    loadAskSessions().catch(() => {});
    return true;
  } catch (error) {
    const message = `未能回答：${error instanceof Error ? error.message : '未知错误'}`;
    upsertAskJob({
      runId: tempId,
      question,
      status: 'failed',
      error: true,
      text: message,
      refs: sentRefs,
    });
    renderAskSession();
    return false;
  } finally {
    setAskComposerBusy(false);
  }
}

function articleAnalysisSourceFromAsk(question) {
  const ref = state.referenceDraft.find((item) => (
    item.resourceType === 'content-item' || item.resourceType === 'post' || item.resourceType === 'inspiration'
  ));
  if (ref) {
    return {
      type: 'reference',
      reference: { resourceType: ref.resourceType, resourceId: ref.resourceId },
      question: ref.label || question || '分析已选材料',
    };
  }
  const body = String(question || '').trim();
  if (!body) return null;
  return {
    type: 'inline',
    title: body.slice(0, 80),
    body,
    question: body.slice(0, 80),
  };
}

async function askArticleAnalysis(question) {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  if (state.askSubmitting) return;
  if (state.askDetail?.session?.kind === 'inspiration' || state.askDetail?.session?.kind === 'question-answer') {
    showToast('问答记录请点 + 再开文章阅读');
    return;
  }
  const packed = articleAnalysisSourceFromAsk(question);
  if (!packed) {
    showToast('粘贴文章，或 @ 选择一条材料');
    return;
  }
  if (!state.askSessionId) openAskSession('new');
  const sessionId = state.askDetail?.session?.kind === 'article-analysis' ? state.askSessionId : undefined;
  const displayQuestion = packed.question;
  const source = packed.type === 'reference'
    ? { type: 'reference', reference: packed.reference }
    : { type: 'inline', title: packed.title, body: packed.body };
  const sentRefs = state.referenceDraft.slice();
  const tempId = `local-${Date.now()}`;
  upsertAskJob({
    runId: tempId,
    sessionId: state.askSessionId,
    question: displayQuestion,
    status: 'queued',
    text: '正在提交文章分析…',
    refs: sentRefs,
    agentMode: 'article-analysis',
  });
  renderAskSession();
  setAskComposerBusy(true);
  try {
    const created = await api('/api/v1/article-analysis/runs', {
      method: 'POST',
      body: JSON.stringify({ source, sessionId }),
    });
    clearReferences();
    removeAskJob(tempId);
    if (created.sessionId && (state.askSessionId === 'new' || !state.askSessionId)) {
      state.askSessionId = created.sessionId;
      const nextHash = askHash(created.sessionId);
      if (location.hash !== nextHash) history.replaceState({}, '', `${location.pathname}${location.search}${nextHash}`);
    }
    upsertAskJob({
      runId: created.runId,
      sessionId: created.sessionId || state.askSessionId,
      question: displayQuestion,
      status: 'queued',
      text: '正在阅读材料…',
      refs: sentRefs,
      agentMode: 'article-analysis',
    });
    renderAskSession();
    elements['ask-thread']?.querySelector(`[data-run-id="${created.runId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    renderAskLiveUi();
    ensureAskPoller();
    loadAskSessions().catch(() => {});
    return true;
  } catch (error) {
    upsertAskJob({
      runId: tempId,
      question: displayQuestion,
      status: 'failed',
      error: true,
      text: `未能分析：${error instanceof Error ? error.message : '未知错误'}`,
      refs: sentRefs,
      agentMode: 'article-analysis',
    });
    renderAskSession();
    return false;
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
const KNOWLEDGE_SWIPE_WIDTH = 84;
const FEED_SWIPE_WIDTH = 84;

const INSPIRATION_TYPE_LABELS = {
  observation: '观察',
  hypothesis: '假设',
  question: '问题',
  idea: '想法',
};

const WORK_PACKAGE_STATUS_LABELS = {
  open: '待领取',
  claimed: '实现中',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已取消',
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
    front.closest('.swipe-item')?.classList.remove('is-open');
    front.style.transform = 'translateX(0)';
  });
}

function swipeActionTarget(target) {
  return target instanceof Element && Boolean(target.closest('.swipe-delete, .swipe-pin, .swipe-archive, .swipe-actions'));
}

function swipeKeepsOwnTap(target) {
  return target instanceof Element && Boolean(target.closest(
    'a, input, textarea, select, .icon-button, .focus-btn, .feed-expand, .card-cite, .text-button',
  ));
}

function setSwipeOpen(front, open, width) {
  front.classList.toggle('is-open', open);
  front.closest('.swipe-item')?.classList.toggle('is-open', open);
  front.style.transform = `translateX(${open ? -width : 0}px)`;
}

function attachGuardedOpen(node, onOpen) {
  if (!node || typeof onOpen !== 'function') return;
  let startX = 0;
  let startY = 0;
  let armed = false;
  let ignore = false;
  node.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    armed = true;
    ignore = false;
    startX = event.clientX;
    startY = event.clientY;
  });
  node.addEventListener('pointermove', (event) => {
    if (!armed) return;
    if (Math.abs(event.clientX - startX) > 8 || Math.abs(event.clientY - startY) > 8) ignore = true;
  });
  node.addEventListener('pointercancel', () => {
    ignore = true;
    armed = false;
  });
  node.addEventListener('pointerup', () => {
    armed = false;
  });
  node.addEventListener('click', (event) => {
    if (ignore) {
      event.preventDefault();
      event.stopPropagation();
      ignore = false;
      return;
    }
    onOpen(event);
  });
}

function attachSwipe(front, width = NOTE_SWIPE_WIDTH, onTap) {
  const host = front.closest('.swipe-item') || front;
  let startX = 0;
  let startY = 0;
  let origin = 0;
  let dx = 0;
  let tracking = false;
  let axis = '';
  let suppressClick = false;
  let startTarget = null;
  let pointerId = null;

  const releaseCapture = () => {
    if (pointerId == null) return;
    try {
      host.releasePointerCapture(pointerId);
    } catch {
      // Capture may already be gone after cancel or a rejected setPointerCapture.
    }
    pointerId = null;
  };

  const finish = (event) => {
    if (!tracking && axis !== 'x') return;
    const canceled = event?.type === 'pointercancel';
    const tapped = tracking && !axis && !canceled;
    const swiped = axis === 'x';
    const tapTarget = startTarget || event?.target;
    tracking = false;
    axis = '';
    startTarget = null;
    front.style.transition = '';
    front.style.touchAction = '';
    releaseCapture();
    if (canceled && !swiped) {
      setSwipeOpen(front, origin < 0, width);
      suppressClick = true;
      return;
    }
    const open = dx < -(width / 3);
    setSwipeOpen(front, open, width);
    if (swiped) suppressClick = true;
    if (tapped && !open && !swipeKeepsOwnTap(tapTarget) && typeof onTap === 'function') {
      onTap(event);
    }
  };

  host.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (swipeActionTarget(event.target)) return;
    closeNoteSwipes(front);
    startX = event.clientX;
    startY = event.clientY;
    startTarget = event.target;
    origin = front.classList.contains('is-open') ? -width : 0;
    dx = origin;
    tracking = true;
    axis = '';
    suppressClick = false;
    pointerId = event.pointerId;
    front.style.transition = 'none';
  });
  host.addEventListener('pointermove', (event) => {
    if (!tracking) return;
    const moveX = event.clientX - startX;
    const moveY = event.clientY - startY;
    if (!axis) {
      if (Math.abs(moveX) < 8 && Math.abs(moveY) < 8) return;
      axis = Math.abs(moveY) > Math.abs(moveX) ? 'y' : 'x';
      if (axis === 'y') {
        tracking = false;
        front.style.transition = '';
        front.style.touchAction = '';
        releaseCapture();
        suppressClick = true;
        return;
      }
      front.style.touchAction = 'none';
      try {
        host.setPointerCapture(event.pointerId);
        pointerId = event.pointerId;
      } catch {
        // Some mobile WebViews reject capture; move/up still land on host.
      }
    }
    dx = Math.min(0, Math.max(-width, origin + moveX));
    front.style.transform = `translateX(${dx}px)`;
  });
  host.addEventListener('pointerup', finish);
  host.addEventListener('pointercancel', finish);
  front.addEventListener('click', (event) => {
    if (!suppressClick && !front.classList.contains('is-open')) return;
    if (swipeKeepsOwnTap(startTarget || event.target) && !suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
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

function continueWithInspiration(note) {
  toggleReference({
    resourceType: 'inspiration',
    resourceId: note.id,
    label: note.title || note.body,
    preview: note.body,
  });
  openAskSession('new');
}

function workPackageForNote(note) {
  return note?.workPackage || state.workPackages.find((item) => item.inspirationId === note?.id) || null;
}

function isWorkPackageNote(note) {
  return note?.sourceType === 'work-package' || Boolean(workPackageForNote(note));
}

function regularNotes() {
  return state.notes.filter((note) => !isWorkPackageNote(note));
}

function syncInspirePanes() {
  const tasks = state.inspirePane === 'tasks';
  const detail = tasks && Boolean(state.selectedWorkPackageId);
  if (!detail && state.composeTarget !== 'ask') {
    state.composeTarget = tasks ? 'task' : 'inspiration';
  }
  document.body.dataset.inspireDetail = detail ? '1' : '';
  elements['inspire-notes-pane']?.classList.toggle('hidden', tasks);
  elements['inspire-tasks-pane']?.classList.toggle('hidden', !tasks);
  elements['task-list-pane']?.classList.toggle('hidden', detail);
  elements['task-detail-pane']?.classList.toggle('hidden', !detail);
  elements['inspire-subnav']?.classList.toggle('hidden', detail);
  elements['note-form']?.classList.toggle('hidden', detail);
  renderInspireSubnav();
  syncDispatchComposer();
  if (detail) renderTaskDetail();
}

function renderInspireSubnav() {
  const target = elements['inspire-subnav'];
  if (!target) return;
  renderChipTabs(target, [
    { id: 'notes', label: '随记' },
    { id: 'tasks', label: '任务' },
  ], state.inspirePane === 'tasks' ? 'tasks' : 'notes', (id) => {
    state.composeTarget = id === 'tasks' ? 'task' : 'inspiration';
    setView(id === 'tasks' ? 'inspire/tasks' : 'inspire');
  });
}

function renderNoteFilters() {
  const target = elements['note-filters'];
  if (!target) return;
  const notes = regularNotes();
  const focused = notes.filter((note) => isFocused(note.id)).length;
  if (state.noteFilter === 'work-package') state.noteFilter = 'all';
  renderChipTabs(target, [
    { id: 'all', label: `全部 ${notes.length}` },
    { id: 'focus', label: `重点 ${focused}` },
  ], state.noteFilter, (id) => {
    state.noteFilter = id;
    renderNotes();
  });
  const entry = elements['note-focus-entry'];
  if (entry) {
    entry.classList.toggle('hidden', focused === 0);
    if (elements['note-focus-hint']) {
      elements['note-focus-hint'].textContent = `回看你标记的 ${focused} 条重点，不催着清空`;
    }
  }
}

function renderTaskFilters() {
  const target = elements['task-filters'];
  if (!target) return;
  const openCount = state.workPackages.filter((item) => item.status === 'open' || item.status === 'claimed').length;
  const doneCount = state.workPackages.filter((item) => item.status === 'completed' || item.status === 'failed').length;
  renderChipTabs(target, [
    { id: 'all', label: `全部 ${state.workPackages.length}` },
    { id: 'open', label: `待办 ${openCount}` },
    { id: 'done', label: `已回写 ${doneCount}` },
  ], state.taskFilter, (id) => {
    state.taskFilter = id;
    renderTasks();
  });
}

function visibleWorkPackages() {
  if (state.taskFilter === 'open') {
    return state.workPackages.filter((item) => item.status === 'open' || item.status === 'claimed');
  }
  if (state.taskFilter === 'done') {
    return state.workPackages.filter((item) => item.status === 'completed' || item.status === 'failed');
  }
  return state.workPackages;
}

function takeContinuedSection(text, mark) {
  const source = String(text || '');
  const token = `\n${mark}\n`;
  const at = source.lastIndexOf(token);
  if (at >= 0) {
    return {
      value: source.slice(at + token.length).trim(),
      rest: source.slice(0, at).trim(),
    };
  }
  if (source.startsWith(`${mark}\n`)) {
    return { value: source.slice(mark.length + 1).trim(), rest: '' };
  }
  return { value: '', rest: source };
}

function parseContinuedWorkPackageBody(body) {
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!text) {
    return {
      previous: '', result: '', instruction: '', goal: '', progress: '', steps: '', continued: false,
    };
  }
  const instructionMark = '\n继续指令：\n';
  const instructionAt = text.lastIndexOf(instructionMark);
  let instruction = '';
  let rest = text;
  if (instructionAt >= 0) {
    instruction = text.slice(instructionAt + instructionMark.length).trim();
    rest = text.slice(0, instructionAt).trim();
  } else if (text.startsWith('继续指令：\n')) {
    instruction = text.slice('继续指令：\n'.length).trim();
    rest = '';
  } else {
    return {
      previous: '', result: '', instruction: text, goal: '', progress: '', steps: '', continued: false,
    };
  }

  let taken = takeContinuedSection(rest, '上一结果：');
  const result = taken.value;
  taken = takeContinuedSection(taken.rest, '上一步骤：');
  const steps = taken.value;
  taken = takeContinuedSection(taken.rest, '上一进展：');
  const progress = taken.value;
  taken = takeContinuedSection(taken.rest, '上一目标：');
  const goal = taken.value;
  rest = taken.rest;
  let previous = '';
  if (rest.startsWith('上一任务：')) {
    previous = rest.replace(/^上一任务：\s*/, '').trim();
  } else {
    previous = rest;
  }
  return { previous, result, instruction, goal, progress, steps, continued: true };
}

function continuedPreviousSummary(previous) {
  const nested = parseContinuedWorkPackageBody(previous);
  if (nested.continued && nested.instruction) return nested.instruction;
  return String(previous || '').trim();
}

function workPackageCardTitle(pack, note) {
  const body = pack?.body || note?.body || '';
  const sections = parseContinuedWorkPackageBody(body);
  if (sections.continued && sections.instruction) {
    return clipFeedText(sections.instruction, 40);
  }
  const explicit = String(pack?.title || '').replace(/\s+/g, ' ').trim();
  if (explicit && !explicit.endsWith('…') && explicit.length <= 48) return explicit;
  return clipFeedText(
    firstFeedSentence(body) || explicit || inspirationCardTitle(note || { title: pack?.title, body }),
    40,
  );
}

function workPackageCardPreview(pack, note) {
  const body = pack?.body || note?.body || '';
  const sections = parseContinuedWorkPackageBody(body);
  if (sections.continued) {
    if (sections.result) return clipFeedText(sections.result, 96);
    const rest = textAfterLead(sections.instruction, workPackageCardTitle(pack, note));
    if (rest) return clipFeedText(rest, 96);
    if (sections.previous) return clipFeedText(continuedPreviousSummary(sections.previous), 96);
  }
  const title = workPackageCardTitle(pack, note);
  const excerpt = clipFeedText(textAfterLead(body, title), 96);
  if (excerpt) return excerpt;
  if (pack?.resultSummary) {
    return pack.status === 'failed'
      ? `未完成：${clipFeedText(pack.resultSummary, 72)}`
      : clipFeedText(pack.resultSummary, 96);
  }
  return workPackageProgressText(pack, state.workPackageTraces[pack?.id]);
}

function workPackageCardWhen(pack) {
  const when = pack.completedAt || pack.claimedAt || pack.createdAt;
  if (pack.status === 'completed') return `已写回 · ${formatTime(when)}`;
  if (pack.status === 'claimed') {
    return `${pack.cursorAgentId ? '独立会话实现中' : '实现中'} · ${formatTime(when)}`;
  }
  if (pack.status === 'failed') return `未完成 · ${formatTime(when)}`;
  if (pack.dispatchJobId) return `已派发独立会话 · ${formatTime(when)}`;
  return `已投递 · ${formatTime(when)}`;
}

function renderTasks() {
  closeNoteSwipes();
  renderTaskFilters();
  const list = elements['task-list'];
  if (!list) return;
  list.replaceChildren();
  const packs = visibleWorkPackages();
  if (!packs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = state.taskFilter === 'done'
      ? '还没有写回结果的任务。'
      : state.taskFilter === 'open'
        ? '没有待办。投递后本机 Cursor 会开独立窗口。'
        : '还没有任务。投一条不足点，独立 session 做完会把状态写回这里。';
    list.append(empty);
    return;
  }
  for (const pack of packs) {
    const note = pack.note || { id: pack.inspirationId, body: pack.body, title: pack.title };
    const row = document.createElement('div');
    row.className = 'swipe-item task-row';
    const actions = document.createElement('div');
    actions.className = 'swipe-actions swipe-actions-single';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'swipe-delete';
    remove.textContent = '删除';
    remove.addEventListener('click', () => runNoteAction(note, 'delete'));
    actions.append(remove);

    const card = document.createElement('article');
    card.className = `note-card swipe-front task-card is-${pack.status}`;
    card.dataset.workPackageId = pack.id;
    card.setAttribute('aria-label', workPackageCardTitle(pack, note));
    const head = document.createElement('div');
    head.className = 'task-card-head';
    head.append(Object.assign(document.createElement('span'), {
      className: `note-tag task-status is-${pack.status}`,
      textContent: WORK_PACKAGE_STATUS_LABELS[pack.status] || pack.status,
    }));
    head.append(Object.assign(document.createElement('small'), {
      className: 'task-card-when',
      textContent: workPackageCardWhen(pack),
    }));
    const chevron = document.createElement('span');
    chevron.className = 'note-card-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    head.append(chevron);
    card.append(head);
    card.append(Object.assign(document.createElement('h3'), {
      className: 'task-card-theme',
      textContent: workPackageCardTitle(pack, note),
    }));
    const preview = workPackageCardPreview(pack, note);
    if (preview) {
      card.append(Object.assign(document.createElement('p'), {
        className: 'task-card-preview',
        textContent: preview,
      }));
    }
    attachSwipe(card, KNOWLEDGE_SWIPE_WIDTH);
    attachGuardedOpen(card, () => openWorkPackage(pack.id));
    row.append(actions, card);
    list.append(row);
  }
}

function openWorkPackage(id) {
  const packId = String(id || '').trim();
  if (!packId) return;
  setView(`inspire/tasks/${packId}`);
}

function workPackageIsLive(pack) {
  return pack?.status === 'claimed';
}

function workPackageProgressText(pack, trace) {
  if (trace?.progress?.summary) return trace.progress.summary;
  const lastStep = trace?.steps?.at(-1);
  if (lastStep?.summary) return `${lastStep.step} ${lastStep.status}：${lastStep.summary}`;
  if (pack?.resultSummary) return pack.resultSummary;
  if (pack?.status === 'claimed') return pack.cursorAgentId ? '独立会话实现中' : '实现中';
  if (pack?.dispatchJobId) return '已派发独立会话';
  return '已投递，等待本机 Cursor 领取';
}

function workPackageHasActiveStep(trace) {
  const last = Array.isArray(trace?.steps) ? trace.steps.at(-1) : null;
  return last?.status === 'started';
}

function appendTaskThinkingMark(target) {
  const mark = document.createElement('span');
  mark.className = 'task-thinking-dots';
  mark.setAttribute('aria-hidden', 'true');
  target.append(mark);
}

function createTaskThinkingLine(text = '正在思考下一步') {
  const line = document.createElement('p');
  line.className = 'task-thinking';
  line.setAttribute('aria-live', 'polite');
  line.append(Object.assign(document.createElement('span'), {
    className: 'task-thinking-label',
    textContent: text,
  }));
  appendTaskThinkingMark(line);
  return line;
}

function workPackageTraceFingerprint(pack, trace) {
  const last = Array.isArray(trace?.steps) ? trace.steps.at(-1) : null;
  return [
    pack?.status || '',
    pack?.updatedAt || '',
    pack?.resultSummary || '',
    trace?.progress?.updatedAt || '',
    trace?.progress?.summary || '',
    Array.isArray(trace?.steps) ? trace.steps.length : 0,
    last?.at || '',
    last?.status || '',
    last?.summary || '',
  ].join('|');
}

const ATTACHMENT_MAX_COUNT = 4;
const DISPATCH_TARGETS = {
  inspiration: { label: '灵感', placeholder: '有什么想法，先记下来…', send: '记下' },
  task: { label: '任务', placeholder: '看到的不足或 bug，投给本机 Cursor…', send: '投递' },
  ask: { label: '对话', placeholder: '问一句，发给问答…', send: '发送' },
};

function attachmentUrl(item) {
  return item?.url || (item?.id ? `/api/v1/attachments/${item.id}/content` : '');
}

function revokeAttachmentPreview(item) {
  if (item?.previewUrl && String(item.previewUrl).startsWith('blob:')) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

function localAttachmentPreview(item) {
  if (item?.previewUrl) return item.previewUrl;
  const id = String(item?.id || '');
  return id && state.attachmentBlobUrls[id] ? state.attachmentBlobUrls[id] : '';
}

async function authenticatedImageUrl(item) {
  const local = localAttachmentPreview(item);
  if (local) return local;
  const id = String(item?.id || '');
  if (!id || id.startsWith('local-')) throw new Error('图片未就绪');
  const response = await fetch(attachmentUrl(item), {
    credentials: 'include',
  });
  if (!response.ok) throw new Error('图片未就绪');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  state.attachmentBlobUrls[id] = url;
  return url;
}

function bindAuthenticatedImage(image, item) {
  const local = localAttachmentPreview(item);
  image.alt = item?.originalName || '附图';
  if (local) {
    image.src = local;
    return;
  }
  void authenticatedImageUrl(item).then((url) => {
    image.src = url;
  }).catch(() => {
    image.replaceWith(Object.assign(document.createElement('span'), {
      className: 'attachment-missing',
      textContent: '图片未就绪',
    }));
  });
}

function renderAttachmentDraft(root, items, onRemove) {
  if (!root) return;
  root.replaceChildren();
  root.classList.toggle('hidden', !items.length);
  for (const item of items) {
    const thumb = document.createElement('div');
    thumb.className = 'attachment-thumb';
    const image = document.createElement('img');
    bindAuthenticatedImage(image, item);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', '去掉这张图');
    remove.textContent = '×';
    remove.addEventListener('click', () => onRemove(item.id));
    thumb.append(image, remove);
    root.append(thumb);
  }
}

function renderAttachmentView(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'attachment-view';
  for (const item of list) {
    const link = document.createElement('a');
    link.href = attachmentUrl(item) || '#';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      void authenticatedImageUrl(item).then((url) => {
        window.open(url, '_blank', 'noopener');
      }).catch(() => showToast('图片未就绪'));
    });
    const image = document.createElement('img');
    bindAuthenticatedImage(image, item);
    link.append(image);
    wrap.append(link);
  }
  return wrap;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.onerror = () => reject(new Error('无法读取图片'));
    reader.readAsDataURL(file);
  });
}

async function uploadAttachmentFile(file) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    throw new Error('只支持图片');
  }
  const data = await fileToBase64(file);
  const payload = await api('/api/v1/attachments', {
    method: 'POST',
    body: JSON.stringify({
      mime: file.type,
      originalName: file.name || '',
      data,
    }),
  });
  return payload.attachment;
}

function createLocalDraft(file) {
  return {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    mime: file.type || '',
    originalName: file.name || '',
    previewUrl: URL.createObjectURL(file),
    pending: true,
    file,
  };
}

async function addDraftAttachments(getItems, setItems, files, render) {
  const next = [...getItems()];
  const queued = [];
  for (const file of files) {
    if (!file || !String(file.type || '').startsWith('image/')) continue;
    if (next.length >= ATTACHMENT_MAX_COUNT) {
      showToast('一次最多 4 张图');
      break;
    }
    const draft = createLocalDraft(file);
    next.push(draft);
    queued.push(draft);
  }
  setItems(next);
  render?.();
  for (const draft of queued) {
    try {
      const attachment = await uploadAttachmentFile(draft.file);
      setItems(getItems().map((item) => (
        item.id === draft.id ? { ...attachment, previewUrl: draft.previewUrl } : item
      )));
    } catch (error) {
      setItems(getItems().map((item) => (
        item.id === draft.id ? { ...item, failed: true } : item
      )));
      showToast(error.message);
    }
    render?.();
  }
}

async function ensureUploadedAttachments(items) {
  const next = [];
  for (const item of items) {
    if (item.id && !item.pending && !item.failed && !String(item.id).startsWith('local-')) {
      next.push(item);
      continue;
    }
    if (!item.file) throw new Error('图片未就绪');
    const attachment = await uploadAttachmentFile(item.file);
    next.push({ ...attachment, previewUrl: item.previewUrl });
  }
  return next;
}

function bindImageComposer({ button, input, textarea, getItems, setItems, render }) {
  button?.addEventListener('click', () => input?.click());
  input?.addEventListener('change', async (event) => {
    const files = [...(event.currentTarget.files || [])];
    event.currentTarget.value = '';
    if (!files.length) return;
    try {
      await addDraftAttachments(getItems, setItems, files, render);
    } catch (error) {
      showToast(error.message);
    }
  });
  textarea?.addEventListener('paste', async (event) => {
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file' && String(item.type || '').startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    try {
      await addDraftAttachments(getItems, setItems, files, render);
    } catch (error) {
      showToast(error.message);
    }
  });
}

function renderDispatchAttachmentDraft() {
  renderAttachmentDraft(elements['note-attachments'], state.dispatchAttachments, (id) => {
    const removed = state.dispatchAttachments.find((item) => item.id === id);
    revokeAttachmentPreview(removed);
    state.dispatchAttachments = state.dispatchAttachments.filter((item) => item.id !== id);
    renderDispatchAttachmentDraft();
  });
}

function clearDispatchAttachments() {
  for (const item of state.dispatchAttachments) revokeAttachmentPreview(item);
  state.dispatchAttachments = [];
  renderDispatchAttachmentDraft();
}

function readyAttachmentIds(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => item.id)
    .filter((id) => id && !String(id).startsWith('local-'));
}

function resizeDispatchComposer() {
  const input = elements['note-body'];
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(120, Math.max(22, input.scrollHeight))}px`;
}

function closeDispatchMenus() {
  document.querySelectorAll('.dispatch-menu').forEach((menu) => menu.classList.add('hidden'));
  elements['dispatch-plus']?.setAttribute('aria-expanded', 'false');
  elements['dispatch-target']?.setAttribute('aria-expanded', 'false');
}

function toggleDispatchMenu(menu, button) {
  const open = menu?.classList.contains('hidden');
  closeDispatchMenus();
  menu?.classList.toggle('hidden', !open);
  button?.setAttribute('aria-expanded', String(Boolean(open)));
}

function syncDispatchComposer() {
  const target = DISPATCH_TARGETS[state.composeTarget] || DISPATCH_TARGETS.inspiration;
  if (elements['dispatch-target-label']) elements['dispatch-target-label'].textContent = target.label;
  if (elements['note-body']) elements['note-body'].placeholder = target.placeholder;
  elements['dispatch-send']?.setAttribute('aria-label', target.send);
  elements['note-ai-toggle']?.classList.toggle('hidden', state.composeTarget !== 'inspiration');
  elements['note-ai-toggle']?.classList.toggle('is-on', state.wantAi);
  elements['note-ai-toggle']?.setAttribute('aria-pressed', String(state.wantAi));
  resizeDispatchComposer();
}

function setComposeTarget(target) {
  const next = target === 'task' || target === 'ask' ? target : 'inspiration';
  state.composeTarget = next;
  if (next === 'task' && (state.inspirePane !== 'tasks' || state.selectedWorkPackageId)) {
    setView('inspire/tasks');
    return;
  }
  if (next === 'inspiration' && (document.body.dataset.view !== 'inspire' || state.inspirePane !== 'notes')) {
    setView('inspire');
    return;
  }
  syncDispatchComposer();
}

function persistTaskComposerDraft(value) {
  const text = value === undefined
    ? String(elements['note-body']?.value || '')
    : String(value || '');
  try {
    if (text.trim()) window.localStorage.setItem(TASK_COMPOSE_DRAFT_KEY, text);
    else window.localStorage.removeItem(TASK_COMPOSE_DRAFT_KEY);
  } catch { /* 草稿写不进去时仍可继续输入 */ }
}

function restoreTaskComposerDraft() {
  const area = elements['note-body'];
  if (!area || String(area.value || '').trim()) return;
  try {
    const saved = window.localStorage.getItem(TASK_COMPOSE_DRAFT_KEY) || '';
    if (saved) area.value = saved;
  } catch { /* 读不到就保持空框 */ }
}

function persistTaskContinueDraft(packId, value) {
  const id = String(packId || '').trim();
  if (!id) return;
  const drafts = readJsonMap(TASK_CONTINUE_DRAFT_KEY);
  const text = String(value ?? '');
  if (text.trim()) drafts[id] = text;
  else delete drafts[id];
  writeJsonMap(TASK_CONTINUE_DRAFT_KEY, drafts);
}

function readTaskContinueDraft(packId) {
  const id = String(packId || '').trim();
  if (!id) return '';
  const drafts = readJsonMap(TASK_CONTINUE_DRAFT_KEY);
  return typeof drafts[id] === 'string' ? drafts[id] : '';
}

function persistTaskDraftsFromDom() {
  persistTaskComposerDraft();
  const area = document.getElementById('task-continue-body');
  if (area && state.selectedWorkPackageId) {
    persistTaskContinueDraft(state.selectedWorkPackageId, area.value);
    if (document.activeElement === area) {
      state.taskContinueSelection = {
        start: area.selectionStart,
        end: area.selectionEnd,
      };
    }
  }
}

function stopWorkPackageProgressWatch() {
  if (state.workPackageProgressTimer) {
    clearInterval(state.workPackageProgressTimer);
    state.workPackageProgressTimer = 0;
  }
  state.workPackageProgressWatchId = '';
}

function syncWorkPackageProgressWatch() {
  const id = state.selectedWorkPackageId;
  if (!id) {
    stopWorkPackageProgressWatch();
    state.workPackageProgressFingerprint = '';
    return;
  }
  const pack = state.workPackages.find((item) => item.id === id);
  if (pack && pack.status !== 'open' && pack.status !== 'claimed') {
    stopWorkPackageProgressWatch();
    return;
  }
  if (state.workPackageProgressWatchId === id && state.workPackageProgressTimer) return;
  stopWorkPackageProgressWatch();
  state.workPackageProgressWatchId = id;
  state.workPackageProgressFingerprint = workPackageTraceFingerprint(pack, state.workPackageTraces[id]);
  refreshSelectedWorkPackageProgress().catch(() => {});
  state.workPackageProgressTimer = window.setInterval(() => {
    refreshSelectedWorkPackageProgress().catch(() => {});
  }, WORK_PACKAGE_PROGRESS_POLL_MS);
}

async function refreshSelectedWorkPackageProgress() {
  const id = state.selectedWorkPackageId;
  if (!id || state.workPackageProgressBusy) return;
  state.workPackageProgressBusy = true;
  try {
    const [packPayload, tracePayload] = await Promise.all([
      api(`/api/v1/work-packages/${id}`).catch(() => null),
      api(`/api/v1/work-packages/${id}/trace`).catch(() => null),
    ]);
    if (state.selectedWorkPackageId !== id) return;
    if (packPayload?.workPackage) {
      const next = packPayload.workPackage;
      const index = state.workPackages.findIndex((item) => item.id === id);
      if (index >= 0) state.workPackages[index] = { ...state.workPackages[index], ...next };
      else state.workPackages.unshift(next);
    }
    if (tracePayload?.trace) state.workPackageTraces[id] = tracePayload.trace;
    const pack = state.workPackages.find((item) => item.id === id);
    const fingerprint = workPackageTraceFingerprint(pack, state.workPackageTraces[id]);
    if (fingerprint !== state.workPackageProgressFingerprint) {
      state.workPackageProgressFingerprint = fingerprint;
      persistTaskDraftsFromDom();
      renderTaskDetail();
      renderTasks();
    }
    if (pack && pack.status !== 'open' && pack.status !== 'claimed') {
      stopWorkPackageProgressWatch();
    }
  } finally {
    state.workPackageProgressBusy = false;
  }
}

function renderTaskDetail() {
  const root = elements['task-detail-pane'];
  if (!root) return;
  const pack = state.workPackages.find((item) => item.id === state.selectedWorkPackageId);
  if (!pack) {
    root.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'empty-state',
      textContent: '找不到这个任务。',
    }));
    return;
  }
  const trace = state.workPackageTraces[pack.id] || { steps: [] };
  const note = pack.note || { id: pack.inspirationId, body: pack.body, title: pack.title };
  const parent = pack.parentWorkPackageId
    ? state.workPackages.find((item) => item.id === pack.parentWorkPackageId)
    : null;
  const sections = parseContinuedWorkPackageBody(pack.body || note.body || '');
  const wrap = document.createElement('article');
  wrap.className = `task-detail detail-shell is-${pack.status}`;

  const head = document.createElement('header');
  head.className = 'detail-head';
  const status = document.createElement('div');
  status.className = 'detail-status task-detail-status';
  status.append(Object.assign(document.createElement('span'), {
    className: `note-tag task-status is-${pack.status}`,
    textContent: WORK_PACKAGE_STATUS_LABELS[pack.status] || pack.status,
  }));
  if (pack.hashId) {
    status.append(Object.assign(document.createElement('small'), {
      className: 'muted',
      textContent: pack.hashId,
    }));
  }
  head.append(status);
  head.append(Object.assign(document.createElement('h2'), {
    className: 'detail-title',
    textContent: sections.continued && sections.instruction
      ? clipFeedText(sections.instruction, 48)
      : (pack.title || inspirationCardTitle(note)),
  }));

  if (parent || pack.parentWorkPackageId) {
    const lineage = document.createElement('p');
    lineage.className = 'detail-meta task-detail-parent';
    lineage.textContent = parent
      ? `续自：${workPackageCardTitle(parent, parent.note)}`
      : '续自上一 session';
    if (parent) {
      lineage.classList.add('is-link');
      lineage.addEventListener('click', () => openWorkPackage(parent.id));
    }
    head.append(lineage);
  }
  wrap.append(head);

  const pictures = renderAttachmentView(pack.attachments);
  if (pictures) wrap.append(pictures);

  if (sections.continued && sections.previous) {
    const previous = document.createElement('details');
    previous.className = 'detail-section task-history-block';
    previous.append(Object.assign(document.createElement('summary'), { textContent: '上一任务' }));
    previous.append(Object.assign(document.createElement('p'), {
      textContent: continuedPreviousSummary(sections.previous),
    }));
    wrap.append(previous);
  }
  if (sections.continued && sections.result) {
    const prior = document.createElement('details');
    prior.className = 'detail-section task-history-block';
    prior.append(Object.assign(document.createElement('summary'), { textContent: '上一结果' }));
    prior.append(Object.assign(document.createElement('p'), { textContent: sections.result }));
    wrap.append(prior);
  }
  const parentTrace = trace.parentTrace;
  const priorGoal = parentTrace?.goal?.objective || sections.goal;
  const priorProgress = parentTrace?.progress
    ? [parentTrace.progress.status, parentTrace.progress.summary].filter(Boolean).join(' · ')
    : sections.progress;
  const priorSteps = Array.isArray(parentTrace?.steps) ? parentTrace.steps : [];
  if (sections.continued && (priorGoal || priorProgress || priorSteps.length || sections.steps)) {
    const process = document.createElement('details');
    process.className = 'detail-section task-history-block';
    process.append(Object.assign(document.createElement('summary'), { textContent: '上一过程' }));
    if (priorGoal) {
      process.append(Object.assign(document.createElement('p'), { textContent: priorGoal }));
    }
    if (priorProgress) {
      process.append(Object.assign(document.createElement('p'), {
        className: 'muted',
        textContent: priorProgress,
      }));
    }
    const priorTimeline = Array.isArray(parentTrace?.timeline) && parentTrace.timeline.length
      ? parentTrace.timeline
      : [];
    if (priorTimeline.length) {
      process.append(createRunProgressList(priorTimeline));
    } else if (sections.steps && sections.steps !== '（无步骤账本）') {
      process.append(Object.assign(document.createElement('p'), { textContent: sections.steps }));
    }
    wrap.append(process);
  }

  const goal = document.createElement('section');
  goal.className = 'detail-section';
  goal.append(Object.assign(document.createElement('h3'), { className: 'detail-section-title', textContent: '目标' }));
  goal.append(Object.assign(document.createElement('p'), {
    textContent: sections.continued && sections.instruction
      ? sections.instruction
      : (trace.goal?.objective || pack.body || pack.title),
  }));
  wrap.append(goal);

  const live = workPackageIsLive(pack);
  const progress = document.createElement('section');
  progress.className = 'detail-section';
  progress.append(Object.assign(document.createElement('h3'), { className: 'detail-section-title', textContent: '当前进展' }));
  const progressSurface = document.createElement('div');
  progressSurface.className = 'detail-surface';
  progressSurface.append(Object.assign(document.createElement('p'), {
    textContent: workPackageProgressText(pack, trace),
  }));
  progressSurface.append(Object.assign(document.createElement('small'), {
    className: 'muted task-progress-when',
    textContent: live
      ? (trace.progress?.updatedAt
        ? `等待下一步 · ${formatTime(trace.progress.updatedAt)}`
        : '打开详情后按进展刷新')
      : (trace.progress?.updatedAt
        ? `随步骤刷新 · ${formatTime(trace.progress.updatedAt)}`
        : '打开详情后按进展刷新'),
  }));
  progress.append(progressSurface);
  wrap.append(progress);

  const steps = document.createElement('section');
  steps.className = 'detail-section';
  steps.append(Object.assign(document.createElement('h3'), { className: 'detail-section-title', textContent: '执行记录' }));
  const stepsSurface = document.createElement('div');
  stepsSurface.className = 'detail-surface task-terminal';
  const timeline = Array.isArray(trace.timeline) ? trace.timeline : [];
  const log = document.createElement('div');
  log.className = 'ask-run-trace';
  renderRunProgress(
    log,
    timeline,
    live ? '已派发，等待下一步。' : '投递后会先落下目标与进展，领取后再追加每一步。',
    `task:${pack.id}`,
  );
  stepsSurface.append(log);
  steps.append(stepsSurface);
  wrap.append(steps);

  if (pack.resultSummary) {
    const result = document.createElement('section');
    result.className = 'detail-section';
    result.append(Object.assign(document.createElement('h3'), {
      className: 'detail-section-title',
      textContent: pack.status === 'failed' ? '未完成' : '结果',
    }));
    const resultSurface = document.createElement('div');
    resultSurface.className = 'detail-surface';
    resultSurface.append(Object.assign(document.createElement('p'), { textContent: pack.resultSummary }));
    result.append(resultSurface);
    wrap.append(result);
  }
  if (pack.status === 'completed' || pack.status === 'failed' || pack.status === 'cancelled') {
    const actions = document.createElement('div');
    actions.className = 'detail-actions is-inline task-detail-actions';
    const retry = createDetailAction({
      iconName: 'refresh-cw',
      label: '重新做',
      primary: true,
      onClick: () => {
        void retryWorkPackage(pack.id, retry);
      },
    });
    actions.append(retry);
    wrap.append(actions);
  }

  const continueBox = document.createElement('form');
  continueBox.className = 'detail-section dispatch-composer task-continue';
  continueBox.append(Object.assign(document.createElement('h3'), { textContent: '继续做' }));
  const box = document.createElement('div');
  box.className = 'compose-box dispatch-box';
  const label = document.createElement('label');
  label.append(Object.assign(document.createElement('span'), { className: 'vh', textContent: '继续指令' }));
  const area = document.createElement('textarea');
  area.id = 'task-continue-body';
  area.name = 'body';
  area.maxLength = 100000;
  area.rows = 1;
  area.placeholder = '带着上一任务的目标、进展和步骤，开一个新 session…';
  area.value = readTaskContinueDraft(pack.id);
  area.addEventListener('input', () => persistTaskContinueDraft(pack.id, area.value));
  const selection = state.taskContinueSelection;
  if (selection) {
    queueMicrotask(() => {
      area.focus();
      try { area.setSelectionRange(selection.start, selection.end); } catch { /* 忽略非法选区 */ }
    });
    state.taskContinueSelection = null;
  }
  label.append(area);
  box.append(label);
  if (state.taskContinuePackId !== pack.id) {
    state.taskContinuePackId = pack.id;
    state.taskContinueAttachments = (pack.attachments || []).map((item) => ({ ...item }));
  }
  const continuePics = document.createElement('div');
  continuePics.className = 'attachment-draft';
  const continueInput = document.createElement('input');
  continueInput.className = 'vh';
  continueInput.type = 'file';
  continueInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
  continueInput.multiple = true;
  const renderContinuePics = () => {
    renderAttachmentDraft(continuePics, state.taskContinueAttachments, (id) => {
      const removed = state.taskContinueAttachments.find((item) => item.id === id);
      revokeAttachmentPreview(removed);
      state.taskContinueAttachments = state.taskContinueAttachments.filter((item) => item.id !== id);
      renderContinuePics();
    });
  };
  renderContinuePics();
  box.append(continuePics, continueInput);
  const toolbar = document.createElement('div');
  toolbar.className = 'dispatch-toolbar';
  const tools = document.createElement('div');
  tools.className = 'dispatch-tools';
  const plusPop = document.createElement('div');
  plusPop.className = 'dispatch-pop';
  const plus = document.createElement('button');
  plus.className = 'dispatch-icon-btn';
  plus.type = 'button';
  plus.setAttribute('aria-label', '添加');
  plus.setAttribute('aria-haspopup', 'true');
  plus.setAttribute('aria-expanded', 'false');
  plus.innerHTML = icon('plus');
  const plusMenu = document.createElement('div');
  plusMenu.className = 'dispatch-menu hidden';
  plusMenu.setAttribute('role', 'menu');
  const pickImage = document.createElement('button');
  pickImage.type = 'button';
  pickImage.setAttribute('role', 'menuitem');
  pickImage.innerHTML = `${icon('image')}<span>图片</span>`;
  plusMenu.append(pickImage);
  plus.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = plusMenu.classList.contains('hidden');
    closeDispatchMenus();
    plusMenu.classList.toggle('hidden', !open);
    plus.setAttribute('aria-expanded', String(open));
  });
  pickImage.addEventListener('click', () => {
    closeDispatchMenus();
    continueInput.click();
  });
  plusPop.append(plus, plusMenu);
  tools.append(plusPop);
  const submit = document.createElement('button');
  submit.className = 'icon-button brand ask-send';
  submit.type = 'submit';
  submit.setAttribute('aria-label', '继续做');
  submit.innerHTML = icon('send-horizontal');
  toolbar.append(tools, submit);
  box.append(toolbar);
  continueBox.append(box);
  bindImageComposer({
    input: continueInput,
    textarea: area,
    getItems: () => state.taskContinueAttachments,
    setItems: (items) => { state.taskContinueAttachments = items; },
    render: renderContinuePics,
  });
  continueBox.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      try {
        if (state.taskContinueAttachments.some((item) => item.pending || item.failed)) {
          state.taskContinueAttachments = await ensureUploadedAttachments(state.taskContinueAttachments);
          renderContinuePics();
        }
        await continueWorkPackageSession(pack.id, area.value, readyAttachmentIds(state.taskContinueAttachments));
      } catch (error) {
        showToast(error.message);
      }
    })();
  });
  wrap.append(continueBox);
  root.replaceChildren(wrap);
}

async function continueWorkPackageSession(parentId, rawBody, attachmentIds = []) {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  const body = String(rawBody || '').trim();
  if (!body) {
    showToast('先写一下要继续做的事');
    return;
  }
  let created;
  try {
    created = await api(`/api/v1/work-packages/${parentId}/continue`, {
      method: 'POST',
      body: JSON.stringify({
        body,
        attachmentIds: Array.isArray(attachmentIds) ? attachmentIds : [],
      }),
    });
  } catch (error) {
    const parent = state.workPackages.find((item) => item.id === parentId);
    if (!parent) throw error;
    const parentTrace = state.workPackageTraces[parentId];
    const priorSteps = Array.isArray(parentTrace?.steps)
      ? parentTrace.steps.map((item) => `${item.step || 'step'} ${item.status || ''}: ${item.summary || ''}`.trim()).join('\n')
      : '';
    const combined = [
      '上一任务：',
      parent.body || '',
      parentTrace?.goal?.objective ? `上一目标：\n${parentTrace.goal.objective}` : '',
      parentTrace?.progress
        ? `上一进展：\n${[parentTrace.progress.status, parentTrace.progress.summary].filter(Boolean).join(' · ')}`
        : '',
      `上一步骤：\n${priorSteps || '（无步骤账本）'}`,
      parent.resultSummary ? `上一结果：\n${parent.resultSummary}` : '',
      '继续指令：',
      body,
    ].filter(Boolean).join('\n');
    created = await api('/api/v1/work-packages', {
      method: 'POST',
      body: JSON.stringify({
        body: combined,
        attachmentIds: Array.isArray(attachmentIds) ? attachmentIds : [],
      }),
    });
    const fallbackId = created.workPackage?.id;
    if (fallbackId) {
      await api('/api/v1/work-packages/notify', {
        method: 'POST',
        body: JSON.stringify({ id: fallbackId }),
      }).catch(() => {});
    }
  }
  const nextId = created.workPackage?.id;
  persistTaskContinueDraft(parentId, '');
  state.taskContinuePackId = '';
  state.taskContinueAttachments = [];
  showToast('已开新 session。本机 Cursor CLI 会带上上一轮全过程继续做。');
  await loadNotes();
  if (nextId) openWorkPackage(nextId);
}

async function retryWorkPackage(parentId, button) {
  if (!parentId || button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const created = await api(`/api/v1/work-packages/${parentId}/retry`, {
      method: 'POST',
      body: '{}',
    });
    if (created.workPackage) {
      state.workPackages.unshift(created.workPackage);
      state.selectedWorkPackageId = created.workPackage.id;
      state.workPackageTraces[created.workPackage.id] = {
        hashId: created.workPackage.hashId,
        steps: [],
      };
      setView(`inspire/tasks/${created.workPackage.id}`);
      await loadNotes();
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderNotes() {
  closeNoteSwipes();
  renderNoteFilters();
  elements['note-list'].replaceChildren();
  const inbox = regularNotes();
  const notes = state.noteFilter === 'focus'
    ? inbox.filter((note) => isFocused(note.id))
    : inbox;
  if (!notes.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = state.noteFilter === 'focus'
      ? '暂无重点。用星标留下真正想继续思考的内容。'
      : '还没有灵感。写一条就能看见。';
    elements['note-list'].append(empty);
    return;
  }
  for (const note of notes) {
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
    card.className = `note-card swipe-front${isFocused(note.id) ? ' is-focus' : ''}`;
    card.dataset.inspirationId = note.id;
    const expanded = state.expandedInspirationIds.has(note.id);
    card.classList.toggle('is-expanded', expanded);
    card.setAttribute('aria-expanded', expanded ? 'true' : 'false');

    const head = document.createElement('div');
    head.className = 'note-card-head';
    const copy = document.createElement('div');
    copy.className = 'note-card-head-copy note-meta';
    appendResourceTags(copy, {
      typeLabel: INSPIRATION_TYPE_LABELS[note.inspirationType] || '随记',
      taxonomy: note.taxonomy,
    });
    const star = document.createElement('button');
    star.type = 'button';
    star.className = `icon-button star${isFocused(note.id) ? ' on' : ''}`;
    star.setAttribute('aria-label', isFocused(note.id) ? '取消重点' : '标记重点');
    star.innerHTML = icon('star');
    star.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleFocus(note.id, renderNotes);
    });
    head.append(copy, star);
    const bodyButton = document.createElement('button');
    bodyButton.type = 'button';
    bodyButton.className = 'note-card-body';
    bodyButton.append(Object.assign(document.createElement('h3'), { textContent: inspirationCardTitle(note) }));
    const detail = document.createElement('div');
    detail.className = 'note-card-detail';
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
    cite.className = 'text-button';
    cite.textContent = '接着研究 ↗';
    cite.addEventListener('click', (event) => {
      event.stopPropagation();
      continueWithInspiration(note);
    });
    const foot = document.createElement('div');
    foot.className = 'note-foot';
    foot.append(
      Object.assign(document.createElement('small'), {
        textContent: `${note.sourceTitle || (note.sourceUrl ? '来自信息流' : '我的随记')} · ${note.pinned ? '置顶 · ' : ''}${formatTime(note.createdAt)}`,
      }),
      cite,
    );
    detail.append(foot);
    if (note.aiReply) {
      const reply = document.createElement('div');
      reply.className = 'post-quote';
      reply.textContent = `AI 结果（与原文分开）：\n${note.aiReply}`;
      detail.append(reply);
    }
    card.append(head, bodyButton, detail, foot);
    attachNoteSwipe(card, (event) => {
      if (card.classList.contains('is-open')) {
        closeNoteSwipes();
        return;
      }
      const target = event?.target;
      const onHead = target instanceof Element && Boolean(target.closest('.note-card-head'));
      if (card.classList.contains('is-expanded') && !onHead) return;
      setInspirationExpanded(note.id, !state.expandedInspirationIds.has(note.id));
      openPage('note', note.id);
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
  persistTaskDraftsFromDom();
  const payload = await api('/api/v1/notes?status=inbox');
  state.notes = payload.notes;
  try {
    const packs = await api('/api/v1/work-packages?status=all');
    state.workPackages = packs.workPackages || [];
    const traces = {};
    const claimed = (state.workPackages || []).filter((item) => item.status === 'claimed');
    const others = (state.workPackages || []).filter((item) => item.status !== 'claimed').slice(0, 8);
    const selected = (state.workPackages || []).filter((item) => item.id === state.selectedWorkPackageId);
    const unique = new Map([...claimed, ...others, ...selected].map((item) => [item.id, item]));
    await Promise.all([...unique.values()].map(async (item) => {
      try {
        const payload = await api(`/api/v1/work-packages/${item.id}/trace`);
        traces[item.id] = payload.trace;
      } catch {
        traces[item.id] = { hashId: item.hashId, steps: [] };
      }
    }));
    state.workPackageTraces = traces;
  } catch {
    state.workPackages = [];
    state.workPackageTraces = {};
  }
  refreshSavedMarks();
  renderNotes();
  renderTasks();
  if (state.selectedWorkPackageId) renderTaskDetail();
  renderPosts();
  syncWorkPackageProgressWatch();
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

async function translateXBatch({ silent = false } = {}) {
  if (!state.session) {
    if (!silent) {
      showToast('请先在设置中完成设备连接');
      setView('settings');
    }
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
    if (state.dialogPost) {
      const live = state.xItems.find((item) => item.id === state.dialogPost.id);
      if (live) fillPostBody(elements['dialog-body'], postViewBody(xAsItem(live)));
      syncDialogTranslation(state.dialogPost);
    }
    const count = pending.filter((post) => translationFor(post)).length;
    if (!silent) {
      if (count) showToast(`已翻译 ${count} 条`);
      else showToast('这次没有译出新内容，可再点一次翻译');
    }
  } catch (error) {
    if (!silent) showToast(error instanceof Error ? error.message : '翻译失败');
  } finally {
    state.xTranslating = false;
    renderXToolbar();
  }
}

async function autoLocalizeSources() {
  if (!state.session || state.sourceLocalizing) return;
  const pending = Object.values(state.sourceLocalizations)
    .filter((row) => row?.pending && row.id && row.sourceText)
    .filter((row, index, rows) => rows.findIndex((item) => item.id === row.id) === index)
    .slice(0, TRANSLATE_BATCH_SIZE);
  if (!pending.length) return;
  state.sourceLocalizing = true;
  try {
    const payload = await api('/api/v1/translate/batch', {
      method: 'POST',
      timeoutMs: 120_000,
      body: JSON.stringify({
        targetLang: 'zh',
        items: pending.map((row) => ({ id: row.id, text: row.sourceText })),
      }),
    });
    const byId = new Map((payload.translations || []).map((row) => [row.id, row.translatedText]));
    for (const [sourceId, row] of Object.entries(state.sourceLocalizations)) {
      const text = byId.get(row.id);
      if (!text) continue;
      state.sourceLocalizations[sourceId] = { ...row, text, pending: false };
    }
    renderStaticSignalBoard();
    renderMarketNativeBoard();
    renderOverviewTimeline();
    const dialogItems = elements['source-dialog-items'];
    if (dialogItems && elements['source-dialog']?.open) {
      const sourceTitle = elements['source-dialog-title']?.textContent;
      const source = state.sourceCatalog.find((item) => item.title === sourceTitle);
      if (source) {
        const snapshot = state.sourceSnapshots[source.id];
        const rows = source.viewKind === 'calendar' ? snapshot?.data?.events : snapshot?.data?.releases;
        if (rows?.length) {
          dialogItems.replaceChildren();
          rows.forEach((item) => appendStaticSignalItem(dialogItems, item, source.viewKind));
        }
      }
    }
  } catch {
    // Keep pending placeholders; a later refresh retries Gemini.
  } finally {
    state.sourceLocalizing = false;
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
  if (state.dialogPost?.id === post.id) {
    fillPostBody(elements['dialog-body'], postViewBody(post));
    syncDialogTranslation(post);
  }
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
  throw new Error('标注仍在进行，请再等一会，或看 Worker 是否还在跑');
}

async function tagXBatch({ silent = false } = {}) {
  if (!state.session) {
    if (!silent) {
      showToast('请先在设置中完成设备连接');
      setView('settings');
    }
    return { saved: 0 };
  }
  if (state.xTagging) return { saved: 0 };
  const pending = pendingXTaggings();
  if (!pending.length) return { saved: 0 };
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
    if (!silent) {
      if (saved) showToast(`已标注 ${saved} 条`);
      else showToast('这次没有新的 Tag，可再点一次');
    }
    return { saved };
  } catch (error) {
    if (!silent) showToast(error instanceof Error ? error.message : '标注失败');
    throw error;
  } finally {
    state.xTagging = false;
    renderXToolbar();
  }
}

async function loadXFeed({ refresh = false, autoTranslate = true } = {}) {
  if (!state.session) return null;
  state.xLoading = true;
  state.xRefreshing = refresh;
  renderXToolbar();
  try {
    const params = new URLSearchParams({ platform: 'x', feed: state.xFeed, limit: '50' });
    if (refresh) params.set('refresh', '1');
    const payload = await api(`/api/v1/feed/x?${params}`, { timeoutMs: refresh ? 180_000 : 15_000 });
    const feed = payload.feed || {};
    state.xItems = (feed.items || []).filter((item) => !isHiddenFeedItem(item));
    state.xFeed = feed.feed || state.xFeed;
    state.xNote = feed.note || '';
    hydrateFeedTranslations(state.xItems);
    await syncLocalTranslationsToServer(state.xItems);
    await loadFeedTaggings(state.xItems);
    renderPosts();
    renderXToolbar();
    if (autoTranslate) translateXBatch({ silent: true }).catch(() => {});
    return feed;
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

async function runXCapturePipeline() {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  if (xTaskBusy()) {
    showToast('已有 X 任务在进行');
    return;
  }
  elements['source-tasks-dialog']?.close();
  state.xPipeline = true;
  renderXToolbar();
  try {
    showToast(`开始抓取${xFeedLabel()} 50 条新内容…`);
    const feed = await loadXFeed({ refresh: true, autoTranslate: false });
    if (!feed) return;
    if (feed.mode === 'error' || feed.mode === 'unavailable') {
      showToast(feed.note || 'X 抓取失败');
      return;
    }
    await translateXBatch({ silent: true });
    let tagged = { saved: 0 };
    try {
      tagged = await tagXBatch({ silent: true }) || { saved: 0 };
    } catch (error) {
      showToast(error instanceof Error ? error.message : '抓取完成，但打 Tag 失败');
      return;
    }
    const added = Number(feed.added) || 0;
    const skipped = Number(feed.skipped) || 0;
    const taggedCount = Number(tagged.saved) || 0;
    showToast(`新增 ${added} 条，去重 ${skipped}。已翻译${taggedCount ? `，并标注 ${taggedCount} 条` : '，当前没有待标注'}`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '抓取失败');
  } finally {
    state.xPipeline = false;
    renderXToolbar();
  }
}

async function loadXueqiuFeed({ refresh = false } = {}) {
  if (!state.session) {
    if (refresh) {
      showToast('请先在设置中完成设备连接');
      setView('settings');
    }
    return null;
  }
  state.xueqiuLoading = true;
  state.xueqiuRefreshing = Boolean(refresh);
  renderXueqiuToolbar();
  try {
    const params = new URLSearchParams({ platform: 'xueqiu', feed: state.xueqiuFeed, limit: '50' });
    if (refresh) params.set('refresh', '1');
    const payload = await api(`/api/v1/feed/xueqiu?${params}`, { timeoutMs: refresh ? 180_000 : 15_000 });
    const feed = payload.feed || {};
    state.xueqiuItems = (feed.items || []).filter((item) => !isHiddenFeedItem(item));
    state.xueqiuFeed = feed.feed || state.xueqiuFeed;
    state.xueqiuNote = feed.note || '';
    hydrateFeedTranslations(state.xueqiuItems);
    await loadFeedTaggings(state.xueqiuItems);
    renderPosts();
    renderXueqiuToolbar();
    if (refresh) {
      if (feed.mode === 'error' || feed.mode === 'unavailable') showToast(feed.note || '雪球抓取失败');
      else showToast(feed.note || `已写入 ${state.xueqiuItems.length} 条`);
    }
    return feed;
  } catch (error) {
    state.xueqiuNote = error instanceof Error ? error.message : '雪球时间线加载失败';
    renderXueqiuToolbar();
    throw error;
  } finally {
    state.xueqiuLoading = false;
    state.xueqiuRefreshing = false;
    renderXueqiuToolbar();
  }
}

async function loadTrendForceFeed({ refresh = false } = {}) {
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    return;
  }
  state.trendforceLoading = true;
  state.trendforceRefreshing = Boolean(refresh);
  renderTrendForceToolbar();
  try {
    const params = new URLSearchParams({ platform: 'trendforce' });
    if (refresh) params.set('refresh', '1');
    const payload = await api(`/api/v1/feed/trendforce?${params}`, { timeoutMs: refresh ? 180_000 : 15_000 });
    state.trendforceItems = (payload.feed?.items || []).filter((item) => !isHiddenFeedItem(item));
    state.trendforceNote = payload.feed?.note || '';
    hydrateFeedTranslations(state.trendforceItems);
    await loadFeedTaggings(state.trendforceItems);
    renderPosts();
    renderTrendForceToolbar();
    if (refresh) {
      if (payload.feed?.mode === 'error') showToast(payload.feed.note || 'TrendForce 抓取失败');
      else showToast(payload.feed?.note || `已写入 ${state.trendforceItems.length} 条`);
    }
    return payload.feed;
  } catch (error) {
    state.trendforceNote = error instanceof Error ? error.message : 'TrendForce 抓取失败';
    renderTrendForceToolbar();
    throw error;
  } finally {
    state.trendforceLoading = false;
    state.trendforceRefreshing = false;
    renderTrendForceToolbar();
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
    state.bilibiliItems = (payload.feed?.items || []).filter((item) => !isHiddenFeedItem(item));
    state.bilibiliNote = payload.feed?.note || '';
    hydrateFeedTranslations(state.bilibiliItems);
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
  state.posts = (payload.posts || []).filter((item) => !isHiddenFeedItem(item));
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
  loadXueqiuFeed({ refresh: false }).catch(() => {});
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
      if (payload.uiRevision && payload.uiRevision !== bootUiRevision()) {
        reloadShellWhenStable(payload.uiRevision).then((reloaded) => {
          if (!reloaded && payload.snapshotRequired) refreshAfterStreamGap();
        });
        return;
      }
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
  state.stream.addEventListener('job.queued', onAgentJobEvent);
  state.stream.addEventListener('job.started', onAgentJobEvent);
  state.stream.addEventListener('job.completed', onAgentJobEvent);
  state.stream.addEventListener('job.failed', onAgentJobEvent);
  state.stream.addEventListener('runtime.agent-run.progressed.v1', onAgentJobEvent);
  state.stream.addEventListener('knowledge.ai-run.completed.v1', onAgentJobEvent);
  state.stream.addEventListener('knowledge.work-package.created.v1', () => {
    loadNotes().catch(() => {});
  });
  state.stream.addEventListener('knowledge.work-package.notified.v1', () => {
    loadNotes().catch(() => {});
    showToast('已通知：有任务了');
  });
  state.stream.addEventListener('knowledge.work-package.claimed.v1', () => loadNotes().catch(() => {}));
  state.stream.addEventListener('knowledge.work-package.completed.v1', () => loadNotes().catch(() => {}));
  state.stream.addEventListener('knowledge.work-package.failed.v1', () => loadNotes().catch(() => {}));
  state.stream.onerror = () => setConnection('waiting', '正在重连');
}

async function pairFromUrl() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('pair');
  if (!code) return false;
  const deviceName = guessDeviceName();
  setConnection('waiting', '正在配对');
  await api('/api/v1/pair', { method: 'POST', body: JSON.stringify({ code, deviceName }) });
  url.searchParams.delete('pair');
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  showToast('配对成功，以后打开即可连接');
  return true;
}

function paintAuthorizedChrome() {
  bindHorizontalTabScroll();
  setIconButton(elements['open-settings'], 'settings');
  setIconButton(elements['reload-view'], 'refresh-cw');
  setIconButton(elements['ask-send'], 'send-horizontal');
  setIconButton(elements['dispatch-plus'], 'plus');
  setIconButton(elements['dispatch-send'], 'send-horizontal');
  const chevron = elements['dispatch-target']?.querySelector('.dispatch-chevron');
  if (chevron) chevron.innerHTML = icon('chevron-right');
  if (elements['dispatch-image'] && !elements['dispatch-image'].dataset.iconed) {
    elements['dispatch-image'].dataset.iconed = '1';
    elements['dispatch-image'].insertAdjacentHTML('afterbegin', icon('image'));
  }
  resizeAskComposer();
  resizeDispatchComposer();
  syncDispatchComposer();
  setIconButton(elements['open-compose'], 'plus');
  setIconButton(elements['toggle-search'], 'search');
  setIconButton(elements['nav-back'], 'chevron-left');
  setIconButton(elements['feed-filter'], 'list-filter');
  setIconButton(elements['holdings-privacy'], 'eye');
  document.querySelectorAll('.dialog-close').forEach((button) => setIconButton(button, 'x'));
  if (elements['nav-back']) elements['nav-back'].style.transform = '';
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
  renderChannels();
  renderPlatformFilters();
  renderXToolbar();
  renderBilibiliToolbar();
  setView(restoreLastLocationHash().slice(1));
}

async function readAuthorizedSession() {
  const { ok, ...session } = await api('/api/v1/session');
  if (!session.role) throw new Error('此设备尚未配对');
  return session;
}

async function waitForAuthorizedSession(attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await readAuthorizedSession();
    } catch (_error) {
      await sleep(250);
    }
  }
  throw new Error('登录已通过，但设备授权还没写进浏览器。请再试一次。');
}

async function completeAuthorizedStart(session) {
  state.session = session;
  elements['server-name'].textContent = session.serverName;
  elements['session-description'].textContent = session.role === 'desktop'
    ? '本机管理端 · 可生成手机二维码'
    : `${session.device.name} · 已长期授权`;
  paintAuthorizedChrome();
  hideUnpairedPage();
  elements['device-repair-panel'].classList.toggle('hidden', session.role === 'desktop');
  if (session.role === 'desktop') {
    elements['pairing-panel'].classList.remove('hidden');
    elements['metrics-panel'].classList.remove('hidden');
  }
  state.extras.us = readExtras('us');
  state.extras.asia = readExtras('asia');
  state.extras.cn = readExtras('cn');
  state.bootstrapped = true;
  connectStream();
  logBehavior('app.open', { role: session.role });
  if (!completeAuthorizedStart.heartbeat) {
    completeAuthorizedStart.heartbeat = window.setInterval(() => {
      syncHarmonyLocalInspirations().catch(() => {});
      if (!state.session) return;
      if (document.body.dataset.view === 'sources') loadMarket({ board: 'overview' }).catch(() => {});
      if (isQuotesView()) {
        if (state.tradePane === 'stocks') loadMarket().catch(() => {});
        if (state.tradePane === 'assets') loadGlobalAssets().catch(() => {});
        if (state.tradePane === 'holdings') loadHoldings().catch(() => {});
      }
    }, 30_000);
  }
  const startupLoads = [
    syncHarmonyLocalInspirations().catch(() => {}),
    loadSourceCatalog().catch(() => {}),
    loadPosts().catch((error) => showToast(error.message)),
    loadXFeed({ refresh: false }).catch(() => {}),
    loadXueqiuFeed({ refresh: false }).catch(() => {}),
    loadBilibiliFeed().catch(() => {}),
    loadNotes().catch(() => {}),
    loadKnowledge().catch(() => {}),
  ];
  if (document.body.dataset.view === 'ask') {
    startupLoads.push(syncAskView().catch((error) => showToast(error.message)));
  }
  startupLoads.push(loadActiveAskRuns().catch(() => {}));
  if (session.role === 'desktop') {
    startupLoads.push(loadPairing().catch((error) => showToast(error.message)));
    startupLoads.push(loadMetrics().catch(() => {}));
  }
  if (isQuotesView()) {
    startupLoads.push(syncTradePaneData().catch((error) => showToast(error.message)));
  }
  if (document.body.dataset.view === 'sources' || document.body.dataset.view === 'feed') {
    startupLoads.push(loadSourcesPage().catch(() => {}));
  }
  if (document.body.dataset.view === 'tools') {
    startupLoads.push(loadDividendInspection().catch((error) => showToast(error.message)));
  }
  scheduleOverviewFocusWatch();
  await Promise.all(startupLoads);
  if (document.body.dataset.view === 'feed') {
    restoreViewScroll('feed');
    restoreOpenFeedItem();
  }
}

async function initialize() {
  forgetLegacyDeviceGrant();
  try {
    await pairFromUrl();
    if (await maybeReloadStaleShell()) return;
    await completeAuthorizedStart(await readAuthorizedSession());
  } catch (error) {
    setConnection('offline', '尚未连接');
    elements['session-description'].textContent = error.message;
    const url = new URL(window.location.href);
    const pairingFailed = url.searchParams.has('pair');
    if (pairingFailed) removePairingCodeFromAddress();
    showUnpairedPage(error.message, pairingFailed, { loginAvailable: Boolean(error.payload?.loginAvailable) });
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
elements['login-form']?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = elements['login-submit'];
  const message = elements['login-message'];
  submit.disabled = true;
  message.classList.add('hidden');
  message.textContent = '';
  setConnection('waiting', '正在登录');
  try {
    await api('/api/v1/session/login', {
      method: 'POST',
      body: JSON.stringify({
        username: elements['login-username'].value,
        password: elements['login-password'].value,
        deviceName: guessDeviceName(),
      }),
    });
    await completeAuthorizedStart(await waitForAuthorizedSession());
  } catch (error) {
    message.textContent = error.message || '登录失败';
    message.classList.remove('hidden');
    setConnection('offline', '尚未连接');
    submit.disabled = false;
  }
});
elements['request-process-restart']?.addEventListener('click', async () => {
  try {
    const result = await api('/api/v1/runtime/restart', { method: 'POST' });
    showToast(result.restart?.requested
      ? '已请求重启 Web/Worker，隧道保持。十几秒后刷新。'
      : result.restart?.reason === 'cooldown'
        ? '刚刚已经请求过重启，稍等再试。'
        : '启动器未接手重启请求。');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '无法请求重启');
  }
});
elements['retry-session'].addEventListener('click', () => window.location.reload());
elements['open-compose'].addEventListener('click', openHeaderAction);
let reloadHoldTimer = 0;
let reloadForcedByHold = false;
function clearReloadHold() {
  if (reloadHoldTimer) window.clearTimeout(reloadHoldTimer);
  reloadHoldTimer = 0;
}
elements['reload-view']?.addEventListener('pointerdown', (event) => {
  if (event.button) return;
  reloadForcedByHold = false;
  clearReloadHold();
  reloadHoldTimer = window.setTimeout(() => {
    reloadHoldTimer = 0;
    reloadForcedByHold = true;
    reloadCurrentView({ forceShell: true }).catch((error) => showToast(error.message));
  }, 550);
});
elements['reload-view']?.addEventListener('pointerup', clearReloadHold);
elements['reload-view']?.addEventListener('pointercancel', clearReloadHold);
elements['reload-view']?.addEventListener('click', (event) => {
  if (reloadForcedByHold) {
    event.preventDefault();
    reloadForcedByHold = false;
    return;
  }
  reloadCurrentView().catch((error) => showToast(error.message));
});
elements['open-settings'].addEventListener('click', () => setView('settings'));
elements['nav-back']?.addEventListener('click', () => {
  if (document.body.dataset.view === 'sources' && state.overviewPane !== 'home') {
    setOverviewPane('home');
    return;
  }
  if (document.body.dataset.view === 'settings' && state.settingsPane === 'connections') {
    setView('settings');
    return;
  }
  if (document.body.dataset.view === 'inspire' && state.selectedWorkPackageId) {
    setView('inspire/tasks');
    return;
  }
  if (document.body.dataset.view === 'ask' && state.askSessionId) {
    setView('ask');
    return;
  }
  goBack();
});
elements['toggle-search']?.addEventListener('click', () => {
  state.showHeaderSearch = !state.showHeaderSearch;
  syncHeaderSearch();
  if (state.showHeaderSearch) elements['global-search']?.focus();
});
elements['feed-filter']?.addEventListener('click', () => {
  if (isSourceFeedScope(state.feedPlatform)) {
    openSourceTasks(state.feedPlatform);
    return;
  }
  renderFeedFilterDialog();
  if (elements['feed-filter-dialog']) openDialog(elements['feed-filter-dialog']);
});
elements['feed-open-calendar']?.addEventListener('click', () => {
  setView('sources/schedule');
  setOverviewPane('schedule');
});
elements['open-all-quotes']?.addEventListener('click', () => setView('market/global'));
elements['open-full-feed']?.addEventListener('click', () => setView('feed'));
elements['holdings-privacy']?.addEventListener('click', () => {
  state.privacy = !state.privacy;
  document.body.classList.toggle('privacy-on', state.privacy);
  setIconButton(elements['holdings-privacy'], state.privacy ? 'eye-off' : 'eye');
  renderHoldings();
});
elements['x-refresh']?.addEventListener('click', () => loadXFeed({ refresh: true }).catch((error) => showToast(error.message)));
elements['xueqiu-refresh']?.addEventListener('click', () => loadXueqiuFeed({ refresh: true }).catch((error) => showToast(error.message)));
elements['trendforce-refresh']?.addEventListener('click', () => loadTrendForceFeed({ refresh: true }).catch((error) => showToast(error.message)));
elements['trendforce-more']?.addEventListener('click', () => openSourceTasks('trendforce'));
function isBilibiliUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return /(^|\.)bilibili\.com$/i.test(url.hostname) || /(^|\.)b23\.tv$/i.test(url.hostname);
  } catch {
    return false;
  }
}
elements['bilibili-import-form']?.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = String(elements['bilibili-url']?.value || '').trim();
  if (!url) {
    showToast('请先粘贴 B 站链接');
    return;
  }
  if (!isBilibiliUrl(url)) {
    showToast('请粘贴 bilibili.com 或 b23.tv 链接');
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
elements['x-more']?.addEventListener('click', () => openSourceTasks('x'));
elements['bilibili-more']?.addEventListener('click', () => openSourceTasks('bilibili'));
elements['open-source-catalog']?.addEventListener('click', () => setOverviewPane('catalog'));
elements['open-full-schedule']?.addEventListener('click', () => setOverviewPane('schedule'));
elements['catalog-back']?.addEventListener('click', () => setOverviewPane('home'));
elements['schedule-back']?.addEventListener('click', () => setOverviewPane('home'));
elements['source-catalog-filter']?.addEventListener('input', (event) => {
  state.sourceCatalogQuery = event.currentTarget.value;
  renderStaticSourceCatalog();
});
elements['note-focus-entry']?.addEventListener('click', () => {
  state.noteFilter = 'focus';
  renderNotes();
});
elements['global-search']?.addEventListener('input', (event) => {
  const query = String(event.currentTarget.value || '').trim();
  const view = document.body.dataset.view;
  if (view === 'feed' || view === 'sources') {
    state.feedQuery = query;
    if (view === 'feed') {
      resetFeedWindow();
      renderPosts();
    } else {
      renderOverviewTimeline();
    }
  }
});
elements['global-search']?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const query = String(event.currentTarget.value || '').trim();
  const view = document.body.dataset.view;
  if (view === 'market' || view === 'assets') {
    openSearch();
    elements['symbol-search'].value = query;
    renderSearch(query);
    return;
  }
  if (view === 'feed' || view === 'sources') {
    state.feedQuery = query;
    if (view === 'feed') {
      resetFeedWindow();
      renderPosts();
    } else renderOverviewTimeline();
    return;
  }
  if (view === 'inspire' && query) {
    const hit = state.notes.find((note) => `${note.title} ${note.body}`.includes(query));
    if (hit) openPage('note', hit.id);
    showToast(hit ? '已打开匹配灵感' : '没有匹配的灵感');
  }
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
  if (url) {
    persistFeedBrowseState();
    markFeedItemRead(state.dialogPost);
    openExternalHttpUrl(url);
  }
});
bindPostLink(elements['dialog-translate'], () => {
  if (!state.dialogPost) return;
  requestTranslate(state.dialogPost).catch((error) => showToast(error.message));
});
bindPostLink(elements['dialog-save'], () => {
  if (!state.dialogPost) return;
  savePostToInspiration(state.dialogPost).catch((error) => showToast(error.message));
});
bindPostLink(elements['dialog-cite'], () => {
  if (!state.dialogPost) return;
  toggleReference({
    resourceType: state.dialogPost.resourceType || (state.dialogPost.live && state.dialogPost.platform !== 'manual' ? 'content-item' : 'post'),
    resourceId: state.dialogPost.resourceId || (state.dialogPost.platform === 'manual' ? state.dialogPost.id : ''),
    label: postDisplayTitle(state.dialogPost),
    preview: translationFor(state.dialogPost)?.text || state.dialogPost.body,
  });
  elements['post-dialog']?.close();
  openAskSession(state.askSessionId || 'new');
});
for (const id of ['compose-dialog', 'search-dialog', 'post-dialog', 'source-dialog', 'subscriptions-dialog', 'holding-dialog', 'reference-preview', 'reference-pack', 'source-tasks-dialog', 'feed-filter-dialog', 'share-image-dialog']) {
  const dialog = elements[id];
  if (!dialog) continue;
  dialog.querySelector('.dialog-close')?.addEventListener('click', () => {
    dialog.close();
    releaseDialogScroll();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (id === 'share-image-dialog') closeShareImagePreview();
    if (id === 'post-dialog') {
      const stayId = state.feedRestoreId;
      state.dialogPost = null;
      renderPosts();
      state.feedRestoreId = stayId;
      persistFeedBrowseState();
    }
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
bindImageComposer({
  input: elements['note-image-input'],
  textarea: elements['note-body'],
  getItems: () => state.dispatchAttachments,
  setItems: (items) => { state.dispatchAttachments = items; },
  render: renderDispatchAttachmentDraft,
});
elements['dispatch-plus']?.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleDispatchMenu(elements['dispatch-plus-menu'], elements['dispatch-plus']);
});
elements['dispatch-target']?.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleDispatchMenu(elements['dispatch-target-menu'], elements['dispatch-target']);
});
elements['dispatch-image']?.addEventListener('click', () => {
  closeDispatchMenus();
  elements['note-image-input']?.click();
});
elements['dispatch-target-menu']?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-dispatch-target]');
  if (!button) return;
  closeDispatchMenus();
  setComposeTarget(button.dataset.dispatchTarget);
});
elements['note-ai-toggle']?.addEventListener('click', () => {
  state.wantAi = !state.wantAi;
  syncDispatchComposer();
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.dispatch-pop')) closeDispatchMenus();
  if (swipeActionTarget(event.target)) return;
  const item = event.target.closest('.swipe-item');
  closeNoteSwipes(item?.querySelector('.swipe-front') || undefined);
});
elements['note-body']?.addEventListener('input', () => {
  persistTaskComposerDraft();
  resizeDispatchComposer();
});
restoreTaskComposerDraft();
setIconButton(elements['dispatch-plus'], 'plus');
setIconButton(elements['dispatch-send'], 'send-horizontal');
const dispatchChevron = elements['dispatch-target']?.querySelector('.dispatch-chevron');
if (dispatchChevron) dispatchChevron.innerHTML = icon('chevron-right');
if (elements['dispatch-image'] && !elements['dispatch-image'].dataset.iconed) {
  elements['dispatch-image'].dataset.iconed = '1';
  elements['dispatch-image'].insertAdjacentHTML('afterbegin', icon('image'));
}
resizeDispatchComposer();
syncDispatchComposer();
elements['note-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  closeDispatchMenus();
  if (!state.session) {
    showToast('请先在设置中完成设备连接');
    setView('settings');
    return;
  }
  const body = String(elements['note-body']?.value || '').trim();
  try {
    if (state.composeTarget === 'ask') {
      if (!body) {
        showToast('先写一句再发给问答');
        return;
      }
      if (state.dispatchAttachments.length) {
        showToast('问答只发文字，图片请改投灵感或任务');
      }
      const ok = await askAgent(body);
      if (ok) {
        elements['note-body'].value = '';
        persistTaskComposerDraft('');
        resizeDispatchComposer();
      }
      return;
    }
    if (state.dispatchAttachments.some((item) => item.pending || item.failed)) {
      state.dispatchAttachments = await ensureUploadedAttachments(state.dispatchAttachments);
      renderDispatchAttachmentDraft();
    }
    const attachmentIds = readyAttachmentIds(state.dispatchAttachments);
    if (state.composeTarget === 'task') {
      if (!body) {
        showToast('先写一下不足或 bug');
        return;
      }
      const created = await api('/api/v1/work-packages', {
        method: 'POST',
        body: JSON.stringify({ body, attachmentIds }),
      });
      const workPackageId = created.workPackage?.id;
      try {
        await api('/api/v1/work-packages/notify', {
          method: 'POST',
          body: JSON.stringify(workPackageId ? { id: workPackageId } : {}),
        });
      } catch {
        /* 旧服务端没有 notify 时，任务本身已经落库 */
      }
      elements['note-body'].value = '';
      elements['note-form'].reset();
      clearDispatchAttachments();
      persistTaskComposerDraft('');
      showToast('已投递。本机 Cursor CLI 会做完退出，状态写回这里。');
      await loadNotes();
      syncDispatchComposer();
      return;
    }
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
        attachmentIds,
      }),
    });
    elements['note-form'].reset();
    clearDispatchAttachments();
    clearSharedInspirationDraft();
    const askedWithAi = state.wantAi;
    state.wantAi = false;
    syncDispatchComposer();
    showToast(askedWithAi ? '原文已记下。AI 加工会另外反馈结果。' : '已记下');
    await loadNotes();
    if (captureChannel === 'harmony-share' && typeof window.AICenterShareHost?.closeShare === 'function') {
      window.AICenterShareHost.closeShare();
    }
  } catch (error) {
    showToast(error.message);
  }
});
elements['ask-start'].addEventListener('click', () => openAskSession('new'));
elements['ask-live-chip']?.addEventListener('click', () => {
  const live = liveAskJobs();
  const target = live.find((job) => job.status === 'running') || live[0];
  if (target?.sessionId && target.sessionId !== 'new') openAskSession(target.sessionId);
  else setView('ask');
});
elements['reference-dock'].addEventListener('click', () => openReferencePack());
elements['reference-pack-ask']?.addEventListener('click', () => sendReferencePackToAsk());
elements['reference-pack-task']?.addEventListener('click', () => {
  sendReferencePackToTask().catch((error) => showToast(error.message));
});
elements['reference-pack-export']?.addEventListener('click', () => {
  exportReferencePack().catch((error) => showToast(error.message));
});
elements['reference-pack-clear']?.addEventListener('click', () => {
  clearReferences();
  closeReferencePack();
  showToast('已清空材料');
});
elements['share-image-save']?.addEventListener('click', () => {
  saveShareImagePreview().catch((error) => showToast(error.message));
});
elements['ask-ref-export']?.addEventListener('click', () => {
  exportReferencePack().catch((error) => showToast(error.message));
});
elements['ask-ref-task']?.addEventListener('click', () => {
  sendReferencePackToTask().catch((error) => showToast(error.message));
});
elements['ask-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  hideAskMentions();
  const form = event.currentTarget;
  const question = String(new FormData(form).get('question') || '').trim();
  if (currentAgentMode() === 'article-analysis') {
    if (!question && !state.referenceDraft.length) {
      showToast('粘贴文章，或 @ 选择一条材料');
      return;
    }
    void askArticleAnalysis(question).then((ok) => {
      if (ok) form.elements.question.value = '';
    });
    return;
  }
  if (!question) return;
  void askAgent(question).then((ok) => {
    if (ok) form.elements.question.value = '';
  });
});
elements['ask-form'].elements.question.addEventListener('input', onAskComposerInput);
elements['ask-form'].elements.question.addEventListener('keydown', onAskComposerKeydown);
elements['ask-form'].elements.question.addEventListener('focus', () => {
  setAskComposerCompact(false);
  syncAskKeyboard();
});
elements['ask-form']?.addEventListener('pointerdown', () => setAskComposerCompact(false));
elements['ask-thread']?.addEventListener('scroll', onAskThreadScroll, { passive: true });
elements['ask-form'].elements.question.addEventListener('blur', () => {
  window.setTimeout(() => {
    hideAskMentions();
    syncAskKeyboard();
  }, 120);
});
window.visualViewport?.addEventListener('resize', syncAskKeyboard);
window.visualViewport?.addEventListener('scroll', syncAskKeyboard);
window.addEventListener('resize', syncAskKeyboard);
restoreWebMode();
restoreResearchMode();
restoreAgentMode();
window.addEventListener('hashchange', () => {
  if (!state.session) return;
  setView(location.hash.slice(1));
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    persistFeedBrowseState();
    persistTaskDraftsFromDom();
  }
  if (document.visibilityState === 'visible') {
    if (!state.session) return;
    syncHarmonyLocalInspirations().catch(() => {});
    if (liveAskJobs().length) void pollAskJobs();
    else void loadActiveAskRuns();
    if (state.selectedWorkPackageId) refreshSelectedWorkPackageProgress().catch(() => {});
  }
});
window.addEventListener('pagehide', () => {
  persistFeedBrowseState();
  persistTaskDraftsFromDom();
});
elements['dialog-body']?.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a') : null;
  if (!link || !elements['dialog-body'].contains(link)) return;
  persistFeedBrowseState();
  markFeedItemRead(state.dialogPost);
  openExternalHttpUrl(link.href, event);
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
