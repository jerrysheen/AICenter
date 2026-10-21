import { createHash } from 'node:crypto';
import { authorCaptureFields } from './authors.js';
import { tweetToFeedItem } from '../../connectors/src/x/home-timeline.js';
import { xVideoCaptureMetadata } from './x-video-articles.js';

// 信息流默认打开的是关注页。补录的长视频挂到同一个来源，搜索才能看到。
export const X_HOME_FOLLOWING_ACCOUNT = 'x:home:following';
export const X_VIDEO_PENDING_LABEL = '视频待整理';

export function xPostTextIsLinkOnly(value) {
  const text = String(value || '').replace(/\u00a0/g, ' ').trim();
  if (!text) return false;
  const stripped = text
    .replace(/https?:\/\/t\.co\/[A-Za-z0-9]+/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\s.。…,，!！?？]+/g, '')
    .trim();
  return !stripped;
}

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

function ensureXHomeAccount(feedRepository, workspaceId) {
  const found = feedRepository.findSourceAccount?.(workspaceId, 'x', X_HOME_FOLLOWING_ACCOUNT);
  let accountId = found?.id || '';
  if (!accountId && typeof feedRepository.upsertSourceAccount === 'function') {
    const created = feedRepository.upsertSourceAccount({
      workspaceId,
      provider: 'x',
      externalId: X_HOME_FOLLOWING_ACCOUNT,
      handle: '',
      displayName: 'X 首页',
      profileUrl: 'https://x.com/home',
      authMode: 'browser-session',
      metadata: {
        sourceId: 'content.x.home',
        sourceInput: { feed: 'following' },
        autoRefresh: true,
      },
    });
    accountId = created?.id || '';
  }
  if (accountId && typeof feedRepository.ensureSubscription === 'function') {
    feedRepository.ensureSubscription({
      workspaceId,
      sourceAccountId: accountId,
      enabled: true,
      refreshIntervalMinutes: 30,
    });
  }
  return accountId;
}

// 只挪作者已关注，或带有 following 标记的帖。不改标题，也不另建整理任务。
export function repairXFollowingFeed({
  feedRepository,
  workspaceId = 'local',
  dryRun = false,
  limit = 40,
} = {}) {
  const preview = typeof feedRepository?.listXPostsOffFollowing === 'function'
    ? feedRepository.listXPostsOffFollowing(workspaceId, { limit })
    : { count: 0, posts: [] };
  const posts = Array.isArray(preview?.posts) ? preview.posts : [];
  const examples = posts.slice(0, 8).map((row) => ({
    captureId: row.captureId || '',
    externalId: row.externalId || '',
    sourceAccountId: row.sourceAccountId || null,
    title: row.title || '',
    sourceExternalId: row.sourceExternalId || '',
  }));
  const count = Number(preview?.count) || 0;
  if (dryRun) return { status: 'dry-run', count, moved: 0, examples, posts };
  const placed = placeXPostsOnFollowing({ feedRepository, workspaceId, posts });
  return { ...placed, count, examples, posts };
}

// 只挪调用方已经选定的帖。备份要在这之前写好。
export function placeXPostsOnFollowing({
  feedRepository,
  workspaceId = 'local',
  posts = [],
} = {}) {
  const accountId = ensureXHomeAccount(feedRepository, workspaceId);
  if (!accountId) return { status: 'missing-account', moved: 0, sourceAccountId: '' };
  let moved = 0;
  for (const row of posts) {
    if (!row?.externalId) continue;
    const placed = feedRepository.placeCaptureOnAccount?.(workspaceId, 'x', row.externalId, accountId);
    if (placed?.sourceAccountId === accountId) moved += 1;
  }
  return { status: moved ? 'moved' : 'done', moved, sourceAccountId: accountId };
}

function presentFeedCopy(item) {
  const body = String(item?.body || '').trim();
  const title = String(item?.title || '').trim();
  if (!xPostTextIsLinkOnly(body) && !xPostTextIsLinkOnly(title)) return item;
  return {
    ...item,
    title: X_VIDEO_PENDING_LABEL,
    summary: X_VIDEO_PENDING_LABEL,
    body: body || title,
  };
}

function patchLinkedPost({ feedRepository, workspaceId, capture, linked, accountId, recomputeAuthor }) {
  if (accountId && capture?.externalId) {
    if (typeof feedRepository.placeCaptureOnAccount === 'function') {
      feedRepository.placeCaptureOnAccount(workspaceId, 'x', capture.externalId, accountId);
    } else if (!capture.sourceAccountId) {
      feedRepository.attachCaptureSource?.(workspaceId, 'x', capture.externalId, accountId);
    }
  }
  const body = String(linked?.body || '');
  const title = String(linked?.title || '');
  const linkOnly = xPostTextIsLinkOnly(body) || xPostTextIsLinkOnly(title);
  if (linkOnly && title !== X_VIDEO_PENDING_LABEL && capture?.id) {
    feedRepository.saveContentItem?.({
      workspaceId,
      captureId: capture.id,
      originType: linked.originType || 'subscription',
      contentType: linked.contentType || 'post',
      title: X_VIDEO_PENDING_LABEL,
      body: body || title,
      summary: X_VIDEO_PENDING_LABEL,
      sourceUrl: linked.sourceUrl || capture.sourceUrl || '',
      authorName: linked.authorName || '',
      publishedAt: linked.publishedAt || null,
    });
  }
  const authorId = linked?.authorId
    || feedRepository.authorIdForContentItem?.(workspaceId, linked?.id)
    || '';
  if (authorId && linkOnly) recomputeAuthor?.(authorId);
  return authorId;
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
  recomputeAuthor,
} = {}) {
  const id = String(tweetId || '').trim();
  if (!feedRepository || !id) return { contentItemId: '', authorId: '', created: false, sourceUrl: '' };
  const capture = feedRepository.getCapture?.(workspaceId, 'x', id) || null;
  const linked = linkedItem(feedRepository, workspaceId, capture);
  const accountId = ensureXHomeAccount(feedRepository, workspaceId);
  if (linked?.id && capture?.id) {
    let authorId = patchLinkedPost({
      feedRepository,
      workspaceId,
      capture,
      linked,
      accountId,
      recomputeAuthor,
    });
    if (!authorId) {
      const parsed = typeof loadTweet === 'function' ? await loadTweet(id) : null;
      const item = presentFeedCopy(feedItemFromParsed(id, parsed));
      authorId = noteAuthor(feedRepository, workspaceId, id, item);
      if (authorId && (item.title === X_VIDEO_PENDING_LABEL)) recomputeAuthor?.(authorId);
    }
    return {
      contentItemId: linked.id,
      authorId,
      created: false,
      sourceUrl: linked.sourceUrl || capture.sourceUrl || '',
    };
  }
  const parsed = typeof loadTweet === 'function' ? await loadTweet(id) : null;
  const item = presentFeedCopy(feedItemFromParsed(id, parsed));
  const fields = authorCaptureFields('x', item);
  const body = item.body || '这条帖子已加入整理队列。';
  const savedCapture = feedRepository.saveCapture({
    workspaceId,
    provider: 'x',
    externalId: id,
    sourceAccountId: accountId || null,
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
  const authorId = saved?.id
    ? (feedRepository.authorIdForContentItem?.(workspaceId, saved.id) || fields?.authorProfile?.authorId || '')
    : '';
  if (authorId && item.title === X_VIDEO_PENDING_LABEL) recomputeAuthor?.(authorId);
  return {
    contentItemId: saved?.id || '',
    authorId,
    created: Boolean(saved?.id),
    sourceUrl: savedCapture.sourceUrl || '',
  };
}
