import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { gemmaTranslationInput, createGemmaTranslationRouter } from '../packages/connectors/src/translate/gemma.js';
import { translationChunkChars } from '../packages/connectors/src/translate/index.js';
import {
  EPISODE_STRUCTURE_SYSTEM,
  GEMMA_26B,
  GEMMA_31B,
  GEMMA_OUTPUT_TOKEN_CAP,
  GEMMA_REQUEST_TOKEN_LIMIT,
  GEMMA_SEGMENT_SYSTEM,
  LEGACY_GEMMA_PART_BOUNDS,
  LONG_VIDEO_GEMMA_SCHEDULE,
  gemmaRequestBudget,
  gemmaRequestText,
  longVideoCallBudget,
  longVideoGemmaCalls,
  longVideoPartBounds,
  mergeParallelArticle,
  normalizeEpisodeChapters,
  parallelSegmentConcurrency,
  parseSegmentTranslation,
  segmentStructureMaterial,
} from '../packages/domain/src/gemma-long-video.js';
import {
  GEMMA_ARTICLE_TITLE_SYSTEM,
  GEMMA_SECTION_SYSTEM,
  GEMMA_SUMMARY_SYSTEM,
  GEMMA_TRANSLATE_SYSTEM,
  splitTranscriptParts,
  transcriptHash,
} from '../packages/domain/src/youtube-captions.js';
import { runYoutubeArticlePass } from '../packages/runtime/src/youtube-article-job.js';
import { saveYoutubeEpisode } from '../packages/runtime/src/youtube-podcasts-job.js';

const sse = (text) => new Response([
  { candidates: [{ content: { parts: [{ text }] } }] },
  { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } },
].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

function openStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gemma-long-video-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    store,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function episodeTranscript(count) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    const second = index * 4;
    const hh = String(Math.floor(second / 3600)).padStart(2, '0');
    const mm = String(Math.floor((second % 3600) / 60)).padStart(2, '0');
    const ss = String(second % 60).padStart(2, '0');
    const speaker = index % 12 === 0 ? '>> ' : '';
    lines.push(`[${hh}:${mm}:${ss}] ${speaker}Sentence ${index} discusses credit, equity supply, and the market return without repeating the previous line.`);
  }
  return lines.join('\n');
}

function modelOf(url) {
  const match = String(url).match(/models\/([^:]+):/);
  return match ? match[1] : '';
}

test('request text matches the Gemma translator wrapper', () => {
  assert.equal(gemmaRequestText('系统', '原文'), gemmaTranslationInput('系统', '原文'));
});

test('one long episode drops from 62 Gemma calls to 14', () => {
  const text = episodeTranscript(380);
  const before = longVideoGemmaCalls(text, LEGACY_GEMMA_PART_BOUNDS);
  const after = longVideoGemmaCalls(text);
  assert.deepEqual(before, { parts: 28, translate: 28, section: 28, summary: 5, title: 1, total: 62 });
  assert.deepEqual(after, { parts: 6, translate: 6, section: 6, summary: 1, title: 1, total: 14 });
  assert.equal(translationChunkChars(), 1500);
  const bounds = longVideoPartBounds();
  assert.equal(bounds.maxChars, 7840);
  assert.equal(bounds.minChars, 5174);
  assert.equal(gemmaRequestBudget(GEMMA_TRANSLATE_SYSTEM, 'a'.repeat(bounds.maxChars), bounds.maxChars).fits, true);
  assert.equal(gemmaRequestBudget(GEMMA_SECTION_SYSTEM, '字'.repeat(bounds.maxChars), bounds.maxChars + 64).fits, true);
  assert.equal(gemmaRequestBudget(GEMMA_SECTION_SYSTEM, '字'.repeat(bounds.maxChars + 10), bounds.maxChars + 74).fits, false);
  assert.ok(before.total > after.total);
});

test('longer parts still cut on a sentence or a speaker change and stay in order', () => {
  const text = episodeTranscript(380);
  const bounds = longVideoPartBounds();
  const parts = splitTranscriptParts(text, bounds);
  const seen = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const next = parts[index + 1];
    if (next) {
      assert.ok(part.text.length >= bounds.minChars && part.text.length <= bounds.maxChars, part.text.length);
      const ended = /[.?!。！？]\s*$/.test(part.text);
      const speaker = next.text.startsWith('>>');
      assert.equal(ended || speaker, true);
    }
    for (const match of part.text.matchAll(/Sentence (\d+)/g)) seen.push(Number(match[1]));
    if (index > 0) assert.ok(part.start > parts[index - 1].start, `${part.start} after ${parts[index - 1].start}`);
  }
  assert.deepEqual(seen, Array.from({ length: 380 }, (_, index) => index));
  const filler = `${'alpha '.repeat(900)}>> next speaker keeps going ${'beta '.repeat(800)}`;
  const speakerParts = splitTranscriptParts(filler, bounds);
  assert.equal(speakerParts.length, 2);
  assert.equal(speakerParts[1].text.startsWith('>>'), true);
  assert.equal(filler.includes(speakerParts[0].text.trim()), true);
});

