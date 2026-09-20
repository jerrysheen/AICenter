import { createHash } from 'node:crypto';
import { ValidationError } from '../../contracts/src/index.js';
import { packFeedAiBatches } from './feed-ai-batch.js';
import { feedItemIdentityHash } from './feed-identity.js';
import { collectLocalizationUnits, localizationItemId, needsZhLocalization } from './localize-texts.js';

const DEFAULT_WORKSPACE_ID = 'local';
const STORED_FEED_LIMIT = 200;

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
    processing: '',
    subscriptionId: '',
    captureId: row.captureId || '',
    isRead: Boolean(row.isRead),
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
  const rows = feedRepository.listTranslations(workspaceId, items.map((item) => item.id), targetLang) || [];
  if (!rows.length) return items;
  const byId = new Map(rows.map((row) => [row.itemId, row]));
  return items.map((item) => {
    const row = byId.get(item.id);
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

function projectLocalizations(units, byItemId) {
  const localizations = {};
  for (const unit of units) {
    const row = byItemId.get(unit.localizationId);
    const hash = contentHash(unit.text);
    const ready = Boolean(row && row.sourceHash === hash && row.translatedText);
    localizations[unit.id] = {
      id: unit.localizationId,
      text: ready ? row.translatedText : '',
      pending: needsZhLocalization(unit.text) && !ready,
      engine: ready ? (row.engine || '') : '',
      sourceText: unit.text,
    };
  }
  return localizations;
}

async function translatePendingUnits(translationPort, pending, targetLang) {
  if (!pending.length || !translationPort) return [];
  const packed = packFeedAiBatches(pending.map((unit) => ({
    id: unit.localizationId,
    text: unit.text,
  })), {
    purpose: 'translate',
    charBudget: 80_000,
    itemClipChars: 5_000,
    itemLimit: 30,
  });
  const originals = new Map(pending.map((unit) => [unit.localizationId, unit.text]));
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
    }
    return { translations: rows, targetLang };
  }
  for (const batch of packed.batches) {
    const chunk = batch.units.map((unit) => ({ id: unit.itemId, text: unit.text }));
    const result = await translateChunk(chunk);
    for (const row of result.translations || []) {
      translations.push({
        ...row,
        sourceText: originals.get(row.id) || row.sourceText,
      });
    }
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
  const existing = translationMap(feedRepository?.listTranslations?.(
    workspaceId,
    unique.map((unit) => unit.localizationId),
    targetLang,
  ));
  const localizations = projectLocalizations(unique, existing);
  const pending = unique.filter((unit) => localizations[unit.id]?.pending);
  if (!pending.length || !translationPort) return { localizations, pendingIds: pending.map((unit) => unit.id) };

  const lockKey = `${workspaceId}:${targetLang}:${pending.map((unit) => unit.localizationId).sort().join(',')}`;
  const run = async () => {
    try {
      const translations = await translatePendingUnits(translationPort, pending, targetLang);
      persistTranslations(feedRepository, workspaceId, translations);
    } catch {
      // Keep cached/empty localizations; the view can retry.
    }
    const latest = translationMap(feedRepository?.listTranslations?.(
      workspaceId,
      unique.map((unit) => unit.localizationId),
      targetLang,
    ));
    return {
      localizations: projectLocalizations(unique, latest),
      pendingIds: unique.filter((unit) => projectLocalizations(unique, latest)[unit.id]?.pending).map((unit) => unit.id),
    };
  };

  if (options.wait === false) {
    return { localizations, pendingIds: pending.map((unit) => unit.id) };
  }

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
    return { added: 0, skipped: 0 };
  }
  const providerId = persistence.providerId;
  const sourceMeta = persistence.sourceAccount;
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
    metadata: {},
  });
  feedRepository.upsertSubscription?.({
    workspaceId,
    sourceAccountId: source.id,
    enabled: true,
    refreshIntervalMinutes: 30,
  });
  let added = 0;
  let skipped = 0;
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
    if (verdict.action === 'ignore' && linked) {
      verdict = { ...verdict, action: 'keep', createContentItem: true, status: 'ready' };
    }
    const capture = feedRepository.saveCapture({
      workspaceId,
      provider: providerId,
      externalId: String(item.externalId),
      sourceAccountId: source.id,
      sourceUrl: item.sourceUrl,
      title: item.title || '',
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
    feedRepository.saveContentItem({
      workspaceId,
      captureId: capture.id,
      originType: item.originType || 'subscription',
      contentType: item.contentType || 'post',
      title: item.title || '',
      body: item.body || '',
      summary: item.summary || '',
      sourceUrl: item.sourceUrl,
      authorName: item.authorName || '',
      publishedAt: item.publishedAt || null,
    });
    rememberFingerprint();
    added += 1;
  }
  return { added, skipped };
}

function readStoredFeed(feedRepository, workspaceId, persistence, query, extra = {}) {
  const providerId = persistence.providerId;
  const feed = query.feed || 'for-you';
  const rows = feedRepository.listContentItemsByProvider?.(workspaceId, providerId, {
    sourceExternalId: persistence.sourceAccount.externalId,
    limit: STORED_FEED_LIMIT,
  }) || [];
  const items = rankFeedItems(attachTranslations(
    feedRepository,
    workspaceId,
    rows.map((row) => toFeedItem(providerId, row)),
  ));
  return {
    platform: providerId,
    workspaceId,
    feed,
    handle: '',
    source: 'source-account',
    mode: items.length ? 'cached' : (extra.mode || 'empty'),
    tweetCount: items.length,
    fetchedAt: extra.fetchedAt || Date.now(),
    note: extra.note || (items.length
      ? `已缓存 ${items.length} 条，来自 SourceAccount`
      : (persistence.emptyNote || '还没有缓存。刷新后会写入来源并去重保留。')),
    added: extra.added || 0,
    skipped: extra.skipped || 0,
    items,
  };
}

