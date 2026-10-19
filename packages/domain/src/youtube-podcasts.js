import { readFileSync } from 'node:fs';

export const YOUTUBE_PODCAST_JOB_TYPE = 'youtube.podcasts.sync';
export const YOUTUBE_PODCAST_SCHEDULE_KEY = 'youtube.podcasts.sync';
export const YOUTUBE_MIN_DURATION_SEC = 20 * 60;
export const YOUTUBE_LOOKBACK = 2;
const DUB_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

const TITLE_NOISE = /\b(?:audio|video|podcast|full|episode|ep|english|dub|dubbed)\b|音频版|视频版|英文版|中文版|英文配音|配音版|完整版/gi;
const SHORT_TITLE = /(?:^|[\s#])shorts\b|切片|精彩片段|直播预告|预告片|\b(?:teaser|trailer)\b/i;
const DUB_TITLE = /英文配音|英文字幕版|english\s+(?:dub|version)|\[en\]|\(en\)/i;

export function youtubePodcastsEnabled(env = process.env) {
  const raw = String(env.AI_CENTER_YOUTUBE_PODCASTS || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

export function youtubePodcastClock(env = process.env) {
  const match = String(env.AI_CENTER_YOUTUBE_PODCASTS_AT || '07:00').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error('AI_CENTER_YOUTUBE_PODCASTS_AT 需要 HH:MM');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('AI_CENTER_YOUTUBE_PODCASTS_AT 需要 HH:MM');
  return {
    hour,
    minute,
    timeZone: String(env.AI_CENTER_YOUTUBE_PODCASTS_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
  };
}

function boundedInt(value, fallback, min, max) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function youtubePodcastLimits(env = process.env) {
  return {
    intervalMs: boundedInt(env.AI_CENTER_YOUTUBE_PODCASTS_INTERVAL_MS, 8_000, 1_000, 120_000),
    roundLimit: boundedInt(env.AI_CENTER_YOUTUBE_PODCASTS_ROUND_LIMIT, 24, 1, 80),
    transcribeSec: boundedInt(env.AI_CENTER_YOUTUBE_PODCASTS_TRANSCRIBE_MINUTES, 90, 1, 24 * 60) * 60,
    episodeTranscribeSec: boundedInt(env.AI_CENTER_YOUTUBE_PODCASTS_EPISODE_MINUTES, 180, 20, 6 * 60) * 60,
    roundMs: boundedInt(env.AI_CENTER_YOUTUBE_PODCASTS_MAX_RUNNING_MS, 3 * 60 * 60_000, 60_000, 6 * 60 * 60_000),
    lookback: boundedInt(env.AI_CENTER_YOUTUBE_PODCASTS_LOOKBACK, YOUTUBE_LOOKBACK, 1, 5),
  };
}

export function loadYoutubePodcastConfig(filePath) {
  if (!filePath) throw new Error('没有 YouTube 播客配置路径');
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`YouTube 播客配置不存在：${filePath}`);
    throw error;
  }
  const parsed = JSON.parse(raw);
  const creators = Array.isArray(parsed.creators) ? parsed.creators : [];
  if (!creators.length) throw new Error('YouTube 播客配置没有频道');
  return {
    minDurationSec: Number(parsed.minDurationSec) || YOUTUBE_MIN_DURATION_SEC,
    lookback: Number(parsed.lookback) || YOUTUBE_LOOKBACK,
    creators: creators.map((creator) => ({
      id: String(creator.id || '').trim(),
      name: String(creator.name || '').trim(),
      focus: String(creator.focus || '').trim(),
      prefer: creator.prefer === 'zh' ? 'zh' : '',
      channels: (creator.channels || []).map((channel) => ({
        key: String(channel.key || '').trim(),
        kind: channel.kind === 'playlist' ? 'playlist' : 'channel',
        role: channel.role === 'audio' ? 'audio' : channel.role === 'video' ? 'video' : '',
        playlistId: String(channel.playlistId || '').trim(),
        handle: String(channel.handle || '').replace(/^@/, '').trim(),
        url: String(channel.url || '').trim(),
      })),
    })),
  };
}

export function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function tagText(block, name) {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

export function parseYoutubeRss(xml) {
  const source = String(xml || '');
  const entries = [];
  for (const chunk of source.split(/<entry\b/i).slice(1)) {
    const block = chunk.split(/<\/entry>/i)[0] || '';
    const videoId = tagText(block, 'yt:videoId') || tagText(block, 'id').replace(/^yt:video:/, '');
    if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) continue;
    const published = Date.parse(tagText(block, 'published'));
    const href = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1]
      || `https://www.youtube.com/watch?v=${videoId}`;
    entries.push({
      videoId,
      title: tagText(block, 'title'),
      publishedAt: Number.isFinite(published) ? published : 0,
      url: decodeXml(href),
      authorName: tagText(block, 'name'),
    });
  }
  return entries.sort((left, right) => right.publishedAt - left.publishedAt || left.videoId.localeCompare(right.videoId));
}

export function rssUrlForChannel(channel, channelId = '') {
  if (channel.kind === 'playlist') {
    if (!channel.playlistId) throw new Error(`${channel.key} 缺少播放列表`);
    return `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(channel.playlistId)}`;
  }
  const id = String(channelId || '').trim();
  if (!id) throw new Error(`${channel.key} 缺少频道编号`);
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`;
}

export function readChannelId(html) {
  const source = String(html || '');
  const match = source.match(/"channelId":"(UC[\w-]{20,})"/)
    || source.match(/"externalId":"(UC[\w-]{20,})"/)
    || source.match(/channel_id=(UC[\w-]{20,})/);
  return match ? match[1] : '';
}

export function cjkRatio(value) {
  const chars = [...String(value || '')].filter((char) => /\S/u.test(char));
  if (!chars.length) return 0;
  const han = chars.filter((char) => /\p{Script=Han}/u.test(char)).length;
  return han / chars.length;
}

export function normalizeEpisodeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(TITLE_NOISE, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleSimilarity(left, right) {
  const a = normalizeEpisodeTitle(left);
  const b = normalizeEpisodeTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 8 && b.length >= 8 && (a.includes(b) || b.includes(a))) return 0.9;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b.slice(index, index + 2);
    const count = grams.get(gram) || 0;
    if (!count) continue;
    overlap += 1;
    grams.set(gram, count - 1);
  }
  return (2 * overlap) / (a.length + b.length - 2);
}

export function durationSimilar(left, right) {
  const a = Number(left) || 0;
  const b = Number(right) || 0;
  if (a <= 0 || b <= 0) return false;
  const diff = Math.abs(a - b);
  return diff <= 180 || diff / Math.max(a, b) <= 0.08;
}

export function sameEpisode(left, right) {
  return titleSimilarity(left.title, right.title) >= 0.82 && durationSimilar(left.durationSec, right.durationSec);
}

export function isShortOrPreview(episode, minDurationSec = YOUTUBE_MIN_DURATION_SEC) {
  const title = String(episode.title || '');
  const status = String(episode.liveStatus || '');
  if (['is_live', 'is_upcoming', 'post_live'].includes(status)) return 'live-preview';
  if (/直播预告|即将直播/i.test(title)) return 'live-preview';
  if (SHORT_TITLE.test(title)) return 'short';
  if (/\/shorts\//.test(String(episode.url || ''))) return 'short';
  const duration = Number(episode.durationSec);
  if (!Number.isFinite(duration) || duration < minDurationSec) return 'short';
  return '';
}

function dubbedAgainst(episode, peers) {
  if (DUB_TITLE.test(episode.title || '')) return true;
  if (cjkRatio(episode.title) >= 0.2) return false;
  return peers.some((peer) => peer.videoId !== episode.videoId
    && cjkRatio(peer.title) >= 0.3
    && durationSimilar(episode.durationSec, peer.durationSec)
    && Math.abs((episode.publishedAt || 0) - (peer.publishedAt || 0)) <= DUB_WINDOW_MS);
}

function preferRank(episode) {
  const role = episode.role === 'video' ? 2 : episode.role === 'audio' ? 0 : 1;
  return role * 10 + cjkRatio(episode.title);
}

export function selectPodcastEpisodes({
  creator,
  incoming = [],
  existing = [],
  minDurationSec = YOUTUBE_MIN_DURATION_SEC,
}) {
  const skip = [];
  const filtered = [];
  const seen = new Set();
  for (const episode of incoming) {
    if (!episode?.videoId || seen.has(episode.videoId)) {
      if (episode?.videoId) skip.push({ ...episode, reason: 'duplicate-id' });
      continue;
    }
    seen.add(episode.videoId);
    const stored = existing.find((row) => row.videoId === episode.videoId && ['ready', 'skipped'].includes(row.status));
    if (stored) {
      skip.push({ ...episode, reason: 'duplicate-id' });
      continue;
    }
    const reason = isShortOrPreview(episode, minDurationSec);
    if (reason) {
      skip.push({ ...episode, reason });
      continue;
    }
    filtered.push(episode);
  }
  const pool = [
    ...existing.filter((row) => row.status === 'ready' || (row.status === 'skipped' && row.reason === 'duplicate-episode')),
    ...filtered,
  ];
  const rejected = new Set();
  if (creator?.prefer === 'zh') {
    for (const episode of filtered) {
      if (cjkRatio(episode.title) < 0.2 && (DUB_TITLE.test(episode.title || '') || dubbedAgainst(episode, pool))) {
        rejected.add(episode.videoId);
        skip.push({ ...episode, reason: 'dubbed' });
      }
    }
  }
  const remain = filtered.filter((episode) => !rejected.has(episode.videoId));
  const anchors = existing.filter((row) => row.status === 'ready');
  const keep = [];
  for (const episode of remain) {
    const prior = [...anchors, ...keep].find((row) => sameEpisode(row, episode));
    if (!prior) {
      keep.push(episode);
      continue;
    }
    if (preferRank(episode) > preferRank(prior) + 0.5 && keep.includes(prior)) {
      keep.splice(keep.indexOf(prior), 1);
      skip.push({ ...prior, reason: 'duplicate-episode' });
      keep.push(episode);
      continue;
    }
    skip.push({ ...episode, reason: 'duplicate-episode' });
  }
  return { keep, skip };
}

export function firstRunSlice(entries, lookback = YOUTUBE_LOOKBACK) {
  const sorted = [...entries].sort((left, right) => right.publishedAt - left.publishedAt);
  const probeCount = Math.max(1, lookback) + 6;
  return {
    probe: sorted.slice(0, probeCount),
    ignore: sorted.slice(probeCount),
  };
}

export function limitFirstRun(kept, lookback = YOUTUBE_LOOKBACK) {
  const sorted = [...kept].sort((left, right) => right.publishedAt - left.publishedAt);
  return {
    keep: sorted.slice(0, lookback),
    extra: sorted.slice(lookback).map((episode) => ({ ...episode, reason: 'lookback' })),
  };
}

export function formatPodcastSummary(raw, { focus = '' } = {}) {
  const points = (Array.isArray(raw?.points) ? raw.points : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const guests = (Array.isArray(raw?.guests) ? raw.guests : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const companies = (Array.isArray(raw?.companies) ? raw.companies : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const quotes = (Array.isArray(raw?.quotes) ? raw.quotes : [])
    .map((item) => ({
      time: String(item?.time || item?.timestamp || '').trim(),
      text: String(item?.text || '').trim(),
    }))
    .filter((item) => item.text)
    .slice(0, 8);
  const relation = String(raw?.relation || '').trim();
  const lines = [];
  if (guests.length) lines.push(`嘉宾：${guests.join('、')}`);
  if (points.length) {
    lines.push('', '核心观点：');
    points.forEach((point, index) => lines.push(`${index + 1}. ${point}`));
  }
  lines.push('', `提到的公司或股票：${companies.length ? companies.join('、') : '未提及'}`);
  lines.push('', `与关注方向的关系：${relation || (focus ? `和${focus}相关，文字稿里没有更具体的对应。` : '文字稿里没有单独说明。')}`);
  if (quotes.length) {
    lines.push('', '关键句：');
    for (const quote of quotes) lines.push(`- ${quote.time ? `${quote.time} ` : ''}${quote.text}`);
  }
  return lines.join('\n').trim().slice(0, 20_000);
}

export function summaryNeedsChinese(text) {
  return cjkRatio(text) < 0.15 || (String(text || '').match(/\p{Script=Han}/gu) || []).length < 12;
}

export function parsePodcastSummary(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('摘要不是 JSON 对象');
  const points = Array.isArray(parsed.points) ? parsed.points.filter((item) => String(item || '').trim()) : [];
  if (!points.length) throw new Error('摘要没有核心观点');
  return parsed;
}

export function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}
