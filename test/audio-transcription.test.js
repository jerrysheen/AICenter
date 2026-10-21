import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import {
  buildWav,
  describeAudioTranscription,
  resolveAudioFile,
} from '../packages/domain/src/audio-transcription.js';
import { executeAudioTranscription } from '../packages/runtime/src/audio-transcription-job.js';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

test('a 4 hour recording is split to the per-minute budget and spread across keys', () => {
  const env = {
    GEMINI_API_KEY: 'one',
    GEMINI_API_KEY2: 'two',
    GEMINI_API_KEY3: 'three',
    GEMINI_API_KEY4: 'four',
    GEMINI_API_KEY5: 'five',
    AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY,GEMINI_API_KEY2,GEMINI_API_KEY3,GEMINI_API_KEY4,GEMINI_API_KEY5',
  };
  const plan = describeAudioTranscription(env, FOUR_HOURS_MS);
  assert.equal(plan.laneCount, 5);
  assert.equal(plan.chunkMs, 500_000);
  assert.equal(plan.chunkCount, 29);
  assert.equal(plan.tokenBudgetMinutes, 6);
  assert.equal(plan.chunks[0].startMs, 0);
  assert.equal(plan.chunks.at(-1).endMs, FOUR_HOURS_MS);
  assert.ok(plan.chunks.every((chunk, index) => chunk.estimatedTokens <= 16_000 && chunk.lane === index % 5));
  const shared = describeAudioTranscription({
    ...env,
    GEMINI_API_KEY_PROJECT: 'same',
    GEMINI_API_KEY2_PROJECT: 'same',
    GEMINI_API_KEY3_PROJECT: 'same',
    GEMINI_API_KEY4_PROJECT: 'same',
    GEMINI_API_KEY5_PROJECT: 'same',
  }, FOUR_HOURS_MS);
  assert.equal(shared.laneCount, 1);
  assert.equal(shared.tokenBudgetMinutes, 29);
});

test('segments are sent separately and joined back in order', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-tx-'));
  const relative = 'blobs/sample.wav';
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const pcm = Buffer.alloc(16_000 * 2 * 3);
  fs.writeFileSync(absolute, buildWav(pcm, { channels: 1, sampleRate: 16_000, bitsPerSample: 16, blockAlign: 2 }));
  const store = createStore(path.join(root, 'test.db'));
  const seen = [];
  const env = { GEMINI_API_KEY: 'one', GEMINI_API_KEY2: 'two', AI_CENTER_AUDIO_TRANSCRIBE_TOKENS_PER_MINUTE: '80' };
  let at = 1_000_000;
  try {
    const result = await executeAudioTranscription({
      input: {
        workspaceId: 'local',
        path: relative,
        languageCodes: [],
        mode: 'SMART',
        plan: describeAudioTranscription(env, 3_000),
      },
      dataDirectory: root,
      env,
      quotaRepository: store.repositories.modelQuota,
      now: () => at,
      sleep: async (ms) => { at += ms; },
      transcribe: async ({ apiKey, audio }) => {
        seen.push(apiKey);
        assert.ok(audio.length > 44);
        return apiKey === 'one' ? '前段' : '后段';
      },
    });
    assert.deepEqual(seen.sort(), ['one', 'two']);
    assert.equal(result.text, '前段\n后段');
    assert.equal(result.segments.length, 2);
  } finally {
    store.close();
  }
});

test('audio path must stay inside the data directory', () => {
  assert.throws(() => resolveAudioFile('C:/data', '../secret.wav'), /数据目录/);
});

function writeSeconds(root, seconds) {
  const relative = 'blobs/sample.wav';
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, buildWav(Buffer.alloc(16_000 * 2 * seconds), {
    channels: 1, sampleRate: 16_000, bitsPerSample: 16, blockAlign: 2,
  }));
  return relative;
}

function quota() {
  return {
    reserve() { return { admitted: true, keyEnv: 'GEMINI_API_KEY' }; },
    release() {},
  };
}

