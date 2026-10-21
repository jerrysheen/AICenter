import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWav, describeAudioTranscription, planFileTranscribePieces, resolveAudioTranscribeModels, AUDIO_TRANSCRIBE_FILE_REQUESTS_PER_DAY } from '../packages/domain/src/audio-transcription.js';
import { clipSecret, createGeminiAudioTranscriber } from '../packages/connectors/src/audio-transcribe.js';
import { createGeminiLiveTranscriber } from '../packages/connectors/src/audio-transcribe-live.js';
import { executeAudioTranscription } from '../packages/runtime/src/audio-transcription-job.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function wav(seconds = 1) {
  return buildWav(Buffer.alloc(16_000 * 2 * seconds), { channels: 1, sampleRate: 16_000, bitsPerSample: 16, blockAlign: 2 });
}

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = {};
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  emit(type, event) {
    for (const fn of this.listeners[type] || []) fn(event);
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.setup) {
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ setupComplete: {} }) }));
    }
    if (message.realtimeInput?.audioStreamEnd) {
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({ serverContent: { inputTranscription: { text: '前半句' }, turnComplete: true } }),
      }));
    }
  }

  close() {}
}

class FailingSocket extends FakeSocket {
  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.setup) {
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({ error: { message: `rejected ${this.url}` } }),
      }));
    }
  }
}

test('model names come from config and secrets stay out of errors', () => {
  assert.deepEqual(resolveAudioTranscribeModels({
    AI_CENTER_AUDIO_TRANSCRIBE_LIVE_MODEL: 'gemini-3.5-transcribe-live',
    AI_CENTER_AUDIO_TRANSCRIBE_MODEL: 'gemini-3.5-transcribe',
  }), {
    live: 'gemini-3.5-transcribe-live',
    file: 'gemini-3.5-transcribe',
  });
  assert.throws(() => resolveAudioTranscribeModels({ AI_CENTER_AUDIO_TRANSCRIBE_LIVE_MODEL: 'https://evil' }), /模型名/);
  const secret = 'AIzaSyTESTKEY1234567890';
  assert.equal(clipSecret(`wss://example.test/live?key=${secret}`).includes(secret), false);
});

test('live transcription streams pcm frames inside the 20K token minute', async () => {
  let at = 0;
  const waits = [];
  const transcribe = createGeminiLiveTranscriber({
    WebSocket: FakeSocket,
    now: () => at,
    sleep: async (ms) => { waits.push(ms); at += ms; },
    model: 'gemini-3.5-transcribe-live',
  });
  const text = await transcribe({ apiKey: 'AIzaSyTESTKEY1234567890', audio: wav(1), languageCodes: ['en'] });
  assert.equal(text, '前半句');
  assert.ok(at + 0.01 >= 32 / 20_000 * 60_000);
  assert.ok(waits.length >= 9);
  assert.equal(waits.some((ms) => ms > 1000), false);
});

test('a live session reports the configured model and does not echo the key', async () => {
  let seen;
  class RecordingSocket extends FakeSocket {
    constructor(url) {
      super(url);
      seen = this;
    }
  }
  const transcribe = createGeminiLiveTranscriber({
    WebSocket: RecordingSocket,
    now: () => 0,
    sleep: async () => {},
    model: 'custom-live-transcribe',
  });
  await transcribe({ apiKey: 'AIzaSyTESTKEY1234567890', audio: wav(1) });
  assert.equal(seen.sent[0].setup.model, 'models/custom-live-transcribe');
  assert.equal(seen.sent.some((message) => message.realtimeInput?.audio?.mimeType === 'audio/pcm;rate=16000'), true);
  assert.equal(seen.sent.at(-1).realtimeInput.audioStreamEnd, true);
  assert.equal(JSON.stringify(seen.sent).includes('AIzaSyTESTKEY1234567890'), false);
  await assert.rejects(
    createGeminiLiveTranscriber({ WebSocket: FailingSocket, now: () => 0, sleep: async () => {} })({
      apiKey: 'AIzaSyTESTKEY1234567890',
      audio: wav(1),
    }),
    (error) => error.code === 'live-failed' && !String(error.message).includes('AIzaSyTESTKEY1234567890'),
  );
});

test('live failure falls back to the file model with a 10K budget and a 24 call day', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-live-'));
  const relative = 'blobs/sample.wav';
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), wav(1));
  const reserves = [];
  const fileCalls = [];
  const quotaRepository = {
    reserve(input) {
      reserves.push(input);
      if (input.model === 'gemini-3.5-transcribe' && reserves.filter((row) => row.model === input.model).length > AUDIO_TRANSCRIBE_FILE_REQUESTS_PER_DAY) {
        return { admitted: false, retryAt: input.at + 86_400_000 };
      }
      return { admitted: true, keyEnv: 'GEMINI_API_KEY', project: 'p', model: input.model, id: String(reserves.length) };
    },
    release() {},
  };
  const env = { GEMINI_API_KEY: 'live-key', AI_CENTER_AUDIO_TRANSCRIBE_LIVE_MODEL: 'gemini-3.5-transcribe-live', AI_CENTER_AUDIO_TRANSCRIBE_MODEL: 'gemini-3.5-transcribe' };
  const result = await executeAudioTranscription({
    input: { workspaceId: 'local', path: relative, languageCodes: [], mode: 'SMART', plan: describeAudioTranscription(env, 1_000) },
    dataDirectory: root,
    env,
    quotaRepository,
    now: () => Date.parse('2026-10-21T18:00:00Z'),
    sleep: async () => {},
    transcribe: async () => { throw Object.assign(new Error('live down'), { code: 'live-failed' }); },
    fileTranscribe: async ({ apiKey, audio }) => {
      fileCalls.push({ apiKey, bytes: audio.length });
      return '文件转写';
    },
  });
  assert.equal(result.text, '文件转写');
  assert.equal(fileCalls.length, 1);
  assert.equal(fileCalls[0].apiKey, 'live-key');
  assert.equal(reserves[0].model, 'gemini-3.5-transcribe-live');
  assert.equal(reserves[0].requestsPerDay, Infinity);
  assert.equal(reserves[0].estimatedTokensPerMinute, 20_000);
  assert.equal(reserves[1].model, 'gemini-3.5-transcribe');
  assert.equal(reserves[1].requestsPerDay, 24);
  assert.equal(reserves[1].estimatedTokensPerMinute, 10_000);
  assert.ok(reserves[1].estimatedTokens <= 8_000);
  const pieces = planFileTranscribePieces({ startMs: 0, endMs: 500_000 }, 32);
  assert.equal(pieces.length, 2);
  assert.ok(pieces.every((piece) => piece.estimatedTokens <= 8_000));
  const urls = [];
  const fileOnly = createGeminiAudioTranscriber({
    env,
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).includes('/upload/v1beta/files')) {
        return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.test/session' } });
      }
      if (String(url) === 'https://upload.test/session') {
        return new Response(JSON.stringify({ file: { name: 'files/1', uri: 'https://files.test/1', state: 'ACTIVE', mimeType: 'audio/wav' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 500 });
    },
  });
  await assert.rejects(fileOnly({ apiKey: 'live-key', audio: wav(1) }), /nope/);
  assert.equal(urls.some((url) => url.includes('/models/gemini-3.5-transcribe:generateContent')), true);
  assert.equal(urls.some((url) => url.includes('transcribe-live') || url.includes('live-key')), false);
});
