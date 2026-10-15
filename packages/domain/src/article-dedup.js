import { createHash } from 'node:crypto';

export const ARTICLE_DEDUP_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_TITLE_THRESHOLD = 0.82;
const MIN_TITLE_CHARS = 18;
const MIN_PATH_CHARS = 8;
const MIN_BODY_CHARS = 200;

export function resolveTitleThreshold(env = process.env) {
  const raw = Number(env?.AI_CENTER_ARTICLE_DEDUP_TITLE_THRESHOLD);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return DEFAULT_TITLE_THRESHOLD;
  return raw;
}

export function normalizeHost(value) {
  let host = String(value || '').trim().toLowerCase();
  if (!host) return '';
  if (host.includes('://') || host.startsWith('//')) {
    try {
      host = new URL(host.includes('://') ? host : `https:${host}`).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  host = host.replace(/:\d+$/, '').replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host || /[\s/]/.test(host)) return '';
  return host;
}

// 去协议、www.、查询参数、锚点、末尾斜杠。只把主机名改成小写。
export function normalizeDedupUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const host = normalizeHost(url.hostname);
    if (!host) return '';
    let path = url.pathname || '';
    if (path.length > 1) path = path.replace(/\/+$/, '');
    if (path === '/') path = '';
    return `${host}${path}`;
  } catch {
    return '';
  }
}

