import { createHash } from 'node:crypto';
import { formatFeedBefore, ValidationError } from '../../contracts/src/index.js';
import { packFeedAiBatches } from './feed-ai-batch.js';
import { feedItemIdentityHash } from './feed-identity.js';
import { cleanIngestExcerpt } from '../../connectors/src/excerpt-text.js';
import { collectLocalizationUnits, localizationItemId, needsZhLocalization } from './localize-texts.js';

const DEFAULT_WORKSPACE_ID = 'local';
const STORED_FEED_LIMIT = 200;
const LIST_SUMMARY_MAX = 200;

function clipText(value, max = LIST_SUMMARY_MAX) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}

function firstSentence(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return (text.match(/^.+?(?:[。！？]|[.!?](?:\s|$)|…)/)?.[0] || text).trim();
}

function commentCount(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').trim().split('\n');
  const heading = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:评论(?:区|预览)?|Comments?|Replies)(?:\*\*)?\s*[：:]?\s*$/iu;
  const marker = /^\s*(?:[·•*−-]|\d+[.)、])\s+/u;
  const index = lines.findIndex((line, offset) => heading.test(line)
    && lines.slice(offset + 1).find((next) => next.trim())?.match(marker));
  if (index < 0) return 0;
  let count = 0;
  for (const line of lines.slice(index + 1)) {
    if (/^\s*\[未抓取\]/u.test(line)) break;
    if (marker.test(line)) count += 1;
  }
  return count;
}

function projectListItem(item) {
  const summary = clipText(item.normalizedArticle?.summary || item.summary || item.body);
  const translated = item.translation?.text || '';
  return {
    id: item.id,
    resourceId: item.resourceId,
    workspaceId: item.workspaceId,
    platform: item.platform,
    externalId: item.externalId,
    authorName: item.authorName || '',
    authorHandle: item.authorHandle || '',
    title: item.title || '',
    summary,
    excerpt: summary,
    sourceUrl: item.sourceUrl || '',
    publishedAt: item.publishedAt || 0,
    capturedAt: item.capturedAt || 0,
    processing: item.processing || '',
    isRead: Boolean(item.isRead),
    isSaved: Boolean(item.isSaved),
    commentCount: commentCount(item.body),
    translation: item.translation ? {
      status: translated ? 'ready' : 'stale',
      title: clipText(firstSentence(translated), 80),
      engine: item.translation.engine || '',
      targetLang: item.translation.targetLang || 'zh',
    } : null,
    normalizedArticle: item.normalizedArticle ? {
      nodeId: item.normalizedArticle.nodeId,
      title: item.normalizedArticle.title || '',
      summary: clipText(item.normalizedArticle.summary || ''),
      generatedAt: item.normalizedArticle.generatedAt,
    } : null,
    tags: item.tags || [],
    lowValue: Boolean(item.lowValue),
  };
}

function contentHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function toFeedItem(providerId, row) {
  return {
    id: `${providerId}:${row.externalId}`,
    resourceId: row.id,
    workspaceId: row.workspaceId,
    platform: providerId,
    externalId: row.externalId,
    authorName: row.authorName || '',
    authorHandle: row.captureMetadata?.authorHandle || '',
    title: row.title || '',
    summary: row.summary || '',
    body: row.body || '',
    sourceUrl: row.sourceUrl || '',
    publishedAt: row.publishedAt || 0,
    capturedAt: row.capturedAt || row.createdAt || 0,
    updatedAt: row.updatedAt || 0,
    processing: '',
    subscriptionId: '',
    captureId: row.captureId || '',
    isRead: Boolean(row.isRead),
    isSaved: Boolean(row.isSaved),
    lowValue: Boolean(row.lowValue),
    translation: null,
  };
}

function rankFeedItems(items) {
  return [...(items || [])].sort((left, right) => (
    Number(Boolean(left.isRead)) - Number(Boolean(right.isRead))
    || (Number(right.capturedAt) || 0) - (Number(left.capturedAt) || 0)
    || String(right.id).localeCompare(String(left.id))
  ));
}

function attachTranslations(feedRepository, workspaceId, items, targetLang = 'zh') {
  if (!items.length || !feedRepository?.listTranslations) return items;
  const ids = [];
  for (const item of items) {
    if (item?.id) ids.push(item.id);
    if (item?.resourceId) ids.push(item.resourceId);
  }
  const rows = feedRepository.listTranslations(workspaceId, ids, targetLang) || [];
  if (!rows.length) return items;
  const byId = new Map(rows.map((row) => [row.itemId, row]));
  return items.map((item) => {
    const row = byId.get(item.id) || (item.resourceId ? byId.get(item.resourceId) : null);
    if (!row || row.sourceHash !== contentHash(item.body || '')) {
      return { ...item, translation: null };
    }
    return {
      ...item,
      translation: {
        text: row.translatedText,
        engine: row.engine || '',
        targetLang: row.targetLang,
      },
    };
  });
}

function persistTranslations(feedRepository, workspaceId, translations) {
  if (!feedRepository?.saveTranslations || !Array.isArray(translations)) return;
  const records = [];
  for (const row of translations) {
    if (!row?.id || !row.translatedText || row.engine === 'passthrough') continue;
    records.push({
      workspaceId,
      itemId: row.id,
      targetLang: row.targetLang === 'en' ? 'en' : 'zh',
      sourceHash: contentHash(row.sourceText || ''),
      translatedText: row.translatedText,
      engine: row.engine || '',
    });
  }
  if (records.length) feedRepository.saveTranslations(records);
}

const localizeLocks = new Map();

