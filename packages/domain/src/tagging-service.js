import {
  TAG_BATCH_CHAR_BUDGET,
  TAG_BATCH_MAX_ITEMS,
  TAG_ITEM_MAX_CHARS,
  packFeedAiBatches,
  taggingText,
} from './feed-ai-batch.js';
import { loadTagCatalog, projectTagCatalog, selectionModeFor } from './tag-catalog.js';
import { parseTagBatchOutput } from './tag-parser.js';
import { translationLooksTruncated } from './localize-texts.js';
import { TAG_PROMPT_VERSION, buildFeedPreprocessPayload, buildFeedPreprocessSystem, buildTagSystemPrompt, buildTagUserPayload } from './tag-prompt.js';

function text(value) {
  return String(value || '').trim();
}

function keywordMatches(keyword, source) {
  const term = text(keyword);
  if (!term || !source) return false;
  if (/^[A-Za-z0-9]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i').test(source);
  }
  if (term === '黄金') {
    return source.replace(/黄金(时间|周|时代|窗口|搭档|比例|坑)/g, '').includes('黄金');
  }
  return source.includes(term);
}

function itemText(item) {
  return [item?.title, item?.summary, item?.body, item?.text].map((part) => String(part || '')).join('\n');
}

function weakKeyword(keyword) {
  return /^[A-Za-z0-9]{1,3}$/.test(text(keyword));
}

