import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXStatusId } from './x-video-articles.js';
import {
  X_LINK_ARTICLE_JOB_TYPE,
  buildXLinkPublisherIndex,
  canonicalArticleUrl,
  chooseOutboundUrl,
  extractOutboundUrls,
  hostArticleMeta,
  matchMediaOutlet,
  readingLinkLabel,
  tweetAuthor,
  tweetOutboundText,
  xLinkArticleDailyLimit,
  xLinkArticleDay,
  xLinkArticleEnabled,
} from './x-link-articles.js';

const MEDIA_CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../config/media.json');

export function loadXLinkPublisherIndex(sources) {
  if (Array.isArray(sources)) return buildXLinkPublisherIndex(sources);
  const parsed = JSON.parse(readFileSync(MEDIA_CONFIG_PATH, 'utf8'));
  return buildXLinkPublisherIndex(Array.isArray(parsed?.sources) ? parsed.sources : []);
}

function view(row, { includeBody = false } = {}) {
  if (!row) return { eligible: false, status: 'missing' };
  const payload = {
    eligible: true,
    status: row.status || 'pending',
    tweetId: row.tweetId,
    finalUrl: row.finalUrl || '',
    linkLabel: row.linkLabel || '',
    publisher: row.publisher || '',
    title: row.title || '',
    reason: row.reason || '',
  };
  if (includeBody && row.status === 'ready') payload.body = row.bodyZh || '';
  return payload;
}

const TERMINAL = new Set(['ready', 'paywall', 'blocked', 'incomplete', 'failed']);

export function createXLinkService({
  repository,
  feedRepository,
  store,
  publishers,
  env = process.env,
  now = Date.now,
} = {}) {
  const index = publishers || loadXLinkPublisherIndex();

  function articleFor(workspaceId, tweetId) {
    const id = parseXStatusId(tweetId);
    if (!id || !repository) return null;
    return repository.get(workspaceId, id);
  }

  return {
    enabled() {
      return xLinkArticleEnabled(env);
    },

    status(workspaceId, tweetId) {
      const row = articleFor(workspaceId, tweetId);
      if (!row) return null;
      return view(row);
    },

    get(workspaceId, tweetId) {
      const row = articleFor(workspaceId, tweetId);
      if (!row || row.status !== 'ready') return null;
      return view(row, { includeBody: true });
    },

    enqueue(workspaceId, raw = {}) {
      if (!xLinkArticleEnabled(env)) return { eligible: false, status: 'disabled' };
      const tweetId = parseXStatusId(raw.tweetId || raw.url || raw);
      if (!tweetId) return { eligible: false, status: 'invalid' };
      const capture = feedRepository?.getCapture?.(workspaceId, 'x', tweetId) || null;
      const item = capture ? feedRepository?.getContentItemByCaptureId?.(workspaceId, capture.id) : null;
      const author = tweetAuthor(capture, item);
      const outlet = matchMediaOutlet(author, index);
      if (!outlet) return { eligible: false, status: 'ineligible' };
      const sourceUrl = chooseOutboundUrl(extractOutboundUrls(tweetOutboundText(capture, item)));
      if (!sourceUrl) return { eligible: false, status: 'ineligible' };
      const existing = repository.get(workspaceId, tweetId);
      const today = xLinkArticleDay(now());
      if (existing?.status === 'ready') return view(existing);
      if (existing && TERMINAL.has(existing.status) && existing.status !== 'failed') return view(existing);
      if (existing?.status === 'failed' && existing.attempts >= 3) return view(existing);
      if (existing?.status === 'limited' && existing.articleDay === today) return view(existing);
      repository.save({
        workspaceId,
        tweetId,
        contentItemId: item?.id || existing?.contentItemId || '',
        authorHandle: author.handle,
        authorName: author.name,
        sourceUrl,
        finalUrl: existing?.finalUrl || '',
        publisher: existing?.publisher || outlet.label,
        linkLabel: existing?.linkLabel || '',
        status: 'pending',
        reason: '',
        title: existing?.title || '',
        bodyZh: existing?.bodyZh || '',
        articleDay: existing?.articleDay || '',
        attempts: existing?.attempts || 0,
      });
      const open = (store?.listOpenJobs?.(X_LINK_ARTICLE_JOB_TYPE) || [])
        .find((job) => job.workspaceId === workspaceId && String(job.input?.tweetId || '') === tweetId);
      if (!open) {
        store?.createJob?.({
          type: X_LINK_ARTICLE_JOB_TYPE,
          workspaceId,
          input: { workspaceId, tweetId },
          maxAttempts: 2,
        });
      }
      return view(repository.get(workspaceId, tweetId));
    },

    publishers: index,
    dailyLimit: () => xLinkArticleDailyLimit(env),
  };
}

export function linkLabelForUrl(finalUrl, index) {
  let host = '';
  try { host = new URL(finalUrl).hostname; } catch { return { publisher: '', linkLabel: '', meta: null }; }
  const meta = hostArticleMeta(host, index);
  const publisher = meta?.label || '';
  return {
    publisher,
    linkLabel: publisher ? readingLinkLabel(publisher) : '',
    meta,
    finalUrl: canonicalArticleUrl(finalUrl),
  };
}
