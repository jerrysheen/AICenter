import { createHash } from 'node:crypto';
import { authorCaptureFields } from './authors.js';

export function dynamicExternalId(id) {
  const raw = String(id || '').trim();
  return raw ? `dyn:${raw}` : '';
}

function httpUrl(value, fallback) {
  const text = String(value || '').trim();
  if (/^https?:\/\//i.test(text)) return text;
  return fallback;
}

export function dynamicFeedItem(record) {
  const externalId = dynamicExternalId(record?.id);
  if (!externalId) return null;
  const authorName = String(record.author || '').trim();
  const mid = String(record.authorMid || '').trim();
  const quoted = record.orig
    ? `${record.orig.author || ''}: ${record.orig.title || record.orig.text || ''}`.trim()
    : '';
  const body = [record.text || record.title || '', quoted].filter(Boolean).join('\n\n').trim();
  const publishedSeconds = Number(record.pubTs) || 0;
  const publishedAt = publishedSeconds > 0 ? publishedSeconds * 1000 : null;
  const sourceUrl = httpUrl(
    record.jumpUrl,
    mid ? `https://space.bilibili.com/${mid}/dynamic` : `https://t.bilibili.com/${String(record.id)}`,
  );
  const fields = authorCaptureFields('bilibili', {
    authorNativeId: mid,
    authorName,
    authorHandle: mid,
    authorProfileUrl: mid ? `https://space.bilibili.com/${mid}` : '',
  });
  return {
    externalId,
    authorName: authorName || 'B站',
    authorHandle: mid ? `@${mid}` : '',
    authorNativeId: fields?.authorNativeId || '',
    authorProfile: fields?.authorProfile || null,
    title: String(record.title || body || 'B站动态').slice(0, 48),
    summary: body.slice(0, 160),
    body,
    sourceUrl,
    publishedAt,
  };
}

export function ingestBilibiliDynamics(feedRepository, workspaceId, records = []) {
  let added = 0;
  let skipped = 0;
  for (const record of records) {
    const item = dynamicFeedItem(record);
    if (!item || !feedRepository?.saveCapture || !feedRepository?.saveContentItem) {
      skipped += 1;
      continue;
    }
    const hash = createHash('sha256').update(`${item.externalId}\n${item.body}`).digest('hex');
    const capture = feedRepository.saveCapture({
      workspaceId,
      provider: 'bilibili',
      externalId: item.externalId,
      sourceUrl: item.sourceUrl,
      title: item.title,
      contentHash: hash,
      status: 'ready',
      publishedAt: item.publishedAt,
      authorNativeId: item.authorNativeId || null,
      metadata: {
        ...(item.authorHandle ? { authorHandle: item.authorHandle } : {}),
        ...(item.authorProfile ? { authorProfile: item.authorProfile } : {}),
        dynamic: true,
      },
    });
    feedRepository.saveContentItem({
      workspaceId,
      captureId: capture.id,
      originType: 'import',
      contentType: 'post',
      title: item.title,
      body: item.body,
      summary: item.summary,
      sourceUrl: item.sourceUrl,
      authorName: item.authorName,
      publishedAt: item.publishedAt,
    });
    added += 1;
  }
  return { added, skipped };
}
