import { open } from 'node:fs/promises';
import {
  AUDIO_TRANSCRIBE_JOB_TYPE,
  AudioTranscriptionJobInputSchema,
  AudioTranscriptionResultSchema,
  parseContract,
} from '../../contracts/src/index.js';
import { createGeminiAudioTranscriber } from '../../connectors/src/audio-transcribe.js';
import { createGeminiLiveTranscriber } from '../../connectors/src/audio-transcribe-live.js';
import { nextGeminiDailyReset } from '../../connectors/src/gemini-grok-task.js';
import {
  AUDIO_TRANSCRIBE_FILE_REQUESTS_PER_DAY,
  AUDIO_TRANSCRIBE_FILE_TOKENS_PER_MINUTE,
  buildWav,
  describeAudioTranscription,
  mergeTranscripts,
  planFileTranscribePieces,
  readWavInfo,
  resolveAudioFile,
  resolveAudioTranscribeModels,
  resolveAudioTranscriptionLanes,
  sliceWav,
  wavSliceRange,
} from '../../domain/src/audio-transcription.js';

const WAIT_LIMIT_MS = 6 * 60 * 60_000;
const NETWORK_ATTEMPTS = 3;

const LIVE_CATEGORIES = new Set([
  'live-audio', 'live-timeout', 'live-connect', 'live-empty', 'live-unavailable', 'live-failed',
]);

