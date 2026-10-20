import { articleProgress, describeYoutubeArticle } from './youtube-article-status.js';
import { formatYmd, zonedParts } from './zoned-time.js';
import { nextZonedDayStart, youtubeArticleDailyLimit, youtubePodcastClock } from './youtube-podcasts.js';
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

export function createXVideoService({ repository, store, env = process.env }) {
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

    enqueue(workspaceId, raw) {
      if (!xVideoArticleEnabled(env)) return { status: 'disabled' };
      const tweetId = parseXStatusId(raw?.tweetId || raw?.url || raw);
      if (!tweetId) return { status: 'invalid' };
      const existing = repository.articleForTweet(workspaceId, tweetId);
      if (existing?.status === 'ready' && existing.articleStatus === 'ready') {
        return { status: 'ready', tweetId, videoId: existing.videoId };
      }
      const videoId = existing?.videoId || `tweet:${tweetId}`;
      repository.savePost({
        workspaceId,
        tweetId,
        videoId,
        contentItemId: existing?.contentItemId || '',
        quotedTweetId: existing?.quotedTweetId || '',
        sourceUrl: existing?.sourceUrl || `https://x.com/i/status/${tweetId}`,
      });
      if (!existing?.videoId || existing.videoId === videoId) {
        repository.saveArticle({
          workspaceId,
          videoId,
          status: existing?.status && existing.status !== 'skipped' ? existing.status : 'probe',
          manual: 1,
          durationSec: existing?.durationSec,
          sourceTranscript: existing?.sourceTranscript,
          sourceHash: existing?.sourceHash,
          articleStatus: existing?.articleStatus,
          articleState: existing?.articleState,
          articleBody: existing?.articleBody,
          articleTitle: existing?.articleTitle,
          articleDay: existing?.articleDay,
          attempts: existing?.attempts,
          reason: '',
        });
      } else {
        repository.saveArticle({ workspaceId, videoId: existing.videoId, manual: 1 });
      }
      const open = (store.listOpenJobs?.(X_VIDEO_ARTICLE_JOB_TYPE) || [])
        .find((job) => String(job.input?.tweetId || '') === tweetId);
      if (open) return { status: 'queued', tweetId, jobId: open.id };
      const job = store.createJob({
        type: X_VIDEO_ARTICLE_JOB_TYPE,
        workspaceId,
        maxAttempts: 1,
        input: { workspaceId, tweetId, manual: true },
      });
      return { status: 'queued', tweetId, jobId: job.id, dailyLimit: youtubeArticleDailyLimit(env) };
    },

    holdState(row) {
      return readState(row?.articleState);
    },
  };
}
