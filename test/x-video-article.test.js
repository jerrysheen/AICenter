import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { planAudioTranscription } from '../packages/domain/src/audio-transcription.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { createAuthorService } from '../packages/domain/src/author-service.js';
import { createXVideoService } from '../packages/domain/src/x-video-service.js';
import {
  parseXStatusId,
  X_VIDEO_ARTICLE_JOB_TYPE,
  shanghaiArticleDay,
  stampTranscriptSegments,
  xVideoArticleDailyLimit,
  xVideoArticleEnabled,
  xVideoArticleMinSec,
  xVideoArticleSlots,
  xVideoCaptureMetadata,
} from '../packages/domain/src/x-video-articles.js';
import {
  allowedMediaUrl,
  fetchXVideoMedia,
  parseSyndicationTweet,
  pickXVideoVariant,
  selectLongVideo,
  xVideoFromExtract,
  xVideoIdFromUrl,
} from '../packages/connectors/src/x/video-media.js';
import { buildTweetExtractExpression, createXHomeBrowserClient } from '../packages/connectors/src/x/home-browser.js';
import { tweetToFeedItem } from '../packages/connectors/src/x/home-timeline.js';
import { runXVideoArticlePass, xVideoChunkCount } from '../packages/runtime/src/x-video-article-job.js';
import { runYoutubeArticlePass } from '../packages/runtime/src/youtube-article-job.js';
import { isApiTokenAllowlisted } from '../apps/web/src/http/api-token-access.js';
import { xPostHasVideo, xVideoArticleRequestPath, xVideoReaderScopeLabel, xVideoTweetId } from '../apps/web/public/x-video-article.js';

const TWEET = '2111105654211608847';
const FIXTURE = {
  id_str: TWEET,
  mediaDetails: [{
    type: 'video',
    expanded_url: `https://x.com/MilesCranmer/status/${TWEET}/video/1`,
    video_info: {
      duration_millis: 3_335_700,
      variants: [
        { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/1/pl/playlist.m3u8' },
        { bitrate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/amplify_video/1/360.mp4' },
        { bitrate: 256000, content_type: 'video/mp4', url: 'https://video.twimg.com/amplify_video/1/270.mp4' },
        { bitrate: 2176000, content_type: 'video/mp4', url: 'https://evil.example/steal.mp4' },
        { bitrate: 1000, content_type: 'video/mp4', url: 'http://video.twimg.com/not-https.mp4' },
      ],
    },
  }],
  text: 'How to avoid AI brain rot. A lecture.',
  user: { id_str: '999001', name: 'Miles Cranmer', screen_name: 'MilesCranmer' },
  quoted_tweet: {
    id_str: '2110683420217286882',
    mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/photo.jpg' }],
  },
};

function openStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'x-video-article-'));
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

function gemmaGenerate({ system, prompt }) {
  const text = String(system || '');
  if (text.includes('partIds')) {
    const ids = [...String(prompt || '').matchAll(/"i":(\d+)/g)].map((match) => Number(match[1]));
    const partIds = ids.length ? [...new Set(ids)] : [0];
    return {
      text: JSON.stringify({
        chapters: [{
          title: '开场说明（00:00:00）',
          start: '00:00:00',
          partIds,
          oneLiner: '讲座说明怎样避免被人工智能带偏',
          bullets: ['按时间保留判断力'],
        }],
      }),
    };
  }
  if (text.includes('"zh"') || text.includes('hint')) {
    return { text: JSON.stringify({ zh: '这是按原文顺序译出的一句话。', hint: ['保留判断力'], topic: '开场说明' }) };
  }
  if (text.includes('标题')) return { text: '如何避免人工智能把判断力带偏' };
  if (text.includes('对话') || text.includes('小节')) return { text: '## 开场说明（00:00:01）\n\n**主持人**：这是一段关于判断力的说明。' };
  return { text: '这是按原文顺序译出的一句话。' };
}

const TRANSCRIPT = `[00:00:01] Hello there, this is a complete sentence about judgment.
[00:00:08] This is another sentence about avoiding a rotten habit.`;

