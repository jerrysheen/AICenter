import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createRuntimeService } from '../packages/domain/src/runtime-service.js';
import { createYoutubePodcastService } from '../packages/domain/src/youtube-podcasts-service.js';
import { describeYoutubeArticle, partialArticleBody } from '../packages/domain/src/youtube-article-status.js';
import { zonedParts } from '../packages/domain/src/zoned-time.js';
import {
  nextYoutubeArticleOpportunity,
  nextYoutubeArticleSlot,
  nextZonedDayStart,
  previousYoutubeArticleOpportunity,
  youtubeArticleDailyLimit,
} from '../packages/domain/src/youtube-podcasts.js';
import { isApiTokenAllowlisted } from '../apps/web/src/http/api-token-access.js';
import { retireYoutubeTranslationJobs } from '../packages/runtime/src/feed-translation-module.js';
import { runYoutubeArticlePass } from '../packages/runtime/src/youtube-article-job.js';
import { ensureYoutubeArticleSchedule } from '../packages/runtime/src/youtube-podcasts-job.js';
import { createFeedRoutes } from '../apps/web/src/routes/feed-routes.js';

const MANUAL = `[00:01:00] Hello there, this is a complete sentence.
[00:01:04] This is a new sentence without any repeated words.
[00:01:08] Manual captions stay intact for the reader.`;

function openStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youtube-queue-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function episode(videoId, extra = {}) {
  return {
    workspaceId: 'local',
    videoId,
    creatorId: 'odd-lots',
    channelKey: 'odd-lots',
    title: videoId,
    status: 'ready',
    transcriptSource: 'subtitle-manual',
    articleStatus: 'pending',
    sourceTranscript: MANUAL,
    ...extra,
  };
}

function fakeDoubao() {
  const calls = [];
  return {
    calls,
    async ask(question) {
      calls.push(question);
      return {
        status: 'ok',
        reply_text: '## 开场（00:01:00）\n\n主持人：这一段已经整理成中文。\n本回答由AI生成，仅供参考，请仔细甄别。',
        page_url: 'https://www.doubao.com/chat/42',
        send_confirmed: true,
        reply_count_before: 1,
      };
    },
    async readReply() {
      return { status: 'ok', reply_text: '' };
    },
  };
}

test('article daily limit defaults to 4 and stays configurable', () => {
  assert.equal(youtubeArticleDailyLimit({}), 4);
  assert.equal(youtubeArticleDailyLimit({ AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: '6' }), 6);
  assert.equal(youtubeArticleDailyLimit({ AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: 'nope' }), 4);
});

