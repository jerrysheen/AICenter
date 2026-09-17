import { parseContract, TagCatalogFileSchema, ValidationError } from '../../contracts/src/index.js';

function text(value) {
  return String(value || '').trim();
}

export function loadTagCatalog(source) {
  if (source?.ids instanceof Set && Array.isArray(source.tags) && source.version) {
    return source;
  }
  const raw = typeof source === 'string' ? JSON.parse(source) : source;
  const catalog = parseContract(TagCatalogFileSchema, raw);
  const byId = new Map();
  for (const tag of catalog.tags) {
    if (byId.has(tag.id)) throw new ValidationError(`tag id 重复：${tag.id}`, ['tags']);
    byId.set(tag.id, {
      id: tag.id,
      name: tag.name,
      level: tag.level || (tag.parent_id ? 2 : 1),
      parent_id: tag.parent_id ?? null,
      keywords: Array.isArray(tag.keywords) ? tag.keywords.map((item) => text(item)).filter(Boolean) : [],
    });
  }
  for (const tag of byId.values()) {
    if (!tag.parent_id) continue;
    if (!byId.has(tag.parent_id)) {
      throw new ValidationError(`tag ${tag.id} 的 parent_id 不存在：${tag.parent_id}`, ['parent_id']);
    }
    if (tag.parent_id === tag.id) {
      throw new ValidationError(`tag ${tag.id} 不能指向自己`, ['parent_id']);
    }
  }
  return {
    version: catalog.version,
    tags: [...byId.values()],
    ids: new Set(byId.keys()),
  };
}

export function projectTagCatalog(catalog) {
  return (catalog?.tags || []).map((tag) => ({
    id: tag.id,
    name: tag.name,
    parent_id: tag.parent_id ?? null,
    keywords: tag.keywords || [],
  }));
}

export function selectionModeFor(resourceType) {
  return resourceType === 'inspiration' ? 'single' : 'multi';
}
