import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredBrowserRuntime, parseBrowserJson } from '../packages/connectors/src/browser/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { chooseAiZhSubtitle } from '../packages/connectors/src/bilibili/subtitle.js';
import { getJson } from '../packages/connectors/src/bilibili/http.js';
import { resolveBilibiliSpaceTarget } from './lib/bilibili-space-target.mjs';

const { hostMid: HOST_MID } = resolveBilibiliSpaceTarget();
const FEATURES = 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,decorationCard,forwardListHidden,ugcDelete,onlyfansQaCard';
const TERMINAL = new Set(['ai-zh', 'no-subs', 'other-subs', 'missing', 'blocked']);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot });
const outputDir = path.join(instance.runtimeDirectory, 'bilibili-up', HOST_MID);
const subtitleDir = path.join(outputDir, 'subtitles');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
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

function fail(failures, name, detail) {
  failures.push({ name, detail });
}

const checkpoint = readJson(path.join(outputDir, 'checkpoint.json'));
const manifest = readJson(path.join(outputDir, 'manifest.json'));
const videos = readJson(path.join(outputDir, 'videos.json'));
const records = readFileSync(path.join(outputDir, 'dynamics.jsonl'), 'utf8')
  .split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));

const ids = records.map((item) => item.id);
const idSet = new Set(ids);
const dupes = ids.filter((id, index) => ids.indexOf(id) !== index);
const decorativeTypes = new Set(['DYNAMIC_TYPE_COMMON_SQUARE']);
const emptyCore = records.filter((item) => {
  if (decorativeTypes.has(item.type)) return false;
  return !item.id || (!item.text && !item.title && !item.bvid && !item.orig && !(item.pics || []).length);
});
const ownBvids = [...new Set(records.filter((item) => item.bvid).map((item) => item.bvid))];
const byPub = [...records].sort((a, b) => b.pubTs - a.pubTs);
const local = {
  jsonlCount: records.length,
  checkpointCount: checkpoint.itemCount,
  checkpointIds: (checkpoint.ids || []).length,
  uniqueIds: idSet.size,
  dupes: [...new Set(dupes)],
  emptyCore: emptyCore.length,
  types: records.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {}),
  onlyFans: records.filter((item) => item.onlyFans).length,
  blocked: records.filter((item) => item.blocked).length,
  ownBvids: ownBvids.length,
  videoItems: (videos.items || []).length,
  forwardedItems: (videos.forwarded || []).length,
  newestByPub: { id: byPub[0]?.id, pubTs: byPub[0]?.pubTs, title: String(byPub[0]?.title || byPub[0]?.text || '').slice(0, 40) },
  oldestByPub: { id: byPub.at(-1)?.id, pubTs: byPub.at(-1)?.pubTs, title: String(byPub.at(-1)?.title || byPub.at(-1)?.text || '').slice(0, 40) },
  pinned: records.filter((item) => item.isTop).length,
};

const subtitleFiles = (videos.items || []).map((item) => {
  const filePath = item.subtitlePath ? path.join(outputDir, item.subtitlePath) : path.join(subtitleDir, `${item.bvid}.json`);
  const exists = existsSync(filePath);
  let chars = 0;
  let ok = false;
  if (exists) {
    const body = readJson(filePath);
    chars = Number(body.charCount || String(body.fullText || '').length);
    ok = Boolean(body.fullText) && body.bvid === item.bvid;
  }
  return {
    bvid: item.bvid,
    status: item.subtitleStatus,
    hasAiZh: item.hasAiZh,
    fileExists: exists,
    fileOk: ok,
    chars,
    bytes: exists ? statSync(filePath).size : 0,
  };
});

const aiZh = subtitleFiles.filter((item) => item.status === 'ai-zh');
const noFile = aiZh.filter((item) => !item.fileExists || !item.fileOk);
const pending = (videos.items || []).filter((item) => !TERMINAL.has(item.subtitleStatus));
const extraFilesShouldNot = subtitleFiles.filter((item) => item.status !== 'ai-zh' && item.fileExists);

const failures = [];
if (!checkpoint.complete || checkpoint.hasMore !== false) fail(failures, 'dynamics.checkpoint', 'checkpoint 未标 complete 或 hasMore 仍为 true');
if (records.length !== checkpoint.itemCount) fail(failures, 'dynamics.count', `jsonl=${records.length} checkpoint=${checkpoint.itemCount}`);
if (records.length === 0) fail(failures, 'dynamics.emptyDump', '没有动态记录');
if (idSet.size !== records.length) fail(failures, 'dynamics.unique', `unique=${idSet.size}`);
if (dupes.length) fail(failures, 'dynamics.dupes', dupes.join(','));
if (emptyCore.length) fail(failures, 'dynamics.empty', `${emptyCore.length} 条没有正文/标题/视频/图`);
if (local.ownBvids !== videos.ownFromDynamics) fail(failures, 'videos.own', `jsonl own=${local.ownBvids} videos.json=${videos.ownFromDynamics}`);
if ((videos.items || []).length !== local.ownBvids) fail(failures, 'videos.items', `${(videos.items || []).length}`);
if (pending.length) fail(failures, 'subs.pending', pending.map((item) => item.bvid).join(','));
if (aiZh.length !== (videos.items || []).filter((item) => item.subtitleStatus === 'ai-zh').length) fail(failures, 'subs.aiZhCount', `${aiZh.length}`);
if (noFile.length) fail(failures, 'subs.missingFiles', noFile.map((item) => item.bvid).join(','));
if (extraFilesShouldNot.length) fail(failures, 'subs.extraFiles', extraFilesShouldNot.map((item) => item.bvid).join(','));
if (manifest.tasks?.subtitles?.status !== 'complete') fail(failures, 'manifest.subtitles', manifest.tasks?.subtitles?.status);

