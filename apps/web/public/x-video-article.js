export function xVideoTweetId(post) {
  const platform = post?.platform || post?.provider;
  if (platform !== 'x') return '';
  const external = String(post.externalId || '').trim();
  if (/^\d{5,25}$/.test(external)) return external;
  const fromId = String(post.id || '').match(/^x:(\d{5,25})$/);
  if (fromId) return fromId[1];
  const fromUrl = String(post.sourceUrl || '').match(/\/status\/(\d{5,25})/);
  return fromUrl ? fromUrl[1] : '';
}

export function xVideoArticleRequestPath(tweetId, { ready = false } = {}) {
  const id = encodeURIComponent(String(tweetId || ''));
  return ready ? `/api/v1/x-videos/${id}` : `/api/v1/x-videos/${id}/article`;
}

export function xVideoArticleReady(record) {
  return record?.article?.status === 'ready' || record?.articleStatus === 'ready';
}
