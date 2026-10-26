import { setTimeout as delay } from 'node:timers/promises';
import { formatYmd, zonedParts } from '../../domain/src/zoned-time.js';
import {
  articlePartPrompt,
  continuedDoubaoChatUrl,
  dedupeRollingCaptions,
  stripResidualEnglish,
  captionAlreadyChinese,
  CHAPTER_DIALOGUE_LAYOUT,
  GEMMA_ARTICLE_TITLE_SYSTEM,
  GEMMA_SECTION_SYSTEM,
  GEMMA_SUMMARY_SYSTEM,
  GEMMA_TRANSLATE_SYSTEM,
  articleTitleSource,
  gemmaArticleNeedsRepair,
  gemmaSummarySource,
  normalizeArticleTitle,
  joinArticleParts,
  joinGemmaArticle,
  repairTimestampHeading,
  timestampOnlyHeading,
  needsChineseTitle,
  needsEnglishQuote,
  splitTranscriptParts,
  stripDoubaoReply,
  transcriptHash,
} from '../../domain/src/youtube-captions.js';
import {
  youtubeArticleDailyLimit,
  youtubeArticleEnabled,
  youtubeArticleEngine,
  youtubePodcastClock,
  youtubeTitleRepairLimit,
} from '../../domain/src/youtube-podcasts.js';
import { createDoubaoChatClient } from '../../connectors/src/doubao/chat-browser.js';
import { createGeminiInvestorSummarizer } from '../../connectors/src/investor-discussion-model.js';
import { createGemmaTranslationRouter, resolveGemmaTranslationSlots } from '../../connectors/src/translate/gemma.js';
import {
  EPISODE_COMPILE_SYSTEM,
  EPISODE_STRUCTURE_SYSTEM,
  GEMMA_26B,
  GEMMA_31B,
  GEMMA_SEGMENT_SYSTEM,
  LONG_VIDEO_GEMMA_SCHEDULE,
  MERGE_CHAPTER_CONCAT,
  MERGE_POINT_COMPILE,
  PARALLEL_SEGMENT_LAYOUT,
  POINTS_SEGMENT_KIND,
  acceptCompiledArticle,
  chaptersCoverParts,
  compilePrompt,
  fallbackEpisodeChapters,
  longVideoCallBudget,
  longVideoPartBounds,
  mergeParallelArticle,
  normalizeEpisodeChapters,
  parallelSegmentConcurrency,
  parseEpisodeStructure,
  parseSegmentTranslation,
  resolvePodcastMergeRequest,
  segmentPointsOk,
  splitSummaryBlocks,
  structureMaterialBatches,
  structurePrompt,
} from '../../domain/src/gemma-long-video.js';

// 正文默认走现有 Gemma 26B 翻译池，只打官方 endpoint，不新接计费服务，也不在这里读写密钥。
// 新开的整理：按段并行 Gemma 26B 写 2～5 个事点。Flash Lite 一次把事点统编成一篇长文。
// 统编失败就降级到切章并把事点接上，不再润色第二轮。flash-polish 和 oneshot 不走这条路径。
// 已经 ready 的 parallel-segments 和 chapter-dialogue 不自动重写。
// 进行中的旧要点稿仍接着写小节。段上还不是事点的，丢掉旧正文，用一次事点重写。
// 豆包只在引擎显式写成 doubao 时使用。
// 标题和关键句的中文化仍只用 Gemma，不走 Flash。
// 正文整理完成后，再用 Gemma 按中文正文写一句话标题；失败就留着原来的标题。

const PART_ATTEMPTS = 3;
const UPSTREAM_EXTRA_TRIES = 2;
const UPSTREAM_WAIT_MIN_MS = 10_000;
const UPSTREAM_WAIT_MAX_MS = 40_000;
const UPSTREAM_HTTP = new Set([408, 500, 502, 503]);
const ASK_TIMEOUT_MS = 120_000;
const GEMMA_MODEL = GEMMA_26B;
const ARTICLE_FRESH_MS = 36 * 60 * 60 * 1000;

function shanghaiDay(now, timeZone) {
  return formatYmd(zonedParts(now, timeZone));
}

