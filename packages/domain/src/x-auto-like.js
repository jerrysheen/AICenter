import {
  aggregateFocusPoints,
  autoLikeEnvEnabled,
  autoLikeLimits,
  buildDriftFromSnapshot,
  focusFeedFromSource,
  mergeFocusSnapshot,
  nextAutoLikeSettings,
  normalizeAutoLikeSettings,
  rankAutoLikeCandidates,
  retainFocusWindow,
  shanghaiDayKey,
  shanghaiDayStart,
  storedFocus,
} from './x-focus.js';

const SETTINGS_KEY = 'x-auto-like';
const DRIFT_KEY = 'x-focus-drift';
const DAY_MS = 86_400_000;
const VIEW_TTL_MS = 60_000;
export const KEYWORD_RESCORE_LIMIT = 40;
export const FOCUS_POINT_LIMIT = 20000;
const KEYWORD_RESCORE_WINDOW_MS = 6 * 60 * 60 * 1000;

function text(value) {
  return String(value || '').trim();
}

const RESULT_LABELS = {
  liked: '已点赞',
  'already-liked': '原先已点赞',
  unconfirmed: '未确认',
  'login-required': '需要登录',
  blocked: '被拦截',
  unavailable: '暂不可用',
  'not-found': '未找到原帖',
  unliked: '已取消点赞',
  'not-liked': '原先未点赞',
  failed: '未完成',
  queued: '处理中',
  running: '处理中',
};

