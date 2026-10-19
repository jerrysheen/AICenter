import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import {
  articlePartPrompt,
  dedupeRollingCaptions,
  needsChineseTitle,
  splitTranscriptParts,
  stripDoubaoReply,
  transcriptHash,
} from '../packages/domain/src/youtube-captions.js';
import { formatPodcastSummary } from '../packages/domain/src/youtube-podcasts.js';
import { repairYoutubeChineseCopy, runYoutubeArticlePass } from '../packages/runtime/src/youtube-article-job.js';
import { runYoutubePodcastRound, saveYoutubeEpisode } from '../packages/runtime/src/youtube-podcasts-job.js';

const ROLLING = `[00:00:03] In general, the market does about 4% worse per
[00:00:05] worse per percent of market cap that comes in in
[00:00:08] percent of market cap that comes in in an IPO in a given year. So, if we are
[00:00:10] an IPO in a given year. So, if we are seeing 6% coming in, that's 24%
[00:00:54] in the market. &gt;&gt; This episode is brought to you by Sarmaaya.`;

const MANUAL = `[00:01:00] Hello there, this is a complete sentence.
[00:01:04] This is a new sentence without any repeated words.
[00:01:08] Manual captions stay intact for the reader.`;

function openStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youtube-article-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    store,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function creatorConfig() {
  return {
    minDurationSec: 1200,
    lookback: 2,
    creators: [{
      id: 'odd-lots',
      name: 'Odd Lots',
      focus: '金融',
      channels: [{ key: 'odd-lots', kind: 'playlist', playlistId: 'PLtest', url: 'https://www.youtube.com/playlist?list=PLtest' }],
    }],
  };
}

function sentences(count) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    const second = index * 4;
    const hh = String(Math.floor(second / 3600)).padStart(2, '0');
    const mm = String(Math.floor((second % 3600) / 60)).padStart(2, '0');
    const ss = String(second % 60).padStart(2, '0');
    lines.push(`[${hh}:${mm}:${ss}] Sentence ${index} discusses credit, equity supply, and the market return without repeating the previous line.`);
  }
  return lines.join('\n');
}

function reply(text = '主持人：这是整理后的正文，保留了论证。') {
  return {
    status: 'ok',
    reply_text: `## 小标题（00:00:03）\n\n${text}\n本回答由AI生成，仅供参考，请仔细甄别。\n如何继续翻译下一段？`,
    page_url: 'https://www.doubao.com/chat/42',
    send_confirmed: true,
    reply_count_before: 1,
  };
}

function fakeDoubao(handler) {
  const calls = [];
  const client = {
    calls,
    async ask(question, options = {}) {
      const call = { kind: 'ask', question, pageUrl: options.pageUrl || '' };
      calls.push(call);
      return handler(call);
    },
    async readReply(options = {}) {
      const call = { kind: 'read', pageUrl: options.pageUrl || '', before: options.beforeReplyCount };
      calls.push(call);
      return handler(call);
    },
  };
  return client;
}

test('rolling captions collapse repeated tails and manual captions keep their words', () => {
  const deduped = dedupeRollingCaptions(ROLLING);
  assert.ok(deduped.length < ROLLING.length);
  assert.equal(deduped.includes('worse per percent of market cap that comes in in an IPO'), true);
  assert.equal(deduped.includes('worse per worse per'), false);
  assert.equal(deduped.includes('&gt;'), false);
  assert.match(deduped, />> This episode is brought to you by Sarmaaya/);
  const manual = dedupeRollingCaptions(MANUAL);
  assert.match(manual, /Hello there, this is a complete sentence/);
  assert.match(manual, /This is a new sentence without any repeated words/);
  assert.match(manual, /Manual captions stay intact for the reader/);
});

test('transcript parts cut on a sentence and stay inside the size window', () => {
  const parts = splitTranscriptParts(dedupeRollingCaptions(sentences(220)));
  assert.ok(parts.length >= 2);
  for (const part of parts.slice(0, -1)) {
    assert.ok(part.text.length >= 10_000 && part.text.length <= 12_000, part.text.length);
    assert.match(part.text.trim(), /[.?!。！？]$/);
  }
  assert.ok(parts.at(-1).text.length < 12_000);
  assert.equal(splitTranscriptParts('Short manual caption. It stays one part.').length, 1);
});