function readState(raw) {
  try {
    const parsed = JSON.parse(raw || '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function doubaoBlock(result) {
  if (!result) return '';
  if (result.status === 'login_required') return 'login';
  const note = `${result.note || ''} ${result.reason || ''}`;
  if (/no_tiptap/.test(note)) return 'page';
  return '';
}

function articleClient(deps) {
  if (deps.doubaoClient) return deps.doubaoClient;
  if (deps.browserRuntime) return createDoubaoChatClient({ browserRuntime: deps.browserRuntime });
  return null;
}

function articleGemma(deps, { lockModel = false } = {}) {
  if (deps.gemmaGenerate) return deps.gemmaGenerate;
  if (!deps.gemmaRouter) {
    deps.gemmaRouter = createGemmaTranslationRouter({
      env: deps.env || process.env,
      models: [GEMMA_26B, GEMMA_31B],
      schedule: LONG_VIDEO_GEMMA_SCHEDULE,
      quotaRepository: deps.quotaRepository,
      signal: deps.signal,
    });
  }
  return (input) => {
    const budget = longVideoCallBudget(input.system, input.prompt);
    return deps.gemmaRouter.generate({
      ...(lockModel ? { model: GEMMA_MODEL } : {}),
      system: input.system,
      prompt: input.prompt,
      estimatedTokens: budget.total,
      maxOutputTokens: budget.maxOutputTokens,
    });
  };
}

function articleFlash(deps) {
  if (deps.flashGenerate === null) return null;
  if (deps.flashGenerate) return deps.flashGenerate;
  if (!deps.flashClient) {
    deps.flashClient = createGeminiInvestorSummarizer({
      env: deps.env || process.env,
      quotaRepository: deps.quotaRepository,
      signal: deps.signal,
      usageStage: 'youtube-podcast-article',
      model: 'gemini-3.1-flash-lite',
      responseMimeType: 'text/plain',
    });
  }
  return deps.flashClient;
}

function callCounts(raw) {
  return {
    gemma: Math.max(0, Number(raw?.gemma) || 0),
    flash: Math.max(0, Number(raw?.flash) || 0),
  };
}

function addCalls(target, extra) {
  if (!target || !extra) return;
  target.gemma += Math.max(0, Number(extra.gemma) || 0);
  target.flash += Math.max(0, Number(extra.flash) || 0);
}

function attachCalls(error, calls) {
  if (error && typeof error === 'object') error.articleCalls = calls;
  return error;
}

function gemmaKeyInflight(env) {
  const raw = String(env?.AI_CENTER_GEMMA_TRANSLATION_KEY_CONCURRENCY ?? '').trim();
  if (!raw) return 2;
  const value = Number(raw);
  if (!Number.isInteger(value)) return 2;
  return Math.min(3, Math.max(2, value));
}

export function podcastSegmentConcurrency(env = process.env) {
  const source = env || process.env;
  const raw = String(source.AI_CENTER_PODCAST_SEGMENT_CONCURRENCY ?? '').trim();
  const cap = raw ? Number(raw) : 8;
  let keyCount = 0;
  try {
    keyCount = resolveGemmaTranslationSlots(source).length;
  } catch {
    keyCount = 0;
  }
  return parallelSegmentConcurrency({ keyCount, perKey: gemmaKeyInflight(source), cap });
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Math.max(1, Math.min(concurrency || 1, items.length || 1));
  if (!items.length) return results;
  await Promise.all(Array.from({ length: workers }, () => runner()));
  return results;
}

async function callArticleModel(deps, input, options = {}) {
  const calls = callCounts();
  try {
    calls.gemma += 1;
    const result = await articleGemma(deps, { lockModel: options.lockModel === true })(input);
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('Gemma 没有返回正文');
    return { text, provider: 'gemma', calls };
  } catch (error) {
    if (error?.code === 'budget-deferred' || deps.signal?.aborted) throw attachCalls(error, calls);
    const flash = articleFlash(deps);
    if (!flash) throw attachCalls(error, calls);
    try {
      calls.flash += 1;
      const result = await flash(input);
      const text = String(result?.text || '').trim();
      if (!text) throw error;
      return { text, provider: 'flash', calls };
    } catch (flashError) {
      throw attachCalls(flashError?.code === 'budget-deferred' ? flashError : error, calls);
    }
  }
}

export function articlePauseReason(error) {
  if (!error || typeof error !== 'object') return '';
  const status = Number(error.upstreamStatus);
  const upstreamHttp = UPSTREAM_HTTP.has(status) || error.code === 'gemma-stream-error';
  if (error.code === 'budget-deferred') {
    if (error.upstream === true || upstreamHttp || /上游/.test(String(error.message || ''))) return 'upstream';
    return 'quota';
  }
  if (upstreamHttp) return 'upstream';
  return '';
}

function upstreamWaitMs(error, now = Date.now()) {
  const retryAt = Number(error?.retryAt);
  const remaining = Number.isFinite(retryAt) ? retryAt - now : UPSTREAM_WAIT_MIN_MS;
  return Math.min(UPSTREAM_WAIT_MAX_MS, Math.max(UPSTREAM_WAIT_MIN_MS, remaining));
}

async function waitQuiet(deps, ms) {
  if (typeof deps?.sleep === 'function') {
    await deps.sleep(ms);
    return;
  }
  if (ms > 0) await delay(ms, undefined, { signal: deps?.signal }).catch(() => {});
}

async function withUpstreamRetry(deps, run) {
  let extra = 0;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (articlePauseReason(error) !== 'upstream' || extra >= UPSTREAM_EXTRA_TRIES || deps?.signal?.aborted) throw error;
      extra += 1;
      await waitQuiet(deps, upstreamWaitMs(error));
      if (deps?.signal?.aborted) throw error;
    }
  }
}

function loadGemmaPart(part) {
  const text = String(part?.text || '');
  let translation = String(part?.translation || '');
  let section = String(part?.section || '');
  let provider = part?.provider === 'source' || part?.provider === 'gemma' || part?.provider === 'flash' ? part.provider : '';
  let status = part?.status === 'done' || part?.status === 'translated' ? part.status : 'pending';
  let attempts = Number(part?.attempts) || 0;
  let dropped = false;
  if (captionAlreadyChinese(text) && translation && !captionAlreadyChinese(translation)) {
    translation = '';
    section = '';
    provider = '';
    status = 'pending';
    attempts = 0;
    dropped = true;
  }
  if (timestampOnlyHeading(section)) {
    section = '';
    status = translation ? 'translated' : status;
    attempts = 0;
    dropped = true;
  }
  if (translation && status === 'pending') status = 'translated';
  return {
    text,
    start: String(part?.start || ''),
    status,
    translation,
    section,
    attempts,
    provider,
    calls: callCounts(part?.calls),
    hint: Array.isArray(part?.hint) ? part.hint.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5) : [],
    topic: String(part?.topic || '').trim().slice(0, 40),
    points: Array.isArray(part?.points) ? part.points.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5) : [],
    segmentKind: part?.segmentKind === POINTS_SEGMENT_KIND ? POINTS_SEGMENT_KIND : '',
    dropped,
  };
}

function pointSegmentReady(part) {
  return part?.segmentKind === POINTS_SEGMENT_KIND && segmentPointsOk(part?.points) && part.translation;
}

// 旧的译文或提炼正文不能当成事点。清掉后这一段只再打一次，不先译再改。
function reusePointPart(part) {
  if (pointSegmentReady(part)) return part;
  if (!part?.translation && !part?.points?.length) return part;
  return {
    ...part,
    translation: '',
    section: '',
    hint: [],
    topic: '',
    points: [],
    status: 'pending',
    attempts: 0,
    provider: '',
    segmentKind: '',
    dropped: true,
  };
}

function replaceContent(feedRepository, workspaceId, contentItemId, patch) {
  const item = feedRepository.getContentItem(workspaceId, contentItemId);
  if (!item?.captureId) return null;
  return feedRepository.saveContentItem({
    workspaceId,
    captureId: item.captureId,
    originType: item.originType,
    contentType: item.contentType,
    title: patch.title || item.title,
    body: patch.body == null ? item.body : patch.body,
    summary: patch.summary == null ? item.summary : patch.summary,
    sourceUrl: item.sourceUrl,
    authorName: item.authorName,
    publishedAt: item.publishedAt,
  });
}

function articleTitleGenerator(deps) {
  if (deps.gemmaGenerate === null) return null;
  if (typeof deps.gemmaGenerate === 'function') return deps.gemmaGenerate;
  if (!deps.quotaRepository) return null;
  return articleGemma(deps, { lockModel: true });
}