test('lowest mp4 on video.twimg.com is kept and other hosts are dropped', () => {
  const picked = pickXVideoVariant(FIXTURE.mediaDetails[0].video_info.variants);
  assert.equal(picked.url, 'https://video.twimg.com/amplify_video/1/270.mp4');
  assert.equal(picked.bitrate, 256000);
  assert.equal(allowedMediaUrl('https://user:pass@video.twimg.com/a.mp4'), false);
  assert.equal(allowedMediaUrl('https://evil.example/a.mp4'), false);
  const parsed = parseSyndicationTweet(FIXTURE, TWEET);
  assert.equal(parsed.video.videoId, `${TWEET}:1`);
  assert.equal(parsed.video.durationMs, 3_335_700);
  assert.equal(parsed.quote, null);
  assert.equal(parsed.text, 'How to avoid AI brain rot. A lecture.');
  assert.equal(parsed.author.handle, 'MilesCranmer');
  assert.equal(parsed.author.name, 'Miles Cranmer');
  assert.equal(parsed.author.restId, '999001');
  assert.equal(xVideoIdFromUrl(`https://x.com/MilesCranmer/status/${TWEET}/video/1`), `${TWEET}:1`);
  const selected = selectLongVideo(parsed, 15 * 60);
  assert.equal(selected.source, 'own');
  assert.equal(selectLongVideo({ video: { ...parsed.video, durationMs: 30_000 } }, 15 * 60).source, 'short');
});

test('syndication fetch does not send cookies', async () => {
  let seen = null;
  const parsed = await fetchXVideoMedia(TWEET, {
    fetch: async (url, options) => {
      seen = { url: String(url), headers: options.headers };
      return { ok: true, url: String(url), json: async () => FIXTURE };
    },
  });
  assert.match(seen.url, /^https:\/\/cdn\.syndication\.twimg\.com\/tweet-result\?/);
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.headers.Cookie, undefined);
  assert.equal(parsed.video.variant.bitrate, 256000);
});

test('quote video is identified separately and the public tweet hides has_video', async () => {
  const hint = xVideoFromExtract({
    tweet_id: TWEET,
    has_video: true,
    quote_has_video: true,
    quote_tweet_id: '2110683420217286882',
  });
  assert.deepEqual(hint, { tweetId: TWEET, own: true, quoteTweetId: '2110683420217286882' });
  const item = tweetToFeedItem({ tweet_id: TWEET, text: '讲座', author_handle: 'MilesCranmer', x_video: hint });
  assert.equal(item.xVideo.quoteTweetId, '2110683420217286882');
  assert.equal('has_video' in item, false);
  new Function(buildTweetExtractExpression());
  const runtime = {
    async withSession(_options, callback) {
      return callback({
        async navigate() {},
        async evaluate(expression) {
          if (String(expression).includes('tweetText')) {
            return {
              items: [{
                tweet_id: '1234567890',
                tweet_url: 'https://x.com/user/status/1234567890',
                text: '看这段',
                has_video: true,
                own_has_video: true,
                author_handle: 'user',
              }],
            };
          }
          return { url: 'https://x.com/home', title: 'Home', logged_in: true, login_wall: false };
        },
      });
    },
  };
  const client = createXHomeBrowserClient({ browserRuntime: runtime, delay: async () => {} });
  const result = await client.fetchHomeTimeline({ feed: 'for-you', limit: 1 });
  assert.equal('has_video' in result.tweets[0], false);
  assert.equal(result.tweets[0].x_video.own, true);
  assert.match(result.tweets[0].text, /\[未抓取\] 视频/);
});