test('long video rotates 26B twice then 31B, and a 500 retries on 26B', async () => {
  const opened = openStore();
  try {
    let at = Date.parse('2026-10-21T18:00:00Z');
    const calls = [];
    const router = createGemmaTranslationRouter({
      env: {
        GEMINI_API_KEY: 'fake-key',
        GEMINI_API_KEY2: 'fake-key-2',
        AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS: '0',
        AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS: '0',
      },
      models: [GEMMA_26B, GEMMA_31B],
      schedule: LONG_VIDEO_GEMMA_SCHEDULE,
      quotaRepository: opened.store.repositories.modelQuota,
      now: () => at,
      sleep: async (ms) => { at += ms; },
      fetch: async (url, init) => {
        calls.push({ url, key: init.headers['x-goog-api-key'], body: JSON.parse(init.body) });
        if (calls.length === 3) return new Response('{"error":{"code":500,"status":"INTERNAL"}}', { status: 500 });
        return sse('译文');
      },
    });
    const first = await router.generate({ system: '翻译', prompt: 'One.', estimatedTokens: 100, maxOutputTokens: 128 });
    const second = await router.generate({ system: '翻译', prompt: 'Two.', estimatedTokens: 100, maxOutputTokens: 128 });
    const third = await router.generate({ system: '翻译', prompt: 'Three.', estimatedTokens: 100, maxOutputTokens: 128 });
    assert.equal(first.engine, GEMMA_26B);
    assert.equal(second.engine, GEMMA_26B);
    assert.equal(third.engine, GEMMA_26B);
    assert.deepEqual(calls.map((call) => modelOf(call.url)), [GEMMA_26B, GEMMA_26B, GEMMA_31B, GEMMA_26B]);
    assert.equal(calls[2].body.generationConfig.maxOutputTokens, 128);
    assert.equal(calls.some((call) => /fake-key/.test(JSON.stringify(call.body))), false);
    assert.equal(calls[3].key === 'fake-key' || calls[3].key === 'fake-key-2', true);
  } finally {
    opened.close();
  }
});

