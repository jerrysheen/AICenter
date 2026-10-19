import { createHash } from 'node:crypto';
import { stableArticleId } from '../../connectors/src/media/article-url.js';
import { officialAuthorForRelease, sourceAuthorProfile } from './source-authors.js';

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
      body: input.body || '',
      summary: input.summary || '',
      sourceUrl,
      authorName: profile.name,
      publishedAt,
    });
    return { authorId: profile.authorId, created: true, contentItemId: saved?.id || '' };
  }
  if (publishedAt && !capture.publishedAt && feed.touchPublishedAt) {
    feed.touchPublishedAt(workspaceId, 'media', externalId, publishedAt);
  }
  feed.relinkCapturedAuthor?.(workspaceId, capture.id, {
    publishedAt,
    publishedAtRaw: input.publishedAtRaw || '',
    title: input.title || existing.title || '',
  });
  return { authorId: profile.authorId, created: false, contentItemId: existing.id };
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

export function syncOfficialReleases(feed, workspaceId, releases, releaseSourceIds = {}) {
  let linked = 0;
  for (const release of releases || []) {
    const source = officialAuthorForRelease(release, releaseSourceIds);
    if (!source) continue;
    const articleId = officialArticleExternalId(source.sourceKey, release);
    const real = articleId ? feed.getCapture(workspaceId, 'media', articleId) : null;
    const externalId = real && real.metadata?.officialMirror !== true
      ? articleId
      : officialReleaseExternalId(source.sourceKey, release);
    if (!externalId) continue;
    try {
      const result = ensureSourceAuthorItem(feed, {
        workspaceId,
        sourceKey: source.sourceKey,
        externalId,
        title: release.title || '',
        summary: release.authority || '',
        sourceUrl: release.sourceUrl || '',
        publishedAt: release.publishedAt,
        contentHash: contentHash(`official:${release.releaseId || externalId}`),
        officialMirror: externalId !== articleId,
      });
      if (result) linked += 1;
    } catch (error) {
      console.error('[authors] 官方来源未挂上:', error instanceof Error ? error.message : error);
    }
  }
  return { linked };
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