test('threshold, shared slots and transcript stamps', () => {
  assert.equal(xVideoArticleEnabled({}), true);
  assert.equal(xVideoArticleEnabled({ AI_CENTER_X_VIDEO_ARTICLE: '0' }), false);
  assert.equal(xVideoArticleMinSec({}), 15 * 60);
  assert.equal(xVideoArticleDailyLimit({}), 1);
  assert.equal(xVideoArticleSlots({ sharedLimit: 4, xLimit: 1, youtubeUsed: 2, xUsed: 0 }), 1);
  assert.equal(xVideoArticleSlots({ sharedLimit: 4, xLimit: 1, youtubeUsed: 2, xUsed: 1 }), 0);
  assert.equal(xVideoArticleSlots({ sharedLimit: 4, xLimit: 1, youtubeUsed: 2, xUsed: 1, manual: true }), 1);
  assert.equal(xVideoArticleSlots({ sharedLimit: 4, xLimit: 1, youtubeUsed: 3, xUsed: 1, manual: true }), 0);
  assert.equal(parseXStatusId(`https://x.com/MilesCranmer/status/${TWEET}`), TWEET);
  assert.equal(xVideoCaptureMetadata({ externalId: TWEET, xVideo: { tweetId: TWEET, own: true, quoteTweetId: 'nope' } }).quoteTweetId, '');
  const stamped = stampTranscriptSegments([{ startMs: 65_000, text: 'Hello\nthere' }]);
  assert.equal(stamped, '[00:01:05] Hello\n[00:01:05] there');
  assert.equal(xVideoChunkCount(56 * 60 * 1000), 7);
  assert.equal(planAudioTranscription({ durationMs: 3_335_700, laneCount: 1 }).chunkCount, 7);
  assert.equal(xVideoTweetId({ platform: 'x', id: `x:${TWEET}` }), TWEET);
  assert.equal(xPostHasVideo({ platform: 'x', id: `x:${TWEET}` }), false);
  assert.equal(xPostHasVideo({ platform: 'x', xVideo: true }), true);
  assert.equal(xPostHasVideo({ platform: 'x', xVideo: { own: true, tweetId: TWEET } }), true);
  assert.equal(xVideoArticleRequestPath(TWEET), `/api/v1/x-videos/${TWEET}/article`);
  assert.equal(isApiTokenAllowlisted('GET', `/api/v1/x-videos/${TWEET}/article`), true);
  assert.equal(isApiTokenAllowlisted('POST', '/api/v1/x-videos/article'), false);
});

test('a long X video is transcribed once, keeps the tweet body, and shares the daily slot', async () => {
  const opened = openStore();
  const env = {
    AI_CENTER_X_VIDEO_ARTICLE: '1',
    AI_CENTER_X_VIDEO_ARTICLE_DAILY: '1',
    AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: '4',
    AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '0',
  };
  try {
    const feed = opened.store.repositories.feed;
    const videos = opened.store.repositories.xVideos;
    const capture = feed.saveCapture({
      workspaceId: 'local',
      provider: 'x',
      externalId: TWEET,
      sourceUrl: `https://x.com/MilesCranmer/status/${TWEET}`,
      title: 'How to avoid AI Brain Rot',
      contentHash: 'hash-1',
      metadata: { xVideo: { tweetId: TWEET, own: true, quoteTweetId: '' } },
    });
    const item = feed.saveContentItem({
      workspaceId: 'local',
      captureId: capture.id,
      originType: 'subscription',
      contentType: 'post',
      title: 'How to avoid AI Brain Rot',
      body: '原帖不要被覆盖，这是推文正文。',
      sourceUrl: capture.sourceUrl,
      authorName: 'Miles Cranmer',
    });
    let downloads = 0;
    const stats = await runXVideoArticlePass({
      env,
      repository: videos,
      feedRepository: feed,
      youtubeRepository: opened.store.repositories.youtubePodcasts,
      workspaceId: 'local',
      dataDirectory: opened.directory,
      now: Date.parse('2026-10-20T04:00:00Z'),
      skipMedia: true,
      loadMedia: async () => parseSyndicationTweet(FIXTURE, TWEET),
      transcribeAudio: async () => {
        downloads += 1;
        return { segments: [{ startMs: 0, text: 'Hello there, this is a complete sentence about judgment.' }] };
      },
      gemmaGenerate,
      flashGenerate: null,
    });
    assert.equal(stats.ready, 1);
    assert.equal(downloads, 1);
    const article = videos.article('local', `${TWEET}:1`);
    assert.equal(article.status, 'ready');
    assert.match(article.articleBody, /章节总结/);
    assert.match(article.articleBody, /这是按原文顺序译出的一句话/);
    assert.equal(article.articleBody.includes('### 对话'), false);
    assert.equal(article.articleTitle, '如何避免人工智能把判断力带偏');
    assert.match(article.sourceTranscript, /^\[00:00:00\]/);
    assert.equal(feed.getContentItem('local', item.id).body, '原帖不要被覆盖，这是推文正文。');
    const service = createXVideoService({ repository: videos, store: opened.store, env });
    const full = service.get('local', TWEET);
    assert.equal(full.title, article.articleTitle);
    const again = await runXVideoArticlePass({
      env,
      repository: videos,
      feedRepository: feed,
      workspaceId: 'local',
      dataDirectory: opened.directory,
      skipMedia: true,
      loadMedia: async () => parseSyndicationTweet(FIXTURE, TWEET),
      transcribeAudio: async () => { downloads += 1; return { text: TRANSCRIPT }; },
      gemmaGenerate,
      flashGenerate: null,
    });
    assert.equal(again.ready, 0);
    assert.equal(downloads, 1);
    const quoteTweet = '2110683420217286001';
    feed.saveCapture({
      workspaceId: 'local',
      provider: 'x',
      externalId: quoteTweet,
      sourceUrl: `https://x.com/someone/status/${quoteTweet}`,
      title: '引用',
      contentHash: 'hash-2',
      metadata: { xVideo: { tweetId: quoteTweet, own: false, quoteTweetId: TWEET } },
    });
    await runXVideoArticlePass({
      env,
      repository: videos,
      feedRepository: feed,
      workspaceId: 'local',
      dataDirectory: opened.directory,
      skipMedia: true,
      loadMedia: async (id) => (id === quoteTweet
        ? { video: null, quote: null }
        : parseSyndicationTweet(FIXTURE, TWEET)),
      transcribeAudio: async () => { downloads += 1; return { text: TRANSCRIPT }; },
      gemmaGenerate,
      flashGenerate: null,
    });
    assert.equal(videos.post('local', quoteTweet).videoId, `${TWEET}:1`);
    assert.equal(downloads, 1);
    assert.equal(videos.postsForVideo('local', `${TWEET}:1`).length, 2);
  } finally {
    opened.close();
  }
});