function translationMap(rows = []) {
  return new Map((rows || []).map((row) => [row.itemId, row]));
}

function failureMap(rows = []) {
  return new Map((rows || []).map((row) => [row.itemId, row]));
}

function hourlySourceIds(unit) {
  const ids = [unit.id, unit.localizationId];
  const raw = String(unit.id || '');
  if (raw && !raw.includes(':')) ids.push(`official:${raw}`, `media:${raw}`, `feed:${raw}`);
  return [...new Set(ids.filter(Boolean))];
}

function projectLocalizations(units, byItemId, failures = new Map(), now = Date.now()) {
  const localizations = {};
  for (const unit of units) {
    const row = byItemId.get(unit.localizationId);
    const hash = contentHash(unit.text);
    const ready = Boolean(row && row.sourceHash === hash && row.translatedText);
    const failure = failures.get(unit.localizationId);
    const failed = !ready && failure && failure.sourceHash === hash
      && (failure.nextRetryAt == null || failure.nextRetryAt > now);
    const pending = needsZhLocalization(unit.text) && !ready && !failed;
    localizations[unit.id] = {
      id: unit.localizationId,
      text: ready ? row.translatedText : '',
      pending,
      status: ready || !needsZhLocalization(unit.text) ? 'ready' : failed ? 'failed' : 'pending',
      retryAt: failed ? (failure.nextRetryAt ?? null) : null,
      engine: ready ? (row.engine || '') : '',
      sourceText: unit.text,
    };
  }
  return localizations;
}

function projectionFor(feedRepository, workspaceId, units, targetLang, now = Date.now()) {
  const ids = units.map((unit) => unit.localizationId);
  const existing = translationMap(feedRepository?.listTranslations?.(workspaceId, ids, targetLang));
  const failures = failureMap(feedRepository?.listTranslationFailures?.(workspaceId, ids, targetLang));
  const localizations = projectLocalizations(units, existing, failures, now);
  return {
    localizations,
    pendingIds: units.filter((unit) => localizations[unit.id]?.pending).map((unit) => unit.id),
  };
}

function adoptReusableTranslations(feedRepository, workspaceId, units, targetLang, hourlyTitles) {
  if (!units?.length || !feedRepository?.saveTranslations) return false;
  const adopted = [];
  const taken = new Set();
  if (typeof hourlyTitles === 'function') {
    let titles = new Map();
    try { titles = hourlyTitles([...new Set(units.flatMap(hourlySourceIds))]) || new Map(); } catch { titles = new Map(); }
    for (const unit of units) {
      const title = hourlySourceIds(unit).map((id) => titles.get?.(id)).find(Boolean);
      if (!title) continue;
      adopted.push({
        id: unit.localizationId,
        sourceText: unit.text,
        translatedText: String(title),
        targetLang,
        engine: 'hourly-report',
      });
      taken.add(unit.localizationId);
    }
  }
  const rest = units.filter((unit) => !taken.has(unit.localizationId));
  if (rest.length && feedRepository.listTranslationsByHash) {
    const rows = feedRepository.listTranslationsByHash(workspaceId, rest.map((unit) => contentHash(unit.text)), targetLang) || [];
    const byHash = new Map();
    for (const row of rows) {
      if (!row.translatedText || row.engine !== 'hourly-report' || byHash.has(row.sourceHash)) continue;
      byHash.set(row.sourceHash, row);
    }
    for (const unit of rest) {
      const row = byHash.get(contentHash(unit.text));
      if (!row?.translatedText) continue;
      adopted.push({
        id: unit.localizationId,
        sourceText: unit.text,
        translatedText: row.translatedText,
        targetLang,
        engine: String(row.engine || 'reused').slice(0, 32),
      });
    }
  }
  if (!adopted.length) return false;
  persistTranslations(feedRepository, workspaceId, adopted);
  return true;
}

async function translatePendingUnits(translationPort, pending, targetLang, checkpoint=()=>{}) {
  if (!pending.length || !translationPort) return [];
  const packed = packFeedAiBatches(pending.map((unit) => ({
    id: unit.localizationId,
    text: unit.text,
  })), {
    purpose: 'translate',
    charBudget: 80_000,
    itemClipChars: 20_000,
    itemLimit: pending.length,
  });
  const originals = new Map(pending.map((unit) => [unit.localizationId, unit.text]));
  const truncated=new Set(packed.batches.flatMap(batch=>batch.units.filter(u=>u.truncatedForModel).map(u=>u.itemId)));
  const translations = [];
  async function translateChunk(items) {
    if (translationPort.translateMany) {
      return translationPort.translateMany({ items, targetLang });
    }
    if (!translationPort.translate) return { translations: [] };
    const rows = [];
    for (const item of items) {
      const translation = await translationPort.translate({
        text: item.text,
        targetLang,
      });
      rows.push({ id: item.id, ...translation });
      checkpoint([{id:item.id,...translation,sourceText:originals.get(item.id)}]);
    }
    return { translations: rows, targetLang };
  }
  for (const batch of packed.batches) {
    const chunk = batch.units.filter(unit=>!truncated.has(unit.itemId)).map((unit) => ({ id: unit.itemId, text: unit.text }));
    if(!chunk.length)continue;
    const result = await translateChunk(chunk);
    const completed=[];
    for (const row of result.translations || []) {
      if(!originals.has(row.id))continue;
      completed.push({
        ...row,
        sourceText: originals.get(row.id) || row.sourceText,
      });
    }
    translations.push(...completed);
    if(translationPort.translateMany)checkpoint(completed);
  }
  return translations;
}