test('doubao footer and follow-up questions are removed', () => {
  const cleaned = stripDoubaoReply(`主持人：市场会差 24%。\n本回答由 AI 生成，仅供参考，请仔细甄别，谨慎投资。\n如何判断AI是一场泡沫？\n能否再提供一些案例？`);
  assert.equal(cleaned, '主持人：市场会差 24%。');
  const bare = stripDoubaoReply('感谢收看。\n将第6段字幕中的重点术语标注出来\n能否再提供一些关于过度投资风险的具体案例？');
  assert.equal(bare, '感谢收看。');
});

test('later parts keep the short prompt and the first part carries the full instruction', () => {
  const first = articlePartPrompt({ index: 0, total: 6, text: '[00:00:03] Hello.' });
  const second = articlePartPrompt({ index: 1, total: 6, text: '[00:14:15] Next.' });
  assert.match(first, /不要写成摘要/);
  assert.match(first, /第 1\/6 段/);
  assert.match(first, /术语保留英文/);
  assert.equal(second.startsWith('第 2/6 段，沿用格式。'), true);
  assert.equal(second.includes('不要写成摘要'), false);
  const recovered = articlePartPrompt({ index: 1, total: 6, text: 'Next.', previousTail: '上一段结尾。', fresh: true });
  assert.match(recovered, /上一段文章的结尾是/);
  assert.match(recovered, /上一段结尾/);
});

test('english titles need a Chinese pass and Chinese titles do not', () => {
  assert.equal(needsChineseTitle('Odd Lots · Don Wilson'), true);
  assert.equal(needsChineseTitle('利率和仓位'), false);
  assert.equal(needsChineseTitle('奇谈：唐·威尔逊'), false);
});

test('article switch off keeps the original captions and does not call Doubao', async () => {
  const opened = openStore();
  const doubao = fakeDoubao(() => {
    throw new Error('开关关闭时不应调用豆包');
  });
  try {
    const transcript = '[00:00:03] Hello rates\n[00:00:05] Hello rates again later';
    await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => { throw new Error('中文摘要不应再翻译'); },
      doubaoClient: doubao,
      fetchRss: async () => ({ entries: [{ videoId: 'articleoff01', title: 'Rates', publishedAt: Date.parse('2026-10-18T00:00:00Z'), channelKey: 'odd-lots' }] }),
      probe: async () => ({ durationSec: 1800, transcript, transcriptSource: 'subtitle-auto' }),
      summarize: async () => ({
        titleZh: '利率和仓位',
        guests: ['嘉宾甲'],
        points: ['观点一', '观点二', '观点三', '观点四', '观点五'],
        companies: ['NVDA'],
        relation: '和金融相关',
        quotes: [{ time: '00:12:03', text: '关键句' }],
      }),
    });
    const saved = opened.store.repositories.youtubePodcasts.getReady('local', 'articleoff01');
    assert.equal(saved.articleStatus, '');
    assert.match(saved.body, /Hello rates/);
    assert.equal(saved.sourceTranscript.includes('Hello rates'), true);
    assert.equal(doubao.calls.length, 0);
  } finally {
    opened.close();
  }
});

