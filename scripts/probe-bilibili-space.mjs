import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredBrowserRuntime, parseBrowserJson } from '../packages/connectors/src/browser/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { chooseAiZhSubtitle } from '../packages/connectors/src/bilibili/subtitle.js';
import { getJson } from '../packages/connectors/src/bilibili/http.js';

const HOST_MID = '525121722';
const SPACE_URL = `https://space.bilibili.com/${HOST_MID}/dynamic`;
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

function compactText(value, limit = 80) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) || '(empty)';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function classifyDynamic(item) {
  const modules = item?.modules || {};
  const major = modules.module_dynamic?.major || {};
  const additional = modules.module_dynamic?.additional || {};
  const topic = modules.module_dynamic?.topic || {};
  const author = modules.module_author || {};
  const opus = major.opus || {};
  const archive = major.archive || {};
  const blocked = major.blocked || null;
  const badge = compactText(author.icon_badge?.text || '', 40);
  const onlyFans = item?.basic?.is_only_fans === true || badge === '充电专属';

  return {
    id: String(item?.id_str || item?.id || ''),
    type: String(item?.type || ''),
    visible: item?.visible !== false,
    majorType: String(major.type || ''),
    author: compactText(author.name, 40),
    pubTs: Number(author.pub_ts || 0),
    title: compactText(opus.title || archive.title || opus.summary?.text || '', 80),
    bvid: String(archive.bvid || ''),
    blocked: Boolean(blocked),
    blockedHint: compactText(blocked?.hint_message || blocked?.title || '', 80),
    onlyFans,
    chargeBadge: badge,
    additionalType: String(additional.type || ''),
    topic: compactText(topic.name || '', 40),
  };
}

function spaceInspectExpression() {
  return `(() => {
    const cookieNames = document.cookie.split(';').map((part) => part.trim().split('=')[0]).filter(Boolean);
    const text = document.body ? (document.body.innerText || '') : '';
    return {
      url: location.href,
      title: document.title || '',
      loggedIn: cookieNames.includes('DedeUserID')
        || Boolean(document.querySelector('.header-avatar-wrap') || document.querySelector('.bili-avatar')),
      hasDedeUserID: cookieNames.includes('DedeUserID'),
      cookieNames,
      chargeLocked: /充电专属|充电可见|开通充电/.test(text),
      cardCount: document.querySelectorAll('.bili-dyn-list__item, .bili-dyn-item, [class*="dyn-item"]').length,
    };
  })()`;
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

function listTracks(subtitles) {
  return (subtitles || []).map((item) => ({
    lang: item.lan || '',
    label: item.lan_doc || '',
    isAi: String(item.lan || '').startsWith('ai-'),
  }));
}

async function fetchInSession(session, url) {
  return parseBrowserJson(await session.fetchJson(url));
}

const maxPages = Math.max(1, Number(argument('--max-pages', '40')) || 40);
const subtitleSamples = Math.max(0, Number(argument('--subtitle-samples', '5')) || 5);
const writeFull = flag('--write-full');

const outputDir = path.join(instance.runtimeDirectory, 'bilibili-up', HOST_MID);
mkdirSync(outputDir, { recursive: true });

const runtime = createConfiguredBrowserRuntime({ defaultBrowserId: instance.browserId });
const health = await runtime.health();
console.log('[probe] health', JSON.stringify(health));
if (!health.available) {
  console.error('[probe] BrowserSkill 未连接。请在已登录 B 站的 Chrome 里打开扩展并连上 daemon。');
  process.exitCode = 1;
  process.exit();
}

const probe = await runtime.withSession(
  { purpose: 'bilibili.space-probe', focused: false },
  async (session) => {
    await session.navigate(SPACE_URL, { timeoutMs: 45_000 });
    await delay(2_500);
    const page = await session.evaluate(spaceInspectExpression());
    console.log('[probe] page', JSON.stringify({
      url: page?.url,
      title: page?.title,
      loggedIn: page?.loggedIn,
      hasDedeUserID: page?.hasDedeUserID,
      chargeLocked: page?.chargeLocked,
      cardCount: page?.cardCount,
    }));

    const pages = [];
    const classified = [];
    let offset = '';
    let hasMore = true;
    let firstError = null;

    for (let pageIndex = 0; pageIndex < maxPages && hasMore; pageIndex += 1) {
      const url = spaceFeedUrl(offset);
      let payload;
      try {
        payload = await fetchInSession(session, url);
      } catch (error) {
        firstError = error instanceof Error ? error.message : String(error);
        console.error(`[probe] feed page ${pageIndex + 1} fetch failed: ${firstError}`);
        break;
      }
      const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];
      const mapped = items.map(classifyDynamic);
      classified.push(...mapped);
      pages.push({
        pageIndex: pageIndex + 1,
        code: payload?.code,
        message: payload?.message || '',
        itemCount: items.length,
        hasMore: Boolean(payload?.data?.has_more),
        nextOffset: String(payload?.data?.offset || ''),
        types: countBy(mapped, (item) => item.type),
        majorTypes: countBy(mapped, (item) => item.majorType),
      });
      console.log('[probe] feed', JSON.stringify(pages[pages.length - 1]));
      if (payload?.code !== 0) {
        firstError = payload?.message || `feed code ${payload?.code}`;
        break;
      }
      hasMore = Boolean(payload?.data?.has_more);
      offset = String(payload?.data?.offset || '');
      if (!offset) break;
      await delay(400);
    }

    let navnum = null;
    try {
      navnum = await fetchInSession(session, `https://api.bilibili.com/x/space/navnum?mid=${HOST_MID}`);
    } catch (error) {
      navnum = { error: error instanceof Error ? error.message : String(error) };
    }

    const videoItems = classified.filter((item) => item.bvid);
    const uniqueBvids = [...new Set(videoItems.map((item) => item.bvid))];
    const subtitleResults = [];
    for (const bvid of uniqueBvids.slice(0, subtitleSamples)) {
      const sample = { bvid, title: '', owner: '', cid: 0, tracks: [], hasAiZh: false, status: 'error', error: '' };
      try {
        const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
        if (view.code !== 0) throw new Error(view.message || 'view failed');
        sample.title = compactText(view.data?.title, 80);
        sample.owner = compactText(view.data?.owner?.name, 40);
        sample.cid = Number(view.data?.cid || 0);
        if (!sample.cid) throw new Error('missing cid');
        const player = await fetchInSession(
          session,
          `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(sample.cid)}`,
        );
        if (player.code !== 0) throw new Error(player.message || 'player failed');
        const tracks = player.data?.subtitle?.subtitles || [];
        sample.tracks = listTracks(tracks);
        sample.hasAiZh = Boolean(chooseAiZhSubtitle(tracks));
        sample.status = sample.hasAiZh ? 'ai-zh' : (tracks.length ? 'other-subs' : 'no-subs');
      } catch (error) {
        sample.error = error instanceof Error ? error.message : String(error);
      }
      subtitleResults.push(sample);
      console.log('[probe] subtitle', JSON.stringify(sample));
      await delay(300);
    }

    return {
      page,
      firstError,
      pages,
      classified,
      subtitleResults,
      navnum,
    };
  },
);

