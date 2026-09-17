import { parseBrowserJson } from '../browser/browser-runtime.js';
import { isBrowserUnavailable } from '../browser/errors.js';
import { getJson, resolveRedirectUrl } from './http.js';

const AI_ZH_LANGS = new Set(['ai-zh', 'ai-zh-cn', 'ai-zhcn']);
const BODY_LIMIT = 1_900_000;

export function extractBvid(value) {
  const match = String(value || '').match(/BV[0-9A-Za-z]{10,12}/);
  return match ? match[0] : '';
}

export function extractBilibiliInput(value) {
  return String(value || '').replace(/^[\s\u3000【\[]+|[\s\u3000】\]]+$/g, '').trim();
}

export async function resolveBvid(value, options = {}) {
  const raw = extractBilibiliInput(value);
  const direct = extractBvid(raw);
  if (direct) return direct;
  const urlMatch = raw.match(/https?:\/\/[^\s]+/i);
  const candidate = urlMatch ? urlMatch[0] : raw;
  if (!/^https?:\/\/(?:b23\.tv|(?:www\.)?bilibili\.com)\b/i.test(candidate)) {
    throw new Error('请粘贴 B 站视频链接或 BV 号');
  }
  const resolveUrl = options.resolveRedirectUrl || resolveRedirectUrl;
  const resolved = await resolveUrl(candidate);
  const fromRedirect = extractBvid(resolved);
  if (fromRedirect) return fromRedirect;
  throw new Error('无法从链接解析出 BV 号');
}

export function chooseAiZhSubtitle(subtitles) {
  const tracks = Array.isArray(subtitles) ? subtitles : [];
  return tracks.find((item) => AI_ZH_LANGS.has(String(item.lan || '').trim().toLowerCase())) || null;
}

export function subtitleBodyToText(body) {
  const segments = Array.isArray(body) ? body : [];
  const lines = [];
  for (const segment of segments) {
    const text = String(segment.content || '').trim();
    if (text) lines.push(text);
  }
  return lines.join(' ').trim();
}

export function videoToFeedItem(video, options = {}) {
  const bvid = video.bvid;
  const body = String(video.fullText || '').slice(0, BODY_LIMIT);
  const title = video.title || bvid;
  return {
    id: `bilibili:${bvid}`,
    workspaceId: options.workspaceId || 'local',
    platform: 'bilibili',
    externalId: bvid,
    authorName: video.owner || '',
    authorHandle: '',
    title,
    summary: body.slice(0, 160),
    body,
    sourceUrl: video.url || `https://www.bilibili.com/video/${bvid}`,
    publishedAt: video.publishedAt || 0,
    processing: '',
    subscriptionId: '',
    captureId: '',
    originType: 'import',
    contentType: 'transcript',
  };
}

function listTracks(subtitles) {
  return (subtitles || []).map((item) => ({
    lang: item.lan || '',
    label: item.lan_doc || '',
    isAi: String(item.lan || '').startsWith('ai-'),
  }));
}

function createBrowserJsonFetcher(options = {}) {
  if (typeof options.fetchJsonInBilibiliBrowser === 'function') {
    return options.fetchJsonInBilibiliBrowser;
  }
  if (!options.browserRuntime?.withSession) {
    throw new Error('Bilibili 浏览器访问需要 browserRuntime');
  }
  return async (url, fetchOptions = {}) => {
    return options.browserRuntime.withSession(
      { purpose: 'bilibili.subtitle', focused: false },
      async (session) => {
        await session.navigate(fetchOptions.pageUrl || 'https://www.bilibili.com');
        return parseBrowserJson(await session.fetchJson(url));
      },
    );
  };
}

export async function fetchBilibiliAiSubtitle(urlOrBvid, options = {}) {
  const getJsonFn = options.getJson || getJson;
  const fetchInBrowser = createBrowserJsonFetcher(options);
  const bvid = await resolveBvid(urlOrBvid, options);
  const result = {
    bvid,
    title: '',
    owner: '',
    url: `https://www.bilibili.com/video/${bvid}`,
    publishedAt: 0,
    availableSubtitles: [],
    hasAiZh: false,
    fullText: '',
    status: 'error',
    errorType: null,
    error: null,
  };

  try {
    const view = await getJsonFn(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    if (view.code !== 0) throw new Error(view.message || 'B 站视频信息接口失败');
    const data = view.data || {};
    result.title = data.title || '';
    result.owner = data.owner?.name || '';
    result.publishedAt = Number(data.pubdate) ? Number(data.pubdate) * 1000 : 0;
    const cid = data.cid;
    if (!cid) throw new Error('视频缺少 cid，无法读取字幕');

    const playerUrl = `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`;
    let player;
    let browserError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        player = await fetchInBrowser(playerUrl, {
          pageUrl: result.url,
          settleMs: attempt === 0 ? 2_500 : 3_500,
        });
        browserError = null;
        break;
      } catch (error) {
        browserError = error instanceof Error ? error.message : String(error);
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    if (!player) {
      result.status = 'error';
      result.errorType = 'browser_unavailable';
      result.error = `无法通过已登录浏览器读取字幕：${browserError}`;
      return result;
    }
    if (player.code !== 0) {
      throw new Error(player.message || 'B 站播放器接口失败');
    }

    const subtitles = player.data?.subtitle?.subtitles || [];
    result.availableSubtitles = listTracks(subtitles);
    const chosen = chooseAiZhSubtitle(subtitles);
    result.hasAiZh = Boolean(chosen);
    if (!chosen) {
      result.status = 'subtitle_unavailable';
      result.errorType = 'subtitle_unavailable';
      result.error = '没有';
      return result;
    }

    const subtitleUrl = String(chosen.subtitle_url || '').startsWith('//')
      ? `https:${chosen.subtitle_url}`
      : chosen.subtitle_url;
    let subtitle;
    try {
      subtitle = await getJsonFn(subtitleUrl);
    } catch {
      subtitle = await fetchInBrowser(subtitleUrl, {
        pageUrl: result.url,
        settleMs: 800,
      });
    }
    result.fullText = subtitleBodyToText(subtitle.body);
    if (!result.fullText) {
      result.status = 'subtitle_unavailable';
      result.errorType = 'subtitle_empty';
      result.error = '没有';
      return result;
    }
    result.status = 'ok';
    result.errorType = null;
    result.error = null;
    return result;
  } catch (error) {
    result.status = 'error';
    result.errorType = isBrowserUnavailable(error) ? 'browser_unavailable' : 'network_or_api_error';
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}
