import { createHash } from 'node:crypto';
import { HOURLY_CATEGORY_FORMAT, UNTAGGED_CATEGORY_ID } from '../../contracts/src/hourly-category.js';
import { localizationItemId } from './localize-texts.js';
import { treeCatalog } from './information-tree-policy.js';

export const HOURLY_CATEGORY_TASK = 'hourly-category-brief';
export const UNTAGGED_CATEGORY_LABEL = '待标注';
export const CATEGORY_EXCERPT_CHARS = 200;
export const CATEGORY_TITLE_CHARS = 180;
export const CATEGORY_EVENT_LIMIT = 12;
export const CATEGORY_BUCKET_ITEM_LIMIT = 40;
const HOUR_MS = 3_600_000;

export const HOURLY_CATEGORY_INSTRUCTION = [
  '只根据给定 JSON 写这一类在该小时里发生的事。不要联网，不要读取或补写正文，不要编造输入里没有的事实。',
  '返回一个 JSON 对象，不要 Markdown。形状必须是 {"categoryId":"...","events":[{"bullet":"...","sourceIds":["..."]}]}。',
  'categoryId 必须与输入 category.id 相同。每条 sourceIds 只能使用输入 items 里的 sourceId，且至少包含一个。',
  '事件建议 8 到 12 条，最多 12 条。同一件事合并成一条，bullet 用一句简体中文。',
  '输入 truncated 为 true 时，只概括已经给出的条目。',
].join('\n');

export const HOURLY_CATEGORY_PROMPT_HASH = createHash('sha256').update(HOURLY_CATEGORY_INSTRUCTION).digest('hex');

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
  const classification = classificationOf(catalog);
  for (const raw of Array.isArray(tagIds) ? tagIds : []) {
    const id = String(raw || '').trim();
    if (!id || id === UNTAGGED_CATEGORY_ID) continue;
    const grouped = classification.group(id);
    if (grouped) return grouped;
  }
  return UNTAGGED_CATEGORY_ID;
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
    const id = primaryCategoryId(item?.tags, classification);
    const bucket = grouped.get(id) || [];
    bucket.push({
      sourceId,
      title: clipCategoryText(item?.title, CATEGORY_TITLE_CHARS),
      excerpt: clipCategoryText(item?.excerpt || item?.summary || item?.title, CATEGORY_EXCERPT_CHARS),
      tags: (Array.isArray(item?.tags) ? item.tags : []).map((tag) => String(tag || '').trim()).filter(Boolean),
      eventAt: Number(item?.eventAt) || 0,
    });
    grouped.set(id, bucket);
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

function editionStatus(categories) {
  if (!categories.length) return 'ready';
  const failed = categories.filter((category) => category.status === 'failed').length;
  if (!failed) return 'ready';
  if (failed === categories.length) return 'failed';
  return 'partial';
}

export function createHourlyCategoryService({
  repository,
  taggingRepository = null,
  candidatePort = null,
  catalog = { tags: [] },
  agentRuntime = null,
  excerptPort = null,
  enabled = false,
  now = () => Date.now(),
  maxItems = CATEGORY_BUCKET_ITEM_LIMIT,
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
    const excerpts = new Map();
    if (excerptPort) {
      for (const row of await excerptPort(workspaceId, candidates) || []) {
        if (row?.id) excerpts.set(row.id, row);
      }
    }
    const prepared = candidates.map((row) => {
      const key = categoryTaggingKey(row.id);
      const tags = key ? tagMap.get(`${key.resourceType}:${key.resourceId}`) : undefined;
      const looked = excerpts.get(row.id);
      return {
        sourceId: row.id,
        title: looked?.title || row.title || '',
        excerpt: looked?.excerpt || row.excerpt || row.summary || row.title || '',
        tags: Array.isArray(tags) ? tags : [],
        eventAt: Number(row.eventAt) || 0,
      };
    });
    const buckets = bucketCategoryItems(prepared, classification);
    const untaggedCount = buckets.find((bucket) => bucket.id === UNTAGGED_CATEGORY_ID)?.items.length || 0;
    const categories = [];
    for (const bucket of buckets) {
      const sent = bucket.items.slice(0, maxItems);
      const truncated = bucket.items.length > sent.length;
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
        truncated,
        model: '',
        promptHash: HOURLY_CATEGORY_PROMPT_HASH,
        generatedAt: now(),
        events: [],
      };
      try {
        if (typeof agentRuntime?.run !== 'function') throw new Error('分类小时报没有模型执行器');
        const payload = {
          window,
          category: { id: bucket.id, label: bucket.label },
          items: inputItems,
          ...(truncated ? { truncated: true } : {}),
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
        categories.push({
          ...base,
          events: parsed.events,
          model: String(result?.model || result?.modelId || '').slice(0, 80),
          status: 'ready',
          generatedAt: now(),
        });
      } catch (error) {
        categories.push({
          ...base,
          status: 'failed',
          error: String(error?.message || error).slice(0, 180) || '分类简报失败',
          generatedAt: now(),
        });
      }
    }
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

  function get(workspaceId = 'local', hourStart) {
    if (!enabled) return { enabled: false, edition: null };
    if (!Number.isFinite(hourStart)) return { enabled: true, edition: null };
    return { enabled: true, edition: projectHourlyCategory(repository.get(workspaceId, hourStart)) };
  }

  return Object.freeze({ generateHour, get, enabled });
}
