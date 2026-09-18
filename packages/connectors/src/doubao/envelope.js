function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const INPUT_PLACEHOLDER = '{{INPUT_JSON}}';
const CONCEPT_SEED_SYSTEM = `你是一个 concept seed 候选抽取器。你的任务是：从输入原文中抽取可作为后续知识生长起点的 concept seed。你只需要回收概念头部候选，不需要生成正式 concept 主库结构，不需要补充复杂字段。

抽取标准：
1. 只保留稳定、可复用的知识点。
2. 名称尽量短，优先名词或短词组。
3. 一个候选只表达一个知识点。
4. 结论句、行动建议、TODO、会议事项、项目口号、情绪表达，不要作为 concept seed。
5. 相近表达尽量合并为同一个候选。
6. 不确定时宁可拒绝，不要硬造。

输出要求：
1. 只输出合法 JSON，不要输出解释，不要输出 Markdown。
2. 顶层字段固定为：schema_version, batch_id, concept_seeds, rejected_candidates。
3. concept_seeds[*] 字段固定为：name, source_path, reason。
4. rejected_candidates[*] 字段固定为：text, source_path, reason。
5. source_path 只能引用输入 files 中提供的 path。
6. 如果没有可抽取内容，也必须返回空数组。`;

export function stripJsonFences(raw) {
  return text(raw).replace(/^```(?:jsonl|json)?\s*/i, '').replace(/\s*```$/i, '');
}

