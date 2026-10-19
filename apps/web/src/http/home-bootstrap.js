import { createHash } from 'node:crypto';
import { homeRequestPlan, hourlyEditions, selectHomeHourHits } from '../../public/home-timeline.js';
import { emptyMarketBoard } from '../../../../packages/source/src/market/board-read.js';
import { emptyStaticSignalBoard } from '../../../../packages/source/src/static/board.js';
import { HOME_BOOTSTRAP_SNAPSHOT_KEY } from '../../../../packages/runtime/src/web-snapshot-jobs.js';
import { labelEventLoop } from './event-loop-blocks.js';
import { createPreparedSlotStore } from './prepared-slots.js';

export const HOME_BOOTSTRAP_PATH = '/api/v1/home/bootstrap';
export const HOME_BOOTSTRAP_TTL_MS = 15_000;
export const HOME_BOOTSTRAP_VISIBLE_HOURS = 4;
export const HOME_BOOTSTRAP_HOUR_SLOTS = 8;
export const HOME_BOOTSTRAP_RAW_BUDGET = 100_000;

export function homeBootstrapQuery(nowMs = Date.now()) {
  const plan = homeRequestPlan(nowMs);
  const tree = new URL(plan.tree, 'http://local');
  const reading = new URL(plan.readingIndex, 'http://local');
  const board = new URL(plan.board, 'http://local');
  return {
    tree: {
      startAt: Number(tree.searchParams.get('startAt')),
      endAt: Number(tree.searchParams.get('endAt')),
      view: 'index',
    },
    reading: {
      startAt: Number(reading.searchParams.get('startAt')),
      endAt: Number(reading.searchParams.get('endAt')),
      scope: reading.searchParams.get('scope') || 'hour',
    },
    board: {
      from: board.searchParams.get('from'),
      to: board.searchParams.get('to'),
      focus: board.searchParams.get('focus') || '1',
      limit: board.searchParams.get('limit') || '40',
      releaseLimit: board.searchParams.get('releaseLimit') || '60',
    },
  };
}

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}

function briefView(brief) {
  if (!brief) return null;
  const items = Array.isArray(brief.informationItems) ? brief.informationItems : [];
  const sentences = items.filter((item) => item?.sentence).slice(0, 5).map((item) => ({
    id: item.id,
    sentence: clip(item.sentence, 180),
    occurredAt: item.occurredAt ?? null,
  }));
  return {
    ...(brief.reportDate ? { reportDate: brief.reportDate } : {}),
    ...(brief.generatedAt ? { generatedAt: brief.generatedAt } : {}),
    ...(typeof brief.sentence === 'string' ? { sentence: clip(brief.sentence, 180) } : {}),
    ...(typeof brief.overview === 'string' ? { overview: clip(brief.overview, 280) } : {}),
    informationItemCount: Number(brief.informationItemCount) > 0 ? Number(brief.informationItemCount) : items.length,
    informationItems: sentences,
  };
}

function slimSparkline(value) {
  if (!Array.isArray(value)) return [];
  const points = value.slice(-30).map((point) => Number(point)).filter((point) => Number.isFinite(point));
  return points.length >= 2 ? points : [];
}

function slimQuote(item, { includeSummary = false } = {}) {
  if (!item?.symbol) return null;
  const asOf = Number(item.asOf ?? item.marketTime);
  const sparkline = slimSparkline(item.sparkline);
  const summary = includeSummary ? clip(item.summary, 40) : '';
  return {
    symbol: item.symbol,
    name: item.name || '',
    lastPrice: item.lastPrice ?? null,
    changePct: item.changePct ?? null,
    currency: item.currency || '',
    ...(summary ? { summary } : {}),
    ...(item.session ? { session: item.session } : {}),
    ...(typeof item.marketOpen === 'boolean' ? { marketOpen: item.marketOpen } : {}),
    ...(Number.isFinite(asOf) && asOf > 0 ? { asOf } : {}),
    ...(sparkline.length ? { sparkline } : {}),
  };
}