async function applyArticleTitle(deps, { row, feedRepository, workspaceId, article, state }) {
  const generate = articleTitleGenerator(deps);
  if (!generate) return { status: 'skipped' };
  const source = articleTitleSource(article);
  const calls = callCounts();
  if (!source) {
    state.titleStatus = 'failed';
    state.articleTitle = '';
    state.titleCalls = calls;
    return { status: 'failed' };
  }
  try {
    const result = await withUpstreamRetry(deps, async () => {
      calls.gemma += 1;
      return generate({ system: GEMMA_ARTICLE_TITLE_SYSTEM, prompt: `文章：\n${source}` });
    });
    const title = normalizeArticleTitle(result?.text);
    state.titleCalls = calls;
    if (!title) {
      state.titleStatus = 'failed';
      state.articleTitle = '';
      return { status: 'failed' };
    }
    if (deps.keepFeedBody) {
      row.articleBody = article;
      row.articleTitle = title;
    } else {
      replaceContent(feedRepository, workspaceId, row.contentItemId, { title, body: article });
    }
    state.titleStatus = 'ready';
    state.articleTitle = title;
    return { status: 'ready', title };
  } catch (error) {
    state.titleCalls = calls;
    if (deps.signal?.aborted) {
      state.titleStatus = 'pending';
      state.articleTitle = '';
      return { status: 'pending', reason: 'deadline', stopPass: true };
    }
    const kind = articlePauseReason(error);
    if (kind) {
      state.titleStatus = 'pending';
      state.articleTitle = '';
      return { status: 'pending', reason: kind, stopPass: true };
    }
    state.titleStatus = 'failed';
    state.articleTitle = '';
    console.warn(`[worker] youtube-podcasts 文章标题未写成：${String(error?.message || error).slice(0, 160)}`);
    return { status: 'failed' };
  }
}

async function finishArticle(deps, { row, repository, feedRepository, workspaceId, article, state, persist }) {
  state.touchedAt = Date.now();
  persist('pending');
  const titled = await applyArticleTitle(deps, { row, feedRepository, workspaceId, article, state });
  if (titled.status !== 'ready') {
    if (deps.keepFeedBody) row.articleBody = article;
    else replaceContent(feedRepository, workspaceId, row.contentItemId, { body: article });
  }
  state.holdDay = '';
  state.holdReason = '';
  persist('ready');
  if (titled.stopPass) return { status: 'ready', stopPass: true, reason: titled.reason || 'quota' };
  return { status: 'ready' };
}

async function titlePendingArticle({ row, repository, feedRepository, workspaceId, deps }) {
  const state = readState(row.articleState) || {};
  if (state.titleStatus !== 'pending') return { status: 'skipped' };
  const item = row.contentItemId && !deps.keepFeedBody ? feedRepository.getContentItem(workspaceId, row.contentItemId) : null;
  const article = String(deps.keepFeedBody ? (row.articleBody || '') : (item?.body || row.body || '')).trim();
  const titled = await applyArticleTitle(deps, { row, feedRepository, workspaceId, article, state });
  repository.saveEpisode(episodePatch(row, workspaceId, {
    articleStatus: row.articleStatus || 'ready',
    articleState: JSON.stringify(state),
  }));
  return titled;
}

function episodePatch(row, workspaceId, patch) {
  const next = {
    workspaceId,
    videoId: row.videoId,
    creatorId: row.creatorId,
    channelKey: row.channelKey,
    title: row.title,
    durationSec: row.durationSec,
    publishedAt: row.publishedAt,
    status: row.status || 'ready',
    reason: row.reason || '',
    transcriptSource: row.transcriptSource || '',
    contentItemId: row.contentItemId || '',
    attempts: row.attempts || 0,
    sourceHash: row.sourceHash || '',
    articleStatus: row.articleStatus || '',
    articleState: row.articleState || '',
    articleDay: row.articleDay || '',
    ...patch,
  };
  if (Object.prototype.hasOwnProperty.call(row, 'sourceTranscript')) next.sourceTranscript = row.sourceTranscript || '';
  if (row.articleBody) next.articleBody = row.articleBody;
  if (row.articleTitle) next.articleTitle = row.articleTitle;
  return next;
}

async function localizeQuoteLines(summary, translate) {
  const lines = String(summary || '').split('\n');
  let inQuotes = false;
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '关键句：') {
      inQuotes = true;
      continue;
    }
    if (!inQuotes || !lines[index].startsWith('- ')) continue;
    const time = lines[index].match(/^- (\d{2}:\d{2}:\d{2}) /);
    const body = lines[index].replace(/^- (?:\d{2}:\d{2}:\d{2} )?/, '');
    if (!needsEnglishQuote(body)) continue;
    if (!translate) throw new Error('关键句不是中文，且没有翻译');
    const translated = String(await translate(body) || '').trim();
    if (!translated || needsEnglishQuote(translated)) continue;
    lines[index] = `- ${time ? `${time[1]} ` : ''}${translated}`;
    changed = true;
  }
  return { text: lines.join('\n'), changed };
}

export async function localizePodcastCopy({ summary, formatted, episodeTitle, translate }) {
  let next = { ...(summary || {}) };
  let text = String(formatted || '');
  if (needsChineseTitle(next.titleZh || episodeTitle)) {
    if (!translate) throw new Error('标题不是中文，且没有翻译');
    const translated = String(await translate(next.titleZh || episodeTitle) || '').trim();
    if (translated && !needsChineseTitle(translated)) next = { ...next, titleZh: translated };
  }
  const quotes = await localizeQuoteLines(text, translate);
  text = quotes.text;
  const displayTitle = needsChineseTitle(next.titleZh || '') ? (episodeTitle || next.titleZh || '') : (next.titleZh || episodeTitle || '');
  return { summary: next, formatted: text, displayTitle };
}

export async function repairYoutubeChineseCopy(deps = {}) {
  const env = deps.env || process.env;
  const translate = deps.translate;
  const repository = deps.repository;
  const feedRepository = deps.feedRepository;
  if (!translate || !repository || !feedRepository) return { repaired: 0 };
  const workspaceId = deps.workspaceId || 'local';
  const limit = deps.limit || youtubeTitleRepairLimit(env);
  let repaired = 0;
  for (const row of repository.listReady(workspaceId, 200)) {
    if (repaired >= limit) break;
    const titleNeeds = needsChineseTitle(row.displayTitle || row.title);
    const quoteNeeds = String(row.summary || '').split('\n').some((line) => line.startsWith('- ') && needsEnglishQuote(line.replace(/^- (?:\d{2}:\d{2}:\d{2} )?/, '')));
    if (!titleNeeds && !quoteNeeds) continue;
    try {
      const localized = await localizePodcastCopy({
        summary: { titleZh: row.displayTitle || row.title },
        formatted: row.summary || '',
        episodeTitle: row.title,
        translate,
      });
      const title = titleNeeds ? localized.displayTitle : (row.displayTitle || row.title);
      const summary = quoteNeeds ? localized.formatted : row.summary;
      if (title === (row.displayTitle || row.title) && summary === row.summary) continue;
      replaceContent(feedRepository, workspaceId, row.contentItemId, { title, summary, body: undefined });
      repaired += 1;
    } catch (error) {
      console.warn(`[worker] youtube-podcasts 标题或关键句未译成中文：${String(error?.message || error).slice(0, 160)}`);
    }
  }
  return { repaired };
}

