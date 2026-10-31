import { createHash } from 'node:crypto';
import { HOURLY_CATEGORY_EVENT_MAX, HOURLY_CATEGORY_FORMAT, UNTAGGED_CATEGORY_ID } from '../../contracts/src/hourly-category.js';
import { localizationItemId, needsZhLocalization } from './localize-texts.js';
import { treeCatalog } from './information-tree-policy.js';
import { readingPlacement } from './reading-focus-route.js';

export const HOURLY_CATEGORY_TASK = 'hourly-category-brief';
export const UNTAGGED_CATEGORY_LABEL = '待标注';
export const CATEGORY_EXCERPT_CHARS = 200;
export const CATEGORY_TITLE_CHARS = 180;
export const CATEGORY_EVENT_LIMIT = 12;
export const CATEGORY_BUCKET_ITEM_LIMIT = 40;
export const UNTAGGED_MODEL_ITEMS = 8;
export const CATEGORY_EVENT_STORE_LIMIT = HOURLY_CATEGORY_EVENT_MAX;
const HOUR_MS = 3_600_000;

export const HOURLY_CATEGORY_INSTRUCTION = [
  '只根据给定 JSON 写这一类在该小时里发生的事。不要联网，不要读取或补写正文，不要编造输入里没有的事实。',
  '返回一个 JSON 对象，不要 Markdown。形状必须是 {"categoryId":"...","events":[{"bullet":"...","sourceIds":["..."]}]}。',
  'categoryId 必须与输入 category.id 相同。每条 sourceIds 只能使用输入 items 里的 sourceId，且至少包含一个。',
  '同一件事才合并成一条，合并后的 sourceIds 写上全部相关材料。不要为了缩短丢掉不同的事。',
  '正式分类最多 12 条。输入里若有 eventLimit，事件条数不超过它。bullet 用一句简体中文，不要重写标题、摘要和正文。输入已经是中文时沿用这句，不要改回英文，也不要写成以省略号收尾的半截标题。',
  '没有写进事件的材料由系统补上：已有中文译文时用译文，不用入库时截断的原题。输入 truncated 为 true 时，先覆盖已经给出的条目。',
].join('\n');

export const HOURLY_CATEGORY_PROMPT_HASH = createHash('sha256').update(HOURLY_CATEGORY_INSTRUCTION).digest('hex');

// The hourly page's tree pane is the reading hour. These four names are the
// headings it already shows. Category editions copy them; they do not invent
// another Gemma tag bucket or another title.
export const TREE_READING_DIRECTIONS = Object.freeze([
  { id: 'finance', label: '金融' },
  { id: 'industry', label: '产业个股' },
  { id: 'ai', label: '科技与AI' },
  { id: 'geopolitics', label: '地缘政治' },
]);
const TREE_DIRECTION_BY_LABEL = new Map(TREE_READING_DIRECTIONS.map((row) => [row.label, row.id]));
export const TREE_CATEGORY_PROMPT_HASH = createHash('sha256').update('hourly-category-tree-reuse-v1').digest('hex');

export function treeReadingDirectionId(name) {
  return TREE_DIRECTION_BY_LABEL.get(String(name || '').trim()) || '';
}

function treeItemRow(item) {
  const sourceId = String(item?.sourceId || '').trim();
  const title = String(item?.title || '').replace(/\s+/g, ' ').trim();
  if (!sourceId || !title || item?.disposition === 'out-of-scope') return null;
  const direction = treeReadingDirectionId(item?.readingDirectionName);
  return {
    sourceId,
    title,
    direction,
    eventAt: Number(item?.firstIngestedAt) || Number(item?.eventAt) || 0,
  };
}

export function nodeToTreeCategoryItem(node) {
  const reading = node?.readingClassification;
  const placement = readingPlacement(reading || {});
  const named = treeReadingDirectionId(placement.readingDirectionName);
  const classified = reading?.status === 'classified' && named;
  return {
    sourceId: node?.sourceId,
    title: node?.title,
    readingDirectionName: classified ? placement.readingDirectionName : '',
    disposition: reading?.status === 'out-of-scope' ? 'out-of-scope' : 'hit',
    eventAt: node?.eventAt,
    firstIngestedAt: node?.eventAt,
  };
}

