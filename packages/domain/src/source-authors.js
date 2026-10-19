import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MEDIA_CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../config/media.json');

const OFFICIAL_NAMES = Object.freeze({
  fed: '美联储',
  federalregister: 'Federal Register',
  whitehouse: '白宫',
  govcn: '国务院政策文件库',
  govnews: '中国政府重要会议发布',
  pboc: '中国人民银行',
});

function loadMediaConfig() {
  const parsed = JSON.parse(readFileSync(MEDIA_CONFIG_PATH, 'utf8'));
  return {
    sources: Array.isArray(parsed?.sources) ? parsed.sources : [],
    discoveryPublishers: Array.isArray(parsed?.discoveryPublishers) ? parsed.discoveryPublishers : [],
  };
}

function httpsUrl(value) {
  const text = String(value || '').trim();
  return text.startsWith('https://') || text.startsWith('http://') ? text : '';
}

function entryFromSource(source, lane) {
  const sourceKey = String(source?.sourceKey || '').trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(sourceKey)) return null;
  const publisher = String(source.publisher || sourceKey).trim();
  const channelName = String(source.channelName || '').trim();
  const name = lane === 'official'
    ? (OFFICIAL_NAMES[sourceKey] || publisher || sourceKey)
    : (channelName || publisher || sourceKey);
  return {
    sourceKey,
    lane,
    name,
    sourceId: String(source.sourceId || '').trim(),
    profileUrl: httpsUrl(source.channelUrl || source.probeUrl),
    authorId: `${lane}:${sourceKey}`,
  };
}

function buildCatalog() {
  const config = loadMediaConfig();
  const byKey = new Map();
  const bySourceId = new Map();
  for (const source of config.sources) {
    const lane = /^policy\.[a-z0-9.-]+$/.test(String(source?.sourceId || '')) ? 'official' : 'media';
    const entry = entryFromSource(source, lane);
    if (!entry || byKey.has(entry.sourceKey)) continue;
    byKey.set(entry.sourceKey, entry);
    if (entry.sourceId) bySourceId.set(entry.sourceId, entry);
  }
  for (const source of config.discoveryPublishers) {
    const entry = entryFromSource(source, 'media');
    if (!entry || byKey.has(entry.sourceKey)) continue;
    byKey.set(entry.sourceKey, entry);
  }
  if (!byKey.has('xueqiu7x24')) {
    byKey.set('xueqiu7x24', {
      sourceKey: 'xueqiu7x24',
      lane: 'media',
      name: '雪球7x24',
      sourceId: 'xueqiu:home:livenews',
      profileUrl: 'https://xueqiu.com/',
      authorId: 'media:xueqiu7x24',
    });
  }
  return { byKey, bySourceId };
}

const catalog = buildCatalog();

export function listSourceAuthors() {
  return [...catalog.byKey.values()];
}

export function sourceAuthorProfile(sourceKey) {
  const key = String(sourceKey || '').trim().toLowerCase();
  const entry = catalog.byKey.get(key);
  if (!entry) return null;
  return {
    authorId: entry.authorId,
    platform: entry.lane,
    nativeId: entry.sourceKey,
    handle: entry.sourceKey,
    name: entry.name,
    avatarUrl: '',
    profileUrl: entry.profileUrl,
    bio: '',
    followers: null,
    kind: 'source',
    provisional: false,
    sourceId: entry.sourceId,
  };
}

export function sourceKeyFromCapture(metadata = {}, accountExternalId = '') {
  const fromMeta = String(metadata?.sourceKey || '').trim().toLowerCase();
  if (/^[a-z0-9]+$/.test(fromMeta) && catalog.byKey.has(fromMeta)) return fromMeta;
  const match = /^media:([a-z0-9]+)$/.exec(String(accountExternalId || '').trim());
  if (match && catalog.byKey.has(match[1])) return match[1];
  return '';
}

export function isXueqiuLiveAuthor(profile = {}) {
  const blob = `${profile.name || ''}\n${profile.handle || ''}\n${profile.nativeId || ''}`;
  return profile.nativeId === '7x24' || /7\s*[x×]\s*24/i.test(blob);
}

export function officialAuthorForRelease(release, releaseSourceIds = {}) {
  const releaseId = String(release?.releaseId || '').trim();
  const sourceId = releaseId ? String(releaseSourceIds?.[releaseId] || '').trim() : '';
  if (sourceId && catalog.bySourceId.has(sourceId)) return catalog.bySourceId.get(sourceId);
  return officialAuthorByUrl(release?.sourceUrl || '');
}

export function officialAuthorByUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname || '';
  if (host === 'federalregister.gov' || host.endsWith('.federalregister.gov')) return catalog.byKey.get('federalregister') || null;
  if (host === 'federalreserve.gov' || host.endsWith('.federalreserve.gov')) return catalog.byKey.get('fed') || null;
  if (host === 'whitehouse.gov' || host.endsWith('.whitehouse.gov')) return catalog.byKey.get('whitehouse') || null;
  if (host === 'pbc.gov.cn' || host.endsWith('.pbc.gov.cn')) return catalog.byKey.get('pboc') || null;
  if (host === 'sousuo.www.gov.cn') return catalog.byKey.get('govcn') || null;
  if (host === 'gov.cn' || host.endsWith('.gov.cn')) {
    if (pathname.includes('/yaowen/')) return catalog.byKey.get('govnews') || null;
    return catalog.byKey.get('govcn') || null;
  }
  return null;
}

export function annotateOfficialReleases(board, releaseSourceIds = {}) {
  if (!board || !Array.isArray(board.releases)) return board;
  const map = releaseSourceIds && typeof releaseSourceIds === 'object' ? releaseSourceIds : {};
  return {
    ...board,
    releases: board.releases.map((release) => {
      const source = officialAuthorForRelease(release, map);
      if (!source) return release;
      return { ...release, authorId: source.authorId, sourceAuthorName: source.name };
    }),
  };
}

function positiveTime(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? Math.trunc(time) : 0;
}

export function authorSortAt({ publishedAt, publishedAtRaw, capturedAt, createdAt } = {}) {
  const published = positiveTime(publishedAt);
  if (published) return { at: published, basis: 'published' };
  const parsed = Date.parse(String(publishedAtRaw || ''));
  if (Number.isFinite(parsed) && parsed > 0) return { at: Math.trunc(parsed), basis: 'published' };
  const captured = positiveTime(capturedAt);
  if (captured) return { at: captured, basis: 'captured' };
  const created = positiveTime(createdAt);
  if (created) return { at: created, basis: 'created' };
  return { at: 0, basis: 'missing' };
}
