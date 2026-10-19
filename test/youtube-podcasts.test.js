import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../packages/database/src/index.js';
import { buildWav } from '../packages/domain/src/audio-transcription.js';
import { executeAudioTranscription } from '../packages/runtime/src/audio-transcription-job.js';
import { latestSchemaVersion, unusedSchemaVersions } from '../packages/database/src/migrations.js';
import { createTreeMaterialPort } from '../packages/domain/src/information-tree-materials.js';
import {
  firstRunSlice,
  formatPodcastSummary,
  isShortOrPreview,
  loadYoutubePodcastConfig,
  mergePodcastEntries,
  parseYoutubeRss,
  selectBackfillEntries,
  selectPodcastEpisodes,
  youtubePodcastsEnabled,
} from '../packages/domain/src/youtube-podcasts.js';
import { createAuthorService } from '../packages/domain/src/author-service.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { createYoutubePodcastService } from '../packages/domain/src/youtube-podcasts-service.js';
import { youtubePodcastClock, youtubePodcastLimits, youtubeRoundDeadlineMs } from '../packages/domain/src/youtube-podcasts.js';
import { createResearchRecallService } from '../packages/domain/src/research-recall-service.js';
import {
  fetchYoutubeText,
  listChannelLongVideos,
  probeYoutubeEpisode,
  resolveYoutubeChannelId,
  runProcess,
  transcribeYoutubeAudio,
  chooseSubtitle,
  pickSubtitleRequest,
  finishAudioFile,
  vttToTranscript,
  youtubeBlockReason,
  youtubeErrorText,
  ytDlpVersionAtLeast,
  YOUTUBE_STDERR_CAP,
  YOUTUBE_STDOUT_CAP,
} from '../packages/connectors/src/youtube-podcasts.js';
import {
  createYoutubePodcastJobHandlers,
  defaultFetchRss,
  ensureYoutubePodcastSchedule,
  runYoutubePodcastRound,
  YOUTUBE_PODCAST_JOB_TYPE,
} from '../packages/runtime/src/youtube-podcasts-job.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config', 'youtube-podcasts.json');

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <entry>
    <yt:videoId>aaaaaaaaaaa</yt:videoId>
    <title><![CDATA[Odd Lots &amp; Rates]]></title>
    <published>2026-10-18T00:00:00Z</published>
    <link rel="alternate" href="https://www.youtube.com/watch?v=aaaaaaaaaaa"/>
    <author><name>Bloomberg Podcasts</name></author>
  </entry>
  <entry>
    <yt:videoId>bbbbbbbbbbb</yt:videoId>
    <title>Older episode</title>
    <published>2026-10-01T00:00:00Z</published>
    <link rel="alternate" href="https://www.youtube.com/watch?v=bbbbbbbbbbb"/>
  </entry>
