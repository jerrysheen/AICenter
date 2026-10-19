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
import { createAuthorService } from '../packages/domain/src/author-service.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { youtubePodcastLimits } from '../packages/domain/src/youtube-podcasts.js';
import { createResearchRecallService } from '../packages/domain/src/research-recall-service.js';
import {
  probeYoutubeEpisode,
  resolveYoutubeChannelId,
  runProcess,
  chooseSubtitle,
  finishAudioFile,
  vttToTranscript,
  youtubeBlockReason,
  youtubeErrorText,
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
    assert.equal(page.some((row) => row.provider === 'youtube'), false);
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
  const originalAuto = chooseSubtitle([
    { name: 'id.zh-Hans.auto.vtt', text: '翻译字幕' },
    { name: 'id.en-orig.auto.vtt', text: 'original speech' },
  ], { language: '', subtitles: {}, automatic_captions: { 'zh-Hans': [{}], 'en-orig': [{}] } });
  assert.equal(originalAuto.source, 'subtitle-auto');
  assert.equal(originalAuto.text, 'original speech');
  const translatedOnly = chooseSubtitle([
    { name: 'id.zh-Hans.auto.vtt', text: '翻译字幕' },
  ], { language: '', subtitles: {}, automatic_captions: { 'zh-Hans': [{}] } });
  assert.equal(translatedOnly.text, '');
  assert.match(formatPodcastSummary(SUMMARY, { focus: '金融' }), /与关注方向的关系：和金融相关/);
  assert.equal(latestSchemaVersion(), 86);
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
        return {
          code: 0,
          stdout: JSON.stringify(info),
          stderr: 'about: $429 billion\ntoo many requests appears in the description',
          missing: false,
        };
      },
    });
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
        run: async () => {
          writeFileSync(path.join(directory, item.videoId, 'clip.en.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello rates\n');
          return {
            code: 0,
            stdout: JSON.stringify({ ...info, subtitles: { en: [{}] } }),
            stderr: '$429 billion',
            missing: false,
          };
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
  assert.equal(capped.stdout.length, 256 * 1024);
  assert.equal(capped.stderr.length, 256 * 1024);
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
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
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
  } finally {
    opened.close();
  }
});
