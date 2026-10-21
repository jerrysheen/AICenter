import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWav, describeAudioTranscription, planAudioTranscription } from '../packages/domain/src/audio-transcription.js';
import { shanghaiArticleDay } from '../packages/domain/src/x-video-articles.js';
import { parseSyndicationTweet } from '../packages/connectors/src/x/video-media.js';
import { createStore } from '../packages/database/src/index.js';
import { X_VIDEO_ARTICLE_JOB_TYPE } from '../packages/domain/src/x-video-articles.js';
import { runXVideoArticlePass } from '../packages/runtime/src/x-video-article-job.js';
import { assembleXVideoTranscribeDeps } from '../packages/runtime/src/x-video-transcribe.js';
import { createYoutubePodcastJobHandlers } from '../packages/runtime/src/youtube-podcasts-job.js';

const TWEET = '2111105654211608847';
const FIXTURE = {
  id_str: TWEET,
  mediaDetails: [{
    type: 'video',
    video_info: {
      duration_millis: 3_336_000,
      variants: [
        { bitrate: 256000, content_type: 'video/mp4', url: 'https://video.twimg.com/amplify_video/1/270.mp4' },
      ],
    },
  }],
  text: 'Here is the full talk',
  user: { id_str: '382008009', name: 'Miles Cranmer', screen_name: 'MilesCranmer' },
};

function openStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'x-video-transcribe-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    directory,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = {};
    FakeSocket.opened.push(this);
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  emit(type, event) {
    for (const fn of this.listeners[type] || []) fn(event);
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.setup) {
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ setupComplete: {} }) }));
    }
    if (message.realtimeInput?.audioStreamEnd) {
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({ serverContent: { inputTranscription: { text: '前半句' }, turnComplete: true } }),
      }));
    }
  }

  close() {}
}
FakeSocket.opened = [];

class FailingSocket extends FakeSocket {
  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.setup) {
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({ error: { message: 'live down' } }),
      }));
    }
  }
}

function sampleRequest(directory, env) {
  const relative = 'tmp/sample.wav';
  const absolute = path.join(directory, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, buildWav(Buffer.alloc(16_000 * 2), {
    channels: 1, sampleRate: 16_000, bitsPerSample: 16, blockAlign: 2,
  }));
  return {
    input: {
      workspaceId: 'local',
      path: relative,
      languageCodes: ['en'],
      mode: 'SMART',
      plan: describeAudioTranscription(env, 1_000),
    },
    dataDirectory: directory,
    env,
    now: () => Date.parse('2026-10-21T18:00:00Z'),
    sleep: async () => {},
  };
}

test('x-video deps use the live-first transcription job, not the file transcriber', async () => {
  const worker = readFileSync(new URL('../apps/worker/src/worker.js', import.meta.url), 'utf8');
  const assembly = readFileSync(new URL('../packages/runtime/src/x-video-transcribe.js', import.meta.url), 'utf8');
  const job = readFileSync(new URL('../packages/runtime/src/x-video-article-job.js', import.meta.url), 'utf8');
  assert.match(worker, /assembleXVideoTranscribeDeps\(/);
  assert.match(assembly, /executeAudioTranscription\(/);
  assert.equal(assembly.includes('createGeminiAudioTranscriber'), false);
  assert.equal(job.includes('createGeminiAudioTranscriber'), false);
  assert.equal(/fileTranscribe\s*:/.test(assembly), false);
  assert.equal(/fileTranscribe\s*:/.test(job), false);
  const plan = planAudioTranscription({ durationMs: 3_336_000, laneCount: 1 });
  assert.equal(plan.chunkCount >= 2, true);
  for (const chunk of plan.chunks) {
    assert.equal(chunk.endMs - chunk.startMs <= 10 * 60 * 1000, true);
  }

  const env = {
    GEMINI_API_KEY: 'assembly-key',
    AI_CENTER_AUDIO_TRANSCRIBE_LIVE_MODEL: 'gemini-3.5-transcribe-live',
    AI_CENTER_AUDIO_TRANSCRIBE_MODEL: 'gemini-3.5-transcribe',
  };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'x-video-live-'));
  const reserves = [];
  const quotaRepository = {
    reserve(input) {
      reserves.push(input);
      return { admitted: true, keyEnv: 'GEMINI_API_KEY' };
    },
    release() {},
  };
  const previousSocket = globalThis.WebSocket;
  const previousFetch = globalThis.fetch;
  FakeSocket.opened = [];
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = async () => {
    throw new Error('file transcriber was called');
  };
  try {
    const deps = assembleXVideoTranscribeDeps({ env });
    assert.equal(typeof deps.geminiTranscribe, 'function');
    assert.equal('geminiFileTranscribe' in deps && typeof deps.geminiFileTranscribe === 'function', false);
    const result = await deps.geminiTranscribe({
      ...sampleRequest(directory, env),
      quotaRepository,
    });
    assert.equal(result.text, '前半句');
    assert.equal(reserves.length, 1);
    assert.equal(reserves[0].model, 'gemini-3.5-transcribe-live');
    assert.equal(reserves[0].requestsPerDay, Infinity);
    assert.equal(FakeSocket.opened[0].sent[0].setup.model, 'models/gemini-3.5-transcribe-live');
    assert.equal(JSON.stringify(FakeSocket.opened[0].sent).includes('assembly-key'), false);
  } finally {
    globalThis.WebSocket = previousSocket;
    globalThis.fetch = previousFetch;
    rmSync(directory, { recursive: true, force: true });
  }

  const failedDir = mkdtempSync(path.join(os.tmpdir(), 'x-video-file-'));
  const failedReserves = [];
  globalThis.WebSocket = FailingSocket;
  try {
    const deps = assembleXVideoTranscribeDeps({ env });
    await assert.rejects(() => deps.geminiTranscribe({
      ...sampleRequest(failedDir, env),
      quotaRepository: {
        reserve(input) {
          failedReserves.push(input);
          return { admitted: true, keyEnv: 'GEMINI_API_KEY' };
        },
        release() {},
      },
    }));
    assert.equal(failedReserves[0].model, 'gemini-3.5-transcribe-live');
    assert.equal(failedReserves[0].requestsPerDay, Infinity);
    assert.equal(failedReserves[1].model, 'gemini-3.5-transcribe');
    assert.equal(failedReserves[1].requestsPerDay, 24);
    assert.equal(failedReserves[1].estimatedTokensPerMinute, 10_000);
  } finally {
    globalThis.WebSocket = previousSocket;
    globalThis.fetch = previousFetch;
    rmSync(failedDir, { recursive: true, force: true });
  }
});