export function createXFocusService({
  config,
  env = process.env,
  feedRepository = null,
  runtimeRepository = null,
  snapshots = null,
  reportRepository = null,
  scorer = null,
  requestLike = null,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (!config) throw new Error('x-focus 配置缺失');
  const limits = () => autoLikeLimits(config, env);

  function readSettings(workspaceId) {
    const row = snapshots?.readSnapshot?.(workspaceId, SETTINGS_KEY);
    return normalizeAutoLikeSettings(row?.payload);
  }

  function writeSettings(workspaceId, settings) {
    const next = normalizeAutoLikeSettings(settings);
    snapshots?.saveSnapshot?.(workspaceId, SETTINGS_KEY, next, now());
    return next;
  }

  const viewCache = new Map();

  function likeJobs(workspaceId, since) {
    return runtimeRepository?.listJobsByType?.('feed.x.like', { workspaceId, since, limit: 1000 }) || [];
  }

  function unlikeJobs(workspaceId, since) {
    return runtimeRepository?.listJobsByType?.('feed.x.unlike', { workspaceId, since, limit: 200 }) || [];
  }

  function dropView(workspaceId) {
    viewCache.delete(workspaceId);
  }

  function candidates(workspaceId, at) {
    const rows = feedRepository?.listRecentXCaptures?.(workspaceId, { since: at - DAY_MS, limit: 400 }) || [];
    return rows.map((row) => {
      const metadata = row.metadata || {};
      const focus = storedFocus(metadata, config);
      const profile = metadata.authorProfile && typeof metadata.authorProfile === 'object' ? metadata.authorProfile : {};
      return {
        contentItemId: row.contentItemId || '',
        tweetId: String(row.externalId || ''),
        title: row.title || '',
        text: row.text || metadata.originalText || '',
        authorHandle: row.authorHandle || metadata.authorHandle || profile.handle || '',
        authorName: row.authorName || profile.name || '',
        authorVerified: row.authorVerified || metadata.authorVerified || profile.verified || profile.verifiedType || '',
        sourceUrl: row.sourceUrl || '',
        capturedAt: row.capturedAt || 0,
        feed: row.feed || focusFeedFromSource(row.sourceExternalId),
        metadata,
        focus,
      };
    }).filter((row) => row.focus);
  }

  function noticeFor(settings) {
    if (!autoLikeEnvEnabled(env)) return '环境变量未打开，不会自动点赞';
    if (settings.suspended && settings.notice) return settings.notice;
    if (!settings.pageEnabled) return '页面开关未打开，不会自动点赞';
    return '';
  }

  function jobFailureReason(job) {
    const error = job?.error;
    if (error && typeof error === 'object') return text(error.message) || text(error.name) || '任务出错';
    return text(error) || '任务出错';
  }

  function failedAutoLikes(workspaceId, at) {
    return likeJobs(workspaceId, at - 30 * DAY_MS).filter((job) => job?.input?.source === 'auto' && job.status === 'failed' && job.id);
  }

  function observeAutoLikeFailures(workspaceId) {
    const settings = readSettings(workspaceId);
    const at = now();
    const failed = failedAutoLikes(workspaceId, at).sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
    if (!settings.failureWatchReady) {
      writeSettings(workspaceId, {
        ...settings,
        failureWatchReady: true,
        notedFailureIds: [...new Set([...settings.notedFailureIds, ...failed.map((job) => job.id)])].slice(-1000),
      });
      return;
    }
    const noted = new Set(settings.notedFailureIds);
    let current = settings;
    let changed = false;
    let announced = false;
    for (const job of failed) {
      if (noted.has(job.id)) continue;
      const reason = jobFailureReason(job);
      current = nextAutoLikeSettings(current, 'failed', reason);
      noted.add(job.id);
      changed = true;
      if (!announced && current.suspended && !settings.suspended) {
        announced = true;
        log(`[worker] x-auto-like stopped status=failed reason=${reason}`);
      }
    }
    if (!changed) return;
    writeSettings(workspaceId, {
      ...current,
      failureWatchReady: true,
      notedFailureIds: [...noted].slice(-1000),
    });
    dropView(workspaceId);
  }

  return Object.freeze({
    limits,
    readSettings,
    async dispatch(workspaceId = 'local') {
      observeAutoLikeFailures(workspaceId);
      const settings = readSettings(workspaceId);
      if (!autoLikeEnvEnabled(env) || !settings.pageEnabled || settings.suspended) return { dispatched: false };
      const openLike = runtimeRepository?.listOpenJobs?.('feed.x.like') || [];
      const openUnlike = runtimeRepository?.listOpenJobs?.('feed.x.unlike') || [];
      if (openLike.length || openUnlike.length) return { dispatched: false, reason: 'busy' };
      const at = now();
      const ranked = rankAutoLikeCandidates(candidates(workspaceId, at), likeJobs(workspaceId, at - 30 * DAY_MS), { ...config, limits: limits() }, at);
      if (!ranked.picked) return { dispatched: false, reason: ranked.usage.blocked ? 'limit' : 'empty' };
      const picked = ranked.picked;
      const input = {
        contentItemId: picked.contentItemId,
        source: 'auto',
        tweetId: picked.tweetId,
        focusScore: picked.focus.focusScore,
        primaryDir: picked.focus.primaryDir,
        directionLabel: config.labels[picked.focus.primaryDir] || '',
        reason: picked.focus.reason,
      };
      requestLike(workspaceId, input);
      log(`[worker] x-auto-like tweet=${picked.tweetId} score=${picked.focus.focusScore} dir=${picked.focus.primaryDir}`);
      return { dispatched: true, tweetId: picked.tweetId };
    },
    recordAutoLike(workspaceId, output) {
      const settings = readSettings(workspaceId);
      const jobId = text(output?.jobId);
      if (output?.status === 'failed' && jobId && settings.notedFailureIds.includes(jobId)) return settings;
      let next = nextAutoLikeSettings(settings, output?.status, output?.reason);
      if (output?.status === 'failed' && jobId) {
        next = {
          ...next,
          notedFailureIds: [...new Set([...next.notedFailureIds, jobId])].slice(-1000),
        };
      }
      if (next !== settings) writeSettings(workspaceId, next);
      dropView(workspaceId);
      if (next.suspended && !settings.suspended) {
        log(`[worker] x-auto-like stopped status=${output?.status || ''} reason=${text(output?.reason)}`);
      }
      return next;
    },
    refreshDrift(workspaceId = 'local') {
      const at = now();
      const previous = snapshots?.readSnapshot?.(workspaceId, DRIFT_KEY)?.payload || null;
      const full = !previous || previous.version !== config.version || !previous.feeds;
      const since = full ? at - 14 * DAY_MS : shanghaiDayStart(at) - DAY_MS;
      const points = (feedRepository?.listXFocusPoints?.(workspaceId, { since, limit: FOCUS_POINT_LIMIT }) || []).map((row) => ({
        ...row,
        feed: focusFeedFromSource(row.sourceExternalId),
      }));
      const fresh = aggregateFocusPoints(points, config);
      const payload = full ? retainFocusWindow(fresh, config, at) : mergeFocusSnapshot(previous, fresh, config, at);
      snapshots?.saveSnapshot?.(workspaceId, DRIFT_KEY, payload, at);
      reportRepository?.deleteAnalysisStagesBefore?.(workspaceId, 'x-focus', at - 14 * DAY_MS, shanghaiDayKey(at));
      dropView(workspaceId);
      return payload;
    },
    invalidateView(workspaceId = 'local') {
      dropView(workspaceId);
    },
    async rescoreKeywords(workspaceId = 'local') {
      if (!scorer?.scoreCards) return { rescored: 0 };
      const at = now();
      const rows = feedRepository?.listKeywordXFocus?.(workspaceId, {
        since: at - KEYWORD_RESCORE_WINDOW_MS,
        limit: KEYWORD_RESCORE_LIMIT,
      }) || [];
      if (!rows.length) return { rescored: 0 };
      const scored = await scorer.scoreCards(rows.map((row) => ({ id: row.externalId, text: row.text })), {
        deadlineAt: at + config.scoreTimeoutMs + 15_000,
      });
      let rescored = 0;
      for (const row of rows) {
        const focus = scored?.byId?.[row.externalId];
        if (!focus || focus.method !== 'model') continue;
        if (feedRepository?.patchCaptureXFocus?.(workspaceId, row.externalId, focus)) rescored += 1;
      }
      log(`[worker] x-focus rescore checked=${rows.length} updated=${rescored}`);
      return { rescored };
    },
    setPageEnabled(workspaceId, enabled) {
      dropView(workspaceId);
      const current = readSettings(workspaceId);
      const watch = {
        notedFailureIds: current.notedFailureIds,
        failureWatchReady: current.failureWatchReady,
      };
      if (enabled === true) {
        return writeSettings(workspaceId, {
          pageEnabled: true,
          suspended: false,
          notice: '',
          consecutiveUnconfirmed: 0,
          consecutiveUnavailable: 0,
          consecutiveTaskErrors: 0,
          ...watch,
        });
      }
      return writeSettings(workspaceId, {
        pageEnabled: false,
        suspended: false,
        notice: '',
        consecutiveUnconfirmed: 0,
        consecutiveUnavailable: 0,
        consecutiveTaskErrors: 0,
        ...watch,
      });
    },
    view(workspaceId = 'local') {
      const at = now();
      const cached = viewCache.get(workspaceId);
      if (cached && at - cached.at < VIEW_TTL_MS) return cached.value;
      const settings = readSettings(workspaceId);
      const likes = likeJobs(workspaceId, at - 30 * DAY_MS);
      const unlikes = unlikeJobs(workspaceId, at - 30 * DAY_MS);
      const usage = rankAutoLikeCandidates([], likes, { ...config, limits: limits() }, at).usage;
      const driftSnapshot = snapshots?.readSnapshot?.(workspaceId, DRIFT_KEY)?.payload || null;
      const recent = [...likes, ...unlikes]
        .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
        .slice(0, 80);
      const captures = feedRepository?.listXCapturesByContentIds?.(
        workspaceId,
        recent.map((job) => job.input?.contentItemId).filter(Boolean),
      ) || [];
      const actions = recent.map((job) => projectAction(job, captures, config, unlikes));
      const currentLimits = limits();
      const value = {
        autoLike: {
          environmentOn: autoLikeEnvEnabled(env),
          pageOn: settings.pageEnabled && !settings.suspended,
          stopped: settings.suspended,
          notice: noticeFor(settings),
          todayCount: usage.dailyUsed,
          todayLimit: currentLimits.dailyLimit,
          hourCount: usage.hourlyUsed,
          hourLimit: currentLimits.hourlyLimit,
        },
        drift: buildDriftFromSnapshot(driftSnapshot, likes, config, at),
        actions,
        capturedOn: shanghaiDayKey(at),
      };
      viewCache.set(workspaceId, { at, value });
      return value;
    },
  });
}

function projectAction(job, captures, config, unlikes) {
  const input = job.input || {};
  const capture = captures.find((row) => row.contentItemId && row.contentItemId === input.contentItemId);
  const focus = capture?.focus ? storedFocus({ xFocus: capture.focus }, config) : null;
  const resultStatus = job.status === 'completed'
    ? (job.output?.status || 'unconfirmed')
    : (job.status === 'failed' || job.status === 'cancelled' ? 'failed' : job.status);
  const sourceLabel = job.type === 'feed.x.unlike' ? '取消点赞' : (input.source === 'auto' ? '自动' : '手动');
  const laterUnlike = unlikes.some((row) => row.input?.contentItemId === input.contentItemId
    && row.createdAt >= job.createdAt
    && row.status === 'completed'
    && row.output?.status === 'unliked');
  const canUnlike = job.type === 'feed.x.like'
    && !laterUnlike
    && (resultStatus === 'liked' || resultStatus === 'already-liked')
    && Boolean(input.contentItemId);
  return {
    id: job.id,
    at: job.createdAt,
    sourceLabel,
    title: text(capture?.title) || text(input.directionLabel) || 'X 帖子',
    href: capture?.sourceUrl || '',
    scoreText: Number.isFinite(Number(input.focusScore))
      ? Number(input.focusScore).toFixed(2)
      : (focus ? focus.focusScore.toFixed(2) : '—'),
    direction: text(input.directionLabel) || (focus ? (config.labels[focus.primaryDir] || '') : ''),
    reason: text(input.reason) || focus?.reason || '',
    result: RESULT_LABELS[resultStatus] || '未完成',
    canUnlike,
    contentItemId: input.contentItemId || '',
  };
}
