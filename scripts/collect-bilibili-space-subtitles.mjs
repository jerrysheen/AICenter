import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredBrowserRuntime, parseBrowserJson } from '../packages/connectors/src/browser/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { chooseAiZhSubtitle, subtitleBodyToText } from '../packages/connectors/src/bilibili/subtitle.js';
import { getJson } from '../packages/connectors/src/bilibili/http.js';
import { resolveBilibiliSpaceTarget } from './lib/bilibili-space-target.mjs';

const { hostMid: HOST_MID, spaceUrl: SPACE_URL } = resolveBilibiliSpaceTarget();
const TERMINAL = new Set(['ai-zh', 'no-subs', 'other-subs', 'missing', 'blocked']);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot });
const outputDir = path.join(instance.runtimeDirectory, 'bilibili-up', HOST_MID);
const subtitleDir = path.join(outputDir, 'subtitles');
const paths = {
  videos: path.join(outputDir, 'videos.json'),
  manifest: path.join(outputDir, 'manifest.json'),
  progress: path.join(outputDir, 'subtitle-progress.json'),
};

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function listTracks(subtitles) {
  return (subtitles || []).map((item) => ({
    lang: item.lan || '',
    label: item.lan_doc || '',
    isAi: String(item.lan || '').startsWith('ai-'),
  }));
}

function normalizeSubtitleUrl(url) {
  const value = String(url || '');
  if (!value) return '';
  return value.startsWith('//') ? `https:${value}` : value;
}

function summarize(videos) {
  const items = videos.items || [];
  const pending = items.filter((item) => !TERMINAL.has(item.subtitleStatus)).length;
  const withAiZh = items.filter((item) => item.subtitleStatus === 'ai-zh').length;
  const withoutAiZh = items.filter((item) => item.subtitleStatus === 'no-subs' || item.subtitleStatus === 'other-subs').length;
  const missing = items.filter((item) => item.subtitleStatus === 'missing' || item.subtitleStatus === 'blocked').length;
  const errors = items.filter((item) => item.subtitleStatus === 'error').length;
  let status = 'not_started';
  if (items.length && pending === 0 && errors === 0) status = 'complete';
  else if (pending < items.length || withAiZh || withoutAiZh || missing) status = 'partial';
  return { status, pending, withAiZh, withoutAiZh, missing, errors, total: items.length };
}

function persist(videos, extra = {}) {
  writeJson(paths.videos, videos);
  const manifest = readJson(paths.manifest, {});
  const summary = summarize(videos);
  manifest.updatedAt = new Date().toISOString();
  manifest.tasks = manifest.tasks || {};
  manifest.tasks.subtitles = {
    ...summary,
    recovery: 'every own video has subtitleStatus in ai-zh | no-subs | other-subs | missing | blocked',
  };
  writeJson(paths.manifest, manifest);
  writeJson(paths.progress, {
    ...summary,
    updatedAt: manifest.updatedAt,
    lastBvid: extra.lastBvid || '',
    lastStatus: extra.lastStatus || '',
    lastError: extra.lastError || '',
    running: extra.running !== false,
  });
  return summary;
}

async function fetchSubtitleBody(url, session) {
  try {
    return await getJson(url);
  } catch {
    return parseBrowserJson(await session.fetchJson(url));
  }
}