</feed>`;

const SUMMARY = {
  titleZh: '利率和仓位',
  guests: ['嘉宾甲'],
  points: ['观点一', '观点二', '观点三', '观点四', '观点五'],
  companies: ['NVDA'],
  relation: '和金融相关',
  quotes: [{ time: '00:12:03', text: '关键句' }],
};

function openStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youtube-podcasts-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    store,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function creatorConfig(extra = {}) {
  return {
    minDurationSec: 1200,
    lookback: 2,
    creators: [
      {
        id: 'odd-lots',
        name: 'Odd Lots',
        focus: '金融',
        channels: [{ key: 'odd-lots', kind: 'playlist', playlistId: 'PLtest', url: 'https://www.youtube.com/playlist?list=PLtest' }],
      },
      ...(extra.creators || []),
    ],
  };
}

function entry(videoId, title = 'A long conversation about rates') {
  return {
    videoId,
    title,
    publishedAt: Date.parse('2026-10-18T00:00:00Z'),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    channelKey: 'odd-lots',
  };
}

test('youtube podcast config and rss parse use a file url path', () => {
  assert.equal(configPath.includes(`${path.sep}config${path.sep}youtube-podcasts.json`), true);
  assert.doesNotMatch(configPath, /^[A-Za-z]:\\[A-Za-z]:\\/);
  const config = loadYoutubePodcastConfig(configPath);
  assert.equal(config.creators.length, 12);
  assert.equal(config.creators[0].channels[0].kind, 'playlist');
  assert.equal(config.creators[0].channels[0].playlistId, 'PLe4PRejZgr0OJbRzA6nWybYiThLJd_ouz');
  const valley = config.creators.find((item) => item.id === 'valley101');
  assert.equal(valley.channels.length, 2);
  assert.deepEqual(valley.channels.map((channel) => channel.language), ['zh', 'zh']);
  const xiaojun = config.creators.find((item) => item.id === 'xiaojun');
  assert.equal(xiaojun.prefer, 'zh');
  assert.equal(xiaojun.channels[0].language, 'zh');
  assert.equal(config.creators.find((item) => item.id === 'no-priors').channels[0].language, 'en');
  assert.equal(config.creators.find((item) => item.id === 'dwarkesh').channels[0].channelId, 'UCZa18YV7qayTh-MRIrBhDpA');
  assert.equal(valley.channels[0].channelId, 'UChnNjLyx_5rk_iDPQ2BQDQA');
  assert.equal(valley.channels[1].channelId, 'UCKV2yWPB3wn0RTZh3cTD8YA');
  const dalao = config.creators.find((item) => item.id === 'dalao-lens');
  assert.equal(dalao.name, '大佬透镜');
  assert.equal(dalao.channels[0].channelId, 'UCF68DQIdjJUDT7Ydlo0Awbw');
  assert.equal(dalao.channels[0].language, 'zh');
  assert.equal(config.creators.filter((creator) => creator.id !== 'odd-lots').every((creator) => creator.channels.every((channel) => /^UC[\w-]{20,}$/.test(channel.channelId))), true);
  const entries = parseYoutubeRss(RSS);
  assert.equal(entries[0].videoId, 'aaaaaaaaaaa');
  assert.equal(entries[0].title, 'Odd Lots & Rates');
  assert.equal(entries[0].publishedAt, Date.parse('2026-10-18T00:00:00Z'));
  assert.equal(entries[1].videoId, 'bbbbbbbbbbb');
  const slice = firstRunSlice(entries, 2);
  assert.equal(slice.probe[0].videoId, 'aaaaaaaaaaa');
  assert.equal(slice.ignore.length, 0);
});

test('duration, shorts and live previews are filtered', () => {
  assert.equal(isShortOrPreview({ title: 'Full talk', durationSec: 19 * 60 }, 1200), 'short');
  assert.equal(isShortOrPreview({ title: 'Full talk', durationSec: 25 * 60 }, 1200), '');
  assert.equal(isShortOrPreview({ title: 'Market #shorts', durationSec: 40 * 60, url: 'https://www.youtube.com/shorts/abc' }, 1200), 'short');
  assert.equal(isShortOrPreview({ title: '切片：三分钟看完', durationSec: 30 * 60 }, 1200), 'short');
  assert.equal(isShortOrPreview({ title: 'Live soon', durationSec: 40 * 60, liveStatus: 'is_upcoming' }, 1200), 'live-preview');
  assert.equal(isShortOrPreview({ title: '直播预告', durationSec: 40 * 60 }, 1200), 'live-preview');
  assert.equal(isShortOrPreview({ title: 'Was live', durationSec: 50 * 60, liveStatus: 'was_live' }, 1200), '');
});

test('dedupes video and audio, dubbed copies, and video ids', () => {
  const macro = selectPodcastEpisodes({
    creator: { id: 'macrovoices', prefer: '' },
    incoming: [
      { videoId: 'macrovideo01', title: 'Weekly Episode: Inflation', durationSec: 3600, publishedAt: 2, channelKey: 'macrovoices', role: 'video' },
      { videoId: 'macroaudio01', title: 'Weekly Episode: Inflation (Audio)', durationSec: 3500, publishedAt: 1, channelKey: 'macrovoices', role: 'audio' },
    ],
    minDurationSec: 1200,
  });
  assert.deepEqual(macro.keep.map((item) => item.videoId), ['macrovideo01']);
  assert.equal(macro.skip.some((item) => item.videoId === 'macroaudio01' && item.reason === 'duplicate-episode'), true);

  const valley = selectPodcastEpisodes({
    creator: { id: 'valley101', prefer: '' },
    incoming: [
      { videoId: 'valleyaudio1', title: '硅谷101 音频版 英伟达', durationSec: 4000, publishedAt: 2, channelKey: 'valley101-audio', role: 'audio' },
      { videoId: 'valleyvideo1', title: '硅谷101 视频版 英伟达', durationSec: 4100, publishedAt: 2, channelKey: 'valley101-video', role: 'video' },
    ],
    minDurationSec: 1200,
  });
  assert.deepEqual(valley.keep.map((item) => item.videoId), ['valleyvideo1']);

  const dubbed = selectPodcastEpisodes({
    creator: { id: 'xiaojun', prefer: 'zh' },
    incoming: [
      { videoId: 'zhepisode01', title: '张小玺对谈创始人', durationSec: 5000, publishedAt: 10, channelKey: 'xiaojun' },
      { videoId: 'enepisode01', title: 'English Dub Founder Interview', durationSec: 4900, publishedAt: 11, channelKey: 'xiaojun' },
    ],
    minDurationSec: 1200,
  });
  assert.deepEqual(dubbed.keep.map((item) => item.videoId), ['zhepisode01']);
  assert.equal(dubbed.skip.some((item) => item.reason === 'dubbed'), true);

  const global = selectPodcastEpisodes({
    creator: { id: 'odd-lots' },
    incoming: [{ videoId: 'samevideo001', title: 'Rates', durationSec: 2000, publishedAt: 3, channelKey: 'odd-lots' }],
    existing: [{ videoId: 'samevideo001', title: 'Rates', durationSec: 2000, status: 'ready', publishedAt: 3 }],
    minDurationSec: 1200,
  });
  assert.equal(global.keep.length, 0);
  assert.equal(global.skip[0].reason, 'duplicate-id');
});

test('subtitles skip transcription and missing subtitles call it', async () => {
  const opened = openStore();
  try {
    let transcribed = 0;
    const result = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => { throw new Error('中文摘要不应再翻译'); },
      fetchRss: async () => ({ entries: [entry('subvideo0001')] }),
      probe: async () => ({ durationSec: 1800, liveStatus: 'not_live', transcript: '[00:12:03] 原文', transcriptSource: 'subtitle-manual' }),
      transcribe: async () => { transcribed += 1; return '不应调用'; },
      summarize: async () => SUMMARY,
    });
    assert.equal(result.subtitles, 1);
    assert.equal(result.transcribed, 0);
    assert.equal(transcribed, 0);
    assert.equal(result.discovered, 1);
    const saved = opened.store.repositories.youtubePodcasts.getReady('local', 'subvideo0001');
    assert.equal(saved.transcriptSource, 'subtitle-manual');
    assert.match(saved.summary, /嘉宾：嘉宾甲/);
    assert.match(saved.summary, /NVDA/);
    assert.match(saved.summary, /00:12:03/);
    assert.match(saved.body, /原文/);
    const capture = opened.store.repositories.feed.getCapture('local', 'youtube', 'subvideo0001');
    assert.equal(capture.provider, 'youtube');
    assert.equal(capture.metadata.transcriptSource, 'subtitle-manual');
    assert.equal(capture.publishedAt, Date.parse('2026-10-18T00:00:00Z'));
    const author = opened.store.repositories.authors.getAuthor('local', 'youtube:odd-lots');
    assert.equal(author.name, 'Odd Lots');
    const page = opened.store.repositories.feed.listContentItemsInWindow('local', {
      startAt: 0, endAt: Date.now() + 60_000, metadataOnly: true, timeBasis: 'ingested',
    });
    assert.equal(page.some((row) => row.provider === 'youtube'), false);
    const hourly = await createTreeMaterialPort({
      feedService: { listContentItemsInWindow: () => page },
    }).candidates('local', { startAt: 0, endAt: Date.now() + 60_000 });
    assert.equal(hourly.some((row) => row.provider === 'youtube'), false);

    let secondProbe = 0;
    await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: [entry('subvideo0001'), entry('nosubvideo01', 'Another long interview')] }),
      probe: async (item) => {
        secondProbe += 1;
        assert.equal(item.videoId, 'nosubvideo01');
        return { durationSec: 2400, liveStatus: 'not_live', transcript: '', transcriptSource: '' };
      },
      transcribe: async () => { transcribed += 1; return '[00:01:00] 转写正文'; },
      summarize: async () => SUMMARY,
    });
    assert.equal(secondProbe, 1);
    assert.equal(transcribed, 1);
    const audio = opened.store.repositories.youtubePodcasts.getReady('local', 'nosubvideo01');
    assert.equal(audio.transcriptSource, 'gemini-transcribe');
    assert.match(audio.body, /转写正文/);
  } finally {
    opened.close();
  }
});

test('bot check and http 429 stop the round', async () => {
  for (const blocked of ['bot-check', '429']) {
    const opened = openStore();
    try {
      let rss = 0;
      let probes = 0;
      const config = creatorConfig({
        creators: [{
          id: 'all-in',
          name: 'All-In',
          focus: '科技',
          channels: [{ key: 'all-in', kind: 'playlist', playlistId: 'PLnext', url: 'https://www.youtube.com/playlist?list=PLnext' }],
        }],
      });
      const result = await runYoutubePodcastRound({
        env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
        config,
        repository: opened.store.repositories.youtubePodcasts,
        feedRepository: opened.store.repositories.feed,
        workspaceId: 'local',
        sleep: async () => {},
        translate: async () => '',
        fetchRss: async () => {
          rss += 1;
          return { entries: [entry(rss === 1 ? 'firstvideo01' : 'secondvide02')] };
        },
        probe: async () => {
          probes += 1;
          return { blocked };
        },
        transcribe: async () => 'no',
        summarize: async () => SUMMARY,
      });
      assert.equal(result.stopped, blocked);
      assert.equal(rss, 1);
      assert.equal(probes, 1);
      assert.equal(result.discovered, 0);
      assert.equal(opened.store.repositories.youtubePodcasts.getReady('local', 'firstvideo01'), null);
    } finally {
      opened.close();
    }
  }
  assert.equal(youtubeBlockReason('Sign in to confirm you\'re not a bot'), 'bot-check');
  assert.equal(youtubeBlockReason('HTTP Error 429: Too Many Requests'), '429');
});

test('the master switch skips the round and the schedule', async () => {
  const opened = openStore();
  try {
    let called = 0;
    const result = await runYoutubePodcastRound({
      env: {},
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      fetchRss: async () => { called += 1; return { entries: [] }; },
      probe: async () => { called += 1; return {}; },
    });
    assert.equal(result.status, 'disabled');
    assert.equal(called, 0);
    assert.equal(youtubePodcastsEnabled({}), false);
    assert.equal(youtubePodcastsEnabled({ AI_CENTER_YOUTUBE_PODCASTS: '1' }), true);
    const saved = [];
    ensureYoutubePodcastSchedule({
      upsertJobSchedule(input) {
        saved.push(input);
        return input;
      },
    }, {});
    assert.equal(saved[0].enabled, false);
    assert.equal(saved[0].schedule.hour, 7);
    assert.equal(saved[0].schedule.timezone, 'Asia/Shanghai');
  } finally {
    opened.close();
  }
});

test('audio is deleted after transcription and vtt prefers manual original captions', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youtube-audio-'));
  const file = path.join(directory, 'clip.wav');
  writeFileSync(file, 'wav');
  let seen = false;
  const text = await finishAudioFile(file, async (target) => {
    seen = true;
    assert.equal(target, file);
    return '转写';
  });
  assert.equal(text, '转写');
  assert.equal(seen, true);
  assert.equal(await import('node:fs').then((fs) => fs.existsSync(file)), false);
  rmSync(directory, { recursive: true, force: true });
  const transcript = vttToTranscript('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n00:00:12.000 --> 00:00:14.000\nWorld\n');
  assert.match(transcript, /\[00:00:12\] World/);
  const chosen = chooseSubtitle([
    { name: 'id.en.vtt', text: 'manual english' },
    { name: 'id.en.auto.vtt', text: 'auto english' },
  ], { language: 'en', subtitles: { en: [{}] }, automatic_captions: { en: [{}] } });
  assert.equal(chosen.source, 'subtitle-manual');
  assert.equal(chosen.text, 'manual english');
  const auto = chooseSubtitle([
    { name: 'id.zh-Hans.auto.vtt', text: '自动中文' },
    { name: 'id.en.auto.vtt', text: 'auto translated' },
  ], { language: 'zh-Hans', subtitles: {}, automatic_captions: { 'zh-Hans': [{}], en: [{}] } });
  assert.equal(auto.source, 'subtitle-auto');
  assert.equal(auto.text, '自动中文');
  const originalAuto = chooseSubtitle([
    { name: 'id.zh-Hans.auto.vtt', text: '翻译字幕' },
    { name: 'id.ar-orig.auto.vtt', text: 'arabic' },
    { name: 'id.en.auto.vtt', text: 'english auto' },
    { name: 'id.en-orig.auto.vtt', text: 'original speech' },
  ], { language: 'en-US', subtitles: {}, automatic_captions: { 'zh-Hans': [{}], 'ar-orig': [{}], en: [{}], 'en-orig': [{}] } });
  assert.equal(originalAuto.source, 'subtitle-auto');
  assert.equal(originalAuto.text, 'original speech');
  const chineseManual = chooseSubtitle([
    { name: 'id.en-orig.auto.vtt', text: 'english auto' },
    { name: 'id.zh.vtt', text: '中文原版' },
  ], { language: 'zh-CN', subtitles: { zh: [{}] }, automatic_captions: { 'en-orig': [{}] } });
  assert.equal(chineseManual.source, 'subtitle-manual');
  assert.equal(chineseManual.text, '中文原版');
  const translatedOnly = chooseSubtitle([
    { name: 'id.zh-Hans.auto.vtt', text: '翻译字幕' },
    { name: 'id.en-orig.auto.vtt', text: 'original speech' },
    { name: 'id.ar-orig.auto.vtt', text: 'arabic' },
  ], { language: '', subtitles: {}, automatic_captions: { 'zh-Hans': [{}], 'en-orig': [{}], 'ar-orig': [{}] } });
  assert.equal(translatedOnly.text, '');
  const onlyOrig = chooseSubtitle([
    { name: 'id.zh-Hans.auto.vtt', text: '翻译字幕' },
    { name: 'id.en-orig.auto.vtt', text: 'original speech' },
  ], { language: '', subtitles: {}, automatic_captions: { 'zh-Hans': [{}], 'en-orig': [{}] } });
  assert.equal(onlyOrig.source, 'subtitle-auto');
  assert.equal(onlyOrig.text, 'original speech');
  assert.deepEqual(pickSubtitleRequest({
    language: '',
    subtitles: {},
    automatic_captions: { 'zh-Hans': [{}], ja: [{}], 'en-orig': [{}] },
  }), { lang: 'en-orig', kind: 'auto' });
  assert.equal(pickSubtitleRequest({
    language: '',
    automatic_captions: { 'en-orig': [{}], 'ar-orig': [{}] },
  }), null);
  assert.deepEqual(pickSubtitleRequest({
    language: 'en-US',
    subtitles: {},
    automatic_captions: { 'zh-Hans': [{}], ja: [{}], 'ar-orig': [{}], 'bn-orig': [{}], 'en-orig': [{}] },
  }), { lang: 'en-orig', kind: 'auto' });
  assert.deepEqual(pickSubtitleRequest({
    language: 'zh-Hans',
    subtitles: { zh: [{}], en: [{}] },
    automatic_captions: { 'zh-Hans': [{}], 'en-orig': [{}] },
  }, 'zh'), { lang: 'zh', kind: 'manual' });
  assert.deepEqual(pickSubtitleRequest({
    language: '',
    subtitles: { zh: [{}] },
    automatic_captions: { 'zh-Hans': [{}], ja: [{}] },
  }, 'zh'), { lang: 'zh', kind: 'manual' });
  assert.match(formatPodcastSummary(SUMMARY, { focus: '金融' }), /与关注方向的关系：和金融相关/);
  assert.equal(latestSchemaVersion(), 91);
  assert.deepEqual(unusedSchemaVersions, [63, 79, 80, 82]);
  assert.equal(youtubePodcastLimits({}).roundMs, 3 * 60 * 60_000);
  assert.equal(youtubePodcastLimits({}).episodeTranscribeSec, 180 * 60);
  assert.throws(
    () => loadYoutubePodcastConfig(path.join(os.tmpdir(), 'missing-youtube-podcasts.json')),
    /YouTube 播客配置不存在/,
  );
});

test('a description that mentions 429 does not stop the round', async () => {
  const opened = openStore();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youtube-desc-429-'));
  try {
    const info = {
      id: 'desc429vid01',
      title: 'The $429 billion balance sheet',
      description: 'Holdings were $429 billion. HTTP 429 is only a number here.',
      duration: 1800,
      language: 'en',
      live_status: 'not_live',
    };
    let requested = [];
    const probed = await probeYoutubeEpisode({
      videoId: 'desc429vid01',
      url: 'https://evil.example/watch?v=desc429vid01',
      workDir: path.join(directory, 'probe'),
      run: async (_command, args) => {
        requested = args;
        writeFileSync(path.join(directory, 'probe', 'desc429vid01.info.json'), JSON.stringify(info));
        return {
          code: 0,
          stdout: JSON.stringify(info),
          stderr: 'about: $429 billion\ntoo many requests appears in the description',
          missing: false,
        };
      },
    });
    assert.equal(requested.includes('--dump-single-json'), false);
    assert.equal(requested.includes('--skip-download'), true);
    assert.equal(requested.includes('--write-subs'), false);
    assert.equal(requested.includes('--write-auto-subs'), false);
    assert.equal(requested.includes('--sub-langs'), false);
    assert.equal(requested.includes('--write-info-json'), true);
    assert.equal(/zh-Hans|zh-Hant|\bja\b|\.\*-orig/.test(requested.join('\n')), false);
    assert.equal(probed.blocked, undefined);
    assert.equal(probed.durationSec, 1800);
    assert.equal(requested.at(-1), 'https://www.youtube.com/watch?v=desc429vid01');
    assert.equal(requested.at(-2), '--');
    assert.equal(requested.includes('https://evil.example/watch?v=desc429vid01'), false);
    assert.equal(requested.includes(`node:${process.execPath}`), true);
    assert.equal(requested.some((arg) => arg.endsWith('%(ext)s')), true);
    assert.equal(youtubeErrorText('about: $429 billion\nERROR: HTTP Error 429: Too Many Requests'), 'ERROR: HTTP Error 429: Too Many Requests');

    const quietFailure = await probeYoutubeEpisode({
      videoId: 'desc429vid01',
      workDir: path.join(directory, 'quiet'),
      run: async () => ({
        code: 1,
        stdout: JSON.stringify({ description: '$429 billion' }),
        stderr: 'WARNING: $429 billion\n下载失败',
        missing: false,
      }),
    });
    assert.equal(quietFailure.blocked, undefined);
    assert.equal(quietFailure.failed, true);

    const realBlock = await probeYoutubeEpisode({
      videoId: 'desc429vid01',
      workDir: path.join(directory, 'block'),
      run: async () => ({
        code: 1,
        stdout: JSON.stringify({ description: 'ok' }),
        stderr: 'ERROR: HTTP Error 429: Too Many Requests',
        missing: false,
      }),
    });
    assert.equal(realBlock.blocked, '429');

    const rssOk = await defaultFetchRss('https://example.test/feed', async () => ({
      ok: true,
      status: 200,
      text: async () => RSS.replace('Odd Lots', 'Odd Lots $429 billion'),
    }));
    assert.equal(rssOk.blocked, undefined);
    assert.equal(rssOk.entries[0].title.includes('429'), true);
    const rssBlocked = await defaultFetchRss('https://example.test/feed', async () => ({
      ok: false,
      status: 429,
      text: async () => 'Too Many Requests',
    }));
    assert.equal(rssBlocked.blocked, '429');
    const channel = await resolveYoutubeChannelId({
      handle: 'oddlots',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => '<html>"channelId":"UCabcdefghijklmnopqrstu" $429 billion</html>',
      }),
    });
    assert.equal(channel.channelId, 'UCabcdefghijklmnopqrstu');

    const result = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: [entry('desc429vid01', 'The $429 billion balance sheet')] }),
      probe: async (item) => probeYoutubeEpisode({
        videoId: item.videoId,
        url: 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLtest',
        workDir: path.join(directory, item.videoId),
        run: async (_command, args) => {
          const blob = args.join('\n');
          assert.equal(/zh-Hans|zh-Hant|\bja\b|\.\*-orig/.test(blob), false);
          writeFileSync(path.join(directory, item.videoId, 'desc429vid01.info.json'), JSON.stringify({
            ...info,
            language: 'en-US',
            subtitles: {},
            automatic_captions: { 'zh-Hans': [{}], ja: [{}], 'en-orig': [{}], 'ar-orig': [{}] },
          }));
          if (!args.includes('--sub-langs')) {
            return { code: 0, stdout: '', stderr: '$429 billion', missing: false };
          }
          assert.equal(args[args.indexOf('--sub-langs') + 1], 'en-orig');
          assert.equal(args.includes('--write-auto-subs'), true);
          assert.equal(args.includes('--write-subs'), false);
          writeFileSync(path.join(directory, item.videoId, 'clip.en-orig.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello rates\n');
          return { code: 0, stdout: '', stderr: '', missing: false };
        },
      }),
      transcribe: async () => { throw new Error('有字幕不应转写'); },
      summarize: async () => SUMMARY,
    });
    assert.equal(result.stopped, '');
    assert.equal(result.discovered, 1);
    assert.equal(result.subtitles, 1);
    assert.match(opened.store.repositories.youtubePodcasts.getReady('local', 'desc429vid01').body, /Hello rates/);
  } finally {
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rss and channel timeouts continue the round', async () => {
  const opened = openStore();
  try {
    let calls = 0;
    const result = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
      config: creatorConfig({
        creators: [{
          id: 'all-in',
          name: 'All-In',
          focus: '科技',
          channels: [{ key: 'all-in', kind: 'playlist', playlistId: 'PLnext', url: 'https://www.youtube.com/playlist?list=PLnext' }],
        }],
      }),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error('RSS 超时');
          error.code = 'youtube-timeout';
          throw error;
        }
        return { entries: [entry('aftertime001')] };
      },
      probe: async () => ({ durationSec: 1800, liveStatus: 'not_live', transcript: '超时之后的正文', transcriptSource: 'subtitle-manual' }),
      summarize: async () => SUMMARY,
    });
    assert.equal(result.stopped, '');
    assert.equal(result.reasons.includes('timeout'), true);
    assert.equal(result.discovered, 1);
    await assert.rejects(
      () => defaultFetchRss('https://example.test/feed', async () => {
        throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
      }),
      (error) => error?.code === 'youtube-timeout',
    );
  } finally {
    opened.close();
  }
});

test('runProcess resolves after a kill and caps captured output', { timeout: 20_000 }, async () => {
  const capped = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(400000)); process.stderr.write("y".repeat(400000))'], {
    timeoutMs: 10_000,
  });
  assert.equal(capped.code, 0);
  assert.equal(capped.stdout.length, 400000);
  assert.equal(capped.stderr.length, YOUTUBE_STDERR_CAP);
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  controller.abort();
  const killed = await pending;
  assert.notEqual(killed.code, 0);
});

test('the round stops on a deadline signal without a second writer', async () => {
  const opened = openStore();
  try {
    let probes = 0;
    const handlers = createYoutubePodcastJobHandlers({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      sleep: async () => {},
      fetchRss: async () => ({ entries: [entry('signalvid001')] }),
      probe: async () => {
        probes += 1;
        return { durationSec: 1800, transcript: '不应探测', transcriptSource: 'subtitle-manual' };
      },
      summarize: async () => SUMMARY,
    });
    const controller = new AbortController();
    controller.abort();
    const stats = await handlers[YOUTUBE_PODCAST_JOB_TYPE]({}, { signal: controller.signal });
    assert.equal(probes, 0);
    assert.equal(stats.stopped, 'deadline');
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'signalvid001'), null);
  } finally {
    opened.close();
  }
});

test('over-long episodes are skipped and the first transcription may exceed the round budget', async () => {
  const opened = openStore();
  try {
    let transcribed = 0;
    const tooLong = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
      config: creatorConfig(),
      limits: { episodeTranscribeSec: 30 * 60 },
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: [entry('toolongvid01', 'A four hour conversation')] }),
      probe: async () => ({ durationSec: 4 * 60 * 60, liveStatus: 'not_live', transcript: '', transcriptSource: '' }),
      transcribe: async () => { transcribed += 1; return '不应转写'; },
      summarize: async () => SUMMARY,
    });
    assert.equal(tooLong.stopped, '');
    assert.equal(transcribed, 0);
    const skipped = opened.store.repositories.youtubePodcasts.episode('local', 'toolongvid01');
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.reason, 'transcribe-too-long');
    assert.equal(opened.store.repositories.youtubePodcasts.isDone('local', 'toolongvid01'), true);

    const budget = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      config: creatorConfig(),
      limits: { transcribeSec: 30, episodeTranscribeSec: 60 * 60 },
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({
        entries: [
          entry('budgetvid001', 'Alpha rates briefing'),
          entry('budgetvid002', 'Beta chip supply'),
        ],
      }),
      probe: async () => ({ durationSec: 1500, liveStatus: 'not_live', transcript: '', transcriptSource: '' }),
      transcribe: async () => { transcribed += 1; return '第一集转写'; },
      summarize: async () => SUMMARY,
    });
    assert.equal(budget.transcribed, 1);
    assert.equal(budget.reasons.includes('transcribe-budget'), true);
    assert.equal(opened.store.repositories.youtubePodcasts.getReady('local', 'budgetvid001').transcriptSource, 'gemini-transcribe');
    const deferred = opened.store.repositories.youtubePodcasts.episode('local', 'budgetvid002');
    assert.equal(deferred.status, 'failed');
    assert.equal(deferred.reason, 'transcribe-budget');
    assert.equal(deferred.attempts, 0);
  } finally {
    opened.close();
  }
});

test('quota and http 429 stop the round without counting an attempt', async () => {
  const opened = openStore();
  try {
    const result = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: [entry('quotavid0001'), entry('quotavid0002', 'Another rates conversation')] }),
      probe: async () => ({ durationSec: 1800, liveStatus: 'not_live', transcript: '正文', transcriptSource: 'subtitle-manual' }),
      summarize: async () => {
        const error = new Error('quota');
        error.status = 429;
        error.code = 'budget-deferred';
        throw error;
      },
    });
    assert.equal(result.stopped, '429');
    assert.equal(result.discovered, 1);
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'quotavid0001'), null);
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'quotavid0002'), null);
  } finally {
    opened.close();
  }
});

test('shadow lists exclude youtube and enforce author reads still return it', async () => {
  const opened = openStore();
  try {
    const transcript = '利率讨论'.repeat(5001);
    const saved = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: [entry('shadowvid001', '利率讨论长集')] }),
      probe: async () => ({ durationSec: 1800, liveStatus: 'not_live', transcript, transcriptSource: 'subtitle-manual' }),
      summarize: async () => SUMMARY,
    });
    assert.equal(saved.discovered, 1);
    const feed = opened.store.repositories.feed;
    const youtube = feed.getCapture('local', 'youtube', 'shadowvid001');
    const youtubeItem = feed.getContentItemByCaptureId('local', youtube.id);
    const plainCapture = feed.saveCapture({
      workspaceId: 'local', provider: 'rss', externalId: 'plain-article', contentHash: 'plain-article',
      title: '对照文章', status: 'ready', publishedAt: Date.parse('2026-10-18T01:00:00Z'),
    });
    const plain = feed.saveContentItem({
      workspaceId: 'local', captureId: plainCapture.id, originType: 'subscription', contentType: 'article',
      title: '对照文章', body: '甲'.repeat(20001), summary: '对照', publishedAt: Date.parse('2026-10-18T01:00:00Z'),
    });
    const droppedCapture = feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'dropped-x', contentHash: 'dropped-x',
      title: '被质量规则挡住', status: 'ready', publishedAt: Date.parse('2026-10-18T02:00:00Z'),
      metadata: { filterMode: 'enforce', filterDecision: 'DROP', filterApplied: true },
    });
    const dropped = feed.saveContentItem({
      workspaceId: 'local', captureId: droppedCapture.id, originType: 'subscription', contentType: 'post',
      title: '被质量规则挡住', body: '不要出现', summary: '不要', publishedAt: Date.parse('2026-10-18T02:00:00Z'),
    });
    const keptCapture = feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'kept-x', contentHash: 'kept-x',
      title: '保留文章', status: 'ready', publishedAt: Date.parse('2026-10-18T03:00:00Z'),
      metadata: {
        filterMode: 'enforce', filterDecision: 'KEEP', filterApplied: true, filterRule: 'all-three-0.60',
        filterScores: { reading_value: 0.9, specific_content: 0.9, sufficient_information: 0.9 },
      },
    });
    const kept = feed.saveContentItem({
      workspaceId: 'local', captureId: keptCapture.id, originType: 'subscription', contentType: 'post',
      title: '保留文章', body: '保留正文', summary: '保留', publishedAt: Date.parse('2026-10-18T03:00:00Z'),
    });

    const window = { startAt: 0, endAt: Date.now() + 60_000 };
    assert.equal(feed.listContentItems('local').some((row) => row.id === youtubeItem.id), false);
    assert.equal(feed.listContentItems('local').some((row) => row.id === plain.id), true);
    assert.equal(feed.listContentItemsWithSource('local').some((row) => row.provider === 'youtube'), false);
    assert.equal(feed.listContentItemsInWindow('local', { ...window, timeBasis: 'published' }).some((row) => row.provider === 'youtube'), false);
    assert.equal(feed.listContentItemsInWindow('local', { ...window, timeBasis: 'ingested' }).some((row) => row.provider === 'youtube'), false);
    assert.equal(feed.countLongUntranslatedOutsideProviders('local'), 1);

    const shadowFeed = createFeedService({
      legacyRepository: {},
      feedRepository: feed,
      sourcePort: {},
      feedFilter: { config: { mode: 'shadow', rule: 'all-three-0.60' } },
    });
    assert.equal(shadowFeed.searchContentItems('local', '利率').some((row) => row.id === youtubeItem.id), false);
    assert.equal(shadowFeed.searchContentItems('local', '对照').some((row) => row.id === plain.id), true);

    let recalled = [];
    createResearchRecallService({
      repository: { savePool(_workspaceId, pool) { recalled = pool.members; return pool; } },
      feedRepository: feed,
      informationRepository: { listInformationInWindow: () => [] },
    }).freezePool({ workspaceId: 'local', window });
    assert.equal(recalled.some((member) => member.originId === youtubeItem.id), false);
    assert.equal(recalled.some((member) => member.originId === plain.id), true);

    const byId = feed.listContentItemsByIds('local', [youtubeItem.id, plain.id, dropped.id, kept.id], { qualityRule: 'all-three-0.60' });
    assert.deepEqual(byId.map((row) => row.id), [youtubeItem.id, kept.id]);
    const authorPage = createAuthorService({
      authorRepository: opened.store.repositories.authors,
      feedRepository: feed,
      qualityRule: 'all-three-0.60',
    }).items('local', 'youtube:odd-lots');
    assert.equal(authorPage.items.length, 1);
    assert.equal(authorPage.items[0].id, youtubeItem.id);
    assert.equal(authorPage.items[0].provider, 'youtube');

    feed.upsertUserItemState({ workspaceId: 'local', contentItemId: youtubeItem.id, isHidden: true });
    assert.equal(feed.listContentItemsByIds('local', [youtubeItem.id], { qualityRule: 'all-three-0.60' }).length, 0);
    feed.upsertUserItemState({ workspaceId: 'local', contentItemId: youtubeItem.id, isHidden: false });
    feed.rememberFeedDedupKey('local', youtubeItem.id, 'shared-dedup');
    feed.rememberFeedDedupKey('local', plain.id, 'shared-dedup');
    feed.saveContentItem({
      workspaceId: 'local', captureId: plainCapture.id, originType: 'subscription', contentType: 'article',
      title: '对照文章', body: '对照...', summary: '对照', publishedAt: Date.parse('2026-10-18T01:00:00Z'),
      sourceUrl: 'https://example.com/plain-article',
    });
    feed.saveContentItem({
      workspaceId: 'local', captureId: youtube.id, originType: 'subscription', contentType: 'video',
      title: '利率讨论长集', body: '文字稿...', summary: '摘要', publishedAt: Date.parse('2026-10-18T00:00:00Z'),
      sourceUrl: 'https://www.youtube.com/watch?v=shadowvid001',
    });
    assert.equal(feed.listFeedByDedupKey('local', 'shared-dedup').some((row) => row.id === youtubeItem.id), false);
    assert.equal(feed.listFeedByDedupKeys('local', ['shared-dedup']).some((row) => row.id === youtubeItem.id), false);
    assert.equal(feed.listFeedByDedupKey('local', 'shared-dedup').some((row) => row.id === plain.id), true);
    assert.equal(feed.listFeedByPublishedAt('local', 0, Date.now() + 60_000).some((row) => row.id === youtubeItem.id), false);
    assert.equal(feed.listEllipsisLeadBodies('local').some((row) => row.id === youtubeItem.id), false);
    assert.equal(feed.listEllipsisLeadBodies('local').some((row) => row.id === plain.id), true);
    assert.equal(feed.listFeedByUrlPrefixes('local', ['https://www.youtube.com/watch?v=shadowvid001']).some((row) => row.id === youtubeItem.id), false);
    assert.equal(feed.listFeedByUrlPrefixes('local', ['https://example.com/plain-article']).some((row) => row.id === plain.id), true);
  } finally {
    opened.close();
  }
});

function delayedFetch({ headerMs, bodyMs, html, status = 200 }) {
  return (_url, { signal } = {}) => new Promise((resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    if (signal?.aborted) { fail(); return; }
    const onAbort = () => { clearTimeout(headerTimer); fail(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const headerTimer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => new Promise((resolveText, rejectText) => {
          const bodyFail = () => rejectText(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
          if (signal?.aborted) { bodyFail(); return; }
          const onBodyAbort = () => { clearTimeout(bodyTimer); bodyFail(); };
          signal?.addEventListener('abort', onBodyAbort, { once: true });
          const bodyTimer = setTimeout(() => {
            signal?.removeEventListener('abort', onBodyAbort);
            resolveText(html);
          }, bodyMs);
        }),
      });
    }, headerMs);
  });
}

test('channel page body gets a fresh timeout and configured channel ids skip resolution', async () => {
  const slowBody = await resolveYoutubeChannelId({
    handle: 'TheValley101',
    timeoutMs: 200,
    fetchImpl: delayedFetch({
      headerMs: 150,
      bodyMs: 150,
      html: '<html>"channelId":"UChnNjLyx_5rk_iDPQ2BQDQA"</html>',
    }),
  });
  assert.equal(slowBody.channelId, 'UChnNjLyx_5rk_iDPQ2BQDQA');
  const bodyTooSlow = await resolveYoutubeChannelId({
    handle: 'TheValley101',
    timeoutMs: 100,
    fetchImpl: delayedFetch({ headerMs: 20, bodyMs: 400, html: '<html>"channelId":"UChnNjLyx_5rk_iDPQ2BQDQA"</html>' }),
  });
  assert.equal(bodyTooSlow.failed, true);
  assert.equal(bodyTooSlow.detail, '频道页超时');
  const headerTooSlow = await fetchYoutubeText('https://www.youtube.com/@TheValley101', {
    timeoutMs: 80,
    fetchImpl: delayedFetch({ headerMs: 200, bodyMs: 10, html: 'late' }),
  }).catch((error) => error);
  assert.equal(headerTooSlow.code, 'youtube-timeout');

  const opened = openStore();
  try {
    let resolved = 0;
    let rssUrl = '';
    const result = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
      config: {
        minDurationSec: 1200,
        lookback: 2,
        creators: [{
          id: 'valley101',
          name: '硅谷101',
          focus: '科技',
          channels: [{
            key: 'valley101-video',
            kind: 'channel',
            handle: 'TheValley101',
            channelId: 'UChnNjLyx_5rk_iDPQ2BQDQA',
            language: 'zh',
            url: 'https://www.youtube.com/@TheValley101',
          }],
        }],
      },
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      resolveChannel: async () => { resolved += 1; return { failed: true, detail: '频道页超时' }; },
      fetchRss: async (url) => { rssUrl = url; return { entries: [] }; },
      listVideos: async () => ({ entries: [] }),
      probe: async () => { throw new Error('没有条目不应探测'); },
      summarize: async () => SUMMARY,
    });
    assert.equal(resolved, 0);
    assert.match(rssUrl, /channel_id=UChnNjLyx_5rk_iDPQ2BQDQA/);
    assert.equal(result.stopped, '');
    const stored = opened.store.repositories.youtubePodcasts.channel('local', 'valley101-video');
    assert.equal(stored.channelId, 'UChnNjLyx_5rk_iDPQ2BQDQA');
    assert.equal(typeof stored.backfilledAt, 'number');
  } finally {
    opened.close();
  }
});

function channelCreator(key, id = key) {
  return {
    minDurationSec: 1200,
    lookback: 2,
    creators: [{
      id,
      name: id,
      focus: 'AI',
      channels: [{
        key,
        kind: 'channel',
        handle: 'ExampleHandle',
        channelId: 'UCZa18YV7qayTh-MRIrBhDpA',
        language: 'en',
        url: 'https://www.youtube.com/@ExampleHandle',
      }],
    }],
  };
}

test('one successful listing stops backfill even when nothing is ready', async () => {
  const opened = openStore();
  try {
    const day1 = Date.parse('2026-10-18T02:00:00Z');
    const day2 = Date.parse('2026-10-19T02:00:00Z');
    opened.store.repositories.youtubePodcasts.saveEpisode({
      workspaceId: 'local',
      videoId: 'dupaudio0001',
      creatorId: 'valley101',
      channelKey: 'valley101-audio',
      title: '已去重的音频版',
      durationSec: 3600,
      publishedAt: day1,
      status: 'skipped',
      reason: 'duplicate-episode',
      attempts: 1,
    });
    let lists = 0;
    let resolved = 0;
    const round = (now) => runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      now,
      config: channelCreator('valley101-audio', 'valley101'),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      resolveChannel: async () => { resolved += 1; return { channelId: 'should-not-resolve' }; },
      fetchRss: async () => ({ entries: [] }),
      listVideos: async (channel) => {
        lists += 1;
        assert.equal(channel.channelId, 'UCZa18YV7qayTh-MRIrBhDpA');
        return { entries: [
          { videoId: 'dupaudio0001', title: 'playlist title', durationSec: 3600, publishedAt: 0 },
          { videoId: 'onlyshort001', title: 'clip #shorts', durationSec: 40, publishedAt: 0 },
        ] };
      },
      probe: async (item) => ({
        durationSec: item.videoId === 'onlyshort001' ? 40 : 3600,
        title: item.title,
        liveStatus: 'not_live',
        transcript: '不应入库',
        transcriptSource: 'subtitle-manual',
      }),
      summarize: async () => SUMMARY,
    });
    const first = await round(day1);
    assert.equal(lists, 1);
    assert.equal(resolved, 0);
    assert.equal(first.discovered, 0);
    assert.equal(opened.store.repositories.youtubePodcasts.listReady('local').length, 0);
    const stored = opened.store.repositories.youtubePodcasts.channel('local', 'valley101-audio');
    assert.equal(stored.backfilledAt, day1);
    assert.equal(stored.backfillAttempts, 0);
    assert.equal(stored.bootstrapped, true);
    opened.store.repositories.youtubePodcasts.saveChannel('local', 'valley101-audio', { channelId: stored.channelId });
    assert.equal(opened.store.repositories.youtubePodcasts.channel('local', 'valley101-audio').backfilledAt, day1);
    const second = await round(day2);
    assert.equal(lists, 1);
    assert.equal(second.discovered, 0);
    assert.deepEqual(selectBackfillEntries([
      { videoId: 'shortone0001', title: 'short', durationSec: 30 },
      { videoId: 'longone00001', title: 'long', durationSec: 4000 },
    ], 1200, 2).map((item) => item.videoId), ['longone00001']);
  } finally {
    opened.close();
  }
});

test('backfill retries on the next Shanghai day and stops after three failures', async () => {
  const opened = openStore();
  try {
    const day1 = Date.parse('2026-10-18T02:00:00Z');
    const day1Later = Date.parse('2026-10-18T14:00:00Z');
    const day2 = Date.parse('2026-10-19T02:00:00Z');
    const day3 = Date.parse('2026-10-20T02:00:00Z');
    const day4 = Date.parse('2026-10-21T02:00:00Z');
    let lists = 0;
    const round = (now, listVideos) => runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      now,
      config: channelCreator('dwarkesh'),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: [] }),
      listVideos,
      probe: async () => { throw new Error('空列表不应探测'); },
      summarize: async () => SUMMARY,
    });
    const blocked = await round(day1, async () => {
      lists += 1;
      return { blocked: '429' };
    });
    assert.equal(blocked.stopped, '429');
    assert.equal(lists, 1);
    assert.equal(opened.store.repositories.youtubePodcasts.channel('local', 'dwarkesh').backfillAttempts, 0);
    lists = 0;
    const fail = async () => {
      lists += 1;
      throw new Error('playlist down');
    };
    const first = await round(day1, fail);
    assert.equal(first.stopped, '');
    assert.equal(first.reasons.includes('backfill'), true);
    assert.equal(lists, 1);
    assert.equal(opened.store.repositories.youtubePodcasts.channel('local', 'dwarkesh').backfillAttempts, 1);
    assert.equal(opened.store.repositories.youtubePodcasts.channel('local', 'dwarkesh').backfilledAt, null);
    await round(day1Later, fail);
    assert.equal(lists, 1);
    assert.equal(opened.store.repositories.youtubePodcasts.channel('local', 'dwarkesh').backfillAttempts, 1);
    await round(day2, fail);
    await round(day3, fail);
    assert.equal(lists, 3);
    assert.equal(opened.store.repositories.youtubePodcasts.channel('local', 'dwarkesh').backfillAttempts, 3);
    await round(day4, fail);
    assert.equal(lists, 3);
    assert.equal(opened.store.repositories.youtubePodcasts.channel('local', 'dwarkesh').backfilledAt, null);
  } finally {
    opened.close();
  }
});

test('a bootstrapped backfill keeps only the lookback window', async () => {
  const opened = openStore();
  try {
    const lookback = 2;
    const listed = Array.from({ length: 30 }, (_, index) => ({
      videoId: `window${String(index).padStart(6, '0')}`,
      title: `Distinct interview ${index} ${index * 97}`,
      durationSec: 1800 + index * 500,
      publishedAt: Date.parse('2026-10-18T00:00:00Z') - index * 86_400_000,
    }));
    opened.store.repositories.youtubePodcasts.saveChannel('local', 'dwarkesh', {
      channelId: 'UCZa18YV7qayTh-MRIrBhDpA',
      bootstrapped: true,
    });
    const probed = [];
    const result = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      now: Date.parse('2026-10-19T02:00:00Z'),
      limits: { lookback },
      config: channelCreator('dwarkesh'),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: [] }),
      listVideos: async () => ({ entries: listed }),
      probe: async (item) => {
        probed.push(item.videoId);
        return {
          durationSec: 1800 + probed.length * 500,
          title: item.title,
          liveStatus: 'not_live',
          transcript: '正文',
          transcriptSource: 'subtitle-manual',
        };
      },
      summarize: async () => SUMMARY,
    });
    assert.equal(probed.length <= lookback + 6, true);
    assert.equal(probed.length, lookback + 6);
    assert.equal(result.discovered, lookback);
    assert.equal(opened.store.repositories.youtubePodcasts.listReady('local').length, lookback);
    const stored = opened.store.repositories.youtubePodcasts.listEpisodes('local');
    const lookbackSkips = stored.filter((row) => row.reason === 'lookback');
    assert.equal(lookbackSkips.length, listed.length - lookback);
    assert.equal(lookbackSkips.every((row) => row.status === 'skipped'), true);
    assert.equal(opened.store.repositories.youtubePodcasts.channel('local', 'dwarkesh').backfilledAt, Date.parse('2026-10-19T02:00:00Z'));
  } finally {
    opened.close();
  }
});

test('a blocked probe does not record a finished backfill', async () => {
  const opened = openStore();
  try {
    opened.store.repositories.youtubePodcasts.saveChannel('local', 'dwarkesh', {
      channelId: 'UCZa18YV7qayTh-MRIrBhDpA',
      bootstrapped: true,
    });
    const before = opened.store.repositories.youtubePodcasts.channel('local', 'dwarkesh');
    let probes = 0;
    const result = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      now: Date.parse('2026-10-19T02:00:00Z'),
      config: channelCreator('dwarkesh'),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: [] }),
      listVideos: async () => ({ entries: [
        { videoId: 'blockfirst01', title: 'First long interview', durationSec: 3600, publishedAt: 300 },
        { videoId: 'blocknext001', title: 'Second long interview', durationSec: 4200, publishedAt: 200 },
        { videoId: 'blocklater01', title: 'Later long interview', durationSec: 5000, publishedAt: 100 },
      ] }),
      probe: async () => {
        probes += 1;
        if (probes === 2) return { blocked: 'bot-check' };
        return { durationSec: 3600, title: 'First long interview', liveStatus: 'not_live', transcript: '正文', transcriptSource: 'subtitle-manual' };
      },
      summarize: async () => SUMMARY,
    });
    const after = opened.store.repositories.youtubePodcasts.channel('local', 'dwarkesh');
    assert.equal(result.stopped, 'bot-check');
    assert.equal(probes, 2);
    assert.equal(after.backfilledAt, null);
    assert.equal(after.backfillAttempts, before.backfillAttempts);
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'blocklater01'), null);
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'blocknext001'), null);
  } finally {
    opened.close();
  }
});

test('backfill lookback does not overwrite episodes already stored', async () => {
  const opened = openStore();
  try {
    const repository = opened.store.repositories.youtubePodcasts;
    const lookback = 2;
    const listed = Array.from({ length: 11 }, (_, index) => {
      const videoId = index === 9 ? 'readyold0001' : index === 10 ? 'failedold001' : `freshwin${String(index).padStart(3, '0')}`;
      return {
        videoId,
        title: `Separate topic ${index} ${videoId}`,
        durationSec: 2400 + index * 500,
        publishedAt: Date.parse('2026-10-18T00:00:00Z') - index * 86_400_000,
      };
    });
    repository.saveChannel('local', 'dwarkesh', {
      channelId: 'UCZa18YV7qayTh-MRIrBhDpA',
      bootstrapped: true,
    });
    repository.saveEpisode({
      workspaceId: 'local',
      videoId: 'readyold0001',
      creatorId: 'dwarkesh',
      channelKey: 'dwarkesh',
      title: 'Already ingested',
      durationSec: 5400,
      publishedAt: listed[9].publishedAt,
      status: 'ready',
      reason: '',
      transcriptSource: 'subtitle-manual',
      contentItemId: 'item-ready-1',
      attempts: 2,
    });
    repository.saveEpisode({
      workspaceId: 'local',
      videoId: 'failedold001',
      creatorId: 'dwarkesh',
      channelKey: 'dwarkesh',
      title: 'Earlier failure',
      durationSec: 4800,
      publishedAt: listed[10].publishedAt,
      status: 'failed',
      reason: 'probe-failed',
      transcriptSource: 'subtitle-auto',
      contentItemId: 'item-failed-1',
      attempts: 3,
    });
    const result = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      now: Date.parse('2026-10-19T02:00:00Z'),
      limits: { lookback },
      config: channelCreator('dwarkesh'),
      repository,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: [] }),
      listVideos: async () => ({ entries: listed }),
      probe: async (item) => {
        assert.equal(item.videoId === 'readyold0001' || item.videoId === 'failedold001', false);
        return {
          durationSec: 3000 + item.publishedAt,
          title: item.title,
          liveStatus: 'not_live',
          transcript: '正文',
          transcriptSource: 'subtitle-manual',
        };
      },
      summarize: async () => SUMMARY,
    });
    const ready = repository.episode('local', 'readyold0001');
    assert.equal(ready.status, 'ready');
    assert.equal(ready.contentItemId, 'item-ready-1');
    assert.equal(ready.attempts, 2);
    assert.equal(ready.transcriptSource, 'subtitle-manual');
    const failed = repository.episode('local', 'failedold001');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.contentItemId, 'item-failed-1');
    assert.equal(failed.attempts, 3);
    assert.equal(failed.reason, 'probe-failed');
    assert.equal(repository.episode('local', 'freshwin008').status, 'skipped');
    assert.equal(repository.episode('local', 'freshwin008').reason, 'lookback');
    assert.equal(result.stopped, '');
  } finally {
    opened.close();
  }
});

test('backfill unions rss by video id and keeps rss title and time', async () => {
  const opened = openStore();
  try {
    const bothAt = Date.parse('2026-10-18T00:00:00Z');
    const rssOnlyAt = Date.parse('2026-10-17T00:00:00Z');
    const listOnlyAt = Date.parse('2026-10-16T00:00:00Z');
    const rss = [
      { videoId: 'both00000001', title: 'RSS title', publishedAt: bothAt, url: 'https://www.youtube.com/watch?v=both00000001' },
      { videoId: 'rssonly00001', title: 'RSS only', publishedAt: rssOnlyAt, url: 'https://www.youtube.com/watch?v=rssonly00001' },
    ];
    const listed = [
      { videoId: 'both00000001', title: 'Playlist title', publishedAt: Date.parse('2026-10-01T00:00:00Z'), durationSec: 3600, url: 'https://www.youtube.com/watch?v=both00000001' },
      { videoId: 'listonly0001', title: 'List only', publishedAt: listOnlyAt, durationSec: 2400, url: 'https://www.youtube.com/watch?v=listonly0001' },
    ];
    const merged = mergePodcastEntries(rss, listed);
    assert.deepEqual(merged.map((item) => item.videoId), ['both00000001', 'rssonly00001', 'listonly0001']);
    assert.equal(merged[0].title, 'RSS title');
    assert.equal(merged[0].publishedAt, bothAt);
    assert.equal(merged[0].durationSec, 3600);
    assert.equal(merged[1].title, 'RSS only');
    const probed = [];
    let lists = 0;
    const round = () => runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      config: channelCreator('dwarkesh'),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: rss }),
      listVideos: async () => {
        lists += 1;
        return { entries: listed };
      },
      probe: async (item) => {
        probed.push(item);
        return { durationSec: 1800, title: item.title, liveStatus: 'not_live', transcript: '正文', transcriptSource: 'subtitle-manual' };
      },
      summarize: async () => SUMMARY,
    });
    const first = await round();
    assert.equal(lists, 1);
    assert.deepEqual(probed.map((item) => item.videoId), ['both00000001', 'rssonly00001', 'listonly0001']);
    assert.equal(probed[0].title, 'RSS title');
    assert.equal(probed[0].publishedAt, bothAt);
    assert.equal(probed[0].durationSec, 3600);
    assert.equal(first.discovered, 2);
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'both00000001').title, 'RSS title');
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'listonly0001').reason, 'lookback');
    await round();
    assert.equal(lists, 1);
  } finally {
    opened.close();
  }
});

test('backfill without timestamps keeps playlist order ahead of lookback', async () => {
  const rss = Array.from({ length: 8 }, (_, index) => ({
    videoId: `timedrss${String(index).padStart(3, '0')}`,
    title: `RSS ${index}`,
    publishedAt: Date.parse('2026-10-18T00:00:00Z') - index * 86_400_000,
    url: `https://www.youtube.com/watch?v=timedrss${String(index).padStart(3, '0')}`,
  }));
  const listed = [
    { videoId: 'newuntimed01', title: 'Newest playlist', publishedAt: 0, durationSec: 4000 },
    { videoId: 'olduntimed01', title: 'Second playlist', publishedAt: 0, durationSec: 3000 },
  ];
  const merged = mergePodcastEntries(rss, listed);
  const slice = firstRunSlice(merged, 2);
  assert.equal(slice.probe[0].videoId, 'newuntimed01');
  assert.equal(slice.probe[1].videoId, 'olduntimed01');
  assert.equal(slice.probe.some((item) => item.videoId === 'timedrss007'), false);
  assert.equal(slice.ignore.some((item) => item.videoId === 'timedrss007'), true);
  const opened = openStore();
  try {
    const probed = [];
    const result = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      config: channelCreator('dwarkesh'),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: rss }),
      listVideos: async () => ({ entries: listed }),
      probe: async (item) => {
        probed.push(item.videoId);
        return { durationSec: 1800, title: item.title, liveStatus: 'not_live', transcript: '正文', transcriptSource: 'subtitle-manual' };
      },
      summarize: async () => SUMMARY,
    });
    assert.equal(probed[0], 'newuntimed01');
    assert.equal(probed.includes('timedrss007'), false);
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'timedrss007').reason, 'lookback');
    assert.equal(opened.store.repositories.youtubePodcasts.getReady('local', 'newuntimed01') != null, true);
    assert.equal(result.stopped, '');
  } finally {
    opened.close();
  }
});