function slimMarket(market) {
  if (!market || typeof market !== 'object') return market;
  const sections = Array.isArray(market.sections) && market.sections.length
    ? market.sections
    : [{ id: market.focus || 'overview', indices: market.indices || [] }];
  return {
    board: market.board || 'overview',
    mode: market.mode || '',
    fetchedAt: market.fetchedAt ?? null,
    session: market.session || '',
    ...(typeof market.marketOpen === 'boolean' ? { marketOpen: market.marketOpen } : {}),
    focus: market.focus || '',
    ...(market.note ? { note: clip(market.note, 180) } : {}),
    sections: sections.slice(0, 2).map((section) => ({
      id: section.id || '',
      title: section.title || '',
      session: section.session || '',
      ...(typeof section.marketOpen === 'boolean' ? { marketOpen: section.marketOpen } : {}),
      indices: (section.indices || []).map((item) => slimQuote(item)).filter(Boolean),
      gainers: (section.gainers || []).slice(0, 6).map((item) => slimQuote(item, { includeSummary: true })).filter(Boolean),
      losers: (section.losers || []).slice(0, 6).map((item) => slimQuote(item, { includeSummary: true })).filter(Boolean),
    })),
  };
}

function slimRelease(release) {
  if (!release || typeof release !== 'object') return null;
  return {
    releaseId: release.releaseId || release.id || '',
    title: clip(release.title, 180),
    authority: release.authority || '',
    documentNumber: release.documentNumber || '',
    sourceUrl: release.sourceUrl || '',
    publishedAt: release.publishedAt ?? null,
    observedAt: release.observedAt ?? null,
    effectiveAt: release.effectiveAt ?? null,
  };
}

function slimBoard(board) {
  if (!board || typeof board !== 'object') return board;
  return {
    generatedAt: board.generatedAt ?? null,
    releases: (board.releases || []).slice(0, 8).map(slimRelease).filter(Boolean),
    upcoming: [],
    sourceHealth: (board.sourceHealth || []).slice(0, 40).map((row) => ({
      sourceId: row.sourceId || '',
      title: row.title || '',
      category: row.category || '',
      status: row.status || '',
      observedAt: row.observedAt ?? null,
      note: clip(row.note, 120),
    })),
  };
}

function slimEdition(row) {
  if (!row?.window) return null;
  return {
    id: row.id || '',
    status: row.status || '',
    window: {
      startAt: Number(row.window.startAt),
      endAt: Number(row.window.endAt),
    },
  };
}

function slimTree(treeBody) {
  const hours = [];
  for (const edition of hourlyEditions(treeBody).slice(0, HOME_BOOTSTRAP_HOUR_SLOTS)) {
    const slim = slimEdition(edition);
    if (slim) hours.push({ edition: slim });
  }
  return { ok: true, hours };
}

function slimReading(snapshot, limit) {
  if (!snapshot) return { items: [] };
  const hits = selectHomeHourHits(snapshot).slice(0, limit).map((item) => ({
    nodeId: item.nodeId || '',
    title: clip(item.title, 180),
    disposition: item.disposition || '',
    readingDirectionName: item.readingDirectionName || '',
    readingThemeName: item.readingThemeName || '',
    publisher: item.publisher || '',
    publishedAt: item.publishedAt ?? null,
    firstIngestedAt: item.firstIngestedAt ?? null,
    timely: item.timely !== false,
  }));
  return {
    ...(snapshot.id ? { id: snapshot.id } : {}),
    ...(snapshot.window ? { window: snapshot.window } : {}),
    items: hits,
  };
}

export function homeBootstrapEtag(body) {
  const stable = { ...(body || {}) };
  delete stable.generatedAt;
  return `W/"${createHash('sha1').update(JSON.stringify(stable)).digest('hex')}"`;
}

async function timed(name, segments, fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    segments[name] = Date.now() - started;
  }
}

function snapshotHasItems(snapshot) {
  return Array.isArray(snapshot?.items) && snapshot.items.length > 0;
}

