import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredBrowserRuntime, parseBrowserJson } from '../packages/connectors/src/browser/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { resolveBilibiliSpaceTarget } from './lib/bilibili-space-target.mjs';

const { hostMid: HOST_MID, spaceUrl: SPACE_URL } = resolveBilibiliSpaceTarget();
const FEATURES = [
  'itemOpusStyle',
  'listOnlyfans',
  'opusBigCover',
  'onlyfansVote',
  'decorationCard',
  'forwardListHidden',
  'ugcDelete',
  'onlyfansQaCard',
].join(',');

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot });
const outputDir = path.join(instance.runtimeDirectory, 'bilibili-up', HOST_MID);
const paths = {
  checkpoint: path.join(outputDir, 'checkpoint.json'),
  dynamics: path.join(outputDir, 'dynamics.jsonl'),
  videos: path.join(outputDir, 'videos.json'),
  manifest: path.join(outputDir, 'manifest.json'),
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

function text(value) {
  return String(value || '').trim();
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) || '(empty)';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function extractPics(pics) {
  return (Array.isArray(pics) ? pics : []).map((pic) => ({
    url: text(pic.url || pic.src || ''),
    width: Number(pic.width || 0) || undefined,
    height: Number(pic.height || 0) || undefined,
  })).filter((pic) => pic.url);
}

function extractOpus(opus) {
  if (!opus || typeof opus !== 'object') return null;
  return {
    title: text(opus.title),
    text: text(opus.summary?.text),
    pics: extractPics(opus.pics),
    jumpUrl: text(opus.jump_url),
    paywall: opus.paywall || null,
  };
}

function extractArchive(archive) {
  if (!archive || typeof archive !== 'object') return null;
  return {
    bvid: text(archive.bvid),
    aid: text(archive.aid),
    title: text(archive.title),
    desc: text(archive.desc),
    duration: Number(archive.duration || 0) || undefined,
    cover: text(archive.cover),
  };
}

function extractRecord(item, options = {}) {
  const modules = item?.modules || {};
  const major = modules.module_dynamic?.major || {};
  const additional = modules.module_dynamic?.additional || {};
  const topic = modules.module_dynamic?.topic || {};
  const author = modules.module_author || {};
  const stat = modules.module_stat || {};
  const tag = modules.module_tag || {};
  const opus = extractOpus(major.opus);
  const archive = extractArchive(major.archive);
  const blocked = major.blocked || null;
  const badge = text(author.icon_badge?.text);
  const onlyFans = item?.basic?.is_only_fans === true || badge === '充电专属';
  const orig = !options.nested && item?.orig ? extractRecord(item.orig, { nested: true }) : undefined;

  return {
    id: text(item?.id_str || item?.id),
    type: text(item?.type),
    visible: item?.visible !== false,
    majorType: text(major.type),
    author: text(author.name),
    authorMid: text(author.mid),
    pubTs: Number(author.pub_ts || 0) || 0,
    isTop: Boolean(author.is_top) || text(tag.text) === '置顶',
    onlyFans,
    chargeBadge: badge,
    blocked: Boolean(blocked),
    blockedHint: text(blocked?.hint_message || blocked?.title),
    title: text(opus?.title || archive?.title),
    text: text(opus?.text || archive?.desc),
    pics: opus?.pics || extractPics(major.draw?.items),
    paywall: opus?.paywall || null,
    bvid: text(archive?.bvid),
    video: archive,
    topic: text(topic.name),
    additionalType: text(additional.type),
    stats: {
      like: Number(stat.like?.count || 0) || 0,
      comment: Number(stat.comment?.count || 0) || 0,
      forward: Number(stat.forward?.count || 0) || 0,
    },
    jumpUrl: text(opus?.jumpUrl),
    orig,
  };
}

function spaceInspectExpression() {
  return `(() => {
    const cookieNames = document.cookie.split(';').map((part) => part.trim().split('=')[0]).filter(Boolean);
    const bodyText = document.body ? (document.body.innerText || '') : '';
    return {
      url: location.href,
      title: document.title || '',
      loggedIn: cookieNames.includes('DedeUserID')
        || Boolean(document.querySelector('.header-avatar-wrap') || document.querySelector('.bili-avatar')),
      hasDedeUserID: cookieNames.includes('DedeUserID'),
      chargeLocked: /充电专属|充电可见|开通充电/.test(bodyText),
    };
  })()`;
}

async function fetchFeedPage(session, offset) {
  let last = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    last = parseBrowserJson(await session.fetchJson(spaceFeedUrl(offset)));
    const code = Number(last?.code);
    if (code === 0) return last;
    const retryable = code === -352 || code === -412 || code === -799;
    if (!retryable || attempt === 5) return last;
    const waitMs = 15_000 * (attempt + 1);
    console.log('[collect] backoff', JSON.stringify({ offset: String(offset || '').slice(0, 16), code, waitMs, attempt: attempt + 1 }));
    await delay(waitMs);
  }
  return last;
}

