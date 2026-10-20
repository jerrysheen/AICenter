import { formatYmd, zonedParts } from '../../domain/src/zoned-time.js';
import {
  articlePartPrompt,
  continuedDoubaoChatUrl,
  dedupeRollingCaptions,
  captionAlreadyChinese,
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
import { translationChunkChars } from '../../connectors/src/translate/index.js';
import { createGemmaTranslationRouter } from '../../connectors/src/translate/gemma.js';

// 正文默认走现有 Gemma 26B 翻译池，只打官方 endpoint，不新接计费服务，也不在这里读写密钥。
// Gemma 失败时，缺的那一段可以改用现有 Gemini Flash。豆包只在引擎显式写成 doubao 时使用。
// 标题和关键句的中文化仍只用 Gemma，不走 Flash。
// 正文整理完成后，再用 Gemma 按中文正文写一句话标题；失败就留着原来的标题。

const PART_ATTEMPTS = 3;
const ASK_TIMEOUT_MS = 120_000;
const GEMMA_MODEL = 'gemma-4-26b-a4b-it';
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

function gemmaPartBounds(env) {
  const maxChars = translationChunkChars(env.AI_CENTER_TRANSLATION_CHUNK_CHARS);
  const minChars = Math.max(400, Math.floor(maxChars * 0.66));
  return { minChars, maxChars: Math.max(minChars, maxChars) };
}

function splitSummaryBlocks(source, maxChars) {
  const blocks = String(source || '').split(/\n\n/).map((item) => item.trim()).filter(Boolean);
  const batches = [];
  let current = '';
  for (const block of blocks) {
    const piece = block.length > maxChars ? block.slice(0, maxChars) : block;
    if (current && current.length + 2 + piece.length > maxChars) {
      batches.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) batches.push(current);
  return batches;
}

function articleGemma(deps) {
  if (deps.gemmaGenerate) return deps.gemmaGenerate;
  if (!deps.gemmaRouter) {
    deps.gemmaRouter = createGemmaTranslationRouter({
      env: deps.env || process.env,
      models: GEMMA_MODEL,
      quotaRepository: deps.quotaRepository,
      signal: deps.signal,
    });
  }
  return (input) => deps.gemmaRouter.generate({
    model: GEMMA_MODEL,
    system: input.system,
    prompt: input.prompt,
  });
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

async function callArticleModel(deps, input) {
  const calls = callCounts();
  try {
    calls.gemma += 1;
    const result = await articleGemma(deps)(input);
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
    dropped,
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
  return articleGemma(deps);
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
  calls.gemma = 1;
  try {
    const result = await generate({ system: GEMMA_ARTICLE_TITLE_SYSTEM, prompt: `文章：\n${source}` });
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
    if (error?.code === 'budget-deferred' || deps.signal?.aborted) {
      state.titleStatus = 'pending';
      state.articleTitle = '';
      return { status: 'pending', reason: 'quota', stopPass: true };
    }
    state.titleStatus = 'failed';
    state.articleTitle = '';
    console.warn(`[worker] youtube-podcasts 文章标题未写成：${String(error?.message || error).slice(0, 160)}`);
    return { status: 'failed' };
  }
}

async function finishArticle(deps, { row, repository, feedRepository, workspaceId, article, state, persist }) {
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
      if (signal?.aborted) return { status: 'pending', reason: 'deadline' };
      const prompt = articlePartPrompt({
        index,
        total: state.parts.length,
        text: slot.text,
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

async function organizeWithGemma({ row, repository, feedRepository, workspaceId, day, signal, env, deps }) {
  const item = row.contentItemId ? feedRepository.getContentItem(workspaceId, row.contentItemId) : null;
  const source = row.sourceTranscript || item?.body || '';
  if (!source.trim()) return { status: 'skipped', reason: 'empty' };
  const hash = transcriptHash(source);
  const saved = readState(row.articleState);
  const reusable = saved?.engine === 'gemma' && saved.hash === hash && Array.isArray(saved.parts) && saved.parts.length;
  if (row.articleStatus === 'ready' && reusable && !gemmaArticleNeedsRepair(saved)) return { status: 'skipped', reason: 'ready' };
  const repairing = row.articleStatus === 'ready' && reusable && gemmaArticleNeedsRepair(saved);
  const deduped = dedupeRollingCaptions(source);
  const bounds = gemmaPartBounds(env);
  const loaded = reusable ? saved.parts.map((part) => loadGemmaPart(part)) : null;
  const parts = loaded
    ? loaded.map(({ dropped, ...part }) => part)
    : splitTranscriptParts(deduped, bounds).map((part) => ({
      text: part.text,
      start: part.start || '',
      status: 'pending',
      translation: '',
      section: '',
      attempts: 0,
      provider: '',
      calls: callCounts(),
    }));
  const state = {
    engine: 'gemma',
    hash,
    holdDay: reusable ? String(saved.holdDay || '') : '',
    holdReason: reusable ? String(saved.holdReason || '') : '',
    summary: reusable && !repairing ? String(saved.summary || '') : '',
    summaryAttempts: reusable && !repairing ? Number(saved.summaryAttempts) || 0 : 0,
    summaryProvider: reusable && !repairing ? String(saved.summaryProvider || '') : '',
    summaryCalls: reusable && !repairing ? callCounts(saved.summaryCalls) : callCounts(),
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
  const stop = (slot, error) => {
    if (slot) addCalls(slot.calls, error?.articleCalls);
    else addCalls(state.summaryCalls, error?.articleCalls);
    if (error?.code === 'budget-deferred') {
      persist('pending');
      return { status: 'pending', reason: 'quota', stopPass: true };
    }
    if (slot) slot.attempts += 1;
    else state.summaryAttempts += 1;
    const attempts = slot ? slot.attempts : state.summaryAttempts;
    if (attempts >= PART_ATTEMPTS) {
      state.holdDay = day;
      state.holdReason = 'failed';
    }
    persist('pending');
    return { status: 'pending', reason: attempts >= PART_ATTEMPTS ? 'failed' : 'retry' };
  };
  for (const slot of state.parts) {
    if (slot.translation) continue;
    if (slot.attempts >= PART_ATTEMPTS) {
      state.holdDay = day;
      state.holdReason = 'failed';
      persist('pending');
      return { status: 'pending', reason: 'failed' };
    }
    if (signal?.aborted) return { status: 'pending', reason: 'deadline' };
    if (captionAlreadyChinese(slot.text)) {
      slot.translation = slot.text;
      slot.provider = 'source';
      slot.status = 'translated';
      slot.attempts = 0;
      persist('pending');
      continue;
    }
    try {
      const result = await callArticleModel(deps, { system: GEMMA_TRANSLATE_SYSTEM, prompt: slot.text });
      slot.translation = result.text;
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
    if (signal?.aborted) return { status: 'pending', reason: 'deadline' };
    try {
      const result = await callArticleModel(deps, { system: GEMMA_SECTION_SYSTEM, prompt: slot.translation });
      slot.section = repairTimestampHeading(result.text, slot.start, slot.translation);
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
    if (signal?.aborted) return { status: 'pending', reason: 'deadline' };
    try {
      const batches = splitSummaryBlocks(gemmaSummarySource(state.parts.map((part) => part.section)), bounds.maxChars);
      const pieces = [];
      for (const batch of batches) {
        const result = await callArticleModel(deps, { system: GEMMA_SUMMARY_SYSTEM, prompt: batch });
        pieces.push(result.text);
        addCalls(state.summaryCalls, result.calls);
        state.summaryProvider = result.provider;
      }
      if (pieces.length > 1) {
        const merged = await callArticleModel(deps, { system: GEMMA_SUMMARY_SYSTEM, prompt: pieces.join('\n\n') });
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
    if (row.articleStatus === 'ready' && saved?.titleStatus === 'pending' && !(engine === 'gemma' && gemmaArticleNeedsRepair(saved))) {
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
    if (row.articleStatus === 'ready' && (engine !== 'gemma' || !gemmaArticleNeedsRepair(saved))) {
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