async function askPart(client, slot, state, prompt) {
  if (slot.status === 'sent' && state.chatUrl) {
    return client.readReply({
      pageUrl: state.chatUrl,
      beforeReplyCount: slot.beforeReplyCount || 0,
      reloadOnce: true,
      maxTimeoutMs: ASK_TIMEOUT_MS,
    });
  }
  return client.ask(prompt, {
    ...(state.chatUrl ? { pageUrl: state.chatUrl } : {}),
    reloadOnce: true,
    maxTimeoutMs: ASK_TIMEOUT_MS,
  });
}

function rememberChat(state, result) {
  const url = continuedDoubaoChatUrl(result?.page_url);
  if (url) state.chatUrl = url;
}

async function organizeEpisode({ row, client, repository, feedRepository, workspaceId, day, signal, deps = {} }) {
  const item = row.contentItemId ? feedRepository.getContentItem(workspaceId, row.contentItemId) : null;
  const source = row.sourceTranscript || item?.body || '';
  if (!source.trim()) return { status: 'skipped', reason: 'empty' };
  const hash = transcriptHash(source);
  if (row.articleStatus === 'ready' && row.sourceHash === hash) return { status: 'skipped', reason: 'ready' };
  const deduped = dedupeRollingCaptions(source);
  const saved = readState(row.articleState);
  const reusable = saved?.hash === hash && Array.isArray(saved.parts) && saved.parts.length;
  const parts = reusable
    ? saved.parts.map((part) => ({
      text: String(part.text || ''),
      start: String(part.start || ''),
      status: part.status === 'done' || part.status === 'sent' ? part.status : 'pending',
      attempts: Number(part.attempts) || 0,
      beforeReplyCount: Number(part.beforeReplyCount) || 0,
      reply: String(part.reply || ''),
      recovered: Boolean(part.recovered),
    }))
    : splitTranscriptParts(deduped).map((part) => ({
      text: part.text,
      start: part.start || '',
      status: 'pending',
      attempts: 0,
      beforeReplyCount: 0,
      reply: '',
      recovered: false,
    }));
  const state = {
    hash,
    chatUrl: reusable ? continuedDoubaoChatUrl(saved.chatUrl) : '',
    holdDay: reusable ? String(saved.holdDay || '') : '',
    holdReason: reusable ? String(saved.holdReason || '') : '',
    parts,
  };
  if (state.holdDay === day) return { status: 'pending', reason: state.holdReason || 'hold' };
  const persist = (articleStatus = 'pending') => {
    row.articleStatus = articleStatus;
    row.articleState = JSON.stringify(state);
    row.sourceTranscript = source;
    row.sourceHash = hash;
    row.articleDay = day;
    repository.saveEpisode(episodePatch(row, workspaceId, {
      sourceTranscript: source,
      sourceHash: hash,
      articleStatus,
      articleState: row.articleState,
      articleDay: day,
    }));
  };
  replaceContent(feedRepository, workspaceId, row.contentItemId, { body: deduped });
  persist('pending');
  for (let index = 0; index < state.parts.length; index += 1) {
    const slot = state.parts[index];
    if (slot.status === 'done' && slot.reply) continue;
    let spins = 0;
    while (slot.status !== 'done' && spins < 8) {
      spins += 1;
      if (signal?.aborted) {
        state.holdReason = 'deadline';
        persist('pending');
        return { status: 'pending', reason: 'deadline', stopPass: true };
      }
      const prompt = articlePartPrompt({
        index,
        total: state.parts.length,
        text: dedupeRollingCaptions(slot.text) || slot.text,
        previousTail: index > 0 ? state.parts[index - 1].reply : '',
        fresh: index > 0 && !state.chatUrl,
      });
      const result = await askPart(client, slot, state, prompt);
      const block = doubaoBlock(result);
      if (block) {
        state.holdDay = day;
        state.holdReason = block;
        persist('pending');
        return { status: 'pending', stopDay: true, reason: block };
      }
      const reply = result?.status === 'ok' ? stripDoubaoReply(result.reply_text) : '';
      if (reply) {
        slot.status = 'done';
        slot.reply = reply;
        slot.recovered = false;
        rememberChat(state, result);
        persist('pending');
        break;
      }
      if (result?.status === 'reply_not_observed' || result?.send_confirmed) {
        slot.status = 'sent';
        slot.beforeReplyCount = Number(result.reply_count_before) || slot.beforeReplyCount || 0;
        rememberChat(state, result);
      } else {
        slot.status = 'pending';
      }
      slot.attempts += 1;
      if (slot.attempts >= PART_ATTEMPTS) {
        if (slot.recovered) {
          state.holdDay = day;
          state.holdReason = 'failed';
          persist('pending');
          return { status: 'pending', reason: 'failed' };
        }
        slot.recovered = true;
        slot.attempts = 0;
        slot.status = 'pending';
        state.chatUrl = '';
      }
      persist('pending');
    }
    if (slot.status !== 'done') {
      state.holdDay = day;
      state.holdReason = 'failed';
      persist('pending');
      return { status: 'pending', reason: 'failed' };
    }
  }
  const article = joinArticleParts(state.parts.map((part) => part.reply));
  if (!article) {
    state.holdDay = day;
    state.holdReason = 'failed';
    persist('pending');
    return { status: 'pending', reason: 'failed' };
  }
  return finishArticle(
    { ...deps, signal },
    { row, repository, feedRepository, workspaceId, article, state, persist },
  );
}

