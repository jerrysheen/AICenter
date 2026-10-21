import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorCaptureFields } from '../../domain/src/authors.js';
import { nextDailyInstant } from '../../domain/src/zoned-time.js';
import {
  firstRunSlice,
  formatPodcastSummary,
  limitFirstRun,
  loadYoutubePodcastConfig,
  mergePodcastEntries,
  parsePodcastSummary,
  parseYoutubeRss,
  podcastBackfillDue,
  rssUrlForChannel,
  selectPodcastEpisodes,
  summaryNeedsChinese,
  watchUrl,
  nextYoutubeArticleSlot,
  youtubeArticleEnabled,
  youtubeArticleEveryHours,
  youtubePodcastClock,
  youtubePodcastLimits,
  youtubeRoundDeadlineMs,
  youtubePodcastsEnabled,
  YOUTUBE_ARTICLE_CATCHUP_MINUTE,
  YOUTUBE_ARTICLE_JOB_TYPE,
  YOUTUBE_ARTICLE_SCHEDULE_KEY,
  YOUTUBE_PODCAST_JOB_TYPE,
  YOUTUBE_PODCAST_SCHEDULE_KEY,
} from '../../domain/src/youtube-podcasts.js';
import { createGeminiInvestorSummarizer } from '../../connectors/src/investor-discussion-model.js';
import { createGemmaTranslationRouter } from '../../connectors/src/translate/gemma.js';
import {
  ensureYtDlpReady,
  fetchYoutubeText,
  listChannelLongVideos,
  prepareYoutubeTranscriber,
  probeYoutubeEpisode,
  resolveYoutubeChannelId,
  transcribeYoutubeAudio,
  youtubeBlockReason,
  youtubeTranscribeUnavailable,
} from '../../connectors/src/youtube-podcasts.js';
import { executeAudioTranscription } from './audio-transcription-job.js';
import { dedupeRollingCaptions, transcriptHash } from '../../domain/src/youtube-captions.js';
import { localizePodcastCopy, repairYoutubeChineseCopy, runYoutubeArticlePass } from './youtube-article-job.js';
import { runXVideoArticlePass, runXVideoArticleTweet } from './x-video-article-job.js';
import { xVideoArticleEnabled, X_VIDEO_ARTICLE_JOB_TYPE } from '../../domain/src/x-video-articles.js';
import { retireYoutubeTranslationJobs } from './feed-translation-module.js';

export { YOUTUBE_ARTICLE_JOB_TYPE, YOUTUBE_PODCAST_JOB_TYPE, YOUTUBE_PODCAST_SCHEDULE_KEY };

const SUMMARY_SYSTEM = `你是财经与科技播客的中文编辑。只根据给定文字稿写简体中文观点摘要，不要补充文字稿里没有的事实。
titleZh 必须是简体中文标题，不要保留英文节目标题。quotes.text 必须是简体中文，人名、公司名和股票代码可以留英文。
只输出 JSON，不要 Markdown 围栏：
{"titleZh":"中文标题","guests":["嘉宾"],"points":["核心观点，写 5 到 8 条"],"companies":["公司或股票代码"],"relation":"和关注方向的关系","quotes":[{"time":"HH:MM:SS","text":"关键句"}]}`;

export function ensureYoutubePodcastSchedule(store, env = process.env, now = Date.now()) {
  const clock = youtubePodcastClock(env);
  const enabled = youtubePodcastsEnabled(env);
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: YOUTUBE_PODCAST_SCHEDULE_KEY,
    jobType: YOUTUBE_PODCAST_JOB_TYPE,
    enabled,
    schedule: { kind: 'daily', timezone: clock.timeZone, hour: clock.hour, minute: clock.minute },
    input: {},
    priority: 0,
    maxAttempts: 1,
    nextRunAt: nextDailyInstant(now - 1, clock),
  });
}