export function extractJsonValue(raw) {
  const source = stripJsonFences(raw);
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    // Fall through to the first balanced object.
  }
  const start = source.indexOf('{');
  if (start < 0) return null;
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
    if (char === '{') depth += 1;
    if (char === '}') {
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

export function fillInputPlaceholder(content, inputJson) {
  const rendered = typeof inputJson === 'string' ? inputJson : JSON.stringify(inputJson, null, 2);
  return String(content || '').split(INPUT_PLACEHOLDER).join(rendered);
}

export function materializeJsonlEnvelope(envelope) {
  const record = envelope && typeof envelope === 'object' ? { ...envelope } : {};
  const inputTemplate = record.input_template && typeof record.input_template === 'object'
    ? record.input_template
    : {};
  const messages = Array.isArray(record.messages)
    ? record.messages.map((message) => ({
      ...message,
      content: fillInputPlaceholder(message?.content, inputTemplate),
    }))
    : [];
  return { ...record, messages, input_template: inputTemplate };
}

export function jsonlEnvelopeLine(envelope) {
  return JSON.stringify(materializeJsonlEnvelope(envelope));
}

function asSeed(row, fallbackPath) {
  if (typeof row === 'string') {
    const name = text(row);
    return name ? { name, source_path: fallbackPath, reason: '' } : null;
  }
  const name = text(row?.name);
  if (!name) return null;
  return {
    name,
    source_path: text(row?.source_path) || fallbackPath,
    reason: text(row?.reason),
  };
}

function asRejected(row, fallbackPath) {
  const value = text(row?.text || row?.name);
  if (!value) return null;
  return {
    text: value,
    source_path: text(row?.source_path) || fallbackPath,
    reason: text(row?.reason),
  };
}

export function normalizeConceptSeedOutput(raw, options = {}) {
  const parsed = raw && typeof raw === 'object' ? raw : extractJsonValue(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const fallbackPath = text(options.fallbackPath);
  const seeds = Array.isArray(parsed.concept_seeds) ? parsed.concept_seeds : [];
  const rejected = Array.isArray(parsed.rejected_candidates) ? parsed.rejected_candidates : [];
  return {
    schema_version: text(parsed.schema_version) || 'concept_seed_extract_output.v0.1',
    batch_id: text(parsed.batch_id),
    concept_seeds: seeds.map((row) => asSeed(row, fallbackPath)).filter(Boolean),
    rejected_candidates: rejected.map((row) => asRejected(row, fallbackPath)).filter(Boolean),
  };
}

export function buildConceptSeedExtractEnvelope(options = {}) {
  const files = (Array.isArray(options.files) ? options.files : [])
    .map((file) => ({
      path: text(file?.path),
      title: text(file?.title) || text(file?.path),
      content: String(file?.content || ''),
    }))
    .filter((file) => file.path && file.content);
  const batchId = text(options.batchId) || 'seed_batch_0001';
  const customId = text(options.customId) || 'concept_seed_extract_0001';
  return {
    custom_id: customId,
    task: 'extract_concept_seed_heads',
    input_schema_version: 'concept_seed_extract_input.v0.1',
    messages: [
      { role: 'system', content: CONCEPT_SEED_SYSTEM },
      {
        role: 'user',
        content: '请基于下面输入 JSON 抽取 concept seed，并只输出固定 JSON。\n\n输入 JSON：\n{{INPUT_JSON}}',
      },
    ],
    input_template: {
      schema_version: 'concept_seed_extract_input.v0.1',
      batch_id: batchId,
      files,
    },
    output_schema_hint: 'concept_seed_extract_output.v0.1',
  };
}

export const FEED_TRANSLATE_INPUT_SCHEMA = 'feed_translate_input.v0.1';
export const FEED_TRANSLATE_OUTPUT_SCHEMA = 'feed_translate_output.v0.1';

const FEED_TRANSLATE_SYSTEM = `你是财经信息翻译器。把输入 JSON 中的英文或韩文译成简体中文，并做轻度清洗。

要求：
1. 保持事实、数字、日期、金额、百分比、公司名、产品名和股票代码准确。
2. 允许轻度清洗：去掉点赞/转发/导航等界面残渣、重复空白和明显无信息尾巴；不要总结，不要扩写，不要加评论或标题。
3. 已经通顺的中文保持原意，只清噪音。
4. id 必须原样返回。
5. 只输出合法 JSON，不要输出解释，不要输出 Markdown。
6. 顶层字段固定为：schema_version, batch_id, translations。
7. translations[*] 字段固定为：id, translated。
8. schema_version 必须是 feed_translate_output.v0.1。
9. batch_id 必须与输入 JSON 的 batch_id 一致。
10. 输入有几条，输出就必须有几条，不能丢 id。`;

export function buildFeedTranslateEnvelope(options = {}) {
  const targetLang = options.targetLang === 'en' ? 'en' : 'zh';
  const items = (Array.isArray(options.items) ? options.items : [])
    .map((item) => ({
      id: text(item?.id),
      text: text(item?.text || item?.body),
    }))
    .filter((item) => item.id && item.text);
  const batchId = text(options.batchId) || 'translate_batch_0001';
  const customId = text(options.customId) || `feed_translate_${batchId}`;
  return {
    custom_id: customId,
    task: 'translate_feed_items',
    input_schema_version: FEED_TRANSLATE_INPUT_SCHEMA,
    messages: [
      { role: 'system', content: FEED_TRANSLATE_SYSTEM },
      {
        role: 'user',
        content: '请基于下面输入 JSON 翻译，并只输出固定 JSON。\n\n输入 JSON：\n{{INPUT_JSON}}',
      },
    ],
    input_template: {
      schema_version: FEED_TRANSLATE_INPUT_SCHEMA,
      batch_id: batchId,
      target_lang: targetLang,
      items,
    },
    output_schema_hint: FEED_TRANSLATE_OUTPUT_SCHEMA,
  };
}

export function acceptFeedTranslateOutput(raw, options = {}) {
  const expectedIds = Array.isArray(options.itemIds)
    ? options.itemIds.map((id) => text(id)).filter(Boolean)
    : [];
  const source = typeof raw === 'string' || raw == null
    ? raw
    : (typeof raw.reply_text === 'string' ? raw.reply_text : raw);
  const parsed = source && typeof source === 'object' && !Array.isArray(source)
    ? source
    : extractJsonValue(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_json_object', translations: [] };
  }
  const rows = Array.isArray(parsed.translations)
    ? parsed.translations
    : (Array.isArray(parsed.items) ? parsed.items : []);
  if (!rows.length) {
    return { ok: false, reason: 'translations', translations: [] };
  }
  const allowed = new Set(expectedIds);
  const seen = new Set();
  const translations = [];
  for (const row of rows) {
    const id = text(row?.id || row?.item_id || row?.itemId);
    const translatedText = text(row?.translated || row?.translatedText);
    if (!id || !translatedText || seen.has(id)) continue;
    if (allowed.size && !allowed.has(id)) continue;
    seen.add(id);
    translations.push({ id, translatedText });
  }
  if (!translations.length) {
    return { ok: false, reason: 'empty_translations', translations: [] };
  }
  return { ok: true, reason: '', translations };
}

export function feedTranslateOutputComplete(raw, options = {}) {
  const accepted = acceptFeedTranslateOutput(raw, options);
  const expected = Array.isArray(options.itemIds)
    ? options.itemIds.map((id) => text(id)).filter(Boolean).length
    : 0;
  if (!accepted.ok) return false;
  if (!expected) return true;
  return accepted.translations.length >= expected;
}
