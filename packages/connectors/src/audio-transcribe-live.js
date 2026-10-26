import { randomUUID } from 'node:crypto';
import { clipSecret } from './audio-transcribe.js';
import { emptyTokenUsage, normalizeTokenUsage } from '../../contracts/src/model-usage.js';
import { modelUsageContext, observeModelUsage } from '../../runtime/src/model-usage-context.js';
import {
  AUDIO_TRANSCRIBE_LIVE_MODEL,
  AUDIO_TRANSCRIBE_TOKENS_PER_MINUTE,
  AUDIO_TRANSCRIBE_TOKENS_PER_SECOND,
  readWavInfo,
  resolveAudioTranscribeModels,
} from '../../domain/src/audio-transcription.js';

const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const FRAME_MS = 100;
// Live digests audio near realtime. 1.1× stays inside 1.0–1.2× and does not dump a chunk in one TPM window.
export const LIVE_REALTIME_FACTOR = 1.1;
export const LIVE_MIN_INPUT_TOKEN_RATIO = 0.5;
export const LIVE_MIN_CHARS_PER_SECOND = 3;
export const LIVE_CHARS_CHECK_MIN_MS = 30_000;

export function clampLiveRealtimeFactor(value) {
  const factor = Number(value);
  if (!Number.isFinite(factor)) return LIVE_REALTIME_FACTOR;
  return Math.min(1.2, Math.max(1, factor));
}

export function liveSendEarliestMs(audioMs, tokens, {
  tokensPerMinute = AUDIO_TRANSCRIBE_TOKENS_PER_MINUTE,
  realtimeFactor = LIVE_REALTIME_FACTOR,
} = {}) {
  const realtimeMs = Number(audioMs) / clampLiveRealtimeFactor(realtimeFactor);
  const quotaMs = Number(tokensPerMinute) > 0
    ? Number(tokens) / Number(tokensPerMinute) * 60_000
    : realtimeMs;
  return Math.max(realtimeMs, Number.isFinite(quotaMs) ? quotaMs : realtimeMs);
}

export function isSparseLiveTranscript({ text, durationMs, inputTokens, estimatedTokens } = {}) {
  const estimated = Number(estimatedTokens);
  const hasInput = inputTokens !== null && inputTokens !== undefined && inputTokens !== '';
  if (hasInput && Number.isFinite(estimated) && estimated > 0) {
    const input = Number(inputTokens);
    if (Number.isFinite(input) && input >= 0) return input < estimated * LIVE_MIN_INPUT_TOKEN_RATIO;
  }
  if (!Number.isFinite(durationMs) || durationMs < LIVE_CHARS_CHECK_MIN_MS) return false;
  const chars = String(text || '').trim().length;
  return chars / (durationMs / 1000) < LIVE_MIN_CHARS_PER_SECOND;
}

export function liveTranscribeUrl() {
  return LIVE_URL;
}

export function wavToLivePcm(audio) {
  const info = readWavInfo(audio, audio.length);
  if (info.bitsPerSample !== 16) throw new Error('Live 转写只接受 16 位 PCM');
  const pcm = audio.subarray(info.dataOffset, info.dataOffset + info.dataLength);
  if (info.channels === 1) return { pcm, sampleRate: info.sampleRate };
  const samples = Math.floor(pcm.length / info.blockAlign);
  const mono = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    let sum = 0;
    for (let channel = 0; channel < info.channels; channel += 1) {
      sum += pcm.readInt16LE(index * info.blockAlign + channel * 2);
    }
    mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / info.channels))), index * 2);
  }
  return { pcm: mono, sampleRate: info.sampleRate };
}

export function liveFrameBytes(sampleRate, frameMs = FRAME_MS) {
  return Math.max(2, Math.floor(sampleRate * frameMs / 1000) * 2);
}

function liveClientError(error, code) {
  if (error?.name === 'AbortError') return error;
  const category = code === 'network' || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(String(error?.message || ''))
    ? 'network'
    : (code || 'live-failed');
  const message = category === 'network' ? 'fetch failed'
    : category === 'live-timeout' ? 'Live 转写超时'
      : category === 'live-connect' ? 'Live 转写连接失败'
        : category === 'live-unavailable' ? 'Live 转写不可用'
          : category === 'live-audio' ? 'Live 转写读不到音频'
            : category === 'live-empty' ? 'Live 转写结果为空'
              : category === 'live-sparse' ? 'Live 转写结果过稀'
                : 'Live 转写失败';
  const wrapped = new Error(message);
  wrapped.code = category;
  return wrapped;
}

