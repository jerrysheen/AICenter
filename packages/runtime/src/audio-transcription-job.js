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
  let attempt = 0;
  while (attempt < 3) {
    const ticket = await admit({
      repository, lane, tokens, now, sleep, signal, model, requestsPerDay, estimatedTokensPerMinute, dayStart, dayEnd,
    });
    try {
      const keyEnv = ticket.keyEnv || lane.slots[attempt % lane.slots.length].keyEnv;
      return await run(keyEnv);
    } catch (error) {
      attempt += 1;
      if (error?.name === 'AbortError' || signal?.aborted || error.code !== 'quota' || attempt >= 3) throw error;
      repository.cooldown?.(ticket.cooldownKey || lane.project, model, now() + quotaDelay(error));
      await sleep(quotaDelay(error));
    } finally {
      repository.release?.(ticket);
    }
  }
  throw new Error('转写失败');
}

async function transcribeChunk({
  audio, chunk, lane, env, job, liveModel, fileModel, tokensPerSecond, liveTranscribe, fallbackTranscribe, quotaRepository, now, sleep, signal,
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
    await Promise.all(resolved.lanes.map(async (lane, laneIndex) => {
      const mine = plan.chunks.filter((chunk) => chunk.lane === laneIndex);
      for (const chunk of mine) {
        const audio = await exclusive(() => readSlice(file, info, chunk.startMs, chunk.endMs));
        texts[chunk.index] = await transcribeChunk({
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
          signal,
        });
      }
    }));
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
