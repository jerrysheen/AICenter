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