test('X sub-cap holds automatic videos while manual backfill still uses a shared slot', async () => {
  const opened = openStore();
  const env = {
    AI_CENTER_X_VIDEO_ARTICLE: '1',
    AI_CENTER_X_VIDEO_ARTICLE_DAILY: '1',
    AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: '4',
  };
  const day = shanghaiArticleDay(Date.parse('2026-10-20T04:00:00Z'));
  try {
    const videos = opened.store.repositories.xVideos;
    videos.savePost({ workspaceId: 'local', tweetId: '1000000000000000001', videoId: '1000000000000000001:1', sourceUrl: 'https://x.com/i/status/1000000000000000001' });
    videos.saveArticle({
      workspaceId: 'local',
      videoId: '1000000000000000001:1',
      status: 'pending',
      durationSec: 3600,
      articleDay: day,
      sourceTranscript: TRANSCRIPT,
      manual: 0,
    });
    videos.savePost({ workspaceId: 'local', tweetId: '1000000000000000002', videoId: '1000000000000000002:1', sourceUrl: 'https://x.com/i/status/1000000000000000002' });
    videos.saveArticle({
      workspaceId: 'local',
      videoId: '1000000000000000002:1',
      status: 'pending',
      durationSec: 3600,
      manual: 0,
    });
    videos.savePost({ workspaceId: 'local', tweetId: '1000000000000000003', videoId: '1000000000000000003:1', sourceUrl: 'https://x.com/i/status/1000000000000000003' });
    videos.saveArticle({
      workspaceId: 'local',
      videoId: '1000000000000000003:1',
      status: 'pending',
      durationSec: 3600,
      manual: 1,
      sourceTranscript: TRANSCRIPT,
    });
    let transcribed = 0;
    const stats = await runXVideoArticlePass({
      env,
      repository: videos,
      feedRepository: opened.store.repositories.feed,
      youtubeRepository: { countArticleDay: () => 0 },
      workspaceId: 'local',
      now: Date.parse('2026-10-20T04:00:00Z'),
      skipMedia: true,
      transcribeAudio: async () => { transcribed += 1; return { text: TRANSCRIPT }; },
      gemmaGenerate,
      flashGenerate: null,
    });
    assert.equal(transcribed, 0);
    assert.ok(stats.ready >= 1);
    const held = videos.article('local', '1000000000000000002:1');
    assert.match(held.articleState, /daily-limit/);
    const manual = videos.article('local', '1000000000000000003:1');
    assert.equal(manual.status, 'ready');
    const service = createXVideoService({ repository: videos, store: opened.store, env });
    const queued = service.status('local', '1000000000000000002', Date.parse('2026-10-20T04:00:00Z'));
    assert.match(queued.article.message, /今天的整理名额已用完/);
    videos.saveArticle({
      workspaceId: 'local',
      videoId: '1000000000000000002:1',
      articleState: JSON.stringify({ holdDay: day, holdReason: 'failed' }),
      articleStatus: 'pending',
      status: 'pending',
    });
    assert.match(service.status('local', '1000000000000000002', Date.parse('2026-10-20T04:00:00Z')).article.message, /整理失败/);
    videos.saveArticle({ workspaceId: 'local', videoId: '1000000000000000002:1', status: 'skipped', reason: 'short' });
    assert.equal(service.status('local', '1000000000000000002', Date.parse('2026-10-20T04:00:00Z')), null);
  } finally {
    opened.close();
  }
});