const summary = {
  hostMid: HOST_MID,
  spaceUrl: SPACE_URL,
  fetchedAt: new Date().toISOString(),
  loggedIn: Boolean(probe.page?.loggedIn),
  pageTitle: probe.page?.title || '',
  feedError: probe.firstError,
  pageCount: probe.pages.length,
  itemCount: probe.classified.length,
  types: countBy(probe.classified, (item) => item.type),
  majorTypes: countBy(probe.classified, (item) => item.majorType),
  videosInFeed: probe.classified.filter((item) => item.bvid).length,
  uniqueVideos: new Set(probe.classified.map((item) => item.bvid).filter(Boolean)).size,
  onlyFansCount: probe.classified.filter((item) => item.onlyFans).length,
  publicPostCount: probe.classified.filter((item) => !item.onlyFans && !item.bvid).length,
  blockedCount: probe.classified.filter((item) => item.blocked).length,
  spaceCounts: {
    video: probe.navnum?.data?.video,
    dynamic: probe.navnum?.data?.dynamic,
    article: probe.navnum?.data?.article,
    navnumCode: probe.navnum?.code,
    navnumError: probe.navnum?.error || probe.navnum?.message,
  },
  subtitleSamples: probe.subtitleResults,
  items: probe.classified,
  pages: probe.pages,
};

const summaryPath = path.join(outputDir, 'probe-summary.json');
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
if (writeFull) {
  writeFileSync(path.join(outputDir, 'probe-raw-classified.json'), `${JSON.stringify(probe.classified, null, 2)}\n`, 'utf8');
}

console.log('[probe] summary', JSON.stringify({
  loggedIn: summary.loggedIn,
  itemCount: summary.itemCount,
  types: summary.types,
  majorTypes: summary.majorTypes,
  videosInFeed: summary.videosInFeed,
  uniqueVideos: summary.uniqueVideos,
  onlyFansCount: summary.onlyFansCount,
  publicPostCount: summary.publicPostCount,
  blockedCount: summary.blockedCount,
  spaceCounts: summary.spaceCounts,
  aiZh: summary.subtitleSamples.filter((item) => item.hasAiZh).length,
  summaryPath,
}, null, 2));
