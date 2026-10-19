import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion, unusedSchemaVersions } from '../packages/database/src/migrations.js';
import { createTreeMaterialPort } from '../packages/domain/src/information-tree-materials.js';
import {
  firstRunSlice,
  formatPodcastSummary,
  isShortOrPreview,
  loadYoutubePodcastConfig,
  parseYoutubeRss,
  selectPodcastEpisodes,
  youtubePodcastsEnabled,
} from '../packages/domain/src/youtube-podcasts.js';
import { chooseSubtitle, finishAudioFile, vttToTranscript, youtubeBlockReason } from '../packages/connectors/src/youtube-podcasts.js';
import {
  ensureYoutubePodcastSchedule,
  runYoutubePodcastRound,
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
  assert.equal(config.creators.length, 11);
  assert.equal(config.creators[0].channels[0].kind, 'playlist');
  assert.equal(config.creators[0].channels[0].playlistId, 'PLe4PRejZgr0OJbRzA6nWybYiThLJd_ouz');
  assert.equal(config.creators.find((item) => item.id === 'valley101').channels.length, 2);
  assert.equal(config.creators.find((item) => item.id === 'xiaojun').prefer, 'zh');
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
    assert.equal(page.some((row) => row.provider === 'youtube'), true);
    const hourly = await createTreeMaterialPort({
      feedService: { listContentItemsInWindow: () => page },
    }).candidates('local', { startAt: 0, endAt: Date.now() + 60_000 });
    assert.equal(hourly.some((row) => row.provider === 'youtube'), false);

    let secondProbe = 0;
    await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
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
  assert.match(formatPodcastSummary(SUMMARY, { focus: '金融' }), /与关注方向的关系：和金融相关/);
  assert.equal(latestSchemaVersion(), 86);
  assert.deepEqual(unusedSchemaVersions, [63, 79, 80, 82]);
});
