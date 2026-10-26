import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWav, describeAudioTranscription, planFileTranscribePieces, resolveAudioTranscribeModels, AUDIO_TRANSCRIBE_FILE_REQUESTS_PER_DAY } from '../packages/domain/src/audio-transcription.js';
import { clipSecret, createGeminiAudioTranscriber } from '../packages/connectors/src/audio-transcribe.js';
import {
  createGeminiLiveTranscriber,
  isSparseLiveTranscript,
  liveSendEarliestMs,
  liveTranscribeUrl,
  LIVE_MIN_CHARS_PER_SECOND,
  LIVE_MIN_INPUT_TOKEN_RATIO,
  LIVE_REALTIME_FACTOR,
} from '../packages/connectors/src/audio-transcribe-live.js';
import { transcribeErrorCategory } from '../packages/runtime/src/audio-transcription-job.js';
import { withModelUsageContext } from '../packages/runtime/src/model-usage-context.js';
import { executeAudioTranscription } from '../packages/runtime/src/audio-transcription-job.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function wav(seconds = 1) {
  return buildWav(Buffer.alloc(16_000 * 2 * seconds), { channels: 1, sampleRate: 16_000, bitsPerSample: 16, blockAlign: 2 });
}

class FakeSocket {
  constructor(url, init) {
    this.url = url;
    this.init = init || {};
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

test('live frames follow realtime and TPM only slows a tighter quota', async () => {
  const audioMs = 500_000;
  const tokens = audioMs / 1000 * 32;
  const elapsed = liveSendEarliestMs(audioMs, tokens);
  const tpmOnly = tokens / 20_000 * 60_000;
  assert.ok(elapsed <= audioMs / 1);
  assert.ok(elapsed >= audioMs / 1.2);
  assert.equal(Math.round(elapsed), Math.round(audioMs / LIVE_REALTIME_FACTOR));
  assert.ok(tpmOnly < 50_000);
  assert.ok(elapsed > tpmOnly * 5);
  assert.equal(liveSendEarliestMs(audioMs, tokens, { tokensPerMinute: 1_000 }), tokens / 1_000 * 60_000);
  assert.equal(liveSendEarliestMs(audioMs, tokens, { realtimeFactor: 10 }), audioMs / 1.2);

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
  assert.ok(Math.abs(at - 1_000 / LIVE_REALTIME_FACTOR) < 1);
  assert.ok(waits.length >= 9);
  assert.equal(waits.some((ms) => ms > 200), false);

  at = 0;
  const paced = createGeminiLiveTranscriber({
    WebSocket: FakeSocket,
    now: () => at,
    sleep: async (ms) => { at += ms; },
    tokensPerMinute: 32,
  });
  await paced({ apiKey: 'AIzaSyTESTKEY1234567890', audio: wav(1) });
  assert.ok(Math.abs(at - 60_000) < 5);
});

test('a live session reports the configured model and does not echo the key', async () => {
  let seen;
  class RecordingSocket extends FakeSocket {
    constructor(url, init) {
      super(url, init);
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
  assert.equal(seen.sent[0].setup.generationConfig, undefined);
  assert.equal(seen.url, liveTranscribeUrl());
  assert.equal(seen.url.includes('key='), false);
  assert.equal(seen.init.headers['x-goog-api-key'], 'AIzaSyTESTKEY1234567890');
  assert.equal(seen.sent.some((message) => message.realtimeInput?.audio?.mimeType === 'audio/pcm;rate=16000'), true);
  assert.equal(seen.sent.at(-1).realtimeInput.audioStreamEnd, true);
  assert.equal(JSON.stringify(seen.sent).includes('AIzaSyTESTKEY1234567890'), false);
  assert.equal(JSON.stringify(seen.url).includes('AIzaSyTESTKEY1234567890'), false);
  await assert.rejects(
    createGeminiLiveTranscriber({ WebSocket: FailingSocket, now: () => 0, sleep: async () => {} })({
      apiKey: 'AIzaSyTESTKEY1234567890',
      audio: wav(1),
    }),
    (error) => error.code === 'live-failed' && !String(error.message).includes('AIzaSyTESTKEY1234567890'),
  );
});

test('a live call is recorded on success and failure without the key or socket address', async () => {
  const secret = 'AIzaSyTESTKEY1234567890';
  const rows = [];
  const observe = (row) => rows.push(JSON.parse(JSON.stringify(row)));
  await withModelUsageContext({ workspaceId: 'local', jobId: 'job-live', stage: 'x-video.article', observe }, async () => {
    const transcribe = createGeminiLiveTranscriber({
      WebSocket: FakeSocket,
      now: () => 0,
      sleep: async () => {},
      model: 'gemini-3.5-transcribe-live',
    });
    const text = await transcribe({ apiKey: secret, audio: wav(1) });
    assert.equal(text, '前半句');
  });
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows.at(-1).status, 'succeeded');
  assert.equal(rows.at(-1).model, 'gemini-3.5-transcribe-live');
  assert.equal(rows.at(-1).provider, 'gemini');
  assert.equal(rows.at(-1).kind, 'request');
  assert.equal(rows.at(-1).stage, 'x-video.article');
  assert.equal(rows.at(-1).jobId, 'job-live');
  assert.equal(rows.at(-1).keySuffix, '7890');
  assert.equal(JSON.stringify(rows).includes(secret), false);
  assert.equal(JSON.stringify(rows).includes('wss://'), false);
  assert.equal(JSON.stringify(rows).includes('generativelanguage'), false);

  rows.length = 0;
  await withModelUsageContext({ workspaceId: 'local', jobId: 'job-live', stage: 'x-video.article', observe }, async () => {
    await assert.rejects(createGeminiLiveTranscriber({
      WebSocket: FailingSocket,
      now: () => 0,
      sleep: async () => {},
    })({ apiKey: secret, audio: wav(1) }), (error) => {
      assert.equal(error.code, 'live-failed');
      assert.equal(String(error.message).includes(secret), false);
      assert.equal(String(error.message).includes('wss://'), false);
      return true;
    });
  });
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows.at(-1).status, 'failed');
  assert.equal(JSON.stringify(rows).includes(secret), false);
});

test('a sparse live result is a failure, and a timeout keeps only a full transcript', async () => {
  assert.equal(isSparseLiveTranscript({
    text: 'x'.repeat(400),
    durationMs: 500_000,
    inputTokens: 1_800,
    estimatedTokens: 16_000,
  }), true);
  assert.equal(1_800 < 16_000 * LIVE_MIN_INPUT_TOKEN_RATIO, true);
  assert.equal(isSparseLiveTranscript({
    text: '嗯',
    durationMs: 500_000,
    inputTokens: 16_000,
    estimatedTokens: 16_000,
  }), false);
  assert.equal(isSparseLiveTranscript({
    text: 'hi',
    durationMs: 60_000,
    inputTokens: null,
    estimatedTokens: 1_920,
  }), true);
  assert.equal('hi'.length / 60 < LIVE_MIN_CHARS_PER_SECOND, true);
  assert.equal(isSparseLiveTranscript({
    text: '字'.repeat(200),
    durationMs: 60_000,
    inputTokens: null,
    estimatedTokens: 1_920,
  }), false);
  assert.equal(transcribeErrorCategory(Object.assign(new Error('Live 转写结果过稀'), { code: 'live-sparse' })), 'live-sparse');

  class SparseSocket extends FakeSocket {
    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message.setup) {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ setupComplete: {} }) }));
      }
      if (message.realtimeInput?.audioStreamEnd) {
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
            serverContent: { inputTranscription: { text: 'hi' }, turnComplete: true },
          }),
        }));
      }
    }
  }
  const rows = [];
  await assert.rejects(createGeminiLiveTranscriber({
    WebSocket: SparseSocket,
    now: () => 0,
    sleep: async () => {},
  })({ apiKey: 'AIzaSyTESTKEY1234567890', audio: wav(1) }), (error) => error.code === 'live-sparse' && error.message === 'Live 转写结果过稀');
  await withModelUsageContext({ workspaceId: 'local', jobId: 'job-sparse', stage: 'audio-transcribe', observe: (row) => rows.push(row.status) }, async () => {
    await assert.rejects(createGeminiLiveTranscriber({
      WebSocket: SparseSocket,
      now: () => 0,
      sleep: async () => {},
    })({ apiKey: 'AIzaSyTESTKEY1234567890', audio: wav(1) }), (error) => error.code === 'live-sparse');
  });
  assert.equal(rows.at(-1), 'failed');

  class TimeoutSparse extends FakeSocket {
    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message.setup) {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ setupComplete: {} }) }));
      }
      if (!this.noted && message.realtimeInput?.audio && !message.realtimeInput.audioStreamEnd) {
        this.noted = true;
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({ serverContent: { inputTranscription: { text: '只有几个字' } } }),
        }));
      }
    }
  }
  await assert.rejects(createGeminiLiveTranscriber({
    WebSocket: TimeoutSparse,
    now: () => 0,
    sleep: async () => {},
    timeoutMs: 30,
  })({ apiKey: 'AIzaSyTESTKEY1234567890', audio: wav(30) }), (error) => error.code === 'live-sparse');

  class TimeoutInterim extends FakeSocket {
    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message.setup) {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ setupComplete: {} }) }));
      }
      if (!this.noted && message.realtimeInput?.audio && !message.realtimeInput.audioStreamEnd) {
        this.noted = true;
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({ serverContent: { interimInputTranscription: { text: '字'.repeat(200) } } }),
        }));
      }
    }
  }
  await assert.rejects(createGeminiLiveTranscriber({
    WebSocket: TimeoutInterim,
    now: () => 0,
    sleep: async () => {},
    timeoutMs: 30,
  })({ apiKey: 'AIzaSyTESTKEY1234567890', audio: wav(30) }), (error) => error.code === 'live-sparse');

  class TimeoutFull extends FakeSocket {
    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message.setup) {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ setupComplete: {} }) }));
      }
      if (!this.noted && message.realtimeInput?.audio && !message.realtimeInput.audioStreamEnd) {
        this.noted = true;
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({
            usageMetadata: { promptTokenCount: 960, candidatesTokenCount: 40, totalTokenCount: 1_000 },
            serverContent: { inputTranscription: { text: '字'.repeat(120) } },
          }),
        }));
      }
    }
  }
  const kept = await createGeminiLiveTranscriber({
    WebSocket: TimeoutFull,
    now: () => 0,
    sleep: async () => {},
    timeoutMs: 30,
  })({ apiKey: 'AIzaSyTESTKEY1234567890', audio: wav(30) });
  assert.equal(kept, '字'.repeat(120));
});