function waitFor(socket, ready, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(liveClientError(new Error('Live 转写超时'), 'live-timeout')), timeoutMs);
    const onAbort = () => finish(Object.assign(new Error('转写已取消'), { name: 'AbortError' }));
    function finish(error, value) {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    ready(finish);
  });
}

async function messageText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (typeof data?.text === 'function') return data.text();
  return '';
}

function geminiLiveUsage(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const prompt = metadata.promptTokenCount;
  const cached = metadata.cachedContentTokenCount;
  const usage = normalizeTokenUsage({
    inputTokens: Number.isSafeInteger(prompt) && Number.isSafeInteger(cached) ? prompt - cached : prompt,
    outputTokens: Number.isSafeInteger(metadata.totalTokenCount) && Number.isSafeInteger(prompt)
      ? metadata.totalTokenCount - prompt
      : metadata.candidatesTokenCount,
    cacheReadTokens: cached,
    reasoningTokens: metadata.thoughtsTokenCount,
    totalTokens: metadata.totalTokenCount,
  });
  return Object.values(usage).some((value) => value !== null) ? usage : null;
}

function usageCompleteness(usage) {
  if (usage.inputTokens !== null && usage.outputTokens !== null && usage.totalTokens !== null) return 'complete';
  return Object.values(usage).some((value) => value !== null) ? 'partial' : 'missing';
}

function liveUsageRow(model, apiKey) {
  const inherited = modelUsageContext();
  return {
    id: randomUUID(),
    kind: 'request',
    workspaceId: inherited.workspaceId || 'local',
    jobId: inherited.jobId || '',
    jobAttempt: inherited.jobAttempt ?? null,
    itemId: String(inherited.itemId || '').slice(0, 256),
    keySuffix: String(apiKey || inherited.keySuffix || '').slice(-4),
    stage: inherited.stage || 'audio-transcribe',
    applicationSessionId: inherited.applicationSessionId || '',
    harnessSessionId: inherited.harnessSessionId || '',
    turn: inherited.turn ?? null,
    step: inherited.step ?? null,
    attempt: null,
    provider: 'gemini',
    model,
    status: 'pending',
    completeness: 'missing',
    usage: emptyTokenUsage(),
    httpStatus: null,
    occurredAt: Date.now(),
    supplierAmount: null,
    supplierCurrency: null,
  };
}

