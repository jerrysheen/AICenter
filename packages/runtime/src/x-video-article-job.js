import { mkdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describeAudioTranscription, planAudioTranscription } from '../../domain/src/audio-transcription.js';
import { youtubeArticleDailyLimit, youtubePodcastClock } from '../../domain/src/youtube-podcasts.js';
import {
  parseXStatusId,
  shanghaiArticleDay,
  stampTranscriptSegments,
  xVideoArticleDailyLimit,
  xVideoArticleEnabled,
  xVideoArticleMinSec,
  xVideoArticleSlots,
  xVideoCaptureMetadata,
} from '../../domain/src/x-video-articles.js';
import { allowedMediaUrl, fetchXVideoMedia, selectLongVideo } from '../../connectors/src/x/video-media.js';
import { runProcess } from '../../connectors/src/youtube-podcasts.js';
import { executeAudioTranscription } from './audio-transcription-job.js';
import { organizeGemmaTranscript, resumeArticleTitle } from './youtube-article-job.js';

const PROBE_LIMIT = 8;
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const STALE_MS = 3 * 60 * 60 * 1000;
const TRANSCRIBE_MESSAGE = '正在转写，完成后开始整理';

function emptyStats() {
  return { ready: 0, pending: 0, skipped: 0, discovered: 0, stopped: '', dailyLimit: 0 };
}

function releaseMissingTranscriber(deps, repository, row, workspaceId) {
  if (row?.sourceTranscript) return row;
  if (!/transcribe is not a function/.test(String(row?.reason || ''))) return row;
  if (typeof deps.geminiTranscribe !== 'function' && typeof deps.transcribeAudio !== 'function') return row;
  const state = holdOf(row);
  delete state.holdDay;
  delete state.holdReason;
  return repository.saveArticle({
    workspaceId,
    videoId: row.videoId,
    status: 'pending',
    reason: '',
    attempts: 0,
    articleState: JSON.stringify(state),
  }) || row;
}

function holdOf(row) {
  try {
    const parsed = JSON.parse(row?.articleState || '');
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function markHold(repository, row, workspaceId, day, reason) {
  const state = holdOf(row);
  state.holdDay = day;
  state.holdReason = reason;
  const articleState = JSON.stringify(state);
  repository.saveArticle({
    workspaceId,
    videoId: row.videoId,
    articleState,
    articleStatus: row.articleStatus || 'pending',
    status: 'pending',
  });
  row.articleState = articleState;
  row.status = 'pending';
}

function safeName(videoId) {
  const name = String(videoId || '').replace(/[^A-Za-z0-9_-]/g, '_');
  if (!name || name.length > 80) throw new Error('视频编号无效');
  return name;
}

async function downloadMp4(url, file, fetchImpl, signal) {
  if (!allowedMediaUrl(url)) throw new Error('视频地址不在允许的主机上');
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal,
    headers: { accept: 'video/mp4' },
  });
  if (!allowedMediaUrl(response.url || url)) throw new Error('视频地址跳到了不允许的主机');
  if (!response.ok) throw new Error(`视频下载失败 ${response.status}`);
  let received = 0;
  const body = response.body;
  if (!body) throw new Error('视频下载没有内容');
  const source = Readable.fromWeb(body);
  source.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_MEDIA_BYTES) {
      source.destroy(new Error('视频文件过大'));
    }
  });
  await pipeline(source, createWriteStream(file));
}

async function extractWav(deps, mp4, wav, durationSec, signal) {
  if (typeof deps.extractAudio === 'function') {
    await deps.extractAudio({ mp4, wav, durationSec, signal });
    return;
  }
  const timeoutMs = Math.min(30 * 60_000, Math.max(120_000, (Number(durationSec) || 60) * 2000));
  const result = await (deps.runProcess || runProcess)(deps.ffmpeg || 'ffmpeg', [
    '-y', '-i', mp4, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav,
  ], { timeoutMs, signal });
  if (result.code !== 0) throw new Error('音频抽取失败');
}

async function transcribeFile(deps, { workspaceId, relativePath, durationSec, signal, env }) {
  if (typeof deps.transcribeAudio === 'function') {
    return deps.transcribeAudio({ workspaceId, relativePath, durationSec, signal });
  }
  const durationMs = Math.max(1000, Math.round(Number(durationSec) || 1) * 1000);
  const plan = describeAudioTranscription(env, durationMs);
  const request = {
    input: {
      workspaceId,
      path: relativePath,
      languageCodes: ['en'],
      mode: 'SMART',
      plan,
    },
    dataDirectory: deps.dataDirectory,
    env,
    quotaRepository: deps.quotaRepository,
    signal,
  };
  const transcribe = typeof deps.geminiTranscribe === 'function' ? deps.geminiTranscribe : executeAudioTranscription;
  return transcribe(request);
}