test('flat playlist args stay on one videos tab and do not download media', async () => {
  let args = [];
  const listed = await listChannelLongVideos({
    channelId: 'UCZa18YV7qayTh-MRIrBhDpA',
    limit: 30,
    run: async (_command, received) => {
      args = received;
      return {
        code: 0,
        stdout: JSON.stringify({ entries: [
          { id: 'fullepisode1', title: 'Long', duration: 5400, timestamp: 100 },
          { id: 'shortclip0001', title: 'Short', duration: 40, timestamp: 90 },
        ] }),
        stderr: '',
        missing: false,
      };
    },
  });
  assert.equal(args.includes('--flat-playlist'), true);
  assert.equal(args[args.indexOf('--playlist-end') + 1], '30');
  assert.equal(args.includes('--skip-download'), true);
  assert.equal(args.at(-1), 'https://www.youtube.com/channel/UCZa18YV7qayTh-MRIrBhDpA/videos');
  assert.equal(/zh-Hans|zh-Hant|\bja\b|\.\*-orig/.test(args.join('\n')), false);
  assert.deepEqual(listed.entries.map((item) => item.videoId), ['fullepisode1', 'shortclip0001']);
  assert.equal(listed.entries[0].durationSec, 5400);
});

test('transcription uses the real executor and a missing transcriber does not download audio', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'youtube-tx-'));
  const store = createStore(path.join(root, 'test.db'));
  try {
    let geminiCalls = 0;
    const text = await transcribeYoutubeAudio({
      videoId: 'xiaojunvid01',
      dataDirectory: root,
      env: { GEMINI_API_KEY: 'test-key' },
      quotaRepository: store.repositories.modelQuota,
      execute: executeAudioTranscription,
      transcribe: async ({ apiKey, audio }) => {
        geminiCalls += 1;
        assert.equal(apiKey, 'test-key');
        assert.ok(audio.length > 44);
        return '张小珺正文';
      },
      run: async (_command, _args, opts) => {
        const pcm = Buffer.alloc(16_000 * 2);
        writeFileSync(path.join(opts.cwd, 'xiaojunvid01.wav'), buildWav(pcm, { channels: 1, sampleRate: 16_000, bitsPerSample: 16, blockAlign: 2 }));
        return { code: 0, stdout: '', stderr: '', missing: false };
      },
    });
    assert.equal(text, '张小珺正文');
    assert.equal(geminiCalls, 1);

    let downloaded = false;
    await assert.rejects(() => transcribeYoutubeAudio({
      videoId: 'nokeyvid0001',
      dataDirectory: root,
      env: {},
      execute: executeAudioTranscription,
      run: async () => { downloaded = true; return { code: 0, stdout: '', stderr: '', missing: false }; },
    }), (error) => error?.code === 'youtube-transcribe-unavailable' && /转写密钥/.test(error.message));
    assert.equal(downloaded, false);

    const opened = openStore();
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const result = await runYoutubePodcastRound({
        env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
        config: creatorConfig(),
        repository: opened.store.repositories.youtubePodcasts,
        feedRepository: opened.store.repositories.feed,
        workspaceId: 'local',
        dataDirectory: root,
        sleep: async () => {},
        fetchRss: async () => ({ entries: [
          { ...entry('nosubvid0001', 'Rates without captions'), publishedAt: 200 },
          { ...entry('subvid000001', 'Chip supply with captions'), publishedAt: 100 },
        ] }),
        probe: async (item) => ({
          durationSec: 1800,
          title: item.title,
          liveStatus: 'not_live',
          transcript: item.videoId === 'subvid000001' ? '有字幕正文' : '',
          transcriptSource: item.videoId === 'subvid000001' ? 'subtitle-manual' : '',
        }),
        summarize: async ({ title }) => {
          assert.equal(title, 'Chip supply with captions');
          return SUMMARY;
        },
      });
      assert.equal(result.stopped, '');
      assert.equal(result.subtitles, 1);
      assert.equal(result.transcribeUnavailable, 1);
      assert.equal(result.reasons.includes('transcribe-unavailable'), true);
      assert.equal(warnings.length, 1);
      const saved = opened.store.repositories.youtubePodcasts.episode('local', 'nosubvid0001');
      assert.equal(saved.status, 'failed');
      assert.equal(saved.reason, 'transcribe-unavailable');
      assert.equal(saved.attempts, 0);
      assert.equal(opened.store.repositories.youtubePodcasts.isDone('local', 'nosubvid0001'), false);
      assert.equal(opened.store.repositories.youtubePodcasts.getReady('local', 'subvid000001').transcriptSource, 'subtitle-manual');
    } finally {
      console.warn = originalWarn;
      opened.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a transcriber that fails mid-round does not stop later episodes', async () => {
  const opened = openStore();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    let calls = 0;
    const result = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      config: creatorConfig(),
      limits: { lookback: 3 },
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      fetchRss: async () => ({ entries: [
        { ...entry('audfirst0001', 'Alpha rates briefing'), publishedAt: 300 },
        { ...entry('audnext00001', 'Beta chip supply'), publishedAt: 200 },
        { ...entry('sublater0001', 'Gamma housing starts'), publishedAt: 100 },
      ] }),
      probe: async (item) => ({
        durationSec: 1800,
        title: item.title,
        liveStatus: 'not_live',
        transcript: item.videoId === 'sublater0001' ? '字幕正文' : '',
        transcriptSource: item.videoId === 'sublater0001' ? 'subtitle-manual' : '',
      }),
      transcribe: async (episode) => {
        calls += 1;
        assert.equal(episode.videoId, 'audfirst0001');
        const error = new Error('没有配置可用的转写密钥');
        error.code = 'youtube-transcribe-unavailable';
        throw error;
      },
      summarize: async ({ title }) => {
        assert.equal(title, 'Gamma housing starts');
        return SUMMARY;
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.stopped, '');
    assert.equal(result.subtitles, 1);
    assert.equal(result.transcribeUnavailable, 2);
    assert.equal(warnings.length, 1);
    for (const videoId of ['audfirst0001', 'audnext00001']) {
      const saved = opened.store.repositories.youtubePodcasts.episode('local', videoId);
      assert.equal(saved.status, 'failed');
      assert.equal(saved.reason, 'transcribe-unavailable');
      assert.equal(saved.attempts, 0);
    }
    assert.equal(opened.store.repositories.youtubePodcasts.getReady('local', 'sublater0001').transcriptSource, 'subtitle-manual');
  } finally {
    console.warn = originalWarn;
    opened.close();
  }
});

