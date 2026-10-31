import { createHash } from 'node:crypto';
import { formatFeedBefore } from '../../contracts/src/index.js';
import { ValidationError } from '../../contracts/src/errors.js';
import { ImportedMediaArticleSchema } from '../../contracts/src/hardware-prices.js';
import { MediaBriefSchema, MediaConfigSchema, MediaSavedArticleQuerySchema } from '../../contracts/src/media.js';
import { cleanIngestExcerpt } from '../../connectors/src/excerpt-text.js';
import { localizationItemId } from './localize-texts.js';
import { mediaTranslationUnits, projectMediaTranslation } from './media-translation.js';
import { formatYmd, zonedParts } from './zoned-time.js';
import { normalizeMediaUrl } from './media-url.js';
import { isFlashSource } from './flash-sources.js';
import { createArticleDedup } from './article-dedup.js';
import { twkrSourceSkipsBody } from '../../connectors/src/twkr-sources.js';
import { sourceAuthorProfile } from './source-authors.js';
const MEDIA_BUDGET = MediaConfigSchema.parse({ version: 1, sources: [] }).budget;
const MEDIA_TIMEZONE = 'Asia/Shanghai';
export const MEDIA_INGESTION_POLICY = 'native-channels-v1';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function blankState(workspaceId, sourceKey, now) {
  return {
    workspaceId,
    sourceKey,
    enabled: false,
    hostDirectVerified: false,
    bodyUseAcknowledged: false,
    health: 'disabled',
    healthDetail: '',
    etag: '',
    lastModified: '',
    feedHash: '',
    lastProbe: null,
    lastSyncAt: null,
    updatedAt: now,
  };
}

function indexHash(item) {
  return sha256([item.title, item.summary, item.sourceUrl, item.originUrl || ''].join('\n'));
}

function contentLevelFor(entry) {
  if (entry.contentAccess === 'discovery') return 'discovery';
  return 'summary_only';
}

export function mediaResourceId(externalId) {
  return localizationItemId(`media:${externalId}`);
}

export function mediaDisplayText({ title = '', summary = '', body = '' } = {}) {
  const head = String(title || '').trim();
  const rest = String(body || summary || '').trim();
  if (head && rest && rest !== head) return `${head}\n\n${rest}`;
  return head || rest;
}

function snapshotArticleText(snapshot) {
  const stored = String(snapshot?.bodyText || '').trim();
  if (stored) return snapshot.bodyText;
  const paragraphs = Array.isArray(snapshot?.article?.paragraphs) ? snapshot.article.paragraphs : [];
  return paragraphs.map((paragraph) => String(paragraph?.text || '').trim()).filter(Boolean).join('\n\n');
}

function clipListText(value, max = 200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}

function presentMediaListItem(item) {
  const originalTitle = item.title || '';
  const articleTitle = String(item.articleTranslation?.title || '').trim();
  const titleTranslated = Boolean(articleTitle) && articleTitle !== originalTitle;
  const lead = item.generatedBrief?.text
    || item.articleTranslation?.paragraphs?.find((paragraph) => paragraph.kind === 'paragraph')?.text
    || item.summary
    || '';
  const summary = clipListText(lead);
  const translated = item.translation?.text || '';
  const translationTitle = titleTranslated ? articleTitle : clipListText(translated, 80);
  return {
    id: item.id,
    resourceId: item.resourceId,
    externalId: item.externalId,
    title: titleTranslated ? articleTitle : originalTitle,
    summary,
    excerpt: summary,
    body: '',
    publishedAt: item.publishedAt,
    createdAt: item.createdAt,
    sourceUrl: item.sourceUrl,
    originUrl: item.originUrl || '',
    authorName: item.authorName || '',
    publisherKey: item.publisherKey,
    publisherName: item.publisherName,
    sourceKey: item.sourceKey,
    channel: item.channel,
    readingVia: item.readingVia || '',
    isRead: Boolean(item.isRead),
    isSaved: Boolean(item.isSaved),
    contentItemId: item.contentItemId,
    legacyContentItemId: item.legacyContentItemId,
    legacyFeedItemId: item.legacyFeedItemId,
    articleKind: item.articleKind || 'article',
    contentLevel: item.contentLevel,
    truncated: Boolean(item.truncated),
    tags: item.tags || [],
    translationStatus: item.articleTranslation?.status || item.translationStatus || 'pending',
    translationTitle,
    articleTranslation: item.articleTranslation ? {
      status: item.articleTranslation.status,
      title: item.articleTranslation.title || '',
      bodyHash: item.articleTranslation.bodyHash,
    } : null,
    translation: titleTranslated || translated ? {
      status: 'ready',
      title: translationTitle,
      engine: item.translation?.engine || '',
      targetLang: item.translation?.targetLang || 'zh',
    } : (item.translationStatus === 'stale' ? { status: 'stale', title: '', engine: '', targetLang: 'zh' } : null),
    briefState: { status: item.briefState?.status || 'pending' },
    bodyHash: item.bodyHash || '',
    snapshotRevision: item.snapshotRevision,
    fetchState: {
      extractionReason: item.fetchState?.extractionReason || '',
      visualEvidenceRequired: Boolean(item.fetchState?.visualEvidenceRequired),
      fetchStatus: item.fetchState?.fetchStatus || '',
    },
    discoveryChannels: item.discoveryChannels || [],
    status: item.status,
    detail: 'list',
  };
}

function textHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function translationMatches(row, source) {
  const text = String(source || '').trim();
  return Boolean(text && row?.translatedText && row.sourceHash === textHash(text));
}

function titleTranslationIds(item, snapshot) {
  const units = mediaTranslationUnits({
    externalId: item.externalId,
    bodyHash: snapshot?.bodyHash || item.bodyHash || '',
    title: item.title,
    paragraphs: snapshot?.article?.paragraphs || [],
  });
  return units
    .filter((unit) => unit.paragraphId === 'title' || unit.kind === 'heading')
    .flatMap((unit) => [unit.id, unit.legacyId].filter(Boolean));
}

function entryRow(workspaceId, entry, item, { at, previous, status }) {
  return {
    workspaceId,
    externalId: item.externalId,
    sourceKey: previous?.sourceKey || entry.sourceKey,
    publisherKey: item.publisherKey || previous?.publisherKey || entry.publisherKey || entry.sourceKey,
    publisherName: item.publisherName || previous?.publisherName || entry.publisher,
    authorName: item.authorName || previous?.authorName || '',
    channel: entry.channel,
    canonicalUrl: item.sourceUrl || item.canonicalUrl,
    title: cleanIngestExcerpt(item.title),
    summary: cleanIngestExcerpt(item.summary),
    publishedAt: item.publishedAt ?? previous?.publishedAt ?? null,
    publishedAtRaw: item.publishedAtRaw || previous?.publishedAtRaw || '',
    contentLevel: previous?.contentLevel === 'full' ? 'full' : contentLevelFor(entry),
    contentHash: indexHash(item),
    revision: previous ? previous.revision + (previous.contentHash === indexHash(item) ? 0 : 1) : 1,
    status,
    originUrl: item.originUrl || '',
    discoveredVia: item.discoveredVia || null,
    observedAt: at,
    bodyHash: previous?.bodyHash || '',
    truncated: Boolean(previous?.truncated),
    createdAt: previous?.createdAt || at,
    updatedAt: at,
  };
}

