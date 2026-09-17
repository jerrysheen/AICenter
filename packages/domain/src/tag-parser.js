function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripTagChrome(raw) {
  return text(raw)
    .replace(/展开全部/g, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
}

function parseBalancedJson(source, start) {
  const open = source[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function isTagResultRow(row) {
  return Boolean(row && typeof row === 'object' && !Array.isArray(row) && Array.isArray(row.tags));
}

function scoreTagItems(items) {
  if (!Array.isArray(items) || !items.length) return -1;
  let tagRows = 0;
  let inputRows = 0;
  for (const row of items) {
    if (isTagResultRow(row)) tagRows += 1;
    else if (row && typeof row === 'object' && typeof row.text === 'string') inputRows += 1;
  }
  if (tagRows === 0) return -1;
  return tagRows * 10 - inputRows;
}

function itemsFromValue(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value.items) === false) return null;
  if (value.task === 'tag_texts' || Array.isArray(value.tag_catalog) || value.input_template) {
    return null;
  }
  return value.items;
}

export function extractTagBatchObject(raw) {
  let best = null;
  let bestScore = -1;

  function consider(value) {
    const items = itemsFromValue(value);
    const score = scoreTagItems(items);
    if (score > bestScore) {
      bestScore = score;
      best = { items };
    }
  }

  if (raw && typeof raw === 'object' && typeof raw.reply_text !== 'string') {
    consider(raw);
    if (bestScore >= 0) return best;
  }

  const source = stripTagChrome(
    typeof raw === 'string' || raw == null
      ? raw
      : (typeof raw.reply_text === 'string' ? raw.reply_text : ''),
  );
  if (!source) return bestScore >= 0 ? best : null;
  try {
    consider(JSON.parse(source));
  } catch {
    // Scan balanced objects and arrays below.
  }
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{' || char === '[') consider(parseBalancedJson(source, index));
  }
  return bestScore >= 0 ? best : null;
}

export function parseTagBatchOutput(raw, options = {}) {
  const expectedIds = new Set((options.itemIds || []).map((id) => text(id)).filter(Boolean));
  const catalogIds = options.catalogIds instanceof Set
    ? options.catalogIds
    : new Set(options.catalogIds || []);
  const maxTags = Number.isInteger(options.maxTags) ? options.maxTags : Infinity;
  const parsed = extractTagBatchObject(raw);
  if (!parsed || !Array.isArray(parsed.items)) {
    return {
      ok: false,
      reason: 'not_json_items',
      accepted: [],
      missingItemIds: [...expectedIds],
      unknownItems: [],
      unknownTags: [],
      warnings: ['模型输出不是带 tags 的 JSON'],
    };
  }

  const accepted = [];
  const unknownItems = [];
  const unknownTags = [];
  const warnings = [];
  const seen = new Set();

  for (const row of parsed.items) {
    if (!isTagResultRow(row)) continue;
    const itemId = text(row?.item_id || row?.itemId || row?.id);
    if (!itemId || seen.has(itemId)) continue;
    if (expectedIds.size && !expectedIds.has(itemId)) {
      unknownItems.push(itemId);
      warnings.push(`丢弃未知 item_id：${itemId}`);
      continue;
    }
    seen.add(itemId);
    const tags = [];
    const used = new Set();
    for (const value of row.tags) {
      const tagId = text(value);
      if (!tagId || used.has(tagId)) continue;
      if (catalogIds.size && !catalogIds.has(tagId)) {
        unknownTags.push({ itemId, tagId });
        warnings.push(`丢弃未知 tag：${tagId}（item ${itemId}）`);
        continue;
      }
      used.add(tagId);
      tags.push(tagId);
      if (tags.length >= maxTags) break;
    }
    accepted.push({ itemId, tags });
  }

  if (!accepted.length && !unknownItems.length) {
    return {
      ok: false,
      reason: 'not_json_items',
      accepted: [],
      missingItemIds: [...expectedIds],
      unknownItems: [],
      unknownTags: [],
      warnings: ['模型输出里没有带 tags 的条目'],
    };
  }

  const missingItemIds = [...expectedIds].filter((id) => !seen.has(id));
  if (missingItemIds.length) {
    warnings.push(`漏回 ${missingItemIds.length} 条 item，将单独重试`);
  }

  return {
    ok: true,
    reason: missingItemIds.length ? 'partial' : '',
    accepted,
    missingItemIds,
    unknownItems,
    unknownTags,
    warnings,
  };
}

export function tagBatchOutputComplete(raw, options = {}) {
  const parsed = parseTagBatchOutput(raw, options);
  if (!parsed.ok) return false;
  const expected = (options.itemIds || []).filter(Boolean).length;
  if (!expected) return parsed.accepted.length > 0;
  return parsed.accepted.length >= expected;
}