async function organizeParallelSegments({ state, deps, signal, day, row, repairing, persist, touch, pause, halted, stop }) {
  const status = repairing ? 'ready' : 'pending';
  for (const slot of state.parts) {
    if (pointSegmentReady(slot)) continue;
    if (slot.translation || slot.points?.length) {
      slot.translation = '';
      slot.points = [];
    }
    if (slot.attempts >= PART_ATTEMPTS) {
      state.holdDay = day;
      state.holdReason = 'failed';
      persist(status);
      return { status: 'pending', reason: 'failed' };
    }
  }
  const concurrency = podcastSegmentConcurrency(deps.env || process.env);
  const translateSlot = async (slot) => {
    if (pointSegmentReady(slot) || signal?.aborted) return;
    const stopped = halted();
    if (stopped) return;
    try {
      touch();
      const sourceText = dedupeRollingCaptions(slot.text) || slot.text;
      const prompt = JSON.stringify({
        i: state.parts.indexOf(slot),
        start: slot.start || '',
        text: sourceText,
      });
      const result = await withUpstreamRetry(deps, () => callArticleModel(
        deps,
        { system: GEMMA_SEGMENT_SYSTEM, prompt },
        { lockModel: true },
      ));
      const parsed = parseSegmentTranslation(result.text);
      const points = parsed.points.map((item) => stripResidualEnglish(item)).filter(Boolean);
      if (!segmentPointsOk(points)) throw new Error('分段事点不完整');
      slot.points = points;
      slot.translation = points.join('\n');
      slot.hint = points;
      slot.topic = parsed.topic;
      slot.segmentKind = POINTS_SEGMENT_KIND;
      slot.provider = result.provider;
      addCalls(slot.calls, result.calls);
      slot.status = 'translated';
      slot.attempts = 0;
      slot._error = null;
      persist(status);
    } catch (error) {
      addCalls(slot.calls, error?.articleCalls);
      if (error && typeof error === 'object') error.articleCalls = null;
      slot._error = error;
    }
  };
  const pending = () => state.parts.filter((slot) => !pointSegmentReady(slot));
  await mapPool(pending(), concurrency, translateSlot);
  if (signal?.aborted) return pause('deadline');
  const succeeded = state.parts.some((slot) => slot.translation);
  const retry = pending().filter((slot) => articlePauseReason(slot._error) !== 'quota');
  if (succeeded && retry.length) await mapPool(retry, concurrency, translateSlot);
  if (signal?.aborted) return pause('deadline');
  const still = pending();
  if (still.length) {
    const quota = still.find((slot) => articlePauseReason(slot._error) === 'quota');
    const upstream = still.find((slot) => articlePauseReason(slot._error) === 'upstream');
    if (quota || upstream) return stop(quota || upstream, (quota || upstream)._error);
    return stop(still[0], still[0]._error);
  }
  if (state.mergeStrategy === MERGE_POINT_COMPILE) {
    return compilePointsOrFallback({
      state, deps, signal, day, row, status, persist, touch, pause, halted, stop,
    });
  }
  if (chaptersCoverParts(state.chapters, state.parts.length)) return null;
  if (state.summaryAttempts >= PART_ATTEMPTS) {
    state.holdDay = day;
    state.holdReason = 'failed';
    persist(status);
    return { status: 'pending', reason: 'failed' };
  }
  const summaryStopped = halted();
  if (summaryStopped) return summaryStopped;
  try {
    touch();
    const result = await withUpstreamRetry(deps, () => callEpisodeStructure(deps, state.parts, row?.title || '', {}));
    if (signal?.aborted) return pause('deadline');
    state.chapters = result.chapters;
    state.summaryProvider = result.provider;
    addCalls(state.summaryCalls, result.calls);
    state.summaryAttempts = 0;
    persist(status);
    return null;
  } catch (error) {
    return stop(null, error);
  }
}

async function compilePointsOrFallback({ state, deps, signal, day, row, status, persist, touch, pause, halted, stop }) {
  if (state.compiledArticle) return null;
  if (state.mergeFallback === MERGE_CHAPTER_CONCAT && chaptersCoverParts(state.chapters, state.parts.length)) return null;
  if (state.summaryAttempts >= PART_ATTEMPTS) {
    state.holdDay = day;
    state.holdReason = 'failed';
    persist(status);
    return { status: 'pending', reason: 'failed' };
  }
  const summaryStopped = halted();
  if (summaryStopped) return summaryStopped;
  const flash = articleFlash(deps);
  if (flash) {
    const calls = callCounts();
    try {
      touch();
      calls.flash += 1;
      const result = await withUpstreamRetry(deps, () => flash({
        system: EPISODE_COMPILE_SYSTEM,
        prompt: compilePrompt(state.parts, row?.title || ''),
      }));
      if (signal?.aborted) return pause('deadline');
      const article = acceptCompiledArticle(result?.text);
      if (!article) throw new Error('统编正文不完整');
      state.compiledArticle = article;
      state.mergeFallback = '';
      state.summaryProvider = 'flash';
      addCalls(state.summaryCalls, calls);
      state.summaryAttempts = 0;
      persist(status);
      return null;
    } catch (error) {
      addCalls(state.summaryCalls, calls);
      if (signal?.aborted || deps.signal?.aborted) return pause('deadline');
    }
  }
  try {
    touch();
    const result = await withUpstreamRetry(deps, () => callEpisodeStructure(
      deps,
      state.parts,
      row?.title || '',
      { skipFlash: true },
    ));
    if (signal?.aborted) return pause('deadline');
    state.chapters = result.chapters;
    state.compiledArticle = '';
    state.mergeFallback = MERGE_CHAPTER_CONCAT;
    state.summaryProvider = result.provider;
    addCalls(state.summaryCalls, result.calls);
    state.summaryAttempts = 0;
    persist(status);
    return null;
  } catch (error) {
    return stop(null, error);
  }
}

async function callEpisodeStructure(deps, parts, title, options = {}) {
  const calls = callCounts();
  const flash = options.skipFlash ? null : articleFlash(deps);
  const readBatches = async (generate, batches, provider) => {
    const chapters = [];
    let titleZh = '';
    for (const batch of batches) {
      calls[provider] += 1;
      const result = await generate({ system: EPISODE_STRUCTURE_SYSTEM, prompt: structurePrompt(batch, title) });
      const parsed = parseEpisodeStructure(result?.text);
      if (!parsed?.chapters?.length) throw new Error('章节划分不是完整 JSON');
      if (parsed.titleZh) titleZh = parsed.titleZh;
      chapters.push(...parsed.chapters);
    }
    return { titleZh, chapters };
  };
  let parsed = null;
  let provider = '';
  if (flash) {
    try {
      parsed = await readBatches(flash, structureMaterialBatches(parts, { title }), 'flash');
      provider = 'flash';
    } catch (error) {
      if (deps.signal?.aborted) throw attachCalls(error, calls);
      parsed = null;
    }
  }
  if (!parsed) {
    try {
      const generate = articleGemma(deps, { lockModel: true });
      parsed = await readBatches(
        generate,
        structureMaterialBatches(parts, { system: EPISODE_STRUCTURE_SYSTEM, title }),
        'gemma',
      );
      provider = 'gemma';
    } catch (error) {
      if (error?.code === 'budget-deferred' || deps.signal?.aborted) throw attachCalls(error, calls);
      parsed = null;
    }
  }
  const chapters = parsed
    ? normalizeEpisodeChapters(parsed.chapters, parts.length)
    : fallbackEpisodeChapters(parts);
  if (!chapters.length) throw attachCalls(new Error('章节划分为空'), calls);
  return { chapters, provider: provider || 'fallback', calls, titleZh: parsed?.titleZh || '' };
}