test('catch-up slots stay on minute 10 and a blocked day waits until tomorrow', () => {
  const at = Date.parse('2026-10-20T02:00:00Z');
  const slot = nextYoutubeArticleSlot(at, { timeZone: 'Asia/Shanghai', everyHours: 3, minute: 10 });
  const parts = zonedParts(slot, 'Asia/Shanghai');
  assert.equal(parts.hour, 12);
  assert.equal(parts.minute, 10);
  const env = {
    AI_CENTER_YOUTUBE_PODCASTS: '1',
    AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1',
    AI_CENTER_YOUTUBE_PODCASTS_AT: '07:00',
    AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_EVERY_HOURS: '3',
  };
  assert.equal(nextYoutubeArticleOpportunity(at, env), slot);
  const tomorrow = nextYoutubeArticleOpportunity(nextZonedDayStart(at, 'Asia/Shanghai') - 1, env);
  const next = zonedParts(tomorrow, 'Asia/Shanghai');
  assert.equal(next.hour, 0);
  assert.equal(next.minute, 10);
  const queued = describeYoutubeArticle({
    articleStatus: 'pending',
    holdReason: 'daily-limit',
    done: 12,
    total: 27,
    nextAt: tomorrow,
    now: at,
  });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.message, '今天的整理名额已用完，将于明天 00:10 处理');
  assert.equal(queued.message.includes('排队中'), false);
  assert.equal(queued.message.includes('整理中'), false);
  const missed = describeYoutubeArticle({
    articleStatus: 'pending',
    overdue: true,
    nextAt: slot,
    now: at,
  });
  assert.equal(missed.message, '预计时间已过，将于 12:10 重试');
  assert.equal(missed.message.includes('排队中'), false);
  const last = previousYoutubeArticleOpportunity(Date.parse('2026-10-20T04:20:00Z'), env);
  assert.equal(zonedParts(last, 'Asia/Shanghai').hour, 12);
  assert.equal(zonedParts(last, 'Asia/Shanghai').minute, 10);
  const running = describeYoutubeArticle({ articleStatus: 'pending', done: 12, total: 27, nextAt: slot, now: at, active: true });
  assert.equal(running.status, 'running');
  assert.equal(running.message, '整理中 12/27 段');
  const idle = describeYoutubeArticle({ articleStatus: 'pending', done: 12, total: 27, nextAt: slot, now: at });
  assert.equal(idle.status, 'queued');
  assert.equal(idle.message, '已译 12/27 段，等待下一轮，12:10 继续');
  assert.equal(idle.message.includes('整理中'), false);
  const upstream = describeYoutubeArticle({
    articleStatus: 'pending',
    holdReason: 'upstream',
    done: 28,
    organized: 4,
    total: 28,
    nextAt: Date.parse('2026-10-21T00:10:00+08:00'),
    now: Date.parse('2026-10-20T21:45:00+08:00'),
  });
  assert.equal(upstream.status, 'queued');
  assert.equal(upstream.message, '已译 24/28 段，模型服务暂时出错，明天 00:10 继续');
  const quotaPause = describeYoutubeArticle({
    articleStatus: 'pending',
    holdReason: 'quota',
    done: 28,
    organized: 4,
    total: 28,
    nextAt: Date.parse('2026-10-21T00:10:00+08:00'),
    now: Date.parse('2026-10-20T21:45:00+08:00'),
  });
  assert.equal(quotaPause.status, 'queued');
  assert.equal(quotaPause.message, '已译 24/28 段，模型额度暂时用完，明天 00:10 继续');
  assert.equal(quotaPause.message.includes('整理失败'), false);
  const finishing = describeYoutubeArticle({
    articleStatus: 'pending',
    done: 28,
    organized: 28,
    total: 28,
    summary: '要点',
    titleStatus: 'pending',
    active: true,
  });
  assert.equal(finishing.status, 'running');
  assert.equal(finishing.message, '收尾中');
  const failed = describeYoutubeArticle({
    articleStatus: 'pending',
    holdReason: 'failed',
    nextAt: Date.parse('2026-10-20T23:00:00Z'),
    now: at,
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.message, '整理失败：模型没有整理完这一段，将于明天 7点 重试');
});

test('article catch-up schedule follows the switch and lands on minute 10', () => {
  const saved = [];
  const store = {
    upsertJobSchedule(input) {
      saved.push(input);
      return input;
    },
  };
  const now = Date.parse('2026-10-20T02:00:00Z');
  ensureYoutubeArticleSchedule(store, {
    AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1',
    AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_EVERY_HOURS: '3',
  }, now);
  assert.equal(saved[0].enabled, true);
  assert.equal(saved[0].jobType, 'youtube.podcasts.article');
  assert.equal(saved[0].schedule.kind, 'interval');
  assert.equal(saved[0].schedule.intervalMinutes, 180);
  assert.equal(zonedParts(saved[0].nextRunAt, 'Asia/Shanghai').minute, 10);
  ensureYoutubeArticleSchedule(store, { AI_CENTER_X_VIDEO_ARTICLE: '0' }, now);
  assert.equal(saved[1].enabled, false);
  ensureYoutubeArticleSchedule(store, { AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '0' }, now);
  assert.equal(saved[2].enabled, true);
});

