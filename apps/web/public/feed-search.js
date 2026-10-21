export function feedSearchQueryReady(query) {
  return String(query || '').trim().length >= 2;
}

export function feedSearchTerms(query) {
  return String(query || '').trim().split(/\s+/).filter((term) => term.length >= 2).slice(0, 8);
}

// loading：这一轮请求正在飞。ready：没有在飞的请求，列表先用手里已有的结果。
// 整页重载会恢复搜索词，但不会把请求标成进行中。那种情况是 ready，不能写成「搜索中…」。
export function feedSearchPhase({ query = '', pending = false } = {}) {
  const text = String(query || '').trim();
  if (!feedSearchQueryReady(text)) return 'idle';
  if (pending) return 'loading';
  return 'ready';
}

export function feedSearchCountText({ phase = 'idle', shown = 0, total = 0 } = {}) {
  if (phase === 'loading') return '搜索中…';
  if (phase !== 'ready') return '';
  const visible = Math.max(0, Number(shown) || 0);
  const all = Math.max(0, Number(total) || 0);
  if (all > visible) return `已显示 ${visible} / ${all} 条`;
  return `共 ${all} 条`;
}

// 空结果不提示继续读取。还有没画出来的命中才给加载更多。
export function feedSearchMoreText({ phase = 'idle', shown = 0, total = 0 } = {}) {
  if (phase !== 'ready' || !(Number(total) > 0)) return '';
  if ((Number(shown) || 0) < (Number(total) || 0)) return '加载更多';
  return '已经到底了';
}

export function highlightParts(text, query) {
  const source = String(text || '');
  const terms = feedSearchTerms(query).map((term) => term.toLocaleLowerCase()).sort((left, right) => right.length - left.length);
  if (!source || !terms.length) return [{ text: source, hit: false }];
  const lower = source.toLocaleLowerCase();
  const marks = [];
  for (const term of terms) {
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      marks.push([at, at + term.length]);
      from = at + term.length;
    }
  }
  if (!marks.length) return [{ text: source, hit: false }];
  marks.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const merged = [];
  for (const span of marks) {
    const last = merged.at(-1);
    if (!last || span[0] > last[1]) merged.push([span[0], span[1]]);
    else last[1] = Math.max(last[1], span[1]);
  }
  const parts = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) parts.push({ text: source.slice(cursor, start), hit: false });
    parts.push({ text: source.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor), hit: false });
  return parts.filter((part) => part.text);
}

function excerptWindow(source, query) {
  const terms = feedSearchTerms(query);
  const text = String(source || '').replace(/\s+/g, ' ').trim();
  if (!text || !terms.length) return '';
  const lower = text.toLocaleLowerCase();
  let at = -1;
  let length = 0;
  for (const term of terms) {
    const found = lower.indexOf(term.toLocaleLowerCase());
    if (found >= 0 && (at < 0 || found < at)) {
      at = found;
      length = term.length;
    }
  }
  if (at < 0) return '';
  const radius = 24;
  let start = Math.max(0, at - radius);
  let end = Math.min(text.length, at + length + radius);
  if (start > 0) {
    const space = text.lastIndexOf(' ', Math.min(at, start + 12));
    if (space >= start - 8 && space < at) start = space + 1;
  }
  if (end < text.length) {
    const space = text.indexOf(' ', Math.max(at + length, end - 12));
    if (space > at) end = space;
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

// 标题里已经有关键词时不另起摘录。只在正文或摘要命中时留一行。
export function feedSearchExcerpt({ title = '', body = '', summary = '', query = '' } = {}) {
  const heading = String(title || '');
  const headingLower = heading.toLocaleLowerCase();
  if (feedSearchTerms(query).some((term) => headingLower.includes(term.toLocaleLowerCase()))) return '';
  const fromBody = excerptWindow(body, query);
  if (fromBody) return fromBody;
  if (String(summary || '').trim() && String(summary) !== String(body || '')) return excerptWindow(summary, query);
  return '';
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

// 文章页首屏要用的作者字段。最近打开的快照会丢掉未列出的字段。
export function articleAuthorFields(item) {
  return {
    author: String(item?.author || '').trim(),
    authorId: String(item?.authorId || '').trim(),
    handle: String(item?.handle || '').trim(),
    authorHandle: String(item?.authorHandle || '').trim(),
  };
}

// 正文还没到时，文章页仍先画出作者。X 和雪球的列表项常常没有正文。
export function socialArticleBodyPending(post) {
  const platform = String(post?.platform || '');
  if (platform !== 'x' && platform !== 'xueqiu') return false;
  if (String(post?.body || '').trim()) return false;
  return Boolean(String(post?.resourceId || '').trim());
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
