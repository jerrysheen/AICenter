import {
  AUTHOR_ITEM_PAGE_SIZE,
  AUTHOR_LIST_PAGE_SIZE,
  AUTHOR_PLATFORMS,
  AUTHOR_READ_BATCH,
  authorPreviewText,
  chinesePreview,
} from './authors.js';
import { readAuthorCache, writeAuthorCache } from '../../database/src/repositories/author-repository.js';

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function decodeAuthorId(value) {
  try {
    return decodeURIComponent(String(value || '').trim());
  } catch {
    return '';
  }
}

function previewFor(item, translations) {
  const translated = translations.get(item.id)
    || (item.provider && item.externalId ? translations.get(`${item.provider}:${item.externalId}`) : '');
  return authorPreviewText(translated) || chinesePreview(item.title) || chinesePreview(item.summary) || '';
}

export function createAuthorService({ authorRepository, feedRepository, qualityRule = '' } = {}) {
  if (!authorRepository || !feedRepository) throw new Error('author repository is required');

  function withVisibleUnread(workspaceId, authors) {
    const rows = (authors || []).filter(Boolean);
    if (!rows.length || typeof authorRepository.countVisibleUnread !== 'function') return rows;
    const counts = authorRepository.countVisibleUnread(
      workspaceId,
      rows.map((author) => author.authorId),
      { qualityRule },
    );
    return rows.map((author) => {
      const unreadCount = counts.get(author.authorId) || 0;
      if (unreadCount === (Number(author.unreadCount) || 0) && Boolean(author.hasUnread) === unreadCount > 0) return author;
      return { ...author, unreadCount, hasUnread: unreadCount > 0 };
    });
  }

  function list({ workspaceId, platform = 'all', cursor = '' } = {}) {
    const known = AUTHOR_PLATFORMS.includes(platform) || platform === 'official' || platform === 'media';
    const source = known ? platform : 'all';
    const decoded = decodeCursor(cursor);
    const cacheKey = `${workspaceId}|${source}|${cursor || ''}`;
    const cached = readAuthorCache(cacheKey);
    if (cached) return cached;
    const page = authorRepository.listAuthors({
      workspaceId,
      platform: source,
      cursor: decoded,
      limit: AUTHOR_LIST_PAGE_SIZE,
    });
    const followed = withVisibleUnread(workspaceId, page.followed);
    const others = withVisibleUnread(workspaceId, page.others);
    const counts = authorRepository.countAuthors(workspaceId);
    const last = others.at(-1);
    const nextCursor = page.hasMore && last
      ? encodeCursor({ latestItemAt: last.latestItemAt, authorId: last.authorId })
      : '';
    const value = { counts, followed, others, nextCursor };
    writeAuthorCache(cacheKey, value);
    return value;
  }

  function get(workspaceId, authorId) {
    const id = decodeAuthorId(authorId);
    if (!id) return null;
    const author = authorRepository.getAuthor(workspaceId, id);
    if (!author) return null;
    return withVisibleUnread(workspaceId, [author])[0] || null;
  }

  function items(workspaceId, authorId, { read = 'unread', cursor = '', limit = AUTHOR_ITEM_PAGE_SIZE } = {}) {
    const author = get(workspaceId, authorId);
    if (!author || author.kind === 'system') return null;
    const sourceAuthor = author.platform === 'official' || author.platform === 'media';
    const readFlag = read === 'read' ? 1 : 0;
    const before = decodeCursor(cursor);
    const page = authorRepository.listAuthorItemIds(workspaceId, author.authorId, {
      readFlag,
      before: before && before.id ? { at: Number(before.at) || 0, id: String(before.id) } : null,
      limit,
      qualityRule: sourceAuthor ? '' : qualityRule,
    });
    const ids = page.rows.map((row) => row.id);
    const loaded = ids.length
      ? feedRepository.listContentItemsByIds(workspaceId, ids, { qualityRule: sourceAuthor ? '' : qualityRule })
      : [];
    const byId = new Map(loaded.map((row) => [row.id, row]));
    const visible = page.rows.map((row) => byId.get(row.id)).filter(Boolean);
    const translationIds = visible.flatMap((item) => [
      item.id,
      item.provider && item.externalId ? `${item.provider}:${item.externalId}` : '',
    ]).filter(Boolean);
    const translations = new Map(
      (feedRepository.listTranslationPreviews?.(workspaceId, translationIds, 'zh') || [])
        .map((row) => [row.itemId, row.translatedText]),
    );
    const last = page.rows.at(-1);
    return {
      items: visible.map((item) => ({
        id: item.id,
        provider: item.provider || '',
        externalId: item.externalId || '',
        authorId: author.authorId,
        title: item.title || '',
        summary: item.summary || '',
        preview: previewFor(item, translations),
        sourceUrl: item.sourceUrl || '',
        publishedAt: item.publishedAt || item.capturedAt || item.createdAt || 0,
        isRead: Boolean(item.isRead),
      })),
      nextCursor: page.hasMore && last ? encodeCursor({ at: last.sortAt, id: last.id }) : '',
    };
  }

  async function readAll(workspaceId, authorId, { batchSize = AUTHOR_READ_BATCH, yield: pause } = {}) {
    const author = get(workspaceId, authorId);
    if (!author) return null;
    const cap = authorRepository.authorReadCap(workspaceId, author.authorId);
    if (!cap) return null;
    let changed = 0;
    for (;;) {
      const batch = authorRepository.markAuthorReadBatch(workspaceId, cap.authorId, cap.capAt, batchSize);
      changed += batch.changed;
      if (batch.done) break;
      if (pause) await pause();
      else await new Promise((resolve) => setImmediate(resolve));
    }
    authorRepository.finishAuthorUnread(workspaceId, cap.authorId);
    return { authorId: cap.authorId, changed, capAt: cap.capAt };
  }

  function follow(workspaceId, authorId, followed) {
    const author = get(workspaceId, authorId);
    if (!author || author.kind === 'system') return null;
    return authorRepository.setFollow(workspaceId, author.authorId, Boolean(followed));
  }

  return Object.freeze({ list, get, items, readAll, follow });
}