async function organizeWithGemma({ row, repository, feedRepository, workspaceId, day, signal, deps }) {
  const item = row.contentItemId ? feedRepository.getContentItem(workspaceId, row.contentItemId) : null;
  const source = row.sourceTranscript || item?.body || '';
  if (!source.trim()) return { status: 'skipped', reason: 'empty' };
  const hash = transcriptHash(source);
  const saved = readState(row.articleState);
  const reusable = saved?.engine === 'gemma' && saved.hash === hash && Array.isArray(saved.parts) && saved.parts.length;
  const savedLayout = String(saved?.layout || '');
  // 已经 ready 的并行稿和章节对话稿不自动换成新正文。缺段修复只留给还在写的旧要点稿。
  const frozenLayout = savedLayout === PARALLEL_SEGMENT_LAYOUT || savedLayout === CHAPTER_DIALOGUE_LAYOUT;
  if (row.articleStatus === 'ready' && reusable && frozenLayout) return { status: 'skipped', reason: 'ready' };
  if (row.articleStatus === 'ready' && reusable && !gemmaArticleNeedsRepair(saved)) return { status: 'skipped', reason: 'ready' };
  const repairing = row.articleStatus === 'ready' && reusable && gemmaArticleNeedsRepair(saved);
  // 进行中的旧要点稿接着写小节。新开的整理、显式重跑，以及还没写完的章节对话，都走并行分段。
  const useParallel = !reusable || savedLayout === PARALLEL_SEGMENT_LAYOUT || savedLayout === CHAPTER_DIALOGUE_LAYOUT;
  const mergeRequest = resolvePodcastMergeRequest(deps.env || process.env);
  const deduped = dedupeRollingCaptions(source);
  const bounds = longVideoPartBounds();
  const loaded = reusable ? saved.parts.map((part) => loadGemmaPart(part)) : null;
  const prepared = loaded?.map((part) => (useParallel ? reusePointPart(part) : part));
  const parts = prepared
    ? prepared.map(({ dropped, ...part }) => part)
    : splitTranscriptParts(deduped, bounds).map((part) => ({
      text: part.text,
      start: part.start || '',
      status: 'pending',
      translation: '',
      section: '',
      hint: [],
      topic: '',
      points: [],
      segmentKind: '',
      attempts: 0,
      provider: '',
      calls: callCounts(),
    }));
  const freshParallel = useParallel && (!reusable || savedLayout !== PARALLEL_SEGMENT_LAYOUT || prepared?.some((part) => part.dropped));
  const state = {
    engine: 'gemma',
    hash,
    layout: useParallel ? PARALLEL_SEGMENT_LAYOUT : '',
    holdDay: reusable ? String(saved.holdDay || '') : '',
    holdReason: reusable ? String(saved.holdReason || '') : '',
    summary: reusable && !repairing && !useParallel ? String(saved.summary || '') : '',
    chapters: freshParallel || !Array.isArray(saved?.chapters) ? [] : saved.chapters,
    compiledArticle: freshParallel ? '' : String(saved?.compiledArticle || ''),
    mergeStrategy: useParallel ? mergeRequest.plan.id : String(saved?.mergeStrategy || ''),
    mergeRequested: useParallel && mergeRequest.pending ? mergeRequest.requested : '',
    mergeFallback: freshParallel ? '' : String(saved?.mergeFallback || ''),
    chapterSummaries: [],
    summaryAttempts: reusable && !repairing && !freshParallel ? Number(saved.summaryAttempts) || 0 : 0,
    summaryProvider: reusable && !repairing && !freshParallel ? String(saved.summaryProvider || '') : '',
    summaryCalls: reusable && !repairing && !freshParallel ? callCounts(saved.summaryCalls) : callCounts(),
    touchedAt: reusable ? Number(saved.touchedAt) || 0 : 0,
    parts,
  };
  if (state.holdDay === day) return { status: 'pending', reason: state.holdReason || 'hold' };
  const visibleStatus = (articleStatus) => (repairing && articleStatus !== 'ready' ? 'ready' : articleStatus);
  const persist = (articleStatus = 'pending') => {
    const status = visibleStatus(articleStatus);
    row.articleStatus = status;
    row.articleState = JSON.stringify(state);
    row.sourceTranscript = source;
    row.sourceHash = hash;
    const articleDay = repairing ? (row.articleDay || '') : day;
    if (!repairing) row.articleDay = day;
    repository.saveEpisode(episodePatch(row, workspaceId, {
      sourceTranscript: source,
      sourceHash: hash,
      articleStatus: status,
      articleState: row.articleState,
      articleDay,
    }));
  };
  if (!repairing && !deps.keepFeedBody) replaceContent(feedRepository, workspaceId, row.contentItemId, { body: deduped });
  persist(repairing ? 'ready' : 'pending');
  const touch = () => {
    state.touchedAt = Date.now();
    persist(repairing ? 'ready' : 'pending');
  };
  const pause = (reason) => {
    state.holdReason = reason;
    if (reason === 'upstream') console.warn('[worker] youtube-podcasts 正文整理因模型 5xx 停下，下一轮继续');
    persist(repairing ? 'ready' : 'pending');
    return { status: 'pending', reason, stopPass: true };
  };
  const halted = () => {
    if (!signal?.aborted) return null;
    return pause('deadline');
  };
  const stop = (slot, error) => {
    if (slot) addCalls(slot.calls, error?.articleCalls);
    else addCalls(state.summaryCalls, error?.articleCalls);
    if (signal?.aborted) return pause('deadline');
    const kind = articlePauseReason(error);
    if (kind === 'quota' || kind === 'upstream') return pause(kind);
    if (slot) slot.attempts += 1;
    else state.summaryAttempts += 1;
    const attempts = slot ? slot.attempts : state.summaryAttempts;
    if (attempts >= PART_ATTEMPTS) {
      state.holdDay = day;
      state.holdReason = 'failed';
    }
    persist(repairing ? 'ready' : 'pending');
    return { status: 'pending', reason: attempts >= PART_ATTEMPTS ? 'failed' : 'retry' };
  };
  if (useParallel) {
    const parallelResult = await organizeParallelSegments({
      state,
      deps,
      signal,
      day,
      row,
      repairing,
      persist,
      touch,
      pause,
      halted,
      stop,
    });
    if (parallelResult) return parallelResult;
    const article = String(state.compiledArticle || '').trim()
      || mergeParallelArticle(state.parts, state.chapters);
    if (!article) {
      state.holdDay = day;
      state.holdReason = 'failed';
      persist(repairing ? 'ready' : 'pending');
      return { status: 'pending', reason: 'failed' };
    }
    return finishArticle(
      { ...deps, signal },
      { row, repository, feedRepository, workspaceId, article, state, persist },
    );
  }
  for (const slot of state.parts) {
    if (slot.translation) continue;
    if (slot.attempts >= PART_ATTEMPTS) {
      state.holdDay = day;
      state.holdReason = 'failed';
      persist('pending');
      return { status: 'pending', reason: 'failed' };
    }
    const translateStopped = halted();
    if (translateStopped) return translateStopped;
    if (captionAlreadyChinese(slot.text)) {
      slot.translation = slot.text;
      slot.provider = 'source';
      slot.status = 'translated';
      slot.attempts = 0;
      persist('pending');
      continue;
    }
    try {
      touch();
      const sourceText = dedupeRollingCaptions(slot.text) || slot.text;
      const result = await withUpstreamRetry(deps, () => callArticleModel(deps, { system: GEMMA_TRANSLATE_SYSTEM, prompt: sourceText }));
      slot.translation = stripResidualEnglish(result.text);
      slot.provider = result.provider;
      addCalls(slot.calls, result.calls);
      slot.status = 'translated';
      slot.attempts = 0;
      persist('pending');
    } catch (error) {
      return stop(slot, error);
    }
  }
  for (const slot of state.parts) {
    if (slot.section) continue;
    if (slot.attempts >= PART_ATTEMPTS) {
      state.holdDay = day;
      state.holdReason = 'failed';
      persist('pending');
      return { status: 'pending', reason: 'failed' };
    }
    const sectionStopped = halted();
    if (sectionStopped) return sectionStopped;
    try {
      touch();
      const result = await withUpstreamRetry(deps, () => callArticleModel(deps, { system: GEMMA_SECTION_SYSTEM, prompt: slot.translation }));
      slot.section = stripResidualEnglish(repairTimestampHeading(result.text, slot.start, slot.translation));
      if (!slot.provider) slot.provider = result.provider;
      addCalls(slot.calls, result.calls);
      slot.status = 'done';
      slot.attempts = 0;
      persist('pending');
    } catch (error) {
      return stop(slot, error);
    }
  }
  if (!state.summary) {
    if (state.summaryAttempts >= PART_ATTEMPTS) {
      state.holdDay = day;
      state.holdReason = 'failed';
      persist('pending');
      return { status: 'pending', reason: 'failed' };
    }
    const summaryStopped = halted();
    if (summaryStopped) return summaryStopped;
    try {
      const batches = splitSummaryBlocks(gemmaSummarySource(state.parts.map((part) => part.section)), bounds.maxChars);
      const pieces = [];
      for (const batch of batches) {
        touch();
        const result = await withUpstreamRetry(deps, () => callArticleModel(deps, { system: GEMMA_SUMMARY_SYSTEM, prompt: batch }));
        pieces.push(result.text);
        addCalls(state.summaryCalls, result.calls);
        state.summaryProvider = result.provider;
      }
      if (pieces.length > 1) {
        touch();
        const merged = await withUpstreamRetry(deps, () => callArticleModel(deps, { system: GEMMA_SUMMARY_SYSTEM, prompt: pieces.join('\n\n') }));
        state.summary = merged.text;
        addCalls(state.summaryCalls, merged.calls);
        state.summaryProvider = merged.provider;
      } else {
        state.summary = pieces[0] || '';
      }
      if (!state.summary) throw new Error('要点为空');
      state.summaryAttempts = 0;
      persist('pending');
    } catch (error) {
      return stop(null, error);
    }
  }
  const article = joinGemmaArticle(state.summary, state.parts.map((part) => part.section));
  if (!article) {
    state.holdDay = day;
    state.holdReason = 'failed';
    persist('pending');
    return { status: 'pending', reason: 'failed' };
  }
  return finishArticle(
    { ...deps, signal },
    { row, repository, feedRepository, workspaceId, article, state, persist },
  );
}

