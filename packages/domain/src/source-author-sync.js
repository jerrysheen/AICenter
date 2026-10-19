import { createHash } from 'node:crypto';
import { stableArticleId } from '../../connectors/src/media/article-url.js';
import { createOfficialSourcesClient } from '../../connectors/src/official-sources.js';
import { officialAuthorForRelease, sourceAuthorProfile } from './source-authors.js';

export function officialDetailReader(options = {}) {
  const client = createOfficialSourcesClient(options);
  return (input) => client.detail(input);
}

function contentHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function positiveTime(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? Math.trunc(time) : null;
}

export const OFFICIAL_MIN_BODY_LENGTH = 80;

export function officialBodyLength(text) {
  return [...String(text || '')].length;
}

function admittedOfficialBody(metadata = {}) {
  return metadata.filterDecision === 'KEEP' && metadata.filterApplied !== true && metadata.filterApplied !== 1;
}

export function officialBodyAction({ body = '', metadata = {} } = {}) {
  const length = officialBodyLength(body);
  if (length >= OFFICIAL_MIN_BODY_LENGTH) {
    return metadata.filterReason === 'body-too-short' ? 'clear' : 'keep';
  }
  if (admittedOfficialBody(metadata)) return 'keep';
  if (metadata.filterReason === 'body-too-short' && metadata.filterDecision === 'REVIEW' && metadata.filterApplied) return 'unchanged';
  return 'hide';
}

function shortOfficialMetadata(metadata = {}) {
  return {
    ...metadata,
    filterMode: 'enforce',
    filterDecision: 'REVIEW',
    filterReason: 'body-too-short',
    filterApplied: true,
    filterReviewKind: 'missing-content',
  };
}

function clearedOfficialMetadata(metadata = {}) {
  if (metadata.filterReason !== 'body-too-short') return metadata;
  return {
    ...metadata,
    filterMode: '',
    filterDecision: '',
    filterReason: '',
    filterApplied: false,
    filterReviewKind: 'none',
  };
}

function releaseShortOfficialLatch(feed, capture, body) {
  if (!capture || !feed?.saveCapture) return;
  if (officialBodyAction({ body, metadata: capture.metadata }) !== 'clear') return;
  feed.saveCapture({
    workspaceId: capture.workspaceId,
    provider: capture.provider || 'media',
    externalId: capture.externalId,
    sourceAccountId: capture.sourceAccountId,
    sourceUrl: capture.sourceUrl || '',
    title: capture.title || '',
    contentHash: capture.contentHash,
    rawArtifactPath: capture.rawArtifactPath,
    status: 'ready',
    publishedAt: capture.publishedAt,
    capturedAt: capture.capturedAt,
    metadata: clearedOfficialMetadata(capture.metadata),
  });
}

function sourceHost(value) {
  try {
    return new URL(String(value || '')).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'unknown';
  }
}

export function ensureSourceAuthorItem(feed, input = {}) {
  const profile = sourceAuthorProfile(input.sourceKey);
  const externalId = String(input.externalId || '').trim().slice(0, 400);
  if (!profile || !externalId || !feed?.getCapture || !feed?.saveCapture || !feed?.saveContentItem || !feed?.upsertSourceAccount) {
    return null;
  }
  const workspaceId = input.workspaceId || 'local';
  const publishedAt = positiveTime(input.publishedAt);
  const sourceUrl = String(input.sourceUrl || '').trim();
  const body = String(input.body || '');
  const official = profile.platform === 'official' || input.officialMirror === true;
  const gate = official && officialBodyAction({ body, metadata: {} }) === 'hide';
  let capture = feed.getCapture(workspaceId, 'media', externalId);
  if (!capture) {
    const account = feed.upsertSourceAccount({
      workspaceId,
      provider: 'media',
      externalId: `media:${profile.nativeId}`,
      displayName: profile.name,
      profileUrl: profile.profileUrl || sourceUrl,
      authMode: 'public',
      metadata: { sourceKey: profile.nativeId, sourceId: profile.sourceId || '', lane: profile.platform },
    });
    capture = feed.saveCapture({
      workspaceId,
      provider: 'media',
      externalId,
      sourceAccountId: account.id,
      sourceUrl,
      title: input.title || '',
      contentHash: String(input.contentHash || '').trim() || contentHash(`${profile.nativeId}:${externalId}`),
      status: gate ? 'captured' : 'ready',
      publishedAt,
      metadata: gate ? shortOfficialMetadata({
        sourceKey: profile.nativeId,
        sourceId: profile.sourceId || '',
        lane: profile.platform,
        publishedAtRaw: input.publishedAtRaw || '',
        ...(input.officialMirror ? { officialMirror: true } : {}),
      }) : {
        sourceKey: profile.nativeId,
        sourceId: profile.sourceId || '',
        lane: profile.platform,
        publishedAtRaw: input.publishedAtRaw || '',
        ...(input.officialMirror ? { officialMirror: true } : {}),
      },
    });
  }
  const existing = feed.getContentItemByCapture?.(workspaceId, capture.id) || null;
  if (!existing) {
    const saved = feed.saveContentItem({
      workspaceId,
      captureId: capture.id,
      originType: 'subscription',
      contentType: 'article',
      title: input.title || '',
      body,
      summary: input.summary || '',
      sourceUrl,
      authorName: profile.name,
      publishedAt,
    });
    return {
      authorId: profile.authorId,
      created: true,
      contentItemId: saved?.id || '',
      bodyFilled: Boolean(body.trim()),
    };
  }
  let bodyFilled = false;
  if (!String(existing.body || '').trim() && body.trim() && feed.replaceContentBody?.(workspaceId, existing.id, body)) {
    bodyFilled = true;
    releaseShortOfficialLatch(feed, capture, body);
  }
  if (publishedAt && !capture.publishedAt && feed.touchPublishedAt) {
    feed.touchPublishedAt(workspaceId, 'media', externalId, publishedAt);
  }
  feed.relinkCapturedAuthor?.(workspaceId, capture.id, {
    publishedAt,
    publishedAtRaw: input.publishedAtRaw || '',
    title: input.title || existing.title || '',
  });
  return { authorId: profile.authorId, created: false, contentItemId: existing.id, bodyFilled };
}