function spaceFeedUrl(offset = '') {
  const params = new URLSearchParams({
    offset: String(offset || ''),
    host_mid: HOST_MID,
    timezone_offset: '-480',
    platform: 'web',
    features: FEATURES,
    web_location: '333.1387',
  });
  return `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?${params}`;
}

function emptyCheckpoint() {
  return {
    hostMid: HOST_MID,
    offset: '',
    hasMore: true,
    complete: false,
    pageCount: 0,
    itemCount: 0,
    ids: [],
    error: null,
    updatedAt: null,
  };
}

function loadExistingRecords() {
  if (!existsSync(paths.dynamics)) return [];
  return readFileSync(paths.dynamics, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function pushVideo(map, bvid, extra) {
  if (!bvid || map.has(bvid)) return;
  map.set(bvid, {
    bvid,
    title: text(extra.title),
    fromDynamicId: text(extra.fromDynamicId),
    onlyFans: Boolean(extra.onlyFans),
    authorMid: text(extra.authorMid),
    author: text(extra.author),
    pubTs: Number(extra.pubTs || 0) || 0,
    source: extra.source,
    subtitleStatus: 'pending',
    hasAiZh: null,
    tracks: [],
  });
}

function buildVideoInventory(records, spaceVideoTotal) {
  const own = new Map();
  const forwarded = new Map();
  for (const record of records) {
    const ownBvid = text(record.bvid || record.video?.bvid);
    if (ownBvid) {
      pushVideo(own, ownBvid, {
        title: record.title || record.video?.title,
        fromDynamicId: record.id,
        onlyFans: record.onlyFans,
        authorMid: record.authorMid,
        author: record.author,
        pubTs: record.pubTs,
        source: 'own-dynamic',
      });
    }
    const forwardedBvid = text(record.orig?.bvid || record.orig?.video?.bvid);
    if (forwardedBvid && !own.has(forwardedBvid)) {
      pushVideo(forwarded, forwardedBvid, {
        title: record.orig?.title || record.orig?.video?.title,
        fromDynamicId: record.id,
        onlyFans: record.orig?.onlyFans,
        authorMid: record.orig?.authorMid,
        author: record.orig?.author,
        pubTs: record.orig?.pubTs || record.pubTs,
        source: 'forwarded',
      });
    }
  }
  const previous = readJson(paths.videos, {});
  const previousByBvid = new Map((previous.items || []).map((item) => [item.bvid, item]));
  const ownItems = [...own.values()].map((item) => {
    const old = previousByBvid.get(item.bvid);
    if (!old) return item;
    return {
      ...item,
      subtitleStatus: old.subtitleStatus || item.subtitleStatus,
      hasAiZh: old.hasAiZh,
      tracks: old.tracks || [],
      error: old.error || '',
      cid: old.cid || 0,
      subtitlePath: old.subtitlePath || '',
    };
  });
  return {
    ownFromDynamics: ownItems.length,
    forwardedFromDynamics: forwarded.size,
    spaceVideoTotal: Number(spaceVideoTotal || 0) || null,
    extraVsSpaceTab: Number(spaceVideoTotal || 0) > 0
      ? ownItems.length - Number(spaceVideoTotal)
      : null,
    items: ownItems,
    forwarded: [...forwarded.values()],
  };
}

const TERMINAL_SUBTITLE = new Set(['ai-zh', 'no-subs', 'other-subs', 'missing', 'blocked']);

function subtitleTaskFromVideos(items) {
  const list = Array.isArray(items) ? items : [];
  const pending = list.filter((item) => !TERMINAL_SUBTITLE.has(item.subtitleStatus)).length;
  const withAiZh = list.filter((item) => item.subtitleStatus === 'ai-zh').length;
  const withoutAiZh = list.filter((item) => item.subtitleStatus === 'no-subs' || item.subtitleStatus === 'other-subs').length;
  const missing = list.filter((item) => item.subtitleStatus === 'missing' || item.subtitleStatus === 'blocked').length;
  let status = 'not_started';
  if (pending === 0 && list.length) status = 'complete';
  else if (pending < list.length) status = 'partial';
  return {
    status,
    pending,
    withAiZh,
    withoutAiZh,
    missing,
    recovery: 'every own video has subtitleStatus in ai-zh | no-subs | other-subs | missing | blocked',
  };
}

function buildManifest(checkpoint, records, spaceCounts, page) {
  const videos = buildVideoInventory(records, spaceCounts?.video);
  const newest = records[0];
  const oldest = records[records.length - 1];
  const dynamicsComplete = Boolean(checkpoint.complete && !checkpoint.hasMore && !checkpoint.error);
  return {
    hostMid: HOST_MID,
    spaceUrl: SPACE_URL,
    updatedAt: new Date().toISOString(),
    loggedIn: Boolean(page?.loggedIn),
    spaceCounts,
    tasks: {
      dynamics: {
        status: dynamicsComplete ? 'complete' : (checkpoint.error ? 'error' : 'partial'),
        collected: records.length,
        pageCount: checkpoint.pageCount,
        hasMore: checkpoint.hasMore,
        complete: dynamicsComplete,
        newestId: newest?.id || '',
        oldestId: oldest?.id || '',
        newestAt: newest?.pubTs || 0,
        oldestAt: oldest?.pubTs || 0,
        types: countBy(records, (item) => item.type),
        onlyFansCount: records.filter((item) => item.onlyFans).length,
        blockedCount: records.filter((item) => item.blocked).length,
        recovery: 'has_more === false && collected > 0 && error == null',
      },
      videos: {
        status: videos.ownFromDynamics > 0 ? 'inventoried' : 'empty',
        ownFromDynamics: videos.ownFromDynamics,
        forwardedFromDynamics: videos.forwardedFromDynamics,
        spaceTotal: videos.spaceVideoTotal,
        extraVsSpaceTab: videos.extraVsSpaceTab,
        recovery: 'own unique bvid from DYNAMIC_TYPE_AV; space navnum.video is the current tab, not a superset',
      },
      subtitles: subtitleTaskFromVideos(videos.items),
    },
    paths: {
      checkpoint: paths.checkpoint,
      dynamics: paths.dynamics,
      videos: paths.videos,
      manifest: paths.manifest,
    },
  };
}

function persist(checkpoint, records, spaceCounts, page) {
  writeFileSync(
    paths.dynamics,
    `${records.map((record) => JSON.stringify(record)).join('\n')}${records.length ? '\n' : ''}`,
    'utf8',
  );
  writeJson(paths.checkpoint, checkpoint);
  const videos = buildVideoInventory(records, spaceCounts?.video);
  writeJson(paths.videos, videos);
  writeJson(paths.manifest, buildManifest(checkpoint, records, spaceCounts, page));
}

const maxPages = Math.max(1, Number(argument('--max-pages', '250')) || 250);
const fresh = flag('--fresh');
const rebuildOnly = flag('--rebuild-only');
mkdirSync(outputDir, { recursive: true });

let checkpoint = fresh ? emptyCheckpoint() : { ...emptyCheckpoint(), ...readJson(paths.checkpoint, {}) };
let records = fresh ? [] : loadExistingRecords();
const knownIds = new Set(records.map((record) => record.id).filter(Boolean));

if (rebuildOnly) {
  const existingManifest = readJson(paths.manifest, {});
  persist(checkpoint, records, existingManifest.spaceCounts || {}, { loggedIn: existingManifest.loggedIn });
  const manifest = readJson(paths.manifest, {});
  console.log('[collect] rebuilt', JSON.stringify({
    itemCount: records.length,
    dynamics: manifest.tasks?.dynamics,
    videos: manifest.tasks?.videos,
    subtitles: manifest.tasks?.subtitles,
  }, null, 2));
  process.exit(0);
}

if (checkpoint.complete && !fresh) {
  const manifest = readJson(paths.manifest, null);
  console.log('[collect] already complete', JSON.stringify({
    itemCount: records.length,
    pageCount: checkpoint.pageCount,
    manifest: manifest?.tasks?.dynamics,
  }, null, 2));
  process.exit(0);
}

const runtime = createConfiguredBrowserRuntime({ defaultBrowserId: instance.browserId });
const health = await runtime.health();
console.log('[collect] health', JSON.stringify(health));
if (!health.available) {
  console.error('[collect] BrowserSkill 未连接。请在已登录 B 站的 Chrome 里打开扩展并连上 daemon。');
  process.exitCode = 1;
  process.exit();
}

const sessionResult = await runtime.withSession(
  { purpose: 'bilibili.space-collect', focused: false },
  async (session) => {
    await session.navigate(SPACE_URL, { timeoutMs: 45_000 });
    await delay(2_000);
    const page = await session.evaluate(spaceInspectExpression());
    console.log('[collect] page', JSON.stringify({
      url: page?.url,
      loggedIn: page?.loggedIn,
      chargeLocked: page?.chargeLocked,
      resumeOffset: checkpoint.offset || '',
      existing: records.length,
    }));
    if (!page?.loggedIn) throw new Error('空间页未检测到登录态，停止采集以免把充电动态抓成空卡');

    let navnum = null;
    try {
      navnum = parseBrowserJson(await session.fetchJson(`https://api.bilibili.com/x/space/navnum?mid=${HOST_MID}`));
    } catch (error) {
      navnum = { error: error instanceof Error ? error.message : String(error) };
    }
    const spaceCounts = {
      video: navnum?.data?.video,
      article: navnum?.data?.article,
      navnumCode: navnum?.code,
      navnumError: navnum?.error || navnum?.message,
    };

    let offset = checkpoint.offset || '';
    let hasMore = checkpoint.hasMore !== false;
    let error = null;
    const startedPages = checkpoint.pageCount || 0;

    for (let step = 0; step < maxPages && hasMore; step += 1) {
      const pageIndex = startedPages + step + 1;
      let payload;
      try {
        payload = await fetchFeedPage(session, offset);
      } catch (fetchError) {
        error = fetchError instanceof Error ? fetchError.message : String(fetchError);
        console.error(`[collect] page ${pageIndex} failed: ${error}`);
        break;
      }
      if (payload?.code !== 0) {
        error = payload?.message || `feed code ${payload?.code}`;
        console.error(`[collect] page ${pageIndex} api: ${error}`);
        break;
      }
      const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];
      let added = 0;
      for (const item of items) {
        const record = extractRecord(item);
        if (!record.id || knownIds.has(record.id)) continue;
        knownIds.add(record.id);
        records.push(record);
        added += 1;
      }
      hasMore = Boolean(payload?.data?.has_more);
      offset = text(payload?.data?.offset);
      checkpoint = {
        hostMid: HOST_MID,
        offset,
        hasMore,
        complete: !hasMore,
        pageCount: pageIndex,
        itemCount: records.length,
        ids: records.map((record) => record.id),
        error: null,
        updatedAt: new Date().toISOString(),
      };
      persist(checkpoint, records, spaceCounts, page);
      console.log('[collect] page', JSON.stringify({
        pageIndex,
        added,
        itemCount: records.length,
        hasMore,
        types: countBy(items.map((item) => extractRecord(item)), (item) => item.type),
      }));
      if (!offset) {
        hasMore = false;
        checkpoint.hasMore = false;
        checkpoint.complete = true;
        persist(checkpoint, records, spaceCounts, page);
        break;
      }
      await delay(pageIndex >= 80 ? 1_200 : 500);
    }

    if (error) {
      checkpoint.error = error;
      checkpoint.complete = false;
      persist(checkpoint, records, spaceCounts, page);
    }
    return { page, spaceCounts, error };
  },
);

const manifest = readJson(paths.manifest, {});
console.log('[collect] done', JSON.stringify({
  complete: Boolean(checkpoint.complete),
  itemCount: records.length,
  pageCount: checkpoint.pageCount,
  hasMore: checkpoint.hasMore,
  error: sessionResult.error || checkpoint.error,
  dynamics: manifest.tasks?.dynamics,
  videos: manifest.tasks?.videos,
  subtitles: manifest.tasks?.subtitles,
  paths,
}, null, 2));
if (!checkpoint.complete) process.exitCode = 2;
