const DEFAULT_CHAR_BUDGET = 5_000;
const DEFAULT_ITEM_LIMIT = 30;

export const TAG_BATCH_MAX_ITEMS = 20;
export const TAG_BATCH_CHAR_BUDGET = 30_000;
export const TAG_ITEM_MAX_CHARS = 6_000;
export const TAG_ITEM_HEAD_CHARS = 4_500;
export const TAG_ITEM_TAIL_CHARS = 1_500;

function textOf(item, purpose) {
  if (purpose === 'analyze') {
    const explicit = String(item?.text || '').trim();
    if (explicit) return explicit;
    return [item?.title, item?.summary, item?.body]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join('\n');
  }
  return String(item?.text || item?.body || '').trim();
}

function clipHead(source, maxChars) {
  if (source.length <= maxChars) return { text: source, truncatedForModel: false };
  return { text: source.slice(0, maxChars).trimEnd(), truncatedForModel: true };
}

function clipHeadTail(source, maxChars, headChars, tailChars) {
  if (source.length <= maxChars) return { text: source, truncatedForModel: false };
  const head = Math.max(1, Math.min(headChars, maxChars));
  const tail = Math.max(0, Math.min(tailChars, maxChars - head));
  if (!tail) return clipHead(source, maxChars);
  return {
    text: `${source.slice(0, head)}${source.slice(-tail)}`,
    truncatedForModel: true,
  };
}

function clipForModel(value, options) {
  const source = String(value || '');
  if (options.clipMode === 'head-tail') {
    return clipHeadTail(source, options.itemMaxChars, options.headChars, options.tailChars);
  }
  return clipHead(source, options.itemMaxChars);
}

export function packFeedAiBatches(items, options = {}) {
  const purpose = options.purpose === 'analyze' ? 'analyze' : 'translate';
  const charBudget = Math.max(500, Number(options.charBudget)
    || (purpose === 'analyze' ? TAG_BATCH_CHAR_BUDGET : DEFAULT_CHAR_BUDGET));
  const itemLimit = Math.max(1, Number(options.itemLimit) || DEFAULT_ITEM_LIMIT);
  const maxItemsPerBatch = Math.max(1, Number(options.maxItemsPerBatch)
    || (purpose === 'analyze' ? TAG_BATCH_MAX_ITEMS : 50));
  const itemMaxChars = Math.max(1, Number(options.itemMaxChars || options.itemClipChars)
    || (purpose === 'analyze' ? TAG_ITEM_MAX_CHARS : charBudget));
  const clipMode = options.clipMode || (purpose === 'analyze' ? 'head-tail' : 'head');
  const headChars = Math.max(1, Number(options.headChars) || TAG_ITEM_HEAD_CHARS);
  const tailChars = Math.max(0, Number(options.tailChars) || TAG_ITEM_TAIL_CHARS);
  const selected = Array.isArray(items) ? items.slice(0, itemLimit) : [];
  const batches = [];
  let units = [];
  let used = 0;

  function flush() {
    if (!units.length) return;
    batches.push({
      purpose,
      charBudget,
      totalChars: used,
      itemCount: units.length,
      units,
    });
    units = [];
    used = 0;
  }

  for (const item of selected) {
    const itemId = String(item?.id || item?.itemId || '').trim();
    const full = textOf(item, purpose);
    if (!itemId || !full) continue;
    const packed = clipForModel(full, {
      clipMode,
      itemMaxChars,
      headChars,
      tailChars,
    });
    if (units.length && (units.length >= maxItemsPerBatch || used + packed.text.length > charBudget)) {
      flush();
    }
    units.push({
      itemId,
      text: packed.text,
      charCount: full.length,
      packedChars: packed.text.length,
      truncatedForModel: packed.truncatedForModel,
      kind: purpose === 'analyze' ? 'text' : 'feed-item',
    });
    used += packed.text.length;
  }
  flush();
  return {
    purpose,
    charBudget,
    itemLimit,
    maxItemsPerBatch,
    batchCount: batches.length,
    batches,
  };
}