test('a Gemma call reserves input plus output and does not send a second chunk in the same minute', async () => {
  const opened = openStore();
  try {
    const at = Date.parse('2026-10-21T18:00:00Z');
    let fetches = 0;
    const router = createGemmaTranslationRouter({
      env: {
        GEMINI_API_KEY: 'fake-key',
        AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS: '0',
        AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS: '0',
        AI_CENTER_GEMMA_TRANSLATION_MAX_RETRIES: '0',
      },
      quotaRepository: opened.store.repositories.modelQuota,
      now: () => at,
      sleep: async () => {},
      fetch: async () => {
        fetches += 1;
        return new Response([
          { candidates: [{ content: { parts: [{ text: '译文' }] }, finishReason: 'STOP' }] },
        ].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    await router.generate({ system: '翻译', prompt: 'One chunk.', estimatedTokens: 12000 });
    await assert.rejects(
      router.generate({ system: '翻译', prompt: 'Next chunk.', estimatedTokens: 12000 }),
      (error) => error?.code === 'budget-deferred',
    );
    await assert.rejects(
      router.generate({ system: '翻译', prompt: 'Too big.', estimatedTokens: GEMMA_REQUEST_TOKEN_LIMIT + 1 }),
      (error) => error?.code === 'budget-deferred' && /每分钟 token/.test(error.message),
    );
    assert.equal(fetches, 1);
    assert.ok(GEMMA_OUTPUT_TOKEN_CAP <= GEMMA_REQUEST_TOKEN_LIMIT);
  } finally {
    opened.close();
  }
});

test('youtube and x article calls pass the token budget and keep the title on 26B', async () => {
  const opened = openStore();
  const transcript = '[00:00:03] Rates move and NVDA stays in the conversation.';
  const calls = [];
  const gemmaRouter = {
    async generate(input) {
      calls.push(input);
      if (input.system === GEMMA_SEGMENT_SYSTEM) {
        return { text: JSON.stringify({ points: ['利率会差 24%，NVDA 仍在讨论。', '回购加到 1100 亿美元。'], topic: '利率' }) };
      }
      if (input.system === EPISODE_STRUCTURE_SYSTEM) {
        return { text: JSON.stringify({ chapters: [{ title: '利率（00:00:03）', start: '00:00:03', partIds: [0], oneLiner: '利率会差 24%。', bullets: ['NVDA 仍在讨论'] }] }) };
      }
      if (input.system === GEMMA_ARTICLE_TITLE_SYSTEM) return { text: '利率路径仍在左右仓位' };
      throw new Error('意外的提示');
    },
  };
  try {
    const item = await saveYoutubeEpisode({
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      creator: { id: 'odd-lots', name: 'Odd Lots', focus: '金融', channels: [{ key: 'odd-lots', handle: 'oddlots' }] },
      episode: { videoId: 'longvid000001', title: 'Rates', channelKey: 'odd-lots', publishedAt: Date.parse('2026-10-18T00:00:00Z'), durationSec: 1800 },
      summaryText: '嘉宾：甲\n\n核心观点：\n1. 中文观点足够长。',
      displayTitle: '利率',
      transcript,
      transcriptSource: 'subtitle-auto',
    });
    opened.store.repositories.youtubePodcasts.saveEpisode({
      workspaceId: 'local',
      videoId: 'longvid000001',
      creatorId: 'odd-lots',
      channelKey: 'odd-lots',
      title: 'Rates',
      status: 'ready',
      transcriptSource: 'subtitle-auto',
      contentItemId: item.id,
      attempts: 1,
      sourceTranscript: transcript,
      sourceHash: transcriptHash(transcript),
      articleStatus: 'pending',
    });
    const result = await runYoutubeArticlePass({
      env: { AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1', AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: '2' },
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      now: Date.parse('2026-10-21T02:00:00Z'),
      gemmaRouter,
      flashGenerate: null,
      quotaRepository: {},
    });
    assert.equal(result.ready, 1);
    assert.deepEqual(calls.map((call) => call.system), [
      GEMMA_SEGMENT_SYSTEM,
      EPISODE_STRUCTURE_SYSTEM,
      GEMMA_ARTICLE_TITLE_SYSTEM,
    ]);
    for (const call of calls) assert.equal(call.model, GEMMA_26B);
    for (const call of calls.slice(0, 2)) {
      assert.equal(call.estimatedTokens, longVideoCallBudget(call.system, call.prompt).total);
      assert.ok(call.estimatedTokens <= GEMMA_REQUEST_TOKEN_LIMIT);
      assert.ok(call.maxOutputTokens <= GEMMA_OUTPUT_TOKEN_CAP);
    }
    assert.equal(JSON.stringify(calls).includes('fake-key'), false);
  } finally {
    opened.close();
  }
});

test('parallel segment concurrency stays within the key pool and defaults to 8', () => {
  assert.equal(parallelSegmentConcurrency(), 8);
  assert.equal(parallelSegmentConcurrency({ keyCount: 5, perKey: 2 }), 8);
  assert.equal(parallelSegmentConcurrency({ keyCount: 2, perKey: 2 }), 4);
  assert.equal(parallelSegmentConcurrency({ keyCount: 1, perKey: 2 }), 2);
  assert.equal(parallelSegmentConcurrency({ keyCount: 5, perKey: 2, cap: 4 }), 4);
});

test('structure partIds map back to full translations, not the excerpt', () => {
  const full = `${'甲'.repeat(2000)}全文结尾`;
  const parts = [
    { start: '00:01:00', translation: full, hint: ['甲要点'], topic: '甲段' },
    { start: '00:20:00', translation: '乙段全文要单独留下。', hint: ['乙要点'], topic: '乙段' },
  ];
  const material = segmentStructureMaterial(parts);
  assert.equal(material[0].excerpt.length, 1800);
  assert.equal(material[0].excerpt.includes('全文结尾'), false);
  assert.equal(material[1].i, 1);
  const parsed = parseSegmentTranslation('```json\n{"points":["利率会差 24%，NVDA 仍在讨论。","回购加到 1100 亿美元。"],"topic":"利率"}\n```');
  assert.equal(parsed.topic, '利率');
  assert.deepEqual(parsed.points, ['利率会差 24%，NVDA 仍在讨论。', '回购加到 1100 亿美元。']);
  const chapters = normalizeEpisodeChapters([
    { title: '后章', partIds: [1, 1], oneLiner: '先讲乙', bullets: ['乙要点'] },
    { title: '前章', partIds: [0], oneLiner: '再讲甲', bullets: ['甲要点'] },
    { title: '空章', partIds: [9], oneLiner: '丢掉', bullets: ['无'] },
  ], 2);
  assert.deepEqual(chapters.map((chapter) => chapter.partIds), [[1], [0]]);
  const merged = mergeParallelArticle(parts, chapters);
  assert.ok(merged.indexOf('后章') < merged.indexOf('前章'));
  assert.match(merged, /乙段全文要单独留下/);
  assert.match(merged, /甲{2000}全文结尾/);
  assert.match(merged, /^## 后章/m);
  assert.match(merged, /先讲乙/);
  assert.equal(merged.includes('### 章节总结'), false);
  assert.equal(merged.includes('- 乙要点'), false);
  assert.ok(merged.indexOf('先讲乙') < merged.indexOf('乙段全文要单独留下'));
  const orphan = mergeParallelArticle(parts, normalizeEpisodeChapters([
    { title: '只收到第一段', partIds: [0], oneLiner: '甲', bullets: ['甲要点'] },
  ], 2));
  assert.match(orphan, /补充段落/);
  assert.match(orphan, /乙段全文要单独留下/);
});