test('a freshly ingested episode takes the daily slot ahead of an older pending one', async () => {
  const opened = openStore();
  const doubao = fakeDoubao();
  const now = Date.parse('2026-10-20T02:00:00Z');
  try {
    const repository = opened.store.repositories.youtubePodcasts;
    repository.saveEpisode(episode('stalevid0001', {
      publishedAt: Date.parse('2026-10-19T00:00:00Z'),
      createdAt: now - 10 * 24 * 60 * 60 * 1000,
    }));
    repository.saveEpisode(episode('freshvid0001', {
      publishedAt: Date.parse('2026-10-18T00:00:00Z'),
      createdAt: now - 60_000,
    }));
    const stats = await runYoutubeArticlePass({
      env: {
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1',
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_ENGINE: 'doubao',
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: '1',
      },
      repository,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      doubaoClient: doubao,
      gemmaGenerate: null,
      flashGenerate: null,
      now,
      dailyLimit: 1,
    });
    assert.equal(doubao.calls.length, 1);
    assert.equal(stats.ready, 1);
    assert.equal(stats.dailyLimit, 1);
    assert.equal(repository.episode('local', 'freshvid0001').articleStatus, 'ready');
    const held = repository.episode('local', 'stalevid0001');
    assert.equal(held.articleDay, '');
    assert.equal(held.articleStatus, 'pending');
    assert.equal(JSON.parse(held.articleState).holdReason, 'daily-limit');
  } finally {
    opened.close();
  }
});

test('episode list reports part progress without loading the article state blob', () => {
  const opened = openStore();
  try {
    const repository = opened.store.repositories.youtubePodcasts;
    repository.saveEpisode(episode('partsvideo01', {
      articleState: JSON.stringify({
        holdReason: 'daily-limit',
        holdDay: '2026-10-20',
        parts: [{ translation: '已完成' }, { reply: '' }, { translation: '', reply: '另一段' }],
      }),
    }));
    const listed = repository.listReady('local');
    assert.equal(listed[0].partsDone, 2);
    assert.equal(listed[0].partsTotal, 3);
    assert.equal(listed[0].holdReason, 'daily-limit');
    assert.equal(listed[0].articleState, '');
    const service = createYoutubePodcastService({
      repository,
      store: opened.store,
      configPath: path.join(os.tmpdir(), 'missing-youtube-podcasts.json'),
      env: {
        AI_CENTER_YOUTUBE_PODCASTS: '1',
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1',
        AI_CENTER_YOUTUBE_PODCASTS_AT: '07:00',
      },
    });
    const now = Date.parse('2026-10-20T04:00:00Z');
    const view = service.get('local', 'partsvideo01', now);
    assert.equal(view.article.status, 'queued');
    assert.equal(view.article.message, '今天的整理名额已用完，将于明天 00:10 处理');
    assert.equal(view.article.message.includes('排队中'), false);
    assert.equal(view.article.message.includes('整理中'), false);
    const status = service.status('local', 'partsvideo01', now);
    assert.equal(status.article.message, view.article.message);
    assert.equal(Object.hasOwn(status, 'body'), false);
    assert.match(status.partial.text, /已完成/);
    assert.match(status.partial.text, /另一段/);
    assert.equal(isApiTokenAllowlisted('GET', '/api/v1/youtube-podcasts/partsvideo01/article'), true);
  } finally {
    opened.close();
  }
});