async function localizeCollected(feedRepository, translationPort, workspaceId, units, targetLang, options = {}) {
  const unique = [];
  const seen = new Set();
  for (const unit of units || []) {
    if (!unit?.id || !unit.localizationId || !unit.text || seen.has(unit.id)) continue;
    seen.add(unit.id);
    unique.push(unit);
  }
  const preview = projectionFor(feedRepository, workspaceId, unique, targetLang);
  const reusable = unique.filter((unit) => preview.localizations[unit.id]?.pending);
  if (reusable.length) adoptReusableTranslations(feedRepository, workspaceId, reusable, targetLang, options.hourlyTitles);
  const current = projectionFor(feedRepository, workspaceId, unique, targetLang);
  const pending = unique.filter((unit) => current.localizations[unit.id]?.pending);
  if (!pending.length || !translationPort || options.wait === false) {
    return { localizations: current.localizations, pendingIds: pending.map((unit) => unit.id) };
  }

  const lockKey = `${workspaceId}:${targetLang}:${pending.map((unit) => unit.localizationId).sort().join(',')}`;
  const run = async () => {
    try {
      await translatePendingUnits(translationPort, pending, targetLang, rows=>persistTranslations(feedRepository,workspaceId,rows));
    } catch {
      // 已成功的批次留在库里，没译完的仍是 pending，下次调用接着补。
      // 任务级失败由 Job Runner 写入 feed_translation_failures，这里不把整批打成退避失败。
    }
    return projectionFor(feedRepository, workspaceId, unique, targetLang);
  };

  const existingLock = localizeLocks.get(lockKey);
  const task = existingLock || run().finally(() => localizeLocks.delete(lockKey));
  if (!existingLock) localizeLocks.set(lockKey, task);
  return task;
}

async function localizeFeedItems(feedRepository, translationPort, workspaceId, items, targetLang = 'zh', options = {}) {
  const units = (items || [])
    .filter((item) => item?.id && needsZhLocalization(item.body || item.summary || ''))
    .map((item) => ({
      id: item.id,
      localizationId: localizationItemId(item.id),
      text: item.body || item.summary || '',
    }));
  if (!units.length) return items;
  await localizeCollected(feedRepository, translationPort, workspaceId, units, targetLang, {
    wait: options.wait !== false,
  });
  return attachTranslations(feedRepository, workspaceId, items, targetLang);
}

async function resolveIngestFilter(feedFilter, input) {
  if (!feedFilter?.evaluate) {
    return { action: 'keep', createContentItem: true, status: 'ready', metadata: {} };
  }
  return feedFilter.evaluate(input);
}