function eventsFromTreeRows(rows) {
  const sorted = [...rows].sort((left, right) => left.eventAt - right.eventAt || left.sourceId.localeCompare(right.sourceId));
  const seen = new Set();
  const unique = [];
  for (const row of sorted) {
    if (seen.has(row.sourceId)) continue;
    seen.add(row.sourceId);
    unique.push(row);
  }
  const truncated = unique.length > CATEGORY_EVENT_STORE_LIMIT;
  const kept = truncated ? unique.slice(0, CATEGORY_EVENT_STORE_LIMIT) : unique;
  return {
    inputCount: unique.length,
    truncated,
    events: kept.map((row) => ({
      bullet: clipCategoryText(row.title, 400),
      sourceIds: [row.sourceId],
    })),
  };
}

// One event per tree row. The bullet is the tree title, not a new model sentence.
export function buildTreeCategoryEdition({ workspaceId = 'local', hourStart, items = [], generatedAt = Date.now() } = {}) {
  const placed = [];
  const seen = new Set();
  for (const item of items || []) {
    const row = treeItemRow(item);
    if (!row || seen.has(row.sourceId)) continue;
    seen.add(row.sourceId);
    placed.push(row);
  }
  const groups = new Map(TREE_READING_DIRECTIONS.map((direction) => [direction.id, []]));
  const untagged = [];
  for (const row of placed) {
    if (row.direction && groups.has(row.direction)) groups.get(row.direction).push(row);
    else untagged.push(row);
  }
  const categories = [];
  for (const direction of TREE_READING_DIRECTIONS) {
    const rows = groups.get(direction.id) || [];
    if (!rows.length) continue;
    const packed = eventsFromTreeRows(rows);
    categories.push({
      id: direction.id,
      label: direction.label,
      inputCount: packed.inputCount,
      truncated: packed.truncated,
      model: '',
      promptHash: TREE_CATEGORY_PROMPT_HASH,
      generatedAt,
      status: 'ready',
      events: packed.events,
    });
  }
  if (untagged.length) {
    const packed = eventsFromTreeRows(untagged);
    categories.push({
      id: UNTAGGED_CATEGORY_ID,
      label: UNTAGGED_CATEGORY_LABEL,
      inputCount: packed.inputCount,
      truncated: packed.truncated,
      model: '',
      promptHash: TREE_CATEGORY_PROMPT_HASH,
      generatedAt,
      status: 'ready',
      events: packed.events,
    });
  }
  return {
    formatVersion: HOURLY_CATEGORY_FORMAT,
    id: `hcat:${hourStart}`,
    workspaceId,
    window: { startAt: hourStart, endAt: hourStart + HOUR_MS },
    status: categories.length ? 'ready' : 'empty',
    dualRun: true,
    untaggedCount: untagged.length,
    categories,
    generatedAt,
  };
}

