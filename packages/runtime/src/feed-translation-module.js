import { createHash } from 'node:crypto';
import { FEED_TRANSLATION_TEXT_MAX, FeedTranslationJobInputSchema } from '../../contracts/src/index.js';
import { TRANSLATION_MAX_ATTEMPTS } from '../../database/src/translation-retry.js';
import { stripLeadingPreview } from '../../connectors/src/x/home-browser.js';
import { translationBodyBatchLimit, translationBodyCharBudget, translationTitleBatchLimit } from '../../domain/src/feed-ai-batch.js';
import { gemmaTranslationPolicy, resolveGemmaTranslationSlots } from '../../connectors/src/translate/gemma.js';
import { translationAttemptCallLimit, withTranslationCallBudget } from '../../connectors/src/translate/call-budget.js';
import { localizationItemId, needsZhLocalization, translationLooksTruncated } from '../../domain/src/localize-texts.js';

function bodyHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export const TRANSLATION_BACKFILL_PRIORITY = -10;
export const TRANSLATION_INTERACTIVE_PRIORITY = 10;
export const TRANSLATION_JOB_UNIT_LIMIT = 30;
export const TRANSLATION_JOB_CHAR_BUDGET = 12_000;
export const TRANSLATION_BULK_JOB_CAP = 8;

export const TRANSLATION_BACKFILL_LIMIT = 80;
export const TRANSLATION_BACKFILL_STARTUP_MAX = 80;

export function translationStartupBackfillLimit(value) {
  if (value === undefined || value === null || String(value).trim() === '') return TRANSLATION_BACKFILL_LIMIT;
  const raw = Number(value);
  if (!Number.isInteger(raw) || raw < 0) return TRANSLATION_BACKFILL_LIMIT;
  return Math.min(raw, TRANSLATION_BACKFILL_STARTUP_MAX);
}

// Backfill stays at 1 or 2 jobs. When the translation pool has room, one slot stays for priority >= 0.
export function translationBackfillConcurrency(value, translationLimit = 5) {
  const slots = Number.isInteger(Number(translationLimit)) && Number(translationLimit) >= 1 ? Number(translationLimit) : 5;
  const raw = Number(value);
  const chosen = Number.isInteger(raw) && raw >= 1 ? raw : 2;
  const capped = Math.min(2, Math.max(1, chosen));
  return slots >= 2 ? Math.min(capped, slots - 1) : 1;
}

export function createFeedTranslationChunkStore(feed) {
  return {
    load({ workspaceId, itemId, targetLang, sourceHash }) {
      return feed?.listTranslationChunks?.(workspaceId, itemId, targetLang, sourceHash) || [];
    },
    save(row) {
      feed?.saveTranslationChunk?.(row);
    },
    clear({ workspaceId, itemId, targetLang }) {
      feed?.deleteTranslationChunks?.(workspaceId, itemId, targetLang);
    },
  };
}

function emptyBackfillSummary(limit) {
  return {
    enqueued: 0, limit, scanned: 0, cjk: 0, flash: 0, hidden: 0, tooLong: 0, empty: 0,
    translated: 0, failure: 0, hourlyTitle: 0, stale: 0, otherProvider: 0,
    ids: { cjk: [], flash: [], hidden: [], tooLong: [], translated: [], failure: [], hourlyTitle: [], stale: [] },
  };
}

function noteSkip(summary, key, id) {
  summary[key] += 1;
  if (id && summary.ids[key] && summary.ids[key].length < 8) summary.ids[key].push(id);
}

function translationCovers(rowHash, engine, translatedLength, text, hash, translatedText = '') {
  if (!rowHash || rowHash !== hash) return false;
  if (engine === 'hourly-report' && text.length > 400 && text.length > Number(translatedLength) * 3) return false;
  if (translationLooksTruncated(text, translatedLength, translatedText)) return false;
  return true;
}