async function ingestExternalItems(feedRepository, workspaceId, persistence, snapshot, feedFilter) {
  if (!feedRepository?.saveCapture || !Array.isArray(snapshot?.items) || !snapshot.items.length) {
    return { added: 0, skipped: 0, addedItemIds: [] };
  }
  const providerId = persistence.providerId;
  const sourceMeta = persistence.sourceAccount;
  const replay = sourceMeta.metadata && typeof sourceMeta.metadata === 'object' && !Array.isArray(sourceMeta.metadata)
    ? sourceMeta.metadata
    : {};
  const source = feedRepository.upsertSourceAccount({
    workspaceId,
    provider: providerId,
    externalId: sourceMeta.externalId,
    handle: '',
    displayName: sourceMeta.displayName,
    profileUrl: sourceMeta.profileUrl,
    authMode: ['public', 'credential', 'browser-session'].includes(sourceMeta.authMode)
      ? sourceMeta.authMode
      : 'browser-session',
    metadata: replay,
  });
  if (replay.autoRefresh === true && typeof feedRepository.ensureSubscription === 'function') {
    const interval = Number(persistence.refreshIntervalMinutes);
    feedRepository.ensureSubscription({
      workspaceId,
      sourceAccountId: source.id,
      enabled: true,
      ...(Number.isInteger(interval) && interval >= 1 ? { refreshIntervalMinutes: interval } : {}),
    });
  }
  let added = 0;
  let skipped = 0;
  const addedItemIds = [];
  const hiddenExternalIds = new Set(feedRepository.listHiddenExternalIds?.(workspaceId, providerId) || []);
  const batchCapturedAt = Number(snapshot.fetchedAt) > snapshot.items.length
    ? Number(snapshot.fetchedAt)
    : Date.now();
  for (const [index, item] of snapshot.items.entries()) {
    if (!item.externalId || !item.sourceUrl) continue;
    const identityHash = feedItemIdentityHash(providerId, item);
    const rememberFingerprint = (hiddenAt) => {
      feedRepository.upsertIdentityFingerprint?.({
        workspaceId,
        provider: providerId,
        identityHash,
        externalId: String(item.externalId),
        ...(hiddenAt === undefined ? {} : { hiddenAt }),
      });
    };
    if (hiddenExternalIds.has(String(item.externalId))
      || feedRepository.isIdentityHidden?.(workspaceId, providerId, {
        identityHash,
        externalId: String(item.externalId),
      })) {
      rememberFingerprint(Date.now());
      skipped += 1;
      continue;
    }
    const originalText = item.originalText || item.body || '';
    const hash = contentHash(`${item.externalId}\n${originalText}\n${item.body || ''}`);
    const existing = feedRepository.getCapture?.(workspaceId, providerId, item.externalId);
    const existingByContentHash = feedRepository.getCaptureByContentHash?.(workspaceId, providerId, hash);
    const hasIdentityFingerprint = Boolean(
      feedRepository.hasIdentityFingerprint?.(workspaceId, providerId, identityHash),
    );
    if (existing) {
      const linked = feedRepository.getContentItemByCapture?.(workspaceId, existing.id)
        || feedRepository.getContentItemByCaptureId?.(workspaceId, existing.id);
      if (linked && feedRepository.isContentHidden?.(workspaceId, linked.id)) {
        rememberFingerprint(Date.now());
        skipped += 1;
        continue;
      }
      if (existing.contentHash === hash) {
        rememberFingerprint();
        skipped += 1;
        continue;
      }
    } else if (hasIdentityFingerprint) {
      rememberFingerprint();
      skipped += 1;
      continue;
    }
    const filterInput = {
      workspaceId,
      provider: providerId,
      item,
      originalText,
      contentHash: hash,
      identityHash,
      existingCapture: existing || null,
      existingByContentHash: existingByContentHash || null,
      hasIdentityFingerprint: existing ? false : hasIdentityFingerprint,
    };
    let verdict = await resolveIngestFilter(feedFilter, filterInput);
    const linked = existing
      ? (feedRepository.getContentItemByCapture?.(workspaceId, existing.id)
        || feedRepository.getContentItemByCaptureId?.(workspaceId, existing.id))
      : null;
    if (verdict.action === 'skip') {
      rememberFingerprint();
      skipped += 1;
      continue;
    }
    if (verdict.action === 'ignore' && linked && verdict.metadata?.filterRule!=='all-three-0.60') {
      verdict = { ...verdict, action: 'keep', createContentItem: true, status: 'ready' };
    }
    const capture = feedRepository.saveCapture({
      workspaceId,
      provider: providerId,
      externalId: String(item.externalId),
      sourceAccountId: source.id,
      sourceUrl: item.sourceUrl,
      title: cleanIngestExcerpt(item.title || ''),
      contentHash: hash,
      rawArtifactPath: null,
      status: verdict.status || 'ready',
      publishedAt: item.publishedAt || null,
      capturedAt: Math.max(0, batchCapturedAt - index),
      metadata: {
        originalText,
        ...(item.formatEngine ? { formatEngine: item.formatEngine } : {}),
        ...(item.authorHandle ? { authorHandle: item.authorHandle } : {}),
        ...(verdict.metadata || {}),
      },
    });
    if (!verdict.createContentItem) {
      rememberFingerprint();
      skipped += 1;
      continue;
    }
    const savedItem = feedRepository.saveContentItem({
      workspaceId,
      captureId: capture.id,
      originType: item.originType || 'subscription',
      contentType: item.contentType || 'post',
      title: cleanIngestExcerpt(item.title || ''),
      body: item.body || '',
      summary: cleanIngestExcerpt(item.summary || ''),
      sourceUrl: item.sourceUrl,
      authorName: item.authorName || '',
      publishedAt: item.publishedAt || null,
    });
    if (savedItem?.id) addedItemIds.push(savedItem.id);
    rememberFingerprint();
    added += 1;
  }
  return { added, skipped, addedItemIds: [...new Set(addedItemIds)] };
}

function readStoredFeed(feedRepository, workspaceId, persistence, query, extra = {}) {
  const providerId = persistence.providerId;
  const feed = query.feed || 'for-you';
  const requested = Number(query.limit);
  const pageLimit = Number.isInteger(requested) && requested > 0 ? Math.min(50, requested) : STORED_FEED_LIMIT;
  const pageQuery = {
    sourceExternalId: persistence.sourceAccount.externalId,
    taggedOnly: false,
    qualityRule: extra.qualityRule || '',
    includeLowValue: Boolean(extra.includeLowValue),
    before: query.before || null,
    savedOnly: Boolean(query.saved),
  };
  const rows = feedRepository.listContentItemsByProvider?.(workspaceId, providerId, {
    ...pageQuery,
    limit: pageLimit + 1,
  }) || [];
  const hasMore = rows.length > pageLimit;
  const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;
  const items = rankFeedItems(pageRows.map((row) => toFeedItem(providerId, row)));
  const counted = feedRepository.countContentItemsByProvider?.(workspaceId, providerId, pageQuery);
  const total = Number.isInteger(counted) ? counted : pageRows.length;
  const last = pageRows[pageRows.length - 1];
  return {
    platform: providerId,
    workspaceId,
    feed,
    handle: '',
    source: 'source-account',
    mode: items.length ? 'cached' : (extra.mode || 'empty'),
    tweetCount: total,
    total,
    nextCursor: hasMore && last?.id ? formatFeedBefore(last.isRead, last.capturedAt, last.id) : null,
    fetchedAt: extra.fetchedAt || Date.now(),
    note: extra.note || (total
      ? `已缓存 ${total} 条，来自 SourceAccount`
      : (persistence.emptyNote || '还没有缓存。刷新后会写入来源并去重保留。')),
    added: extra.added || 0,
    skipped: extra.skipped || 0,
    items,
  };
}

function searchTerms(query) {
  return String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

function searchStoredItems(feedRepository, workspaceId, query, limit, qualityRule) {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const rows = feedRepository.listContentItems(workspaceId, { limit: STORED_FEED_LIMIT, qualityRule }) || [];
  return rows.map((item) => {
    const searchable = [item.title, item.summary, item.body, item.authorName].join('\n').toLocaleLowerCase();
    const score = terms.reduce((total, term) => total + (searchable.includes(term) ? 1 : 0), 0);
    return { item, score };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score
      || (right.item.createdAt || right.item.publishedAt) - (left.item.createdAt || left.item.publishedAt))
    .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)))
    .map(({ item }) => item);
}

