import { createHash } from 'node:crypto';
import { homeRequestPlan, hourlyEditions } from '../../public/home-timeline.js';
import { emptyMarketBoard } from '../../../../packages/source/src/market/board-read.js';
import { emptyStaticSignalBoard } from '../../../../packages/source/src/static/board.js';
import { collectLocalizationUnits } from '../../../../packages/domain/src/localize-texts.js';
import { labelEventLoop } from './event-loop-blocks.js';
import { createStaleReadCache } from './stale-read-cache.js';

export const HOME_BOOTSTRAP_PATH = '/api/v1/home/bootstrap';
export const HOME_BOOTSTRAP_TTL_MS = 15_000;
export const HOME_BOOTSTRAP_VISIBLE_HOURS = 4;
export const HOME_BOOTSTRAP_LIST_LIMIT = 12;

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

function briefView(brief) {
  if (!brief) return null;
  const { providerId, modelId, ...view } = brief;
  return view;
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

async function localizeBoard(services, workspace, board) {
  const units = collectLocalizationUnits(board);
  if (!units.length || !services.feed?.localizeTexts) return {};
  const result = await services.feed.localizeTexts(units, { workspaceId: workspace }, { wait: false });
  return result?.localizations || {};
}

async function readFeedList(services, workspace, providerId) {
  if (!services.feed?.getExternalFeed) return null;
  const leave = labelEventLoop(`feed.${providerId}`);
  try {
    const feed = await services.feed.getExternalFeed(providerId, {
      limit: HOME_BOOTSTRAP_LIST_LIMIT,
      fields: 'list',
      refresh: false,
      feed: providerId === 'x' ? 'for-you' : 'following',
    }, { workspaceId: workspace });
    if (!feed || typeof feed !== 'object') return null;
    const items = Array.isArray(feed.items) ? feed.items.slice(0, HOME_BOOTSTRAP_LIST_LIMIT) : [];
    return { ...feed, items };
  } catch {
    return null;
  } finally {
    leave();
  }
}

export async function composeHomeBootstrap(services, { workspace = 'local', now = Date.now() } = {}) {
  const query = homeBootstrapQuery(now);
  const leave = labelEventLoop('home.bootstrap');
  let treeBody;
  let readingIndex;
  let readings;
  let brief;
  let posts;
  try {
    treeBody = services.informationTree.list(workspace, query.tree);
    readingIndex = services.readingHour?.indexForRange
      ? services.readingHour.indexForRange(workspace, {
        startAt: query.reading.startAt,
        endAt: query.reading.endAt,
      }, query.reading.scope)
      : { hours: [] };
    readings = {};
    if (services.readingHour?.forWindow) {
      for (const edition of hourlyEditions(treeBody).slice(0, HOME_BOOTSTRAP_VISIBLE_HOURS)) {
        const startAt = Number(edition?.window?.startAt);
        const endAt = Number(edition?.window?.endAt);
        if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) continue;
        const snapshot = services.readingHour.forWindow(workspace, { startAt, endAt }, 'hour');
        if (snapshot) readings[startAt] = snapshot;
      }
    }
    brief = { ok: true, brief: briefView(services.report?.getLatestDailyBrief?.('local') ?? null) };
    posts = {
      ok: true,
      posts: (services.feed?.listLegacyPosts?.(HOME_BOOTSTRAP_LIST_LIMIT) || []).slice(0, HOME_BOOTSTRAP_LIST_LIMIT),
    };
  } finally {
    leave();
  }

  let market = { ok: true, market: emptyMarketBoard('overview', now), pending: true };
  if (services.marketBoard?.read) {
    try {
      const loaded = await services.marketBoard.read({ board: 'overview' }, { refresh: false });
      market = {
        ok: true,
        market: loaded.market,
        ...(loaded.pending ? { pending: true } : {}),
      };
    } catch {
      market = { ok: true, market: emptyMarketBoard('overview', now), pending: true };
    }
  }

  let board = { ok: true, board: emptyStaticSignalBoard(now), localizations: {}, pending: true };
  if (services.staticSignalBoard?.read) {
    try {
      const loaded = await services.staticSignalBoard.read(query.board, { refresh: false });
      const localizations = await localizeBoard(services, workspace, loaded.board);
      board = {
        ok: true,
        board: loaded.board,
        localizations,
        ...(loaded.pending ? { pending: true } : {}),
      };
    } catch {
      board = { ok: true, board: emptyStaticSignalBoard(now), localizations: {}, pending: true };
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
    tree: { ok: true, ...treeBody },
    readingIndex: { ok: true, ...readingIndex },
    readings,
    market,
    brief,
    board,
    posts,
    feeds: {
      x: await readFeedList(services, workspace, 'x'),
      xueqiu: await readFeedList(services, workspace, 'xueqiu'),
    },
  };
}

export function createHomeBootstrapHandler({ ttlMs = HOME_BOOTSTRAP_TTL_MS, now = () => Date.now() } = {}) {
  const cache = createStaleReadCache({ ttlMs, now });
  return async function homeBootstrap({ request, response, services, identity, url, json }) {
    const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
    const workspace = identity?.device?.workspaceId || 'local';
    const bucket = homeBootstrapQuery(now());
    const key = `${workspace}|${bucket.tree.startAt}|${bucket.tree.endAt}|${bucket.board.from}`;
    const body = await cache.get(
      key,
      () => composeHomeBootstrap(services, { workspace, now: now() }),
      { refresh },
    );
    const etag = homeBootstrapEtag(body);
    const headers = { ETag: etag, 'Cache-Control': 'private, no-cache' };
    if (!refresh && ifNoneMatch(request, etag)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    await json(response, 200, body, headers, { compress: true });
  };
}