export function hourlyCategoryEnabled(env = process.env) {
  const raw = String(env?.AI_CENTER_HOURLY_CATEGORY ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

export function clipCategoryText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function categoryTaggingKey(sourceId) {
  const id = String(sourceId || '');
  if (id.startsWith('feed:')) return { resourceType: 'content-item', resourceId: id.slice(5) };
  if (id.startsWith('media:')) return { resourceType: 'media-index', resourceId: localizationItemId(id) };
  return null;
}

export function categorySourceHref(sourceId) {
  const id = String(sourceId || '').trim();
  if (!id.startsWith('feed:') && !id.startsWith('media:')) return '';
  return `#article/${id}`;
}

function classificationOf(catalog) {
  if (typeof catalog?.group === 'function' && catalog.ids && Array.isArray(catalog.tags)) return catalog;
  return treeCatalog(catalog?.tags ? catalog : { tags: [] });
}

export function primaryCategoryId(tagIds, catalog) {
  return categoryBucketIds(tagIds, catalog)[0];
}

// Every catalog tag is kept. groupByTag still folds a child into its parent.
// The first tag alone used to drop later finance, tech, and company tags.
export function categoryBucketIds(tagIds, catalog) {
  const classification = classificationOf(catalog);
  const ids = [];
  const seen = new Set();
  for (const raw of Array.isArray(tagIds) ? tagIds : []) {
    const id = String(raw || '').trim();
    if (!id || id === UNTAGGED_CATEGORY_ID) continue;
    const grouped = classification.group(id);
    if (!grouped || seen.has(grouped)) continue;
    seen.add(grouped);
    ids.push(grouped);
  }
  return ids.length ? ids : [UNTAGGED_CATEGORY_ID];
}

function categoryLabel(id, classification) {
  if (id === UNTAGGED_CATEGORY_ID) return UNTAGGED_CATEGORY_LABEL;
  return classification.tags.find((tag) => tag.id === id)?.name || id;
}

function categoryOrder(classification) {
  const order = [];
  const seen = new Set();
  for (const tag of classification.tags) {
    const id = classification.group(tag.id) || tag.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  order.push(UNTAGGED_CATEGORY_ID);
  return order;
}

export function bucketCategoryItems(items, catalog) {
  const classification = classificationOf(catalog);
  const grouped = new Map();
  for (const item of items || []) {
    const sourceId = String(item?.sourceId || item?.id || '').trim();
    if (!sourceId) continue;
    const originalTitle = String(item?.originalTitle || item?.title || '');
    const translation = String(item?.translation || item?.translatedText || '');
    const excerpt = String(item?.excerpt || item?.summary || '');
    const copy = categoryModelCopy({ title: item?.title, excerpt, translation, originalTitle });
    const row = {
      sourceId,
      title: copy.title,
      excerpt: copy.excerpt,
      originalTitle,
      translation,
      tags: (Array.isArray(item?.tags) ? item.tags : []).map((tag) => String(tag || '').trim()).filter(Boolean),
      eventAt: Number(item?.eventAt) || 0,
    };
    for (const id of categoryBucketIds(item?.tags, classification)) {
      const bucket = grouped.get(id) || [];
      bucket.push(row);
      grouped.set(id, bucket);
    }
  }
  const buckets = [];
  const seen = new Set();
  for (const id of categoryOrder(classification)) {
    const rows = grouped.get(id);
    if (!rows?.length) continue;
    seen.add(id);
    rows.sort((a, b) => a.eventAt - b.eventAt || a.sourceId.localeCompare(b.sourceId));
    buckets.push({ id, label: categoryLabel(id, classification), items: rows });
  }
  for (const [id, rows] of grouped) {
    if (seen.has(id) || !rows.length) continue;
    rows.sort((a, b) => a.eventAt - b.eventAt || a.sourceId.localeCompare(b.sourceId));
    buckets.push({ id, label: categoryLabel(id, classification), items: rows });
  }
  return buckets;
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw Object.assign(new Error('分类简报不是 JSON'), { code: 'invalid-output' });
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw Object.assign(new Error('分类简报不是 JSON'), { code: 'invalid-output' });
  }
}

export function parseCategoryBriefOutput(raw, { categoryId, sourceIds } = {}) {
  const parsed = extractJsonObject(raw);
  const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
  if (keys.length !== 2 || !keys.includes('categoryId') || !keys.includes('events')) {
    throw Object.assign(new Error('分类简报字段不符合约定'), { code: 'invalid-output' });
  }
  if (parsed.categoryId !== categoryId) {
    throw Object.assign(new Error('分类简报 categoryId 与输入不一致'), { code: 'invalid-output' });
  }
  if (!Array.isArray(parsed.events) || parsed.events.length > CATEGORY_EVENT_LIMIT) {
    throw Object.assign(new Error('分类简报事件数量不符合约定'), { code: 'invalid-output' });
  }
  const allowed = new Set(sourceIds || []);
  const events = parsed.events.map((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw Object.assign(new Error('分类简报事件不符合约定'), { code: 'invalid-output' });
    }
    const eventKeys = Object.keys(event);
    if (eventKeys.some((key) => key !== 'bullet' && key !== 'sourceIds')) {
      throw Object.assign(new Error('分类简报事件字段不符合约定'), { code: 'invalid-output' });
    }
    const bullet = typeof event.bullet === 'string' ? event.bullet.trim() : '';
    if (!bullet || bullet.length > 400) {
      throw Object.assign(new Error('分类简报缺少事件句子'), { code: 'invalid-output' });
    }
    if (!Array.isArray(event.sourceIds) || !event.sourceIds.length || event.sourceIds.length > 40) {
      throw Object.assign(new Error('分类简报事件缺少来源'), { code: 'invalid-output' });
    }
    const ids = [];
    for (const sourceId of event.sourceIds) {
      if (typeof sourceId !== 'string' || !allowed.has(sourceId)) {
        throw Object.assign(new Error('分类简报 sourceIds 超出输入'), { code: 'invalid-output' });
      }
      if (!ids.includes(sourceId)) ids.push(sourceId);
    }
    return { bullet, sourceIds: ids };
  });
  return { categoryId, events };
}

function observeToken(value, limit = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit).replace(/ /g, '_');
  return text || '-';
}