export function officialArticleExternalId(sourceKey, release) {
  const fromUrl = stableArticleId(sourceKey, { link: release?.sourceUrl || '' });
  return fromUrl ? fromUrl.slice(0, 400) : '';
}

export function officialReleaseExternalId(sourceKey, release) {
  const key = String(sourceKey || '').trim();
  const articleId = officialArticleExternalId(key, release);
  const releaseId = String(release?.releaseId || '').trim();
  const id = articleId || (releaseId ? `${key}:release:${releaseId}` : '');
  if (!key || !id) return '';
  return `official-board:${key}:${id}`.slice(0, 400);
}

function storedBody(feed, workspaceId, capture) {
  if (!capture) return '';
  return String(feed.getContentItemByCapture?.(workspaceId, capture.id)?.body || '');
}

export async function syncOfficialReleases(feed, workspaceId, releases, releaseSourceIds = {}, {
  readDetail = null,
  detailDelayMs = 0,
} = {}) {
  let linked = 0;
  let bodies = 0;
  const pause = Math.max(0, Number(detailDelayMs) || 0);
  for (const release of releases || []) {
    const source = officialAuthorForRelease(release, releaseSourceIds);
    if (!source) continue;
    const articleId = officialArticleExternalId(source.sourceKey, release);
    const real = articleId ? feed.getCapture(workspaceId, 'media', articleId) : null;
    const externalId = real && real.metadata?.officialMirror !== true
      ? articleId
      : officialReleaseExternalId(source.sourceKey, release);
    if (!externalId) continue;
    const target = externalId === articleId ? real : feed.getCapture(workspaceId, 'media', externalId);
    let body = '';
    let summary = release.authority || '';
    let fetched = false;
    if (!storedBody(feed, workspaceId, target).trim() && typeof readDetail === 'function' && release.sourceUrl) {
      fetched = true;
      try {
        const detail = await readDetail({ sourceUrl: release.sourceUrl });
        body = String(detail?.bodyText || '').trim();
        const officialSummary = String(detail?.officialSummary || '').trim();
        if (officialSummary) summary = officialSummary;
      } catch (error) {
        console.error('[authors] 官方正文未读到:', error instanceof Error ? error.message : error);
      }
    }
    try {
      const result = ensureSourceAuthorItem(feed, {
        workspaceId,
        sourceKey: source.sourceKey,
        externalId,
        title: release.title || '',
        body,
        summary,
        sourceUrl: release.sourceUrl || '',
        publishedAt: release.publishedAt,
        contentHash: contentHash(`official:${release.releaseId || externalId}`),
        officialMirror: externalId !== articleId,
      });
      if (result) linked += 1;
      if (result?.bodyFilled) bodies += 1;
    } catch (error) {
      console.error('[authors] 官方来源未挂上:', error instanceof Error ? error.message : error);
    }
    if (fetched && pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
  return { linked, bodies };
}

export function hideShortOfficialItems(store, { dryRun = false, workspaceId = 'local', limit = 200 } = {}) {
  const feed = store?.repositories?.feed;
  if (!feed?.listOfficialLaneItems || !feed.saveCapture) throw new Error('官方正文回填需要 feed repository');
  const counts = { scanned: 0, hidden: 0, cleared: 0, unchanged: 0, dryRun: Boolean(dryRun) };
  let afterId = '';
  const page = Math.max(1, Math.min(500, Number(limit) || 200));
  for (;;) {
    const rows = feed.listOfficialLaneItems(workspaceId, { afterId, limit: page });
    if (!rows.length) break;
    for (const row of rows) {
      counts.scanned += 1;
      const action = officialBodyAction(row);
      if (action === 'hide') {
        counts.hidden += 1;
        if (!dryRun) {
          feed.saveCapture({
            workspaceId,
            provider: 'media',
            externalId: row.externalId,
            sourceAccountId: row.sourceAccountId,
            sourceUrl: row.sourceUrl,
            title: row.title,
            contentHash: row.contentHash,
            rawArtifactPath: row.rawArtifactPath,
            status: 'captured',
            publishedAt: row.publishedAt,
            capturedAt: row.capturedAt,
            metadata: shortOfficialMetadata(row.metadata),
          });
        }
      } else if (action === 'clear') {
        counts.cleared += 1;
        if (!dryRun) {
          feed.saveCapture({
            workspaceId,
            provider: 'media',
            externalId: row.externalId,
            sourceAccountId: row.sourceAccountId,
            sourceUrl: row.sourceUrl,
            title: row.title,
            contentHash: row.contentHash,
            rawArtifactPath: row.rawArtifactPath,
            status: 'ready',
            publishedAt: row.publishedAt,
            capturedAt: row.capturedAt,
            metadata: clearedOfficialMetadata(row.metadata),
          });
        }
      } else counts.unchanged += 1;
    }
    afterId = rows.at(-1).captureId;
    if (rows.length < page) break;
  }
  return counts;
}

export async function backfillOfficialBodies(store, {
  dryRun = false,
  workspaceId = 'local',
  limit = 0,
  sleepMs = 200,
  readDetail = null,
  onItem,
} = {}) {
  const feed = store?.repositories?.feed;
  if (!feed?.listEmptyOfficialBodies || !feed.replaceContentBody) throw new Error('官方正文回填需要 feed repository');
  const cap = Math.max(0, Number(limit) || 0);
  const pause = Math.max(0, Number(sleepMs) || 0);
  const pageSize = 40;
  const counts = { scanned: 0, filled: 0, missed: 0, unchanged: 0, dryRun: Boolean(dryRun), hosts: {} };
  let afterId = '';
  for (;;) {
    const room = cap ? Math.min(pageSize, cap - counts.scanned) : pageSize;
    if (room <= 0) break;
    const rows = feed.listEmptyOfficialBodies(workspaceId, { afterId, limit: room });
    if (!rows.length) break;
    for (const row of rows) {
      counts.scanned += 1;
      const host = sourceHost(row.sourceUrl);
      counts.hosts[host] = (counts.hosts[host] || 0) + 1;
      if (dryRun) {
        onItem?.({ dryRun: true, id: row.contentItemId, host, title: row.title, sourceUrl: row.sourceUrl });
        continue;
      }
      const rest = async () => {
        if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
      };
      let body = '';
      try {
        if (typeof readDetail !== 'function' || !row.sourceUrl) throw new Error('没有正文读取器或来源地址');
        const detail = await readDetail({ sourceUrl: row.sourceUrl });
        body = String(detail?.bodyText || '').trim();
      } catch (error) {
        counts.missed += 1;
        onItem?.({
          id: row.contentItemId,
          host,
          title: row.title,
          sourceUrl: row.sourceUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        await rest();
        continue;
      }
      if (!body) {
        counts.missed += 1;
        onItem?.({ id: row.contentItemId, host, title: row.title, sourceUrl: row.sourceUrl, error: '官方页面没有正文' });
        await rest();
        continue;
      }
      const wrote = feed.replaceContentBody(workspaceId, row.contentItemId, body);
      if (!wrote) {
        counts.unchanged += 1;
        await rest();
        continue;
      }
      try {
        releaseShortOfficialLatch(feed, {
          workspaceId,
          provider: 'media',
          externalId: row.externalId,
          sourceAccountId: row.sourceAccountId,
          sourceUrl: row.sourceUrl,
          title: row.title,
          contentHash: row.contentHash,
          rawArtifactPath: row.rawArtifactPath,
          publishedAt: row.publishedAt,
          capturedAt: row.capturedAt,
          metadata: row.metadata,
        }, body);
      } catch (error) {
        console.error('[authors] 官方正文门闩未解开:', error instanceof Error ? error.message : error);
      }
      counts.filled += 1;
      onItem?.({ id: row.contentItemId, host, title: row.title, sourceUrl: row.sourceUrl, filled: true, chars: officialBodyLength(body) });
      await rest();
    }
    afterId = rows.at(-1).contentItemId;
    if (rows.length < room) break;
  }
  return counts;
}