export function formatTranslationBackfillLog(summary = {}, { enqueued = 0, limit = 0 } = {}) {
  const fields = [
    ['cjk', summary.cjk], ['flash', summary.flash], ['hidden', summary.hidden],
    ['too-long', summary.tooLong], ['translated', summary.translated], ['failure', summary.failure],
    ['hourly-title', summary.hourlyTitle], ['stale', summary.stale], ['other-provider', summary.otherProvider],
  ];
  const idKeys = [
    ['cjk', 'cjk'], ['flash', 'flash'], ['hidden', 'hidden'], ['too-long', 'tooLong'],
    ['translated', 'translated'], ['failure', 'failure'], ['hourly-title', 'hourlyTitle'], ['stale', 'stale'],
  ];
  const ids = idKeys.flatMap(([label, key]) => (summary.ids?.[key]?.length ? [`${label}-ids=${summary.ids[key].join(',')}`] : []));
  return `[worker] translation-backfill enqueued=${enqueued} limit=${limit} scanned=${summary.scanned ?? 0} ${fields.map(([name, value]) => `${name}=${Number(value) || 0}`).join(' ')}${ids.length ? ` ${ids.join(' ')}` : ''}`;
}

export const feedTranslationManifest = Object.freeze({
  id: 'feed.translation', version: '1.0.0',
  capabilities: ['feed.translation.run'], jobTypes: ['feed.translation.run'],
});

function translationKeyCount(env = process.env) {
  try {
    const count = resolveGemmaTranslationSlots(env).length;
    return count || 1;
  } catch {
    return 1;
  }
}

export function createFeedTranslationJobHandlers({ feedService, env = process.env } = {}) {
  return {
    'feed.translation.run': async (input, context) => {
      const value = FeedTranslationJobInputSchema.parse(input);
      const policy = gemmaTranslationPolicy(env);
      const callLimit = translationAttemptCallLimit({
        itemCount: value.items.length,
        keyCount: translationKeyCount(env),
        maxRetries: policy.maxRetries,
        configured: env.AI_CENTER_TRANSLATION_ATTEMPT_CALL_CAP,
      });
      const touch = () => {
        const job = context?.job;
        if (job && context?.store?.touchJob && context.workerId) context.store.touchJob(job.id, context.workerId);
      };
      try {
        touch();
        return await withTranslationCallBudget(callLimit, () => feedService.translateMany(value, {
          workspaceId: value.workspaceId,
          onItem: touch,
        }));
      } catch (error) {
        const failedIds = Array.isArray(error?.failedItemIds) ? error.failedItemIds.filter(Boolean) : [];
        const job = context?.job;
        const items = value.items.filter((item) => failedIds.includes(item.id));
        if (items.length && items.length < value.items.length && job && context?.store?.replaceRunningJobInput) {
          const replaced = context.store.replaceRunningJobInput(job.id, { ...value, items }, {
            workerId: context.workerId,
            attemptCount: job.attemptCount,
          });
          if (replaced) {
            console.log(`[worker] translation-batch saved=${value.items.length - items.length} retry=${items.length}`);
          }
        }
        throw error;
      }
    },
  };
}

