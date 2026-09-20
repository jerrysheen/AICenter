import { createHash } from 'node:crypto';

export function normalizeFeedIdentityAuthor({ authorHandle = '', authorName = '' } = {}) {
  const handle = String(authorHandle || '').replace(/^@/, '').trim().toLocaleLowerCase();
  if (handle) return handle;
  return String(authorName || '').trim().toLocaleLowerCase();
}

export function normalizeFeedIdentityText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .toLocaleLowerCase();
}

export function computeFeedIdentityHash({
  provider,
  authorHandle,
  authorName,
  text,
  externalId,
} = {}) {
  const author = normalizeFeedIdentityAuthor({ authorHandle, authorName });
  let body = normalizeFeedIdentityText(text);
  if (!body && String(externalId || '').trim()) {
    body = `external:${String(externalId).trim()}`;
  }
  return createHash('sha256')
    .update(`${String(provider || '').trim().toLocaleLowerCase()}\n${author}\n${body}`)
    .digest('hex');
}

export function feedItemIdentityInput(providerId, item = {}) {
  const metadata = item.captureMetadata && typeof item.captureMetadata === 'object'
    ? item.captureMetadata
    : {};
  return {
    provider: providerId,
    authorHandle: item.authorHandle || metadata.authorHandle || '',
    authorName: item.authorName || '',
    text: item.originalText || metadata.originalText || item.body || item.title || '',
    externalId: item.externalId || '',
  };
}

export function feedItemIdentityHash(providerId, item) {
  return computeFeedIdentityHash(feedItemIdentityInput(providerId, item));
}
