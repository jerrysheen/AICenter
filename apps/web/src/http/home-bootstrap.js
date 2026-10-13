import { createHash } from 'node:crypto';
import { homeRequestPlan, hourlyEditions, selectHomeHourHits } from '../../public/home-timeline.js';
import { emptyMarketBoard } from '../../../../packages/source/src/market/board-read.js';
import { emptyStaticSignalBoard } from '../../../../packages/source/src/static/board.js';
import { labelEventLoop } from './event-loop-blocks.js';
import { prepareJsonBody, sendPreparedJson } from './prepared-json.js';
import { createStaleReadCache } from './stale-read-cache.js';

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
    informationItemCount: items.length,
    informationItems: sentences,
  };
}

function slimQuote(item) {
  if (!item?.symbol) return null;
  return {
    symbol: item.symbol,
    name: item.name || '',
    lastPrice: item.lastPrice ?? null,
    changePct: item.changePct ?? null,
    currency: item.currency || '',
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
    focus: market.focus || '',
    ...(market.note ? { note: clip(market.note, 180) } : {}),
    sections: sections.slice(0, 2).map((section) => ({
      id: section.id || '',
      title: section.title || '',
      session: section.session || '',
      indices: (section.indices || []).map(slimQuote).filter(Boolean),
      gainers: (section.gainers || []).slice(0, 6).map(slimQuote).filter(Boolean),
      losers: (section.losers || []).slice(0, 6).map(slimQuote).filter(Boolean),
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

function ifNoneMatch(request, etag) {
  const header = String(request?.headers?.['if-none-match'] || '').trim();
  if (!header) return false;
  if (header === '*') return true;
  const wanted = etag.replace(/^W\//, '');
  return header.split(',').some((part) => part.trim().replace(/^W\//, '') === wanted);
}

export function homeBootstrapEtag(body) {
  const stable = { ...(body || {}) };
  delete stable.generatedAt;
  return `W/"${createHash('sha1').update(JSON.stringify(stable)).digest('hex')}"`;
}

export async function composeHomeBootstrap(services, { workspace = 'local', now = Date.now() } = {}) {
  const query = homeBootstrapQuery(now);
  const leaveTree = labelEventLoop('home.bootstrap');
  let treeBody;
  try {
    treeBody = services.informationTree.list(workspace, query.tree);
  } finally {
    leaveTree();
  }
  const tree = slimTree(treeBody);
  await yieldEventLoop();
  const readings = {};
  let filled = 0;
  for (const edition of hourlyEditions(tree)) {
    const startAt = Number(edition?.window?.startAt);
    const endAt = Number(edition?.window?.endAt);
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) continue;
    const leaveHour = labelEventLoop('home.bootstrap');
    try {
      const loadSnapshot = filled < HOME_BOOTSTRAP_VISIBLE_HOURS && services.readingHour?.forWindow;
      const snapshot = loadSnapshot
        ? services.readingHour.forWindow(workspace, { startAt, endAt }, 'hour')
        : null;
      const limit = filled === 0 ? 5 : 2;
      readings[startAt] = slimReading(snapshot, loadSnapshot ? limit : 0);
      if (readings[startAt].items.length) filled += 1;
    } finally {
      leaveHour();
    }
    await yieldEventLoop();
  }
  const leaveBrief = labelEventLoop('home.bootstrap');
  let brief;
  try {
    brief = { ok: true, brief: briefView(services.report?.getLatestDailyBrief?.(workspace) ?? null) };
  } finally {
    leaveBrief();
  }

  let market = { ok: true, market: slimMarket(emptyMarketBoard('overview', now)), pending: true };
  if (services.marketBoard?.read) {
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
  }

  let board = { ok: true, board: slimBoard(emptyStaticSignalBoard(now)), pending: true };
  if (services.staticSignalBoard?.read) {
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
  }

  return {
    ok: true,
    generatedAt: now,
    window: {
      startAt: query.tree.startAt,
      endAt: query.tree.endAt,
      boardFrom: Number(query.board.from),
      boardTo: Number(query.board.to),
    },
    tree,
    readings,
    market,
    brief,
    board,
  };
}

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createHomeBootstrapHandler({ ttlMs = HOME_BOOTSTRAP_TTL_MS, now = () => Date.now() } = {}) {
  const cache = createStaleReadCache({
    ttlMs,
    now,
    refreshLeadMs: Math.min(5_000, Math.floor(ttlMs / 3)),
  });
  return async function homeBootstrap({ request, response, services, identity, url, json }) {
    const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
    const workspace = identity?.device?.workspaceId || 'local';
    const bucket = homeBootstrapQuery(now());
    const key = `${workspace}|${bucket.tree.startAt}|${bucket.tree.endAt}|${bucket.board.from}`;
    const prepared = await cache.get(
      key,
      async () => {
        const body = await composeHomeBootstrap(services, { workspace, now: now() });
        const packed = await prepareJsonBody(body);
        packed.etag = homeBootstrapEtag(body);
        return packed;
      },
      { refresh },
    );
    const headers = { ETag: prepared.etag, 'Cache-Control': 'private, no-cache' };
    if (!refresh && ifNoneMatch(request, prepared.etag)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    sendPreparedJson(request, response, 200, prepared, headers);
  };
}