export function hourlyCategoryObserveStatus(edition, error = null) {
  if (error || !edition) return 'error';
  const categories = Array.isArray(edition.categories) ? edition.categories : [];
  if (!categories.length) return 'empty';
  if (edition.status === 'failed') return 'error';
  if (edition.status === 'partial') return 'partial';
  return edition.status === 'ready' ? 'ready' : 'error';
}

// Counts already stored on the edition. flashCallCount is how many non-empty buckets this run attempted, not a new call.
export function formatHourlyCategoryObserveLog({
  workspaceId = 'local',
  hourStart,
  edition = null,
  error = null,
  startedAt = 0,
  finishedAt = 0,
  treeExists = false,
  treeStatus = '',
} = {}) {
  const categories = Array.isArray(edition?.categories) ? edition.categories : [];
  const materialCount = categories.reduce((sum, category) => sum + (Number(category?.inputCount) || 0), 0);
  const untaggedCount = Number(edition?.untaggedCount) || 0;
  const ratio = materialCount > 0 ? untaggedCount / materialCount : 0;
  const truncatedBuckets = categories.filter((category) => category?.truncated === true).length;
  const duration = Number.isFinite(finishedAt) && Number.isFinite(startedAt) ? Math.max(0, Math.round(finishedAt - startedAt)) : 0;
  const start = Number.isFinite(hourStart) ? hourStart : Number(edition?.window?.startAt);
  const treeEdition = treeExists ? observeToken(treeStatus) : 'missing';
  const parts = [
    '[worker] hourly-category-observe',
    `workspaceId=${observeToken(edition?.workspaceId || workspaceId)}`,
    `hourStart=${Number.isFinite(start) ? start : '-'}`,
    'flag=on',
    `materialCount=${materialCount}`,
    `bucketCount=${categories.length}`,
    `untaggedCount=${untaggedCount}`,
    `untaggedRatio=${ratio.toFixed(3)}`,
    `flashCallCount=${categories.length}`,
    `categoryDurationMs=${duration}`,
    `status=${hourlyCategoryObserveStatus(edition, error)}`,
    `treeEdition=${treeEdition}`,
    `truncatedBuckets=${truncatedBuckets}`,
  ];
  if (error) parts.push(`message=${observeToken(error?.message || error, 180)}`);
  return parts.join(' ');
}

export function projectHourlyCategory(edition) {
  if (!edition) return null;
  return {
    formatVersion: edition.formatVersion,
    id: edition.id,
    window: edition.window,
    status: edition.status,
    dualRun: true,
    untaggedCount: edition.untaggedCount,
    generatedAt: edition.generatedAt,
    categories: (edition.categories || []).map((category) => ({
      id: category.id,
      label: category.label,
      inputCount: category.inputCount,
      truncated: category.truncated === true,
      status: category.status,
      events: (category.events || []).map((event) => ({
        bullet: event.bullet,
        sourceIds: event.sourceIds,
        links: event.sourceIds.map((sourceId) => ({
          sourceId,
          href: categorySourceHref(sourceId),
        })),
      })),
    })),
  };
}

function chunk(ids, size) {
  const rows = [];
  for (let index = 0; index < ids.length; index += size) rows.push(ids.slice(index, index + size));
  return rows;
}

async function tagsBySource(taggingRepository, workspaceId, candidates) {
  const map = new Map();
  if (!taggingRepository?.listTaggings) return map;
  const groups = new Map();
  for (const candidate of candidates) {
    const key = categoryTaggingKey(candidate.id);
    if (!key?.resourceId) continue;
    const list = groups.get(key.resourceType) || [];
    list.push(key.resourceId);
    groups.set(key.resourceType, list);
  }
  for (const [resourceType, ids] of groups) {
    for (const part of chunk([...new Set(ids)], 200)) {
      const rows = taggingRepository.listTaggings(workspaceId, resourceType, part) || [];
      for (const row of rows) map.set(`${resourceType}:${row.resourceId}`, Array.isArray(row.tags) ? row.tags : []);
    }
  }
  return map;
}