export function ensureYoutubeArticleSchedule(store, env = process.env, now = Date.now()) {
  const clock = youtubePodcastClock(env);
  const everyHours = youtubeArticleEveryHours(env);
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: YOUTUBE_ARTICLE_SCHEDULE_KEY,
    jobType: YOUTUBE_ARTICLE_JOB_TYPE,
    enabled: youtubeArticleEnabled(env) || xVideoArticleEnabled(env),
    schedule: { kind: 'interval', intervalMinutes: everyHours * 60 },
    input: {},
    priority: 0,
    maxAttempts: 1,
    nextRunAt: nextYoutubeArticleSlot(now - 1, {
      timeZone: clock.timeZone,
      everyHours,
      minute: YOUTUBE_ARTICLE_CATCHUP_MINUTE,
    }),
  });
}

function logRound(stats) {
  const reasons = stats.reasons.length ? stats.reasons.join(',') : '-';
  console.log(`[worker] youtube-podcasts discovered=${stats.discovered} subtitles=${stats.subtitles} transcribed=${stats.transcribed} failed=${stats.failed} skipped=${stats.skipped} transcribeUnavailable=${stats.transcribeUnavailable} articles=${stats.articlesReady || 0} articlePending=${stats.articlePending || 0} articleHeld=${stats.articleHeld || 0} stopped=${stats.stopped || '-'} reasons=${reasons}`);
}

function emptyStats() {
  return {
    discovered: 0,
    subtitles: 0,
    transcribed: 0,
    failed: 0,
    skipped: 0,
    transcribeUnavailable: 0,
    stopped: '',
    reasons: [],
    articlesReady: 0,
    articlePending: 0,
    articleHeld: 0,
    status: 'ready',
  };
}

function retryTranscribeBug(repository, workspaceId, videoId) {
  const row = repository.episode(workspaceId, videoId);
  return /transcribe is not a function/.test(row?.reason || '');
}

function episodeSettled(repository, workspaceId, videoId) {
  if (retryTranscribeBug(repository, workspaceId, videoId)) return false;
  return repository.isDone(workspaceId, videoId);
}

function pushReason(stats, reason) {
  if (reason && !stats.reasons.includes(reason)) stats.reasons.push(reason);
}

const SUMMARY_CHUNK = 24_000;

function transcriptChunks(transcript) {
  const text = String(transcript || '');
  if (text.length <= 60_000) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > SUMMARY_CHUNK && chunks.length < 7) {
    let cut = rest.lastIndexOf('\n', SUMMARY_CHUNK);
    if (cut < Math.floor(SUMMARY_CHUNK / 2)) cut = SUMMARY_CHUNK;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function summaryPrompt(creator, title, transcript) {
  return `博主：${creator.name}\n关注方向：${creator.focus || '金融与 AI'}\n标题：${title}\n\n文字稿：\n${transcript}`;
}

export async function defaultFetchRss(url, fetchImpl, signal) {
  let response;
  let text = '';
  try {
    const loaded = await fetchYoutubeText(url, {
      fetchImpl,
      signal,
      headers: { 'user-agent': 'AICenter/0.2 youtube-podcasts', accept: 'application/atom+xml, application/xml, text/xml' },
    });
    response = loaded.response;
    text = loaded.text;
  } catch (error) {
    if (signal?.aborted) throw error;
    const timeout = new Error('RSS 超时');
    timeout.code = 'youtube-timeout';
    throw timeout;
  }
  if (response.ok) return { entries: parseYoutubeRss(text) };
  const blocked = response.status === 429 ? '429' : youtubeBlockReason(text);
  if (blocked) return { blocked, detail: text.slice(0, 180) };
  throw new Error(`RSS ${response.status}`);
}

function defaultSummarize(env, quotaRepository, signal) {
  const model = String(env.AI_CENTER_YOUTUBE_PODCASTS_SUMMARY_MODEL || '').trim();
  const summarize = createGeminiInvestorSummarizer({
    env,
    quotaRepository,
    usageStage: 'youtube-podcast-summary',
    signal,
    ...(model ? { model } : {}),
  });
  return async ({ title, creator, transcript }) => {
    const chunks = transcriptChunks(transcript);
    if (chunks.length === 1) {
      const result = await summarize({ system: SUMMARY_SYSTEM, prompt: summaryPrompt(creator, title, chunks[0]) });
      return parsePodcastSummary(result.text);
    }
    const parts = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const result = await summarize({
        system: SUMMARY_SYSTEM,
        prompt: `这是同一集的第 ${index + 1}/${chunks.length} 段，只摘要这一段。\n${summaryPrompt(creator, title, chunks[index])}`,
      });
      parts.push(result.text);
    }
    const merged = await summarize({
      system: SUMMARY_SYSTEM,
      prompt: `下面是同一集的分段摘要。合并成一份，核心观点保留 5 到 8 条，不要重复。\n\n${parts.join('\n\n')}`,
    });
    return parsePodcastSummary(merged.text);
  };
}