test('same conversation translates each part, strips the footer, and keeps the source', async () => {
  const opened = openStore();
  const doubao = fakeDoubao(() => reply());
  try {
    await runYoutubePodcastRound({
      env: {
        AI_CENTER_YOUTUBE_PODCASTS: '1',
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1',
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: '2',
        GEMINI_API_KEY: 'test-key',
      },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      now: Date.parse('2026-10-19T02:00:00Z'),
      translate: async () => { throw new Error('正文不应走 Gemma'); },
      doubaoClient: doubao,
      fetchRss: async () => ({ entries: [{ videoId: 'articleon0001', title: 'Rates', publishedAt: Date.parse('2026-10-18T00:00:00Z'), channelKey: 'odd-lots' }] }),
      probe: async () => ({ durationSec: 1800, transcript: sentences(220), transcriptSource: 'subtitle-auto' }),
      summarize: async () => ({
        titleZh: '利率和仓位',
        guests: ['嘉宾甲'],
        points: ['观点一', '观点二', '观点三', '观点四', '观点五'],
        companies: ['NVDA'],
        relation: '和金融相关',
        quotes: [{ time: '00:00:03', text: '关键句' }],
      }),
    });
    const saved = opened.store.repositories.youtubePodcasts.getReady('local', 'articleon0001');
    assert.equal(saved.articleStatus, 'ready');
    assert.match(saved.body, /主持人：这是整理后的正文/);
    assert.equal(saved.body.includes('本回答由AI生成'), false);
    assert.equal(saved.body.includes('如何继续翻译'), false);
    assert.match(saved.sourceTranscript, /Sentence 0 discusses/);
    assert.equal(saved.body.includes('Sentence 0 discusses'), false);
    assert.ok(doubao.calls.length >= 2);
    assert.equal(doubao.calls[0].pageUrl, '');
    assert.equal(doubao.calls[1].pageUrl, 'https://www.doubao.com/chat/42');
    assert.match(doubao.calls[0].question, /不要写成摘要/);
    assert.match(doubao.calls[1].question, /^第 2\//);
    const again = doubao.calls.length;
    await runYoutubePodcastRound({
      env: {
        AI_CENTER_YOUTUBE_PODCASTS: '1',
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1',
        GEMINI_API_KEY: 'test-key',
      },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      now: Date.parse('2026-10-19T03:00:00Z'),
      translate: async () => { throw new Error('不应再翻译'); },
      doubaoClient: doubao,
      fetchRss: async () => ({ entries: [{ videoId: 'articleon0001', title: 'Rates', publishedAt: Date.parse('2026-10-18T00:00:00Z'), channelKey: 'odd-lots' }] }),
      probe: async () => { throw new Error('已完成的集不应再探测'); },
      summarize: async () => { throw new Error('已完成的集不应再摘要'); },
    });
    assert.equal(doubao.calls.length, again);
    assert.equal(opened.store.repositories.youtubePodcasts.getReady('local', 'articleon0001').body.includes('主持人'), true);
  } finally {
    opened.close();
  }
});

test('unconfirmed sends are resent and a missing reply is only reread', async () => {
  const opened = openStore();
  const transcript = '[00:00:03] One short caption that stays a single part for the retry test.';
  const item = await saveYoutubeEpisode({
    feedRepository: opened.store.repositories.feed,
    workspaceId: 'local',
    creator: { id: 'odd-lots', name: 'Odd Lots', focus: '金融', channels: [{ key: 'odd-lots', handle: 'oddlots' }] },
    episode: { videoId: 'retryvid0001', title: 'Rates', channelKey: 'odd-lots', publishedAt: Date.parse('2026-10-18T00:00:00Z'), durationSec: 1800 },
    summaryText: '嘉宾：甲\n\n核心观点：\n1. 中文观点足够长。',
    displayTitle: '利率',
    transcript,
    transcriptSource: 'subtitle-auto',
  });
  opened.store.repositories.youtubePodcasts.saveEpisode({
    workspaceId: 'local',
    videoId: 'retryvid0001',
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
  const resend = fakeDoubao((call) => {
    if (call.kind === 'ask' && resend.calls.filter((item) => item.kind === 'ask').length < 2) {
      return { status: 'send_not_confirmed', send_confirmed: false, note: '页面没有确认已发出', page_url: '' };
    }
    return reply('主持人：重发后的正文。');
  });
  try {
    const first = await runYoutubeArticlePass({
      env: { AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1', AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: '2' },
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      doubaoClient: resend,
      now: Date.parse('2026-10-19T02:00:00Z'),
    });
    assert.equal(first.ready, 1);
    assert.equal(resend.calls.filter((call) => call.kind === 'read').length, 0);
    assert.ok(resend.calls.filter((call) => call.kind === 'ask').length >= 2);
    const stored = opened.store.repositories.youtubePodcasts.episode('local', 'retryvid0001');
    const state = JSON.parse(stored.articleState);
    state.parts[0].status = 'sent';
    state.parts[0].reply = '';
    state.chatUrl = 'https://www.doubao.com/chat/42';
    state.parts[0].beforeReplyCount = 1;
    opened.store.repositories.youtubePodcasts.saveEpisode({
      workspaceId: 'local',
      videoId: 'retryvid0001',
      creatorId: 'odd-lots',
      channelKey: 'odd-lots',
      title: 'Rates',
      status: 'ready',
      contentItemId: item.id,
      attempts: 1,
      sourceTranscript: transcript,
      sourceHash: transcriptHash(transcript),
      articleStatus: 'pending',
      articleState: JSON.stringify(state),
      articleDay: '2026-10-20',
    });
    const reread = fakeDoubao(() => reply('主持人：重读到的正文。'));
    const second = await runYoutubeArticlePass({
      env: { AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1' },
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      doubaoClient: reread,
      now: Date.parse('2026-10-20T02:00:00Z'),
    });
    assert.equal(second.ready, 1);
    assert.equal(reread.calls.length, 1);
    assert.equal(reread.calls[0].kind, 'read');
    assert.match(opened.store.repositories.youtubePodcasts.getReady('local', 'retryvid0001').body, /重读到的正文/);
  } finally {
    opened.close();
  }
});

test('login stops the day and a failed part opens a new chat with the previous ending', async () => {
  const opened = openStore();
  try {
    const login = fakeDoubao(() => ({
      status: 'login_required',
      note: '豆包输入框不可用',
      page_url: 'https://www.doubao.com/chat',
      send_confirmed: false,
    }));
    await runYoutubePodcastRound({
      env: {
        AI_CENTER_YOUTUBE_PODCASTS: '1',
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1',
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: '4',
        GEMINI_API_KEY: 'test-key',
      },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      now: Date.parse('2026-10-19T02:00:00Z'),
      translate: async () => { throw new Error('未登录时不应改走 Gemma'); },
      doubaoClient: login,
      fetchRss: async () => ({
        entries: [
          { videoId: 'loginvideo01', title: 'Rates', publishedAt: Date.parse('2026-10-18T00:00:00Z'), channelKey: 'odd-lots' },
          { videoId: 'loginvideo02', title: 'Later', publishedAt: Date.parse('2026-10-17T00:00:00Z'), channelKey: 'odd-lots' },
        ],
      }),
      probe: async (entry) => ({ durationSec: 1800, transcript: `[00:00:03] Caption for ${entry.videoId}. It is already one clean sentence.`, transcriptSource: 'subtitle-manual' }),
      summarize: async () => ({
        titleZh: '利率和仓位',
        guests: ['嘉宾甲'],
        points: ['观点一', '观点二', '观点三', '观点四', '观点五'],
        companies: ['NVDA'],
        relation: '和金融相关',
        quotes: [{ time: '00:00:03', text: '关键句' }],
      }),
    });
    assert.equal(login.calls.length, 1);
    const pending = opened.store.repositories.youtubePodcasts.episode('local', 'loginvideo01');
    assert.equal(pending.articleStatus, 'pending');
    const shown = opened.store.repositories.youtubePodcasts.getReady('local', 'loginvideo01');
    assert.match(shown.body, /Caption for loginvideo01/);
    assert.equal(shown.body.includes('[00:00:05]'), false);
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'loginvideo02').articleStatus, 'pending');
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'loginvideo02').articleDay, '');
  } finally {
    opened.close();
  }
});

test('a failed part opens a new chat with the previous ending', async () => {
  const opened = openStore();
  const recovery = fakeDoubao((call) => {
      if (call.question.includes('不要写成摘要')) return reply('主持人：第一段结尾就停在这里。');
      if (call.question.includes('上一段文章的结尾是')) return reply('主持人：新对话补上的第二段。');
      return { status: 'send_not_confirmed', send_confirmed: false, note: '页面没有确认已发出', page_url: 'https://www.doubao.com/chat/42' };
    });
  try {
    const long = sentences(220);
    const item = await saveYoutubeEpisode({
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      creator: { id: 'odd-lots', name: 'Odd Lots', focus: '金融', channels: [{ key: 'odd-lots' }] },
      episode: { videoId: 'recovervid01', title: 'Rates', channelKey: 'odd-lots', publishedAt: Date.parse('2026-10-16T00:00:00Z'), durationSec: 1800 },
      summaryText: '中文摘要',
      displayTitle: '利率',
      transcript: long,
      transcriptSource: 'subtitle-auto',
    });
    opened.store.repositories.youtubePodcasts.saveEpisode({
      workspaceId: 'local',
      videoId: 'recovervid01',
      creatorId: 'odd-lots',
      channelKey: 'odd-lots',
      title: 'Rates',
      status: 'ready',
      contentItemId: item.id,
      attempts: 1,
      sourceTranscript: long,
      sourceHash: transcriptHash(long),
      articleStatus: 'pending',
    });
    const recovered = await runYoutubeArticlePass({
      env: { AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1', AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: '4' },
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      doubaoClient: recovery,
      now: Date.parse('2026-10-21T02:00:00Z'),
    });
    assert.equal(recovered.ready, 1);
    assert.ok(recovery.calls.some((call) => call.question.includes('上一段文章的结尾是') && call.question.includes('第一段结尾')));
    assert.equal(recovery.calls.filter((call) => call.question.includes('上一段')).every((call) => call.pageUrl === ''), true);
  } finally {
    opened.close();
  }
});

test('daily cap leaves the next ready episode for tomorrow', async () => {
  const opened = openStore();
  const doubao = fakeDoubao(() => reply('主持人：只整理了一集。'));
  try {
    await runYoutubePodcastRound({
      env: {
        AI_CENTER_YOUTUBE_PODCASTS: '1',
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE: '1',
        AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY: '1',
        GEMINI_API_KEY: 'test-key',
      },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      now: Date.parse('2026-10-19T02:00:00Z'),
      translate: async () => { throw new Error('不应翻译正文'); },
      doubaoClient: doubao,
      fetchRss: async () => ({
        entries: [
          { videoId: 'capvideo0001', title: 'Newer', publishedAt: Date.parse('2026-10-18T00:00:00Z'), channelKey: 'odd-lots' },
          { videoId: 'capvideo0002', title: 'Older', publishedAt: Date.parse('2026-10-17T00:00:00Z'), channelKey: 'odd-lots' },
        ],
      }),
      probe: async (entry) => ({ durationSec: 1800, transcript: `[00:00:03] Caption ${entry.videoId} is one sentence.`, transcriptSource: 'subtitle-manual' }),
      summarize: async () => ({
        titleZh: '利率和仓位',
        guests: ['嘉宾甲'],
        points: ['观点一', '观点二', '观点三', '观点四', '观点五'],
        companies: ['NVDA'],
        relation: '和金融相关',
        quotes: [{ time: '00:00:03', text: '关键句' }],
      }),
    });
    assert.equal(doubao.calls.length, 1);
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'capvideo0001').articleStatus, 'ready');
    assert.equal(opened.store.repositories.youtubePodcasts.episode('local', 'capvideo0002').articleDay, '');
    assert.notEqual(opened.store.repositories.youtubePodcasts.episode('local', 'capvideo0002').articleStatus, 'ready');
  } finally {
    opened.close();
  }
});