async function collectOne(session, item) {
  const result = {
    bvid: item.bvid,
    title: item.title || '',
    owner: item.author || '',
    cid: 0,
    pages: [],
    tracks: [],
    hasAiZh: false,
    subtitleStatus: 'error',
    fullText: '',
    charCount: 0,
    error: '',
  };

  const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(item.bvid)}`);
  if (view.code !== 0) {
    result.subtitleStatus = view.code === -404 || /稿件不存在|已删除|不可见/.test(String(view.message || ''))
      ? 'missing'
      : 'error';
    result.error = view.message || `view code ${view.code}`;
    return result;
  }

  const data = view.data || {};
  result.title = data.title || result.title;
  result.owner = data.owner?.name || result.owner;
  const pages = Array.isArray(data.pages) && data.pages.length
    ? data.pages
    : [{ cid: data.cid, page: 1, part: data.title || '' }];
  result.cid = Number(data.cid || pages[0]?.cid || 0);

  const pageTexts = [];
  for (const page of pages) {
    const cid = Number(page.cid || 0);
    if (!cid) continue;
    const player = parseBrowserJson(await session.fetchJson(
      `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(item.bvid)}&cid=${encodeURIComponent(cid)}`,
    ));
    if (player.code !== 0) {
      result.pages.push({ cid, page: page.page, part: page.part || '', status: 'error', error: player.message || `player ${player.code}` });
      continue;
    }
    const tracks = player.data?.subtitle?.subtitles || [];
    result.tracks = listTracks(tracks);
    const chosen = chooseAiZhSubtitle(tracks);
    if (!chosen) {
      result.pages.push({
        cid,
        page: page.page,
        part: page.part || '',
        status: tracks.length ? 'other-subs' : 'no-subs',
        tracks: listTracks(tracks),
      });
      continue;
    }
    const subtitleUrl = normalizeSubtitleUrl(chosen.subtitle_url);
    const body = await fetchSubtitleBody(subtitleUrl, session);
    const text = subtitleBodyToText(body.body);
    result.pages.push({
      cid,
      page: page.page,
      part: page.part || '',
      status: text ? 'ai-zh' : 'no-subs',
      tracks: listTracks(tracks),
      charCount: text.length,
    });
    if (text) pageTexts.push(pages.length > 1 ? `P${page.page} ${page.part || ''}\n${text}` : text);
    await delay(200);
  }

  result.fullText = pageTexts.join('\n\n').trim();
  result.charCount = result.fullText.length;
  result.hasAiZh = result.pages.some((page) => page.status === 'ai-zh');
  if (result.hasAiZh) result.subtitleStatus = 'ai-zh';
  else if (result.pages.some((page) => page.status === 'other-subs')) result.subtitleStatus = 'other-subs';
  else if (result.pages.length) result.subtitleStatus = 'no-subs';
  else {
    result.subtitleStatus = 'error';
    result.error = result.error || 'player returned no pages';
  }
  return result;
}

const limit = Math.max(0, Number(argument('--limit', '0')) || 0);
const fresh = flag('--fresh');
mkdirSync(subtitleDir, { recursive: true });

const videos = readJson(paths.videos, null);
if (!videos?.items?.length) {
  console.error('[subs] 没有 videos.json，先跑 scripts/collect-bilibili-space-dynamics.mjs');
  process.exit(1);
}

if (fresh) {
  for (const item of videos.items) {
    item.subtitleStatus = 'pending';
    item.hasAiZh = null;
    item.tracks = [];
    item.error = '';
    item.subtitlePath = '';
  }
}

const queue = videos.items.filter((item) => !TERMINAL.has(item.subtitleStatus));
const selected = limit > 0 ? queue.slice(0, limit) : queue;
persist(videos, { running: true });
console.log('[subs] start', JSON.stringify({ total: videos.items.length, queued: selected.length, skipped: videos.items.length - queue.length }));

if (!selected.length) {
  const summary = persist(videos, { running: false });
  console.log('[subs] already complete', JSON.stringify(summary));
  process.exit(0);
}

const runtime = createConfiguredBrowserRuntime({ defaultBrowserId: instance.browserId });
const health = await runtime.health();
console.log('[subs] health', JSON.stringify(health));
if (!health.available) {
  persist(videos, { running: false, lastError: 'browser unavailable' });
  console.error('[subs] BrowserSkill 未连接。');
  process.exit(1);
}

let fatal = null;
await runtime.withSession({ purpose: 'bilibili.space-subtitles', focused: false }, async (session) => {
  await session.navigate(SPACE_URL, { timeoutMs: 45_000 });
  await delay(1_500);
  const loggedIn = await session.evaluate(`(() => document.cookie.split(';').some((part) => part.trim().startsWith('DedeUserID=')))()`);
  console.log('[subs] loggedIn', Boolean(loggedIn));
  if (!loggedIn) throw new Error('未检测到登录态');

  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index];
    let result;
    try {
      result = await collectOne(session, item);
    } catch (error) {
      result = {
        bvid: item.bvid,
        title: item.title,
        subtitleStatus: 'error',
        hasAiZh: false,
        tracks: [],
        error: error instanceof Error ? error.message : String(error),
        fullText: '',
        charCount: 0,
        pages: [],
      };
    }

    item.subtitleStatus = result.subtitleStatus;
    item.hasAiZh = result.hasAiZh;
    item.tracks = result.tracks;
    item.error = result.error || '';
    item.cid = result.cid || 0;
    item.title = result.title || item.title;
    if (result.subtitleStatus === 'ai-zh' && result.fullText) {
      const fileName = `${item.bvid}.json`;
      writeJson(path.join(subtitleDir, fileName), {
        bvid: item.bvid,
        title: result.title,
        owner: result.owner,
        onlyFans: Boolean(item.onlyFans),
        cid: result.cid,
        tracks: result.tracks,
        pages: result.pages,
        charCount: result.charCount,
        fullText: result.fullText,
      });
      item.subtitlePath = `subtitles/${fileName}`;
    }

    const summary = persist(videos, {
      running: true,
      lastBvid: item.bvid,
      lastStatus: result.subtitleStatus,
      lastError: result.error || '',
    });
    console.log('[subs]', JSON.stringify({
      index: index + 1,
      of: selected.length,
      bvid: item.bvid,
      status: result.subtitleStatus,
      chars: result.charCount || 0,
      ...summary,
    }));

    if (/风控|验证码|412|403|352/.test(result.error || '')) {
      fatal = result.error;
      break;
    }
    await delay(350);
  }
});

const summary = persist(videos, { running: false, lastError: fatal || '' });
console.log('[subs] done', JSON.stringify({ ...summary, fatal }, null, 2));
if (fatal || summary.pending > 0 || summary.errors > 0) process.exitCode = 2;
