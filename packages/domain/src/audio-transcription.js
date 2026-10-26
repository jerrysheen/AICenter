import { createHash } from 'node:crypto';
import path from 'node:path';
import { AudioTranscriptionPlanSchema } from '../../contracts/src/audio-transcription.js';
import { parseContract, ValidationError } from '../../contracts/src/errors.js';

export const AUDIO_TRANSCRIBE_TOKENS_PER_SECOND = 32;
export const AUDIO_TRANSCRIBE_TOKENS_PER_MINUTE = 20_000;
export const AUDIO_TRANSCRIBE_LIVE_MODEL = 'gemini-3.5-transcribe-live';
export const AUDIO_TRANSCRIBE_FILE_MODEL = 'gemini-3.5-transcribe';
// Non-live is 10K TPM and 25 RPD. Stop one request early so a later call does not wait for 429.
export const AUDIO_TRANSCRIBE_FILE_TOKENS_PER_MINUTE = 10_000;
export const AUDIO_TRANSCRIBE_FILE_REQUESTS_PER_DAY = 24;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

function modelSetting(env, name, fallback) {
  const raw = String(env[name] ?? '').trim();
  if (!raw) return fallback;
  if (!MODEL_ID.test(raw)) throw new Error(`${name} 不是可用的模型名`);
  return raw;
}

export function resolveAudioTranscribeModels(env = process.env) {
  return {
    live: modelSetting(env, 'AI_CENTER_AUDIO_TRANSCRIBE_LIVE_MODEL', AUDIO_TRANSCRIBE_LIVE_MODEL),
    file: modelSetting(env, 'AI_CENTER_AUDIO_TRANSCRIBE_MODEL', AUDIO_TRANSCRIBE_FILE_MODEL),
  };
}
const MAX_CHUNK_MS = 50 * 60_000;
const SAFETY = 0.8;