test('english title and quote are translated with the summary translator', async () => {
  const opened = openStore();
  const seen = [];
  try {
    await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async (text) => {
        seen.push(text);
        if (String(text).includes('Odd Lots')) return '奇谈：唐·威尔逊';
        if (String(text).includes('worse')) return '市场每多一个百分点大约差百分之四。';
        throw new Error(`不应整篇翻译：${text}`);
      },
      fetchRss: async () => ({ entries: [{ videoId: 'titlevid0001', title: 'Odd Lots · Don Wilson', publishedAt: Date.parse('2026-10-18T00:00:00Z'), channelKey: 'odd-lots' }] }),
      probe: async () => ({ durationSec: 1800, transcript: '[00:12:03] The market does about 4% worse.', transcriptSource: 'subtitle-auto' }),
      summarize: async () => ({
        titleZh: 'Odd Lots · Don Wilson',
        guests: ['Don Wilson'],
        points: ['市场在讨论利率和仓位。', '第二条也是中文观点。', '第三条继续用中文。', '第四条。', '第五条。'],
        companies: ['NVDA'],
        relation: '和金融相关',
        quotes: [{ time: '00:12:03', text: 'The market does about 4% worse per percent.' }],
      }),
    });
    const saved = opened.store.repositories.youtubePodcasts.getReady('local', 'titlevid0001');
    assert.equal(saved.displayTitle, '奇谈：唐·威尔逊');
    assert.match(saved.summary, /市场每多一个百分点/);
    assert.equal(saved.summary.includes('4% worse'), false);
    assert.equal(seen.some((text) => String(text).includes('核心观点')), false);
    const formatted = formatPodcastSummary({
      titleZh: '奇谈：唐·威尔逊',
      points: ['中文'],
      quotes: [{ time: '00:12:03', text: '市场每多一个百分点大约差百分之四。' }],
    });
    assert.match(formatted, /关键句/);
  } finally {
    opened.close();
  }
});