export function isTranscribeNetworkError(error) {
  if (!error || error.name === 'AbortError') return false;
  const code = String(error.code || '');
  if (code === 'quota' || code === 'aborted' || LIVE_CATEGORIES.has(code)) return false;
  if (code === 'network' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_SOCKET') return true;
  const message = String(error.message || '');
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|Connect Timeout|network error/i.test(message);
}

export function transcribeErrorCategory(error) {
  if (!error) return 'upstream';
  if (error.name === 'AbortError') return 'aborted';
  const code = String(error.code || '');
  if (LIVE_CATEGORIES.has(code) || code === 'network' || code === 'quota' || code === 'aborted') return code;
  if (isTranscribeNetworkError(error)) return 'network';
  const message = String(error.message || '');
  if (/Live 转写连接/.test(message)) return 'live-connect';
  if (/Live 转写超时/.test(message)) return 'live-timeout';
  if (/Live 转写不可用/.test(message)) return 'live-unavailable';
  if (/Live 转写音频为空|Live 转写读不到音频/.test(message)) return 'live-audio';
  if (/Live 转写结果为空/.test(message)) return 'live-empty';
  return 'upstream';
}

export function safeTranscribeMessage(error) {
  const category = transcribeErrorCategory(error);
  const raw = String(error?.message || '');
  if (!raw || /wss?:|key=|AIza|generativelanguage|GEMINI_API_KEY/i.test(raw)) {
    if (category === 'network') return 'fetch failed';
    if (category === 'aborted') return '转写已取消';
    return `转写失败（${category}）`;
  }
  return raw.slice(0, 160);
}

export const audioTranscriptionManifest = Object.freeze({
  id: 'audio.transcribe',
  version: '1.0.0',
  capabilities: ['audio.transcribe'],
  jobTypes: [AUDIO_TRANSCRIBE_JOB_TYPE],
  sourceIds: [],
});

export function previewAudioTranscription(options) {
  return describeAudioTranscription(options.env || process.env, options.durationMs);
}

async function readHeader(file, size) {
  const length = Math.min(size, 1024 * 1024);
  const header = Buffer.alloc(length);
  const { bytesRead } = await file.read(header, 0, length, 0);
  return readWavInfo(header.subarray(0, bytesRead), size);
}

async function readSlice(file, info, startMs, endMs) {
  const range = wavSliceRange(info, startMs, endMs);
  const pcm = Buffer.alloc(range.byteLength);
  if (range.byteLength) await file.read(pcm, 0, range.byteLength, range.byteStart);
  return buildWav(pcm, info);
}

function pacificDay(at) {
  const dayEnd = nextGeminiDailyReset(at);
  return { dayStart: nextGeminiDailyReset(dayEnd - 27 * 3600000), dayEnd };
}

function slicePiece(audio, chunkStartMs, startMs, endMs) {
  if (startMs === chunkStartMs && endMs - startMs === readWavInfo(audio, audio.length).durationMs) return audio;
  const info = readWavInfo(audio, audio.length);
  return sliceWav(audio, info, startMs - chunkStartMs, endMs - chunkStartMs);
}

async function admit({ repository, lane, tokens, now, sleep, signal, model, requestsPerDay, estimatedTokensPerMinute, dayStart, dayEnd }) {
  const started = now();
  while (now() - started <= WAIT_LIMIT_MS) {
    if (signal?.aborted) throw new Error('转写已取消');
    const at = now();
    const ticket = repository.reserve({
      slots: lane.slots.map((slot) => ({ ...slot, project: lane.project, cooldownKey: lane.project })),
      model,
      at,
      requestsPerHour: 2_000,
      requestsPerMinute: 30,
      minIntervalMs: 0,
      estimatedTokensPerMinute,
      estimatedTokens: tokens,
      accountMode: true,
      requestsPerDay,
      requestsPerKeyPerDay: requestsPerDay,
      dayStart,
      dayEnd,
    });
    if (ticket.admitted) return ticket;
    if (!Number.isFinite(ticket.retryAt)) throw new Error('转写额度不可用');
    await sleep(Math.min(60_000, Math.max(200, ticket.retryAt - now())));
  }
  throw new Error('转写额度等待超时');
}

async function callLimited({ repository, lane, tokens, now, sleep, signal, model, requestsPerDay, estimatedTokensPerMinute, dayStart, dayEnd, run }) {
  let quotaAttempt = 0;
  let networkAttempt = 0;
  while (quotaAttempt < 3) {
    if (signal?.aborted) throw Object.assign(new Error('转写已取消'), { name: 'AbortError', code: 'aborted' });
    const ticket = await admit({
      repository, lane, tokens, now, sleep, signal, model, requestsPerDay, estimatedTokensPerMinute, dayStart, dayEnd,
    });
    try {
      const keyEnv = ticket.keyEnv || lane.slots[attemptKey(lane, quotaAttempt + networkAttempt)].keyEnv;
      return await run(keyEnv);
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      if (error.code === 'quota' && quotaAttempt < 2) {
        quotaAttempt += 1;
        repository.cooldown?.(ticket.cooldownKey || lane.project, model, now() + quotaDelay(error));
        await sleep(quotaDelay(error));
        continue;
      }
      if (isTranscribeNetworkError(error) && networkAttempt < NETWORK_ATTEMPTS - 1) {
        networkAttempt += 1;
        await sleep(Math.min(4_000, 500 * (2 ** (networkAttempt - 1))));
        continue;
      }
      throw error;
    } finally {
      repository.release?.(ticket);
    }
  }
  throw new Error('转写失败');
}

function attemptKey(lane, attempt) {
  const slots = lane.slots || [];
  return slots.length ? attempt % slots.length : 0;
}

async function transcribeChunk({
  audio, chunk, lane, env, job, liveModel, fileModel, tokensPerSecond, liveTranscribe, fallbackTranscribe, quotaRepository, now, sleep, signal, onLiveFailure,
}) {
  const run = (client, piece) => (keyEnv) => client({
    apiKey: env[keyEnv],
    audio: piece,
    languageCodes: job.languageCodes,
    mode: job.mode,
    signal,
  });
  try {
    const at = now();
    return await callLimited({
      repository: quotaRepository,
      lane,
      tokens: chunk.estimatedTokens,
      now,
      sleep,
      signal,
      model: liveModel,
      requestsPerDay: Number.POSITIVE_INFINITY,
      estimatedTokensPerMinute: lane.tokensPerMinute,
      dayStart: at,
      dayEnd: at + 86_400_000,
      run: run(liveTranscribe, audio),
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted || !fallbackTranscribe) throw error;
    onLiveFailure?.(error);
    const parts = [];
    for (const piece of planFileTranscribePieces(chunk, tokensPerSecond)) {
      const slice = slicePiece(audio, chunk.startMs, piece.startMs, piece.endMs);
      const day = pacificDay(now());
      parts.push(await callLimited({
        repository: quotaRepository,
        lane,
        tokens: piece.estimatedTokens,
        now,
        sleep,
        signal,
        model: fileModel,
        requestsPerDay: AUDIO_TRANSCRIBE_FILE_REQUESTS_PER_DAY,
        estimatedTokensPerMinute: AUDIO_TRANSCRIBE_FILE_TOKENS_PER_MINUTE,
        dayStart: day.dayStart,
        dayEnd: day.dayEnd,
        run: run(fallbackTranscribe, slice),
      }));
    }
    return parts.filter(Boolean).join('\n');
  }
}

function quotaDelay(error) {
  const match = String(error?.message || '').match(/retryDelay[^0-9]*(\d+(?:\.\d+)?)s/i);
  return match ? Math.ceil(Number(match[1]) * 1000) : 60_000;
}

export async function executeAudioTranscription({
  input,
  dataDirectory,
  env = process.env,
  quotaRepository,
  transcribe,
  fileTranscribe,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
  resumeSegments = [],
  onSegment,
}) {
  const job = parseContract(AudioTranscriptionJobInputSchema, input);
  const models = resolveAudioTranscribeModels(env);
  const usingDefault = transcribe == null;
  const liveTranscribe = transcribe || createGeminiLiveTranscriber({ env, model: models.live });
  const fallbackTranscribe = fileTranscribe !== undefined
    ? fileTranscribe
    : (usingDefault ? createGeminiAudioTranscriber({ env, model: models.file }) : null);
  const absolute = resolveAudioFile(dataDirectory, job.path);
  const resolved = resolveAudioTranscriptionLanes(env);
  const file = await open(absolute, 'r');
  const stop = new AbortController();
  const onParentAbort = () => stop.abort();
  signal?.addEventListener?.('abort', onParentAbort, { once: true });
  const linked = signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, stop.signal])
    : (signal || stop.signal);
  const saved = new Map();
  for (const segment of Array.isArray(resumeSegments) ? resumeSegments : []) {
    const text = String(segment?.text || '').trim();
    if (!Number.isInteger(segment?.index) || segment.index < 0 || !text) continue;
    saved.set(segment.index, text);
  }
  let liveFailureLogged = false;
  const noteLiveFailure = (error) => {
    if (liveFailureLogged) return;
    liveFailureLogged = true;
    console.warn(`[worker] 语音转写 Live 失败，改走文件转写：${transcribeErrorCategory(error)}`);
  };
  const completed = [];
  let failure = null;
  const fail = (error) => {
    if (!failure) failure = error;
    stop.abort();
    return failure;
  };
  try {
    const info = await readHeader(file, (await file.stat()).size);
    if (info.durationMs <= 0) throw new Error('音频时长无效');
    const plan = previewAudioTranscription({ env, durationMs: info.durationMs });
    const texts = new Array(plan.chunkCount);
    let reading = Promise.resolve();
    const exclusive = (work) => {
      const run = reading.then(work, work);
      reading = run.then(() => {}, () => {});
      return run;
    };
    try {
      await Promise.all(resolved.lanes.map(async (lane, laneIndex) => {
        const mine = plan.chunks.filter((chunk) => chunk.lane === laneIndex);
        for (const chunk of mine) {
          if (linked.aborted) throw Object.assign(new Error('转写已取消'), { name: 'AbortError', code: 'aborted' });
          const resumed = saved.get(chunk.index);
          if (resumed) {
            texts[chunk.index] = resumed;
            continue;
          }
          const audio = await exclusive(() => readSlice(file, info, chunk.startMs, chunk.endMs));
          if (linked.aborted) throw Object.assign(new Error('转写已取消'), { name: 'AbortError', code: 'aborted' });
          let text;
          try {
            text = await transcribeChunk({
              audio,
              chunk,
              lane,
              env,
              job,
              liveModel: models.live,
              fileModel: models.file,
              tokensPerSecond: plan.tokensPerSecond,
              liveTranscribe,
              fallbackTranscribe,
              quotaRepository,
              now,
              sleep,
              signal: linked,
              onLiveFailure: noteLiveFailure,
            });
          } catch (error) {
            throw fail(error);
          }
          texts[chunk.index] = text;
          const segment = {
            index: chunk.index,
            startMs: chunk.startMs,
            endMs: chunk.endMs,
            text: String(text || '').trim(),
          };
          if (segment.text) {
            completed.push(segment);
            await onSegment?.(segment);
          }
        }
      }));
    } catch (error) {
      const primary = fail(error);
      if (completed.length) primary.completedSegments = completed.slice();
      primary.message = safeTranscribeMessage(primary);
      primary.code = primary.code || transcribeErrorCategory(primary);
      throw primary;
    }
    return parseContract(AudioTranscriptionResultSchema, {
      text: mergeTranscripts(texts.map((text) => ({ text }))),
      segments: plan.chunks.map((chunk) => ({
        index: chunk.index,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        text: String(texts[chunk.index] || '').trim(),
      })),
      plan,
    });
  } finally {
    signal?.removeEventListener?.('abort', onParentAbort);
    await file.close();
  }
}

export function createAudioTranscriptionJobHandlers(options) {
  return {
    [AUDIO_TRANSCRIBE_JOB_TYPE]: (input, context = {}) => executeAudioTranscription({
      input,
      dataDirectory: options.dataDirectory,
      env: options.env || process.env,
      quotaRepository: options.quotaRepository,
      transcribe: options.transcribe,
      fileTranscribe: options.fileTranscribe,
      now: options.now,
      sleep: options.sleep,
      signal: context.signal,
    }),
  };
}
