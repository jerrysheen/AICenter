import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWav, planAudioTranscription } from '../packages/domain/src/audio-transcription.js';
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

test('worker assembly puts a live transcriber on x-video deps', () => {
  const worker = readFileSync(new URL('../apps/worker/src/worker.js', import.meta.url), 'utf8');
  const assembly = readFileSync(new URL('../packages/runtime/src/x-video-transcribe.js', import.meta.url), 'utf8');
  assert.match(worker, /assembleXVideoTranscribeDeps\(/);
  assert.match(assembly, /createGeminiLiveTranscriber\(/);
  assert.match(assembly, /createGeminiAudioTranscriber\(/);
  assert.equal(assembly.includes('WebSocket'), false);
  assert.equal(assembly.includes('wss://'), false);
  const deps = assembleXVideoTranscribeDeps({
    env: { GEMINI_API_KEY: 'assembly-key' },
  });
  assert.equal(typeof deps.geminiTranscribe, 'function');
  assert.equal(typeof deps.geminiFileTranscribe, 'function');
  const plan = planAudioTranscription({ durationMs: 3_336_000, laneCount: 1 });
  assert.equal(plan.chunkCount >= 2, true);
  for (const chunk of plan.chunks) {
    assert.equal(chunk.endMs - chunk.startMs <= 10 * 60 * 1000, true);
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
    let fileCalls = 0;
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
      geminiTranscribe: async (input) => {
        liveCalls += 1;
        assert.equal(input.apiKey, 'assembly-key');
        assert.equal(String(input.apiKey).includes('AIza'), false);
        return 'Here is the full talk, sentence one.';
      },
      geminiFileTranscribe: async () => {
        fileCalls += 1;
        return 'file fallback';
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
    assert.equal(fileCalls, 0);
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