test('an existing english title and quote are repaired on the next round', async () => {
  const opened = openStore();
  try {
    const item = await saveYoutubeEpisode({
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      creator: { id: 'odd-lots', name: 'Odd Lots', focus: '金融', channels: [{ key: 'odd-lots' }] },
      episode: { videoId: 'oldtitle0001', title: 'Odd Lots · Don Wilson', channelKey: 'odd-lots', publishedAt: Date.parse('2026-10-18T00:00:00Z'), durationSec: 1800 },
      summaryText: '嘉宾：Don Wilson\n\n核心观点：\n1. 市场在讨论利率和仓位。\n2. 第二条也是中文。\n3. 第三条。\n4. 第四条。\n5. 第五条。\n\n关键句：\n- 00:12:03 The market does about 4% worse per percent.',
      displayTitle: 'Odd Lots · Don Wilson',
      transcript: '[00:12:03] The market does about 4% worse.',
      transcriptSource: 'subtitle-auto',
    });
    opened.store.repositories.youtubePodcasts.saveEpisode({
      workspaceId: 'local',
      videoId: 'oldtitle0001',
      creatorId: 'odd-lots',
      channelKey: 'odd-lots',
      title: 'Odd Lots · Don Wilson',
      status: 'ready',
      contentItemId: item.id,
      attempts: 1,
      publishedAt: Date.parse('2026-10-18T00:00:00Z'),
    });
    const doubao = fakeDoubao(() => { throw new Error('标题修复不应调用豆包'); });
    await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async (text) => {
        if (String(text).includes('Odd Lots')) return '奇谈：唐·威尔逊';
        if (String(text).includes('worse')) return '市场每多一个百分点大约差百分之四。';
        throw new Error(`不应整篇翻译：${text}`);
      },
      doubaoClient: doubao,
      fetchRss: async () => ({ entries: [] }),
      probe: async () => { throw new Error('没有新集'); },
    });
    const saved = opened.store.repositories.youtubePodcasts.getReady('local', 'oldtitle0001');
    assert.equal(saved.displayTitle, '奇谈：唐·威尔逊');
    assert.match(saved.summary, /市场每多一个百分点/);
    assert.equal(saved.body.includes('The market does about 4% worse'), true);
    assert.equal(doubao.calls.length, 0);
    const twice = await repairYoutubeChineseCopy({
      env: {},
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      translate: async () => { throw new Error('已经是中文'); },
    });
    assert.equal(twice.repaired, 0);
  } finally {
    opened.close();
  }
});

