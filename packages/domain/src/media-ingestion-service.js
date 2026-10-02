import { createHash } from 'node:crypto';
import { ValidationError } from '../../contracts/src/errors.js';
import { MediaBriefSchema, MediaConfigSchema } from '../../contracts/src/media.js';
import { localizationItemId } from './localize-texts.js';
import { mediaTranslationUnits, projectMediaTranslation } from './media-translation.js';
import { formatYmd, zonedParts } from './zoned-time.js';
const MEDIA_BUDGET = MediaConfigSchema.parse({ version: 1, sources: [] }).budget;
const MEDIA_TIMEZONE = 'Asia/Shanghai';

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

function textHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function entryRow(workspaceId, entry, item, { at, previous, status }) {
  return {
    workspaceId,
    externalId: item.externalId,
    sourceKey: entry.sourceKey,
    publisherKey: entry.sourceKey,
    channel: entry.channel,
    canonicalUrl: item.sourceUrl || item.canonicalUrl,
    title: item.title,
    summary: item.summary,
    publishedAt: item.publishedAt,
    publishedAtRaw: item.publishedAtRaw,
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
  mediaRepository,
  feedRepository = null,
  taggingRepository = null,
  mediaPort = null,
  now = () => Date.now(),
  budget = {},
} = {}) {
  if (!mediaRepository) throw new Error('media repository is required');
  const MEDIA_SOURCES = mediaPort?.sources || [];
  const dayKey = at => formatYmd(zonedParts(at,mediaPort?.timeZone || MEDIA_TIMEZONE));
  budget = { ...MEDIA_BUDGET, ...(mediaPort?.budget || {}), ...budget };
  const MEDIA_PUBLISHERS = [...MEDIA_SOURCES, ...(mediaPort?.publishers || [])];
  const mediaSource = key => MEDIA_PUBLISHERS.find(s => s.sourceKey === key) || null;
  const mediaSourcesByChannel = channel => MEDIA_SOURCES.filter(s => !channel || s.channel === channel);
  const redactUrl = mediaPort?.redactUrl || (url => url);
  const fetchAllowlisted = (input, options) => mediaPort.fetch(input, options);
  const parseFeedXml = (xml, entry) => mediaPort.parseFeed(xml, entry);
  const extractorVersion = mediaPort?.extractorVersion || '';
  const initialFetchState = () => ({ fetchStatus: 'pending', httpStatus: null, extractionReason: '', attemptCount: 0, failureCount: 0, lastAttemptAt: null, nextRetryAt: null,
    responseBytes: 0, extractedBytes: 0, paragraphCount: 0, extractionMethod: '', extractorVersion: '', fetchedRevision: 0, etag: '', lastModified: '',
    finalUrl: '', author: '', publishedAtRaw: '', updatedAtRaw: '', selectedReason: '', visualEvidenceRequired: false });

  function stateOf(workspaceId, sourceKey, at) {
    return mediaRepository.getState(workspaceId, sourceKey) || blankState(workspaceId, sourceKey, at);
  }

  function catalogView(workspaceId) {
    const states = new Map(mediaRepository.listStates(workspaceId).map((item) => [item.sourceKey, item]));
    return MEDIA_PUBLISHERS.map((entry) => {
      const state = states.get(entry.sourceKey);
      return {
        sourceKey: entry.sourceKey,
        publisher: entry.publisher,
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

  function readFeed(workspaceId, { channel = 'tech', view = 'all', offset = 0, limit = 50 } = {}) {
    const wanted = channel === 'macro' || channel === 'tech' ? channel : 'tech';
    const allItems = mediaRepository.listEntries(workspaceId, { channel: wanted, limit: 10_000 });
    const category = row => row.fetchState?.fetchStatus === 'ready' && row.contentLevel === 'full' && row.fetchState?.extractorVersion === extractorVersion && row.fetchState?.fetchedRevision === row.revision ? 'full' : ['failed','policy_skipped'].includes(row.fetchState?.fetchStatus) ? 'failed' : ['full','partial'].includes(row.contentLevel) ? 'partial' : row.fetchState?.fetchStatus === 'pending' || row.fetchState?.fetchStatus === 'deferred' ? 'pending' : 'index';
    const counts = { all: allItems.length, full: 0, partial: 0, index: 0, pending: 0, failed: 0 };
    for (const item of allItems) counts[category(item)] += 1;
    const filtered = allItems.filter(row => view === 'all' || category(row) === view);
    const items = filtered.slice(offset, offset + Math.min(100,limit));
    const visibleSources = catalogView(workspaceId).filter((item) => item.channel === wanted);
    const bodies = new Map((mediaRepository.latestBodies?.(workspaceId, items.map((item) => item.externalId)) || [])
      .map((row) => [row.externalId, row]));
    const projected = items.map((item) => {
      const snapshot = bodies.get(item.externalId);
      const article = ['full','partial'].includes(item.contentLevel) ? (snapshot?.bodyText || '') : '';
      const verifiedFull = article && snapshot.contentLevel === 'full' && !snapshot.truncated && snapshot.article?.extractorVersion === extractorVersion && item.fetchState?.extractorVersion === extractorVersion && item.fetchState?.fetchStatus === 'ready' && item.fetchState?.fetchedRevision === item.revision;
      const body = mediaDisplayText({ title: item.title, summary: item.summary, body: article });
      const id = mediaResourceId(item.externalId);
      return {
        id,
        resourceId: id,
        externalId: item.externalId,
        title: item.title,
        summary: item.summary,
        body,
        sourceUrl: item.canonicalUrl,
        authorName: snapshot?.article?.author || item.fetchState?.author || item.publisherKey,
        publishedAt: item.publishedAt || 0,
        contentLevel: article ? verifiedFull ? 'full' : 'partial' : item.contentLevel,
        truncated: Boolean(snapshot?.truncated),
        fetchState: item.fetchState || {},
        paragraphs: snapshot?.article?.paragraphs || [],
        articleTranslation: verifiedFull ? articleTranslation(workspaceId,item,snapshot) : null,
        generatedBrief: verifiedFull && snapshot?.brief?.bodyHash === item.bodyHash ? snapshot.brief : null,
        briefState: mediaRepository.getBriefProcessing(workspaceId,item.externalId,item.bodyHash),
        bodyHash: item.bodyHash,
        snapshotRevision: snapshot?.revision || null,
        publisherKey: item.publisherKey,
        publisherName: mediaSource(item.publisherKey)?.publisher || item.publisherKey,
        channel: item.channel,
        originUrl: item.originUrl,
        status: item.status,
      };
    });
    const translationRows = feedRepository?.listTranslations?.(
      workspaceId,
      projected.map((item) => item.id),
      'zh',
    ) || [];
    const translationById = new Map(translationRows.map((row) => [row.itemId, row]));
    const tagRows = taggingRepository?.listTaggings?.(
      workspaceId,
      'media-index',
      projected.map((item) => item.resourceId),
    ) || [];
    const tagsById = new Map(tagRows.map((row) => [row.resourceId, row.tags]));
    const fullCount = projected.filter((item) => item.contentLevel === 'full').length;
    return {
      platform: 'media',
      feed: wanted,
      source: 'media-index',
      mode: projected.length ? 'cached' : 'empty',
      fetchedAt: now(),
      note: projected.length
        ? `媒体索引 ${projected.length} 条 · 正文 ${fullCount} 篇 · ${wanted === 'tech' ? '产业科技' : '宏观与国际'}`
        : '来源默认关闭。主机探针确认 RSS 后，才能显式启用第一批。',
      items: projected.map((item) => {
        const saved = translationById.get(item.id);
        const ready = Boolean(saved && saved.sourceHash === textHash(item.body) && saved.translatedText);
        return {
          ...item,
          tags: tagsById.get(item.resourceId) || [],
          translation: ready ? {
            text: saved.translatedText,
            engine: saved.engine || '',
            targetLang: saved.targetLang || 'zh',
          } : null,
          translationStatus: ready ? 'ready' : saved ? 'stale' : 'pending',
        };
      }),
      sources: visibleSources,
      budget: mediaRepository.budgetDay(workspaceId, dayKey(now())),
      counts,
      total: filtered.length,
      nextOffset: offset + items.length < filtered.length ? offset + items.length : null,
    };
  }

  async function probe({ workspaceId = 'local', sourceKeys = [], policyReviewed = false, run = false } = {}) {
    const keys = [...new Set(sourceKeys.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, MEDIA_BUDGET.maxActiveSources);
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
      if (entry.transport === 'vendor_api') {
        const saved = mediaRepository.saveState({
          ...current,
          health: 'needs_credentials',
          healthDetail: '没有凭证，不把产品介绍地址当成业务接口',
          updatedAt: at,
        });
        results.push({ sourceKey: key, health: saved.health, status: null, requestCount: 0, items: null });
        continue;
      }
      if (entry.transport === 'existing_adapter') {
        results.push({ sourceKey: key, health: 'existing_adapter', status: null, requestCount: 0, items: null });
        continue;
      }
      const fetched = await fetchAllowlisted({
        url: entry.probeUrl,
        allowedHosts: entry.allowedHosts,
        redirectHosts: entry.redirectHosts,
      }, { maxBytes: budget.maxFeedBytes });
      requestCount += 1 + fetched.redirectChain.length;
      let health = fetched.health;
      let itemCount = null;
      let verified = false;
      if (entry.transport === 'rss' && fetched.ok && !fetched.notModified) {
        const parsed = parseFeedXml(fetched.body, entry);
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
    const existingBody = entry.transport === 'existing_adapter' && entry.contentAccess === 'body';
    if (!existingBody && (entry.deployment !== 'first' || entry.transport !== 'rss')) {
      return { ok: false, health: entry.transport === 'vendor_api' ? 'needs_credentials' : 'not_in_initial_batch' };
    }
    if (!existingBody && !current.hostDirectVerified) return { ok: false, health: 'needs_host_probe' };
    const enabled = mediaRepository.listStates(workspaceId).filter((item) => item.enabled && item.sourceKey !== sourceKey && mediaSource(item.sourceKey)?.transport !== 'existing_adapter');
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
    const waiting = mediaRepository.listDeferred(workspaceId, entry.sourceKey);
    if (!waiting.length) return 0;
    const reservation = mediaRepository.reserveMetadata(
      workspaceId, dayKey(at), waiting.length, at, budget.maxNewMetadataPerDay, { recordDeferred: false },
    );
    waiting.slice(0, reservation.allowed).forEach((item) => {
      mediaRepository.upsertEntry({ ...item, status: 'indexed', updatedAt: at });
    });
    return reservation.allowed;
  }

  async function syncSource(workspaceId, entry, at, force = false) {
    const current = stateOf(workspaceId, entry.sourceKey, at);
    if (!current.enabled) return { sourceKey: entry.sourceKey, health: 'disabled', added: 0, items: null };
    if (!force && current.lastSyncAt && at < current.lastSyncAt + entry.refreshMinutes * 60_000) return { sourceKey: entry.sourceKey, health: 'not_due', added: 0, items: null };
    if (entry.transport === 'vendor_api') {
      mediaRepository.saveState({
        ...current,
        health: 'needs_credentials',
        healthDetail: '没有 Key 或使用许可',
        updatedAt: at,
      });
      return { sourceKey: entry.sourceKey, health: 'needs_credentials', added: 0, items: null };
    }
    if (entry.transport === 'existing_adapter' && !mediaPort?.readExisting) {
      return { sourceKey: entry.sourceKey, health: 'existing_adapter', added: 0, items: null };
    }
    if (entry.transport !== 'rss' && entry.transport !== 'existing_adapter') {
      mediaRepository.saveState({ ...current, health: 'needs_parser', healthDetail: '栏目页还没有验收过的列表解析', updatedAt: at });
      return { sourceKey: entry.sourceKey, health: 'needs_parser', added: 0, items: null };
    }
    const existing = entry.transport === 'existing_adapter' ? await mediaPort.readExisting(entry) : null;
    const fetched = existing ? { ok: existing.ok, health: existing.health, body: JSON.stringify(existing.items), etag: '', lastModified: '' } : await fetchAllowlisted({
      url: entry.probeUrl,
      allowedHosts: entry.allowedHosts,
      redirectHosts: entry.redirectHosts,
      etag: current.etag,
      lastModified: current.lastModified,
    }, { maxBytes: budget.maxFeedBytes });
    if (!fetched.ok) {
      mediaRepository.saveState({ ...current, health: fetched.health, healthDetail: fetched.note || '', updatedAt: at });
      return { sourceKey: entry.sourceKey, health: fetched.health, added: 0, items: null };
    }
    if (fetched.notModified) {
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
    const feedHash = sha256(fetched.body);
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
      return { sourceKey: entry.sourceKey, health: 'not_modified', added: acceptedDeferred, items: null };
    }
    const cutoff = at - budget.backfillHours * 60 * 60 * 1000;
    const fresh = parsed.items.filter((item) => item.publishedAt == null || item.publishedAt >= cutoff);
    const known = new Map(mediaRepository.getEntries(workspaceId, fresh.map((item) => item.externalId))
      .map((item) => [item.externalId, item]));
    const changed = fresh.filter((item) => known.get(item.externalId)?.contentHash !== indexHash(item));
    const created = changed.filter((item) => !known.has(item.externalId));
    const retry = changed.filter((item) => known.get(item.externalId)?.status === 'budget_deferred');
    const reservation = mediaRepository.reserveMetadata(
      workspaceId, dayKey(at), created.length, at, budget.maxNewMetadataPerDay,
    );
    const retryReservation = mediaRepository.reserveMetadata(
      workspaceId, dayKey(at), retry.length, at, budget.maxNewMetadataPerDay, { recordDeferred: false },
    );
    const accepted = new Set([
      ...created.slice(0, reservation.allowed),
      ...retry.slice(0, retryReservation.allowed),
    ].map((item) => item.externalId));
    const deferredIds = new Set([...created, ...retry]
      .filter((item) => !accepted.has(item.externalId))
      .map((item) => item.externalId));
    let added = 0;
    for (const item of changed) {
      const previous = known.get(item.externalId);
      const deferred = deferredIds.has(item.externalId);
      mediaRepository.atomic(() => {
      mediaRepository.upsertEntry(entryRow(workspaceId, entry, item, {
        at,
        previous,
        status: deferred ? 'budget_deferred' : (previous?.status === 'body_ready' ? 'body_ready' : 'indexed'),
      }));
      if (item.feedBodyHtml) mediaRepository.saveFeedBody(workspaceId, item.externalId, item.feedBodyHtml);
      });
      if (!deferred && (!previous || previous.status === 'budget_deferred')) added += 1;
    }
    added += acceptDeferred(workspaceId, entry, at);
    const dated = parsed.items.map((item) => item.publishedAt).filter((value) => Number.isInteger(value));
    const newest = dated.length ? Math.max(...dated) : null;
    const oldest = dated.length ? Math.min(...dated) : null;
    const stale = newest != null && newest < at - 7 * 24 * 60 * 60 * 1000;
    const possibleGap = Boolean(current.lastSyncAt && oldest && oldest > current.lastSyncAt);
    const health = possibleGap ? 'possible_gap' : (stale ? 'stale' : (parsed.items.length ? 'ready' : 'empty'));
    mediaRepository.saveState({
      ...current,
      health,
      healthDetail: reservation.deferred ? `budget_deferred ${reservation.deferred}` : '',
      etag: fetched.etag || '',
      lastModified: fetched.lastModified || '',
      feedHash,
      lastSyncAt: at,
      updatedAt: at,
    });
    return { sourceKey: entry.sourceKey, health, added, deferred: reservation.deferred, items: null };
  }

  async function syncEnabled({ workspaceId = 'local', channel = '', force = false } = {}) {
    const at = now();
    const entries = mediaSourcesByChannel(channel).filter((entry) => stateOf(workspaceId, entry.sourceKey, at).enabled);
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

  async function fetchBodies({ workspaceId = 'local', externalIds = [], usageReviewed, repair = false, selectedReasons = {} } = {}) {
    if (usageReviewed === false) return { ok: false, health: 'needs_license', fetched: [] };
    // Explicit operator acknowledgement is recorded before making any request.
    const rows = mediaRepository.getEntries(workspaceId, [...new Set(externalIds)].slice(0,40));
    if (usageReviewed === true) acknowledgeBodyUse(workspaceId, [...new Set(rows.map(r => r.sourceKey))]);
    const at = now();
    const fetched = [];
    const stats = { selected: rows.length, attempted: 0, requests: 0, validFull: 0, partial: 0, failed: 0, policySkipped: 0, deferred: 0, skipped: 0 };
    for (const row of rows) {
      const entry = mediaSource(row.sourceKey);
      const old = { ...initialFetchState(), ...row.fetchState };
      let state = { ...old, selectedReason: selectedReasons[row.externalId] || old.selectedReason || 'explicit_selection' };
      const result = (health, kind, extra = {}) => {
        stats[kind] += 1;
        fetched.push({ externalId: row.externalId, sourceKey: row.sourceKey, health, contentLevel: row.contentLevel, ...extra });
      };
      if (!entry || entry.contentAccess !== 'body' || !stateOf(workspaceId,row.sourceKey,at).bodyUseAcknowledged) {
        state = { ...state, fetchStatus: 'policy_skipped', extractionReason: entry?.contentAccess === 'body' ? 'needs_license' : 'index_only' };
        mediaRepository.saveFetchState(workspaceId,row.externalId,state);
        result(state.extractionReason,'policySkipped'); continue;
      }
      const previous = mediaRepository.latestBodies(workspaceId,[row.externalId])[0];
      if (!repair && row.contentLevel === 'full' && row.bodyHash && old.extractorVersion === extractorVersion && old.fetchedRevision === row.revision && old.nextRetryAt > at) {
        result('ready','skipped',{ skipped: true }); continue;
      }
      if (!repair && old.fetchStatus === 'failed' && (!old.nextRetryAt || old.nextRetryAt > at)) { result('retry_cooldown','deferred'); continue; }
      if (!repair && old.nextRetryAt > at && old.fetchStatus !== 'ready') { result('retry_cooldown','deferred'); continue; }
      const alreadyCounted = previous?.contentLevel === 'full';
      const reservation = alreadyCounted ? { reserved: true } : mediaRepository.reserveBody(workspaceId, dayKey(at), row.sourceKey, at, {
        globalMax: budget.maxSelectedBodiesPerDay, sourceMax: entry.detailDailyCap,
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
        response = await mediaPort.fetch({ url: row.canonicalUrl, allowedHosts: entry.articleHosts, redirectHosts: entry.redirectHosts, kind: 'article', ...validators }, { maxBytes: budget.maxFeedBytes, onRequest() {
          const reserved = mediaRepository.reserveRequest(workspaceId,dayKey(at),row.sourceKey,at,budget.maxBodyRequestsPerDay,budget.maxSourceRequestsPerDay);
          if (reserved) stats.requests += 1;
          return reserved;
        } });
        if (response.health === 'budget_deferred') {
          if (!alreadyCounted) mediaRepository.releaseBody(workspaceId,dayKey(at),row.sourceKey,at);
          mediaRepository.saveFetchState(workspaceId,row.externalId,{ ...state, fetchStatus: 'deferred', extractionReason: 'request_budget', nextRetryAt: at + 3_600_000 });
          result('budget_deferred','deferred'); continue;
        }
        if (response.notModified && previous) {
          mediaRepository.saveFetchState(workspaceId,row.externalId,{ ...state, fetchStatus: previous.contentLevel === 'full' ? 'ready' : 'partial', httpStatus: 304, lastAttemptAt: at,
            attemptCount: old.attemptCount + 1, fetchedRevision: row.revision, nextRetryAt: at + 86_400_000, extractionReason: 'not_modified' });
          if (!alreadyCounted) mediaRepository.releaseBody(workspaceId,dayKey(at),row.sourceKey,at);
          stats.attempted += 1; result('not_modified','skipped',{ skipped: true }); continue;
        }
        article = response.ok ? mediaPort.extract(response.body,{ status: response.status, sourceKey: entry.sourceKey, title: row.title, summary: row.summary, maxBytes: budget.maxBodyBytes }) : { ok: false, reason: response.health, text: '' };
      }
      stats.attempted += 1;
      const attemptCount = old.attemptCount + 1;
      const failureCount = article.ok ? 0 : (old.failureCount || 0) + 1;
      const transient = ['network','rate_limited','http_error'].includes(article.reason) && (response.status == null || response.status === 429 || response.status >= 500);
      const nextRetryAt = article.ok ? at + 86_400_000 : transient && failureCount < 5 ? at + Math.min(86_400_000, 900_000 * 2 ** (failureCount-1)) : null;
      state = { ...state, fetchStatus: article.ok ? article.contentLevel === 'full' ? 'ready' : 'partial' : 'failed', httpStatus: response.status ?? null,
        extractionReason: article.reason || '', attemptCount, failureCount, lastAttemptAt: at, nextRetryAt, responseBytes: response.bytes || 0,
        extractedBytes: Buffer.byteLength(article.text || ''), paragraphCount: article.paragraphs?.length || 0, extractionMethod: article.extractionMethod || '', extractorVersion,
        fetchedRevision: article.ok ? row.revision : old.fetchedRevision, etag: String(response.etag || '').slice(0,1000), lastModified: String(response.lastModified || '').slice(0,1000), finalUrl: String(response.finalUrl || '').slice(0,2048),
        author: article.author || '', publishedAtRaw: article.publishedAtRaw || '', updatedAtRaw: article.updatedAtRaw || '', visualEvidenceRequired: Boolean(article.visualEvidenceRequired) };
      if (!article.ok) {
        if (!alreadyCounted) mediaRepository.releaseBody(workspaceId,dayKey(at),row.sourceKey,at);
        mediaRepository.saveFetchState(workspaceId,row.externalId,state);
        result(article.reason || 'failed','failed'); continue;
      }
      const bodyHash = sha256(article.text);
      const changed = previous?.bodyHash !== bodyHash || previous?.article?.extractorVersion !== extractorVersion ||
        (previous.article?.author || '') !== (article.author || '') || (previous.article?.publishedAtRaw || '') !== (article.publishedAtRaw || '');
      const revision = changed ? mediaRepository.nextSnapshotRevision(workspaceId,row.externalId) : previous.revision;
      mediaRepository.atomic(() => {
        if (changed) mediaRepository.saveSnapshot({ workspaceId, externalId: row.externalId, revision, bodyHash, bodyText: article.text,
          truncated: article.truncated, contentLevel: article.contentLevel, observedAt: at, article: { ...article, text: undefined, sourceRevision: row.revision, finalUrl: response.finalUrl || row.canonicalUrl } });
        const degrade = previous?.contentLevel === 'full' && article.contentLevel !== 'full';
        if (!degrade) {
          mediaRepository.upsertEntry({ ...row, contentLevel: article.contentLevel, bodyHash, truncated: article.truncated, status: 'body_ready', updatedAt: at });
          promoteBody(workspaceId,row,article,bodyHash);
        }
        mediaRepository.saveFetchState(workspaceId,row.externalId,state);
      });
      if (article.contentLevel !== 'full' && !alreadyCounted) mediaRepository.releaseBody(workspaceId,dayKey(at),row.sourceKey,at);
      result(article.contentLevel === 'full' ? 'ready' : 'partial', article.contentLevel === 'full' ? 'validFull' : 'partial', { contentLevel: article.contentLevel, bodyHash, snapshotRevision: revision, truncated: article.truncated });
    }
    return { ok: !stats.failed && !stats.partial && !stats.policySkipped && !stats.deferred, health: stats.failed || stats.partial || stats.policySkipped || stats.deferred ? 'partial' : 'ready', stats, fetched };
  }

  function promoteBody(workspaceId, row, article, bodyHash) {
    if (!feedRepository?.saveCapture || !feedRepository?.saveContentItem) return;
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
        contentLevel: article.contentLevel,
        extractorVersion,
        bodyHash,
        truncated: article.truncated,
        publishedAtRaw: row.publishedAtRaw,
        channel: row.channel,
      },
    });
    feedRepository.saveContentItem({
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
  }

  function selectBodyCandidates(workspaceId, limit = 40) {
    const at = now();
    const rows = mediaRepository.listEntries(workspaceId,{ limit: 200 });
    const ranked = rows.filter(row => {
      if (row.contentLevel === 'full' && !row.fetchState?.extractorVersion) return false;
      const entry = mediaSource(row.sourceKey);
      const state = row.fetchState || {};
      if (!entry || entry.contentAccess !== 'body' || !stateOf(workspaceId,row.sourceKey,at).enabled || row.status === 'budget_deferred') return false;
      if (state.fetchStatus === 'failed' && (!state.nextRetryAt || state.nextRetryAt > at)) return false;
      if (state.nextRetryAt > at && state.extractorVersion === extractorVersion && state.fetchedRevision === row.revision) return false;
      return true;
    }).map(row => {
      const text = (row.title + ' ' + row.summary).toLowerCase();
      const matched = (mediaPort?.focusKeywords || []).filter(k => text.includes(k.toLowerCase()));
      const informative = /\d|announc|launch|rais|change|report|acquir|policy|rate|price|build|发布|新增|变更/i.test(text);
      const score = matched.length * 20 + (informative ? 5 : 0) + (row.summary ? 1 : 0) - (row.fetchState?.attemptCount || 0);
      return { externalId: row.externalId, title: row.title, score, reason: matched.length ? 'focus:' + matched.join(',') : informative ? 'new_event_or_data' : 'source_revision_check', at: row.publishedAt || row.observedAt };
    }).sort((a,b) => b.score-a.score || b.at-a.at || a.externalId.localeCompare(b.externalId));
    const selected = [], events = new Set();
    for (const row of ranked) {
      const event = row.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
      if (events.has(event) || selected.length >= limit) continue;
      events.add(event); selected.push(row);
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
      const reservation = mediaRepository.reserveMetadata(workspaceId,dayKey(at),1,at,budget.maxNewMetadataPerDay);
      mediaRepository.upsertEntry(entryRow(workspaceId,publisher,item,{at,status:reservation.allowed ? 'indexed' : 'budget_deferred'}));
      if (reservation.allowed) added++;
    }
    for (const entry of mediaPort?.publishers || []) added += acceptDeferred(workspaceId,entry,at);
    return {added};
  }

  function articleTranslation(workspaceId,row,snapshot) {
    const article = {externalId:row.externalId,bodyHash:snapshot.bodyHash,snapshotRevision:snapshot.revision,title:row.title,paragraphs:snapshot.article.paragraphs || []};
    const saved = feedRepository?.listTranslations?.(workspaceId,mediaTranslationUnits(article).map(u=>u.id),'zh') || [];
    return projectMediaTranslation(article,saved);
  }

  function listArticleTranslationUnits(workspaceId,externalIds) {
    return mediaRepository.getEntries(workspaceId,externalIds).flatMap(row=>{
      const snapshot=mediaRepository.latestBodies(workspaceId,[row.externalId])[0];
      if (!snapshot || snapshot.contentLevel!=='full' || snapshot.truncated || snapshot.article.extractorVersion!==extractorVersion || row.fetchState?.fetchStatus!=='ready' || row.fetchState.fetchedRevision!==row.revision) return [];
      return mediaTranslationUnits({externalId:row.externalId,bodyHash:snapshot.bodyHash,title:row.title,paragraphs:snapshot.article.paragraphs});
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
    const rows = mediaRepository.listEntries(workspaceId,{ limit: 200 });
    const row = rows.find(r => r.canonicalUrl === item.sourceUrl);
    if (!row) return null;
    const snapshot = mediaRepository.latestBodies(workspaceId,[row.externalId])[0];
    if (!snapshot?.brief || snapshot.bodyHash !== sha256(item.body) || row.fetchState?.fetchStatus !== 'ready' || row.fetchState?.fetchedRevision !== row.revision) return null;
    return snapshot.brief;
  }

  function listEnrichmentItems(workspaceId, limit = 120) {
    const rows = mediaRepository.listEntries(workspaceId, { limit }).filter((row) => row.status !== 'budget_deferred');
    const bodies = new Map((mediaRepository.latestBodies?.(workspaceId, rows.map((row) => row.externalId)) || [])
      .map((row) => [row.externalId, row]));
    return rows.map((row) => {
      const article = ['full','partial'].includes(row.contentLevel) ? (bodies.get(row.externalId)?.bodyText || '') : '';
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

  return Object.freeze({
    catalog: () => MEDIA_SOURCES.map((entry) => ({ ...entry })),
    discoverOriginals,
    listArticleTranslationUnits,
    catalogView,
    readFeed: (query, actor = {}) => readFeed(actor.workspaceId || 'local', query || {}),
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
  });
}
