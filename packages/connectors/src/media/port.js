import { extractArticleText, EXTRACTOR_VERSION } from './article-html.js';
import { parseFeedXml } from './feed-xml.js';
import { fetchAllowlisted } from './http.js';
import { redactUrl } from './article-url.js';
import { stableArticleId } from './article-url.js';
import { isPublicHttpsUrl, hostAllowed } from './article-url.js';
import { readYahooList, readYahooArticle } from './yahoo-public.js';

export function createMediaConnector({ sources = [], discoveryPublishers = [], budget = {}, timeZone = 'Asia/Shanghai', focusKeywords = [], fetchImpl, lookupImpl, readExisting, readSource, browserRuntime } = {}) {
  const publishers = discoveryPublishers.map(p => ({ ...p, channel: 'tech', contentAccess: 'body', transport: 'discovery', deployment: 'existing' }));
  return Object.freeze({ sources, publishers, budget, timeZone, focusKeywords, extractorVersion: EXTRACTOR_VERSION, redactUrl,
    matchOriginal(row) {
      if (!isPublicHttpsUrl(row.originUrl)) return null;
      const url = new URL(row.originUrl);
      const publisher = publishers.find(p => hostAllowed(url.hostname, p.articleHosts) && p.pathPrefixes.some(path => url.pathname.startsWith(path)))
        || sources.find(p => p.contentAccess === 'body' && hostAllowed(url.hostname, p.articleHosts));
      if (!publisher) return null;
      return { publisher, item: { externalId: stableArticleId(publisher.sourceKey, {link: row.originUrl}), sourceUrl: row.originUrl,
        title: row.title, summary: '', publishedAt: row.publishedAt, publishedAtRaw: row.publishedAtRaw,
        discoveredVia: {sourceKey: row.sourceKey, url: row.canonicalUrl} } };
    },
    readExisting: readExisting || (readSource ? async entry => {
      if (!entry.sourceId) return { ok: false, health: 'existing_adapter', items: [], note: '未配置已有来源能力' };
      const snapshot = await readSource(entry.sourceId,{ limit: 20 });
      const view = snapshot.data;
      return { ok: Boolean(view?.available), health: view?.available ? 'ready' : 'unavailable', note: view?.note || '',
        items: (view?.items || view?.releases || []).filter(r=>!r.externalId?.startsWith('price:')).map(r => ({ externalId: stableArticleId(entry.sourceKey,{ link: r.sourceUrl }), sourceUrl: r.sourceUrl,
          title: r.title, summary: '', publishedAt: r.publishedAt, publishedAtRaw: r.publishedAt ? new Date(r.publishedAt).toISOString() : '' })) };
    } : null),
    parseFeed: parseFeedXml,
    extract: (html,options={}) => {
      const entry = sources.find(source => source.sourceKey === options.sourceKey || source.sourceAliases?.includes(options.sourceKey));
      return extractArticleText(options.fragment && options.sourceKey==='ftav' ? `<article itemprop="articleBody">${html}</article>` : html,
        { ...options, publisherKey: entry?.publisherKey || options.sourceKey });
    },
    readList: entry => readYahooList(browserRuntime,entry),
    readArticle: (entry,input,options={}) => entry.bodyReadMethod==='browser'
      ? readYahooArticle(browserRuntime,{...entry,expectedPublisherKey:input.publisherKey,expectedPublisherName:input.publisherName},input,options)
      : fetchAllowlisted(input,{fetchImpl,lookupImpl,...options}),
    fetch: (input, options = {}) => fetchAllowlisted(input, { fetchImpl, lookupImpl, ...options }),
  });
}
