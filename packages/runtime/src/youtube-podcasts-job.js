import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorCaptureFields } from '../../domain/src/authors.js';
import { nextDailyInstant } from '../../domain/src/zoned-time.js';
import {
  firstRunSlice,
  formatPodcastSummary,
  limitFirstRun,
  loadYoutubePodcastConfig,
  parsePodcastSummary,
  parseYoutubeRss,
  rssUrlForChannel,
  selectPodcastEpisodes,
  summaryNeedsChinese,
  watchUrl,
  youtubePodcastClock,
  youtubePodcastLimits,
  youtubePodcastsEnabled,
  YOUTUBE_PODCAST_JOB_TYPE,
  YOUTUBE_PODCAST_SCHEDULE_KEY,
} from '../../domain/src/youtube-podcasts.js';
import { createGeminiInvestorSummarizer } from '../../connectors/src/investor-discussion-model.js';
import { createGemmaTranslationRouter } from '../../connectors/src/translate/gemma.js';
import {
  probeYoutubeEpisode,
  resolveYoutubeChannelId,
  transcribeYoutubeAudio,
} from '../../connectors/src/youtube-podcasts.js';
import { executeAudioTranscription } from './audio-transcription-job.js';

export { YOUTUBE_PODCAST_JOB_TYPE, YOUTUBE_PODCAST_SCHEDULE_KEY };