function knownExternalIds(feedRepository, workspaceId, providerId) {
  const ids = [
    ...(feedRepository.listCaptureExternalIds?.(workspaceId, providerId) || []),
    ...(feedRepository.listHiddenExternalIds?.(workspaceId, providerId) || []),
    ...(feedRepository.listIdentityExternalIds?.(workspaceId, providerId) || []),
  ];
  return [...new Set(ids.map((id) => String(id || '')).filter(Boolean))];
}

function wrapFeedProviders(feedProviders) {
  if (!feedProviders || typeof feedProviders.get !== 'function') return null;
  return {
    findByProvider(providerId, viewKind) {
      if (viewKind && viewKind !== 'content-feed') return null;
      if (!feedProviders.get(providerId)) return null;
      return { id: `content.${providerId}` };
    },
    persistence(sourceId) {
      const providerId = String(sourceId || '').replace(/^content\./, '');
      return {
        providerId,
        emptyNote: '还没有缓存。',
        sourceAccount: {
          externalId: `${providerId}:default`,
          displayName: providerId,
          profileUrl: `https://${providerId}.example`,
          authMode: 'none',
        },
      };
    },
    async read(sourceId, query = {}, context = {}) {
      const providerId = String(sourceId || '').replace(/^content\./, '');
      const provider = feedProviders.get(providerId);
      const data = await provider.getFeed({
        ...query,
        refresh: Boolean(context.refresh),
        bypassCache: Boolean(context.refresh),
        excludeExternalIds: context.excludeExternalIds,
      });
      return { data };
    },
  };
}

