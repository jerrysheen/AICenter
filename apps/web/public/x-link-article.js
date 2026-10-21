const OUTBOUND_LINK = /https?:\/\/(?!(?:www\.)?(?:x|twitter|pic\.x)\.com\b)[^\s<>"')\]]+/i;
const BARE_LINK = /(?:^|[\s([「『])((?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"')\]]+)/i;
const BARE_SKIP = /^(?:www\.)?(?:x|twitter|pic\.x)\.com$/i;

export function xLinkTweetId(post) {
  const platform = post?.platform || post?.provider;
  if (platform !== 'x') return '';
  const external = String(post.externalId || '').trim();
  if (/^\d{5,25}$/.test(external)) return external;
  const fromId = String(post.id || '').match(/^x:(\d{5,25})$/);
  if (fromId) return fromId[1];
  const fromUrl = String(post.sourceUrl || '').match(/\/status\/(\d{5,25})/);
  return fromUrl ? fromUrl[1] : '';
}

export function xPostHasOutboundLink(post) {
  if ((post?.platform || post?.provider) !== 'x') return false;
  const text = [post?.body, post?.summary, post?.title, post?.xLinkOriginal].filter(Boolean).join('\n');
  if (OUTBOUND_LINK.test(text)) return true;
  const bare = text.match(BARE_LINK);
  if (!bare) return false;
  return !BARE_SKIP.test(bare[1].split('/')[0]);
}

export function xLinkArticleRequestPath(tweetId, { ready = false } = {}) {
  const id = encodeURIComponent(String(tweetId || ''));
  return ready ? `/api/v1/x-links/${id}` : `/api/v1/x-links/${id}/article`;
}

export function xLinkArticleReady(record) {
  return record?.status === 'ready' && Boolean(String(record.body || '').trim());
}

const CLOSED = new Set(['ineligible', 'disabled', 'invalid']);

export function xLinkClosed(record) {
  return Boolean(record?.absent || record?.eligible === false || CLOSED.has(record?.status));
}

export function xLinkTerminal(record) {
  if (!record) return false;
  if (xLinkClosed(record)) return true;
  return ['ready', 'failed', 'paywall', 'blocked', 'incomplete', 'limited'].includes(record.status);
}

// 外链还没抓到正文时不能标「正文完整」。不是媒体账号时返回 null，沿用帖子自己的标记。
export function xLinkReaderScope(post, record) {
  if ((post?.platform || post?.provider) !== 'x') return null;
  if (xLinkClosed(record)) return null;
  if (record?.status === 'ready') return record.body ? '正文完整' : '正在获取';
  if (!record && !xPostHasOutboundLink(post)) return null;
  if (!record) return '仅帖文';
  if (record.status === 'pending' || record.status === 'running') return '正在获取';
  if (record.finalUrl || record.status) return '仅帖文';
  return xPostHasOutboundLink(post) ? '仅帖文' : null;
}

export function xLinkOwnsBody(post, record) {
  if (!xPostHasOutboundLink(post)) return false;
  if (!record) return true;
  return !xLinkClosed(record);
}