test('partial article keeps finished sections and drops rolling caption repeats', () => {
  const rolling = [
    '[00:00:01] Hello there this is the start of the sentence',
    '[00:00:03] Hello there this is the start of the sentence and it continues',
    '[00:00:06] and it continues past the overlap',
  ].join('\n');
  const partial = partialArticleBody({
    parts: [
      { section: '## 开场（00:00:01）\n主持人：第一段已经整理好。', translation: rolling },
      { translation: rolling },
      { text: '[00:01:00] not translated yet' },
    ],
  });
  assert.equal(partial.shown, 2);
  assert.equal(partial.total, 3);
  assert.equal(partial.remaining, 1);
  assert.match(partial.text, /第一段已经整理好/);
  assert.equal(partial.text.includes('not translated yet'), false);
  assert.equal((partial.text.match(/Hello there this is the start of the sentence/g) || []).length, 1);
  const opened = openStore();
  try {
    const repository = opened.store.repositories.youtubePodcasts;
    repository.saveEpisode(episode('partialvid01', {
      articleStatus: 'pending',
      articleState: JSON.stringify({
        holdReason: 'upstream',
        holdDay: '',
        parts: [
          { section: '## 开场（00:00:01）\n主持人：已经整理的一段。' },
          { translation: rolling },
          { text: '还没译' },
        ],
      }),
    }));
    const service = createYoutubePodcastService({
      repository,
      store: opened.store,
      configPath: path.join(os.tmpdir(), 'missing-youtube-podcasts.json'),
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1' },
    });
    const status = service.status('local', 'partialvid01', Date.parse('2026-10-20T13:45:00Z'));
    assert.equal(Object.hasOwn(status, 'body'), false);
    assert.equal(status.partial.remaining, 1);
    assert.match(status.partial.text, /已经整理的一段/);
    assert.equal((status.partial.text.match(/Hello there this is the start of the sentence/g) || []).length, 1);
    repository.saveEpisode(episode('partialvid01', { articleStatus: 'ready' }));
    const ready = service.status('local', 'partialvid01', Date.parse('2026-10-20T13:45:00Z'));
    assert.equal(ready.articleStatus, 'ready');
    assert.equal(ready.partial, undefined);
  } finally {
    opened.close();
  }
});

test('a stopped round waits for the next slot unless the job lease is still fresh', () => {
  const opened = openStore();
  try {
    const repository = opened.store.repositories.youtubePodcasts;
    const now = Date.parse('2026-10-20T13:45:00Z');
    const touched = now - 60_000;
    const env = {
      AI_CENTER_YOUTUBE_PODCASTS: '1',
      AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1',
      AI_CENTER_YOUTUBE_PODCASTS_AT: '07:00',
      AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_EVERY_HOURS: '3',
    };
    repository.saveEpisode(episode('roundstop001', {
      articleState: JSON.stringify({
        holdReason: 'upstream',
        touchedAt: touched,
        summary: '',
        parts: [
          ...Array.from({ length: 4 }, () => ({ translation: '已整理', section: '## 小节' })),
          ...Array.from({ length: 24 }, () => ({ translation: '已译', section: '' })),
        ],
      }),
    }));
    repository.saveEpisode(episode('roundtail0001', {
      articleState: JSON.stringify({
        touchedAt: touched,
        summary: '',
        parts: Array.from({ length: 3 }, () => ({ translation: '译', section: '## 节' })),
      }),
    }));
    const service = (jobs) => createYoutubePodcastService({
      repository,
      store: { listOpenJobs: () => jobs },
      configPath: path.join(os.tmpdir(), 'missing-youtube-podcasts.json'),
      env,
    });
    const waiting = service([]).status('local', 'roundstop001', now);
    assert.equal(waiting.article.status, 'queued');
    assert.equal(waiting.article.message, '已译 24/28 段，模型服务暂时出错，明天 00:10 继续');
    const crashed = service([{ status: 'running', lockedAt: now - 10 * 60_000 }]).status('local', 'roundstop001', now);
    assert.equal(crashed.article.status, 'queued');
    assert.equal(crashed.article.message.includes('整理中'), false);
    const live = service([{ status: 'running', lockedAt: now - 20_000 }]).status('local', 'roundstop001', now);
    assert.equal(live.article.status, 'running');
    assert.equal(live.article.message, '整理中 4/28 段');
    const tail = service([{ status: 'running', lockedAt: now - 20_000 }]).status('local', 'roundtail0001', now);
    assert.equal(tail.article.status, 'running');
    assert.equal(tail.article.message, '收尾中');
    const tailIdle = service([]).status('local', 'roundtail0001', now);
    assert.equal(tailIdle.article.status, 'queued');
    assert.equal(tailIdle.article.message.includes('收尾中'), false);
  } finally {
    opened.close();
  }
});