function countKeyword(keyword, source) {
  const term = text(keyword);
  if (!term || !source) return 0;
  if (/^[A-Za-z0-9]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return source.match(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi'))?.length || 0;
  }
  if (term === '黄金') {
    return source.replace(/黄金(时间|周|时代|窗口|搭档|比例|坑)/g, '').split('黄金').length - 1;
  }
  return source.split(term).length - 1;
}

function aiEvidence(tag, source) {
  const keywords = tag?.keywords || [];
  const strong = keywords.some((keyword) => !weakKeyword(keyword) && keywordMatches(keyword, source));
  let weakHits = 0;
  for (const keyword of keywords) {
    if (!weakKeyword(keyword)) continue;
    weakHits += countKeyword(keyword, source);
  }
  return { strong, weakHits };
}

function tagSupportedByText(tag, source) {
  if (tag?.id !== 'ai') return true;
  const { strong, weakHits } = aiEvidence(tag, source);
  if (strong) return true;
  if (!weakHits) return false;
  if (weakHits < 2 && String(source || '').length > 80) return false;
  return true;
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
    recordEmptyWhenUnlabeled = false,
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
    const failedIds = new Set();
    const answeredOmission = new Set();
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
      const records = parsed.accepted.map((row) => {
        const origin = originals.get(row.itemId) || {};
        const source = taggingText(origin);
        const tags = row.tags.filter((id) => id !== 'ai' || tagSupportedByText(
          loaded.tags.find((tag) => tag.id === 'ai'),
          source,
        ));
        return {
          workspaceId,
          resourceType,
          resourceId: row.itemId,
          tags,
          tagCatalogVersion: loaded.version,
          promptVersion: TAG_PROMPT_VERSION,
          model: asked?.model || 'gemini',
          truncatedForModel: Boolean(truncated.get(row.itemId)),
          analyzedAt: now(),
        };
      });
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
        const failedItemIds = batch.units.map((unit) => unit.itemId);
        for (const id of failedItemIds) failedIds.add(id);
        batchReports.push({
          customId: `tag_${stamp}_${String(batchIndex).padStart(4, '0')}`,
          status: 'failed',
          itemCount: batch.itemCount,
          saved: 0,
          missingItemIds: failedItemIds,
        });
        missing.push(...failedItemIds);
        batchIndex += 1;
        continue;
      }
      if (report.status === 'failed' && report.parsed?.emptyAnswer !== true) {
        for (const id of report.parsed.missingItemIds) failedIds.add(id);
      } else {
        for (const id of report.parsed.missingItemIds) answeredOmission.add(id);
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
          const emptyAnswer = report.parsed?.emptyAnswer === true;
          const stillMissing = report.status === 'failed'
            ? retryIds
            : report.parsed.missingItemIds;
          if (report.status === 'failed' && !emptyAnswer) {
            for (const id of stillMissing) {
              if (!answeredOmission.has(id)) failedIds.add(id);
            }
          } else {
            for (const id of stillMissing) answeredOmission.add(id);
          }
          missing.length = 0;
          missing.push(...stillMissing);
        } catch (error) {
          logger.warn?.('[tagging] retry batch failed', error);
          for (const id of retryIds) {
            if (!answeredOmission.has(id)) failedIds.add(id);
          }
        }
      }
    }

    if (recordEmptyWhenUnlabeled) {
      const savedIds = new Set(saved.map((row) => row.resourceId));
      const unlabeledIds = [...answeredOmission].filter((id) => !savedIds.has(id) && !failedIds.has(id));
      if (unlabeledIds.length) {
        const records = unlabeledIds.map((id) => ({
          workspaceId,
          resourceType,
          resourceId: id,
          tags: [],
          tagCatalogVersion: loaded.version,
          promptVersion: TAG_PROMPT_VERSION,
          model: '',
          truncatedForModel: false,
          analyzedAt: now(),
        }));
        saved.push(...(taggingRepository?.saveTaggings ? taggingRepository.saveTaggings(records) : records));
        const unlabeled = new Set(unlabeledIds);
        for (let index = missing.length - 1; index >= 0; index -= 1) {
          if (unlabeled.has(missing[index])) missing.splice(index, 1);
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

  function parseFeedPreprocessReply(raw, itemId) {
    const source = String(typeof raw === 'string' ? raw : (raw?.reply_text || ''))
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    if (!source) return null;
    let parsed;
    try { parsed = JSON.parse(source); } catch { return null; }
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : [parsed]);
    const row = rows.find((entry) => String(entry?.item_id || entry?.id || '').trim() === itemId) || rows[0];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const id = String(row.item_id || row.id || '').trim();
    if (id && id !== itemId) return null;
    if (!Array.isArray(row.tags)) return null;
    return {
      translatedText: String(row.translated_text || row.zh_body || row.zh || '').trim(),
      tags: row.tags,
    };
  }

  async function preprocessShortItem({
    workspaceId = 'local',
    resourceType = 'content-item',
    item,
    originalText,
  } = {}) {
    if (!taggingPort?.preprocessItem) throw new Error('尚未配置合并预处理');
    const id = text(item?.id || item?.itemId);
    const source = text(originalText);
    if (!id || !source) throw new Error('没有可预处理的原文');
    const asked = await taggingPort.preprocessItem({
      systemPrompt: buildFeedPreprocessSystem(),
      userPayload: buildFeedPreprocessPayload({ catalog: projection, itemId: id, originalText: source }),
    });
    const reply = parseFeedPreprocessReply(asked?.reply_text ?? asked, id);
    if (!reply?.translatedText) throw new Error('合并预处理没有返回译文');
    if (translationLooksTruncated(source, reply.translatedText.length, reply.translatedText)) {
      throw new Error('合并预处理译文不完整');
    }
    const parsed = parseTagBatchOutput({
      items: [{ item_id: id, tags: reply.tags }],
    }, { itemIds: [id], catalogIds: loaded.ids });
    if (!parsed.ok || parsed.missingItemIds.length) throw new Error('合并预处理没有返回标签');
    const tags = (parsed.accepted[0]?.tags || []).filter((tagId) => tagId !== 'ai' || tagSupportedByText(
      loaded.tags.find((tag) => tag.id === 'ai'),
      source,
    ));
    const record = {
      workspaceId,
      resourceType,
      resourceId: id,
      tags,
      tagCatalogVersion: loaded.version,
      promptVersion: TAG_PROMPT_VERSION,
      model: asked?.model || 'gemma-4-26b-a4b-it',
      truncatedForModel: false,
      analyzedAt: now(),
    };
    const saved = taggingRepository?.saveTaggings ? taggingRepository.saveTaggings([record]) : [record];
    return {
      resourceId: id,
      sourceText: source,
      translatedText: reply.translatedText,
      targetLang: 'zh',
      engine: String(asked?.model || record.model).slice(0, 32),
      tags,
      saved: saved[0] || record,
    };
  }

  function tagsForText(tagIds, source) {
    const wanted = new Set((tagIds || []).map((id) => text(id)).filter((id) => loaded.ids.has(id)));
    const hits = [];
    for (const tag of loaded.tags) {
      if (!wanted.has(tag.id)) continue;
      if (!(tag.keywords || []).some((keyword) => keywordMatches(keyword, source))) continue;
      hits.push(tag.id);
      if (tag.parent_id && loaded.ids.has(tag.parent_id) && !hits.includes(tag.parent_id)) {
        hits.push(tag.parent_id);
      }
    }
    return hits;
  }

  function supplementTags({
    workspaceId = 'local',
    resourceType = 'content-item',
    items = [],
    tagIds = [],
    persist = true,
  } = {}) {
    const originals = [];
    for (const item of items) {
      const id = text(item?.id || item?.itemId);
      if (!id) continue;
      originals.push({ id, text: itemText(item) });
    }
    const existing = new Map(
      listSaved(workspaceId, resourceType, originals.map((item) => item.id))
        .map((row) => [row.resourceId, row]),
    );
    const records = [];
    for (const item of originals) {
      const hits = tagsForText(tagIds, item.text);
      if (!hits.length) continue;
      const row = existing.get(item.id);
      const current = row?.tags || [];
      const next = [...new Set([...current, ...hits])];
      if (next.length === current.length) continue;
      records.push({
        workspaceId,
        resourceType,
        resourceId: item.id,
        tags: next,
        tagCatalogVersion: row?.tagCatalogVersion || loaded.version,
        promptVersion: row?.promptVersion || TAG_PROMPT_VERSION,
        model: row?.model || 'keyword',
        truncatedForModel: Boolean(row?.truncatedForModel),
        analyzedAt: now(),
      });
    }
    const saved = persist && records.length && taggingRepository?.saveTaggings
      ? taggingRepository.saveTaggings(records)
      : [];
    return {
      resourceType,
      considered: originals.length,
      matched: records,
      saved,
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
    preprocessShortItem,
    supplementTags,
    pruneUnsupportedTags({
      workspaceId = 'local',
      resourceType = 'content-item',
      items = [],
      persist = true,
    } = {}) {
      const originals = [];
      for (const item of items) {
        const id = text(item?.id || item?.itemId);
        if (!id) continue;
        originals.push({
          id,
          source: taggingText(item),
          author: text(item?.author || item?.authorName || item?.author_name),
        });
      }
      const existing = new Map(
        listSaved(workspaceId, resourceType, originals.map((item) => item.id))
          .map((row) => [row.resourceId, row]),
      );
      const records = [];
      for (const item of originals) {
        const row = existing.get(item.id);
        if (!row?.tags?.length) continue;
        const aiTag = loaded.tags.find((tag) => tag.id === 'ai');
        const evidence = aiEvidence(aiTag, item.source);
        const authorLeak = !evidence.strong && !evidence.weakHits
          && (keywordMatches('AI', item.author) || item.author.includes('人工智能'));
        const tags = row.tags.filter((id) => id !== 'ai' || !authorLeak);
        if (tags.length === row.tags.length) continue;
        records.push({
          workspaceId,
          resourceType,
          resourceId: item.id,
          tags,
          tagCatalogVersion: row.tagCatalogVersion || loaded.version,
          promptVersion: row.promptVersion || TAG_PROMPT_VERSION,
          model: row.model || '',
          truncatedForModel: Boolean(row.truncatedForModel),
          analyzedAt: now(),
        });
      }
      const saved = persist && records.length && taggingRepository?.saveTaggings
        ? taggingRepository.saveTaggings(records)
        : [];
      return { considered: originals.length, matched: records, saved };
    },
  });
}