export function packTranslationJobBatches(units, options = {}) {
  const requested = Number.isInteger(options.unitLimit) ? options.unitLimit : translationBodyBatchLimit(options.bodyBatchLimit);
  const unitLimit = Math.min(TRANSLATION_JOB_UNIT_LIMIT, Math.max(1, requested));
  const charBudget = translationBodyCharBudget(options.charBudget ?? options.bodyCharBudget);
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const unit of units) {
    const size = String(unit?.text || '').length;
    if (batch.length && (batch.length >= unitLimit || chars + size > charBudget)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(unit);
    chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function translationItemId(unit) {
  return unit.localizationId || unit.id;
}

export function demoteQueuedHashTranslationJobs(store, workspaceId = 'local') {
  if (!store?.listOpenJobs || !store?.reprioritizeQueuedJobs) return 0;
  const changes = [];
  for (const job of store.listOpenJobs('feed.translation.run') || []) {
    if (job.workspaceId !== workspaceId || job.status !== 'queued') continue;
    const priority = Number(job.priority) || 0;
    if (priority < 0) continue;
    const items = job.input?.items || [];
    if (items.length !== 1 || !String(items[0]?.id || '').startsWith('h:')) continue;
    changes.push({ id: job.id, priority: TRANSLATION_BACKFILL_PRIORITY, expectedPriority: priority });
  }
  if (!changes.length) return 0;
  const changed = store.reprioritizeQueuedJobs(workspaceId, changes);
  return Array.isArray(changed) ? changed.length : changes.length;
}

export async function enqueueOriginalTranslations({
  store, feedService, workspaceId, units, priority = 0, unitLimit, force = false,
}) {
  if (!store?.createJob || !feedService?.localizeTexts || !units?.length) return [];
  const state = await feedService.localizeTexts(units, { workspaceId }, { wait: false });
  const pending = new Set(state.pendingIds || []);
  const rank = Number.isFinite(priority) ? Math.trunc(priority) : 0;
  const eligible = units.filter((unit) => {
    if (!unit?.text || unit.text.length <= 0 || unit.text.length > FEED_TRANSLATION_TEXT_MAX) return false;
    if (pending.has(unit.id)) return true;
    if (!force) return false;
    const loc = state.localizations?.[unit.id];
    return Boolean(loc && loc.status !== 'ready');
  });
  const openJobs = (store.listOpenJobs?.('feed.translation.run') || []).filter((job) => job.workspaceId === workspaceId);
  const jobs = [];
  const seen = new Set();
  const fresh = [];
  const requested = new Set(eligible.map((unit) => translationItemId(unit)));
  const remember = (job) => {
    if (!job || seen.has(job.id)) return;
    seen.add(job.id);
    jobs.push(job);
  };
  for (const unit of eligible) {
    const open = openJobs.find((job) => (job.input?.items || []).some((item) => item?.id === translationItemId(unit)));
    if (!open) {
      fresh.push(unit);
      continue;
    }
    if (open.status === 'queued' && Number(open.priority) !== rank) {
      const current = Number(open.priority) || 0;
      const coversRequest = (open.input?.items || []).every((item) => requested.has(item.id));
      if (rank < 0 && current === 0 && coversRequest && store.reprioritizeQueuedJobs) {
        store.reprioritizeQueuedJobs(workspaceId, [{ id: open.id, priority: rank, expectedPriority: current }]);
        open.priority = rank;
      } else if (rank > current && store.prioritizeQueuedJobs) {
        store.prioritizeQueuedJobs(workspaceId, [open.id], rank);
        open.priority = rank;
      }
    }
    remember(open);
  }
  const batches = packTranslationJobBatches(fresh, { unitLimit });
  const cap = rank < 0 ? TRANSLATION_BULK_JOB_CAP : batches.length;
  for (const batch of batches.slice(0, cap)) {
    const input = FeedTranslationJobInputSchema.parse({
      workspaceId,
      items: batch.map((unit) => ({ id: translationItemId(unit), text: unit.text })),
    });
    const open = openJobs.find((job) => JSON.stringify(job.input) === JSON.stringify(input));
    const job = open || store.createJob({
      type: 'feed.translation.run', workspaceId, input, maxAttempts: TRANSLATION_MAX_ATTEMPTS, priority: rank,
    });
    if (!open) openJobs.push(job);
    remember(job);
  }
  return jobs;
}

export const TRANSLATION_GAP_FILL_INTERVAL_MS = 300_000;
export const TRANSLATION_GAP_FILL_LIMIT = 20;
export const TRANSLATION_GAP_FILL_WINDOW_MS = 72 * 60 * 60 * 1000;
export const TRANSLATION_GAP_SCAN_CAP = 400;
const TRANSLATION_GAP_PAGE_SIZE = 200;
export const TRANSLATION_GAP_RETRY_BASE_MS = 15 * 60 * 1000;
const TRANSLATION_GAP_RETRY_CAP_MS = 24 * 60 * 60 * 1000;
const TRANSLATION_GAP_WINDOW_MAX_MS = 30 * 24 * 60 * 60 * 1000;

export function translationGapFillIntervalMs(value) {
  if (value === undefined || value === null || String(value).trim() === '') return TRANSLATION_GAP_FILL_INTERVAL_MS;
  const raw = Number(value);
  if (!Number.isInteger(raw) || raw < 0) return TRANSLATION_GAP_FILL_INTERVAL_MS;
  if (raw === 0) return 0;
  return Math.min(86_400_000, Math.max(60_000, raw));
}

export function translationGapFillLimit(value) {
  if (value === undefined || value === null || String(value).trim() === '') return TRANSLATION_GAP_FILL_LIMIT;
  const raw = Number(value);
  if (!Number.isInteger(raw) || raw < 0) return TRANSLATION_GAP_FILL_LIMIT;
  return Math.min(TRANSLATION_BACKFILL_STARTUP_MAX, raw);
}

export function translationGapFillWindowMs(value) {
  if (value === undefined || value === null || String(value).trim() === '') return TRANSLATION_GAP_FILL_WINDOW_MS;
  const raw = Number(value);
  if (!Number.isInteger(raw) || raw < TRANSLATION_GAP_FILL_WINDOW_MS) return TRANSLATION_GAP_FILL_WINDOW_MS;
  return Math.min(TRANSLATION_GAP_WINDOW_MAX_MS, raw);
}

export function translationGapRetryBaseMs(value) {
  if (value === undefined || value === null || String(value).trim() === '') return TRANSLATION_GAP_RETRY_BASE_MS;
  const raw = Number(value);
  if (!Number.isInteger(raw) || raw < 60_000) return TRANSLATION_GAP_RETRY_BASE_MS;
  return Math.min(TRANSLATION_GAP_RETRY_CAP_MS, raw);
}

export function translationGapRetryDelayMs(attemptCount, base = TRANSLATION_GAP_RETRY_BASE_MS) {
  const extra = Math.max(0, Math.trunc(Number(attemptCount) || 0) - TRANSLATION_MAX_ATTEMPTS);
  const doubled = base * (2 ** extra);
  return Math.min(TRANSLATION_GAP_RETRY_CAP_MS, Number.isFinite(doubled) ? doubled : TRANSLATION_GAP_RETRY_CAP_MS);
}

export function translationGapRetryBlocked(failure, sourceHash, now = Date.now(), base = TRANSLATION_GAP_RETRY_BASE_MS) {
  if (!failure || failure.sourceHash !== sourceHash) return false;
  if (Number.isFinite(failure.nextRetryAt) && failure.nextRetryAt > now) return true;
  const updatedAt = Number(failure.updatedAt) || 0;
  return updatedAt + translationGapRetryDelayMs(failure.attemptCount, base) > now;
}

export async function backfillUntranslatedFeedTranslations({
  store, feedService, workspaceId = 'local', limit = TRANSLATION_BACKFILL_LIMIT, excludeSourceIds = [],
  includeTerminalFailures = false,
} = {}) {
  const repo = store?.repositories?.feed;
  const requested = Number(limit);
  const cap = Number.isInteger(requested) && requested >= 0
    ? Math.min(requested, 200)
    : TRANSLATION_BACKFILL_LIMIT;
  const summary = emptyBackfillSummary(cap);
  if (cap === 0 || !repo?.listUntranslatedFeedBodies || !feedService?.localizeTexts) return { jobs: [], summary };
  const flash = new Set((excludeSourceIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const rows = repo.listUntranslatedFeedBodies(workspaceId, {
    limit: cap,
    scan: Math.min(500, Math.max(cap * 5, cap)),
    excludeSourceIds,
  });
  summary.scanned = rows.length;
  summary.otherProvider = repo.countLongUntranslatedOutsideProviders?.(workspaceId) || 0;
  const units = [];
  for (const row of rows) {
    if (row.hidden) { noteSkip(summary, 'hidden', row.id); continue; }
    if (flash.has(row.sourceExternalId)) { noteSkip(summary, 'flash', row.id); continue; }
    let text = stripLeadingPreview(row.body || '');
    if (text && text !== String(row.body || '').trim() && repo.replaceContentBody?.(workspaceId, row.id, text)) {
      row.body = text;
    }
    if (!text) { noteSkip(summary, 'empty', row.id); continue; }
    if (text.length > FEED_TRANSLATION_TEXT_MAX) { noteSkip(summary, 'tooLong', row.id); continue; }
    const hash = bodyHash(text);
    const covered = translationCovers(row.translationHash, row.translationEngine, row.translationLength, text, hash, row.translationTail)
      || translationCovers(row.externalTranslationHash, row.externalTranslationEngine, row.externalTranslationLength, text, hash, row.externalTranslationTail);
    if (covered) {
      noteSkip(summary, 'translated', row.id);
      continue;
    }
    if (!needsZhLocalization(text)) { noteSkip(summary, 'cjk', row.id); continue; }
    const hourlyTitle = (row.translationEngine === 'hourly-report' && row.translationHash === hash)
      || (row.externalTranslationEngine === 'hourly-report' && row.externalTranslationHash === hash);
    if (hourlyTitle) noteSkip(summary, 'hourlyTitle', row.id);
    else if (row.translationHash || row.externalTranslationHash) noteSkip(summary, 'stale', row.id);
    units.push({ id: row.id, text });
    if (units.length >= cap) break;
  }
  if (!units.length) return { jobs: [], summary };
  const preview = await feedService.localizeTexts(units, { workspaceId }, { wait: false });
  const pending = new Set(preview?.pendingIds || []);
  const queued = [];
  for (const unit of units) {
    if (pending.has(unit.id)) { queued.push(unit); continue; }
    const loc = preview?.localizations?.[unit.id];
    if (includeTerminalFailures && loc?.status === 'failed') { queued.push(unit); continue; }
    if (loc?.engine === 'hourly-report') noteSkip(summary, 'hourlyTitle', unit.id);
    else if (loc?.status === 'failed') noteSkip(summary, 'failure', unit.id);
    else noteSkip(summary, 'translated', unit.id);
  }
  const jobs = queued.length
    ? await enqueueOriginalTranslations({
      store, feedService, workspaceId, units: queued, priority: TRANSLATION_BACKFILL_PRIORITY,
      force: includeTerminalFailures,
    })
    : [];
  summary.enqueued = jobs.length;
  return { jobs, summary };
}

function openTranslationJobs(store, workspaceId) {
  return (store?.listOpenJobs?.('feed.translation.run') || []).filter((job) => job.workspaceId === workspaceId);
}

function openTranslationItemIds(jobs) {
  const ids = new Set();
  for (const job of jobs || []) {
    for (const item of job.input?.items || []) {
      if (item?.id) ids.add(item.id);
    }
  }
  return ids;
}

function translationReady(row, text) {
  if (!row?.translatedText) return false;
  const hash = bodyHash(text);
  if (row.sourceHash !== hash) return false;
  return !translationLooksTruncated(text, String(row.translatedText).length, row.translatedText);
}

export function collectMediaTranslationGaps({
  entries = [], articleUnits = [], translations = [], failures = [], openIds = new Set(),
  limit = TRANSLATION_GAP_FILL_LIMIT, now = Date.now(), retryBaseMs = TRANSLATION_GAP_RETRY_BASE_MS,
} = {}) {
  const open = openIds instanceof Set ? openIds : new Set(openIds || []);
  const byId = new Map((translations || []).map((row) => [row.itemId, row]));
  const failureById = failures instanceof Map ? failures : new Map((failures || []).map((row) => [row.itemId, row]));
  const cap = Math.max(0, Number(limit) || 0);
  const selected = [];
  const seen = new Set();
  function consider(unit) {
    if (selected.length >= cap) return;
    const id = String(unit?.localizationId || unit?.id || '').trim();
    const text = String(unit?.text || '').trim();
    if (!id || !text || seen.has(id) || open.has(id)) return;
    if (!needsZhLocalization(text) || text.length > FEED_TRANSLATION_TEXT_MAX) return;
    if (translationReady(byId.get(id), text)) return;
    if (translationGapRetryBlocked(failureById.get(id), bodyHash(text), now, retryBaseMs)) return;
    seen.add(id);
    selected.push({
      id,
      localizationId: id,
      externalId: unit.externalId || '',
      text,
      kind: unit.kind || '',
      paragraphId: unit.paragraphId || '',
    });
  }
  const titles = [];
  const bodies = [];
  for (const unit of articleUnits || []) {
    if (unit?.kind === 'heading' || unit?.paragraphId === 'title') titles.push(unit);
    else bodies.push(unit);
  }
  for (const entry of entries || []) {
    if (entry?.contentLevel === 'full') continue;
    const text = String(entry?.title || '').trim();
    if (!text || !entry?.externalId) continue;
    titles.push({
      id: localizationItemId(`media:${entry.externalId}`),
      externalId: entry.externalId,
      text,
      kind: 'heading',
      paragraphId: 'title',
    });
  }
  for (const unit of [...titles, ...bodies]) consider(unit);
  return selected;
}

function createdJobs(before, jobs) {
  const known = new Set((before || []).map((job) => job.id));
  return (jobs || []).filter((job) => job?.id && !known.has(job.id));
}

function entrySortAt(entry) {
  return Number(entry?.publishedAt || entry?.observedAt || 0);
}

function numericCursor(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function gapFillTurn(yieldTurn) {
  if (typeof yieldTurn === 'function') return Promise.resolve(yieldTurn());
  return new Promise((resolve) => { setImmediate(resolve); });
}

async function scanMediaGaps({
  store, mediaService, workspaceId, openIds, since, cursor, limit, now, retryBaseMs, yieldTurn,
}) {
  const repo = store.repositories?.media;
  if (!repo?.listEntriesSince || limit <= 0) return { units: [], scanned: 0, cursor: cursor || null };
  const flashIds = new Set();
  const initialSortAt = numericCursor(cursor?.sortAt);
  let scanCursor = initialSortAt == null ? null : { sortAt: initialSortAt, externalId: String(cursor?.externalId || '') };
  const startedMidWindow = scanCursor != null;
  let wrapped = false;
  let scanned = 0;
  const selected = [];
  while (selected.length < limit && scanned < TRANSLATION_GAP_SCAN_CAP) {
    await gapFillTurn(yieldTurn);
    const page = repo.listEntriesSince(workspaceId, {
      since,
      beforeSortAt: scanCursor?.sortAt ?? null,
      beforeExternalId: scanCursor?.externalId || '',
      limit: TRANSLATION_GAP_PAGE_SIZE,
    }) || [];
    if (!page.length) {
      if (startedMidWindow && scanCursor && !wrapped) { scanCursor = null; wrapped = true; continue; }
      scanCursor = null;
      break;
    }
    scanned += page.length;
    let entries = page;
    if (mediaService?.flashExternalIds) {
      const flash = mediaService.flashExternalIds(workspaceId, entries.map((entry) => entry.externalId)) || [];
      for (const id of flash) flashIds.add(id);
      entries = entries.filter((entry) => !flashIds.has(entry.externalId));
    }
    const fullIds = entries.filter((entry) => entry.contentLevel === 'full').map((entry) => entry.externalId);
    let articleUnits = [];
    if (fullIds.length && mediaService?.listArticleTranslationUnits) {
      try { articleUnits = mediaService.listArticleTranslationUnits(workspaceId, fullIds) || []; }
      catch { articleUnits = []; }
    }
    const translationIds = [
      ...articleUnits.map((unit) => unit.localizationId || unit.id),
      ...entries.filter((entry) => entry.contentLevel !== 'full' && entry.externalId).map((entry) => localizationItemId(`media:${entry.externalId}`)),
    ];
    const translations = translationIds.length
      ? (store.repositories?.feed?.listTranslations?.(workspaceId, translationIds, 'zh') || [])
      : [];
    const failures = translationIds.length
      ? (store.repositories?.feed?.listTranslationFailures?.(workspaceId, translationIds, 'zh') || [])
      : [];
    const gaps = collectMediaTranslationGaps({
      entries, articleUnits, translations, failures, openIds, limit: limit - selected.length, now, retryBaseMs,
    });
    selected.push(...gaps);
    if (selected.length >= limit) {
      const lastUnit = gaps[gaps.length - 1];
      const lastEntry = entries.find((entry) => entry.externalId === lastUnit?.externalId) || page[page.length - 1];
      scanCursor = { sortAt: entrySortAt(lastEntry), externalId: lastEntry?.externalId || '' };
      break;
    }
    const last = page[page.length - 1];
    scanCursor = { sortAt: entrySortAt(last), externalId: last.externalId };
    if (page.length < TRANSLATION_GAP_PAGE_SIZE || scanned >= TRANSLATION_GAP_SCAN_CAP) {
      if (page.length < TRANSLATION_GAP_PAGE_SIZE && startedMidWindow && !wrapped) { scanCursor = null; wrapped = true; continue; }
      if (page.length < TRANSLATION_GAP_PAGE_SIZE) scanCursor = null;
      break;
    }
  }
  return { units: selected, scanned, cursor: scanCursor };
}

async function scanFeedGaps({
  store, workspaceId, openIds, since, cursor, limit, now, retryBaseMs, excludeSourceIds, yieldTurn,
}) {
  const repo = store.repositories?.feed;
  if (!repo?.listFeedBodiesSince || limit <= 0) return { units: [], scanned: 0, cursor: cursor || null };
  const flash = new Set((excludeSourceIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const initialCreatedAt = numericCursor(cursor?.createdAt);
  let scanCursor = initialCreatedAt == null ? null : { createdAt: initialCreatedAt, id: String(cursor?.id || '') };
  const startedMidWindow = scanCursor != null;
  let wrapped = false;
  let scanned = 0;
  const selected = [];
  while (selected.length < limit && scanned < TRANSLATION_GAP_SCAN_CAP) {
    await gapFillTurn(yieldTurn);
    const page = repo.listFeedBodiesSince(workspaceId, {
      since,
      beforeCreatedAt: scanCursor?.createdAt ?? null,
      beforeId: scanCursor?.id || '',
      limit: TRANSLATION_GAP_PAGE_SIZE,
    }) || [];
    if (!page.length) {
      if (startedMidWindow && scanCursor && !wrapped) { scanCursor = null; wrapped = true; continue; }
      scanCursor = null;
      break;
    }
    scanned += page.length;
    const ids = page.flatMap((row) => [row.id, row.provider && row.externalId ? `${row.provider}:${row.externalId}` : ''].filter(Boolean));
    const translations = ids.length ? (repo.listTranslations?.(workspaceId, ids, 'zh') || []) : [];
    const failures = ids.length ? (repo.listTranslationFailures?.(workspaceId, ids, 'zh') || []) : [];
    const byId = new Map(translations.map((row) => [row.itemId, row]));
    const failureById = new Map(failures.map((row) => [row.itemId, row]));
    for (const row of page) {
      if (selected.length >= limit) break;
      if (row.hidden || flash.has(row.sourceExternalId)) continue;
      const text = stripLeadingPreview(row.body || '');
      if (!text || text.length > FEED_TRANSLATION_TEXT_MAX || !needsZhLocalization(text)) continue;
      const externalId = row.provider && row.externalId ? `${row.provider}:${row.externalId}` : '';
      if (translationReady(byId.get(row.id), text) || (externalId && translationReady(byId.get(externalId), text))) continue;
      if (openIds.has(row.id) || (externalId && openIds.has(externalId))) continue;
      if (translationGapRetryBlocked(failureById.get(row.id), bodyHash(text), now, retryBaseMs)) continue;
      selected.push({ id: row.id, localizationId: row.id, text });
    }
    if (selected.length >= limit) {
      const last = page.find((row) => row.id === selected[selected.length - 1].id) || page[page.length - 1];
      scanCursor = { createdAt: last.createdAt, id: last.id };
      break;
    }
    const last = page[page.length - 1];
    scanCursor = { createdAt: last.createdAt, id: last.id };
    if (page.length < TRANSLATION_GAP_PAGE_SIZE || scanned >= TRANSLATION_GAP_SCAN_CAP) {
      if (page.length < TRANSLATION_GAP_PAGE_SIZE && startedMidWindow && !wrapped) { scanCursor = null; wrapped = true; continue; }
      if (page.length < TRANSLATION_GAP_PAGE_SIZE) scanCursor = null;
      break;
    }
  }
  return { units: selected, scanned, cursor: scanCursor };
}

export async function fillUncoveredTranslations({
  store, feedService, mediaService, workspaceId = 'local', limit = TRANSLATION_GAP_FILL_LIMIT,
  excludeSourceIds = [], titleBatchLimit, cursor = null, now = Date.now(), windowMs, retryBaseMs,
  yieldTurn,
} = {}) {
  const requested = Number(limit);
  const cap = Number.isInteger(requested) && requested >= 0
    ? Math.min(requested, TRANSLATION_BACKFILL_STARTUP_MAX)
    : TRANSLATION_GAP_FILL_LIMIT;
  const empty = { jobs: [], enqueued: 0, scanned: 0, media: 0, feed: 0, limit: cap, cursor: cursor || null };
  if (cap === 0 || !store || !feedService?.localizeTexts) return empty;
  const window = translationGapFillWindowMs(windowMs ?? process.env.AI_CENTER_TRANSLATION_GAP_FILL_WINDOW_MS);
  const retryBase = translationGapRetryBaseMs(retryBaseMs ?? process.env.AI_CENTER_TRANSLATION_GAP_RETRY_BASE_MS);
  const since = now - window;
  const before = openTranslationJobs(store, workspaceId);
  const openIds = openTranslationItemIds(before);
  const mediaScan = await scanMediaGaps({
    store, mediaService, workspaceId, openIds, since, cursor: cursor?.media || null,
    limit: cap, now, retryBaseMs: retryBase, yieldTurn,
  });
  const titleLimit = translationTitleBatchLimit(titleBatchLimit ?? process.env.AI_CENTER_TRANSLATION_TITLE_BATCH_LIMIT);
  const titleUnits = mediaScan.units.filter((unit) => unit.kind === 'heading' || unit.paragraphId === 'title');
  const bodyUnits = mediaScan.units.filter((unit) => unit.kind !== 'heading' && unit.paragraphId !== 'title');
  const mediaJobs = [];
  if (titleUnits.length) {
    mediaJobs.push(...await enqueueOriginalTranslations({
      store, feedService, workspaceId, units: titleUnits, priority: TRANSLATION_BACKFILL_PRIORITY,
      unitLimit: titleLimit, force: true,
    }));
  }
  if (bodyUnits.length) {
    mediaJobs.push(...await enqueueOriginalTranslations({
      store, feedService, workspaceId, units: bodyUnits, priority: TRANSLATION_BACKFILL_PRIORITY, force: true,
    }));
  }
  const feedScan = await scanFeedGaps({
    store, workspaceId, openIds, since, cursor: cursor?.feed || null,
    limit: Math.max(0, cap - mediaScan.units.length), now, retryBaseMs: retryBase, excludeSourceIds,
    yieldTurn,
  });
  const feedJobs = feedScan.units.length
    ? await enqueueOriginalTranslations({
      store, feedService, workspaceId, units: feedScan.units, priority: TRANSLATION_BACKFILL_PRIORITY, force: true,
    })
    : [];
  const jobs = createdJobs(before, [...mediaJobs, ...feedJobs]);
  return {
    jobs,
    enqueued: jobs.length,
    scanned: mediaScan.scanned + feedScan.scanned,
    media: createdJobs(before, mediaJobs).length,
    feed: createdJobs(before, feedJobs).length,
    limit: cap,
    cursor: { media: mediaScan.cursor, feed: feedScan.cursor },
  };
}

export function repairEllipsisLeadTexts({
  store, workspaceId = 'local', limit = TRANSLATION_BACKFILL_LIMIT,
} = {}) {
  const repo = store?.repositories?.feed;
  const requested = Number(limit);
  const cap = Number.isInteger(requested) && requested >= 0
    ? Math.min(requested, TRANSLATION_BACKFILL_STARTUP_MAX)
    : TRANSLATION_BACKFILL_LIMIT;
  if (cap === 0 || !repo?.listEllipsisLeadBodies || !repo?.listEllipsisLeadTranslations || !repo?.saveTranslations) {
    return { bodies: 0, translations: 0 };
  }
  const cleanedByItem = new Map();
  let bodies = 0;
  for (const row of repo.listEllipsisLeadBodies(workspaceId, { limit: 400 })) {
    if (bodies >= cap) break;
    const cleaned = stripLeadingPreview(row.body || '');
    if (!cleaned || cleaned === String(row.body || '')) continue;
    if (!repo.replaceContentBody?.(workspaceId, row.id, cleaned)) continue;
    bodies += 1;
    const fix = { previousHash: bodyHash(row.body || ''), nextHash: bodyHash(cleaned) };
    cleanedByItem.set(row.id, fix);
    if (row.provider && row.externalId) cleanedByItem.set(`${row.provider}:${row.externalId}`, fix);
  }
  let translations = 0;
  for (const row of repo.listEllipsisLeadTranslations(workspaceId, { limit: 400 })) {
    if (translations >= cap) break;
    const cleaned = stripLeadingPreview(row.translatedText || '');
    if (!cleaned || !row.itemId || !row.sourceHash || cleaned === String(row.translatedText || '')) continue;
    const fix = cleanedByItem.get(row.itemId);
    const sourceHash = fix && row.sourceHash === fix.previousHash ? fix.nextHash : row.sourceHash;
    repo.saveTranslations([{
      workspaceId,
      itemId: row.itemId,
      targetLang: row.targetLang === 'en' ? 'en' : 'zh',
      sourceHash,
      translatedText: cleaned,
      engine: row.engine || '',
    }]);
    translations += 1;
  }
  return { bodies, translations };
}