async function writeTranscript(deps, row, media, workspaceId, signal, env) {
  if (typeof deps.transcribeAudio === 'function' && deps.skipMedia) {
    const result = await deps.transcribeAudio({ row, media, signal });
    return stampTranscriptSegments(result?.segments) || String(result?.text || '').trim();
  }
  const directory = path.join(deps.dataDirectory, 'tmp', 'x-videos', safeName(row.videoId));
  await mkdir(directory, { recursive: true });
  const mp4 = path.join(directory, 'audio.mp4');
  const wav = path.join(directory, 'audio.wav');
  const relativePath = path.posix.join('tmp', 'x-videos', safeName(row.videoId), 'audio.wav');
  try {
    const fetchImpl = deps.fetch || globalThis.fetch;
    if (typeof deps.downloadMedia === 'function') await deps.downloadMedia({ url: media.variant.url, file: mp4, signal });
    else await downloadMp4(media.variant.url, mp4, fetchImpl, signal);
    await extractWav(deps, mp4, wav, Math.ceil(media.durationMs / 1000), signal);
    const result = await transcribeFile(deps, {
      workspaceId,
      relativePath,
      durationSec: Math.ceil(media.durationMs / 1000),
      signal,
      env,
    });
    return stampTranscriptSegments(result?.segments) || String(result?.text || '').trim();
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function loadMedia(deps, tweetId, signal) {
  if (typeof deps.loadMedia === 'function') return deps.loadMedia(tweetId, signal);
  return fetchXVideoMedia(tweetId, { fetch: deps.fetch, signal });
}

async function probeRow(deps, row, workspaceId, signal, env) {
  const minSec = xVideoArticleMinSec(env);
  const ownId = parseXStatusId(String(row.videoId || '').startsWith('tweet:')
    ? String(row.videoId).slice('tweet:'.length)
    : String(row.videoId || '').split(':')[0]);
  const quoteId = parseXStatusId(row.quotedTweetId);
  const own = ownId ? await loadMedia(deps, ownId, signal) : null;
  let quote = null;
  if (quoteId && quoteId !== ownId) quote = await loadMedia(deps, quoteId, signal);
  const selected = selectLongVideo({
    video: own?.video || null,
    quote: quote?.video || own?.quote || null,
  }, minSec);
  if (selected.source === 'short' || selected.source === 'none') {
    deps.repository.saveArticle({
      workspaceId,
      videoId: row.videoId,
      status: 'skipped',
      reason: selected.source === 'short' ? 'short' : 'no-video',
      durationSec: selected.durationMs ? Math.round(selected.durationMs / 1000) : row.durationSec,
      articleDay: '',
    });
    return { status: 'skipped' };
  }
  const durationSec = Math.round(selected.durationMs / 1000);
  const existing = row.videoId !== selected.videoId
    ? deps.repository.article(workspaceId, selected.videoId)
    : null;
  if (existing) {
    deps.repository.rekey(workspaceId, row.videoId, selected.videoId);
    if (row.tweetId) {
      deps.repository.savePost({
        workspaceId,
        tweetId: row.tweetId,
        videoId: selected.videoId,
        quotedTweetId: row.quotedTweetId || '',
        contentItemId: row.contentItemId || '',
        sourceUrl: row.sourceUrl || '',
      });
    }
    const done = existing.status === 'ready' && existing.articleStatus === 'ready';
    return { status: done ? 'skipped' : 'pending', row: existing };
  }
  const rebound = deps.repository.rekey(workspaceId, row.videoId, selected.videoId, {
    durationSec,
    status: 'pending',
    reason: '',
  });
  if (row.tweetId) {
    deps.repository.savePost({
      workspaceId,
      tweetId: row.tweetId,
      videoId: selected.videoId,
      quotedTweetId: row.quotedTweetId || '',
      contentItemId: row.contentItemId || '',
      sourceUrl: row.sourceUrl || '',
    });
  }
  return { status: 'pending', row: rebound || deps.repository.article(workspaceId, selected.videoId) };
}

async function organizeRow(deps, row, workspaceId, day, signal, env) {
  const result = await organizeGemmaTranscript({
    row,
    repository: deps.repository,
    feedRepository: deps.feedRepository,
    workspaceId,
    day,
    signal,
    env,
    deps: { ...deps, keepFeedBody: true, signal },
  });
  if (result.status === 'ready') {
    deps.repository.saveArticle({
      workspaceId,
      videoId: row.videoId,
      status: 'ready',
      articleStatus: 'ready',
      articleBody: row.articleBody,
      articleTitle: row.articleTitle,
      articleState: row.articleState,
      articleDay: row.articleDay || day,
      sourceTranscript: row.sourceTranscript,
      sourceHash: row.sourceHash,
      attempts: 0,
      reason: '',
    });
  } else {
    deps.repository.saveArticle({
      workspaceId,
      videoId: row.videoId,
      status: 'pending',
      articleStatus: row.articleStatus || 'pending',
      articleState: row.articleState,
      articleDay: row.articleDay || day,
      sourceTranscript: row.sourceTranscript,
      sourceHash: row.sourceHash,
    });
  }
  return result;
}

async function workRow(deps, row, workspaceId, day, signal, env, manual) {
  const repository = deps.repository;
  if (!row.sourceTranscript) {
    const claimed = repository.claim(workspaceId, row.videoId, ['pending'], 'transcribing', manual ? day : (row.articleDay || day));
    if (!claimed) return { status: 'pending', reason: 'busy' };
    const minSec = xVideoArticleMinSec(env);
    const media = {
      videoId: row.videoId,
      durationMs: Math.max(1, Number(row.durationSec) || 0) * 1000,
      variant: row.variant,
    };
    let loaded = row.media || null;
    if (!loaded && typeof deps.loadMedia === 'function') {
      const ownId = String(row.videoId || '').split(':')[0];
      const parsed = await deps.loadMedia(ownId, signal);
      const selected = selectLongVideo(parsed, minSec);
      if (selected.source !== 'own' && selected.source !== 'quote') {
        repository.saveArticle({ workspaceId, videoId: row.videoId, status: 'skipped', reason: 'short', articleDay: '' });
        return { status: 'skipped' };
      }
      loaded = selected;
    }
    if (!loaded?.variant?.url && !deps.skipMedia) {
      const ownId = String(row.videoId || '').split(':')[0];
      const parsed = await loadMedia(deps, /^\d{5,}$/.test(ownId) ? ownId : '', signal);
      const selected = selectLongVideo(parsed, minSec);
      if (!selected.variant) throw new Error('没有可用的视频');
      loaded = selected;
    }
    const transcript = await writeTranscript(deps, row, loaded || media, workspaceId, signal, env);
    if (!transcript) throw new Error('转写是空的');
    repository.saveArticle({
      workspaceId,
      videoId: row.videoId,
      status: 'pending',
      sourceTranscript: transcript,
      attempts: 0,
      reason: '',
      articleDay: row.articleDay || day,
    });
    row.sourceTranscript = transcript;
    row.status = 'pending';
  }
  return organizeRow(deps, repository.article(workspaceId, row.videoId) || row, workspaceId, day, signal, env);
}

function rememberCapture(repository, workspaceId, capture) {
  const hint = xVideoCaptureMetadata({ xVideo: capture.xVideo, externalId: capture.tweetId });
  if (!hint) return false;
  const videoId = `tweet:${hint.tweetId}`;
  repository.savePost({
    workspaceId,
    tweetId: hint.tweetId,
    videoId,
    contentItemId: capture.contentItemId || '',
    quotedTweetId: hint.quoteTweetId,
    sourceUrl: capture.sourceUrl || `https://x.com/i/status/${hint.tweetId}`,
  });
  if (!repository.article(workspaceId, videoId)) {
    repository.saveArticle({
      workspaceId,
      videoId,
      status: 'probe',
      manual: 0,
    });
  }
  return true;
}

export async function runXVideoArticlePass(deps = {}) {
  const env = deps.env || process.env;
  const stats = emptyStats();
  if (!xVideoArticleEnabled(env)) return stats;
  const repository = deps.repository;
  if (!repository) return stats;
  const workspaceId = deps.workspaceId || 'local';
  const now = Number(deps.now) || Date.now();
  const day = shanghaiArticleDay(now, deps.timeZone || youtubePodcastClock(env).timeZone);
  const signal = deps.signal;
  repository.releaseStale?.(workspaceId, now - STALE_MS);
  if (!deps.tweetId) {
    for (const capture of repository.listNewCaptures(workspaceId, PROBE_LIMIT)) {
      if (signal?.aborted) break;
      if (rememberCapture(repository, workspaceId, capture)) stats.discovered += 1;
    }
    for (const row of repository.listByStatus(workspaceId, ['probe'], PROBE_LIMIT)) {
      if (signal?.aborted) {
        stats.stopped = 'deadline';
        break;
      }
      try {
        const probed = await probeRow(deps, row, workspaceId, signal, env);
        if (probed.status === 'skipped') stats.skipped += 1;
      } catch (error) {
        repository.saveArticle({
          workspaceId,
          videoId: row.videoId,
          status: 'probe',
          reason: String(error?.message || error).slice(0, 160),
        });
        console.warn(`[worker] x-video 没有读到视频信息：${String(error?.message || error).slice(0, 160)}`);
      }
    }
  }
  for (const row of repository.listTitleRetries?.(workspaceId, PROBE_LIMIT) || []) {
    if (signal?.aborted) break;
    try {
      await resumeArticleTitle({
        row,
        repository,
        feedRepository: deps.feedRepository,
        workspaceId,
        deps: { ...deps, keepFeedBody: true, signal },
      });
    } catch (error) {
      console.warn(`[worker] x-video 标题没有写成：${String(error?.message || error).slice(0, 160)}`);
    }
  }
  const sharedLimit = youtubeArticleDailyLimit(env);
  const xLimit = xVideoArticleDailyLimit(env);
  const rows = deps.tweetId
    ? [repository.articleForTweet(workspaceId, deps.tweetId)].filter(Boolean)
    : repository.listWork(workspaceId);
  for (const row of rows) {
    if (signal?.aborted) {
      stats.stopped = 'deadline';
      break;
    }
    if (!row?.videoId || row.status === 'skipped' || row.status === 'ready') {
      if (row?.status === 'ready') stats.skipped += 1;
      continue;
    }
    const current = releaseMissingTranscriber(deps, repository, row, workspaceId);
    const saved = holdOf(current);
    if (saved.holdDay === day && saved.holdReason) {
      stats.pending += 1;
      if (saved.holdReason === 'daily-limit') stats.dailyLimit += 1;
      continue;
    }
    if (current.status === 'probe' || !current.durationSec) {
      try {
        const probed = await probeRow(deps, current, workspaceId, signal, env);
        if (probed.status !== 'pending') {
          stats.skipped += 1;
          continue;
        }
        Object.assign(current, probed.row || {});
      } catch (error) {
        stats.pending += 1;
        console.warn(`[worker] x-video 没有读到视频信息：${String(error?.message || error).slice(0, 160)}`);
        continue;
      }
    }
    const manual = Boolean(deps.manual || current.manual);
    if (current.articleDay !== day) {
      const remaining = xVideoArticleSlots({
        sharedLimit,
        xLimit,
        youtubeUsed: Number(deps.youtubeRepository?.countArticleDay?.(workspaceId, day)) || 0,
        xUsed: repository.countArticleDay(workspaceId, day),
        manual,
      });
      if (remaining <= 0) {
        markHold(repository, current, workspaceId, day, 'daily-limit');
        stats.dailyLimit += 1;
        stats.pending += 1;
        continue;
      }
      repository.saveArticle({ workspaceId, videoId: current.videoId, articleDay: day, status: 'pending' });
      current.articleDay = day;
    }
    try {
      const result = await workRow(deps, current, workspaceId, day, signal, env, manual);
      if (result.status === 'ready') stats.ready += 1;
      else if (result.status === 'skipped') stats.skipped += 1;
      else stats.pending += 1;
      if (result.stopPass || result.stopDay) {
        stats.stopped = result.reason || 'blocked';
        break;
      }
    } catch (error) {
      const attempts = (Number(current.attempts) || 0) + 1;
      if (attempts >= 3) markHold(repository, current, workspaceId, day, 'failed');
      repository.saveArticle({
        workspaceId,
        videoId: current.videoId,
        status: 'pending',
        attempts,
        reason: String(error?.message || error).slice(0, 160),
        articleDay: current.articleDay || day,
      });
      stats.pending += 1;
      console.warn(`[worker] x-video 整理没有完成：${String(error?.message || error).slice(0, 160)}`);
    }
  }
  return stats;
}

export async function runXVideoArticleTweet(deps, tweetId) {
  return runXVideoArticlePass({ ...deps, tweetId: parseXStatusId(tweetId), manual: true });
}

export function xVideoChunkCount(durationMs, laneCount = 1) {
  return planAudioTranscription({ durationMs, laneCount }).chunkCount;
}

export { TRANSCRIBE_MESSAGE };