test('youtube daily slots count X videos that already took a day', async () => {
  const saved = [];
  await runYoutubeArticlePass({
    env: {
      AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1',
      AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: '4',
      AI_CENTER_X_VIDEO_ARTICLE: '0',
    },
    now: Date.parse('2026-10-20T04:00:00Z'),
    repository: {
      countArticleDay: () => 0,
      listArticleCandidates: () => [{
        videoId: 'abcdefghijk',
        articleStatus: '',
        articleDay: '',
        status: 'ready',
        sourceTranscript: TRANSCRIPT,
        publishedAt: Date.parse('2026-10-20T00:00:00Z'),
        ingestedAt: Date.parse('2026-10-20T00:00:00Z'),
      }],
      saveEpisode: (row) => saved.push(row),
    },
    feedRepository: {},
    xVideoRepository: { countArticleDay: () => 4 },
  });
  assert.equal(saved.length, 1);
  assert.match(saved[0].articleState, /daily-limit/);
});

test('operator can enqueue one tweet', async () => {
  const opened = openStore();
  try {
    const service = createXVideoService({
      repository: opened.store.repositories.xVideos,
      store: opened.store,
      env: { AI_CENTER_X_VIDEO_ARTICLE: '1' },
    });
    const queued = await service.enqueue('local', { url: `https://x.com/MilesCranmer/status/${TWEET}` });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.jobCreated, true);
    assert.equal(opened.store.repositories.xVideos.article('local', `tweet:${TWEET}`).manual, 1);
    const again = await service.enqueue('local', { tweetId: TWEET });
    assert.equal(again.jobId, queued.jobId);
    assert.equal(again.jobCreated, false);
  } finally {
    opened.close();
  }
});

