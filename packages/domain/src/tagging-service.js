import {
  TAG_BATCH_CHAR_BUDGET,
  TAG_BATCH_MAX_ITEMS,
  TAG_ITEM_MAX_CHARS,
  packFeedAiBatches,
} from './feed-ai-batch.js';
import { loadTagCatalog, projectTagCatalog, selectionModeFor } from './tag-catalog.js';
import { parseTagBatchOutput } from './tag-parser.js';
import { TAG_PROMPT_VERSION, buildTagSystemPrompt, buildTagUserPayload } from './tag-prompt.js';

function text(value) {
  return String(value || '').trim();
}

function dateStamp(now) {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function modelItemsForBatch(batch, originals) {
  return batch.units.map((unit) => {
    const origin = originals.get(unit.itemId) || {};
    return {
      item_id: unit.itemId,
      source: origin.source || '',
      author: origin.author || '',
      text: unit.text,
    };
  });
}

export function createTaggingService({ catalog, taggingRepository, taggingPort, now = () => Date.now(), logger = console } = {}) {
  const loaded = loadTagCatalog(catalog);
  const projection = projectTagCatalog(loaded);

  function listSaved(workspaceId, resourceType, resourceIds) {
    return taggingRepository?.listTaggings?.(workspaceId, resourceType, resourceIds) || [];
  }

  async function analyzeItems({
    workspaceId = 'local',
    resourceType = 'content-item',
    items = [],
    force = false,
    selection,
  } = {}) {
    if (!taggingPort?.tagBatch) throw new Error('尚未配置 taggingPort');
    const mode = selection || selectionModeFor(resourceType);
    const maxTags = mode === 'single' ? 1 : Infinity;
    const originals = new Map();
    for (const item of items) {
      const id = String(item?.id || item?.itemId || '').trim();
      if (!id) continue;
      originals.set(id, {
        source: item.source || '',
        author: item.author || item.authorName || '',
        title: item.title || '',
        summary: item.summary || '',
        body: item.body || '',
        text: item.text || '',
      });
    }
    const existing = force ? [] : listSaved(workspaceId, resourceType, [...originals.keys()]);
    const skip = new Set(
      existing
        .filter((row) => row.tagCatalogVersion === loaded.version && row.promptVersion === TAG_PROMPT_VERSION)
        .map((row) => row.resourceId),
    );
    const pending = [...originals.entries()]
      .filter(([id]) => !skip.has(id))
      .map(([id, item]) => ({ id, ...item }));
    if (!pending.length) {
      return {
        resourceType,
        tagCatalogVersion: loaded.version,
        promptVersion: TAG_PROMPT_VERSION,
        skipped: skip.size,
        saved: [],
        missingItemIds: [],
        batches: [],
      };
    }

    const packed = packFeedAiBatches(pending, {
      purpose: 'analyze',
      charBudget: TAG_BATCH_CHAR_BUDGET,
      itemLimit: pending.length,
      maxItemsPerBatch: TAG_BATCH_MAX_ITEMS,
      itemMaxChars: TAG_ITEM_MAX_CHARS,
    });
    const truncated = new Map(packed.batches.flatMap((batch) => batch.units.map((unit) => [unit.itemId, unit.truncatedForModel])));
    const stamp = dateStamp(now());
    const saved = [];
    const missing = [];
    const batchReports = [];
    const warnings = [];

    async function submitBatch(units, index, suffix = '') {
      const customId = `tag_${stamp}_${String(index).padStart(4, '0')}${suffix}`;
      const payloadItems = modelItemsForBatch({ units }, originals);
      const asked = await taggingPort.tagBatch({
        customId,
        selection: mode,
        systemPrompt: buildTagSystemPrompt(mode),
        userPayload: buildTagUserPayload({ catalog: projection, items: payloadItems, selection: mode }),
      });
      const parsed = parseTagBatchOutput(asked?.reply_text ?? asked, {
        itemIds: units.map((unit) => unit.itemId),
        catalogIds: loaded.ids,
        maxTags,
      });
      if (!parsed.ok) {
        return { customId, status: 'failed', parsed, model: asked?.model || '' };
      }
      const records = parsed.accepted.map((row) => ({
        workspaceId,
        resourceType,
        resourceId: row.itemId,
        tags: row.tags,
        tagCatalogVersion: loaded.version,
        promptVersion: TAG_PROMPT_VERSION,
        model: asked?.model || 'doubao',
        truncatedForModel: Boolean(truncated.get(row.itemId)),
        analyzedAt: now(),
      }));
      if (records.length && taggingRepository?.saveTaggings) {
        saved.push(...taggingRepository.saveTaggings(records));
      } else {
        saved.push(...records);
      }
      warnings.push(...parsed.warnings);
      const status = parsed.missingItemIds.length ? 'partial' : 'completed';
      return { customId, status, parsed, model: asked?.model || '' };
    }

    let batchIndex = 1;
    for (const batch of packed.batches) {
      let report;
      try {
        report = await submitBatch(batch.units, batchIndex);
      } catch (error) {
        logger.warn?.(`[tagging] batch ${batchIndex} failed`, error);
        batchReports.push({
          customId: `tag_${stamp}_${String(batchIndex).padStart(4, '0')}`,
          status: 'failed',
          itemCount: batch.itemCount,
          saved: 0,
          missingItemIds: batch.units.map((unit) => unit.itemId),
        });
        missing.push(...batch.units.map((unit) => unit.itemId));
        batchIndex += 1;
        continue;
      }
      batchReports.push({
        customId: report.customId,
        status: report.status,
        itemCount: batch.itemCount,
        saved: report.parsed.accepted.length,
        missingItemIds: report.parsed.missingItemIds,
        unknownTags: report.parsed.unknownTags,
      });
      missing.push(...report.parsed.missingItemIds);
      batchIndex += 1;
    }

    const retryIds = [...new Set(missing)];
    if (retryIds.length) {
      const retryUnits = packed.batches
        .flatMap((batch) => batch.units)
        .filter((unit) => retryIds.includes(unit.itemId));
      if (retryUnits.length) {
        try {
          const report = await submitBatch(retryUnits, batchIndex, '_retry');
          batchReports.push({
            customId: report.customId,
            status: report.status,
            itemCount: retryUnits.length,
            saved: report.parsed.accepted.length,
            missingItemIds: report.parsed.missingItemIds,
            unknownTags: report.parsed.unknownTags,
          });
          const stillMissing = report.status === 'failed'
            ? retryIds
            : report.parsed.missingItemIds;
          missing.length = 0;
          missing.push(...stillMissing);
        } catch (error) {
          logger.warn?.('[tagging] retry batch failed', error);
        }
      }
    }

    if (!saved.length && pending.length) {
      throw new Error('标注全部失败');
    }

    return {
      resourceType,
      tagCatalogVersion: loaded.version,
      promptVersion: TAG_PROMPT_VERSION,
      skipped: skip.size,
      saved,
      missingItemIds: [...new Set(missing)],
      batches: batchReports,
      warnings,
      jsonlLineCount: packed.batchCount,
    };
  }

  return Object.freeze({
    catalogVersion: loaded.version,
    promptVersion: TAG_PROMPT_VERSION,
    listCatalog() {
      return { version: loaded.version, tags: projection };
    },
    resolveTagQuery(query) {
      const needle = text(query).toLowerCase();
      if (!needle) return [];
      const seen = new Set();
      const matched = [];
      for (const tag of loaded.tags) {
        const id = tag.id.toLowerCase();
        const name = tag.name.toLowerCase();
        const keywords = (tag.keywords || []).map((item) => item.toLowerCase());
        const hit = id === needle
          || name === needle
          || keywords.includes(needle)
          || (needle.length >= 2 && name.includes(needle));
        if (!hit || seen.has(tag.id)) continue;
        seen.add(tag.id);
        matched.push({ id: tag.id, name: tag.name, parent_id: tag.parent_id ?? null });
      }
      return matched;
    },
    findTaggedResources({ workspaceId, resourceType = 'content-item', tagIds = [], limit = 500 } = {}) {
      const ids = [...new Set((tagIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
      if (!ids.length) return [];
      return taggingRepository?.listByTags?.(workspaceId, resourceType, ids, { limit }) || [];
    },
    getTagging(workspaceId, resourceType, resourceId) {
      return taggingRepository?.getTagging?.(workspaceId, resourceType, resourceId) || null;
    },
    listTaggings(workspaceId, resourceType, resourceIds) {
      return listSaved(workspaceId, resourceType, resourceIds);
    },
    analyzeItems,
  });
}