export function createMediaIngestionService({
  feedFilter = null,
  mediaRepository,
  feedRepository = null,
  taggingRepository = null,
  mediaPort = null,
  flashSources = null,
  now = () => Date.now(),
  budget = {},
} = {}) {
  if (!mediaRepository) throw new Error('media repository is required');
  const MEDIA_SOURCES = mediaPort?.sources || [];
  const dayKey = at => formatYmd(zonedParts(at,mediaPort?.timeZone || MEDIA_TIMEZONE));
  budget = { ...MEDIA_BUDGET, ...(mediaPort?.budget || {}), ...budget };
  const MEDIA_PUBLISHERS = [...MEDIA_SOURCES, ...(mediaPort?.publishers || [])];
  const articleDedup = createArticleDedup({ mediaRepository, feedRepository, sources: MEDIA_PUBLISHERS });
  const mediaSource = key => MEDIA_PUBLISHERS.find(s => s.sourceKey === key || s.sourceAliases?.includes(key)) || null;
  const publicVendorApi = entry => entry?.transport === 'vendor_api' && entry.sourceKey === 'arxiv' && typeof mediaPort?.readVendor === 'function';
  function saveMediaEntry(entry) {
    const dedupKey = articleDedup.keyFor({
      url: entry.canonicalUrl,
      sourceKey: entry.sourceKey,
      publisherKey: entry.publisherKey,
      sourceExternalId: entry.sourceKey ? `media:${entry.sourceKey}` : '',
    });
    return mediaRepository.upsertEntry({ ...entry, dedupKey: dedupKey || null });
  }
  function incomingArticle(entry, item) {
    return {
      url: item.sourceUrl || item.canonicalUrl || '',
      title: item.title || '',
      summary: item.summary || '',
      body: String(item.feedBodyHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      authorName: item.authorName || '',
      publishedAt: item.publishedAt || null,
      sourceKey: entry.sourceKey,
      publisherKey: item.publisherKey || entry.publisherKey || entry.sourceKey,
      sourceExternalId: `media:${entry.sourceKey}`,
    };
  }
  const mediaSourcesByChannel = channel => MEDIA_SOURCES.filter(s => !channel || s.channel === channel);
  const parsedHtmlList = entry => entry?.transport === 'html' && (
    entry.listReadMethod === 'browser' || (entry.listReadMethod === 'http' && Boolean(mediaPort?.supportsHtmlList?.(entry)))
  );
  const strictAdmission=feedFilter?.config?.mode==='enforce' && feedFilter.config.rule==='all-three-0.60';
  function qualityExcluded(workspaceId) {
    if(!strictAdmission) return feedRepository?.listQualityExcludedExternalIds?.(workspaceId,'media') || [];
    const approved=new Set(feedRepository?.listQualityApprovedExternalIds?.(workspaceId,'media') || []);
    return mediaRepository.listEntries(workspaceId,{limit:10000}).filter(r=>!approved.has(r.externalId)).map(r=>r.externalId);
  }
  const redactUrl = mediaPort?.redactUrl || (url => url);
  const fetchAllowlisted = (input, options) => mediaPort.fetch(input, options);
  const parseFeedXml = (xml, entry) => mediaPort.parseFeed(xml, entry);
  const extractorVersion = mediaPort?.extractorVersion || '';
  const budgetCooldownRemoved = (state, entry) => state.fetchStatus === 'deferred' && (
    state.extractionReason === 'success_budget' ? budget.maxSelectedBodiesPerDay == null && entry?.detailDailyCap == null :
    state.extractionReason === 'request_budget' && budget.maxBodyRequestsPerDay == null && budget.maxSourceRequestsPerDay == null
  );
  const initialFetchState = () => ({ fetchStatus: 'pending', httpStatus: null, extractionReason: '', attemptCount: 0, failureCount: 0, lastAttemptAt: null, nextRetryAt: null,
    responseBytes: 0, extractedBytes: 0, paragraphCount: 0, extractionMethod: '', extractorVersion: '', fetchedRevision: 0, etag: '', lastModified: '',
    finalUrl: '', author: '', publishedAtRaw: '', updatedAtRaw: '', selectedReason: '', visualEvidenceRequired: false });

  function stateOf(workspaceId, sourceKey, at) {
    const entry = mediaSource(sourceKey);
    const canonical = entry?.sourceKey || sourceKey;
    const saved = mediaRepository.getState(workspaceId, canonical);
    if (saved) return saved;
    const legacy = (entry?.sourceAliases || []).map(key=>mediaRepository.getState(workspaceId,key)).filter(Boolean);
    return { ...blankState(workspaceId,canonical,at), enabled:legacy.some(s=>s.enabled), hostDirectVerified:legacy.some(s=>s.hostDirectVerified),
      bodyUseAcknowledged:legacy.some(s=>s.enabled && s.bodyUseAcknowledged) };
  }

  function catalogView(workspaceId) {
    const states = new Map(mediaRepository.listStates(workspaceId).map((item) => [item.sourceKey, item]));
    return MEDIA_PUBLISHERS.map((entry) => {
      const state = states.get(entry.sourceKey) || stateOf(workspaceId,entry.sourceKey,now());
      return {
        sourceKey: entry.sourceKey,
        publisher: entry.publisher,
        channelName: entry.channelName || entry.publisher,
        channelUrl: entry.channelUrl || entry.probeUrl,
        listUrl: entry.probeUrl,
        listSelector: entry.listSelector || '',
        channel: entry.channel,
        transport: entry.transport,
        deployment: entry.deployment,
        contentAccess: entry.contentAccess,
        enabled: Boolean(state?.enabled),
        health: state?.health || 'disabled',
        healthDetail: state?.healthDetail || '',
        hostDirectVerified: Boolean(state?.hostDirectVerified),
        detailDailyCap: entry.detailDailyCap,
        refreshMinutes: entry.refreshMinutes || null,
      };
    });
  }

  function loadLegacyStates(workspaceId, itemStates) {
    const links = mediaRepository.legacyLinks?.(workspaceId) || [];
    const byProvider = new Map();
    for (const link of links) {
      const group = byProvider.get(link.legacyProvider) || [];
      group.push(link);
      byProvider.set(link.legacyProvider, group);
    }
    for (const [provider, group] of byProvider) {
      const states = feedRepository?.listContentItemStatesByExternalIds?.(workspaceId, provider, group.map((link) => link.legacyExternalId)) || [];
      const byExternal = new Map(states.map((row) => [row.externalId, row]));
      for (const link of group) {
        const legacy = byExternal.get(link.legacyExternalId);
        if (legacy) itemStates.set(link.externalId, legacy);
      }
    }
    return new Map(links.map((link) => [link.externalId, link]));
  }

  function readFeed(workspaceId, { channel = 'tech', view = 'all', sourceKey = '', offset = 0, limit = 50, externalId = '', before = null, fields = 'full' } = {}) {
    const wanted = channel === 'macro' || channel === 'tech' ? channel : 'tech';
    const pageLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const shape = externalId ? 'full' : (fields === 'list' ? 'list' : 'full');
    let entries;
    let counts;
    let matched;
    let linksByExternal;
    let itemStates;
    let nextCursor = null;
    if (!externalId && mediaRepository.listFeedPage) {
      const page = mediaRepository.listFeedPage(workspaceId, {
        channel: wanted, sourceKey, view, offset, before,
        limit: before ? pageLimit + 1 : pageLimit,
        excludedExternalIds: qualityExcluded(workspaceId),
        extractorVersion,
      });
      const hasMore = Boolean(before) && page.rows.length > pageLimit;
      entries = hasMore ? page.rows.slice(0, pageLimit) : page.rows;
      counts = page.counts;
      matched = page.matched;
      itemStates = new Map(entries.map((item) => [item.externalId, item]));
      linksByExternal = new Map(entries.filter((item) => item.legacyContentItemId).map((item) => [item.externalId, {
        externalId: item.externalId, contentItemId: item.legacyContentItemId,
        legacyProvider: item.legacyProvider, legacyExternalId: item.legacyExternalId,
      }]));
      const last = entries[entries.length - 1];
      if (last && (hasMore || (!before && offset + entries.length < matched))) {
        nextCursor = formatFeedBefore(last.isRead, last.sortAt || last.publishedAt || last.observedAt || 0, last.externalId);
      }
    } else {
      entries = (externalId ? mediaRepository.getEntries(workspaceId,[externalId]) : mediaRepository.listEntries(workspaceId, { channel: wanted, limit: 10_000 })).filter(row=>!sourceKey || row.sourceKey===sourceKey || row.publisherKey===sourceKey);
      itemStates = new Map((feedRepository?.listContentItemStatesByExternalIds?.(
        workspaceId, 'media', entries.map(item => item.externalId),
      ) || []).map(row => [row.externalId, row]));
      linksByExternal = loadLegacyStates(workspaceId, itemStates);
      const excluded=new Set(qualityExcluded(workspaceId));
      const allItems = entries.filter(item => externalId || (!itemStates.get(item.externalId)?.isHidden && !excluded.has(item.externalId)))
        .sort((a, b) => Number(Boolean(itemStates.get(a.externalId)?.isRead)) - Number(Boolean(itemStates.get(b.externalId)?.isRead)));
      const category = row => row.articleKind==='report-intro' ? 'index' : row.fetchState?.fetchStatus === 'ready' && row.contentLevel === 'full' && row.fetchState?.extractorVersion === extractorVersion && row.fetchState?.fetchedRevision === row.revision ? 'full' : ['failed','policy_skipped'].includes(row.fetchState?.fetchStatus) ? 'failed' : ['full','partial'].includes(row.contentLevel) ? 'partial' : row.fetchState?.fetchStatus === 'pending' || row.fetchState?.fetchStatus === 'deferred' ? 'pending' : 'index';
      counts = { all: allItems.length, full: 0, partial: 0, index: 0, pending: 0, failed: 0 };
      for (const item of allItems) counts[category(item)] += 1;
      const filtered = allItems.filter(row => view === 'all' || category(row) === view);
      matched = filtered.length;
      entries = externalId ? filtered : filtered.slice(offset, offset + pageLimit);
    }
    const items = entries;
    const discoveries = mediaRepository.listDiscoveries?.(workspaceId,items.map(item=>item.externalId)) || [];
    const visibleSources = catalogView(workspaceId).filter((item) => item.channel === wanted);
    const bodies = new Map((mediaRepository.latestBodies?.(workspaceId, items.map((item) => item.externalId)) || [])
      .map((row) => [row.externalId, row]));
    const verified = items.map((item) => {
      const snapshot = bodies.get(item.externalId);
      const storedBody = ['full','partial'].includes(item.contentLevel) ? (snapshot?.bodyText || '') : '';
      const article = String(storedBody).trim() ? storedBody : (['full','partial'].includes(item.contentLevel) ? snapshotArticleText(snapshot) : '');
      const verifiedFull = Boolean(String(storedBody).trim() && snapshot.contentLevel === 'full' && !snapshot.truncated && snapshot.article?.extractorVersion === extractorVersion && item.fetchState?.extractorVersion === extractorVersion && item.fetchState?.fetchStatus === 'ready' && item.fetchState?.fetchedRevision === item.revision);
      return { item, snapshot, article, verifiedFull, storedBody };
    });
    const articleTranslations = articleTranslationsFor(workspaceId, verified);
    const briefRows = mediaRepository.listBriefProcessing
      ? mediaRepository.listBriefProcessing(workspaceId, items.map((item) => ({ externalId: item.externalId, bodyHash: item.bodyHash })))
      : [];
    const briefs = new Map(briefRows.map((row) => [`${row.externalId}:${row.bodyHash}`, { status: row.status, reason: row.reason, lastAttemptAt: row.lastAttemptAt }]));
    const projected = verified.map(({ item, snapshot, article, verifiedFull, storedBody }) => {
      const body = mediaDisplayText({ title: item.title, summary: item.summary, body: article });
      const id = mediaResourceId(item.externalId);
      const link = linksByExternal.get(item.externalId);
      const state = itemStates.get(item.externalId);
      return {
        id,
        resourceId: id,
        contentItemId: state?.contentItemId || null,
        legacyContentItemId: link?.contentItemId || null,
        legacyFeedItemId: link ? `${link.legacyProvider}:${link.legacyExternalId}` : null,
        articleKind: item.articleKind || 'article',
        isRead: Boolean(state?.isRead),
        isSaved: Boolean(state?.isSaved),
        createdAt: item.createdAt,
        externalId: item.externalId,
        title: item.title,
        summary: item.summary,
        body,
        sourceUrl: item.canonicalUrl,
        authorName: snapshot?.article?.author || item.fetchState?.author || item.authorName || item.publisherName || item.publisherKey,
        publishedAt: item.publishedAt,
        contentLevel: String(storedBody).trim() ? verifiedFull ? 'full' : 'partial' : item.contentLevel,
        truncated: Boolean(snapshot?.truncated),
        fetchState: item.fetchState || {},
        paragraphs: snapshot?.article?.paragraphs || [],
        articleTranslation: verifiedFull ? (articleTranslations.get(item.externalId) || null) : null,
        generatedBrief: verifiedFull && snapshot?.brief?.bodyHash === item.bodyHash ? snapshot.brief : null,
        briefState: briefs.get(`${item.externalId}:${item.bodyHash}`) || (mediaRepository.listBriefProcessing ? { status: 'pending', reason: '', lastAttemptAt: null } : mediaRepository.getBriefProcessing(workspaceId,item.externalId,item.bodyHash)),
        bodyHash: item.bodyHash,
        snapshotRevision: snapshot?.revision || null,
        publisherKey: item.publisherKey,
        publisherName: item.publisherName || mediaSource(item.publisherKey)?.publisher || item.publisherKey,
        sourceKey: item.sourceKey,
        authorId: sourceAuthorProfile(item.sourceKey)?.authorId || '',
        sourceAuthorName: sourceAuthorProfile(item.sourceKey)?.name || '',
        discoveryChannels: discoveries.filter(d=>d.externalId===item.externalId).map(d=>({...d,channelName:mediaSource(d.sourceKey)?.channelName || mediaSource(d.sourceKey)?.publisher || d.sourceKey})),
        channel: item.channel,
        originUrl: item.originUrl,
        readingVia: item.discoveredVia?.sourceKey === 'yahoo' ? 'Yahoo Finance' : '',
        status: item.status,
      };
    });
    const titleIdsByExternal = new Map();
    for (const pair of verified) {
      const ids = titleTranslationIds(pair.item, pair.snapshot);
      if (ids.length) titleIdsByExternal.set(pair.item.externalId, ids);
    }
    const translationRows = feedRepository?.listTranslations?.(
      workspaceId,
      [...projected.map((item) => item.id), ...[...titleIdsByExternal.values()].flat()],
      'zh',
    ) || [];
    const translationById = new Map(translationRows.map((row) => [row.itemId, row]));
    const tagRows = taggingRepository?.listTaggings?.(
      workspaceId,
      'media-index',
      projected.map((item) => item.resourceId),
    ) || [];
    const tagsById = new Map(tagRows.map((row) => [row.resourceId, row.tags]));
    const legacyTagIds = projected.map((item) => item.legacyContentItemId).filter(Boolean);
    const legacyTags = new Map((taggingRepository?.listTaggings?.(workspaceId, 'content-item', legacyTagIds) || []).map((row) => [row.resourceId, row.tags]));
    return {
      platform: 'media',
      feed: wanted,
      source: 'media-index',
      mode: projected.length ? 'cached' : 'empty',
      fetchedAt: now(),
      note: matched
        ? `媒体索引 ${matched} 条 · 正文 ${counts?.full || 0} 篇 · ${wanted === 'tech' ? '产业科技' : '宏观与国际'}`
        : '来源默认关闭。主机探针确认 RSS 后，才能显式启用第一批。',
      items: projected.map((item) => {
        const saved = translationById.get(item.id);
        const titleSource = String(item.title || '').trim();
        const displaySource = String(item.body || '').trim();
        const blockRow = (titleIdsByExternal.get(item.externalId) || [])
          .map((id) => translationById.get(id))
          .find((row) => translationMatches(row, titleSource));
        const bodyReady = translationMatches(saved, displaySource);
        const titleRow = translationMatches(saved, titleSource) ? saved : blockRow;
        const chosen = bodyReady ? saved : titleRow;
        const full = {
          ...item,
          tags: tagsById.get(item.resourceId) || legacyTags.get(item.legacyContentItemId) || [],
          translation: chosen ? {
            text: chosen.translatedText,
            engine: chosen.engine || '',
            targetLang: chosen.targetLang || 'zh',
          } : null,
          translationStatus: chosen ? 'ready' : saved ? 'stale' : 'pending',
        };
        return shape === 'list' ? presentMediaListItem(full) : full;
      }),
      sources: visibleSources,
      budget: mediaRepository.budgetDay(workspaceId, dayKey(now())),
      counts,
      total: matched,
      nextCursor,
      nextOffset: before ? null : (offset + items.length < matched ? offset + items.length : null),
    };
  }

  async function probe({ workspaceId = 'local', sourceKeys = [], policyReviewed = false, run = false } = {}) {
    const keys = [...new Set(sourceKeys.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, budget.maxActiveSources);
    const unknown = keys.filter((key) => !mediaSource(key));
    if (!keys.length || unknown.length) {
      throw new ValidationError('探针只能选择目录内的来源', ['sourceKeys']);
    }
    const plans = keys.map((key) => {
      const entry = mediaSource(key);
      return { sourceKey: key, transport: entry.transport, url: redactUrl(entry.probeUrl), allowedHosts: entry.allowedHosts };
    });
    if (!policyReviewed || !run) {
      return { dryRun: true, requestCount: 0, plans };
    }
    const at = now();
    const results = [];
    let requestCount = 0;
    for (const key of keys) {
      const entry = mediaSource(key);
      const current = stateOf(workspaceId, key, at);
      if (entry.transport === 'vendor_api' && !publicVendorApi(entry)) {
        const saved = mediaRepository.saveState({
          ...current,
          health: 'needs_credentials',
          healthDetail: '没有凭证，不把产品介绍地址当成业务接口',
          updatedAt: at,
        });
        results.push({ sourceKey: key, health: saved.health, status: null, requestCount: 0, items: null });
        continue;
      }
      if (publicVendorApi(entry)) {
        const fetched = await mediaPort.readVendor(entry);
        requestCount += Number(fetched.requestCount) || 0;
        const verified = Boolean(fetched.ok && fetched.items?.length);
        const health = verified ? 'ready' : (fetched.health || 'empty');
        mediaRepository.saveState({
          ...current,
          hostDirectVerified: verified || current.hostDirectVerified,
          health,
          healthDetail: fetched.note || '',
          lastProbe: {
            sourceKey: key,
            status: fetched.status ?? null,
            health,
            itemCount: fetched.items?.length ?? null,
            observedAt: at,
            finalUrl: entry.probeUrl,
          },
          updatedAt: at,
        });
        results.push({ sourceKey: key, health, status: fetched.status ?? null, requestCount: fetched.requestCount || 0, itemCount: fetched.items?.length ?? null, items: null });
        continue;
      }
      if (entry.transport === 'existing_adapter') {
        results.push({ sourceKey: key, health: 'existing_adapter', status: null, requestCount: 0, items: null });
        continue;
      }
      const browserList = parsedHtmlList(entry);
      const fetched = browserList ? await mediaPort.readList(entry) : await fetchAllowlisted({
        url: entry.probeUrl,
        allowedHosts: entry.allowedHosts,
        redirectHosts: entry.redirectHosts,
      }, { maxBytes: budget.maxFeedBytes });
      requestCount += 1 + fetched.redirectChain.length;
      let health = fetched.health;
      let itemCount = null;
      let verified = false;
      if ((entry.transport === 'rss' || browserList) && fetched.ok && !fetched.notModified) {
        const parsed = browserList ? fetched : parseFeedXml(fetched.body, entry);
        health = parsed.ok ? (parsed.items.length ? 'ready' : 'empty') : parsed.health;
        itemCount = parsed.ok ? parsed.items.length : null;
        verified = parsed.ok && parsed.items.length > 0;
      }
      const observation = {
        sourceKey: key,
        status: fetched.status ?? null,
        contentType: fetched.contentType || '',
        redirectChain: fetched.redirectChain,
        bytes: fetched.bytes || 0,
        date: fetched.date || '',
        finalUrl: fetched.finalUrl || '',
        health,
        itemCount,
        observedAt: at,
      };
      mediaRepository.saveState({
        ...current,
        hostDirectVerified: verified || current.hostDirectVerified,
        health,
        healthDetail: fetched.note || '',
        lastProbe: observation,
        updatedAt: at,
      });
      results.push({ ...observation, items: null });
    }
    return { dryRun: false, requestCount, results };
  }

  function enableSource(workspaceId, sourceKey) {
    const entry = mediaSource(sourceKey);
    if (!entry) throw new ValidationError('未知媒体来源', ['sourceKey']);
    const at = now();
    const current = stateOf(workspaceId, sourceKey, at);
    const existingBody = entry.transport === 'existing_adapter' && (entry.contentAccess === 'body' || entry.sourceKey === 'trendforce');
    const browserList = parsedHtmlList(entry);
    const publicApi = publicVendorApi(entry);
    if (!existingBody && !publicApi && (entry.deployment !== 'first' || entry.transport !== 'rss' && !browserList)) {
      return { ok: false, health: entry.transport === 'vendor_api' ? 'needs_credentials' : 'not_in_initial_batch' };
    }
    if (!existingBody && !current.hostDirectVerified) return { ok: false, health: 'needs_host_probe' };
    const enabled = MEDIA_PUBLISHERS.filter(source=>source.sourceKey!==entry.sourceKey && source.transport!=='existing_adapter' && stateOf(workspaceId,source.sourceKey,at).enabled);
    if (!existingBody && enabled.length >= budget.maxActiveSources) return { ok: false, health: 'budget_deferred' };
    mediaRepository.saveState({ ...current, enabled: true, health: 'ready', updatedAt: at });
    return { ok: true, health: 'ready' };
  }

  function disableSource(workspaceId, sourceKey) {
    const at = now();
    const current = stateOf(workspaceId, sourceKey, at);
    mediaRepository.saveState({ ...current, enabled: false, health: 'disabled', updatedAt: at });
    return { ok: true, health: 'disabled' };
  }

  function acceptDeferred(workspaceId, entry, at) {
    const waiting = [entry.sourceKey,...(entry.sourceAliases || [])].flatMap(key=>mediaRepository.listDeferred(workspaceId,key));
    if (!waiting.length) return 0;
    const reservation = mediaRepository.reserveMetadata(
      workspaceId, dayKey(at), waiting.length, at, budget.maxNewMetadataPerDay, { recordDeferred: false },
    );
    waiting.slice(0, reservation.allowed).forEach((item) => {
      saveMediaEntry({ ...item, status: 'indexed', updatedAt: at });
    });
    return reservation.allowed;
  }

  async function syncSource(workspaceId, entry, at, force = false) {
    const current = stateOf(workspaceId, entry.sourceKey, at);
    if (!current.enabled) return { sourceKey: entry.sourceKey, health: 'disabled', added: 0, items: null };
    const reparse = current.ingestionPolicy !== MEDIA_INGESTION_POLICY;
    if (!reparse && !force && current.lastSyncAt && at < current.lastSyncAt + entry.refreshMinutes * 60_000) return { sourceKey: entry.sourceKey, health: 'not_due', added: 0, items: null };
    if (entry.transport === 'vendor_api' && !publicVendorApi(entry)) {
      mediaRepository.saveState({
        ...current,
        health: 'needs_credentials',
        healthDetail: '没有 Key 或使用许可',
        updatedAt: at,
      });
      return { sourceKey: entry.sourceKey, health: 'needs_credentials', added: 0, items: null };
    }
    const vendorRead = publicVendorApi(entry) ? await mediaPort.readVendor(entry) : null;
    if (vendorRead && !vendorRead.ok) {
      mediaRepository.saveState({
        ...current,
        health: vendorRead.health || 'network',
        healthDetail: vendorRead.note || '',
        updatedAt: at,
      });
      return { sourceKey: entry.sourceKey, health: vendorRead.health || 'network', added: 0, items: null };
    }
    if (entry.transport === 'existing_adapter' && !mediaPort?.readExisting) {
      return { sourceKey: entry.sourceKey, health: 'existing_adapter', added: 0, items: null };
    }
    const browserList = parsedHtmlList(entry);
    if (!vendorRead && entry.transport !== 'rss' && entry.transport !== 'existing_adapter' && !browserList) {
      mediaRepository.saveState({ ...current, health: 'needs_parser', healthDetail: '栏目页还没有验收过的列表解析', updatedAt: at });
      return { sourceKey: entry.sourceKey, health: 'needs_parser', added: 0, items: null };
    }
    const existing = vendorRead
      ? { ok: true, health: vendorRead.health || 'ready', items: vendorRead.items || [], note: vendorRead.note || '' }
      : entry.transport === 'existing_adapter' ? await mediaPort.readExisting(entry) : browserList ? await mediaPort.readList(entry) : null;
    const fetched = existing ? { ok: existing.ok, health: existing.health, body: JSON.stringify(existing.items), etag: '', lastModified: '' } : await fetchAllowlisted({
      url: entry.probeUrl,
      allowedHosts: entry.allowedHosts,
      redirectHosts: entry.redirectHosts,
      etag: reparse ? '' : current.etag,
      lastModified: reparse ? '' : current.lastModified,
    }, { maxBytes: budget.maxFeedBytes });
    if (!fetched.ok) {
      mediaRepository.saveState({ ...current, health: fetched.health, healthDetail: fetched.note || '', updatedAt: at });
      return { sourceKey: entry.sourceKey, health: fetched.health, added: 0, items: null };
    }
    if (fetched.notModified) {
      if (reparse) return {sourceKey:entry.sourceKey,health:'policy_reparse_required',added:0,items:null,note:'unconditional request returned 304; policy remains pending'};
      const acceptedDeferred = acceptDeferred(workspaceId, entry, at);
      mediaRepository.saveState({
        ...current,
        health: 'not_modified',
        etag: fetched.etag || current.etag,
        lastModified: fetched.lastModified || current.lastModified,
        lastSyncAt: at,
        updatedAt: at,
      });
      return { sourceKey: entry.sourceKey, health: 'not_modified', added: acceptedDeferred, items: null };
    }
    const parsed = existing || parseFeedXml(fetched.body, entry);
    if (!parsed.ok) {
      mediaRepository.saveState({ ...current, health: parsed.health, healthDetail: parsed.note, updatedAt: at });
      return { sourceKey: entry.sourceKey, health: parsed.health, added: 0, items: null };
    }
    const comparisonInput = parsed.observations || parsed.items;
    const comparisons = () => comparisonInput.slice(0,10).map((item,position)=>{
      const url=normalizeMediaUrl(item.sourceUrl || item.url || item.canonicalUrl,entry.trackingParams || []);
      const row=mediaRepository.findByUrl?.(workspaceId,url) || mediaRepository.getEntries(workspaceId,[item.externalId]).at(0);
      return {position:item.listPosition ?? position,title:item.title,url,externalId:row?.externalId || item.externalId || '',
        alreadyExisted:Boolean(row),indexed:Boolean(row && row.status!=='budget_deferred'),inLookback:item.publishedAt==null || item.publishedAt>=at-(entry.backfillHours ?? budget.backfillHours)*3600000,
        excludedReason:item.excludedReason || '',status:row?.status || item.excludedReason || 'outside_lookback',bodyStatus:row?.fetchState?.fetchStatus || 'pending'};
    });
    const initialComparisons=comparisons();
    const feedHash = sha256(`${MEDIA_INGESTION_POLICY}\n${entry.backfillHours ?? budget.backfillHours}\n${fetched.body}`);
    if (feedHash && feedHash === current.feedHash) {
      const acceptedDeferred = acceptDeferred(workspaceId, entry, at);
      mediaRepository.saveState({
        ...current,
        health: 'not_modified',
        etag: fetched.etag || current.etag,
        lastModified: fetched.lastModified || current.lastModified,
        feedHash,
        lastSyncAt: at,
        updatedAt: at,
      });
      return { sourceKey: entry.sourceKey, health: 'not_modified', added: acceptedDeferred, listUrl:entry.probeUrl,listKind:entry.transport,comparisons:initialComparisons,items: null };
    }
    const cutoff = at - (entry.backfillHours ?? budget.backfillHours) * 60 * 60 * 1000;
    const urlIds = new Map();
    const fresh = parsed.items.map((item,position)=>{
      const sourceUrl = normalizeMediaUrl(item.sourceUrl || item.canonicalUrl,entry.trackingParams || []);
      const previous = mediaRepository.findByUrl?.(workspaceId,sourceUrl);
      const externalId = previous?.externalId || urlIds.get(sourceUrl) || item.externalId;
      urlIds.set(sourceUrl,externalId);
      return {...item,sourceUrl,externalId,listPosition:item.listPosition ?? position};
    }).filter((item) => item.publishedAt == null || item.publishedAt >= cutoff);
    const known = new Map(mediaRepository.getEntries(workspaceId, fresh.map((item) => item.externalId))
      .map((item) => [item.externalId, item]));
    const changed = [...new Map(fresh.filter((item) => {
      const previous = known.get(item.externalId);
      return (!previous || mediaSource(previous.sourceKey)?.sourceKey === entry.sourceKey) && previous?.contentHash !== indexHash(item);
    }).map(item=>[item.externalId,item])).values()];
    const created = changed.filter((item) => !known.has(item.externalId));
    const listCap = Number.isInteger(entry.maxListCandidates) ? entry.maxListCandidates : null;
    const cappedOut = new Set(listCap == null ? [] : created.slice(listCap).map((item) => item.externalId));
    const createdWithinCap = created.filter((item) => !cappedOut.has(item.externalId));
    const retry = changed.filter((item) => known.get(item.externalId)?.status === 'budget_deferred');
    const reservation = mediaRepository.reserveMetadata(
      workspaceId, dayKey(at), createdWithinCap.length, at, budget.maxNewMetadataPerDay,
    );
    const retryReservation = mediaRepository.reserveMetadata(
      workspaceId, dayKey(at), retry.length, at, budget.maxNewMetadataPerDay, { recordDeferred: false },
    );
    const accepted = new Set([
      ...createdWithinCap.slice(0, reservation.allowed),
      ...retry.slice(0, retryReservation.allowed),
    ].map((item) => item.externalId));
    const deferredIds = new Set([...createdWithinCap, ...retry]
      .filter((item) => !accepted.has(item.externalId))
      .map((item) => item.externalId));
    let added = 0;
    const mergedMediaId = new Map();
    for (const item of changed) {
      if (cappedOut.has(item.externalId)) continue;
      const previous = known.get(item.externalId);
      if (!previous) {
        const article = incomingArticle(entry, item);
        const match = articleDedup.find(workspaceId, article, { ignoreMediaIds: [item.externalId] });
        if (match && !(String(item.externalId).startsWith('arxiv:') && match.externalId !== item.externalId)) {
          articleDedup.fill(match, article);
          mergedMediaId.set(item.externalId, match.kind === 'media' ? match.externalId : '');
          continue;
        }
      }
      const deferred = deferredIds.has(item.externalId);
      // Index and body are separate scoring inputs. Preserve both originals in media storage.
      const gateRow=entryRow(workspaceId,entry,item,{at,previous,status:deferred?'budget_deferred':'indexed'});
      const gate= !deferred && previous?.contentLevel!=='full' ? await evaluateMediaGate(workspaceId,gateRow,{text:item.summary || '',truncated:false}) : null;
      mediaRepository.atomic(() => {
      saveMediaEntry(entryRow(workspaceId, entry, item, {
        at,
        previous,
        status: deferred ? 'budget_deferred' : (previous?.status === 'body_ready' ? 'body_ready' : 'indexed'),
      }));
      if (item.feedBodyHtml) mediaRepository.saveFeedBody(workspaceId, item.externalId, item.feedBodyHtml);
      if(gate) saveMediaGate(workspaceId,gateRow,{text:item.summary || '',truncated:false},indexHash(item),gate);
      if (item.fullText?.status === 'deferred') {
        mediaRepository.saveFetchState(workspaceId, item.externalId, {
          ...initialFetchState(),
          fetchStatus: 'deferred',
          extractionReason: String(item.fullText.reason || 'full_text_deferred:html_preferred').slice(0, 500),
          extractionMethod: 'arxiv-abstract-v1',
          finalUrl: String(item.fullText.htmlUrl || '').slice(0, 2048),
          lastAttemptAt: at,
        });
      }
      });
      if (!deferred && (!previous || previous.status === 'budget_deferred')) added += 1;
    }
    for (const item of fresh) {
      const previous=known.get(item.externalId);
      if (previous && mediaSource(previous.sourceKey)?.sourceKey===entry.sourceKey && previous.contentHash===indexHash(item) &&
        ((item.publisherName && previous.publisherName!==item.publisherName) || (item.authorName && previous.authorName!==item.authorName))) {
        saveMediaEntry({...previous,publisherKey:item.publisherKey || previous.publisherKey,
          publisherName:item.publisherName || previous.publisherName,authorName:item.authorName || previous.authorName,updatedAt:at});
      }
    }
    added += acceptDeferred(workspaceId, entry, at);
    for (const item of fresh) {
      if (cappedOut.has(item.externalId)) continue;
      const target = mergedMediaId.has(item.externalId) ? mergedMediaId.get(item.externalId) : item.externalId;
      if (!target) continue;
      mediaRepository.saveDiscovery?.({workspaceId,externalId:target,sourceKey:entry.sourceKey,
        entryUrl:entry.probeUrl,listPosition:item.listPosition,firstSeenAt:at,lastSeenAt:at});
    }
    const dated = parsed.items.map((item) => item.publishedAt).filter((value) => Number.isInteger(value));
    const newest = dated.length ? Math.max(...dated) : null;
    const oldest = dated.length ? Math.min(...dated) : null;
    const stale = newest != null && newest < at - 7 * 24 * 60 * 60 * 1000;
    const possibleGap = Boolean(current.lastSyncAt && oldest && oldest > current.lastSyncAt);
    const health = possibleGap ? 'possible_gap' : (stale ? 'stale' : (parsed.items.length ? 'ready' : 'empty'));
    mediaRepository.saveState({
      ...current,
      health,
      healthDetail: [reservation.deferred ? `budget_deferred ${reservation.deferred}` : '', cappedOut.size ? `candidate_limit ${cappedOut.size}` : ''].filter(Boolean).join('; '),
      etag: fetched.etag || '',
      lastModified: fetched.lastModified || '',
      feedHash: cappedOut.size ? '' : feedHash,
      ingestionPolicy: MEDIA_INGESTION_POLICY,
      lastSyncAt: at,
      updatedAt: at,
    });
    return { sourceKey: entry.sourceKey, health, added, deferred: reservation.deferred, policyReparsed:reparse,
      listUrl:entry.probeUrl, listKind:entry.transport, comparisons:comparisons().map((item,i)=>({...item,alreadyExisted:initialComparisons[i].alreadyExisted})),items:null };
  }

  async function syncEnabled({ workspaceId = 'local', channel = '', force = false } = {}) {
    const at = now();
    const entries = mediaSourcesByChannel(channel).filter((entry) => entry.sourceKey!=='trendforce' && stateOf(workspaceId, entry.sourceKey, at).enabled);
    const results = [];
    for (const entry of entries) {
      try {
        results.push(await syncSource(workspaceId, entry, at, force));
      } catch (error) {
        results.push({
          sourceKey: entry.sourceKey,
          health: 'network',
          added: 0,
          items: null,
          note: error instanceof Error ? error.message : '来源失败',
        });
      }
    }
    return { results, feed: readFeed(workspaceId, { channel: channel || 'tech' }) };
  }

  function acknowledgeBodyUse(workspaceId, sourceKeys) {
    const at = now();
    for (const key of sourceKeys) {
      const entry = mediaSource(key);
      if (!entry || entry.contentAccess !== 'body') continue;
      mediaRepository.saveState({ ...stateOf(workspaceId,key,at), bodyUseAcknowledged: true, updatedAt: at });
    }
  }

  async function fetchBodies({ workspaceId = 'local', externalIds = [], usageReviewed, repair = false, selectedReasons = {}, signal, deadlineAt } = {}) {
    if (usageReviewed === false) return { ok: false, health: 'needs_license', fetched: [] };
    // Explicit operator acknowledgement is recorded before making any request.
    const rows = mediaRepository.getEntries(workspaceId, [...new Set(externalIds)].slice(0,40));
    if (usageReviewed === true) acknowledgeBodyUse(workspaceId, [...new Set(rows.map(r => r.sourceKey))]);
    const at = now();
    const fetched = [];
    const pausedSources = new Set();
    const stats = { selected: rows.length, attempted: 0, requests: 0, validFull: 0, partial: 0, failed: 0, policySkipped: 0, deferred: 0, skipped: 0 };
    let processed = 0;
    let stoppedEarly = false;
    for (const row of rows) {
      if (signal?.aborted || (Number.isFinite(Number(deadlineAt)) && Date.now() >= Number(deadlineAt))) {
        stoppedEarly = true;
        break;
      }
      processed += 1;
      const entry = mediaSource(row.sourceKey);
      const old = { ...initialFetchState(), ...row.fetchState };
      if (budgetCooldownRemoved(old, entry)) old.nextRetryAt = null;
      let state = { ...old, selectedReason: selectedReasons[row.externalId] || old.selectedReason || 'explicit_selection' };
      const result = (health, kind, extra = {}) => {
        stats[kind] += 1;
        fetched.push({ externalId: row.externalId, sourceKey: row.sourceKey, health, contentLevel: row.contentLevel, ...extra });
      };
      if (twkrSourceSkipsBody(row.sourceKey)) {
        result('index_only', 'skipped', { skipped: true });
        continue;
      }
      // TrendForce's owner collector has already saved the verified body or report intro.
      if (row.sourceKey === 'trendforce') { result(old.fetchStatus === 'ready' ? 'ready' : 'source_owned','skipped',{skipped:true}); continue; }
      if (!entry || entry.contentAccess !== 'body' || !stateOf(workspaceId,row.sourceKey,at).bodyUseAcknowledged) {
        if (String(old.extractionReason || '').startsWith('full_text_deferred')) {
          result('full_text_deferred', 'skipped', { skipped: true, contentLevel: row.contentLevel });
          continue;
        }
        state = { ...state, fetchStatus: 'policy_skipped', extractionReason: entry?.contentAccess === 'body' ? 'needs_license' : 'index_only' };
        mediaRepository.saveFetchState(workspaceId,row.externalId,state);
        result(state.extractionReason,'policySkipped'); continue;
      }
      const previous = mediaRepository.latestBodies(workspaceId,[row.externalId])[0];
      if (!repair && row.contentLevel === 'full' && row.bodyHash && old.fetchStatus==='ready' && old.extractorVersion === extractorVersion && old.fetchedRevision === row.revision) {
        result('ready','skipped',{ skipped: true }); continue;
      }
      if (entry.bodyReadMethod==='browser' && entry.sourceKey==='yahooeconomy' && !['reuters','bloomberg'].includes(row.publisherKey)) {
        mediaRepository.saveFetchState(workspaceId,row.externalId,{...state,fetchStatus:'policy_skipped',extractionReason:row.publisherKey==='unknown'?'publisher_unknown':'publisher_adapter_pending',extractorVersion});
        result('publisher_adapter_pending','policySkipped');continue;
      }
      if (!repair && old.fetchStatus === 'failed' && (!old.nextRetryAt || old.nextRetryAt > at)) { result('retry_cooldown','deferred'); continue; }
      if (!repair && old.nextRetryAt > at && old.fetchStatus !== 'ready') { result('retry_cooldown','deferred'); continue; }
      if (pausedSources.has(entry.sourceKey)) { result('rate_limited','deferred'); continue; }
      const alreadyCounted = previous?.contentLevel === 'full';
      const reservation = alreadyCounted ? { reserved: true } : mediaRepository.reserveBody(workspaceId, dayKey(at), entry.sourceKey, at, {
        globalMax: budget.maxSelectedBodiesPerDay, sourceMax: entry.detailDailyCap, sourceAliases:entry.sourceAliases || [],
      });
      if (!reservation.reserved) {
        mediaRepository.saveFetchState(workspaceId,row.externalId,{ ...state, fetchStatus: 'deferred', extractionReason: 'success_budget', nextRetryAt: at + 3_600_000 });
        result('budget_deferred','deferred'); continue;
      }
      let response = { ok: true, status: null, bytes: 0, finalUrl: row.canonicalUrl };
      let article = row.feedBodyHtml ? mediaPort.extract(row.feedBodyHtml,{ fragment: true, sourceKey: entry.sourceKey, title: row.title, summary: row.summary, maxBytes: budget.maxBodyBytes }) : null;
      // A feed preview is never enough to suppress an article request.
      if (article?.contentLevel !== 'full') {
        const validators = previous?.article?.extractorVersion === extractorVersion && !repair ? { etag: old.etag, lastModified: old.lastModified } : {};
        const readArticle = mediaPort.readArticle ? (input,options)=>mediaPort.readArticle(entry,input,options) : mediaPort.fetch;
        response = await readArticle({ url: row.canonicalUrl, publisherKey:row.publisherKey, publisherName:row.publisherName, allowedHosts: entry.articleHosts, redirectHosts: entry.redirectHosts, kind: 'article', ...validators }, { maxBytes: budget.maxFeedBytes, maxBodyBytes: budget.maxBodyBytes, onRequest() {
          const reserved = mediaRepository.reserveRequest(workspaceId,dayKey(at),entry.sourceKey,at,budget.maxBodyRequestsPerDay,budget.maxSourceRequestsPerDay,entry.sourceAliases || []);
          if (reserved) stats.requests += 1;
          return reserved;
        } });
        if (response.health === 'budget_deferred') {
          if (!alreadyCounted) mediaRepository.releaseBody(workspaceId,dayKey(at),entry.sourceKey,at);
          mediaRepository.saveFetchState(workspaceId,row.externalId,{ ...state, fetchStatus: 'deferred', extractionReason: 'request_budget', nextRetryAt: at + 3_600_000 });
          result('budget_deferred','deferred'); continue;
        }
        if (response.notModified && previous) {
          mediaRepository.saveFetchState(workspaceId,row.externalId,{ ...state, fetchStatus: previous.contentLevel === 'full' ? 'ready' : 'partial', httpStatus: 304, lastAttemptAt: at,
            attemptCount: old.attemptCount + 1, fetchedRevision: row.revision, nextRetryAt: at + 86_400_000, extractionReason: 'not_modified' });
          if (!alreadyCounted) mediaRepository.releaseBody(workspaceId,dayKey(at),entry.sourceKey,at);
          stats.attempted += 1; result('not_modified','skipped',{ skipped: true }); continue;
        }
        article = response.ok ? response.article || mediaPort.extract(response.body,{ status: response.status, sourceKey: entry.sourceKey, title: row.title, summary: row.summary, maxBytes: budget.maxBodyBytes }) : { ok: false, reason: response.health, text: '' };
      }
      stats.attempted += 1;
      const attemptCount = old.attemptCount + 1;
      const failureCount = article.ok ? 0 : (old.failureCount || 0) + 1;
      const transient = ['network','rate_limited','http_error'].includes(article.reason) && (response.status == null || response.status === 429 || response.status >= 500);
      const retryAfterMs = Number(response.retryAfterMs);
      const nextRetryAt = article.ok ? at + 86_400_000
        : article.reason === 'rate_limited' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? at + retryAfterMs
        : transient && failureCount < 5 ? at + Math.min(86_400_000, 900_000 * 2 ** (failureCount-1)) : null;
      if (article.reason === 'rate_limited') pausedSources.add(entry.sourceKey);
      state = { ...state, fetchStatus: article.ok ? article.contentLevel === 'full' ? 'ready' : 'partial' : 'failed', httpStatus: response.status ?? null,
        extractionReason: article.reason || '', attemptCount, failureCount, lastAttemptAt: at, nextRetryAt, responseBytes: response.bytes || 0,
        extractedBytes: Buffer.byteLength(article.text || ''), paragraphCount: article.paragraphs?.length || 0, extractionMethod: article.extractionMethod || '', extractorVersion,
        fetchedRevision: article.ok ? row.revision : old.fetchedRevision, etag: String(response.etag || '').slice(0,1000), lastModified: String(response.lastModified || '').slice(0,1000), finalUrl: String(response.finalUrl || '').slice(0,2048),
        author: article.author || '', publishedAtRaw: article.publishedAtRaw || '', updatedAtRaw: article.updatedAtRaw || '', visualEvidenceRequired: Boolean(article.visualEvidenceRequired) };
      if (!article.ok) {
        if (!alreadyCounted) mediaRepository.releaseBody(workspaceId,dayKey(at),entry.sourceKey,at);
        mediaRepository.saveFetchState(workspaceId,row.externalId,state);
        result(article.reason || 'failed','failed'); continue;
      }
      const bodyHash = sha256(article.text);
      const changed = previous?.bodyHash !== bodyHash || previous?.article?.extractorVersion !== extractorVersion ||
        (previous.article?.author || '') !== (article.author || '') || (previous.article?.publishedAtRaw || '') !== (article.publishedAtRaw || '') || Boolean(previous.article?.visualEvidenceRequired) !== Boolean(article.visualEvidenceRequired);
      const revision = changed ? mediaRepository.nextSnapshotRevision(workspaceId,row.externalId) : previous.revision;
      const gate=await evaluateMediaGate(workspaceId,row,article);
      mediaRepository.atomic(() => {
        if (changed) mediaRepository.saveSnapshot({ workspaceId, externalId: row.externalId, revision, bodyHash, bodyText: article.text,
          truncated: article.truncated, contentLevel: article.contentLevel, observedAt: at, article: { ...article, text: undefined, sourceRevision: row.revision, finalUrl: response.finalUrl || row.canonicalUrl } });
        const degrade = previous?.contentLevel === 'full' && article.contentLevel !== 'full';
        if (!degrade) {
          const articleDate=Date.parse(article.publishedAtRaw || '');
          saveMediaEntry({ ...row, publishedAt: row.publishedAt ?? (Number.isFinite(articleDate) && articleDate>=0 ? articleDate : null), publishedAtRaw: row.publishedAtRaw || article.publishedAtRaw || '', originUrl: response.originUrl || row.originUrl, contentLevel: article.contentLevel, bodyHash, truncated: article.truncated, status: 'body_ready', updatedAt: at });
          promoteBody(workspaceId,row,article,bodyHash,gate);
        }
        mediaRepository.saveFetchState(workspaceId,row.externalId,state);
      });
      if (article.contentLevel !== 'full' && !alreadyCounted) mediaRepository.releaseBody(workspaceId,dayKey(at),entry.sourceKey,at);
      result(article.contentLevel === 'full' ? 'ready' : 'partial', article.contentLevel === 'full' ? 'validFull' : 'partial', { contentLevel: article.contentLevel, bodyHash, snapshotRevision: revision, truncated: article.truncated });
    }
    return { ok: !stats.failed && !stats.partial && !stats.policySkipped && !stats.deferred, health: stoppedEarly || stats.failed || stats.partial || stats.policySkipped || stats.deferred ? 'partial' : 'ready', stats, fetched, processed, stoppedEarly };
  }

  async function evaluateMediaGate(workspaceId,row,article) {
    if(isFlashSource({sourceKey: row.sourceKey, publisher: row.publisherName || row.publisherKey, id: row.sourceKey}, flashSources)) return null;
    if(!feedFilter?.evaluate) return null;
    return feedFilter.evaluate({workspaceId,provider:'media',existingCapture:null,existingByContentHash:null,hasIdentityFingerprint:false,
      item:{title:row.title,body:article.text || row.title,authorName:article.author || '',captureContext:{truncated:Boolean(article.truncated)}}});
  }

  function saveMediaGate(workspaceId,row,article,bodyHash,gate) {
    if(!feedRepository?.saveCapture) return null;
    const source=feedRepository.upsertSourceAccount({workspaceId,provider:'media',externalId:`media:${row.sourceKey}`,
      displayName:mediaSource(row.sourceKey)?.publisher || row.sourceKey,profileUrl:row.canonicalUrl,authMode:'public',
      metadata:{sourceId:'content.media.articles',autoRefresh:false,sourceKey:row.sourceKey}});
    return feedRepository.saveCapture({workspaceId,provider:'media',externalId:row.externalId,sourceAccountId:source.id,
      sourceUrl:row.canonicalUrl,title:row.title,contentHash:bodyHash,status:gate?.status || 'ready',publishedAt:row.publishedAt,
      metadata:{...(gate?.metadata || {}),originalText:article.text || row.title,publisherKey:row.publisherKey,sourceKey:row.sourceKey,articleKind:row.articleKind || 'article',contentLevel:article.contentLevel || 'summary_only',
        extractorVersion,bodyHash,truncated:Boolean(article.truncated),publishedAtRaw:row.publishedAtRaw,channel:row.channel}});
  }

  function promoteBody(workspaceId, row, article, bodyHash, gate=null) {
    if (!feedRepository?.saveCapture || !feedRepository?.saveContentItem) return;
    if(gate) {
      const capture=saveMediaGate(workspaceId,row,article,bodyHash,gate);
      if(!gate.createContentItem) return;
      const saved = feedRepository.saveContentItem({workspaceId,captureId:capture.id,originType:'subscription',contentType:'article',
        title:row.title,body:article.text,summary:row.summary,sourceUrl:row.canonicalUrl,authorName:article.author || row.publisherKey,publishedAt:row.publishedAt});
      articleDedup.rememberFeed(workspaceId, saved?.id, {
        url: row.canonicalUrl, title: row.title || '', publishedAt: row.publishedAt,
        sourceKey: row.sourceKey, publisherKey: row.publisherKey, sourceExternalId: `media:${row.sourceKey}`,
      });
      return;
    }
    const source = feedRepository.upsertSourceAccount({
      workspaceId,
      provider: 'media',
      externalId: `media:${row.sourceKey}`,
      displayName: mediaSource(row.sourceKey)?.publisher || row.sourceKey,
      profileUrl: row.canonicalUrl,
      authMode: 'public',
      metadata: { sourceId: 'content.media.articles', autoRefresh: false, sourceKey: row.sourceKey },
    });
    const capture = feedRepository.saveCapture({
      workspaceId,
      provider: 'media',
      externalId: row.externalId,
      sourceAccountId: source.id,
      sourceUrl: row.canonicalUrl,
      title: row.title,
      contentHash: bodyHash,
      status: 'ready',
      publishedAt: row.publishedAt,
      metadata: {
        publisherKey: row.publisherKey,
        sourceKey: row.sourceKey,
        contentLevel: article.contentLevel,
        extractorVersion,
        bodyHash,
        truncated: article.truncated,
        publishedAtRaw: row.publishedAtRaw,
        channel: row.channel,
      },
    });
    const saved = feedRepository.saveContentItem({
      workspaceId,
      captureId: capture.id,
      originType: 'subscription',
      contentType: 'article',
      title: row.title,
      body: article.text,
      summary: row.summary,
      sourceUrl: row.canonicalUrl,
      authorName: article.author || row.publisherKey,
      publishedAt: row.publishedAt,
    });
    articleDedup.rememberFeed(workspaceId, saved?.id, {
      url: row.canonicalUrl, title: row.title || '', publishedAt: row.publishedAt,
      sourceKey: row.sourceKey, publisherKey: row.publisherKey, sourceExternalId: `media:${row.sourceKey}`,
    });
  }

  function selectBodyCandidates(workspaceId, limit = 40) {
    const at = now();
    const rows = mediaRepository.listEntries(workspaceId,{ limit: 10_000 });
    const rowsById=new Map(rows.map(row=>[row.externalId,row]));
    const hidden = new Set((feedRepository?.listContentItemStatesByExternalIds?.(workspaceId,'media',rows.map(row=>row.externalId)) || []).filter(row=>row.isHidden).map(row=>row.externalId));
    const discoveries = mediaRepository.listDiscoveries?.(workspaceId,rows.map(row=>row.externalId)) || [];
    const completedUrls=new Set(rows.filter(row=>row.contentLevel==='full' && row.bodyHash && row.fetchState?.fetchStatus==='ready' && row.fetchState.extractorVersion===extractorVersion && row.fetchState.fetchedRevision===row.revision)
      .map(row=>normalizeMediaUrl(row.canonicalUrl,mediaSource(row.sourceKey)?.trackingParams || [])));
    const byId = new Map();
    for (const d of discoveries) {
      const source = mediaSource(d.sourceKey);
      if (!source || !stateOf(workspaceId,source.sourceKey,at).enabled) continue;
      const previous = byId.get(d.externalId);
      if (!previous || d.lastSeenAt > previous.lastSeenAt) byId.set(d.externalId,{...d,sourceKey:source.sourceKey});
    }
    const ranked = rows.filter(row => {
      if (twkrSourceSkipsBody(row.sourceKey)) return false;
      if (row.contentLevel === 'full' && !row.fetchState?.extractorVersion) return false;
      const entry = mediaSource(row.sourceKey);
      const state = row.fetchState || {};
      if (!entry || hidden.has(row.externalId) || entry.contentAccess !== 'body' || !stateOf(workspaceId,row.sourceKey,at).enabled || row.status === 'budget_deferred') return false;
      if (row.contentLevel!=='full' && completedUrls.has(normalizeMediaUrl(row.canonicalUrl,entry.trackingParams || []))) return false;
      if (row.contentLevel === 'full' && row.bodyHash && state.fetchStatus==='ready' && state.extractorVersion === extractorVersion && state.fetchedRevision === row.revision) return false;
      if (state.fetchStatus==='policy_skipped' && ['publisher_adapter_pending','publisher_unknown'].includes(state.extractionReason) && state.extractorVersion===extractorVersion) return false;
      if (state.fetchStatus === 'failed' && (!state.nextRetryAt || state.nextRetryAt > at)) return false;
      if (state.nextRetryAt > at && !budgetCooldownRemoved(state, entry) && state.extractorVersion === extractorVersion && state.fetchedRevision === row.revision) return false;
      return true;
    }).map(row => {
      const d=byId.get(row.externalId);
      return { externalId:row.externalId,sourceKey:mediaSource(row.sourceKey).sourceKey,title:row.title,
        reason:d?.listPosition != null ? 'channel_list_order' : 'publication_order',
        firstSeenAt:d?.firstSeenAt ?? row.createdAt,listPosition:d?.listPosition ?? null,
        at:row.publishedAt,revisionCheck:row.contentLevel==='full' };
    }).sort((a,b) => Number(a.revisionCheck)-Number(b.revisionCheck) || (a.listPosition != null || b.listPosition != null
      ? b.firstSeenAt-a.firstSeenAt || (a.listPosition ?? Infinity)-(b.listPosition ?? Infinity)
      : (b.at ?? -1)-(a.at ?? -1)) || a.externalId.localeCompare(b.externalId));
    const selected = [], selectedUrls=new Set();
    const queues = new Map();
    for (const row of ranked) {
      if (!queues.has(row.sourceKey)) queues.set(row.sourceKey, []);
      queues.get(row.sourceKey).push(row);
    }
    const fair = [];
    while ([...queues.values()].some(queue => queue.length)) {
      for (const queue of queues.values()) if (queue.length) fair.push(queue.shift());
    }
    const roundCount = new Map();
    for (const row of fair) {
      if (selected.length >= limit) break;
      const source = mediaSource(row.sourceKey);
      const cap = source?.maxNewBodiesPerRound;
      if (Number.isInteger(cap) && (roundCount.get(source.sourceKey) || 0) >= cap) continue;
      const entry=rowsById.get(row.externalId);
      const url=normalizeMediaUrl(entry.canonicalUrl,source?.trackingParams || []);
      if(selectedUrls.has(url))continue;
      selectedUrls.add(url);
      if (Number.isInteger(cap)) roundCount.set(source.sourceKey, (roundCount.get(source.sourceKey) || 0) + 1);
      selected.push(row);
    }
    return selected;
  }
  function listBodyCandidates(workspaceId,limit) { return selectBodyCandidates(workspaceId,limit).map(r => r.externalId); }

  function discoverOriginals(workspaceId = 'local') {
    const at = now();
    let added = 0;
    for (const row of mediaRepository.listEntries(workspaceId, {limit: 200}).filter(r => r.contentLevel === 'discovery' && r.originUrl)) {
      const match = mediaPort?.matchOriginal?.(row);
      if (!match) continue;
      const {publisher, item} = match;
      let state = stateOf(workspaceId,publisher.sourceKey,at);
      if (publisher.transport === 'discovery' && publisher.bodyUseAcknowledged && !mediaRepository.getState(workspaceId,publisher.sourceKey)) {
        state = mediaRepository.saveState({...state,enabled:true,bodyUseAcknowledged:true,health:'ready',updatedAt:at});
      }
      if (!state.enabled || !state.bodyUseAcknowledged) continue;
      const previous = mediaRepository.getEntries(workspaceId,[item.externalId])[0];
      if (previous) continue;
      const article = incomingArticle(publisher, item);
      const duplicate = articleDedup.find(workspaceId, article, { ignoreMediaIds: [item.externalId] });
      if (duplicate) {
        articleDedup.fill(duplicate, article);
        continue;
      }
      const reservation = mediaRepository.reserveMetadata(workspaceId,dayKey(at),1,at,budget.maxNewMetadataPerDay);
      saveMediaEntry(entryRow(workspaceId,publisher,item,{at,status:reservation.allowed ? 'indexed' : 'budget_deferred'}));
      if (reservation.allowed) added++;
    }
    for (const entry of mediaPort?.publishers || []) added += acceptDeferred(workspaceId,entry,at);
    return {added};
  }

  function articleTranslationsFor(workspaceId, pairs) {
    const ready = (pairs || []).filter((pair) => pair.verifiedFull && pair.snapshot).map((pair) => ({
      externalId: pair.item.externalId,
      article: {
        externalId: pair.item.externalId,
        bodyHash: pair.snapshot.bodyHash,
        snapshotRevision: pair.snapshot.revision,
        title: pair.item.title,
        paragraphs: pair.snapshot.article?.paragraphs || [],
      },
    }));
    const units = ready.flatMap((row) => mediaTranslationUnits(row.article));
    const saved = units.length ? (feedRepository?.listTranslations?.(workspaceId, units.flatMap((unit) => [unit.id, unit.legacyId]), 'zh') || []) : [];
    const out = new Map();
    for (const row of ready) {
      const ids = new Set(mediaTranslationUnits(row.article).flatMap((unit) => [unit.id, unit.legacyId]));
      out.set(row.externalId, projectMediaTranslation(row.article, saved.filter((entry) => ids.has(entry.itemId))));
    }
    return out;
  }

  function articleTranslation(workspaceId,row,snapshot) {
    const article = {externalId:row.externalId,bodyHash:snapshot.bodyHash,snapshotRevision:snapshot.revision,title:row.title,paragraphs:snapshot.article.paragraphs || []};
    const saved = feedRepository?.listTranslations?.(workspaceId,mediaTranslationUnits(article).flatMap(u=>[u.id,u.legacyId]),'zh') || [];
    return projectMediaTranslation(article,saved);
  }

  function listArticleTranslationUnits(workspaceId,externalIds) {
    return mediaRepository.getEntries(workspaceId,externalIds).flatMap(row=>{
      const snapshot=mediaRepository.latestBodies(workspaceId,[row.externalId])[0];
      if (!snapshot || snapshot.contentLevel!=='full' || snapshot.truncated || snapshot.article.extractorVersion!==extractorVersion || row.fetchState?.fetchStatus!=='ready' || row.fetchState.fetchedRevision!==row.revision) return [];
      const units=mediaTranslationUnits({externalId:row.externalId,bodyHash:snapshot.bodyHash,title:row.title,paragraphs:snapshot.article.paragraphs});
      const saved=feedRepository?.listTranslations?.(workspaceId,units.flatMap(u=>[u.id,u.legacyId]),'zh') || [];
      const byId=new Map(saved.map(r=>[r.itemId,r]));
      const reuse=units.filter(u=>!byId.has(u.id) && byId.get(u.legacyId)?.sourceHash===sha256(u.text)).map(u=>{
        const old=byId.get(u.legacyId);return {workspaceId,itemId:u.id,targetLang:'zh',sourceHash:old.sourceHash,translatedText:old.translatedText,engine:old.engine};
      });
      if(reuse.length) feedRepository?.saveTranslations?.(reuse);
      return units.map((unit) => ({ ...unit, externalId: row.externalId }));
    });
  }

  function suspectedLegacyFull(workspaceId) {
    const rows = mediaRepository.listEntries(workspaceId,{ limit: 200 });
    const bodies = new Map(mediaRepository.latestBodies(workspaceId,rows.map(r=>r.externalId)).map(b=>[b.externalId,b]));
    return rows.filter(r => r.contentLevel === 'full' && bodies.get(r.externalId)?.article?.extractorVersion !== extractorVersion)
      .map(r => ({ externalId: r.externalId, sourceKey: r.sourceKey, bodyHash: r.bodyHash, reason: 'legacy_extractor_unverified' }));
  }
  async function generateBodyBriefs({ workspaceId = 'local', externalIds = [], briefPort, retryFailed = false } = {}) {
    const results = [];
    for (const row of mediaRepository.getEntries(workspaceId,externalIds.slice(0,24))) {
      const snapshot = mediaRepository.latestBodies(workspaceId,[row.externalId])[0];
      if (!snapshot || snapshot.bodyHash !== row.bodyHash || snapshot.contentLevel !== 'full' || snapshot.article?.extractorVersion !== extractorVersion || row.fetchState?.extractorVersion !== extractorVersion || row.fetchState?.fetchStatus !== 'ready' || row.fetchState?.fetchedRevision !== row.revision) continue;
      if (snapshot.brief?.bodyHash === snapshot.bodyHash) { results.push({ externalId: row.externalId, status: 'cached' }); continue; }
      const processing = mediaRepository.getBriefProcessing(workspaceId,row.externalId,snapshot.bodyHash);
      if (processing.status === 'failed' && !retryFailed) { results.push({externalId:row.externalId,status:'failed',reason:processing.reason});continue; }
      if (!briefPort?.generate) {
        mediaRepository.saveBriefProcessing(workspaceId,row.externalId,snapshot.bodyHash,'unavailable','model_port_unavailable',now());
        results.push({ externalId: row.externalId, status: 'unavailable' }); continue;
      }
      try {
        mediaRepository.saveBriefProcessing(workspaceId,row.externalId,snapshot.bodyHash,'running','',now());
        const value = await briefPort.generate({ title: row.title, bodyHash: snapshot.bodyHash, snapshotRevision: snapshot.revision, paragraphs: snapshot.article.paragraphs });
        const brief = MediaBriefSchema.parse({ ...value, bodyHash: snapshot.bodyHash, snapshotRevision: snapshot.revision, generatedAt: now() });
        for (const evidence of brief.evidence) {
          const p = snapshot.article.paragraphs.find(p => p.id === evidence.paragraphId);
          if (!p || !p.text.includes(evidence.quote)) throw new Error('brief evidence is not in saved paragraph');
        }
        mediaRepository.saveBrief(workspaceId,row.externalId,brief);
        mediaRepository.saveBriefProcessing(workspaceId,row.externalId,snapshot.bodyHash,'ready','',now());
        results.push({ externalId: row.externalId, status: 'ready' });
      } catch (error) {
        const timeout = /Abort|Timeout|TransportClosed/.test(error.name || '');
        const reason = timeout ? 'brief_timeout' : /evidence is not/.test(error.message) ? 'invalid_evidence' : error.name === 'ZodError' ? 'invalid_brief_schema' : error.name === 'SyntaxError' ? 'invalid_json' : 'brief_generation_failed';
        mediaRepository.saveBriefProcessing(workspaceId,row.externalId,snapshot.bodyHash,'failed',reason,now());
        results.push({ externalId: row.externalId, status: 'failed', reason });
        // A provider outage must not multiply a timeout by all remaining articles.
        if (timeout) break;
      }
    }
    return results;
  }
  function briefForContentItem(workspaceId,itemId) {
    const item = feedRepository?.getContentItem(workspaceId,itemId);
    if (!item) return null;
    const row = mediaRepository.findByUrl(workspaceId,item.sourceUrl);
    if (!row) return null;
    const snapshot = mediaRepository.latestBodies(workspaceId,[row.externalId])[0];
    if (!snapshot?.brief || snapshot.bodyHash !== sha256(item.body) || row.fetchState?.fetchStatus !== 'ready' || row.fetchState?.fetchedRevision !== row.revision) return null;
    return snapshot.brief;
  }

  function listEnrichmentItems(workspaceId, limit = 120, externalIds = []) {
    const excluded=new Set(qualityExcluded(workspaceId));
    const recent = mediaRepository.listEntries(workspaceId, { limit });
    const requested = mediaRepository.getEntries(workspaceId, externalIds);
    const rows = [...new Map([...requested, ...recent].map(row => [row.externalId, row])).values()]
      .filter((row) => row.status !== 'budget_deferred' && !excluded.has(row.externalId));
    const bodies = new Map((mediaRepository.latestBodies?.(workspaceId, rows.map((row) => row.externalId)) || [])
      .map((row) => [row.externalId, row]));
    return rows.map((row) => {
      const article = ['full','partial'].includes(row.contentLevel) ? snapshotArticleText(bodies.get(row.externalId)) : '';
      const text = mediaDisplayText({ title: row.title, summary: row.summary, body: article });
      const id = mediaResourceId(row.externalId);
      return {
        id,
        resourceId: id,
        externalId: row.externalId,
        source: row.sourceKey,
        author: row.publisherKey,
        contentLevel: row.contentLevel,
        bodyObservedAt: bodies.get(row.externalId)?.observedAt || 0,
        title: row.title,
        summary: row.summary,
        body: article || row.summary,
        text,
      };
    }).filter((item) => item.text);
  }

  function legacyHidden(workspaceId) {
    return (mediaRepository.legacyLinks?.(workspaceId) || []).filter(link=>feedRepository?.listContentItemStatesByExternalIds?.(workspaceId,link.legacyProvider,[link.legacyExternalId])?.[0]?.isHidden).map(link=>link.externalId);
  }
  return Object.freeze({
    async ingestArticles(workspaceId, articles, legacyProvider = 'trendforce', {preserveLegacyGate=false} = {}) {
      let added=0; const ids=[],externalIds=[];
      const linkLegacy=(externalId,legacyItem,item)=>{
        mediaRepository.linkLegacy(workspaceId,externalId,legacyItem.id,legacyProvider,item.externalId);
        const resourceId=mediaResourceId(externalId),saved=taggingRepository?.listTaggings?.(workspaceId,'media-index',[resourceId])?.[0];
        const prior=taggingRepository?.listTaggings?.(workspaceId,'content-item',[legacyItem.id])?.[0];
        if(prior && !saved)taggingRepository.saveTaggings({...prior,resourceType:'media-index',resourceId});
      };
      for(const input of articles) {
        const item=ImportedMediaArticleSchema.parse(input),at=item.observedAt ?? now();
        const entry=mediaSource('trendforce');if(!entry)throw new ValidationError('缺少 TrendForce 媒体配置',['sourceKey']);
        const externalId=`trendforce:${item.externalId}`;
        const previous=mediaRepository.getEntries(workspaceId,[externalId])[0];
        const legacy=feedRepository?.getCapture?.(workspaceId,legacyProvider,item.externalId);
        const legacyItem=legacy && feedRepository?.getContentItemByCaptureId?.(workspaceId,legacy.id);
        if(previous?.contentLevel==='full' && item.contentLevel!=='full') {
          if(legacyItem)mediaRepository.atomic(()=>linkLegacy(externalId,legacyItem,item));
          continue;
        }
        const row=entryRow(workspaceId,entry,{...item,externalId},{at,previous,status:'indexed'});
        row.articleKind=item.articleKind;
        const article={text:item.body || item.summary,contentLevel:item.contentLevel,paragraphs:item.paragraphs,extractorVersion:item.extractorVersion,author:'TrendForce',truncated:false};
        const bodyHash=sha256(article.text),latest=mediaRepository.latestBodies(workspaceId,[externalId])[0];
        if(previous && previous.contentHash===row.contentHash && previous.articleKind===item.articleKind && previous.contentLevel===item.contentLevel && previous.fetchState?.extractorVersion===item.extractorVersion && previous.fetchState?.fetchedRevision===previous.revision && (!['full','partial'].includes(item.contentLevel) || latest?.bodyHash===bodyHash)) {
          if(legacyItem)mediaRepository.atomic(()=>linkLegacy(externalId,legacyItem,item));
          continue;
        }
        const gate=preserveLegacyGate && legacy ? {status:legacy.status,metadata:legacy.metadata,createContentItem:false} : await evaluateMediaGate(workspaceId,row,article);
        mediaRepository.atomic(()=>{
          row.contentLevel=item.contentLevel;row.bodyHash=['full','partial'].includes(item.contentLevel)?bodyHash:'';
          row.status=row.bodyHash?'body_ready':'indexed';row.truncated=false;
          saveMediaEntry(row);mediaRepository.saveArticleKind(workspaceId,externalId,item.articleKind);
          if(row.bodyHash) {
            const revision=(mediaRepository.listSnapshots(workspaceId,externalId).at(-1)?.revision || 0)+1;
            mediaRepository.saveSnapshot({workspaceId,externalId,revision,bodyHash,bodyText:article.text,truncated:false,contentLevel:item.contentLevel,observedAt:at,article});
          }
          mediaRepository.saveFetchState(workspaceId,externalId,{...initialFetchState(),fetchStatus:item.contentLevel==='full'?'ready':item.contentLevel==='partial'?'partial':'policy_skipped',
            extractionReason:item.articleKind==='report-intro'?'report_intro':item.contentLevel==='full'?'':'source_summary',extractorVersion:item.extractorVersion,fetchedRevision:row.revision,paragraphCount:item.paragraphs.length,lastAttemptAt:at});
          if(legacyItem)linkLegacy(externalId,legacyItem,item);
          const capture=saveMediaGate(workspaceId,row,article,bodyHash,gate);
          if(!legacyItem && (!gate || gate.createContentItem) && capture) {
            const ci=feedRepository.saveContentItem({workspaceId,captureId:capture.id,originType:'subscription',contentType:'article',title:item.title,summary:item.summary,body:article.text,authorName:'TrendForce',sourceUrl:item.sourceUrl,publishedAt:item.publishedAt});ids.push(ci.id);
          }
        });
        added++;externalIds.push(externalId);
      }
      return {added,addedItemIds:ids,mediaExternalIds:externalIds};
    },
    verifiedTrendforceExternalIds(workspaceId) {return mediaRepository.listEntries(workspaceId,{limit:10000}).filter(r=>r.sourceKey==='trendforce' && r.contentLevel==='full' && r.fetchState?.fetchStatus==='ready' && r.fetchState?.extractorVersion===extractorVersion && r.fetchState?.fetchedRevision===r.revision).map(r=>r.externalId.replace(/^trendforce:/,''));},
    legacyItemIds(workspaceId) {return (mediaRepository.legacyLinks?.(workspaceId) || []).map(r=>r.contentItemId);},
    isLegacyRouted(workspaceId,id) {return (mediaRepository.legacyLinks?.(workspaceId) || []).some(r=>r.contentItemId===id);},
    dailySources(workspaceId,window) {
      const excluded=[...legacyHidden(workspaceId),...(feedRepository?.listHiddenExternalIds?.(workspaceId,'media') || []),...qualityExcluded(workspaceId)];
      const counts=mediaRepository.listWindowSources(workspaceId,{...window,hiddenExternalIds:excluded});
      const states=mediaRepository.listStates(workspaceId);
      const byKey=new Map(counts.map(r=>[r.sourceId,r]));
      for(const state of states.filter(s=>s.enabled)) if(!byKey.has(state.sourceKey)) byKey.set(state.sourceKey,{sourceId:state.sourceKey,channel:mediaSource(state.sourceKey)?.channel || 'macro',available:0});
      return [...byKey.values()].map(r=>{const s=states.find(s=>s.sourceKey===r.sourceId);return {...r,lastSyncAt:s?.lastSyncAt ?? null,status:s?.health || 'unknown',note:s?.healthDetail || ''};});
    },
    dailyMaterials(workspaceId,window) {
      const excluded=[...legacyHidden(workspaceId),...(feedRepository?.listHiddenExternalIds?.(workspaceId,'media') || []),...qualityExcluded(workspaceId)];
      const rows=window.externalIds?.length ? mediaRepository.getEntries(workspaceId,window.externalIds).filter(row=>!excluded.includes(row.externalId)) : mediaRepository.listEntriesInWindow(workspaceId,{...window,hiddenExternalIds:excluded});
      const bodies=new Map(mediaRepository.latestBodies(workspaceId,rows.map(r=>r.externalId)).map(b=>[b.externalId,b]));
      return rows.map(row=>{
        const body=bodies.get(row.externalId);
        const valid=body && body.contentLevel==='full' && !body.truncated && body.article?.extractorVersion===extractorVersion && row.fetchState?.fetchStatus==='ready' && row.fetchState?.extractorVersion===extractorVersion && row.fetchState?.fetchedRevision===row.revision;
        const partial=body && !valid && body.contentLevel==='partial';
        return {...row,eventAt:row.publishedAt ?? row.observedAt,body:valid || partial ? body : null,
          effectiveLevel:valid ? 'full' : partial ? 'partial' : row.contentLevel==='discovery' ? 'discovery' : 'summary_only',
          bodyReason:valid ? '' : row.fetchState?.extractionReason || (body ? 'saved_body_not_current_verified_full' : 'body_not_saved')};
      });
    },
    flashExternalIds(workspaceId, externalIds = []) {
      return mediaRepository.getEntries(workspaceId, externalIds)
        .filter((row) => isFlashSource({ sourceKey: row.sourceKey, publisher: row.publisherName, id: row.sourceKey }, flashSources))
        .map((row) => row.externalId);
    },
    informationCandidates(workspaceId,window) {
      const excluded=[...legacyHidden(workspaceId),...(feedRepository?.listHiddenExternalIds?.(workspaceId,'media') || []),...qualityExcluded(workspaceId)];
      return mediaRepository.informationCandidates(workspaceId,{...window,hiddenExternalIds:excluded,extractorVersion});
    },
    articleDedup,
    dedupeHourlyCandidates(workspaceId, items) {
      return articleDedup.dedupeHourlyCandidates(workspaceId, items);
    },
    catalog: () => MEDIA_SOURCES.map((entry) => ({ ...entry })),
    discoverOriginals,
    listArticleTranslationUnits,
    catalogView,
    readFeed: (query, actor = {}) => readFeed(actor.workspaceId || 'local', query || {}),
    getSavedArticle(raw, actor = {}) {
      const {externalId}=MediaSavedArticleQuerySchema.parse(raw);
      return readFeed(actor.workspaceId || 'local',{externalId,limit:1}).items[0] || null;
    },
    probe,
    enableSource: (workspaceId, sourceKey) => enableSource(workspaceId, sourceKey),
    disableSource,
    syncEnabled,
    fetchBodies,
    acknowledgeBodyUse,
    selectBodyCandidates,
    suspectedLegacyFull,
    generateBodyBriefs,
    briefForContentItem,
    listBodyCandidates,
    listEnrichmentItems,
    indexExternalItems(workspaceId, descriptor, items, at = now(), { maxNew = 40 } = {}) {
      const entry = {
        sourceKey: descriptor.sourceKey,
        publisher: descriptor.publisher || descriptor.sourceKey,
        publisherKey: descriptor.publisherKey || descriptor.sourceKey,
        channel: descriptor.channel === 'macro' ? 'macro' : 'tech',
        contentAccess: 'index',
        trackingParams: [],
      };
      let added = 0;
      const externalIds = [];
      for (const item of items || []) {
        if (!item?.externalId || !item.sourceUrl || !String(item.title || '').trim()) continue;
        if (!Number.isInteger(item.publishedAt) || item.publishedAt <= 0) continue;
        const sharedListingUrl = descriptor.format === 'twse-material';
        const previous = mediaRepository.getEntries(workspaceId, [item.externalId])[0]
          || (sharedListingUrl ? null : mediaRepository.findByUrl?.(workspaceId, item.sourceUrl))
          || null;
        const article = incomingArticle(entry, item);
        if (!previous && !sharedListingUrl) {
          const match = articleDedup.find(workspaceId, article, { ignoreMediaIds: [item.externalId] });
          if (match?.kind === 'media' && match.externalId) {
            articleDedup.fill(match, article);
            continue;
          }
        }
        if (!previous && added >= maxNew) continue;
        const row = entryRow(workspaceId, entry, { ...item, externalId: previous?.externalId || item.externalId }, {
          at,
          previous,
          status: previous?.status === 'body_ready' ? 'body_ready' : 'indexed',
        });
        if (previous && previous.contentHash === row.contentHash && previous.publishedAt === row.publishedAt) continue;
        saveMediaEntry(row);
        if (!previous) added += 1;
        externalIds.push(row.externalId);
      }
      return { added, externalIds };
    },
  });
}