test('a live failure is logged by category and only then uses the file model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-live-log-'));
  const env = { GEMINI_API_KEY: 'assembly-key' };
  const relative = writeSeconds(root, 1);
  const secret = 'AIzaSySECRETKEY1234567890';
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let liveCalls = 0;
  let fileCalls = 0;
  try {
    const result = await executeAudioTranscription({
      input: {
        workspaceId: 'local',
        path: relative,
        languageCodes: ['en'],
        mode: 'SMART',
        plan: describeAudioTranscription(env, 1_000),
      },
      dataDirectory: root,
      env,
      quotaRepository: quota(),
      now: () => 1_000,
      sleep: async () => {},
      transcribe: async () => {
        liveCalls += 1;
        throw new Error(`fetch failed wss://generativelanguage.googleapis.com/ws?key=${secret}`);
      },
      fileTranscribe: async () => {
        fileCalls += 1;
        return '文件转写';
      },
    });
    assert.equal(result.text, '文件转写');
    assert.equal(liveCalls, 3);
    assert.equal(fileCalls, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /语音转写 Live 失败，改走文件转写：network/);
    assert.equal(warnings[0].includes(secret), false);
    assert.equal(warnings[0].includes('wss://'), false);
    assert.equal(warnings[0].includes('generativelanguage'), false);
  } finally {
    console.warn = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed segment aborts the others and a later run keeps the finished text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-abort-'));
  const env = {
    GEMINI_API_KEY: 'one',
    GEMINI_API_KEY2: 'two',
    GEMINI_API_KEY3: 'three',
    AI_CENTER_AUDIO_TRANSCRIBE_TOKENS_PER_MINUTE: '80',
  };
  const relative = writeSeconds(root, 5);
  let entered = 0;
  let aborted = false;
  const saved = [];
  try {
    await assert.rejects(() => executeAudioTranscription({
      input: {
        workspaceId: 'local',
        path: relative,
        languageCodes: [],
        mode: 'SMART',
        plan: describeAudioTranscription(env, 5_000),
      },
      dataDirectory: root,
      env,
      quotaRepository: {
        reserve(input) {
          return { admitted: true, keyEnv: input.slots[0].keyEnv };
        },
        release() {},
      },
      now: () => 1_000,
      sleep: async () => {},
      onSegment: (segment) => saved.push(segment),
      transcribe: ({ signal }) => {
        const mine = entered;
        entered += 1;
        if (mine === 0) return '第一段';
        if (mine === 1) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('分段没有取消')), 2_000);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              aborted = true;
              reject(Object.assign(new Error('转写已取消'), { name: 'AbortError', code: 'aborted' }));
            }, { once: true });
          });
        }
        throw new Error('分段失败');
      },
    }), (error) => {
      assert.equal(error.completedSegments.length, 1);
      assert.equal(error.completedSegments[0].text, '第一段');
      assert.equal(String(error.message).includes('wss://'), false);
      return true;
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].text, '第一段');
    assert.equal(aborted, true);

    let resumedCalls = 0;
    const again = await executeAudioTranscription({
      input: {
        workspaceId: 'local',
        path: relative,
        languageCodes: [],
        mode: 'SMART',
        plan: describeAudioTranscription(env, 5_000),
      },
      dataDirectory: root,
      env,
      quotaRepository: {
        reserve(input) {
          return { admitted: true, keyEnv: input.slots[0].keyEnv };
        },
        release() {},
      },
      now: () => 2_000,
      sleep: async () => {},
      resumeSegments: saved,
      transcribe: () => {
        resumedCalls += 1;
        return '续上';
      },
    });
    assert.equal(resumedCalls, 2);
    assert.match(again.text, /第一段/);
    assert.match(again.text, /续上/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fetch failed is retried a limited number of times and abort is not', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-retry-'));
  const env = { GEMINI_API_KEY: 'one' };
  const relative = writeSeconds(root, 1);
  const input = {
    workspaceId: 'local',
    path: relative,
    languageCodes: [],
    mode: 'SMART',
    plan: describeAudioTranscription(env, 1_000),
  };
  try {
    let calls = 0;
    const result = await executeAudioTranscription({
      input,
      dataDirectory: root,
      env,
      quotaRepository: quota(),
      now: () => 1_000,
      sleep: async () => {},
      transcribe: async () => {
        calls += 1;
        if (calls < 3) throw new Error('fetch failed');
        return '第三次成功';
      },
    });
    assert.equal(calls, 3);
    assert.equal(result.text, '第三次成功');

    let abortedCalls = 0;
    await assert.rejects(() => executeAudioTranscription({
      input,
      dataDirectory: root,
      env,
      quotaRepository: quota(),
      now: () => 1_000,
      sleep: async () => {},
      transcribe: async () => {
        abortedCalls += 1;
        throw Object.assign(new Error('转写已取消'), { name: 'AbortError', code: 'aborted' });
      },
    }), (error) => error.name === 'AbortError');
    assert.equal(abortedCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