test('english videos download only en-orig and chinese channels keep zh', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youtube-one-sub-'));
  const forbidden = /zh-Hans|zh-Hant|\bja\b|\.\*-orig/;
  try {
    const englishCalls = [];
    const english = await probeYoutubeEpisode({
      videoId: 'allinorig01',
      workDir: path.join(directory, 'en'),
      run: async (_command, args) => {
        englishCalls.push(args);
        assert.equal(forbidden.test(args.join('\n')), false);
        if (englishCalls.length === 1) {
          assert.equal(args.includes('--write-info-json'), true);
          assert.equal(args.includes('--write-subs'), false);
          assert.equal(args.includes('--write-auto-subs'), false);
          assert.equal(args.includes('--sub-langs'), false);
          writeFileSync(path.join(directory, 'en', 'allinorig01.info.json'), JSON.stringify({
            id: 'allinorig01',
            title: 'All-In',
            duration: 5646,
            language: 'en-US',
            live_status: 'not_live',
            subtitles: {},
            automatic_captions: { 'zh-Hans': [{}], 'zh-Hant': [{}], ja: [{}], 'ar-orig': [{}], 'bn-orig': [{}], 'en-orig': [{}] },
          }));
          return { code: 0, stdout: '', stderr: '', missing: false };
        }
        assert.equal(args[args.indexOf('--sub-langs') + 1], 'en-orig');
        assert.equal(args.includes('--write-auto-subs'), true);
        assert.equal(args.includes('--convert-subs'), true);
        writeFileSync(path.join(directory, 'en', 'allinorig01.en-orig.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOriginal english\n');
        return { code: 0, stdout: '', stderr: '', missing: false };
      },
    });
    assert.equal(englishCalls.length, 2);
    assert.equal(english.durationSec, 5646);
    assert.equal(english.language, 'en-US');
    assert.equal(english.transcriptSource, 'subtitle-auto');
    assert.match(english.transcript, /Original english/);

    const chineseCalls = [];
    for (const [videoId, fallback] of [['valley101vid', 'zh'], ['xiaojunvid01', 'zh']]) {
      const probed = await probeYoutubeEpisode({
        videoId,
        workDir: path.join(directory, videoId),
        language: fallback,
        run: async (_command, args) => {
          chineseCalls.push(args);
          assert.equal(forbidden.test(args.join('\n')), false);
          if (!args.includes('--sub-langs')) {
            writeFileSync(path.join(directory, videoId, `${videoId}.info.json`), JSON.stringify({
              id: videoId,
              title: videoId,
              duration: 3600,
              language: videoId.startsWith('valley') ? 'zh-CN' : '',
              subtitles: { zh: [{}], en: [{}] },
              automatic_captions: { 'zh-Hans': [{}], ja: [{}], 'en-orig': [{}] },
            }));
            return { code: 0, stdout: '', stderr: '', missing: false };
          }
          assert.equal(args[args.indexOf('--sub-langs') + 1], 'zh');
          assert.equal(args.includes('--write-subs'), true);
          assert.equal(args.includes('--write-auto-subs'), false);
          writeFileSync(path.join(directory, videoId, `${videoId}.zh.vtt`), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n中文原版\n');
          return { code: 0, stdout: '', stderr: '', missing: false };
        },
      });
      assert.equal(probed.transcriptSource, 'subtitle-manual');
      assert.match(probed.transcript, /中文原版/);
    }
    assert.equal(chineseCalls.length, 4);

    let subtitleStep = 0;
    const rateLimited = await probeYoutubeEpisode({
      videoId: 'ratelimited1',
      workDir: path.join(directory, 'rate'),
      run: async () => {
        subtitleStep += 1;
        if (subtitleStep === 1) {
          writeFileSync(path.join(directory, 'rate', 'ratelimited1.info.json'), JSON.stringify({
            id: 'ratelimited1', duration: 5646, language: 'en-US', live_status: 'not_live',
            automatic_captions: { 'en-orig': [{}] },
          }));
          return { code: 0, stdout: '', stderr: '', missing: false };
        }
        return {
          code: 1,
          stdout: '',
          stderr: "ERROR: Unable to download video subtitles for 'en-orig': HTTP Error 429",
          missing: false,
        };
      },
    });
    assert.equal(rateLimited.blocked, '429');
    assert.equal(subtitleStep, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('truncated metadata, broken json, and a missing duration stay failed', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youtube-probe-parse-'));
  const opened = openStore();
  try {
    const over = await runProcess(process.execPath, ['-e', `
      process.stdout.write('{"duration":7200,"pad":"');
      process.stdout.write('a'.repeat(${YOUTUBE_STDOUT_CAP}));
      process.stdout.write('"}');
    `], { timeoutMs: 20_000 });
    assert.equal(over.code, 0);
    assert.equal(over.stdout.length, YOUTUBE_STDOUT_CAP);
    const overCap = await probeYoutubeEpisode({
      videoId: 'overcapvid01',
      workDir: path.join(directory, 'over'),
      run: async (_command, args) => {
        assert.equal(args.includes('--dump-single-json'), false);
        assert.equal(args.includes('--write-info-json'), true);
        assert.equal(args.some((arg) => arg.endsWith('%(id)s.%(ext)s')), true);
        assert.equal(args.includes('--sub-langs'), false);
        assert.equal(args.includes('--write-subs'), false);
        assert.equal(/zh-Hans|zh-Hant|\bja\b|\.\*-orig/.test(args.join('\n')), false);
        return over;
      },
    });
    assert.equal(overCap.failed, true);
    assert.equal(overCap.detail, 'probe-parse');

    const broken = await probeYoutubeEpisode({
      videoId: 'brokenvid001',
      workDir: path.join(directory, 'broken'),
      run: async () => ({ code: 0, stdout: '{"id":"brokenvid001","duration":', stderr: '', missing: false }),
    });
    assert.equal(broken.failed, true);
    assert.equal(broken.detail, 'probe-parse');

    const missingDuration = await probeYoutubeEpisode({
      videoId: 'nodurvid0001',
      workDir: path.join(directory, 'nodur'),
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({ id: 'nodurvid0001', title: 'Long talk', automatic_captions: { en: [] } }),
        stderr: '',
        missing: false,
      }),
    });
    assert.equal(missingDuration.failed, true);
    assert.equal(missingDuration.detail, 'probe-parse');

    const stdoutOnly = await probeYoutubeEpisode({
      videoId: 'stdoutonly01',
      workDir: path.join(directory, 'stdout-only'),
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({ id: 'stdoutonly01', duration: 3600, title: 'Only stdout' }),
        stderr: '',
        missing: false,
      }),
    });
    assert.equal(stdoutOnly.failed, true);
    assert.equal(stdoutOnly.detail, 'probe-parse');

    const fromFile = await probeYoutubeEpisode({
      videoId: 'infovid00001',
      workDir: path.join(directory, 'file'),
      run: async () => {
        writeFileSync(path.join(directory, 'file', 'clip.info.json'), JSON.stringify({
          id: 'infovid00001', title: 'From file', duration: 5400, language: 'en',
        }));
        return { code: 0, stdout: '{"duration":', stderr: '', missing: false };
      },
    });
    assert.equal(fromFile.failed, undefined);
    assert.equal(fromFile.durationSec, 5400);

    const round = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: [entry('nodurvid0001', 'A long conversation without a duration')] }),
      probe: async () => ({ durationSec: 0, title: 'A long conversation without a duration' }),
      transcribe: async () => '不应转写',
      summarize: async () => SUMMARY,
    });
    assert.equal(round.stopped, '');
    assert.equal(round.discovered, 0);
    const saved = opened.store.repositories.youtubePodcasts.episode('local', 'nodurvid0001');
    assert.equal(saved.status, 'failed');
    assert.equal(saved.reason, 'probe-parse');
    assert.equal(opened.store.repositories.youtubePodcasts.isDone('local', 'nodurvid0001'), false);
  } finally {
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an old yt-dlp stops the round before any episode is counted', async () => {
  const opened = openStore();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youtube-ytdlp-ver-'));
  try {
    assert.equal(ytDlpVersionAtLeast('2025.11.12'), true);
    assert.equal(ytDlpVersionAtLeast('2025.11.11'), false);
    assert.equal(ytDlpVersionAtLeast('2024.08.06'), false);
    assert.equal(ytDlpVersionAtLeast('2026.1.2'), true);
    assert.equal(ytDlpVersionAtLeast('2025.11.2'), false);
    let probes = 0;
    const outdated = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
      config: creatorConfig(),
      ytDlpVersion: '2024.08.06',
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      fetchRss: async () => ({ entries: [entry('oldytdlp0001')] }),
      probe: async () => { probes += 1; return { durationSec: 1800, transcript: '正文', transcriptSource: 'subtitle-manual' }; },
      summarize: async () => SUMMARY,
    });
    assert.equal(outdated.stopped, 'yt-dlp-outdated');
    assert.equal(probes, 0);
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'oldytdlp0001'), null);

    const option = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
      config: creatorConfig(),
      ytDlpVersion: '2025.11.12',
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => '',
      fetchRss: async () => ({ entries: [entry('nosuchopt001', 'Rates and the option flag')] }),
      probe: async (item) => probeYoutubeEpisode({
        videoId: item.videoId,
        workDir: path.join(directory, item.videoId),
        run: async () => ({
          code: 1,
          stdout: '',
          stderr: 'yt-dlp: error: no such option: --js-runtimes',
          missing: false,
        }),
      }),
      summarize: async () => SUMMARY,
    });
    assert.equal(option.stopped, 'yt-dlp-outdated');
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'nosuchopt001'), null);
    assert.equal(youtubeRoundDeadlineMs(3 * 60 * 60_000), 3 * 60 * 60_000 - 10 * 60_000);
    assert.equal(youtubeRoundDeadlineMs(60_000), 60_000);
    assert.equal(youtubePodcastClock({ AI_CENTER_YOUTUBE_PODCASTS_AT: '25:99' }).hour, 7);
    assert.equal(youtubePodcastClock({ AI_CENTER_YOUTUBE_PODCASTS_AT: '08:15' }).hour, 8);
    const listed = createYoutubePodcastService({
      repository: { listReady: () => [] },
      store: {},
      configPath: path.join(directory, 'missing-youtube-podcasts.json'),
      env: {},
    }).list('local');
    assert.equal(listed.configError, '配置缺失');
    assert.equal(listed.configError.includes(directory), false);
  } finally {
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