function articleQueueTier(row, day, now) {
  if (row.articleStatus === 'ready') return 3;
  if (row.articleDay === day) return 0;
  const ingested = Number(row.ingestedAt) || 0;
  if (ingested && now - ingested <= ARTICLE_FRESH_MS) return 1;
  return 2;
}

function sortArticleCandidates(rows, day, now) {
  return [...rows].sort((left, right) => {
    const tier = articleQueueTier(left, day, now) - articleQueueTier(right, day, now);
    if (tier) return tier;
    const published = (Number(right.publishedAt) || 0) - (Number(left.publishedAt) || 0);
    if (published) return published;
    const ingested = (Number(right.ingestedAt) || 0) - (Number(left.ingestedAt) || 0);
    if (ingested) return ingested;
    return String(right.videoId).localeCompare(String(left.videoId));
  });
}

function markArticleHold(repository, row, workspaceId, day, reason) {
  const state = readState(row.articleState) || {};
  state.holdDay = day;
  state.holdReason = reason;
  const articleState = JSON.stringify(state);
  repository.saveEpisode(episodePatch(row, workspaceId, {
    articleState,
    articleStatus: row.articleStatus || 'pending',
  }));
  row.articleState = articleState;
}

export async function runYoutubeArticlePass(deps = {}) {
  const env = deps.env || process.env;
  const stats = { ready: 0, pending: 0, skipped: 0, stopped: '', dailyLimit: 0 };
  if (!youtubeArticleEnabled(env)) return stats;
  const engine = youtubeArticleEngine(env);
  const client = engine === 'doubao' ? articleClient(deps) : null;
  if (engine === 'doubao' && !client) {
    console.warn('[worker] youtube-podcasts 正文整理指定了豆包，但没有豆包浏览器。这一轮不改走其他模型');
    stats.stopped = 'no-client';
    return stats;
  }
  const repository = deps.repository;
  const feedRepository = deps.feedRepository;
  const workspaceId = deps.workspaceId || 'local';
  const now = Number(deps.now) || Date.now();
  const day = shanghaiDay(now, deps.timeZone || youtubePodcastClock(env).timeZone);
  const limit = deps.dailyLimit || youtubeArticleDailyLimit(env);
  const xVideoUsed = Math.max(0, Number(deps.xVideoRepository?.countArticleDay?.(workspaceId, day)) || 0);
  let slots = Math.max(0, limit - repository.countArticleDay(workspaceId, day) - xVideoUsed);
  const candidates = sortArticleCandidates(repository.listArticleCandidates(workspaceId), day, now);
  for (const row of candidates) {
    if (deps.signal?.aborted) {
      stats.stopped = 'deadline';
      break;
    }
    const saved = readState(row.articleState);
    if (saved?.holdDay === day) {
      stats.pending += 1;
      if (saved.holdReason === 'daily-limit') stats.dailyLimit += 1;
      continue;
    }
    const frozenReady = row.articleStatus === 'ready'
      && (saved?.layout === CHAPTER_DIALOGUE_LAYOUT || saved?.layout === PARALLEL_SEGMENT_LAYOUT);
    if (frozenReady && saved?.titleStatus !== 'pending') {
      stats.skipped += 1;
      continue;
    }
    if (row.articleStatus === 'ready' && saved?.titleStatus === 'pending' && (frozenReady || !(engine === 'gemma' && gemmaArticleNeedsRepair(saved)))) {
      try {
        const titled = await titlePendingArticle({ row, repository, feedRepository, workspaceId, deps });
        if (titled.stopPass) {
          stats.stopped = titled.reason || 'quota';
          break;
        }
      } catch (error) {
        console.warn(`[worker] youtube-podcasts 文章标题未写成：${String(error?.message || error).slice(0, 160)}`);
      }
      stats.skipped += 1;
      continue;
    }
    if (frozenReady || (row.articleStatus === 'ready' && (engine !== 'gemma' || !gemmaArticleNeedsRepair(saved)))) {
      stats.skipped += 1;
      continue;
    }
    const repair = row.articleStatus === 'ready' && engine === 'gemma' && gemmaArticleNeedsRepair(saved);
    if (row.articleDay !== day && !repair) {
      if (slots <= 0) {
        markArticleHold(repository, row, workspaceId, day, 'daily-limit');
        stats.dailyLimit += 1;
        stats.pending += 1;
        continue;
      }
      slots -= 1;
      row.articleDay = day;
    }
    let result;
    try {
      result = engine === 'doubao'
        ? await organizeEpisode({
          row,
          client,
          repository,
          feedRepository,
          workspaceId,
          day,
          signal: deps.signal,
          deps,
        })
        : await organizeWithGemma({
          row,
          repository,
          feedRepository,
          workspaceId,
          day,
          signal: deps.signal,
          env,
          deps,
        });
    } catch (error) {
      stats.pending += 1;
      console.warn(`[worker] youtube-podcasts 正文整理失败：${String(error?.message || error).slice(0, 160)}`);
      continue;
    }
    if (result.status === 'ready') stats.ready += 1;
    else if (result.status === 'pending') stats.pending += 1;
    else stats.skipped += 1;
    if (result.stopDay || result.stopPass) {
      stats.stopped = result.reason || 'blocked';
      break;
    }
  }
  return stats;
}