export function normalizeDedupTitle(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function titleSimilarity(left, right) {
  const a = normalizeDedupTitle(left);
  const b = normalizeDedupTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (text) => {
    const counts = new Map();
    for (let i = 0; i < text.length - 1; i += 1) {
      const gram = text.slice(i, i + 2);
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
    return counts;
  };
  const leftGrams = grams(a);
  const rightGrams = grams(b);
  let leftSize = 0;
  let rightSize = 0;
  let overlap = 0;
  for (const count of leftGrams.values()) leftSize += count;
  for (const count of rightGrams.values()) rightSize += count;
  for (const [gram, count] of leftGrams) overlap += Math.min(count, rightGrams.get(gram) || 0);
  if (!leftSize || !rightSize) return 0;
  return (2 * overlap) / (leftSize + rightSize);
}

function publisherId(source) {
  return String(source?.publisherKey || source?.sourceKey || '').trim().toLowerCase();
}

function addAlias(map, key, id) {
  const name = String(key || '').trim().toLowerCase().replace(/^media:/, '');
  if (!name || !id) return;
  if (!map.has(name)) map.set(name, id);
  else if (map.get(name) !== id) map.set(name, '');
}

function addHost(map, host, id) {
  const name = normalizeHost(host);
  if (!name || !id) return;
  if (!map.has(name)) map.set(name, id);
  else if (map.get(name) !== id) map.set(name, '');
}

// 发布者归一：媒体栏目的 publisherKey 是同一发布者（bbc / bbcworld / bbctech → bbc）。
// articleHosts、redirectHosts、channelUrl、probeUrl、allowedHosts 上的主机名都指向这个发布者，
// 因此 bbc.com、bbc.co.uk、feeds.bbci.co.uk 与 media:bbc 是同一来源。
// 登记里没有的站点用「host:主机名」，不和别的站点并在一起。
export function createPublisherIndex(sources = []) {
  const byKey = new Map();
  const byHost = new Map();
  for (const source of sources || []) {
    const id = publisherId(source);
    if (!id) continue;
    addAlias(byKey, source.sourceKey, id);
    addAlias(byKey, source.publisherKey, id);
    for (const alias of source.sourceAliases || []) addAlias(byKey, alias, id);
    for (const host of [...(source.articleHosts || []), ...(source.redirectHosts || []), ...(source.allowedHosts || [])]) {
      addHost(byHost, host, id);
    }
    addHost(byHost, source.channelUrl, id);
    addHost(byHost, source.probeUrl, id);
    addHost(byHost, source.profileUrl, id);
  }
  return { byKey, byHost };
}

export function canonicalArticleSource(probe, index) {
  const keys = [probe?.publisherKey, probe?.sourceKey, probe?.sourceExternalId];
  for (const key of keys) {
    const name = String(key || '').trim().toLowerCase().replace(/^media:/, '');
    const hit = name ? index?.byKey?.get(name) : '';
    if (hit) return { id: hit, registered: true };
  }
  for (const host of [probe?.url, probe?.siteUrl]) {
    const name = normalizeHost(host);
    const hit = name ? index?.byHost?.get(name) : '';
    if (hit) return { id: hit, registered: true };
  }
  const host = normalizeHost(probe?.url) || normalizeHost(probe?.siteUrl);
  if (host) return { id: `host:${host}`, registered: false };
  return { id: '', registered: false };
}

function usablePath(normalized) {
  const slash = normalized.indexOf('/');
  return slash > 0 && normalized.length - slash >= MIN_PATH_CHARS;
}

export function articleIdentity(probe, index) {
  const source = canonicalArticleSource(probe, index);
  const url = normalizeDedupUrl(probe?.url);
  const usable = Boolean(url && usablePath(url));
  return {
    sourceId: source.id,
    registered: source.registered,
    url: usable ? url : '',
    key: source.id && usable ? `${source.id}\n${url}` : '',
    title: String(probe?.title || ''),
    publishedAt: Number(probe?.publishedAt) > 0 ? Number(probe.publishedAt) : 0,
  };
}

export function articlesMatch(left, right, threshold = DEFAULT_TITLE_THRESHOLD) {
  if (!left?.sourceId || left.sourceId !== right?.sourceId) return false;
  if (left.key && left.key === right.key) return true;
  if (!left.registered || !right.registered) return false;
  if (!left.publishedAt || !right.publishedAt) return false;
  if (Math.abs(left.publishedAt - right.publishedAt) > ARTICLE_DEDUP_WINDOW_MS) return false;
  const leftTitle = normalizeDedupTitle(left.title);
  const rightTitle = normalizeDedupTitle(right.title);
  if (leftTitle.length < MIN_TITLE_CHARS || rightTitle.length < MIN_TITLE_CHARS) return false;
  return titleSimilarity(left.title, right.title) >= threshold;
}

function likePrefix(value) {
  return `${String(value).replace(/[\\%_]/g, '\\$&')}%`;
}

function urlPrefixes(normalized) {
  const slash = normalized.indexOf('/');
  if (slash < 1 || normalized.length - slash < MIN_PATH_CHARS) return [];
  const host = normalized.slice(0, slash);
  const path = normalized.slice(slash);
  const prefixes = [];
  for (const protocol of ['https://', 'http://']) {
    for (const www of ['', 'www.']) prefixes.push(`${protocol}${www}${host}${path}`);
  }
  return prefixes;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mediaParagraphs(text) {
  const chunks = String(text || '').split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const parts = chunks.length ? chunks : [String(text || '').trim()].filter(Boolean);
  return parts.slice(0, 200).map((part, index) => ({
    id: `p${String(index + 1).padStart(4, '0')}`,
    text: part.slice(0, 100_000),
    kind: 'paragraph',
  })).filter((part) => part.text);
}

function chooseWinner(left, right) {
  const rank = (row) => (row.kind === 'media' || String(row.refId || '').startsWith('media:') ? 0 : 1);
  if (rank(left) !== rank(right)) return rank(left) < rank(right) ? left : right;
  const at = (row) => Number(row.eventAt ?? row.createdAt ?? row.publishedAt) || 0;
  if (at(left) !== at(right)) return at(left) < at(right) ? left : right;
  const id = (row) => String(row.refId || row.id || '');
  return id(left).localeCompare(id(right)) <= 0 ? left : right;
}

export function createArticleDedup({
  mediaRepository = null,
  feedRepository = null,
  sources = [],
  env = process.env,
} = {}) {
  const index = createPublisherIndex(sources);
  const threshold = resolveTitleThreshold(env);

  function identityOf(probe) {
    return articleIdentity(probe, index);
  }

  function keyFor(probe) {
    return identityOf(probe).key;
  }

  function mapMedia(row) {
    if (!row) return null;
    return {
      kind: 'media',
      workspaceId: row.workspace_id,
      externalId: row.external_id,
      id: row.external_id,
      refId: `media:${row.external_id}`,
      url: row.canonical_url || '',
      title: row.title || '',
      summary: row.summary || '',
      authorName: row.author_name || '',
      publishedAt: row.published_at || null,
      createdAt: row.created_at || null,
      hasBody: Boolean(row.body_hash),
      sourceKey: row.source_key || '',
      publisherKey: row.publisher_key || '',
      siteUrl: '',
      sourceExternalId: row.source_key ? `media:${row.source_key}` : '',
    };
  }

  function mapFeed(row) {
    if (!row) return null;
    return {
      kind: 'feed',
      workspaceId: row.workspace_id,
      id: row.id,
      externalId: '',
      refId: `feed:${row.id}`,
      url: row.source_url || '',
      title: row.title || '',
      summary: row.summary || '',
      authorName: row.author_name || '',
      publishedAt: row.published_at || null,
      createdAt: row.created_at || null,
      hasBody: Boolean(row.has_body),
      sourceKey: '',
      publisherKey: '',
      siteUrl: row.profile_url || '',
      sourceExternalId: row.source_external_id || '',
    };
  }

  function ignored(match, ignore) {
    if (!match) return true;
    if (match.kind === 'media' && (ignore.ignoreMediaIds || []).includes(match.externalId)) return true;
    if (match.kind === 'feed' && (ignore.ignoreFeedIds || []).includes(match.id)) return true;
    if (ignore.ignoreRefIds?.includes(match.refId)) return true;
    return false;
  }

  function loadRows(workspaceId, identity) {
    const prefixes = identity.url ? urlPrefixes(identity.url) : [];
    const media = [
      ...(identity.key && mediaRepository?.listMediaByDedupKey ? mediaRepository.listMediaByDedupKey(workspaceId, identity.key) : []),
      ...(prefixes.length && mediaRepository?.listMediaByUrlPrefixes ? mediaRepository.listMediaByUrlPrefixes(workspaceId, prefixes) : []),
    ].map(mapMedia).filter(Boolean);
    const feed = [
      ...(identity.key && feedRepository?.listFeedByDedupKey ? feedRepository.listFeedByDedupKey(workspaceId, identity.key) : []),
      ...(prefixes.length && feedRepository?.listFeedByUrlPrefixes ? feedRepository.listFeedByUrlPrefixes(workspaceId, prefixes) : []),
    ].map(mapFeed).filter(Boolean);
    return [...media, ...feed];
  }

  function loadByTime(workspaceId, publishedAt) {
    const start = publishedAt - ARTICLE_DEDUP_WINDOW_MS;
    const end = publishedAt + ARTICLE_DEDUP_WINDOW_MS;
    const media = mediaRepository?.listMediaByPublishedAt?.(workspaceId, start, end) || [];
    const feed = feedRepository?.listFeedByPublishedAt?.(workspaceId, start, end) || [];
    return [...media.map(mapMedia), ...feed.map(mapFeed)].filter(Boolean);
  }

  function best(matches) {
    return matches.slice().sort((left, right) => {
      const byKind = (left.kind === 'media' ? 0 : 1) - (right.kind === 'media' ? 0 : 1);
      if (byKind) return byKind;
      return (left.createdAt || 0) - (right.createdAt || 0);
    })[0] || null;
  }

  function find(workspaceId, probe, ignore = {}) {
    const identity = identityOf(probe);
    if (!identity.sourceId) return null;
    const seen = new Set();
    const exact = [];
    for (const match of loadRows(workspaceId, identity)) {
      if (seen.has(match.refId) || ignored(match, ignore)) continue;
      seen.add(match.refId);
      const other = identityOf(match);
      if (identity.key && other.key === identity.key) exact.push(match);
    }
    if (exact.length) return best(exact);
    if (!identity.registered || !identity.publishedAt) return null;
    const fuzzy = [];
    for (const match of loadByTime(workspaceId, identity.publishedAt)) {
      if (seen.has(match.refId) || ignored(match, ignore)) continue;
      seen.add(match.refId);
      if (articlesMatch(identity, identityOf(match), threshold)) fuzzy.push(match);
    }
    return best(fuzzy);
  }

  function fill(match, incoming) {
    if (!match) return false;
    const text = String(incoming?.body || '').replace(/\s+/g, ' ').trim();
    const fields = {
      title: String(incoming?.title || '').trim(),
      summary: String(incoming?.summary || '').trim(),
      authorName: String(incoming?.authorName || '').trim(),
      url: String(incoming?.url || '').trim(),
      publishedAt: Number(incoming?.publishedAt) > 0 ? Number(incoming.publishedAt) : null,
      dedupKey: keyFor(match) || keyFor({ ...match, url: incoming?.url || match.url }),
    };
    if (match.kind === 'media') {
      if (!match.hasBody && text.length >= MIN_BODY_CHARS) {
        const bodyHash = sha256(text);
        const paragraphs = mediaParagraphs(text);
        if (paragraphs.length) {
          const revision = mediaRepository.nextSnapshotRevision(match.workspaceId, match.externalId);
          mediaRepository.saveSnapshot({
            workspaceId: match.workspaceId,
            externalId: match.externalId,
            revision,
            bodyHash,
            bodyText: text,
            truncated: false,
            contentLevel: 'partial',
            observedAt: Date.now(),
            article: { paragraphs },
          });
          fields.bodyHash = bodyHash;
          fields.contentLevel = 'partial';
        }
      }
      return mediaRepository.fillMediaEntryGaps(match.workspaceId, match.externalId, fields);
    }
    if (text.length >= MIN_BODY_CHARS) fields.body = text;
    return feedRepository.fillFeedItemGaps(match.workspaceId, match.id, fields);
  }

  function rememberFeed(workspaceId, contentItemId, probe) {
    const key = keyFor(probe);
    if (!key || !feedRepository?.rememberFeedDedupKey) return;
    feedRepository.rememberFeedDedupKey(workspaceId, contentItemId, key);
  }

  function dedupeHourlyCandidates(workspaceId, items) {
    return (items || []).filter((item) => {
      const self = {
        kind: String(item.id || '').startsWith('media:') ? 'media' : 'feed',
        refId: item.id,
        eventAt: item.eventAt,
        publishedAt: item.publishedAt,
        createdAt: item.eventAt,
      };
      const probe = {
        url: item.sourceUrl || '',
        title: item.title || '',
        publishedAt: item.publishedAt,
        sourceKey: item.sourceKey || '',
        publisherKey: item.publisherKey || '',
        sourceExternalId: item.sourceExternalId || '',
      };
      const ignore = String(item.id || '').startsWith('media:')
        ? { ignoreMediaIds: [String(item.id).slice(6)] }
        : { ignoreFeedIds: [String(item.id).slice(5)] };
      const rival = find(workspaceId, probe, ignore);
      if (!rival) return true;
      const winner = chooseWinner(self, {
        kind: rival.kind,
        refId: rival.refId,
        eventAt: rival.createdAt,
        createdAt: rival.createdAt,
        publishedAt: rival.publishedAt,
      });
      return winner.refId === self.refId;
    });
  }

  return {
    index,
    threshold,
    keyFor,
    identityOf,
    find,
    fill,
    rememberFeed,
    dedupeHourlyCandidates,
  };
}