test('a missed slot stops saying the episode is still queued', () => {
  const opened = openStore();
  try {
    const repository = opened.store.repositories.youtubePodcasts;
    const now = Date.parse('2026-10-20T04:20:00Z');
    repository.saveEpisode(episode('missedvideo1', { createdAt: Date.parse('2026-10-20T01:00:00Z') }));
    repository.saveEpisode(episode('freshvideo001', { createdAt: Date.parse('2026-10-20T04:15:00Z') }));
    const service = createYoutubePodcastService({
      repository,
      store: opened.store,
      configPath: path.join(os.tmpdir(), 'missing-youtube-podcasts.json'),
      env: {
        AI_CENTER_YOUTUBE_PODCASTS: '1',
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1',
        AI_CENTER_YOUTUBE_PODCASTS_AT: '07:00',
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_EVERY_HOURS: '3',
      },
    });
    const missed = service.status('local', 'missedvideo1', now);
    const fresh = service.status('local', 'freshvideo001', now);
    assert.equal(missed.article.message, '预计时间已过，将于 15:10 重试');
    assert.equal(missed.article.message.includes('排队中'), false);
    assert.equal(fresh.article.message, '中文整理排队中，预计 15:10 处理');
  } finally {
    opened.close();
  }
});

test('a stuck youtube translation is cancelled and not queued again', async () => {
  const opened = openStore();
  try {
    const store = opened.store;
    const job = store.createJob({
      type: 'feed.translation.run',
      workspaceId: 'local',
      maxAttempts: 4,
      input: { items: [{ id: 'youtube:abc12345', text: 'English transcript that should not be requeued.' }] },
    });
    const retired = retireYoutubeTranslationJobs(store, 'local');
    assert.equal(retired.cancelled, 1);
    assert.equal(store.getJob(job.id).status, 'cancelled');
    const runtime = createRuntimeService({ runtimeRepository: store });
    const again = runtime.requestTranslation({
      workspaceId: 'local',
      items: [{ id: 'youtube:abc12345', text: 'English transcript that should not be requeued.' }],
    });
    assert.equal(again.skipped, true);
    assert.equal(again.reason, 'youtube-article');
    assert.equal(store.listOpenJobs('feed.translation.run').length, 0);
    const route = createFeedRoutes().find((entry) => entry.path === '/api/v1/translate');
    const response = { statusCode: 0, body: null, writeHead(status) { this.statusCode = status; }, end(payload) { this.body = JSON.parse(String(payload)); } };
    await route.handler({
      request: (async function* body() {
        yield Buffer.from(JSON.stringify({ id: 'youtube:abc12345', text: 'English transcript that should not be requeued.', targetLang: 'zh' }));
      })(),
      response,
      identity: { device: { workspaceId: 'local' } },
      events: { flush() {} },
      services: { runtime },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error, 'YouTube 正文由整理任务处理');
  } finally {
    opened.close();
  }
});

test('the same chunk failing outright stops the translation job', () => {
  const opened = openStore();
  try {
    const store = opened.store;
    const job = store.createJob({
      type: 'feed.translation.run',
      workspaceId: 'local',
      maxAttempts: 4,
      input: { items: [{ id: 'feed-item-1', text: 'An ordinary English paragraph that can fail as one chunk.' }] },
    });
    const claimed = store.claimNextJob('worker-chunk', ['feed.translation.run']);
    assert.equal(claimed.id, job.id);
    const error = new Error('同一段连续失败，不再重试');
    error.code = 'translation-chunk-exhausted';
    store.failJob(claimed.id, error, 0, { workerId: 'worker-chunk', attemptCount: claimed.attemptCount });
    assert.equal(store.getJob(job.id).status, 'failed');
    assert.equal(store.getJob(job.id).attemptCount, 1);
  } finally {
    opened.close();
  }
});