function readingsFromEditions(services, workspace, editions) {
  const windows = [];
  for (const edition of editions) {
    const startAt = Number(edition?.window?.startAt);
    const endAt = Number(edition?.window?.endAt);
    if (Number.isFinite(startAt) && Number.isFinite(endAt)) windows.push({ startAt, endAt });
  }
  const loaded = new Map();
  const reading = services.readingHour;
  if (reading?.listWindowSnapshots && reading?.presentSnapshots) {
    const raw = reading.listWindowSnapshots(workspace, windows, 'hour') || [];
    const byStart = new Map();
    for (const snapshot of raw) {
      const startAt = Number(snapshot?.window?.startAt);
      if (Number.isFinite(startAt)) byStart.set(startAt, snapshot);
    }
    const chosen = [];
    for (const window of windows) {
      if (chosen.length >= HOME_BOOTSTRAP_VISIBLE_HOURS) break;
      const snapshot = byStart.get(window.startAt);
      if (snapshotHasItems(snapshot)) chosen.push(snapshot);
    }
    for (const snapshot of reading.presentSnapshots(workspace, chosen) || []) {
      const startAt = Number(snapshot?.window?.startAt);
      if (Number.isFinite(startAt)) loaded.set(startAt, snapshot);
    }
  } else if (reading?.forWindows) {
    for (const snapshot of reading.forWindows(workspace, windows, 'hour') || []) {
      const startAt = Number(snapshot?.window?.startAt);
      if (Number.isFinite(startAt)) loaded.set(startAt, snapshot);
    }
  }
  const readings = {};
  let filled = 0;
  for (const window of windows) {
    const loadSnapshot = filled < HOME_BOOTSTRAP_VISIBLE_HOURS;
    let snapshot = null;
    if (loadSnapshot) {
      snapshot = loaded.get(window.startAt) || null;
      if (!snapshot && !services.readingHour?.forWindows && services.readingHour?.forWindow) {
        snapshot = services.readingHour.forWindow(workspace, window, 'hour');
      }
    }
    const limit = filled === 0 ? 5 : 2;
    readings[window.startAt] = slimReading(snapshot, loadSnapshot ? limit : 0);
    if (readings[window.startAt].items.length) filled += 1;
  }
  return readings;
}

export async function composeHomeBootstrap(services, { workspace = 'local', now = Date.now() } = {}) {
  const query = homeBootstrapQuery(now);
  const segments = {};
  const started = Date.now();
  const treeTask = timed('tree', segments, async () => {
    const leaveTree = labelEventLoop('home.bootstrap');
    try {
      return services.informationTree.list(workspace, query.tree);
    } finally {
      leaveTree();
    }
  });
  const briefTask = timed('brief', segments, async () => {
    const leaveBrief = labelEventLoop('home.bootstrap');
    try {
      const card = briefView(services.informationTree?.latestDaily?.(workspace) ?? null);
      return { ok: true, daily: card, brief: card };
    } finally {
      leaveBrief();
    }
  });
  const marketTask = timed('market', segments, async () => {
    let market = { ok: true, market: slimMarket(emptyMarketBoard('overview', now)), pending: true };
    if (!services.marketBoard?.read) return market;
    try {
      const loaded = await services.marketBoard.read({ board: 'overview' }, { refresh: false });
      market = {
        ok: true,
        market: slimMarket(loaded.market),
        ...(loaded.pending ? { pending: true } : {}),
      };
    } catch {
      market = { ok: true, market: slimMarket(emptyMarketBoard('overview', now)), pending: true };
    }
    return market;
  });
  const boardTask = timed('board', segments, async () => {
    let board = { ok: true, board: slimBoard(emptyStaticSignalBoard(now)), pending: true };
    if (!services.staticSignalBoard?.read) return board;
    try {
      const loaded = await services.staticSignalBoard.read(query.board, { refresh: false });
      board = {
        ok: true,
        board: slimBoard(loaded.board),
        ...(loaded.pending ? { pending: true } : {}),
      };
    } catch {
      board = { ok: true, board: slimBoard(emptyStaticSignalBoard(now)), pending: true };
    }
    return board;
  });
  const treeBody = await treeTask;
  const readings = await timed('readings', segments, async () => readingsFromEditions(services, workspace, hourlyEditions(slimTree(treeBody))));
  const [brief, market, board] = await Promise.all([briefTask, marketTask, boardTask]);
  await yieldEventLoop();
  segments.total = Date.now() - started;
  return {
    ok: true,
    generatedAt: now,
    timings: segments,
    window: {
      startAt: query.tree.startAt,
      endAt: query.tree.endAt,
      boardFrom: Number(query.board.from),
      boardTo: Number(query.board.to),
    },
    tree: slimTree(treeBody),
    readings,
    market,
    daily: brief,
    brief,
    board,
  };
}

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createHomeBootstrapHandler({ slots = createPreparedSlotStore() } = {}) {
  return async function homeBootstrap({ request, response, url }) {
    const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
    slots.send(request, response, HOME_BOOTSTRAP_SNAPSHOT_KEY, {
      headers: { 'Cache-Control': 'private, max-age=0, stale-while-revalidate=60' },
      allow304: !refresh,
    });
  };
}
