import { formatYmd, zonedParts } from '../../domain/src/zoned-time.js';
import {
  articlePartPrompt,
  continuedDoubaoChatUrl,
  dedupeRollingCaptions,
  GEMMA_SECTION_SYSTEM,
  GEMMA_SUMMARY_SYSTEM,
  GEMMA_TRANSLATE_SYSTEM,
  gemmaSummarySource,
  joinArticleParts,
  joinGemmaArticle,
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
// 标题和关键句的中文化仍用调用方传入的 Gemma，不走 Flash。

const PART_ATTEMPTS = 3;
const ASK_TIMEOUT_MS = 120_000;
const GEMMA_MODEL = 'gemma-4-26b-a4b-it';

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

async function callArticleModel(deps, input) {
  try {
    const result = await articleGemma(deps)(input);
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('Gemma 没有返回正文');
    return text;
  } catch (error) {
    if (error?.code === 'budget-deferred' || deps.signal?.aborted) throw error;
    const flash = articleFlash(deps);
    if (!flash) throw error;
    try {
      const result = await flash(input);
      const text = String(result?.text || '').trim();
      if (!text) throw error;
      return text;
    } catch (flashError) {
      if (flashError?.code === 'budget-deferred') throw flashError;
      throw error;
    }
  }
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

function episodePatch(row, workspaceId, patch) {
  return {
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
    sourceTranscript: row.sourceTranscript || '',
    sourceHash: row.sourceHash || '',
    articleStatus: row.articleStatus || '',
    articleState: row.articleState || '',
    articleDay: row.articleDay || '',
    ...patch,
  };
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

async function organizeEpisode({ row, client, repository, feedRepository, workspaceId, day, signal }) {
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
  replaceContent(feedRepository, workspaceId, row.contentItemId, { body: article });
  state.holdDay = '';
  state.holdReason = '';
  persist('ready');
  return { status: 'ready' };
}

async function organizeWithGemma({ row, repository, feedRepository, workspaceId, day, signal, env, deps }) {
  const item = row.contentItemId ? feedRepository.getContentItem(workspaceId, row.contentItemId) : null;
  const source = row.sourceTranscript || item?.body || '';
  if (!source.trim()) return { status: 'skipped', reason: 'empty' };
  const hash = transcriptHash(source);
  if (row.articleStatus === 'ready' && row.sourceHash === hash) return { status: 'skipped', reason: 'ready' };
  const deduped = dedupeRollingCaptions(source);
  const bounds = gemmaPartBounds(env);
  const saved = readState(row.articleState);
  const reusable = saved?.engine === 'gemma' && saved.hash === hash && Array.isArray(saved.parts) && saved.parts.length;
  const parts = reusable
    ? saved.parts.map((part) => ({
      text: String(part.text || ''),
      start: String(part.start || ''),
      status: part.status === 'done' || part.status === 'translated' ? part.status : 'pending',
      translation: String(part.translation || ''),
      section: String(part.section || ''),
      attempts: Number(part.attempts) || 0,
    }))
    : splitTranscriptParts(deduped, bounds).map((part) => ({
      text: part.text,
      start: part.start || '',
      status: 'pending',
      translation: '',
      section: '',
      attempts: 0,
    }));
  const state = {
    engine: 'gemma',
    hash,
    holdDay: reusable ? String(saved.holdDay || '') : '',
    holdReason: reusable ? String(saved.holdReason || '') : '',
    summary: reusable ? String(saved.summary || '') : '',
    summaryAttempts: reusable ? Number(saved.summaryAttempts) || 0 : 0,
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
  const stop = (slot, error) => {
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
    try {
      slot.translation = await callArticleModel(deps, { system: GEMMA_TRANSLATE_SYSTEM, prompt: slot.text });
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
      slot.section = await callArticleModel(deps, { system: GEMMA_SECTION_SYSTEM, prompt: slot.translation });
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
        pieces.push(await callArticleModel(deps, { system: GEMMA_SUMMARY_SYSTEM, prompt: batch }));
      }
      state.summary = pieces.length === 1
        ? pieces[0]
        : await callArticleModel(deps, { system: GEMMA_SUMMARY_SYSTEM, prompt: pieces.join('\n\n') });
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
  replaceContent(feedRepository, workspaceId, row.contentItemId, { body: article });
  state.holdDay = '';
  state.holdReason = '';
  persist('ready');
  return { status: 'ready' };
}

export async function runYoutubeArticlePass(deps = {}) {
  const env = deps.env || process.env;
  const stats = { ready: 0, pending: 0, skipped: 0, stopped: '' };
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
  let slots = Math.max(0, limit - repository.countArticleDay(workspaceId, day));
  for (const row of repository.listArticleCandidates(workspaceId)) {
    if (deps.signal?.aborted) {
      stats.stopped = 'deadline';
      break;
    }
    const saved = readState(row.articleState);
    if (saved?.holdDay === day) {
      stats.pending += 1;
      continue;
    }
    if (row.articleDay !== day) {
      if (slots <= 0) continue;
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