function searchTerms(query) {
  return String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

function searchStoredItems(feedRepository, workspaceId, query, limit) {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const rows = feedRepository.listContentItems(workspaceId, { limit: STORED_FEED_LIMIT }) || [];
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

export function createFeedService({ legacyRepository, feedRepository, sourcePort, feedProviders, translationPort, feedFilter = null }) {
  const resolvedSourcePort = sourcePort || wrapFeedProviders(feedProviders);
  if (!legacyRepository || !feedRepository || !resolvedSourcePort) throw new Error('feed repositories and source port are required');
  sourcePort = resolvedSourcePort;

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
      const source = sourcePort.findByProvider(providerId, 'content-feed');
      if (!source) throw new ValidationError(`尚未启用 ${providerId} 信息源`, ['platform']);
      const { platform: _platform, refresh: _refresh, ...sourceInput } = query || {};
      const persistence = sourcePort.persistence(source.id, sourceInput);
      if (!persistence?.sourceAccount) throw new ValidationError(`${source.id} 未声明 Feed 持久化投影`, ['sourceId']);
      const workspaceId = actor.workspaceId || DEFAULT_WORKSPACE_ID;
      if (!query?.refresh) {
        const stored = readStoredFeed(feedRepository, workspaceId, persistence, sourceInput);
        stored.items = rankFeedItems(await localizeFeedItems(feedRepository, translationPort, workspaceId, stored.items, 'zh', { wait: false }));
        return stored;
      }
      const sourceSnapshot = await sourcePort.read(source.id, sourceInput, {
        refresh: true,
        excludeExternalIds: knownExternalIds(feedRepository, workspaceId, providerId),
      });
      const snapshot = sourceSnapshot.data;
      let stats = { added: 0, skipped: 0 };
      try {
        stats = await ingestExternalItems(feedRepository, workspaceId, persistence, snapshot, feedFilter);
      } catch {
        // Live snapshot still returns even if persistence fails.
      }
      const stored = readStoredFeed(feedRepository, workspaceId, persistence, sourceInput, {
        fetchedAt: snapshot.fetchedAt,
        added: stats.added,
        skipped: stats.skipped,
      });
      stored.items = rankFeedItems(await localizeFeedItems(feedRepository, translationPort, workspaceId, stored.items));
      const hiddenExternalIds = new Set(feedRepository.listHiddenExternalIds?.(workspaceId, providerId) || []);
      stored.items = stored.items.filter((item) => !hiddenExternalIds.has(String(item.externalId || '')));
      const total = stored.items.length;
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
      return {
        ...stored,
        mode: snapshot.mode === 'error' && total ? 'cached' : (snapshot.mode === 'live' ? 'live' : stored.mode),
        loggedIn: snapshot.loggedIn,
        note: snapshot.mode === 'unavailable'
          ? (total ? `${snapshot.note} · 仍显示已缓存 ${total} 条` : snapshot.note)
          : snapshot.mode === 'error' && total
            ? `${snapshot.note} · 仍显示已缓存 ${total} 条`
            : `${snapshot.note || '已拉取'} · 新增 ${stats.added} · 去重 ${stats.skipped} · 共 ${total} 条`,
        items: stored.items.length ? stored.items : visibleSnapshotItems,
      };
    },
    listContentItems(workspaceId, page) {
      return feedRepository.listContentItems(workspaceId, page);
    },
    listTaggableItems(workspaceId, { limit = 200, ids = [] } = {}) {
      const rows = feedRepository.listContentItemsWithSource
        ? feedRepository.listContentItemsWithSource(workspaceId, { limit, ids })
        : feedRepository.listContentItems(workspaceId, { limit });
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
      const row = rows.find((entry) => entry.sourceHash === hash && entry.translatedText)
        || rows.find((entry) => entry.translatedText);
      return {
        ...item,
        translation: row?.translatedText
          ? { text: row.translatedText, engine: row.engine || '', targetLang: row.targetLang || 'zh' }
          : null,
      };
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
      return searchStoredItems(feedRepository, workspaceId, query, limit);
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
      const packed = packFeedAiBatches(input.items, {
        purpose: 'translate',
        charBudget: 80_000,
        itemClipChars: 5_000,
        itemLimit: 30,
      });
      const originals = new Map((input.items || []).map((item) => [item.id, item.text]));
      const translations = [];
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
        for (const row of result.translations || []) {
          translations.push({
            ...row,
            sourceText: originals.get(row.id) || row.sourceText,
          });
        }
      }
      persistTranslations(feedRepository, actor.workspaceId || DEFAULT_WORKSPACE_ID, translations);
      return { translations, targetLang: input.targetLang };
    },
    persistItemTranslations(translations, actor = {}) {
      persistTranslations(feedRepository, actor.workspaceId || DEFAULT_WORKSPACE_ID, translations);
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
