import { fetchXVideoMedia } from '../../connectors/src/x/video-media.js';
import { articleProgress, describeYoutubeArticle } from './youtube-article-status.js';
import { formatYmd, zonedParts } from './zoned-time.js';
import { nextZonedDayStart, youtubeArticleDailyLimit, youtubePodcastClock } from './youtube-podcasts.js';
import { ensureXVideoFeedPost } from './x-video-feed.js';
import {
  nextSharedArticleOpportunity,
  parseXStatusId,
  previousSharedArticleOpportunity,
  X_VIDEO_ARTICLE_JOB_TYPE,
  xVideoArticleEnabled,
} from './x-video-articles.js';

const BLOCKED_HOLD = new Set(['daily-limit', 'failed', 'quota', 'login', 'page']);

function readState(raw) {
  try {
    const parsed = JSON.parse(raw || '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* 状态损坏时按没有处理 */ }
  return null;
}

function activeHold(facts, today) {
  const hold = String(facts.holdReason || '');
  if (hold === 'daily-limit' && facts.holdDay && facts.holdDay !== today) return '';
  return hold;
}

function articleView(row, now, env) {
  if (row.status === 'transcribing' && !row.articleStatus) {
    return {
      status: 'running',
      message: '正在转写，完成后开始整理',
      done: 0,
      total: 0,
      holdReason: '',
      nextAt: null,
    };
  }
  const facts = row.articleState
    ? articleProgress(row.articleState)
    : { holdReason: '', holdDay: '', done: 0, total: 0 };
  const clock = youtubePodcastClock(env);
  const today = formatYmd(zonedParts(now, clock.timeZone));
  const hold = activeHold(facts, today);
  const blocked = facts.holdDay === today && BLOCKED_HOLD.has(facts.holdReason);
  const ingested = Number(row.createdAt) || 0;
  const last = previousSharedArticleOpportunity(now, env);
  const overdue = row.articleStatus !== 'ready'
    && hold !== 'daily-limit'
    && !BLOCKED_HOLD.has(hold)
    && !((Number(facts.done) || 0) > 0 && (Number(facts.total) || 0) > 0)
    && Number.isFinite(last)
    && last >= ingested
    && now > last;
  const nextAt = row.articleStatus === 'ready' || row.status === 'ready'
    ? null
    : nextSharedArticleOpportunity(blocked ? nextZonedDayStart(now, clock.timeZone) - 1 : now, env);
  return describeYoutubeArticle({
    articleStatus: row.articleStatus || (row.status === 'ready' ? 'ready' : 'pending'),
    holdReason: hold,
    done: facts.done,
    total: facts.total,
    nextAt,
    overdue,
    now,
    timeZone: clock.timeZone,
  });
}

function visible(row) {
  if (!row?.videoId) return false;
  if (row.status === 'skipped') return false;
  return true;
}

export function createXVideoService({ repository, store, feedRepository = null, loadMedia = null, env = process.env }) {
  async function loadTweet(tweetId) {
    if (typeof loadMedia === 'function') return loadMedia(tweetId);
    return fetchXVideoMedia(tweetId);
  }

  async function ensureFeed(workspaceId, tweetId) {
    return ensureXVideoFeedPost({
      feedRepository,
      workspaceId,
      tweetId,
      loadTweet,
      recomputeAuthor: (authorId) => store?.repositories?.authors?.recomputeAuthor?.(workspaceId, authorId),
    });
  }

  function rememberFeed(workspaceId, tweetId, videoId, current, feed) {
    if (!feed?.contentItemId || feed.contentItemId === (current?.contentItemId || '')) return;
    repository.savePost({
      workspaceId,
      tweetId,
      videoId,
      contentItemId: feed.contentItemId,
      ...(feed.sourceUrl ? { sourceUrl: feed.sourceUrl } : {}),
    });
  }

  return {
    enabled() {
      return xVideoArticleEnabled(env);
    },

    status(workspaceId, tweetId, now = Date.now()) {
      const id = parseXStatusId(tweetId);
      if (!id) return null;
      const row = repository.articleForTweet(workspaceId, id);
      if (!visible(row)) return null;
      const article = articleView(row, now, env);
      return {
        tweetId: id,
        videoId: row.videoId,
        articleStatus: row.status === 'ready' ? 'ready' : (row.articleStatus || 'pending'),
        article,
      };
    },

    get(workspaceId, tweetId, now = Date.now()) {
      const id = parseXStatusId(tweetId);
      if (!id) return null;
      const row = repository.articleForTweet(workspaceId, id);
      if (!row || row.status !== 'ready' || row.articleStatus !== 'ready') return null;
      return {
        tweetId: id,
        videoId: row.videoId,
        title: row.articleTitle || '',
        body: row.articleBody || '',
        sourceUrl: row.sourceUrl || '',
        durationSec: row.durationSec,
        articleStatus: 'ready',
        article: articleView(row, now, env),
      };
    },

    async enqueue(workspaceId, raw) {
      if (!xVideoArticleEnabled(env)) return { status: 'disabled' };
      const tweetId = parseXStatusId(raw?.tweetId || raw?.url || raw);
      if (!tweetId) return { status: 'invalid' };
      const existing = repository.articleForTweet(workspaceId, tweetId);
      const videoId = existing?.videoId || `tweet:${tweetId}`;
      if (!existing) {
        repository.savePost({
          workspaceId,
          tweetId,
          videoId,
          contentItemId: '',
          quotedTweetId: '',
          sourceUrl: `https://x.com/i/status/${tweetId}`,
        });
        repository.saveArticle({
          workspaceId,
          videoId,
          status: 'probe',
          manual: 1,
          reason: '',
        });
      }
      const open = (store.listOpenJobs?.(X_VIDEO_ARTICLE_JOB_TYPE) || [])
        .find((job) => String(job.input?.tweetId || '') === tweetId);
      let job = null;
      const jobCreated = !existing && !open;
      if (jobCreated) {
        job = store.createJob({
          type: X_VIDEO_ARTICLE_JOB_TYPE,
          workspaceId,
          maxAttempts: 1,
          input: { workspaceId, tweetId, manual: true },
        });
      }
      const feed = await ensureFeed(workspaceId, tweetId);
      rememberFeed(workspaceId, tweetId, videoId, existing, feed);
      if (existing?.status === 'ready' && existing.articleStatus === 'ready') {
        return {
          status: 'ready',
          tweetId,
          videoId: existing.videoId,
          contentItemId: feed.contentItemId || existing.contentItemId || '',
          authorId: feed.authorId || '',
          jobCreated: false,
        };
      }
      return {
        status: 'queued',
        tweetId,
        jobId: open?.id || job?.id || '',
        jobCreated,
        contentItemId: feed.contentItemId || existing?.contentItemId || '',
        authorId: feed.authorId || '',
        ...(jobCreated ? { dailyLimit: youtubeArticleDailyLimit(env) } : {}),
      };
    },

    holdState(row) {
      return readState(row?.articleState);
    },
  };
}