export function createGeminiLiveTranscriber({
  WebSocket: WebSocketImpl = globalThis.WebSocket,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  env = process.env,
  model,
  tokensPerMinute = AUDIO_TRANSCRIBE_TOKENS_PER_MINUTE,
  tokensPerSecond = AUDIO_TRANSCRIBE_TOKENS_PER_SECOND,
  realtimeFactor = LIVE_REALTIME_FACTOR,
  frameMs = FRAME_MS,
  timeoutMs = 180_000,
} = {}) {
  const liveModel = model || resolveAudioTranscribeModels(env).live || AUDIO_TRANSCRIBE_LIVE_MODEL;
  return async function transcribeLive({ apiKey, audio, languageCodes = [], signal }) {
    const secret = String(apiKey || '').trim();
    if (!secret) throw new Error('转写密钥不可用');
    if (!WebSocketImpl) throw liveClientError(new Error('Live 转写不可用'), 'live-unavailable');
    let pcm;
    let sampleRate;
    try {
      ({ pcm, sampleRate } = wavToLivePcm(audio));
    } catch (error) {
      throw Object.assign(new Error(clipSecret(error?.message) || 'Live 转写读不到音频'), { code: 'live-audio' });
    }
    if (!pcm.length) throw Object.assign(new Error('Live 转写音频为空'), { code: 'live-audio' });
    const durationMs = Math.floor(pcm.length / 2 / sampleRate * 1000);
    const estimatedTokens = durationMs / 1000 * tokensPerSecond;
    const usage = liveUsageRow(liveModel, secret);
    await observeModelUsage(usage);
    const finishUsage = async (status, httpStatus = null) => {
      usage.status = status;
      usage.httpStatus = httpStatus;
      usage.usage = usageTokens || emptyTokenUsage();
      usage.completeness = usageCompleteness(usage.usage);
      await observeModelUsage(usage);
    };
    let usageTokens = null;
    let socket;
    try {
      socket = new WebSocketImpl(liveTranscribeUrl(), { headers: { 'x-goog-api-key': secret } });
    } catch (error) {
      await finishUsage('failed');
      throw liveClientError(error, /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(String(error?.message || '')) ? 'network' : 'live-connect');
    }
    const finals = [];
    let interim = '';
    let failed = null;
    let setupDone = false;
    let turnDone = false;
    const queued = [];
    let isOpen = false;
    const notify = () => {
      const waiting = queued.splice(0, queued.length);
      for (const fn of waiting) fn();
    };
    const fail = (error) => {
      failed = error instanceof Error ? error : new Error(clipSecret(error));
      notify();
    };
    socket.addEventListener?.('error', () => fail(liveClientError(new Error('Live 转写连接失败'), 'live-connect')));
    socket.addEventListener?.('open', () => { isOpen = true; notify(); });
    socket.addEventListener?.('close', () => notify());
    socket.addEventListener?.('message', (event) => {
      messageText(event?.data).then((raw) => {
        let message = {};
        try { message = raw ? JSON.parse(raw) : {}; } catch { message = {}; }
        if (message.error) fail(new Error(clipSecret(message.error.message || message.error.status) || 'Live 转写失败'));
        if (message.setupComplete) setupDone = true;
        const reported = geminiLiveUsage(message.usageMetadata || message.serverContent?.usageMetadata);
        if (reported) usageTokens = reported;
        const content = message.serverContent || {};
        if (content.inputTranscription?.text) finals.push(String(content.inputTranscription.text));
        if (content.interimInputTranscription?.text) interim = String(content.interimInputTranscription.text);
        if (content.turnComplete) turnDone = true;
        notify();
      }).catch((error) => fail(error));
    });
    const opened = waitFor(socket, (finish) => {
      const check = () => {
        if (failed) finish(failed);
        else if (isOpen) finish(null, true);
        else queued.push(check);
      };
      check();
    }, timeoutMs, signal);
    try {
      await opened;
      if (failed) throw failed;
      // responseModalities TEXT suppresses the final inputTranscription on this endpoint.
      // The session is still counted upstream, then times out here with no text to save.
      socket.send(JSON.stringify({
        setup: {
          model: `models/${liveModel}`,
          inputAudioTranscription: { languageCodes },
        },
      }));
      const setupWait = waitFor(socket, (finish) => {
        const check = () => {
          if (failed) finish(failed);
          else if (setupDone) finish(null, true);
          else queued.push(check);
        };
        check();
      }, timeoutMs, signal);
      await setupWait;
      const frameBytes = liveFrameBytes(sampleRate, frameMs);
      const started = now();
      let sentAudioMs = 0;
      let sentTokens = 0;
      for (let offset = 0; offset < pcm.length; offset += frameBytes) {
        if (signal?.aborted) throw Object.assign(new Error('转写已取消'), { name: 'AbortError' });
        if (failed) throw failed;
        const bytes = Math.min(frameBytes, pcm.length - offset);
        const audioMs = bytes / 2 / sampleRate * 1000;
        sentAudioMs += audioMs;
        sentTokens += audioMs / 1000 * tokensPerSecond;
        // TPM is a ceiling. The interval follows audio time, so Live is not asked to swallow a chunk in a few seconds.
        const earliest = started + liveSendEarliestMs(sentAudioMs, sentTokens, { tokensPerMinute, realtimeFactor });
        const delay = earliest - now();
        if (delay > 0) await sleep(delay);
        if (signal?.aborted) throw Object.assign(new Error('转写已取消'), { name: 'AbortError' });
        socket.send(JSON.stringify({
          realtimeInput: {
            audio: {
              data: pcm.subarray(offset, offset + frameBytes).toString('base64'),
              mimeType: `audio/pcm;rate=${sampleRate}`,
            },
          },
        }));
      }
      socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      let turnError = null;
      try {
        await waitFor(socket, (finish) => {
          const check = () => {
            if (failed) finish(failed);
            else if (turnDone) finish(null, true);
            else queued.push(check);
          };
          check();
        }, timeoutMs, signal);
      } catch (error) {
        turnError = error;
      }
      if (turnError?.name === 'AbortError') throw turnError;
      const finalText = finals.join('').trim();
      const interimText = interim.trim();
      const text = finalText || interimText;
      const sparse = isSparseLiveTranscript({
        text,
        durationMs,
        inputTokens: usageTokens?.inputTokens,
        estimatedTokens,
      });
      const timedOut = Boolean(turnError);
      const partial = !finalText;
      if (text && !sparse && !(timedOut && partial)) {
        await finishUsage('succeeded');
        return text;
      }
      if (text && (sparse || (timedOut && partial))) {
        throw liveClientError(new Error('Live 转写结果过稀'), 'live-sparse');
      }
      if (turnError) throw turnError;
      throw liveClientError(new Error('Live 转写结果为空'), 'live-empty');
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      await finishUsage(aborted ? 'interrupted' : 'failed', error?.code === 'live-timeout' ? 408 : null);
      if (aborted) throw error;
      throw liveClientError(error, error?.code || 'live-failed');
    } finally {
      try { socket?.close?.(); } catch { /* The session is already done. */ }
    }
  };
}