function defaultTranslate(env, quotaRepository, signal) {
  // 标题、摘要和关键句只用 Gemma 26B。正文整理另开翻译池调用，不走这个摘要翻译函数。
  const router = createGemmaTranslationRouter({
    env,
    models: 'gemma-4-26b-a4b-it',
    quotaRepository,
    signal,
  });
  return async (text) => {
    const result = await router.generate({
      model: 'gemma-4-26b-a4b-it',
      system: '把下面的播客摘要译成简体中文。保留人名、公司名、股票代码和数字，不要加评论。',
      prompt: text,
    });
    return String(result?.text || '').trim();
  };
}

export async function saveYoutubeEpisode({ feedRepository, workspaceId, creator, episode, summaryText, displayTitle, transcript, transcriptSource }) {
  const channel = creator.channels.find((item) => item.key === episode.channelKey) || creator.channels[0] || {};
  const account = feedRepository.upsertSourceAccount({
    workspaceId,
    provider: 'youtube',
    externalId: `creator:${creator.id}`,
    handle: channel.handle || creator.id,
    displayName: creator.name,
    profileUrl: channel.url || creator.channels[0]?.url || '',
    authMode: 'public',
    metadata: { creatorId: creator.id },
  });
  const authorFields = authorCaptureFields('youtube', {
    authorName: creator.name,
    authorHandle: channel.handle || creator.id,
    authorNativeId: creator.id,
    authorProfileUrl: channel.url || creator.channels[0]?.url || '',
  });
  const capture = feedRepository.saveCapture({
    workspaceId,
    provider: 'youtube',
    externalId: episode.videoId,
    sourceAccountId: account.id,
    sourceUrl: episode.url || watchUrl(episode.videoId),
    title: episode.title,
    contentHash: createHash('sha256').update(episode.videoId).digest('hex'),
    status: 'ready',
    publishedAt: episode.publishedAt || null,
    authorNativeId: authorFields?.authorNativeId || creator.id,
    metadata: {
      transcriptSource,
      durationSec: episode.durationSec || 0,
      creatorId: creator.id,
      channelKey: episode.channelKey,
      originalTitle: episode.title,
      youtubePodcast: true,
      ...(authorFields ? { authorProfile: authorFields.authorProfile } : {}),
    },
  });
  return feedRepository.saveContentItem({
    workspaceId,
    captureId: capture.id,
    originType: 'subscription',
    contentType: 'video',
    title: displayTitle || episode.title,
    body: String(transcript || '').slice(0, 2_000_000),
    summary: String(summaryText || '').slice(0, 20_000),
    sourceUrl: episode.url || watchUrl(episode.videoId),
    authorName: creator.name,
    publishedAt: episode.publishedAt || null,
  });
}

function attemptsOf(repository, workspaceId, videoId) {
  return repository.episode(workspaceId, videoId)?.attempts || 0;
}

function recordTranscribeUnavailable(stats, repository, workspaceId, creator, episode) {
  repository.saveEpisode({
    workspaceId,
    videoId: episode.videoId,
    creatorId: creator.id,
    channelKey: episode.channelKey,
    title: episode.title,
    durationSec: episode.durationSec,
    publishedAt: episode.publishedAt,
    status: 'failed',
    reason: 'transcribe-unavailable',
    attempts: attemptsOf(repository, workspaceId, episode.videoId),
  });
  stats.failed += 1;
  stats.transcribeUnavailable += 1;
  pushReason(stats, 'transcribe-unavailable');
}

function roundStop(error, signal) {
  if (error?.code === 'youtube-round-stop' || error?.reason === 'bot-check' || error?.reason === '429' || error?.reason === 'yt-dlp-outdated' || error?.reason === 'yt-dlp-missing') {
    return error.reason || 'bot-check';
  }
  if (signal?.aborted) return 'deadline';
  if (error?.status === 429 || error?.quota || error?.code === 'budget-deferred' || error?.code === 'quota') return '429';
  return '';
}