const live = { skipped: true };
const runtime = createConfiguredBrowserRuntime({ defaultBrowserId: instance.browserId });
const health = await runtime.health();
if (!health.available) {
  fail(failures, 'live.browser', 'BrowserSkill 未连接，无法做接口复验');
} else {
  live.skipped = false;
  await runtime.withSession({ purpose: 'bilibili.space-audit', focused: false }, async (session) => {
    await session.navigate(`https://space.bilibili.com/${HOST_MID}/dynamic`, { timeoutMs: 45_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    let first;
    try {
      first = parseBrowserJson(await session.fetchJson(spaceFeedUrl('')));
    } catch (error) {
      fail(failures, 'live.first', error instanceof Error ? error.message : String(error));
      live.first = { error: error instanceof Error ? error.message : String(error) };
      return;
    }
    const firstItems = first?.data?.items || [];
    const firstIds = firstItems.map((item) => String(item.id_str || item.id || ''));
    const missingFirst = firstIds.filter((id) => id && !idSet.has(id));
    live.first = {
      code: first?.code,
      count: firstItems.length,
      hasMore: first?.data?.has_more,
      missingFromDump: missingFirst,
      onlyFansVisible: firstItems.filter((item) => item.basic?.is_only_fans).length,
    };
    if (first?.code !== 0) fail(failures, 'live.first', first?.message || `code ${first?.code}`);
    if (missingFirst.length) fail(failures, 'live.firstMissing', `首页有 ${missingFirst.length} 条不在库里，可能漏抓或之后新发`);

    let offset = '';
    let pages = 0;
    let liveCount = 0;
    let lastHasMore = true;
    const seen = new Set();
    const pageCap = Math.max(250, Number(checkpoint.pageCount || 0) + 20);
    while (pages < pageCap && lastHasMore) {
      const payload = parseBrowserJson(await session.fetchJson(spaceFeedUrl(offset)));
      if (payload?.code !== 0) {
        fail(failures, 'live.page', payload?.message || `code ${payload?.code} page ${pages + 1}`);
        break;
      }
      const items = payload?.data?.items || [];
      for (const item of items) {
        const id = String(item.id_str || item.id || '');
        if (id && !seen.has(id)) {
          seen.add(id);
          liveCount += 1;
        }
      }
      pages += 1;
      lastHasMore = Boolean(payload?.data?.has_more);
      offset = String(payload?.data?.offset || '');
      if (!offset) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    live.full = { pages, liveCount, hasMore: lastHasMore, dumpCount: records.length, extraLive: [...seen].filter((id) => !idSet.has(id)).length, extraDump: [...idSet].filter((id) => !seen.has(id)).length };
    if (lastHasMore) fail(failures, 'live.hasMore', `复翻 ${pages} 页后仍 has_more`);
    if (liveCount !== records.length) fail(failures, 'live.countMismatch', `现场 ${liveCount} 条，落盘 ${records.length} 条`);

    const samples = [
      videos.items.find((item) => item.subtitleStatus === 'ai-zh'),
      videos.items.filter((item) => item.subtitleStatus === 'ai-zh').at(-1),
      videos.items.find((item) => item.subtitleStatus === 'no-subs' || item.subtitleStatus === 'other-subs'),
    ].filter(Boolean);
    live.subtitleSamples = [];
    for (const item of samples) {
      const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(item.bvid)}`);
      let playerHasAi = null;
      if (view.code === 0 && view.data?.cid) {
        const player = parseBrowserJson(await session.fetchJson(
          `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(item.bvid)}&cid=${encodeURIComponent(view.data.cid)}`,
        ));
        playerHasAi = Boolean(chooseAiZhSubtitle(player.data?.subtitle?.subtitles || []));
      }
      const sample = {
        bvid: item.bvid,
        recorded: item.subtitleStatus,
        viewCode: view.code,
        playerHasAi,
        match: item.subtitleStatus === 'ai-zh' ? playerHasAi === true : playerHasAi === false,
      };
      live.subtitleSamples.push(sample);
      if (sample.match === false) fail(failures, 'live.subtitleMismatch', `${item.bvid} dump=${item.subtitleStatus} playerHasAi=${playerHasAi}`);
    }
  });
}

const report = {
  ok: failures.length === 0,
  failures,
  local: {
    ...local,
    subtitleFiles: aiZh.length,
    subtitleBytes: subtitleFiles.reduce((sum, item) => sum + item.bytes, 0),
    subtitleChars: aiZh.reduce((sum, item) => sum + item.chars, 0),
    withoutAiZh: subtitleFiles.filter((item) => item.status === 'no-subs' || item.status === 'other-subs').length,
    noSubStatuses: subtitleFiles.filter((item) => item.status !== 'ai-zh').reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {}),
  },
  live,
};

writeFileSync(path.join(outputDir, 'audit-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
process.exitCode = failures.length ? 2 : 0;
