const SYNDICATION_HOST = 'cdn.syndication.twimg.com';
const MEDIA_HOST = 'video.twimg.com';

export function allowedMediaUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    if (url.hostname !== MEDIA_HOST) return false;
    return true;
  } catch {
    return false;
  }
}

export function xVideoIdFromUrl(value, fallbackTweetId = '') {
  const text = String(value || '');
  const indexed = text.match(/\/status\/(\d{5,25})\/video\/(\d+)/);
  if (indexed) return `${indexed[1]}:${indexed[2]}`;
  const status = text.match(/\/status\/(\d{5,25})/);
  if (status) return `${status[1]}:1`;
  if (/^\d{5,25}$/.test(String(fallbackTweetId || ''))) return `${fallbackTweetId}:1`;
  return '';
}

export function pickXVideoVariant(variants) {
  const rows = (Array.isArray(variants) ? variants : []).filter((item) => {
    const type = String(item?.content_type || item?.contentType || '').toLowerCase();
    return type === 'video/mp4' && allowedMediaUrl(item?.url);
  });
  rows.sort((left, right) => (Number(left.bitrate) || Number.MAX_SAFE_INTEGER) - (Number(right.bitrate) || Number.MAX_SAFE_INTEGER));
  const picked = rows[0];
  if (!picked) return null;
  return {
    url: String(picked.url),
    bitrate: Number(picked.bitrate) || 0,
  };
}

function mediaEntries(payload) {
  const details = Array.isArray(payload?.mediaDetails) ? payload.mediaDetails : [];
  const extended = payload?.extended_entities?.media || payload?.entities?.media || [];
  return [...details, ...(Array.isArray(extended) ? extended : [])];
}

function videoFromPayload(payload, fallbackTweetId) {
  let best = null;
  for (const media of mediaEntries(payload)) {
    const type = String(media?.type || '').toLowerCase();
    if (type && type !== 'video' && type !== 'animated_gif') continue;
    const info = media?.video_info || media?.videoInfo || {};
    const variant = pickXVideoVariant(info.variants);
    if (!variant) continue;
    const durationMs = Number(info.duration_millis ?? info.durationMillis) || 0;
    if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
    const expanded = media.expanded_url || media.expandedUrl || media.url || '';
    const videoId = xVideoIdFromUrl(expanded, fallbackTweetId);
    if (!videoId) continue;
    const candidate = { videoId, durationMs, variant, tweetId: String(fallbackTweetId || '') };
    if (!best || candidate.variant.bitrate < best.variant.bitrate) best = candidate;
  }
  return best;
}

function syndicationUser(payload) {
  const direct = payload?.user;
  if (direct && (direct.screen_name || direct.screenName || direct.name || direct.id_str || direct.id)) return direct;
  const result = payload?.core?.user_results?.result;
  if (!result || typeof result !== 'object') return {};
  const legacy = result.legacy && typeof result.legacy === 'object' ? result.legacy : {};
  const core = result.core && typeof result.core === 'object' ? result.core : {};
  return {
    id_str: result.rest_id || legacy.id_str || '',
    name: legacy.name || core.name || '',
    screen_name: legacy.screen_name || core.screen_name || '',
    profile_image_url_https: legacy.profile_image_url_https || '',
  };
}

function syndicationText(payload) {
  const note = payload?.note_tweet?.note_tweet_results?.result?.text || payload?.note_tweet?.text || '';
  return String(note || payload?.full_text || payload?.text || '').trim();
}

function syndicationCreatedAt(payload) {
  const parsed = payload?.created_at ? Date.parse(payload.created_at) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseSyndicationTweet(payload, fallbackTweetId = '') {
  const tweetId = String(payload?.id_str || payload?.id || fallbackTweetId || '').trim();
  const own = videoFromPayload(payload, tweetId || fallbackTweetId);
  const quoted = payload?.quoted_tweet || payload?.quotedTweet || null;
  const quoteId = String(quoted?.id_str || quoted?.id || '').trim();
  const quote = quoted ? videoFromPayload(quoted, quoteId) : null;
  const user = syndicationUser(payload);
  return {
    tweetId,
    text: syndicationText(payload),
    createdAt: syndicationCreatedAt(payload),
    author: {
      handle: String(user.screen_name || user.screenName || '').replace(/^@/, '').trim(),
      name: String(user.name || '').trim(),
      restId: String(user.id_str || user.id || '').trim(),
      avatar: String(user.profile_image_url_https || user.profile_image_url || '').trim(),
    },
    video: own,
    quote: quote ? { ...quote, tweetId: quoteId || quote.tweetId } : null,
  };
}

export function selectLongVideo(parsed, minSec) {
  const minMs = Math.max(1, Number(minSec) || 0) * 1000;
  if (parsed?.video && parsed.video.durationMs >= minMs) return { ...parsed.video, source: 'own' };
  if (parsed?.quote && parsed.quote.durationMs >= minMs) return { ...parsed.quote, source: 'quote' };
  if (parsed?.video || parsed?.quote) return { source: 'short', durationMs: parsed?.video?.durationMs || parsed?.quote?.durationMs || 0 };
  return { source: 'none', durationMs: 0 };
}

export function xVideoFromExtract(item) {
  const tweetId = String(item?.tweet_id || item?.tweetId || '').trim();
  if (!/^\d{5,25}$/.test(tweetId)) return null;
  const quoteTweetId = String(item?.quote_tweet_id || item?.quoteTweetId || '').trim();
  const quote = Boolean(item?.quote_has_video) && /^\d{5,25}$/.test(quoteTweetId);
  const own = item?.own_has_video === true || (item?.own_has_video == null && Boolean(item?.has_video));
  if (!own && !quote) return null;
  return {
    tweetId,
    own,
    quoteTweetId: quote ? quoteTweetId : '',
  };
}

function syndicationUrl(tweetId) {
  const id = String(tweetId || '').trim();
  if (!/^\d{5,25}$/.test(id)) throw new Error('帖子编号无效');
  const url = new URL('https://cdn.syndication.twimg.com/tweet-result');
  url.searchParams.set('id', id);
  url.searchParams.set('token', '0');
  return url;
}

export async function fetchXVideoMedia(tweetId, { fetch: fetchImpl = globalThis.fetch, signal } = {}) {
  const url = syndicationUrl(tweetId);
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal,
    headers: { accept: 'application/json' },
  });
  const finalUrl = new URL(response.url || url);
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== SYNDICATION_HOST) {
    throw new Error('视频信息来源不允许');
  }
  if (!response.ok) throw new Error(`视频信息读取失败 ${response.status}`);
  const payload = await response.json();
  return parseSyndicationTweet(payload, tweetId);
}