test('backfill writes the missing post and author without a second job', async () => {
  const opened = openStore();
  try {
    const videos = opened.store.repositories.xVideos;
    const feed = opened.store.repositories.feed;
    const hold = JSON.stringify({ holdReason: 'daily-limit', holdDay: '2026-10-20' });
    videos.savePost({
      workspaceId: 'local',
      tweetId: TWEET,
      videoId: `tweet:${TWEET}`,
      contentItemId: '',
      sourceUrl: `https://x.com/i/status/${TWEET}`,
    });
    videos.saveArticle({
      workspaceId: 'local',
      videoId: `tweet:${TWEET}`,
      status: 'pending',
      articleStatus: 'pending',
      manual: 1,
      articleState: hold,
    });
    const first = opened.store.createJob({
      type: X_VIDEO_ARTICLE_JOB_TYPE,
      workspaceId: 'local',
      maxAttempts: 1,
      input: { workspaceId: 'local', tweetId: TWEET, manual: true },
    });
    opened.store.cancelJob(first.id);
    feed.saveCapture({
      workspaceId: 'local',
      provider: 'x',
      externalId: 'quiet-one',
      sourceUrl: 'https://x.com/quiet/status/quiet-one',
      title: '只有一条',
      contentHash: 'quiet-hash',
      publishedAt: Date.now(),
      authorNativeId: '888',
      metadata: { authorProfile: { authorId: 'x:888', platform: 'x', nativeId: '888', handle: 'quiet', name: '安静作者', kind: 'person' } },
    });
    const quietCapture = feed.getCapture('local', 'x', 'quiet-one');
    feed.saveContentItem({
      workspaceId: 'local',
      captureId: quietCapture.id,
      originType: 'subscription',
      contentType: 'post',
      title: '只有一条',
      body: '这条不够两条，也不在长视频里。',
      sourceUrl: quietCapture.sourceUrl,
      authorName: '安静作者',
      publishedAt: Date.now(),
    });
    const service = createXVideoService({
      repository: videos,
      feedRepository: feed,
      store: opened.store,
      loadMedia: async () => parseSyndicationTweet(FIXTURE, TWEET),
      env: { AI_CENTER_X_VIDEO_ARTICLE: '1' },
    });
    const repaired = await service.enqueue('local', { tweetId: TWEET });
    assert.equal(repaired.jobCreated, false);
    assert.equal(repaired.jobId, '');
    assert.equal(opened.store.listJobsByType(X_VIDEO_ARTICLE_JOB_TYPE).length, 1);
    assert.equal(videos.article('local', `tweet:${TWEET}`).articleState, hold);
    assert.equal(repaired.authorId, 'x:999001');
    const reader = createFeedService({
      legacyRepository: { listPosts() { return []; }, getPost() { return null; } },
      feedRepository: feed,
      feedFilter: { config: { mode: 'enforce', rule: 'all-three-0.60' } },
      sourcePort: { findByProvider() { return null; }, persistence() { return null; }, async read() { return { data: null }; } },
    });
    const item = reader.getLocalizedContentItem('local', `x:${TWEET}`);
    assert.equal(item.authorName, 'Miles Cranmer');
    assert.match(item.body, /brain rot/);
    assert.equal(item.authorId, 'x:999001');
    const found = reader.searchContentItems('local', 'Miles Cranmer');
    assert.equal(found.some((row) => row.authorName === 'Miles Cranmer'), true);
    const listed = feed.listContentItemsByProvider('local', 'x', {
      sourceExternalId: 'x:home:following',
      qualityRule: 'all-three-0.60',
      limit: 20,
    });
    assert.equal(listed.some((row) => row.externalId === TWEET && row.authorName === 'Miles Cranmer'), true);
    const authors = opened.store.repositories.authors.listAuthors({ workspaceId: 'local', platform: 'x' });
    assert.equal(authors.others.some((row) => row.authorId === 'x:999001' && row.name === 'Miles Cranmer'), true);
    assert.equal(authors.others.some((row) => row.authorId === 'x:888'), false);
    const view = service.status('local', TWEET, Date.parse('2026-10-20T10:00:00Z'));
    assert.match(view.article.message, /今天的整理名额已用完/);
    const shortCapture = feed.saveCapture({
      workspaceId: 'local',
      provider: 'x',
      externalId: 'short-video',
      sourceUrl: 'https://x.com/short/status/short-video',
      title: '短视频',
      contentHash: 'short-hash',
      publishedAt: Date.now(),
      authorNativeId: '777',
      metadata: { authorProfile: { authorId: 'x:777', platform: 'x', nativeId: '777', handle: 'short', name: '短视频作者', kind: 'person' } },
    });
    const shortItem = feed.saveContentItem({
      workspaceId: 'local',
      captureId: shortCapture.id,
      originType: 'subscription',
      contentType: 'post',
      title: '短视频',
      body: '这条太短，不进作者列表。',
      sourceUrl: shortCapture.sourceUrl,
      authorName: '短视频作者',
      publishedAt: Date.now(),
    });
    videos.saveArticle({ workspaceId: 'local', videoId: 'tweet:shortvid', status: 'skipped', manual: 1 });
    videos.savePost({
      workspaceId: 'local',
      tweetId: '555001',
      videoId: 'tweet:shortvid',
      contentItemId: shortItem.id,
    });
    const afterSkip = opened.store.repositories.authors.listAuthors({ workspaceId: 'local', platform: 'x' });
    assert.equal(afterSkip.others.some((row) => row.authorId === 'x:777'), false);
    assert.equal(afterSkip.others.some((row) => row.authorId === 'x:999001'), true);
  } finally {
    opened.close();
  }
});