const ELLIPSIS_END = /(?:…|\.{3})\s*$/u;
const BULLET_MAX = 400;

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function usableZh(value) {
  const text = normalizeSpace(value);
  if (!text || needsZhLocalization(text) || !/\p{Script=Han}/u.test(text)) return '';
  return text;
}

function stripEllipsis(value) {
  return normalizeSpace(value).replace(ELLIPSIS_END, '').trim();
}

// X and Xueqiu store lead.slice(0, 48) + '…'. A title that ends in an ellipsis
// and is only a prefix of a longer summary or translation is the same kind of clip.
export function isStoredTitleClip(title, ...fuller) {
  const value = normalizeSpace(title);
  if (!ELLIPSIS_END.test(value)) return false;
  const stem = stripEllipsis(value);
  if (!stem) return true;
  if (stem.length === 48) return true;
  const longer = fuller.map(normalizeSpace).filter((text) => text.length > stem.length && text.startsWith(stem));
  if (longer.length) return true;
  return stem.length >= 48 && !usableZh(value);
}

function finishedPlain(value) {
  const text = normalizeSpace(value);
  if (!text) return '';
  const base = stripEllipsis(text);
  const match = base.match(/^.+?(?:[。！？]|[.!?](?:\s|$))/);
  const sentence = (match?.[0] || base).trim();
  return sentence || base;
}

function finishedZh(value) {
  const sentence = finishedPlain(value);
  if (!usableZh(sentence) || isStoredTitleClip(sentence, value)) return '';
  return sentence;
}

function boundBullet(value) {
  const text = normalizeSpace(value);
  if (!text) return '';
  if (text.length <= BULLET_MAX) return text;
  const cut = text.slice(0, BULLET_MAX);
  const punct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  if (punct >= 24) return cut.slice(0, punct + 1).trim();
  return cut.trim();
}

export function categoryFallbackBullet(item) {
  const stored = normalizeSpace(item?.originalTitle || item?.title);
  const title = normalizeSpace(item?.title);
  const excerpt = normalizeSpace(item?.excerpt || item?.summary);
  const translation = normalizeSpace(item?.translation || item?.translatedText);
  const clip = isStoredTitleClip(stored, excerpt, translation, title);
  const translationZh = finishedZh(translation);
  const titleZh = !isStoredTitleClip(title, excerpt, translation) ? finishedZh(title) : '';
  const storedZh = !clip ? finishedZh(stored) : '';
  const excerptZh = finishedZh(excerpt);
  if (translationZh && (clip || !storedZh || needsZhLocalization(stored))) return boundBullet(translationZh);
  if (titleZh) return boundBullet(titleZh);
  if (storedZh) return boundBullet(storedZh);
  if (excerptZh) return boundBullet(excerptZh);
  if (clip) {
    const stem = stripEllipsis(stored);
    const fuller = [excerpt, translation, title].map(normalizeSpace).find((text) => stripEllipsis(text).length > stem.length);
    const chosen = stripEllipsis(finishedPlain(fuller) || fuller || stem);
    if (chosen) return boundBullet(chosen);
  }
  const plain = stripEllipsis(finishedPlain(stored) || finishedPlain(excerpt) || stored || excerpt);
  return boundBullet(plain) || '这条材料没有标题';
}

export function categoryModelCopy(item) {
  const bullet = categoryFallbackBullet(item);
  const translation = normalizeSpace(item?.translation || item?.translatedText);
  const excerpt = normalizeSpace(item?.excerpt || item?.summary);
  const extra = usableZh(translation) || usableZh(excerpt) || excerpt || bullet;
  return {
    title: clipCategoryText(bullet, CATEGORY_TITLE_CHARS),
    excerpt: clipCategoryText(extra, CATEGORY_EXCERPT_CHARS),
  };
}

function echoesStoredClip(raw, item) {
  const text = normalizeSpace(raw);
  const stored = normalizeSpace(item?.originalTitle || item?.title);
  if (!text || !stored || !isStoredTitleClip(stored, item?.excerpt, item?.translation, item?.summary, item?.title)) return false;
  return text === stored || text === clipCategoryText(stored, 180) || text === clipCategoryText(stored, BULLET_MAX);
}