const SUMMARY_SYSTEM = `你是财经与科技播客的中文编辑。只根据给定文字稿写简体中文观点摘要，不要补充文字稿里没有的事实。
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

function logRound(stats) {
  const reasons = stats.reasons.length ? stats.reasons.join(',') : '-';
  console.log(`[worker] youtube-podcasts discovered=${stats.discovered} subtitles=${stats.subtitles} transcribed=${stats.transcribed} failed=${stats.failed} skipped=${stats.skipped} stopped=${stats.stopped || '-'} reasons=${reasons}`);
}

function emptyStats() {
  return { discovered: 0, subtitles: 0, transcribed: 0, failed: 0, skipped: 0, stopped: '', reasons: [], status: 'ready' };
}

function pushReason(stats, reason) {
  if (reason && !stats.reasons.includes(reason)) stats.reasons.push(reason);
}

async function defaultFetchRss(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'AICenter/0.2 youtube-podcasts', accept: 'application/atom+xml, application/xml, text/xml' },
  });
  const text = await response.text();
  if (response.status === 429 || /too many requests|not a bot/i.test(text)) {
    return { blocked: response.status === 429 || /429|too many requests/i.test(text) ? '429' : 'bot-check', detail: text.slice(0, 180) };
  }
  if (!response.ok) throw new Error(`RSS ${response.status}`);
  return { entries: parseYoutubeRss(text) };
}

function defaultSummarize(env, quotaRepository) {
  const summarize = createGeminiInvestorSummarizer({ env, quotaRepository, usageStage: 'youtube-podcast-summary' });
  return async ({ title, creator, transcript }) => {
    const clipped = transcript.length > 60_000 ? `${transcript.slice(0, 60_000)}\n\n[文字稿已截断]` : transcript;
    const result = await summarize({
      system: SUMMARY_SYSTEM,
      prompt: `博主：${creator.name}\n关注方向：${creator.focus || '金融与 AI'}\n标题：${title}\n\n文字稿：\n${clipped}`,
    });
    return parsePodcastSummary(result.text);
  };
}

function defaultTranslate(env, quotaRepository) {
  const router = createGemmaTranslationRouter({
    env,
    models: 'gemma-4-26b-a4b-it',
    quotaRepository,
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
  const row = repository.listEpisodes(workspaceId).find((item) => item.videoId === videoId);
  return row?.attempts || 0;
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
  const fetchRss = deps.fetchRss || ((url) => defaultFetchRss(url, deps.fetchImpl || fetch));
  const resolveChannel = deps.resolveChannel || ((handle) => resolveYoutubeChannelId({ handle, fetchImpl: deps.fetchImpl || fetch, env }));
  const probe = deps.probe;
  const transcribe = deps.transcribe;
  const summarize = deps.summarize || defaultSummarize(env, deps.quotaRepository);
  const translate = deps.translate === undefined ? defaultTranslate(env, deps.quotaRepository) : deps.translate;
  const root = await mkdtemp(path.join(os.tmpdir(), 'youtube-podcasts-'));
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
        if (!state.bootstrapped) freshChannels.add(channel.key);
        let channelId = state.channelId;
        if (channel.kind === 'channel' && !channelId) {
          const resolved = await resolveChannel(channel.handle);
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
          stats.failed += 1;
          pushReason(stats, String(error?.message || error).slice(0, 120));
          continue;
        }
        if (rss?.blocked) {
          stats.stopped = rss.blocked;
          pushReason(stats, rss.blocked);
          break;
        }
        await sleep(limits.intervalMs);
        const entries = (rss?.entries || []).map((entry) => ({ ...entry, channelKey: channel.key, role: channel.role || '' }));
        const slice = state.bootstrapped
          ? { probe: entries.filter((entry) => !repository.isDone(workspaceId, entry.videoId)), ignore: [] }
          : firstRunSlice(entries, limits.lookback);
        let finished = true;
        for (const entry of slice.probe) {
          if (stats.stopped || processed >= limits.roundLimit) {
            finished = false;
            break;
          }
          if (repository.isDone(workspaceId, entry.videoId)) continue;
          const workDir = path.join(root, entry.videoId);
          const probed = probe
            ? await probe(entry)
            : await probeYoutubeEpisode({ videoId: entry.videoId, url: entry.url || watchUrl(entry.videoId), workDir, env });
          if (probed?.blocked) {
            stats.stopped = probed.blocked;
            pushReason(stats, probed.blocked);
            finished = false;
            break;
          }
          await sleep(limits.intervalMs);
          if (probed?.failed) {
            const attempts = attemptsOf(repository, workspaceId, entry.videoId) + 1;
            repository.saveEpisode({
              workspaceId,
              videoId: entry.videoId,
              creatorId: creator.id,
              channelKey: channel.key,
              title: entry.title,
              publishedAt: entry.publishedAt,
              status: attempts >= 3 ? 'skipped' : 'failed',
              reason: probed.detail || 'probe-failed',
              attempts,
            });
            stats.failed += 1;
            pushReason(stats, 'probe-failed');
            continue;
          }
          incoming.push({
            ...entry,
            title: probed.title || entry.title,
            durationSec: Number(probed.durationSec) || 0,
            liveStatus: probed.liveStatus || '',
            url: entry.url || watchUrl(entry.videoId),
            transcript: probed.transcript || '',
            transcriptSource: probed.transcriptSource || '',
            role: channel.role || '',
          });
          processed += 1;
        }
        if (!state.bootstrapped && finished && !stats.stopped) {
          for (const entry of slice.ignore) {
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
          repository.saveChannel(workspaceId, channel.key, { channelId, bootstrapped: true });
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
          if (transcript) {
            stats.subtitles += 1;
          } else {
            if (transcribedSec + Number(episode.durationSec || 0) > limits.transcribeSec) {
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
            const runTranscribe = transcribe || ((item) => transcribeYoutubeAudio({
              videoId: item.videoId,
              url: item.url,
              dataDirectory: deps.dataDirectory,
              env,
              quotaRepository: deps.quotaRepository,
              languageCodes: [],
              execute: deps.executeAudio || executeAudioTranscription,
              workspaceId,
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
            summary = { ...summary, titleZh: summary.titleZh };
          }
          const item = await saveYoutubeEpisode({
            feedRepository: deps.feedRepository,
            workspaceId,
            creator,
            episode,
            summaryText: formatted,
            displayTitle: summaryNeedsChinese(summary.titleZh || '') ? episode.title : (summary.titleZh || episode.title),
            transcript,
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
          });
        } catch (error) {
          if (error?.code === 'youtube-round-stop' || error?.reason === 'bot-check' || error?.reason === '429') {
            stats.stopped = error.reason || 'bot-check';
            pushReason(stats, stats.stopped);
            stats.failed += 1;
            break;
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
  logRound(stats);
  return stats;
}

export function createYoutubePodcastJobHandlers(options = {}) {
  return {
    [YOUTUBE_PODCAST_JOB_TYPE]: (input = {}) => runYoutubePodcastRound({
      ...options,
      workspaceId: input.workspaceId || options.workspaceId || 'local',
    }),
  };
}
