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

export function ensureSourceAuthorItem(feed, input = {}) {
  const profile = sourceAuthorProfile(input.sourceKey);
  const externalId = String(input.externalId || '').trim().slice(0, 400);
  if (!profile || !externalId || !feed?.getCapture || !feed?.saveCapture || !feed?.saveContentItem || !feed?.upsertSourceAccount) {
    return null;
  }
  const workspaceId = input.workspaceId || 'local';
  const publishedAt = positiveTime(input.publishedAt);
  const sourceUrl = String(input.sourceUrl || '').trim();
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
      status: 'ready',
      publishedAt,
      metadata: {
        sourceKey: profile.nativeId,
        sourceId: profile.sourceId || '',
        lane: profile.platform,
        publishedAtRaw: input.publishedAtRaw || '',
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

export function officialReleaseExternalId(sourceKey, release) {
  const fromUrl = stableArticleId(sourceKey, { link: release?.sourceUrl || '' });
  if (fromUrl) return fromUrl.slice(0, 400);
  const releaseId = String(release?.releaseId || '').trim();
  return releaseId ? `${sourceKey}:release:${releaseId}`.slice(0, 400) : '';
}

export function syncOfficialReleases(feed, workspaceId, releases, releaseSourceIds = {}) {
  let linked = 0;
  for (const release of releases || []) {
    const source = officialAuthorForRelease(release, releaseSourceIds);
    const externalId = source ? officialReleaseExternalId(source.sourceKey, release) : '';
    if (!source || !externalId) continue;
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
      });
      if (result) linked += 1;
    } catch (error) {
      console.error('[authors] 官方来源未挂上:', error instanceof Error ? error.message : error);
    }
  }
  return { linked };
}