function settleEventBullet(event, byId) {
  const sources = (event?.sourceIds || []).map((id) => byId.get(String(id || ''))).filter(Boolean);
  const raw = normalizeSpace(event?.bullet);
  if (raw && usableZh(raw) && !sources.some((item) => echoesStoredClip(raw, item))) {
    return raw.length > BULLET_MAX ? clipCategoryText(raw, BULLET_MAX) : raw;
  }
  const preferred = sources.map((item) => categoryFallbackBullet(item)).filter(Boolean);
  const zh = [...new Set(preferred.filter((text) => usableZh(text)))];
  if (zh.length === 1) return zh[0];
  if (zh.length > 1) {
    const joined = zh.join('；');
    return joined.length <= BULLET_MAX ? joined : clipCategoryText(joined, BULLET_MAX);
  }
  if (sources.length === 1) return preferred[0] || raw || '这条材料没有标题';
  if (raw && !sources.some((item) => raw === normalizeSpace(item?.originalTitle || item?.title))) {
    return raw.length > BULLET_MAX ? clipCategoryText(raw, BULLET_MAX) : raw;
  }
  return preferred[0] || raw || '这条材料没有标题';
}

export function coverCategoryEvents(events, items, limit = CATEGORY_EVENT_STORE_LIMIT) {
  const byId = new Map((items || []).filter((item) => item?.sourceId).map((item) => [String(item.sourceId), item]));
  const cited = new Set();
  const kept = [];
  let truncated = false;
  for (const event of events || []) {
    if (kept.length >= limit) { truncated = true; break; }
    const ids = [];
    for (const sourceId of event?.sourceIds || []) {
      if (cited.has(sourceId)) continue;
      cited.add(sourceId);
      ids.push(sourceId);
    }
    if (!ids.length) continue;
    kept.push({ bullet: settleEventBullet({ ...event, sourceIds: ids }, byId), sourceIds: ids });
  }
  for (const item of items || []) {
    const sourceId = String(item?.sourceId || '');
    if (!sourceId || cited.has(sourceId)) continue;
    if (kept.length >= limit) { truncated = true; break; }
    const bullet = categoryFallbackBullet(item) || '这条材料没有标题';
    kept.push({ bullet, sourceIds: [sourceId] });
    cited.add(sourceId);
  }
  return { events: kept, truncated };
}

function editionStatus(categories) {
  if (!categories.length) return 'empty';
  const failed = categories.filter((category) => category.status === 'failed').length;
  if (!failed) return 'ready';
  if (failed === categories.length) return 'failed';
  return 'partial';
}

const STOCK_TAG_IDS = new Set(['corporate_results', 'corporate_financing']);

export function censusCategoryTags(items, buckets, catalog) {
  const classification = classificationOf(catalog);
  const directions = catalog?.reading?.directionByTag || {};
  const tagged = new Map();
  let nonempty = 0;
  let missing = 0;
  const direction = { finance: 0, tech: 0, policy: 0, stock: 0 };
  for (const item of items || []) {
    const raw = Array.isArray(item?.tags) ? item.tags : [];
    const known = raw.map((id) => classification.group(String(id || '').trim())).filter(Boolean);
    if (!raw.length) missing += 1;
    else if (!known.length) missing += 1;
    else nonempty += 1;
    const seenDir = new Set();
    for (const id of known) {
      tagged.set(id, (tagged.get(id) || 0) + 1);
      if (STOCK_TAG_IDS.has(id) && !seenDir.has('stock')) {
        seenDir.add('stock');
        direction.stock += 1;
      }
      const name = directions[id] || '';
      if (name && !seenDir.has(name)) {
        seenDir.add(name);
        direction[name] += 1;
      }
    }
  }
  const bucketed = new Map();
  let eventSources = 0;
  for (const bucket of buckets || []) {
    if (!bucket || bucket.id === UNTAGGED_CATEGORY_ID) continue;
    bucketed.set(bucket.id, (bucket.items || []).length);
    const cited = new Set((bucket.events || []).flatMap((event) => event.sourceIds || []));
    eventSources += cited.size;
  }
  const tags = [...new Set([...tagged.keys(), ...bucketed.keys()])].sort();
  return {
    ingested: (items || []).length,
    missing,
    nonempty,
    direction,
    tags: tags.map((id) => ({
      id,
      label: categoryLabel(id, classification),
      tagged: tagged.get(id) || 0,
      bucketed: bucketed.get(id) || 0,
    })),
    untagged: (buckets || []).find((bucket) => bucket.id === UNTAGGED_CATEGORY_ID)?.items.length || 0,
    eventSources,
  };
}

