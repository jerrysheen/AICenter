import { clipSecret } from './audio-transcribe.js';
import {
  AUDIO_TRANSCRIBE_LIVE_MODEL,
  AUDIO_TRANSCRIBE_TOKENS_PER_MINUTE,
  AUDIO_TRANSCRIBE_TOKENS_PER_SECOND,
  readWavInfo,
  resolveAudioTranscribeModels,
} from '../../domain/src/audio-transcription.js';

const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const FRAME_MS = 100;

export function liveTranscribeUrl(apiKey) {
  const key = encodeURIComponent(String(apiKey || '').trim());
  return `${LIVE_URL}?key=${key}`;
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

export function createGeminiLiveTranscriber({
  WebSocket: WebSocketImpl = globalThis.WebSocket,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  env = process.env,
  model,
  tokensPerMinute = AUDIO_TRANSCRIBE_TOKENS_PER_MINUTE,
  tokensPerSecond = AUDIO_TRANSCRIBE_TOKENS_PER_SECOND,
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
    const url = liveTranscribeUrl(secret);
    let socket;
    try {
      socket = new WebSocketImpl(url);
    } catch (error) {
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
      socket.send(JSON.stringify({
        setup: {
          model: `models/${liveModel}`,
          generationConfig: { responseModalities: ['TEXT'] },
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
      let sentTokens = 0;
      for (let offset = 0; offset < pcm.length; offset += frameBytes) {
        if (signal?.aborted) throw Object.assign(new Error('转写已取消'), { name: 'AbortError' });
        if (failed) throw failed;
        const frameTokens = Math.min(frameBytes, pcm.length - offset) / 2 / sampleRate * tokensPerSecond;
        sentTokens += frameTokens;
        const earliest = started + sentTokens / tokensPerMinute * 60_000;
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
      await waitFor(socket, (finish) => {
        const check = () => {
          if (failed) finish(failed);
          else if (turnDone) finish(null, true);
          else queued.push(check);
        };
        check();
      }, timeoutMs, signal);
      const text = (finals.join('') || interim).trim();
      if (!text) throw liveClientError(new Error('Live 转写结果为空'), 'live-empty');
      return text;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw liveClientError(error, error?.code || 'live-failed');
    } finally {
      try { socket.close?.(); } catch { /* The session is already done. */ }
    }
  };
}
