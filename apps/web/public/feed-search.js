export function feedSearchQueryReady(query) {
  return String(query || '').trim().length >= 2;
}

// 新的搜索请求取消上一次。target 是这次 fetch 的 AbortController。
export function linkAbortSignal(target, signal) {
  if (!target?.abort || !signal?.addEventListener) return () => {};
  const abort = () => {
    try { target.abort(); } catch { /* already aborted */ }
  };
  if (signal.aborted) {
    abort();
    return () => {};
  }
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

export function feedSearchPath({ platform = '', query = '' } = {}) {
  const params = new URLSearchParams();
  const text = String(query || '').trim();
  if (text) params.set('q', text);
  const source = String(platform || '').trim();
  if (source && source !== 'all') params.set('platform', source);
  return `/api/v1/feed/search?${params}`;
}

// 文章页作者名只打开作者。没有作者 id 时，X 的 handle 走 x:@handle，服务端再对到 x:数字。
export function articleAuthorTarget(post, { authorView = true } = {}) {
  const authorId = String(post?.authorId || '').trim();
  if (authorView && authorId) return { kind: 'author', id: authorId };
  const handle = String(post?.handle || post?.authorHandle || '').trim().replace(/^@/, '');
  const platform = String(post?.platform || '').trim();
  if (authorView && platform === 'x' && handle) return { kind: 'author', id: `x:@${handle}` };
  if (platform === 'official') return { kind: 'source', id: `policy.${post?.author || ''}` };
  if (platform === 'manual') return { kind: 'source', id: 'manual' };
  if (platform) return { kind: 'source', id: platform };
  return { kind: 'none', id: '' };
}