export async function organizeGemmaTranscript(input) {
  return organizeWithGemma(input);
}

export function queueYoutubeChapterRerun({ repository, workspaceId = 'local', videoId = '', all = false, dryRun = false } = {}) {
  if (!repository) return { queued: [], missing: Boolean(videoId) };
  const wanted = String(videoId || '').trim();
  const rows = repository.listEpisodes(workspaceId).filter((row) => {
    if (row.status !== 'ready' || row.articleStatus !== 'ready') return false;
    if (wanted) return row.videoId === wanted;
    return all;
  });
  const queued = [];
  for (const row of rows) {
    if (!dryRun) {
      repository.saveEpisode(episodePatch(row, workspaceId, {
        articleStatus: 'pending',
        articleDay: '',
        articleState: JSON.stringify({
          engine: 'gemma',
          layout: PARALLEL_SEGMENT_LAYOUT,
          rerun: true,
          hash: '',
          parts: [],
        }),
      }));
    }
    queued.push(row.videoId);
  }
  return { queued, missing: Boolean(wanted) && queued.length === 0 };
}

export async function resumeArticleTitle(input) {
  return titlePendingArticle(input);
}

export async function backfillYoutubeArticleTitles(deps = {}) {
  const repository = deps.repository;
  const feedRepository = deps.feedRepository;
  if (!repository || !feedRepository) return { titled: 0, failed: 0, skipped: 0, stopped: '' };
  const workspaceId = deps.workspaceId || 'local';
  const limit = Math.max(1, Math.min(Number(deps.limit) || 500, 500));
  const rows = repository.listArticlesNeedingTitle(workspaceId, limit);
  const stats = { titled: 0, failed: 0, skipped: 0, stopped: '' };
  const generate = deps.dryRun ? null : articleTitleGenerator({ ...deps, quotaRepository: deps.quotaRepository || {}, gemmaGenerate: deps.gemmaGenerate });
  for (const row of rows) {
    if (deps.signal?.aborted) {
      stats.stopped = 'deadline';
      break;
    }
    const state = readState(row.articleState) || {};
    if (!deps.force && state.titleStatus === 'ready' && state.articleTitle) {
      stats.skipped += 1;
      continue;
    }
    const article = String(row.body || '').trim();
    if (deps.dryRun) {
      stats.titled += 1;
      deps.onItem?.({ videoId: row.videoId, title: row.displayTitle || row.title, originalTitle: row.title, dryRun: true });
      continue;
    }
    if (!generate) {
      stats.failed += 1;
      continue;
    }
    const titled = await applyArticleTitle(
      { ...deps, gemmaGenerate: generate, quotaRepository: deps.quotaRepository || {} },
      { row, feedRepository, workspaceId, article, state },
    );
    repository.saveEpisode(episodePatch(row, workspaceId, {
      articleStatus: 'ready',
      articleState: JSON.stringify(state),
    }));
    if (titled.stopPass) {
      stats.stopped = titled.reason || 'quota';
      break;
    }
    if (titled.status === 'ready') {
      stats.titled += 1;
      deps.onItem?.({ videoId: row.videoId, title: titled.title, originalTitle: row.title });
    } else {
      stats.failed += 1;
      deps.onItem?.({ videoId: row.videoId, title: row.displayTitle || row.title, originalTitle: row.title, failed: true });
    }
  }
  return stats;
}