export function createFeedService({ legacyRepository, feedRepository, sourcePort, feedProviders, translationPort, feedFilter = null, mediaPort = null, contentRoutingPort = null,onContentReady=null,normalizedArticlePort=null,taggingRepository=null }) {
  const resolvedSourcePort = sourcePort || wrapFeedProviders(feedProviders);
  if (!legacyRepository || !feedRepository || !resolvedSourcePort) throw new Error('feed repositories and source port are required');
  sourcePort = resolvedSourcePort;
  const qualityRule=feedFilter?.config?.mode==='enforce' && feedFilter.config.rule==='all-three-0.60'?'all-three-0.60':'';

  const attachNormalizedArticle=(workspaceId,item)=>{
    if(!normalizedArticlePort || !item)return item;
    const id=item.resourceId || item.id;
    const original=feedRepository.getContentItem(workspaceId,id);
    const article=original && normalizedArticlePort.normalizedArticle(workspaceId,`feed:${id}`,original.updatedAt);
    return {...item,normalizedArticle:article || null,processing:!article && needsZhLocalization(item.body || '') ? 'ai' : item.processing || ''};
  };
  const contentOriginals=(workspaceId,items)=>{
    const ids=[...new Set(items.map(item=>item.resourceId || item.id).filter(Boolean))];
    if(!ids.length) return new Map();
    if(feedRepository.listContentItemsWithSource) {
      const rows=feedRepository.listContentItemsWithSource(workspaceId,{ids,limit:ids.length,qualityRule}) || [];
      return new Map(rows.map(row=>[row.id,row]));
    }
    return new Map(ids.map(id=>[id,feedRepository.getContentItem(workspaceId,id)]).filter(([,row])=>row));
  };
  const attachNormalizedArticles=(workspaceId,items)=>{
    if(!normalizedArticlePort || !items.length) return items;
    if(typeof normalizedArticlePort.normalizedArticles==='function') {
      const originals=contentOriginals(workspaceId,items);
      const specs=items.map(item=>{
        const id=item.resourceId || item.id;
        const sourceVersion=originals.get(id)?.updatedAt;
        return sourceVersion ? {sourceId:`feed:${id}`,sourceVersion} : null;
      }).filter(Boolean);
      const found=normalizedArticlePort.normalizedArticles(workspaceId,specs);
      return items.map(item=>{
        const id=item.resourceId || item.id;
        const article=found.get(`feed:${id}`) || null;
        return {...item,normalizedArticle:article,processing:!article && needsZhLocalization(item.body || '') ? 'ai' : item.processing || ''};
      });
    }
    return items.map(item=>attachNormalizedArticle(workspaceId,item));
  };
  const presentFeed=(feed,shape,workspaceId)=>{
    if(shape!=='list') return feed;
    const items=(feed.items || []).map(projectListItem);
    if(taggingRepository?.listTaggings && items.length) {
      const ids=items.map(item=>item.resourceId).filter(Boolean);
      const rows=taggingRepository.listTaggings(workspaceId,'content-item',ids) || [];
      const tags=new Map(rows.map(row=>[row.resourceId,row.tags]));
      for(const item of items) item.tags=tags.get(item.resourceId) || [];
    }
    return {...feed,items};
  };
  const localizeForReading=async(workspaceId,items,options={})=>normalizedArticlePort
    ? attachNormalizedArticles(workspaceId,attachTranslations(feedRepository,workspaceId,items))
    : localizeFeedItems(feedRepository,translationPort,workspaceId,items,'zh',options);
  return Object.freeze({
    listLegacyPosts(limit) {
      return legacyRepository.listPosts(limit);
    },
    getLegacyPost(id) {
      return legacyRepository.getPost(id);
    },
    createLegacyPost(input, actor = {}) {
      const post = legacyRepository.createPost(input, actor.deviceId || null);
      legacyRepository.recordBehavior('post.created', actor.deviceId || null, { postId: post.id });
      return post;
    },
    async getExternalFeed(providerId, query, actor = {}) {
      if(providerId==='trendforce' && contentRoutingPort && !query?.refresh) {
        const listFields = query?.fields === 'list';
        return mediaPort.readFeed({
          channel:'tech',
          sourceKey:'trendforce',
          view:'all',
          fields: listFields ? 'list' : 'full',
          ...(Number(query?.limit) > 0 ? { limit: query.limit } : {}),
          ...(query?.before ? { before: query.before } : {}),
        },{workspaceId:actor.workspaceId || DEFAULT_WORKSPACE_ID});
      }
      if (providerId === 'media') {
        if (!mediaPort?.readFeed) throw new ValidationError('尚未启用 media 信息源', ['platform']);
        const workspaceId = actor.workspaceId || DEFAULT_WORKSPACE_ID;
        const channel = query?.channel || query?.feed || 'tech';
        return mediaPort.readFeed({ ...query, channel }, { workspaceId });
      }
      const source = sourcePort.findByProvider(providerId, 'content-feed');
      if (!source) throw new ValidationError(`尚未启用 ${providerId} 信息源`, ['platform']);
      const { platform: _platform, refresh: _refresh, before, fields: _fields, saved, ...sourceInput } = query || {};
      const persistence = sourcePort.persistence(source.id, sourceInput);
      if (!persistence?.sourceAccount) throw new ValidationError(`${source.id} 未声明 Feed 持久化投影`, ['sourceId']);
      const workspaceId = actor.workspaceId || DEFAULT_WORKSPACE_ID;
      const shape = query?.fields === 'list' ? 'list' : 'full';
      const pageQuery = { ...sourceInput, before: before || null, saved: Boolean(saved) };
      if (!query?.refresh) {
        const stored = readStoredFeed(feedRepository, workspaceId, persistence, pageQuery,{qualityRule, includeLowValue:true});
        stored.items = rankFeedItems(await localizeForReading(workspaceId,stored.items,{wait:false}));
        return presentFeed(stored, shape, workspaceId);
      }
      const sourceSnapshot = await sourcePort.read(contentRoutingPort && providerId==='trendforce' ? 'content.trendforce.collection' : source.id, sourceInput, {
        refresh: true,
        workspaceId,
        excludeExternalIds: contentRoutingPort && providerId==='trendforce'?contentRoutingPort.knownFullArticleIds(workspaceId):knownExternalIds(feedRepository, workspaceId, providerId),
      });
      const snapshot = sourceSnapshot.data;
      let stats = { added: 0, skipped: 0 };
      try {
        stats = contentRoutingPort && providerId==='trendforce' ? await contentRoutingPort.ingest(workspaceId,snapshot) : await ingestExternalItems(feedRepository, workspaceId, persistence, snapshot, feedFilter);
      } catch (error) {
        if(contentRoutingPort && providerId==='trendforce') throw error;
        // Live snapshot still returns even if persistence fails.
      }
      if(stats.addedItemIds?.length)await onContentReady?.({workspaceId,sourceIds:stats.addedItemIds.map(id=>`feed:${id}`)});
      if(contentRoutingPort && providerId==='trendforce')return {...mediaPort.readFeed({channel:'tech',sourceKey:'trendforce',view:'all'},{workspaceId}),added:stats.added,mediaExternalIds:stats.mediaExternalIds || []};
      const stored = readStoredFeed(feedRepository, workspaceId, persistence, pageQuery, {
        qualityRule,
        includeLowValue: true,
        fetchedAt: snapshot.fetchedAt,
        added: stats.added,
        skipped: stats.skipped,
      });
      stored.items = rankFeedItems(await localizeForReading(workspaceId,stored.items));
      const hiddenExternalIds = new Set(feedRepository.listHiddenExternalIds?.(workspaceId, providerId) || []);
      stored.items = stored.items.filter((item) => !hiddenExternalIds.has(String(item.externalId || '')));
      const total = Number.isInteger(stored.total) ? stored.total : stored.items.length;
      const visibleSnapshotItems = (snapshot.items || []).filter((item) => {
        const externalId = String(item.externalId || '');
        if (hiddenExternalIds.has(externalId)) return false;
        const identityHash = feedItemIdentityHash(providerId, item);
        if (feedRepository.isIdentityHidden?.(workspaceId, providerId, { identityHash, externalId })) return false;
        if (feedRepository.hasIdentityFingerprint?.(workspaceId, providerId, identityHash)) return false;
        return true;
      });
      if ((snapshot.mode === 'error' || snapshot.mode === 'unavailable') && !total) {
        return { ...snapshot, source: snapshot.source, items: [] };
      }
      return presentFeed({
        ...stored,
        mode: snapshot.mode === 'error' && total ? 'cached' : (snapshot.mode === 'live' ? 'live' : stored.mode),
        loggedIn: snapshot.loggedIn,
        note: snapshot.mode === 'unavailable'
          ? (total ? `${snapshot.note} · 仍显示已缓存 ${total} 条` : snapshot.note)
          : snapshot.mode === 'error' && total
            ? `${snapshot.note} · 仍显示已缓存 ${total} 条`
            : `${snapshot.note || '已拉取'} · 新增 ${stats.added} · 去重 ${stats.skipped} · 共 ${total} 条`,
        items: stored.items.length || qualityRule ? stored.items : visibleSnapshotItems,
      }, shape, workspaceId);
    },
    async refreshPersistedSource({ workspaceId = DEFAULT_WORKSPACE_ID, sourceId, sourceInput } = {}) {
      if (!sourceId || !sourceInput || typeof sourceInput !== 'object' || Array.isArray(sourceInput)) {
        throw new ValidationError('来源缺少可重放参数', ['sourceId']);
      }
      const persistence = sourcePort.persistence(sourceId, sourceInput);
      if (!persistence?.sourceAccount) {
        throw new ValidationError(`${sourceId} 未声明 Feed 持久化投影`, ['sourceId']);
      }
      const sourceSnapshot = await sourcePort.read(contentRoutingPort && persistence.providerId==='trendforce' ? 'content.trendforce.collection' : sourceId, sourceInput, {
        refresh: true,workspaceId,
        excludeExternalIds: contentRoutingPort && persistence.providerId==='trendforce'?contentRoutingPort.knownFullArticleIds(workspaceId):knownExternalIds(feedRepository, workspaceId, persistence.providerId),
      });
      const snapshot = sourceSnapshot?.data || {};
      if (snapshot.mode === 'error' || snapshot.mode === 'unavailable') {
        throw new Error(snapshot.note || `${sourceId} 抓取失败`);
      }
      const stats=await (contentRoutingPort && persistence.providerId==='trendforce' ? contentRoutingPort.ingest(workspaceId,snapshot) : ingestExternalItems(feedRepository, workspaceId, persistence, snapshot, feedFilter));
      if(stats.addedItemIds?.length)await onContentReady?.({workspaceId,sourceIds:stats.addedItemIds.map(id=>`feed:${id}`)});
      return stats;
    },
    listContentItems(workspaceId, page) {
      return feedRepository.listContentItems(workspaceId, {...page,qualityRule});
    },
    listContentItemsInWindow(workspaceId, window) {
      return feedRepository.listContentItemsInWindow(workspaceId, {...window,qualityRule,excludedItemIds:contentRoutingPort?.routedItemIds?.(workspaceId) || []});
    },
    listWindowSources(workspaceId, window) {
      return feedRepository.listWindowSources(workspaceId, {...window,qualityRule,excludedItemIds:contentRoutingPort?.routedItemIds?.(workspaceId) || []});
    },
    listTaggableItems(workspaceId, { limit = 200, ids = [] } = {}) {
      const rows = feedRepository.listContentItemsWithSource
        ? feedRepository.listContentItemsWithSource(workspaceId, { limit, ids,qualityRule })
        : feedRepository.listContentItems(workspaceId, { limit,qualityRule });
      return rows.map((row) => ({
        id: row.id,
        source: row.provider || '',
        author: row.authorName || '',
        title: row.title || '',
        summary: row.summary || '',
        body: row.body || '',
      }));
    },
    getContentItem(workspaceId, id) {
      return feedRepository.getContentItem(workspaceId, id);
    },
    getLocalizedContentItem(workspaceId, id) {
      const item = feedRepository.getContentItem(workspaceId, id);
      if (!item) return null;
      const ids = [item.id];
      if (item.provider && item.externalId) ids.push(`${item.provider}:${item.externalId}`);
      const rows = feedRepository.listTranslations?.(workspaceId, ids, 'zh') || [];
      const hash = contentHash(item.body || '');
      const row = rows.find((entry) => entry.sourceHash === hash && entry.translatedText);
      return attachNormalizedArticle(workspaceId,{
        ...item,
        translation: row?.translatedText
          ? { text: row.translatedText, engine: row.engine || '', targetLang: row.targetLang || 'zh' }
          : null,
      });
    },
    getOriginalContent(workspaceId, id) {
      const requested = String(id || '').trim();
      if (!requested) return null;
      let row = feedRepository.getContentItem?.(workspaceId, requested);
      if (!row && requested.includes(':')) {
        const split = requested.indexOf(':');
        const capture = feedRepository.getCapture?.(workspaceId, requested.slice(0, split), requested.slice(split + 1));
        if (capture?.id) row = feedRepository.getContentItemByCaptureId?.(workspaceId, capture.id);
      }
      if (!row) return null;
      const rawText = String(row.captureMetadata?.originalText || row.body || '').trim();
      return {
        id: row.id,
        feedItemId: row.provider && row.externalId ? `${row.provider}:${row.externalId}` : '',
        title: row.title || '',
        body: row.body || '',
        summary: row.summary || '',
        sourceUrl: row.sourceUrl || '',
        rawText: rawText || row.body || '',
        provider: row.provider || '', externalId: row.externalId || '',
        contentLevel: row.captureMetadata?.contentLevel || 'summary_only',
        hardwareSnapshot: contentRoutingPort?.legacySnapshot?.(workspaceId,row.id) || null,
      };
    },
    listContentItemsByIds(workspaceId, ids = []) {
      const wanted = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
      if (!wanted.length) return [];
      if (feedRepository.listContentItemsWithSource) {
        return feedRepository.listContentItemsWithSource(workspaceId, { ids: wanted, limit: wanted.length });
      }
      return wanted.map((id) => feedRepository.getContentItem(workspaceId, id)).filter(Boolean);
    },
    searchContentItems(workspaceId, query, { limit = 8 } = {}) {
      return searchStoredItems(feedRepository, workspaceId, query, limit, qualityRule);
    },
    upsertSourceAccount(input) {
      return feedRepository.upsertSourceAccount(input);
    },
    upsertSubscription(input) {
      return feedRepository.upsertSubscription(input);
    },
    listDueSubscriptions(now, limit) {
      return feedRepository.listDueSubscriptions(now, limit);
    },
    async translate(input, actor = {}) {
      if (!translationPort?.translate) throw new ValidationError('尚未配置翻译', ['text']);
      const translation = await translationPort.translate(input);
      if (input.id) {
        persistTranslations(feedRepository, actor.workspaceId || DEFAULT_WORKSPACE_ID, [{
          id: input.id,
          ...translation,
        }]);
      }
      return translation;
    },
    async translateMany(input, actor = {}) {
      const workspaceId = actor.workspaceId || DEFAULT_WORKSPACE_ID;
      const targetLang = input.targetLang || 'zh';
      adoptReusableTranslations(feedRepository, workspaceId, (input.items || []).map((item) => ({
        id: item.id,
        localizationId: item.id,
        text: item.text,
      })), targetLang, normalizedArticlePort?.hourlyTitles
        ? (ids) => normalizedArticlePort.hourlyTitles(workspaceId, ids)
        : null);
      const stored = translationMap(feedRepository.listTranslations?.(workspaceId, input.items.map(item => item.id), targetLang));
      const translations = [];
      const pending = input.items.filter(item => {
        const row = stored.get(item.id);
        if (row?.sourceHash !== contentHash(item.text) || !row.translatedText) return true;
        translations.push({ id: item.id, sourceText: item.text, translatedText: row.translatedText, targetLang, engine: row.engine, cached: true });
        return false;
      });
      const packed = packFeedAiBatches(pending, {
        purpose: 'translate',
        charBudget: 80_000,
        itemClipChars: 20_000,
        itemLimit: 30,
      });
      const originals = new Map((input.items || []).map((item) => [item.id, item.text]));
      async function translateChunk(items) {
        if (translationPort?.translateMany) {
          return translationPort.translateMany({ items, targetLang: input.targetLang });
        }
        if (!translationPort?.translate) throw new ValidationError('尚未配置翻译', ['items']);
        const rows = [];
        for (const item of items) {
          const translation = await translationPort.translate({
            text: item.text,
            targetLang: input.targetLang,
          });
          rows.push({ id: item.id, ...translation });
        }
        return { translations: rows, targetLang: input.targetLang };
      }
      for (const batch of packed.batches) {
        const chunk = batch.units.map((unit) => ({ id: unit.itemId, text: unit.text }));
        const result = await translateChunk(chunk);
        const completed = [];
        for (const row of result.translations || []) {
          if (!originals.has(row.id)) continue;
          completed.push({
            ...row,
            sourceText: originals.get(row.id) || row.sourceText,
          });
        }
        persistTranslations(feedRepository, workspaceId, completed);
        translations.push(...completed);
      }
      return { translations, targetLang: input.targetLang };
    },
    persistItemTranslations(translations, actor = {}) {
      const workspaceId=actor.workspaceId || DEFAULT_WORKSPACE_ID;
      const safe=normalizedArticlePort ? translations.filter(row=>{
        const original=this.getOriginalContent(workspaceId,row.id);
        const item=original && feedRepository.getContentItem(workspaceId,original.id);
        const normalized=item && normalizedArticlePort.normalizedArticle(workspaceId,`feed:${item.id}`,item.updatedAt);
        return !normalized || row.translatedText!==normalized.body || Boolean(row.engine);
      }) : translations;
      persistTranslations(feedRepository,workspaceId,safe);
    },
    async localizeContentItems(workspaceId, ids = []) {
      const rows = this.listContentItemsByIds(workspaceId, ids);
      const units = [];
      for (const row of rows) {
        const text = String(row.body || row.summary || '').trim();
        if (!text || !needsZhLocalization(text)) continue;
        const id = row.provider && row.externalId ? `${row.provider}:${row.externalId}` : row.id;
        units.push({ id, text });
      }
      if (!units.length) return { considered: 0, pendingIds: [], translated: 0 };
      const result = await this.localizeTexts(units, { workspaceId });
      const pendingIds = result?.pendingIds || [];
      return {
        considered: units.length,
        pendingIds,
        translated: Math.max(0, units.length - pendingIds.length),
      };
    },
    async localizeTexts(units, actor = {}, options = {}) {
      const workspaceId = actor.workspaceId || DEFAULT_WORKSPACE_ID;
      const targetLang = options.targetLang === 'en' ? 'en' : 'zh';
      const collected = Array.isArray(units) && units.length
        ? units.map((unit) => ({
          id: String(unit?.id || '').trim(),
          localizationId: localizationItemId(unit?.localizationId || unit?.id),
          text: String(unit?.text || unit?.body || '').trim(),
        })).filter((unit) => unit.id && unit.localizationId && unit.text)
        : collectLocalizationUnits(units);
      return localizeCollected(feedRepository, translationPort, workspaceId, collected, targetLang, {
        wait: options.wait !== false,
        hourlyTitles: normalizedArticlePort?.hourlyTitles
          ? (ids) => normalizedArticlePort.hourlyTitles(workspaceId, ids)
          : null,
      });
    },
    hideContentItem(workspaceId, contentItemId) {
      return this.patchContentItemState({ workspaceId, contentItemId, isHidden: true });
    },
    patchContentItemState(input) {
      const item = feedRepository.getContentItem(input.workspaceId, input.contentItemId);
      if (!item) return null;
      const state = feedRepository.upsertUserItemState(input);
      if (item.provider && input.isHidden !== undefined) {
        feedRepository.upsertIdentityFingerprint?.({
          workspaceId: input.workspaceId,
          provider: item.provider,
          identityHash: feedItemIdentityHash(item.provider, item),
          externalId: item.externalId || '',
          hiddenAt: input.isHidden ? state.updatedAt : null,
        });
      }
      return state;
    },
    hideLegacyPost(id) {
      if (!legacyRepository.hidePost) return false;
      return legacyRepository.hidePost(id);
    },
  });
}
