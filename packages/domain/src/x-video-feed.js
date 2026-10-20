import { createHash } from 'node:crypto';
import { authorCaptureFields } from './authors.js';
import { tweetToFeedItem } from '../../connectors/src/x/home-timeline.js';
import { xVideoCaptureMetadata } from './x-video-articles.js';

function linkedItem(feedRepository, workspaceId, capture) {
  if (!capture?.id) return null;
  return feedRepository.getContentItemByCaptureId?.(workspaceId, capture.id)
    || feedRepository.getContentItemByCapture?.(workspaceId, capture.id)
    || null;
}

function noteAuthor(feedRepository, workspaceId, tweetId, item) {
  const fields = authorCaptureFields('x', item);
  if (!fields) return '';
  const noted = feedRepository.noteCaptureAuthor?.({
    workspaceId,
    provider: 'x',
    externalId: tweetId,
    authorNativeId: fields.authorNativeId,
    authorProfile: fields.authorProfile,
    title: item.title || '',
    publishedAt: item.publishedAt || null,
  });
  return noted?.authorId || fields.authorProfile.authorId || '';
}

function feedItemFromParsed(tweetId, parsed) {
  const author = parsed?.author && typeof parsed.author === 'object' ? parsed.author : {};
  const handle = String(author.handle || '').replace(/^@/, '').trim();
  const text = String(parsed?.text || '').trim();
  const video = xVideoCaptureMetadata({
    externalId: tweetId,
    xVideo: {
      tweetId,
      own: Boolean(parsed?.video),
      quoteTweetId: parsed?.quote?.tweetId || '',
    },
  });
  return tweetToFeedItem({
    tweetId,
    text: text || '这条帖子已加入整理队列。',
    author_handle: handle,
    author_name: author.name || '',
    author_rest_id: author.restId || '',
    author_avatar: author.avatar || '',
    tweet_url: handle ? `https://x.com/${handle}/status/${tweetId}` : '',
    publishedAt: Number(parsed?.createdAt) || 0,
    ...(video ? { x_video: video } : {}),
  });
}

export async function ensureXVideoFeedPost({
  feedRepository,
  workspaceId,
  tweetId,
  loadTweet,
} = {}) {
  const id = String(tweetId || '').trim();
  if (!feedRepository || !id) return { contentItemId: '', authorId: '', created: false, sourceUrl: '' };
  const capture = feedRepository.getCapture?.(workspaceId, 'x', id) || null;
  const linked = linkedItem(feedRepository, workspaceId, capture);
  if (linked?.id && linked.authorId) {
    return {
      contentItemId: linked.id,
      authorId: linked.authorId,
      created: false,
      sourceUrl: linked.sourceUrl || capture?.sourceUrl || '',
    };
  }
  const parsed = typeof loadTweet === 'function' ? await loadTweet(id) : null;
  const item = feedItemFromParsed(id, parsed);
  if (linked?.id) {
    const authorId = noteAuthor(feedRepository, workspaceId, id, item);
    return {
      contentItemId: linked.id,
      authorId,
      created: false,
      sourceUrl: linked.sourceUrl || item.sourceUrl || '',
    };
  }
  const fields = authorCaptureFields('x', item);
  const body = item.body || '这条帖子已加入整理队列。';
  const savedCapture = feedRepository.saveCapture({
    workspaceId,
    provider: 'x',
    externalId: id,
    sourceUrl: item.sourceUrl || `https://x.com/i/status/${id}`,
    title: item.title || 'X 动态',
    contentHash: createHash('sha256').update(`${id}\n${body}`).digest('hex'),
    status: 'ready',
    publishedAt: item.publishedAt || null,
    authorNativeId: fields?.authorNativeId || null,
    metadata: {
      originalText: body,
      // 操作者点名补录。不重新打分，执行中的质量规则也能搜到、也能出现在作者页。
      filterMode: 'enforce',
      filterDecision: 'KEEP',
      filterApplied: true,
      filterRule: 'all-three-0.60',
      filterReason: 'fallback-manual',
      ...(item.authorHandle ? { authorHandle: item.authorHandle } : {}),
      ...(fields ? { authorProfile: fields.authorProfile } : {}),
      ...(item.xVideo ? { xVideo: item.xVideo } : {}),
    },
  });
  const saved = feedRepository.saveContentItem({
    workspaceId,
    captureId: savedCapture.id,
    originType: 'subscription',
    contentType: 'post',
    title: item.title || 'X 动态',
    body,
    summary: item.summary || '',
    sourceUrl: savedCapture.sourceUrl,
    authorName: item.authorName || '',
    publishedAt: item.publishedAt || null,
  });
  const authorId = saved?.id ? (feedRepository.getContentItem?.(workspaceId, saved.id)?.authorId || fields?.authorProfile?.authorId || '') : '';
  return {
    contentItemId: saved?.id || '',
    authorId,
    created: Boolean(saved?.id),
    sourceUrl: savedCapture.sourceUrl || '',
  };
}
