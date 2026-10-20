import { statSync } from 'node:fs';
import { articleProgress, describeYoutubeArticle, youtubeArticleJobLive, YOUTUBE_ARTICLE_TOUCH_MS } from './youtube-article-status.js';
import { formatYmd, zonedParts } from './zoned-time.js';
import {
  loadYoutubePodcastConfig,
  nextYoutubeArticleOpportunity,
  nextZonedDayStart,
  previousYoutubeArticleOpportunity,
  watchUrl,
  YOUTUBE_ARTICLE_JOB_TYPE,
  YOUTUBE_PODCAST_JOB_TYPE,
  youtubePodcastClock,
  youtubePodcastsEnabled,
} from './youtube-podcasts.js';

const BLOCKED_HOLD = new Set(['daily-limit', 'failed', 'quota', 'login', 'page']);

function articleFacts(row) {
  if (row.articleState) return articleProgress(row.articleState);
  return {
    holdReason: row.holdReason || '',
    holdDay: row.holdDay || '',
    done: Number(row.partsDone) || 0,
    translated: Number(row.partsDone) || 0,
    organized: Number(row.partsOrganized) || 0,
    total: Number(row.partsTotal) || 0,
    summary: row.articleSummary || '',
    titleStatus: row.titleStatus || '',
    touchedAt: Number(row.touchedAt) || 0,
  };
}

function activeHold(facts, today) {
  const hold = String(facts.holdReason || '');
  if (hold === 'daily-limit' && facts.holdDay && facts.holdDay !== today) return '';
  return hold;
}

function articleSlotMissed(row, facts, hold, now, env) {
  if (String(row.articleStatus || '') === 'ready') return false;
  if (hold === 'daily-limit' || hold === 'failed' || hold === 'quota' || hold === 'upstream' || hold === 'deadline' || hold === 'login' || hold === 'page') return false;
  if ((Number(facts.done) || 0) > 0 && (Number(facts.total) || 0) > 0) return false;
  const ingested = Number(row.ingestedAt) || 0;
  if (!ingested) return false;
  const last = previousYoutubeArticleOpportunity(now, env);
  return Number.isFinite(last) && last >= ingested && now > last;
}

function articleJobsLive(store, now) {
  const jobs = [
    ...(store?.listOpenJobs?.(YOUTUBE_ARTICLE_JOB_TYPE) || []),
    ...(store?.listOpenJobs?.(YOUTUBE_PODCAST_JOB_TYPE) || []),
  ];
  return youtubeArticleJobLive(jobs, now);
}

function articleView(row, now, env, store) {
  const facts = articleFacts(row);
  const clock = youtubePodcastClock(env);
  const today = formatYmd(zonedParts(now, clock.timeZone));
  const hold = activeHold(facts, today);
  const blocked = facts.holdDay === today && BLOCKED_HOLD.has(facts.holdReason);
  const nextAt = row.articleStatus === 'ready'
    ? null
    : nextYoutubeArticleOpportunity(blocked ? nextZonedDayStart(now, clock.timeZone) - 1 : now, env);
  const touched = Number(facts.touchedAt) || 0;
  const active = articleJobsLive(store, now) && touched > 0 && Number(now) - touched <= YOUTUBE_ARTICLE_TOUCH_MS;
  return describeYoutubeArticle({
    articleStatus: row.articleStatus,
    holdReason: hold,
    done: facts.done,
    organized: facts.organized,
    total: facts.total,
    summary: facts.summary,
    titleStatus: facts.titleStatus,
    active,
    nextAt,
    overdue: articleSlotMissed(row, facts, hold, now, env),
    now,
    timeZone: clock.timeZone,
  });
}

function present(row, { withBody = false, now = Date.now(), env = process.env, store = null } = {}) {
  return {
    videoId: row.videoId,
    creatorId: row.creatorId,
    title: row.displayTitle || row.title,
    originalTitle: row.title,
    publishedAt: row.publishedAt,
    durationSec: row.durationSec,
    summary: row.summary || '',
    transcriptSource: row.transcriptSource || '',
    articleStatus: row.articleStatus || '',
    sourceUrl: row.sourceUrl || watchUrl(row.videoId),
    contentItemId: row.contentItemId || '',
    article: articleView(row, now, env, store),
    ...(withBody ? { body: row.body || '' } : {}),
  };
}

export function createYoutubePodcastService({ repository, store, configPath, env = process.env }) {
  let cache = { stamp: '', creators: [], error: '' };

  function readConfig() {
    let stamp = 'missing';
    try {
      stamp = String(statSync(configPath).mtimeMs);
    } catch {
      stamp = 'missing';
    }
    if (cache.stamp === stamp) return cache;
    try {
      cache = { stamp, creators: loadYoutubePodcastConfig(configPath).creators, error: '' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'YouTube 播客配置无法读取';
      console.error(`[youtube-podcasts] ${message}`);
      cache = { stamp, creators: [], error: '配置缺失' };
    }
    return cache;
  }

  return {
    list(workspaceId) {
      const config = readConfig();
      const rows = repository.listReady(workspaceId, 200);
      const configured = config.creators;
      const grouped = configured.map((creator) => ({
        id: creator.id,
        name: creator.name,
        focus: creator.focus,
        episodes: rows.filter((row) => row.creatorId === creator.id).map((row) => present(row, { env, store })),
      }));
      const known = new Set(configured.map((creator) => creator.id));
      for (const row of rows) {
        if (known.has(row.creatorId)) continue;
        known.add(row.creatorId);
        grouped.push({
          id: row.creatorId,
          name: row.authorName || row.creatorId,
          focus: '',
          episodes: rows.filter((item) => item.creatorId === row.creatorId).map((item) => present(item, { env, store })),
        });
      }
      return { enabled: youtubePodcastsEnabled(env), configError: config.error, creators: grouped };
    },

    get(workspaceId, videoId, now = Date.now()) {
      const row = repository.getReady(workspaceId, videoId);
      return row ? present(row, { withBody: true, now, env, store }) : null;
    },

    status(workspaceId, videoId, now = Date.now()) {
      const row = repository.getStatus(workspaceId, videoId);
      if (!row) return null;
      const view = present(row, { now, env, store });
      return { videoId: view.videoId, articleStatus: view.articleStatus, article: view.article };
    },

    enqueue(workspaceId) {
      if (!youtubePodcastsEnabled(env)) return { status: 'disabled' };
      const open = (store.listOpenJobs?.(YOUTUBE_PODCAST_JOB_TYPE) || [])[0];
      if (open) return { status: 'already-running', jobId: open.id };
      const job = store.createJob({
        type: YOUTUBE_PODCAST_JOB_TYPE,
        workspaceId,
        maxAttempts: 1,
        input: { workspaceId, manual: true },
      });
      return { status: 'queued', jobId: job.id };
    },
  };
}