test('final transcript text is kept when the live turn does not complete', async () => {
  class FinalWithoutTurn extends FakeSocket {
    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message.setup) {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ setupComplete: {} }) }));
      }
      if (!this.noted && message.realtimeInput?.audio && !message.realtimeInput.audioStreamEnd) {
        this.noted = true;
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({ serverContent: { inputTranscription: { text: '已经转出的句子' } } }),
        }));
      }
    }
  }
  const transcribe = createGeminiLiveTranscriber({
    WebSocket: FinalWithoutTurn,
    now: () => 0,
    sleep: async () => {},
    timeoutMs: 30,
  });
  const text = await transcribe({ apiKey: 'AIzaSyTESTKEY1234567890', audio: wav(1) });
  assert.equal(text, '已经转出的句子');
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

test('a sparse live segment retries once at realtime and then uses the file transcriber', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-sparse-'));
  const relative = 'blobs/sample.wav';
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), wav(1));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  let liveCalls = 0;
  const fileCalls = [];
  const env = { GEMINI_API_KEY: 'live-key' };
  try {
    const recovered = await executeAudioTranscription({
      input: { workspaceId: 'local', path: relative, languageCodes: [], mode: 'SMART', plan: describeAudioTranscription(env, 1_000) },
      dataDirectory: root,
      env,
      quotaRepository: {
        reserve() { return { admitted: true, keyEnv: 'GEMINI_API_KEY', project: 'p', id: '1' }; },
        release() {},
      },
      now: () => Date.parse('2026-10-26T02:00:00Z'),
      sleep: async () => {},
      transcribe: async () => {
        liveCalls += 1;
        if (liveCalls === 1) throw Object.assign(new Error('Live 转写结果过稀'), { code: 'live-sparse' });
        return '第二次实时转写已经完整，覆盖了这一小段音频里实际说出口的内容。';
      },
      fileTranscribe: async () => { throw new Error('file transcriber was called'); },
    });
    assert.equal(liveCalls, 2);
    assert.equal(recovered.text.includes('第二次实时转写'), true);
    assert.equal(warnings.length, 0);

    liveCalls = 0;
    const fallback = await executeAudioTranscription({
      input: { workspaceId: 'local', path: relative, languageCodes: [], mode: 'SMART', plan: describeAudioTranscription(env, 1_000) },
      dataDirectory: root,
      env,
      quotaRepository: {
        reserve(input) {
          return { admitted: true, keyEnv: 'GEMINI_API_KEY', project: 'p', model: input.model, id: '1' };
        },
        release() {},
      },
      now: () => Date.parse('2026-10-26T02:00:00Z'),
      sleep: async () => {},
      transcribe: async () => {
        liveCalls += 1;
        throw Object.assign(new Error('Live 转写结果过稀'), { code: 'live-sparse' });
      },
      fileTranscribe: async ({ apiKey }) => {
        fileCalls.push(apiKey);
        return '文件转写补上了这一段。';
      },
    });
    assert.equal(liveCalls, 2);
    assert.deepEqual(fileCalls, ['live-key']);
    assert.equal(fallback.text, '文件转写补上了这一段。');
    assert.equal(warnings.some((line) => line.includes('live-sparse')), true);
    assert.equal(warnings.some((line) => /Authorization|live-key|AIza/i.test(line)), false);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a sparse live socket is not stored as success and falls back to the file transcriber', async () => {
  class SparseSocket extends FakeSocket {
    constructor(url, init) {
      super(url, init);
      SparseSocket.count += 1;
    }

    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message.setup) {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ setupComplete: {} }) }));
      }
      if (message.realtimeInput?.audioStreamEnd) {
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
            serverContent: { inputTranscription: { text: 'hi' }, turnComplete: true },
          }),
        }));
      }
    }
  }
  SparseSocket.count = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-sparse-socket-'));
  const relative = 'blobs/sample.wav';
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), wav(1));
  const env = { GEMINI_API_KEY: 'live-key' };
  let fileCalls = 0;
  try {
    const result = await executeAudioTranscription({
      input: { workspaceId: 'local', path: relative, languageCodes: [], mode: 'SMART', plan: describeAudioTranscription(env, 1_000) },
      dataDirectory: root,
      env,
      quotaRepository: {
        reserve() { return { admitted: true, keyEnv: 'GEMINI_API_KEY', project: 'p', id: '1' }; },
        release() {},
      },
      now: () => Date.parse('2026-10-26T02:00:00Z'),
      sleep: async () => {},
      transcribe: createGeminiLiveTranscriber({
        WebSocket: SparseSocket,
        now: () => 0,
        sleep: async () => {},
      }),
      fileTranscribe: async () => {
        fileCalls += 1;
        return '文件转写补上了这一段。';
      },
    });
    assert.equal(SparseSocket.count, 2);
    assert.equal(fileCalls, 1);
    assert.equal(result.text, '文件转写补上了这一段。');
    assert.equal(JSON.stringify(result).includes('live-key'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