test('the x-video job calls the assembled transcriber and retries a missing-function failure', async () => {
  const opened = openStore();
  const now = Date.parse('2026-10-21T02:00:00Z');
  const day = shanghaiArticleDay(now);
  const env = {
    GEMINI_API_KEY: 'assembly-key',
    AI_CENTER_X_VIDEO_ARTICLE: '1',
    AI_CENTER_X_VIDEO_ARTICLE_DAILY: '1',
    AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: '4',
  };
  try {
    const videos = opened.store.repositories.xVideos;
    videos.savePost({
      workspaceId: 'local',
      tweetId: TWEET,
      videoId: `${TWEET}:1`,
      sourceUrl: `https://x.com/MilesCranmer/status/${TWEET}`,
    });
    videos.saveArticle({
      workspaceId: 'local',
      videoId: `${TWEET}:1`,
      status: 'pending',
      durationSec: 3336,
      articleDay: day,
      attempts: 3,
      reason: 'transcribe is not a function',
      articleState: JSON.stringify({ holdDay: day, holdReason: 'failed' }),
    });
    let liveCalls = 0;
    const deps = assembleXVideoTranscribeDeps({
      env,
      repository: opened.store.repositories.youtubePodcasts,
      xVideoRepository: videos,
      feedRepository: opened.store.repositories.feed,
      quotaRepository: {
        reserve() { return { admitted: true, keyEnv: 'GEMINI_API_KEY' }; },
        release() {},
      },
      dataDirectory: opened.directory,
      geminiTranscribe: async (request) => {
        liveCalls += 1;
        assert.equal(request.transcribe, undefined);
        assert.equal(request.fileTranscribe, undefined);
        assert.equal(request.env.GEMINI_API_KEY, 'assembly-key');
        assert.equal(String(request.env.GEMINI_API_KEY).includes('AIza'), false);
        return { text: 'Here is the full talk, sentence one.' };
      },
      loadMedia: async () => parseSyndicationTweet(FIXTURE, TWEET),
      downloadMedia: async () => {},
      extractAudio: async ({ wav }) => {
        writeFileSync(wav, buildWav(Buffer.alloc(16_000 * 2), {
          channels: 1, sampleRate: 16_000, bitsPerSample: 16, blockAlign: 2,
        }));
      },
      gemmaGenerate: async () => ({ text: '## 要点\n- 演讲按时间展开。' }),
    });
    assert.equal(typeof deps.geminiTranscribe, 'function');
    const handlers = createYoutubePodcastJobHandlers(deps);
    await handlers[X_VIDEO_ARTICLE_JOB_TYPE]({ workspaceId: 'local', tweetId: TWEET }, {});
    assert.equal(liveCalls, 1);
    assert.equal(/transcribe is not a function/.test(videos.article('local', `${TWEET}:1`).reason || ''), false);

    videos.saveArticle({
      workspaceId: 'local',
      videoId: `${TWEET}:1`,
      status: 'pending',
      sourceTranscript: '',
      durationSec: 3336,
      articleDay: day,
      attempts: 3,
      reason: 'transcribe is not a function',
      articleState: JSON.stringify({ holdDay: day, holdReason: 'failed' }),
    });
    let retried = 0;
    await runXVideoArticlePass({
      env,
      repository: videos,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      now,
      geminiTranscribe: async () => 'kept',
      skipMedia: true,
      transcribeAudio: async () => {
        retried += 1;
        return { text: 'Here is the full talk, sentence one.' };
      },
    });
    assert.equal(retried, 1);
  } finally {
    opened.close();
  }
});
