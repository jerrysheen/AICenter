import { formatYmd, nextDailyInstant, previousDailyInstant, zonedParts } from './zoned-time.js';
import {
  nextYoutubeArticleSlot,
  previousYoutubeArticleSlot,
  YOUTUBE_ARTICLE_CATCHUP_MINUTE,
  youtubeArticleEnabled,
  youtubeArticleEveryHours,
  youtubePodcastClock,
  youtubePodcastsEnabled,
} from './youtube-podcasts.js';

export const X_VIDEO_ARTICLE_JOB_TYPE = 'x.videos.article';

function boundedInt(value, fallback, min, max) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// 默认打开。首页时间线里超过门槛的 X 视频会进入和 YouTube 共用的整理队列。
// 设为 0 / false / off / no 才关闭。没配这个变量时视为打开。
export function xVideoArticleEnabled(env = process.env) {
  const raw = env.AI_CENTER_X_VIDEO_ARTICLE;
  if (raw == null || String(raw).trim() === '') return true;
  const value = String(raw).trim().toLowerCase();
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return false;
  return value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

export function xVideoArticleMinSec(env = process.env) {
  return boundedInt(env.AI_CENTER_X_VIDEO_ARTICLE_MINUTES, 15, 1, 180) * 60;
}

// 和 YouTube 共用每天的整理名额。这里再加一个 X 自己的上限，避免首页一下子涌进很多长视频，把播客队列挤掉。
export function xVideoArticleDailyLimit(env = process.env) {
  return boundedInt(env.AI_CENTER_X_VIDEO_ARTICLE_DAILY, 1, 0, 4);
}

export function xVideoArticleSlots({
  sharedLimit,
  xLimit,
  youtubeUsed = 0,
  xUsed = 0,
  manual = false,
} = {}) {
  const shared = Math.max(0, Number(sharedLimit) - Number(youtubeUsed) - Number(xUsed));
  if (manual) return shared;
  const own = Math.max(0, Number(xLimit) - Number(xUsed));
  return Math.min(shared, own);
}

export function parseXStatusId(value) {
  const text = String(value || '').trim();
  if (/^\d{5,25}$/.test(text)) return text;
  const match = text.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?:[^/?#]+\/status|i\/status)\/(\d{5,25})/i);
  return match ? match[1] : '';
}

export function xVideoCaptureMetadata(item) {
  const video = item?.xVideo;
  if (!video || typeof video !== 'object' || Array.isArray(video)) return null;
  const tweetId = parseXStatusId(video.tweetId || item.externalId);
  if (!tweetId) return null;
  const quoteTweetId = parseXStatusId(video.quoteTweetId);
  const own = video.own === true || video.own === 1;
  if (!own && !quoteTweetId) return null;
  return {
    tweetId,
    own,
    quoteTweetId: quoteTweetId || '',
  };
}

export function stampTranscriptSegments(segments) {
  const rows = Array.isArray(segments) ? segments : [];
  return rows.map((segment) => {
    const text = String(segment?.text || '').trim();
    if (!text) return '';
    const clock = formatTranscriptClock(segment.startMs);
    return text.split('\n').map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (/^\[\d{2}:\d{2}:\d{2}\]/.test(trimmed)) return trimmed;
      return `[${clock}] ${trimmed}`;
    }).filter(Boolean).join('\n');
  }).filter(Boolean).join('\n');
}

export function formatTranscriptClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const hour = Math.floor(total / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  return [hour, minute, second].map((part) => String(part).padStart(2, '0')).join(':');
}

export function shanghaiArticleDay(now, timeZone = 'Asia/Shanghai') {
  return formatYmd(zonedParts(now, timeZone));
}

export function nextSharedArticleOpportunity(afterMs, env = process.env) {
  if (!xVideoArticleEnabled(env) && !youtubeArticleEnabled(env)) return null;
  const clock = youtubePodcastClock(env);
  const times = [nextYoutubeArticleSlot(afterMs, {
    timeZone: clock.timeZone,
    everyHours: youtubeArticleEveryHours(env),
    minute: YOUTUBE_ARTICLE_CATCHUP_MINUTE,
  })];
  if (youtubePodcastsEnabled(env)) times.push(nextDailyInstant(afterMs, clock));
  return Math.min(...times);
}

export function previousSharedArticleOpportunity(atMs, env = process.env) {
  if (!xVideoArticleEnabled(env) && !youtubeArticleEnabled(env)) return null;
  const clock = youtubePodcastClock(env);
  const times = [];
  const slot = previousYoutubeArticleSlot(atMs, {
    timeZone: clock.timeZone,
    everyHours: youtubeArticleEveryHours(env),
    minute: YOUTUBE_ARTICLE_CATCHUP_MINUTE,
  });
  if (slot != null) times.push(slot);
  if (youtubePodcastsEnabled(env)) times.push(previousDailyInstant(atMs, clock));
  return times.length ? Math.max(...times) : null;
}