test('a skipped transcribe-is-not-a-function episode is retried', async () => {
  const opened = openStore();
  try {
    opened.store.repositories.youtubePodcasts.saveEpisode({
      workspaceId: 'local',
      videoId: 'fnbugvid0001',
      creatorId: 'odd-lots',
      channelKey: 'odd-lots',
      title: 'Rates',
      publishedAt: Date.parse('2026-10-18T00:00:00Z'),
      status: 'skipped',
      reason: 'transcribe is not a function',
      attempts: 3,
    });
    const result = await runYoutubePodcastRound({
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1', GEMINI_API_KEY: 'test-key' },
      config: creatorConfig(),
      repository: opened.store.repositories.youtubePodcasts,
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      sleep: async () => {},
      translate: async () => { throw new Error('中文摘要不应再翻译'); },
      fetchRss: async () => ({ entries: [{ videoId: 'fnbugvid0001', title: 'Rates', publishedAt: Date.parse('2026-10-18T00:00:00Z'), channelKey: 'odd-lots' }] }),
      probe: async () => ({ durationSec: 1800, transcript: '[00:12:03] 有字幕就可以入库', transcriptSource: 'subtitle-manual' }),
      summarize: async () => ({
        titleZh: '利率和仓位',
        guests: ['嘉宾甲'],
        points: ['观点一', '观点二', '观点三', '观点四', '观点五'],
        companies: ['NVDA'],
        relation: '和金融相关',
        quotes: [{ time: '00:12:03', text: '关键句' }],
      }),
    });
    assert.equal(result.subtitles, 1);
    assert.equal(opened.store.repositories.youtubePodcasts.getReady('local', 'fnbugvid0001').transcriptSource, 'subtitle-manual');
  } finally {
    opened.close();
  }
});
