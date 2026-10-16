export const AUTHOR_ACTIVITY_MIN = 2;
export const AUTHOR_ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTHOR_LIST_PAGE_SIZE = 50;
export const AUTHOR_ITEM_PAGE_SIZE = 30;
export const AUTHOR_READ_BATCH = 500;
export const AUTHOR_PLATFORMS = Object.freeze(['x', 'xueqiu', 'bilibili']);

const PREVIEW_LIMIT = 80;

export function authorViewEnabled(env = process.env) {
  const raw = env?.AUTHOR_VIEW;
  if (raw == null || String(raw).trim() === '') return true;
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}

export function isSystemAuthor({ name = '', handle = '', nativeId = '', kind = '' } = {}) {
  if (kind === 'system') return true;
  return /7\s*[x×]\s*24/i.test(`${name}\n${handle}\n${nativeId}`);
}

export function preferNativeId(previous, incoming) {
  const prev = String(previous || '').trim();
  const next = String(incoming || '').trim();
  const real = (value) => Boolean(value) && !value.startsWith('@');
  if (real(next)) return next;
  if (real(prev)) return prev;
  return next || prev || '';
}

export function authorPreviewText(value) {
  const line = String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean) || '';
  const compact = line.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > PREVIEW_LIMIT ? `${compact.slice(0, PREVIEW_LIMIT)}…` : compact;
}

export function chinesePreview(value) {
  const preview = authorPreviewText(value);
  if (!preview || !/\p{Script=Han}/u.test(preview)) return '';
  return preview;
}

function clip(value, max) {
  return String(value || '').trim().slice(0, max);
}

function defaultProfileUrl(platform, nativeId, handle) {
  if (nativeId.startsWith('@')) return '';
  if (platform === 'x' && handle) return `https://x.com/${handle}`;
  if (platform === 'xueqiu' && nativeId) return `https://xueqiu.com/u/${nativeId}`;
  if (platform === 'bilibili' && nativeId) return `https://space.bilibili.com/${nativeId}`;
  return '';
}

export function provisionalLabel(platform, handle, name) {
  const cleanHandle = String(handle || '').trim().replace(/^@/, '');
  const cleanName = String(name || '').trim();
  if (platform === 'x') return cleanHandle;
  if (platform === 'xueqiu' || platform === 'bilibili') return cleanName || cleanHandle;
  return '';
}

export function provisionalAuthorId(platform, handle, name) {
  const label = provisionalLabel(platform, handle, name);
  if (!label || !AUTHOR_PLATFORMS.includes(platform)) return '';
  return `${platform}:@${label}`;
}

export function authorCaptureFields(platform, item = {}) {
  const source = String(platform || item.platform || item.provider || '').trim();
  if (!AUTHOR_PLATFORMS.includes(source)) return null;
  const profile = item.authorProfile && typeof item.authorProfile === 'object' ? item.authorProfile : {};
  const name = clip(item.attributionName || item.authorName || item.name || profile.name, 256);
  const handle = clip(String(item.attributionHandle || item.authorHandle || item.handle || profile.handle || '').replace(/^@/, ''), 256);
  let nativeId = clip(item.attributionNativeId || item.authorNativeId || item.nativeId || profile.nativeId, 256);
  let provisional = Boolean(item.authorProvisional || item.provisional || profile.provisional);
  const requestedKind = item.authorKind || item.kind || profile.kind || '';
  const kind = isSystemAuthor({ name, handle, nativeId, kind: requestedKind }) ? 'system' : 'person';
  if (!nativeId) {
    const label = provisionalLabel(source, handle, name);
    if (kind === 'system') nativeId = '7x24';
    else if (label) {
      nativeId = `@${label}`;
      provisional = true;
    } else return null;
  }
  if (nativeId.startsWith('@')) provisional = true;
  const avatarUrl = clip(item.attributionAvatar || item.authorAvatar || item.avatarUrl || profile.avatarUrl, 1024);
  const explicitProfile = clip(item.authorProfileUrl || item.profileUrl || profile.profileUrl, 1024);
  const profileUrl = explicitProfile || defaultProfileUrl(source, nativeId, handle);
  const bio = clip(item.authorBio || item.bio || profile.bio, 500);
  const followersRaw = item.authorFollowers ?? item.followers ?? profile.followers;
  const followersNumber = Number(followersRaw);
  const followers = Number.isFinite(followersNumber) ? Math.max(0, Math.trunc(followersNumber)) : null;
  return {
    authorNativeId: nativeId,
    authorProfile: {
      authorId: `${source}:${nativeId}`,
      platform: source,
      nativeId,
      handle,
      name: name || handle,
      avatarUrl,
      profileUrl,
      bio,
      followers,
      kind,
      provisional,
    },
  };
}

export function attributeXAuthor(tweet = {}) {
  const repostHandle = String(tweet.reposter_handle || tweet.reposterHandle || '').replace(/^@/, '').trim();
  const repostRestId = String(tweet.reposter_rest_id || tweet.reposterRestId || '').trim();
  if (repostHandle || repostRestId) {
    return {
      handle: repostHandle,
      restId: repostRestId,
      name: String(tweet.reposter_name || tweet.reposterName || repostHandle).trim(),
      avatar: String(tweet.reposter_avatar || tweet.reposterAvatar || '').trim(),
    };
  }
  return {
    handle: String(tweet.author_handle || tweet.authorHandle || '').replace(/^@/, '').trim(),
    restId: String(tweet.author_rest_id || tweet.authorRestId || tweet.author_id || tweet.authorId || '').trim(),
    name: String(tweet.author_name || tweet.authorName || '').trim(),
    avatar: String(tweet.author_avatar || tweet.authorAvatar || '').trim(),
  };
}
