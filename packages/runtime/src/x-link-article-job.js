import { createTranslateService } from '../../connectors/src/translate/index.js';
import { fetchLinkedArticle } from '../../connectors/src/x/link-fetch.js';
import {
  hostArticleMeta,
  xLinkArticleDailyLimit,
  xLinkArticleDay,
  xLinkArticleEnabled,
} from '../../domain/src/x-link-articles.js';
import { linkLabelForUrl } from '../../domain/src/x-link-service.js';

function clip(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

export async function runXLinkArticle({
  repository,
  publishers,
  translate,
  fetchArticle = fetchLinkedArticle,
  env = process.env,
  workspaceId = 'local',
  tweetId = '',
  quotaRepository,
  signal,
  now = Date.now,
} = {}) {
  const id = String(tweetId || '').trim();
  if (!repository || !id) return { status: 'invalid' };
  if (!xLinkArticleEnabled(env)) return { status: 'disabled' };
  const row = repository.get(workspaceId, id);
  if (!row) return { status: 'missing' };
  if (row.status === 'ready' || row.status === 'paywall' || row.status === 'blocked' || row.status === 'incomplete') {
    return { status: row.status };
  }
  if (row.status === 'failed' && row.attempts >= 3) return { status: 'failed' };
  const allowedHosts = [...(publishers?.hosts?.keys?.() || [])];
  const fetched = await fetchArticle({
    url: row.sourceUrl,
    allowedHosts,
    publisherForHost: (host) => hostArticleMeta(host, publishers),
    signal,
  });
  const labeled = fetched.finalUrl ? linkLabelForUrl(fetched.finalUrl, publishers) : { publisher: '', linkLabel: '', finalUrl: '', meta: null };
  const base = {
    workspaceId,
    tweetId: id,
    finalUrl: labeled.finalUrl || fetched.finalUrl || '',
    publisher: labeled.publisher || row.publisher || '',
    linkLabel: labeled.linkLabel || '',
  };
  if (!fetched.ok) {
    const terminal = fetched.reason === 'paywall' || fetched.reason === 'blocked' || fetched.reason === 'incomplete'
      || fetched.reason === 'blocked_host' || fetched.reason === 'blocked_url';
    const status = fetched.reason === 'paywall' || fetched.reason === 'blocked' || fetched.reason === 'incomplete'
      ? fetched.reason
      : 'failed';
    repository.save({
      ...base,
      status: terminal || row.attempts + 1 >= 3 ? status : 'pending',
      reason: clip(fetched.reason),
      attempts: row.attempts + 1,
    });
    return { status };
  }
  const copied = repository.findReadyByFinalUrl(workspaceId, base.finalUrl);
  if (copied && copied.tweetId !== id) {
    repository.save({
      ...base,
      status: 'ready',
      reason: '',
      title: copied.title,
      bodyZh: copied.bodyZh,
      articleDay: copied.articleDay || xLinkArticleDay(now()),
    });
    return { status: 'ready', copied: true };
  }
  const today = xLinkArticleDay(now());
  if (repository.countReadyOnDay(workspaceId, today) >= xLinkArticleDailyLimit(env)) {
    repository.save({ ...base, status: 'limited', reason: 'daily-limit', articleDay: today });
    return { status: 'limited' };
  }
  const translator = translate || createTranslateService({ env, quotaRepository, signal });
  const source = [fetched.title, fetched.text].filter(Boolean).join('\n\n');
  try {
    const result = await translator.translate({
      text: source,
      id: `x-link:${id}`,
      workspaceId,
    });
    const translated = String(result?.translatedText || '').trim();
    if (!translated) throw new Error('没有译出正文');
    const first = translated.split('\n').map((line) => line.trim()).find(Boolean) || '';
    repository.save({
      ...base,
      status: 'ready',
      reason: '',
      title: first.length <= 80 ? first : (fetched.title || row.title || ''),
      bodyZh: translated,
      articleDay: today,
    });
    return { status: 'ready' };
  } catch (error) {
    const attempts = row.attempts + 1;
    repository.save({
      ...base,
      status: attempts >= 3 ? 'failed' : 'pending',
      reason: clip(error?.message || error),
      attempts,
    });
    if (attempts >= 3 || signal?.aborted) return { status: 'failed' };
    throw error;
  }
}

export function createXLinkArticleJobHandlers(options = {}) {
  return {
    'x.links.article': (input = {}, ctx = {}) => runXLinkArticle({
      ...options,
      env: options.env || process.env,
      workspaceId: input.workspaceId || options.workspaceId || 'local',
      tweetId: input.tweetId,
      signal: ctx.signal,
    }),
  };
}
