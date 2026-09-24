import {
  inHalfOpenWindow,
  resolveDailyConfig,
  resolveDailyTimeContext,
  resolveReportDate,
} from './daily-window.js';

const MARKET_NOTE = '这是生成日报时能够取得的最新行情状态，不是刚好截止到日报窗口结束的历史快照。';

function clip(value, max) {
  const text = String(value || '');
  return text.length > max ? text.slice(0, max) : text;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function lightBoard(board, key) {
  const indices = Array.isArray(board?.indices) ? board.indices.slice(0, 8).map((quote) => ({
    symbol: String(quote.symbol || ''),
    name: String(quote.name || ''),
    lastPrice: finiteOrNull(quote.lastPrice),
    changePct: finiteOrNull(quote.changePct),
    asOf: Number.isInteger(quote.asOf) ? quote.asOf : null,
  })) : [];
  const asOf = indices.reduce((latest, quote) => Math.max(latest, quote.asOf || 0), 0) || null;
  return {
    board: key,
    mode: board?.mode === 'live' || board?.mode === 'partial' ? board.mode : 'unavailable',
    fetchedAt: Number.isInteger(board?.fetchedAt) ? board.fetchedAt : null,
    asOf: asOf || (Number.isInteger(board?.fetchedAt) ? board.fetchedAt : null),
    indices,
    note: MARKET_NOTE,
  };
}

function unavailableBoard(key) {
  return lightBoard(null, key);
}

export function createReportService({
  reportRepository,
  feedService,
  tradingService,
  staticSignalPort,
  strategyPort = null,
  defaultConfig = resolveDailyConfig({}),
  now = () => Date.now(),
}) {
  if (!reportRepository || !feedService || !tradingService) {
    throw new Error('report service requires report, feed, and trading ports');
  }

  return Object.freeze({
    getDailyReport(workspaceId, reportDate) {
      return reportRepository.getDailyReport(workspaceId || 'local', reportDate);
    },
    getLatestDailyReport(workspaceId) {
      return reportRepository.getLatestDailyReport(workspaceId || 'local');
    },
    listDailyReports(workspaceId, limit) {
      return reportRepository.listDailyReports(workspaceId || 'local', limit);
    },
    getDailyBrief(workspaceId, reportDate) {
      return reportRepository.getDailyBriefByDate(workspaceId || 'local', reportDate);
    },
    getLatestDailyBrief(workspaceId) {
      return reportRepository.getLatestDailyBrief(workspaceId || 'local');
    },
    async generateDailyReport(input = {}) {
      const generatedAt = now();
      const timezone = input.timezone || defaultConfig.timezone;
      const cutoffHour = input.cutoffHour ?? defaultConfig.cutoffHour;
      const cutoffMinute = input.cutoffMinute ?? defaultConfig.cutoffMinute;
      const upcomingHours = defaultConfig.upcomingHours;
      const clock = Number.isInteger(input.scheduledFor) ? input.scheduledFor : generatedAt;
      const reportDate = input.reportDate || resolveReportDate(clock, { timezone, cutoffHour, cutoffMinute });
      const time = resolveDailyTimeContext({
        reportDate,
        timezone,
        cutoffHour,
        cutoffMinute,
        generatedAt,
        upcomingHours,
      });
      const workspaceId = input.workspaceId || 'local';
      const warnings = [];
      const newsLimit = input.newsLimit || 200;
      const newsRows = feedService.listContentItemsInWindow(workspaceId, {
        startAt: time.contentWindow.startAt,
        endAt: time.contentWindow.endAt,
        limit: newsLimit,
      }) || [];
      const news = newsRows.map((item) => ({
        id: item.id,
        title: clip(item.title, 1_000),
        summary: clip(item.summary, 500),
        sourceUrl: item.sourceUrl || '',
        authorName: clip(item.authorName, 512),
        publishedAt: item.publishedAt ?? null,
        createdAt: item.createdAt,
        capturedAt: item.capturedAt ?? null,
        eventAt: item.eventAt ?? item.publishedAt ?? item.createdAt,
      }));

      let releases = [];
      let upcoming = [];
      if (staticSignalPort?.readBoard) {
        try {
          const board = await staticSignalPort.readBoard({
            from: time.upcomingWindow.startAt,
            to: Math.max(time.upcomingWindow.startAt, time.upcomingWindow.endAt - 1),
            focus: false,
            includeUndated: false,
            limit: 200,
            releaseLimit: 80,
          });
          releases = (board.releases || []).filter((release) => inHalfOpenWindow(release.publishedAt, time.contentWindow));
          upcoming = (board.upcoming || []).filter((event) => inHalfOpenWindow(event.scheduledAt, time.upcomingWindow));
          for (const health of board.sourceHealth || []) {
            if (health.status === 'unavailable' && health.note) warnings.push(clip(health.note, 500));
          }
        } catch (error) {
          warnings.push(clip(error instanceof Error ? error.message : error, 500) || '官方与日程读取失败');
        }
      } else {
        warnings.push('官方与日程端口未配置');
      }

      const markets = {};
      for (const board of ['cn', 'global']) {
        try {
          markets[board] = lightBoard(await tradingService.getBoard({ board }), board);
          if (markets[board].mode !== 'live') warnings.push(`${board} 行情不是完整快照`);
        } catch (error) {
          markets[board] = unavailableBoard(board);
          warnings.push(clip(error instanceof Error ? error.message : error, 500) || `${board} 行情读取失败`);
        }
      }

      let strategy = null;
      let strategyRef = null;
      if (strategyPort?.latestBefore) {
        const snapshot = await strategyPort.latestBefore(workspaceId, time.contentWindow.endAt);
        if (snapshot?.factors?.regime) {
          strategy = {
            strategyKey: snapshot.strategyKey,
            asOf: snapshot.asOf,
            regime: snapshot.factors.regime,
            factors: snapshot.factors,
          };
          strategyRef = { type: 'strategy-snapshot', id: snapshot.id, at: snapshot.asOf };
        } else {
          warnings.push('尚无可用的红利策略快照');
        }
      }

      const sourceRefs = [
        ...news.map((item) => ({ type: 'content-item', id: item.id, at: item.eventAt })),
        ...releases.map((release) => ({ type: 'official-release', id: release.releaseId, at: release.publishedAt })),
        ...upcoming.map((event) => ({ type: 'scheduled-event', id: event.eventId, at: event.scheduledAt })),
        ...['cn', 'global'].map((board) => ({
          type: 'market-snapshot',
          id: board,
          at: markets[board].asOf,
        })),
        ...(strategyRef ? [strategyRef] : []),
      ];
      const content = {
        reportDate: time.reportDate,
        timezone,
        window: time.contentWindow,
        upcomingWindow: time.upcomingWindow,
        generatedAt,
        news,
        officialReleases: releases.slice(0, 200),
        upcoming: upcoming.slice(0, 200),
        market: { cn: markets.cn, global: markets.global },
        strategy,
        warnings: warnings.filter(Boolean).slice(0, 50),
      };
      return reportRepository.upsertDailyReport({
        workspaceId,
        reportDate: time.reportDate,
        status: warnings.length ? 'partial' : 'ready',
        content,
        sourceRefs,
      });
    },
  });
}