function rememberProbeFailure(stats, repository, workspaceId, creator, channelKey, entry, detail) {
  const reason = detail === 'probe-parse' ? 'probe-parse' : (detail || 'probe-failed');
  const attempts = attemptsOf(repository, workspaceId, entry.videoId) + 1;
  repository.saveEpisode({
    workspaceId,
    videoId: entry.videoId,
    creatorId: creator.id,
    channelKey: channelKey,
    title: entry.title,
    publishedAt: entry.publishedAt,
    status: attempts >= 3 ? 'skipped' : 'failed',
    reason: reason.slice(0, 180),
    attempts,
  });
  stats.failed += 1;
  pushReason(stats, reason === 'probe-parse' ? 'probe-parse' : 'probe-failed');
}

export async function runYoutubePodcastRound(deps = {}) {
  const env = deps.env || process.env;
  const stats = emptyStats();
  if (!youtubePodcastsEnabled(env)) {
    stats.status = 'disabled';
    logRound(stats);
    return stats;
  }
  const limits = { ...youtubePodcastLimits(env), ...(deps.limits || {}) };
  const config = deps.config || loadYoutubePodcastConfig(deps.configPath);
  const workspaceId = deps.workspaceId || 'local';
  const repository = deps.repository;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = AbortSignal.timeout(youtubeRoundDeadlineMs(limits.roundMs));
  const signal = deps.signal
    ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([deps.signal, deadline]) : deps.signal)
    : deadline;
  const fetchRss = deps.fetchRss || ((url) => defaultFetchRss(url, deps.fetchImpl || fetch, signal));
  const resolveChannel = deps.resolveChannel || ((handle) => resolveYoutubeChannelId({ handle, fetchImpl: deps.fetchImpl || fetch, signal }));
  const listVideos = deps.listVideos || ((channel) => listChannelLongVideos({
    channelId: channel.channelId,
    handle: channel.handle,
    env,
    run: deps.run,
    signal,
  }));
  const audioTranscribe = deps.audioTranscribe;
  const now = Number(deps.now) || Date.now();
  const timeZone = youtubePodcastClock(env).timeZone;
  let audioDisabled = false;
  try {
    prepareYoutubeTranscriber(env, audioTranscribe);
  } catch (error) {
    if (!youtubeTranscribeUnavailable(error)) throw error;
    audioDisabled = true;
    pushReason(stats, 'transcribe-unavailable');
    console.warn(`[worker] youtube-podcasts 转写器不可用，本轮只收有字幕的集：${String(error?.message || error).slice(0, 180)}`);
  }
  const probe = deps.probe;
  const transcribe = deps.transcribe;
  const summarize = deps.summarize || defaultSummarize(env, deps.quotaRepository, signal);
  const translate = deps.translate === undefined ? defaultTranslate(env, deps.quotaRepository, signal) : deps.translate;
  async function finishRound() {
    if (repository && deps.feedRepository) {
      try {
        await repairYoutubeChineseCopy({
          env,
          repository,
          feedRepository: deps.feedRepository,
          workspaceId,
          translate,
        });
      } catch (error) {
        console.warn(`[worker] youtube-podcasts 中文标题修复中断：${String(error?.message || error).slice(0, 160)}`);
      }
      try {
        const articles = await runYoutubeArticlePass({
          env,
          repository,
          feedRepository: deps.feedRepository,
          xVideoRepository: deps.xVideoRepository,
          workspaceId,
          doubaoClient: deps.doubaoClient,
          browserRuntime: deps.browserRuntime,
          quotaRepository: deps.quotaRepository,
          gemmaGenerate: deps.gemmaGenerate,
          flashGenerate: deps.flashGenerate,
          signal,
          now,
          timeZone,
        });
        if (deps.xVideoRepository) {
          const xArticles = await runXVideoArticlePass({
            env,
            repository: deps.xVideoRepository,
            feedRepository: deps.feedRepository,
            youtubeRepository: repository,
            quotaRepository: deps.quotaRepository,
            dataDirectory: deps.dataDirectory,
            workspaceId,
            signal,
            now,
            timeZone,
            gemmaGenerate: deps.gemmaGenerate,
            flashGenerate: deps.flashGenerate,
          });
          stats.articlesReady += xArticles.ready || 0;
          stats.articlePending += xArticles.pending || 0;
          stats.articleHeld += xArticles.dailyLimit || 0;
        }
        stats.articlesReady = articles.ready;
        stats.articlePending = articles.pending;
        stats.articleHeld = articles.dailyLimit || 0;
        if (articles.stopped) pushReason(stats, `article-${articles.stopped}`);
      } catch (error) {
        pushReason(stats, 'article');
        console.warn(`[worker] youtube-podcasts 正文整理中断：${String(error?.message || error).slice(0, 160)}`);
      }
    }
    logRound(stats);
    return stats;
  }
  const tempRoot = deps.dataDirectory
    ? path.join(deps.dataDirectory, 'tmp', 'youtube-podcasts')
    : path.join(os.tmpdir(), 'youtube-podcasts');
  if (!probe || deps.ytDlpVersion !== undefined) {
    const ready = await ensureYtDlpReady({
      env,
      run: deps.run,
      signal,
      ...(deps.ytDlpVersion !== undefined ? { versionText: String(deps.ytDlpVersion) } : {}),
    });
    if (ready?.blocked) {
      stats.stopped = ready.blocked;
      pushReason(stats, ready.blocked);
      return finishRound();
    }
  }
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(path.join(tempRoot, 'round-'));
  let processed = 0;
  let transcribedSec = 0;
  try {
    for (const creator of config.creators) {
      if (stats.stopped) break;
      const incoming = [];
      const freshChannels = new Set();
      for (const channel of creator.channels) {
        if (stats.stopped || processed >= limits.roundLimit) break;
        const state = repository.channel(workspaceId, channel.key);
        const needsBackfill = channel.kind === 'channel' && podcastBackfillDue(state, now, timeZone);
        if (!state.bootstrapped) freshChannels.add(channel.key);
        let channelId = String(channel.channelId || state.channelId || '').trim();
        if (channel.kind === 'channel' && channel.channelId && state.channelId !== channel.channelId) {
          repository.saveChannel(workspaceId, channel.key, { channelId: channel.channelId, bootstrapped: state.bootstrapped });
        }
        if (channel.kind === 'channel' && !channelId) {
          let resolved;
          try {
            resolved = await resolveChannel(channel.handle);
          } catch (error) {
            const stop = roundStop(error, signal);
            if (stop) {
              stats.stopped = stop;
              pushReason(stats, stop);
              break;
            }
            stats.failed += 1;
            pushReason(stats, 'channel-id');
            continue;
          }
          if (resolved?.blocked) {
            stats.stopped = resolved.blocked;
            pushReason(stats, resolved.blocked);
            break;
          }
          if (!resolved?.channelId) {
            stats.failed += 1;
            pushReason(stats, resolved?.detail || 'channel-id');
            continue;
          }
          channelId = resolved.channelId;
          repository.saveChannel(workspaceId, channel.key, { channelId, bootstrapped: state.bootstrapped });
          await sleep(limits.intervalMs);
        }
        let rss;
        try {
          rss = await fetchRss(rssUrlForChannel(channel, channelId));
        } catch (error) {
          const stop = roundStop(error, signal);
          if (stop) {
            stats.stopped = stop;
            pushReason(stats, stop);
            break;
          }
          stats.failed += 1;
          pushReason(stats, error?.code === 'youtube-timeout' ? 'timeout' : String(error?.message || error).slice(0, 120));
          continue;
        }
        if (rss?.blocked) {
          stats.stopped = rss.blocked;
          pushReason(stats, rss.blocked);
          break;
        }
        await sleep(limits.intervalMs);
        let entries = (rss?.entries || []).map((entry) => ({ ...entry, channelKey: channel.key, role: channel.role || '' }));
        let backfillListed = false;
        if (needsBackfill) {
          let listed;
          try {
            listed = await listVideos({ ...channel, channelId });
          } catch (error) {
            const stop = roundStop(error, signal);
            if (stop) {
              stats.stopped = stop;
              pushReason(stats, stop);
              break;
            }
            listed = { failed: true, detail: String(error?.message || error).slice(0, 120) };
          }
          if (listed?.blocked) {
            stats.stopped = listed.blocked;
            pushReason(stats, listed.blocked);
            break;
          }
          if (!listed || listed.failed) {
            repository.saveChannel(workspaceId, channel.key, {
              channelId,
              bootstrapped: state.bootstrapped,
              backfillAttempts: (state.backfillAttempts || 0) + 1,
              backfillFailedAt: now,
            });
            pushReason(stats, 'backfill');
          } else {
            backfillListed = true;
            freshChannels.add(channel.key);
            entries = mergePodcastEntries(entries, (listed.entries || []).map((entry) => ({
              ...entry,
              channelKey: channel.key,
              role: channel.role || '',
            })));
          }
          await sleep(limits.intervalMs);
        }
        const limitWindow = !state.bootstrapped || backfillListed;
        const slice = limitWindow
          ? firstRunSlice(entries, limits.lookback)
          : { probe: entries.filter((entry) => !episodeSettled(repository, workspaceId, entry.videoId)), ignore: [] };
        let finished = true;
        for (const entry of slice.probe) {
          if (stats.stopped || processed >= limits.roundLimit) {
            finished = false;
            break;
          }
          if (episodeSettled(repository, workspaceId, entry.videoId)) continue;
          if (signal?.aborted) {
            stats.stopped = 'deadline';
            pushReason(stats, 'deadline');
            finished = false;
            break;
          }
          const workDir = path.join(root, entry.videoId);
          const probed = probe
            ? await probe(entry)
            : await probeYoutubeEpisode({
              videoId: entry.videoId,
              url: watchUrl(entry.videoId),
              workDir,
              env,
              signal,
              language: channel.language || '',
            });
          if (probed?.blocked) {
            stats.stopped = probed.blocked;
            pushReason(stats, probed.blocked);
            finished = false;
            break;
          }
          await sleep(limits.intervalMs);
          const durationSec = Number(probed?.durationSec);
          if (probed?.failed || !Number.isFinite(durationSec) || durationSec <= 0) {
            rememberProbeFailure(stats, repository, workspaceId, creator, channel.key, entry, probed?.failed ? probed.detail : 'probe-parse');
            continue;
          }
          incoming.push({
            ...entry,
            title: probed.title || entry.title,
            durationSec,
            liveStatus: probed.liveStatus || '',
            url: watchUrl(entry.videoId),
            transcript: probed.transcript || '',
            transcriptSource: probed.transcriptSource || '',
            role: channel.role || '',
          });
          processed += 1;
        }
        if (limitWindow && finished && !stats.stopped) {
          for (const entry of slice.ignore) {
            if (repository.episode(workspaceId, entry.videoId)) continue;
            repository.saveEpisode({
              workspaceId,
              videoId: entry.videoId,
              creatorId: creator.id,
              channelKey: channel.key,
              title: entry.title,
              publishedAt: entry.publishedAt,
              status: 'skipped',
              reason: 'lookback',
              attempts: 1,
            });
            stats.skipped += 1;
          }
          repository.saveChannel(workspaceId, channel.key, {
            channelId,
            bootstrapped: true,
            ...(backfillListed ? { backfilledAt: now } : {}),
          });
        }
      }
      const existing = repository.listForDedup(workspaceId, creator.id);
      let decision = selectPodcastEpisodes({
        creator,
        incoming,
        existing,
        minDurationSec: config.minDurationSec,
      });
      if (freshChannels.size) {
        const keep = [];
        const extra = [];
        for (const channel of creator.channels) {
          const rows = decision.keep.filter((episode) => episode.channelKey === channel.key);
          if (!freshChannels.has(channel.key)) {
            keep.push(...rows);
            continue;
          }
          const limited = limitFirstRun(rows, limits.lookback);
          keep.push(...limited.keep);
          extra.push(...limited.extra);
        }
        decision = { keep, skip: [...decision.skip, ...extra] };
      }
      for (const episode of decision.skip) {
        if (repository.episode(workspaceId, episode.videoId)) continue;
        repository.saveEpisode({
          workspaceId,
          videoId: episode.videoId,
          creatorId: creator.id,
          channelKey: episode.channelKey,
          title: episode.title,
          durationSec: episode.durationSec,
          publishedAt: episode.publishedAt,
          status: 'skipped',
          reason: episode.reason || 'skipped',
          attempts: 1,
        });
        stats.skipped += 1;
      }
      for (const episode of decision.keep) {
        if (stats.stopped) break;
        stats.discovered += 1;
        try {
          let transcript = episode.transcript || '';
          let transcriptSource = episode.transcriptSource || '';
          if (signal?.aborted) {
            stats.stopped = 'deadline';
            pushReason(stats, 'deadline');
            break;
          }
          if (transcript) {
            stats.subtitles += 1;
          } else {
            const duration = Number(episode.durationSec || 0);
            if (duration > limits.episodeTranscribeSec) {
              repository.saveEpisode({
                workspaceId,
                videoId: episode.videoId,
                creatorId: creator.id,
                channelKey: episode.channelKey,
                title: episode.title,
                durationSec: episode.durationSec,
                publishedAt: episode.publishedAt,
                status: 'skipped',
                reason: 'transcribe-too-long',
                attempts: 1,
              });
              stats.skipped += 1;
              pushReason(stats, 'transcribe-too-long');
              continue;
            }
            if (transcribedSec > 0 && transcribedSec + duration > limits.transcribeSec) {
              repository.saveEpisode({
                workspaceId,
                videoId: episode.videoId,
                creatorId: creator.id,
                channelKey: episode.channelKey,
                title: episode.title,
                durationSec: episode.durationSec,
                publishedAt: episode.publishedAt,
                status: 'failed',
                reason: 'transcribe-budget',
                attempts: attemptsOf(repository, workspaceId, episode.videoId),
              });
              stats.failed += 1;
              pushReason(stats, 'transcribe-budget');
              continue;
            }
            if (audioDisabled) {
              recordTranscribeUnavailable(stats, repository, workspaceId, creator, episode);
              continue;
            }
            const runTranscribe = transcribe || ((item) => transcribeYoutubeAudio({
              videoId: item.videoId,
              url: watchUrl(item.videoId),
              dataDirectory: deps.dataDirectory,
              env,
              quotaRepository: deps.quotaRepository,
              languageCodes: [],
              execute: deps.executeAudio || executeAudioTranscription,
              transcribe: audioTranscribe,
              workspaceId,
              signal,
            }));
            transcript = await runTranscribe(episode);
            if (!transcript) throw new Error('转写结果为空');
            transcriptSource = 'gemini-transcribe';
            transcribedSec += Number(episode.durationSec || 0);
            stats.transcribed += 1;
          }
          let summary = await summarize({ title: episode.title, creator, transcript });
          let formatted = formatPodcastSummary(summary, { focus: creator.focus });
          if (summaryNeedsChinese(formatted)) {
            if (!translate) throw new Error('摘要不是中文，且没有翻译');
            formatted = await translate(formatted);
          }
          const localized = await localizePodcastCopy({
            summary,
            formatted,
            episodeTitle: episode.title,
            translate,
          });
          summary = localized.summary;
          formatted = localized.formatted;
          const showArticle = youtubeArticleEnabled(env);
          const item = await saveYoutubeEpisode({
            feedRepository: deps.feedRepository,
            workspaceId,
            creator,
            episode,
            summaryText: formatted,
            displayTitle: localized.displayTitle,
            transcript: showArticle ? dedupeRollingCaptions(transcript) : transcript,
            transcriptSource,
          });
          repository.saveEpisode({
            workspaceId,
            videoId: episode.videoId,
            creatorId: creator.id,
            channelKey: episode.channelKey,
            title: episode.title,
            durationSec: episode.durationSec,
            publishedAt: episode.publishedAt,
            status: 'ready',
            reason: '',
            transcriptSource,
            contentItemId: item.id,
            attempts: attemptsOf(repository, workspaceId, episode.videoId) + 1,
            sourceTranscript: transcript,
            sourceHash: transcriptHash(transcript),
            articleStatus: showArticle ? 'pending' : '',
          });
        } catch (error) {
          const stop = roundStop(error, signal);
          if (stop) {
            stats.stopped = stop;
            pushReason(stats, stop);
            stats.failed += 1;
            break;
          }
          if (youtubeTranscribeUnavailable(error)) {
            if (!audioDisabled) {
              audioDisabled = true;
              console.warn(`[worker] youtube-podcasts 转写器不可用，本轮剩下的集不再下载音频：${String(error?.message || error).slice(0, 180)}`);
            }
            recordTranscribeUnavailable(stats, repository, workspaceId, creator, episode);
            continue;
          }
          const attempts = attemptsOf(repository, workspaceId, episode.videoId) + 1;
          repository.saveEpisode({
            workspaceId,
            videoId: episode.videoId,
            creatorId: creator.id,
            channelKey: episode.channelKey,
            title: episode.title,
            durationSec: episode.durationSec,
            publishedAt: episode.publishedAt,
            status: attempts >= 3 ? 'skipped' : 'failed',
            reason: String(error?.message || error).slice(0, 180),
            attempts,
          });
          stats.failed += 1;
          pushReason(stats, 'ingest');
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return finishRound();
}

export function createYoutubePodcastJobHandlers(options = {}) {
  return {
    [YOUTUBE_PODCAST_JOB_TYPE]: (input = {}, ctx = {}) => runYoutubePodcastRound({
      ...options,
      workspaceId: input.workspaceId || options.workspaceId || 'local',
      signal: ctx.signal,
    }),
    [YOUTUBE_ARTICLE_JOB_TYPE]: async (input = {}, ctx = {}) => {
      const env = options.env || process.env;
      const workspaceId = input.workspaceId || options.workspaceId || 'local';
      const jobStore = ctx.store || options.store;
      if (jobStore) retireYoutubeTranslationJobs(jobStore, workspaceId);
      const syncing = (jobStore?.listOpenJobs?.(YOUTUBE_PODCAST_JOB_TYPE) || []).some((job) => job.status === 'running');
      const limits = youtubePodcastLimits(env);
      const deadline = AbortSignal.timeout(youtubeRoundDeadlineMs(limits.roundMs));
      const signal = ctx.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([ctx.signal, deadline])
        : (ctx.signal || deadline);
      let articles = { ready: 0, pending: 0, skipped: 0, dailyLimit: 0, stopped: '' };
      if (syncing) {
        console.log('[worker] youtube-article skipped sync-running');
        articles.stopped = 'sync-running';
      } else {
        articles = await runYoutubeArticlePass({
          ...options,
          env,
          workspaceId,
          signal,
          xVideoRepository: options.xVideoRepository,
        });
        console.log(`[worker] youtube-article ready=${articles.ready} pending=${articles.pending} held=${articles.dailyLimit || 0} skipped=${articles.skipped} stopped=${articles.stopped || '-'}`);
      }
      if (options.xVideoRepository) {
        const xArticles = await runXVideoArticlePass({
          ...options,
          repository: options.xVideoRepository,
          youtubeRepository: options.repository,
          env,
          workspaceId,
          signal,
        });
        console.log(`[worker] x-video-article ready=${xArticles.ready} pending=${xArticles.pending} held=${xArticles.dailyLimit || 0} skipped=${xArticles.skipped} discovered=${xArticles.discovered} stopped=${xArticles.stopped || '-'}`);
        articles = {
          ...articles,
          xReady: xArticles.ready,
          xPending: xArticles.pending,
          xDailyLimit: xArticles.dailyLimit || 0,
        };
      }
      return articles;
    },
    [X_VIDEO_ARTICLE_JOB_TYPE]: async (input = {}, ctx = {}) => {
      const env = options.env || process.env;
      const workspaceId = input.workspaceId || options.workspaceId || 'local';
      const limits = youtubePodcastLimits(env);
      const deadline = AbortSignal.timeout(youtubeRoundDeadlineMs(limits.roundMs));
      const signal = ctx.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([ctx.signal, deadline])
        : (ctx.signal || deadline);
      const tweetId = String(input.tweetId || '').trim();
      if (!tweetId) return { ready: 0, pending: 0, skipped: 0, stopped: 'no-tweet' };
      return runXVideoArticleTweet({
        ...options,
        repository: options.xVideoRepository,
        youtubeRepository: options.repository,
        env,
        workspaceId,
        signal,
        manual: true,
      }, tweetId);
    },
  };
}