function integerSetting(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be an integer >= 1`);
  return value;
}

function keyNames(env) {
  const names = String(env.AI_CENTER_GEMINI_KEY_ENVS || 'GEMINI_API_KEY,GEMINI_API_KEY2,GEMINI_API_KEY3,GEMINI_API_KEY4,GEMINI_API_KEY5')
    .split(',').map((item) => item.trim()).filter(Boolean);
  if (names.length > 5 || names.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new Error('invalid Gemini key environment names');
  }
  return names;
}

function projectId(label) {
  return createHash('sha256').update(label).digest('hex');
}

export function resolveAudioTranscriptionLanes(env = process.env) {
  const tokensPerMinute = integerSetting(env, 'AI_CENTER_AUDIO_TRANSCRIBE_TOKENS_PER_MINUTE', AUDIO_TRANSCRIBE_TOKENS_PER_MINUTE);
  const seen = new Set();
  const keys = [];
  for (const name of keyNames(env)) {
    const secret = String(env[name] || '').trim();
    if (!secret || seen.has(secret)) continue;
    seen.add(secret);
    const label = String(env[`${name}_PROJECT`] || '').trim();
    keys.push({ keyEnv: name, project: projectId(label || `audio-key:${secret}`) });
  }
  if (!keys.length) throw new Error('没有配置可用的转写密钥');
  const groups = new Map();
  for (const item of keys) {
    const current = groups.get(item.project) || [];
    current.push({ keyEnv: item.keyEnv });
    groups.set(item.project, current);
  }
  const lanes = [...groups.entries()].map(([project, slots]) => ({ project, slots, tokensPerMinute }));
  return { keyCount: keys.length, tokensPerMinute, lanes };
}

export function describeAudioTranscription(env, durationMs) {
  const resolved = resolveAudioTranscriptionLanes(env);
  const plan = planAudioTranscription({
    durationMs,
    laneCount: resolved.lanes.length,
    tokensPerSecond: integerSetting(env, 'AI_CENTER_AUDIO_TRANSCRIBE_TOKENS_PER_SECOND', AUDIO_TRANSCRIBE_TOKENS_PER_SECOND),
    tokensPerMinute: resolved.tokensPerMinute,
  });
  return parseContract(AudioTranscriptionPlanSchema, {
    ...plan,
    keyCount: resolved.keyCount,
    note: budgetNote(resolved.keyCount, resolved.lanes.length),
  });
}

export function budgetNote(keyCount, laneCount) {
  if (laneCount > 1 && laneCount === keyCount) {
    return '未填写项目标记的密钥各自使用一份本地每分钟额度，可以并行。如果它们实际属于同一个供应商项目，超出的请求会等待后重试。';
  }
  if (keyCount > laneCount) return '标成同一个项目的密钥共用一份每分钟额度，按顺序转写。';
  return '按一份每分钟额度顺序转写。';
}

export function planAudioTranscription({
  durationMs,
  laneCount,
  tokensPerSecond = AUDIO_TRANSCRIBE_TOKENS_PER_SECOND,
  tokensPerMinute = AUDIO_TRANSCRIBE_TOKENS_PER_MINUTE,
  safety = SAFETY,
  maxChunkMs = MAX_CHUNK_MS,
} = {}) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error('音频时长无效');
  if (!Number.isSafeInteger(laneCount) || laneCount < 1) throw new Error('转写通道数量无效');
  // Chunk length stays on the token budget. Live playback pace is separate and stays near realtime.
  const chunkMs = Math.min(maxChunkMs, Math.floor(tokensPerMinute * safety / tokensPerSecond) * 1000);
  if (chunkMs < 1000) throw new Error('每分钟额度不够容纳一个音频片段');
  const chunks = [];
  for (let startMs = 0, index = 0; startMs < durationMs; index += 1, startMs += chunkMs) {
    const endMs = Math.min(durationMs, startMs + chunkMs);
    chunks.push({
      index,
      startMs,
      endMs,
      lane: index % laneCount,
      estimatedTokens: Math.ceil((endMs - startMs) / 1000 * tokensPerSecond),
    });
  }
  const laneChunkCounts = Array.from({ length: laneCount }, (_, lane) => chunks.filter((chunk) => chunk.lane === lane).length);
  return {
    durationMs,
    chunkMs,
    tokensPerSecond,
    tokensPerMinute,
    laneCount,
    chunkCount: chunks.length,
    estimatedTokens: chunks.reduce((sum, chunk) => sum + chunk.estimatedTokens, 0),
    tokenBudgetMinutes: Math.max(...laneChunkCounts),
    laneChunkCounts,
    chunks,
  };
}

export function planFileTranscribePieces(chunk, tokensPerSecond = AUDIO_TRANSCRIBE_TOKENS_PER_SECOND) {
  const pieceMs = Math.floor(AUDIO_TRANSCRIBE_FILE_TOKENS_PER_MINUTE * 0.8 / tokensPerSecond) * 1000;
  const pieces = [];
  for (let startMs = chunk.startMs; startMs < chunk.endMs; startMs += pieceMs) {
    const endMs = Math.min(chunk.endMs, startMs + pieceMs);
    pieces.push({
      startMs,
      endMs,
      estimatedTokens: Math.ceil((endMs - startMs) / 1000 * tokensPerSecond),
    });
  }
  return pieces;
}

export function mergeTranscripts(parts) {
  return parts.map((part) => String(part?.text || '').trim()).filter(Boolean).join('\n');
}

export function resolveAudioFile(dataDirectory, relativePath) {
  const raw = String(relativePath || '').replace(/\\/g, '/').trim();
  if (!raw || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw) || raw.split('/').includes('..')) {
    throw new ValidationError('音频路径必须位于数据目录内', ['path']);
  }
  const root = path.resolve(dataDirectory);
  const absolute = path.resolve(root, raw);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new ValidationError('音频路径必须位于数据目录内', ['path']);
  }
  if (!absolute.toLowerCase().endsWith('.wav')) throw new ValidationError('目前只接受 PCM WAV', ['path']);
  return absolute;
}

export function readWavInfo(buffer, fileSize = buffer.length) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new ValidationError('只支持 PCM WAV', ['path']);
  }
  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && start + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      dataOffset = start;
      dataSize = size;
      break;
    }
    offset = start + size + (size % 2);
    if (offset > buffer.length && id !== 'data') break;
  }
  if (!format || format.audioFormat !== 1 || ![8, 16].includes(format.bitsPerSample) || format.channels < 1 || dataOffset < 0) {
    throw new ValidationError('只支持 8 或 16 位 PCM WAV', ['path']);
  }
  const blockAlign = format.channels * (format.bitsPerSample / 8);
  const dataLength = Math.min(dataSize, Math.max(0, fileSize - dataOffset));
  const sampleCount = Math.floor(dataLength / blockAlign);
  return {
    ...format,
    blockAlign,
    dataOffset,
    dataLength: sampleCount * blockAlign,
    sampleCount,
    durationMs: Math.floor(sampleCount / format.sampleRate * 1000),
  };
}

export function wavSliceRange(info, startMs, endMs) {
  const startSample = Math.max(0, Math.floor(startMs * info.sampleRate / 1000));
  const endSample = Math.min(info.sampleCount, Math.ceil(endMs * info.sampleRate / 1000));
  return {
    byteStart: info.dataOffset + startSample * info.blockAlign,
    byteLength: Math.max(0, endSample - startSample) * info.blockAlign,
  };
}

export function buildWav(pcm, info) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(info.channels, 22);
  header.writeUInt32LE(info.sampleRate, 24);
  header.writeUInt32LE(info.sampleRate * info.blockAlign, 28);
  header.writeUInt16LE(info.blockAlign, 32);
  header.writeUInt16LE(info.bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function sliceWav(buffer, info, startMs, endMs) {
  const range = wavSliceRange(info, startMs, endMs);
  return buildWav(buffer.subarray(range.byteStart, range.byteStart + range.byteLength), info);
}
