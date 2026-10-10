import { open } from 'node:fs/promises';
import {
  AUDIO_TRANSCRIBE_JOB_TYPE,
  AudioTranscriptionJobInputSchema,
  AudioTranscriptionResultSchema,
  parseContract,
} from '../../contracts/src/index.js';
import { createGeminiAudioTranscriber } from '../../connectors/src/audio-transcribe.js';
import {
  buildWav,
  describeAudioTranscription,
  mergeTranscripts,
  readWavInfo,
  resolveAudioFile,
  resolveAudioTranscriptionLanes,
  wavSliceRange,
} from '../../domain/src/audio-transcription.js';

const MODEL = 'gemini-3.5-transcribe';
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

async function admit({ repository, lane, tokens, now, sleep, signal }) {
  const started = now();
  while (now() - started <= WAIT_LIMIT_MS) {
    if (signal?.aborted) throw new Error('转写已取消');
    const at = now();
    const ticket = repository.reserve({
      slots: lane.slots.map((slot) => ({ ...slot, project: lane.project, cooldownKey: lane.project })),
      model: MODEL,
      at,
      requestsPerHour: 2_000,
      requestsPerMinute: 30,
      minIntervalMs: 0,
      estimatedTokensPerMinute: lane.tokensPerMinute,
      estimatedTokens: tokens,
      accountMode: true,
      requestsPerDay: Number.POSITIVE_INFINITY,
      requestsPerKeyPerDay: Number.POSITIVE_INFINITY,
      dayStart: at,
      dayEnd: at + 86_400_000,
    });
    if (ticket.admitted) return ticket;
    if (!Number.isFinite(ticket.retryAt)) throw new Error('转写额度不可用');
    await sleep(Math.min(60_000, Math.max(200, ticket.retryAt - now())));
  }
  throw new Error('转写额度等待超时');
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
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
}) {
  const job = parseContract(AudioTranscriptionJobInputSchema, input);
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
        let attempt = 0;
        while (attempt < 3) {
          const ticket = await admit({ repository: quotaRepository, lane, tokens: chunk.estimatedTokens, now, sleep, signal });
          try {
            const keyEnv = ticket.keyEnv || lane.slots[attempt % lane.slots.length].keyEnv;
            texts[chunk.index] = await transcribe({
              apiKey: env[keyEnv],
              audio,
              languageCodes: job.languageCodes,
              mode: job.mode,
              signal,
            });
            break;
          } catch (error) {
            attempt += 1;
            if (error.code !== 'quota' || attempt >= 3) throw error;
            quotaRepository.cooldown?.(ticket.cooldownKey || lane.project, MODEL, now() + quotaDelay(error));
            await sleep(quotaDelay(error));
          } finally {
            quotaRepository.release?.(ticket);
          }
        }
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
  const transcribe = options.transcribe || createGeminiAudioTranscriber();
  return {
    [AUDIO_TRANSCRIBE_JOB_TYPE]: (input, context = {}) => executeAudioTranscription({
      input,
      dataDirectory: options.dataDirectory,
      env: options.env || process.env,
      quotaRepository: options.quotaRepository,
      transcribe,
      now: options.now,
      sleep: options.sleep,
      signal: context.signal,
    }),
  };
}