export function formatCategoryTagCensus(census, hourStart) {
  const tags = (census?.tags || []).map((row) => `${row.id}:${row.tagged}>${row.bucketed}`).join(',') || '-';
  const direction = census?.direction || {};
  return [
    '[worker] hourly-category-tags',
    `hourStart=${Number.isFinite(hourStart) ? hourStart : '-'}`,
    `ingested=${census?.ingested || 0}`,
    `noTag=${census?.missing || 0}`,
    `tagged=${census?.nonempty || 0}`,
    `untaggedBucket=${census?.untagged || 0}`,
    `finance=${direction.finance || 0}`,
    `tech=${direction.tech || 0}`,
    `stock=${direction.stock || 0}`,
    `policy=${direction.policy || 0}`,
    `eventSources=${census?.eventSources || 0}`,
    `tags=${tags}`,
  ].join(' ');
}

export function createHourlyCategoryService({
  repository,
  taggingRepository = null,
  candidatePort = null,
  catalog = { tags: [] },
  agentRuntime = null,
  excerptPort = null,
  nodeTagPort = null,
  nodePort = null,
  enabled = false,
  now = () => Date.now(),
  maxItems = CATEGORY_BUCKET_ITEM_LIMIT,
  log = console.log,
} = {}) {
  const classification = classificationOf(catalog);

  async function generateHour({ workspaceId = 'local', hourStart } = {}) {
    if (!Number.isFinite(hourStart) || hourStart % HOUR_MS !== 0) throw new Error('小时起点必须为整小时');
    if (hourStart + HOUR_MS > now()) throw new Error('目标小时尚未结束');
    const window = { startAt: hourStart, endAt: hourStart + HOUR_MS };
    const candidates = (await candidatePort?.(workspaceId, window) || []).filter((row) => {
      const at = Number(row?.eventAt);
      return row?.id && Number.isFinite(at) && at >= window.startAt && at < window.endAt;
    });
    const tagMap = await tagsBySource(taggingRepository, workspaceId, candidates);
    let nodeTags = new Map();
    if (typeof nodeTagPort === 'function') {
      try {
        const loaded = await nodeTagPort(workspaceId, candidates.map((row) => row.id));
        if (loaded instanceof Map) nodeTags = loaded;
      } catch { /* 信息树标签读不到时仍用 resource_taggings */ }
    }
    const excerpts = new Map();
    if (excerptPort) {
      for (const row of await excerptPort(workspaceId, candidates) || []) {
        if (row?.id) excerpts.set(row.id, row);
      }
    }
    const prepared = candidates.map((row) => {
      const key = categoryTaggingKey(row.id);
      const stored = key ? tagMap.get(`${key.resourceType}:${key.resourceId}`) : undefined;
      const looked = excerpts.get(row.id);
      const tags = Array.isArray(stored) ? [...stored] : [];
      for (const id of nodeTags.get(row.id) || []) {
        if (id && !tags.includes(id)) tags.push(id);
      }
      const storedTitle = looked?.title || row.title || '';
      const storedExcerpt = looked?.excerpt || row.excerpt || row.summary || '';
      return {
        sourceId: row.id,
        title: storedTitle,
        excerpt: storedExcerpt || storedTitle,
        originalTitle: storedTitle,
        translation: looked?.translation || row.translation || '',
        tags,
        eventAt: Number(row.eventAt) || 0,
      };
    });
    const buckets = bucketCategoryItems(prepared, classification);
    const untaggedCount = buckets.find((bucket) => bucket.id === UNTAGGED_CATEGORY_ID)?.items.length || 0;
    const categories = [];
    for (const bucket of buckets) {
      const untagged = bucket.id === UNTAGGED_CATEGORY_ID;
      const modelCap = untagged ? Math.min(maxItems, UNTAGGED_MODEL_ITEMS) : maxItems;
      const sent = bucket.items.slice(0, modelCap);
      const sentShort = bucket.items.length > sent.length;
      const inputItems = sent.map((item) => ({
        sourceId: item.sourceId,
        title: item.title,
        excerpt: item.excerpt,
        tags: item.tags,
      }));
      const base = {
        id: bucket.id,
        label: bucket.label,
        inputCount: bucket.items.length,
        truncated: sentShort,
        model: '',
        promptHash: HOURLY_CATEGORY_PROMPT_HASH,
        generatedAt: now(),
        events: [],
      };
      const store = (events, model = '') => {
        const covered = coverCategoryEvents(events, bucket.items, CATEGORY_EVENT_STORE_LIMIT);
        return {
          ...base,
          events: covered.events,
          truncated: sentShort || covered.truncated,
          model: String(model || '').slice(0, 80),
          status: covered.events.length ? 'ready' : 'failed',
          generatedAt: now(),
        };
      };
      try {
        if (typeof agentRuntime?.run !== 'function') throw new Error('分类小时报没有模型执行器');
        const payload = {
          window,
          category: { id: bucket.id, label: bucket.label },
          items: inputItems,
          ...(untagged ? { eventLimit: UNTAGGED_MODEL_ITEMS } : {}),
          ...(sentShort ? { truncated: true } : {}),
        };
        const result = await agentRuntime.run({
          closedContext: true,
          closedTask: HOURLY_CATEGORY_TASK,
          webMode: 'off',
          allowedToolIds: [],
          workspaceId,
          message: JSON.stringify(payload),
          taskInstruction: HOURLY_CATEGORY_INSTRUCTION,
          usageStage: 'hourly-category',
          timeoutMs: 120_000,
        });
        const parsed = parseCategoryBriefOutput(result?.answer ?? result?.text ?? '', {
          categoryId: bucket.id,
          sourceIds: inputItems.map((item) => item.sourceId),
        });
        categories.push(store(parsed.events, result?.model || result?.modelId));
      } catch (error) {
        const saved = store([]);
        categories.push(saved.events.length ? saved : {
          ...saved,
          status: 'failed',
          error: String(error?.message || error).slice(0, 180) || '分类简报失败',
        });
      }
    }
    log(formatCategoryTagCensus(censusCategoryTags(prepared, categories.map((category) => ({
      id: category.id,
      items: buckets.find((bucket) => bucket.id === category.id)?.items || [],
      events: category.events,
    })), catalog), hourStart));
    const edition = {
      formatVersion: HOURLY_CATEGORY_FORMAT,
      id: `hcat:${hourStart}`,
      workspaceId,
      window,
      status: editionStatus(categories),
      dualRun: true,
      untaggedCount,
      categories,
      generatedAt: now(),
    };
    return repository.save(workspaceId, edition);
  }

  async function publishFromTree({ workspaceId = 'local', hourStart, snapshot = null } = {}) {
    if (!Number.isFinite(hourStart) || hourStart % HOUR_MS !== 0) throw new Error('小时起点必须为整小时');
    if (hourStart + HOUR_MS > now()) throw new Error('目标小时尚未结束');
    let items = null;
    if (snapshot && Array.isArray(snapshot.items)) items = snapshot.items;
    else if (typeof nodePort === 'function') {
      const nodes = await nodePort(workspaceId, hourStart) || [];
      items = nodes.map((node) => nodeToTreeCategoryItem(node)).filter(Boolean);
    }
    const edition = buildTreeCategoryEdition({
      workspaceId,
      hourStart,
      items: items || [],
      generatedAt: now(),
    });
    log([
      '[worker] hourly-category-tree',
      `hourStart=${hourStart}`,
      `items=${Array.isArray(items) ? items.length : 0}`,
      `buckets=${edition.categories.filter((category) => category.id !== UNTAGGED_CATEGORY_ID).length}`,
      `untagged=${edition.untaggedCount}`,
      'flash=0',
    ].join(' '));
    return repository.save(workspaceId, edition);
  }

  function get(workspaceId = 'local', hourStart) {
    if (!enabled) return { enabled: false, edition: null };
    if (!Number.isFinite(hourStart)) return { enabled: true, edition: null };
    return { enabled: true, edition: projectHourlyCategory(repository.get(workspaceId, hourStart)) };
  }

  return Object.freeze({ generateHour, publishFromTree, get, enabled });
}