test('a link-only long video stays on the X feed with a Chinese title and no second job', async () => {
  const opened = openStore();
  try {
    const videos = opened.store.repositories.xVideos;
    const feed = opened.store.repositories.feed;
    const hold = JSON.stringify({ holdReason: 'daily-limit', holdDay: '2026-10-20' });
    const capture = feed.saveCapture({
      workspaceId: 'local',
      provider: 'x',
      externalId: TWEET,
      sourceUrl: `https://x.com/MilesCranmer/status/${TWEET}`,
      title: 'https://t.co/abc123XY',
      contentHash: 'link-only-hash',
      publishedAt: Date.now(),
      authorNativeId: '999001',
      metadata: {
        originalText: 'https://t.co/abc123XY',
        filterMode: 'enforce',
        filterDecision: 'KEEP',
        filterApplied: true,
        filterRule: 'all-three-0.60',
        filterReason: 'fallback-manual',
        authorHandle: '@MilesCranmer',
        authorProfile: {
          authorId: 'x:999001',
          platform: 'x',
          nativeId: '999001',
          handle: 'MilesCranmer',
          name: 'Miles Cranmer',
          kind: 'person',
        },
        xVideo: { tweetId: TWEET, own: true },
      },
    });
    feed.saveContentItem({
      workspaceId: 'local',
      captureId: capture.id,
      originType: 'subscription',
      contentType: 'post',
      title: 'https://t.co/abc123XY',
      body: 'https://t.co/abc123XY',
      summary: 'https://t.co/abc123XY',
      sourceUrl: capture.sourceUrl,
      authorName: 'Miles Cranmer',
      publishedAt: Date.now(),
    });
    videos.savePost({
      workspaceId: 'local',
      tweetId: TWEET,
      videoId: `tweet:${TWEET}`,
      contentItemId: '',
      sourceUrl: capture.sourceUrl,
    });
    videos.saveArticle({
      workspaceId: 'local',
      videoId: `tweet:${TWEET}`,
      status: 'pending',
      articleStatus: 'pending',
      manual: 1,
      articleState: hold,
    });
    const service = createXVideoService({
      repository: videos,
      feedRepository: feed,
      store: opened.store,
      loadMedia: async () => parseSyndicationTweet({ ...FIXTURE, text: 'https://t.co/abc123XY' }, TWEET),
      env: { AI_CENTER_X_VIDEO_ARTICLE: '1' },
    });
    const repaired = await service.enqueue('local', { tweetId: TWEET });
    assert.equal(repaired.jobCreated, false);
    assert.equal(opened.store.listJobsByType(X_VIDEO_ARTICLE_JOB_TYPE).length, 0);
    assert.equal(videos.article('local', `tweet:${TWEET}`).articleState, hold);
    const item = feed.getContentItemByCapture('local', capture.id);
    assert.equal(item.title, '视频待整理');
    assert.equal(item.summary, '视频待整理');
    assert.match(item.body, /t\.co\/abc123XY/);
    assert.equal(item.authorName, 'Miles Cranmer');
    const savedCapture = feed.getCapture('local', 'x', TWEET);
    assert.equal(Boolean(savedCapture.sourceAccountId), true);
    const listed = feed.listContentItemsByProvider('local', 'x', {
      sourceExternalId: 'x:home:following',
      qualityRule: 'all-three-0.60',
      limit: 20,
    });
    assert.equal(listed.some((row) => row.externalId === TWEET), true);
    const authors = createAuthorService({
      authorRepository: opened.store.repositories.authors,
      feedRepository: feed,
      qualityRule: 'all-three-0.60',
    });
    const page = authors.list({ workspaceId: 'local', platform: 'x' });
    const miles = page.others.find((row) => row.authorId === 'x:999001');
    assert.equal(miles?.name, 'Miles Cranmer');
    assert.equal(miles?.unreadCount, 1);
    assert.equal(miles?.latestTitleZh, '视频待整理');
    const again = await service.enqueue('local', { tweetId: TWEET });
    assert.equal(again.jobCreated, false);
    assert.equal(videos.article('local', `tweet:${TWEET}`).articleState, hold);
  } finally {
    opened.close();
  }
});

test('long video posts use the video label instead of a complete body tag', () => {
  assert.equal(xVideoReaderScopeLabel({ platform: 'x', xVideo: { tweetId: TWEET } }, null), '视频待整理');
  assert.equal(xVideoReaderScopeLabel({ platform: 'x' }, { articleStatus: 'pending', article: { status: 'queued' } }), '视频待整理');
  assert.equal(xVideoReaderScopeLabel({ platform: 'x' }, { articleStatus: 'ready', article: { status: 'ready' } }), '视频已整理');
  assert.equal(xVideoReaderScopeLabel({ platform: 'x', xVideo: true }, { absent: true }), null);
  assert.equal(xVideoReaderScopeLabel({ platform: 'x' }, null), null);
  assert.equal(xVideoReaderScopeLabel({ platform: 'media', complete: true }, null), null);
});
