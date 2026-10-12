import { READING_CLASS_VERSION } from './reading-focus-route.js';
import { READING_CLASS_INSTRUCTION } from './reading-hour-service.js';

// Same per-item body cap as classificationInput in reading-hour-service.js.
export const CLASSIFICATION_BODY_LIMIT = 8000;
export const PRIMARY_DIRECTIONS = ['finance', 'industry', 'ai', 'geopolitics', 'other', 'pending'];
export const SUBJECT_KINDS = ['macro_policy', 'market_asset', 'company_event', 'company_security', 'ai_model_method', 'ai_application', 'geopolitics_event', 'geopolitics_rules', 'other', 'unknown'];
const DIRECTIONS = new Set(PRIMARY_DIRECTIONS);
const KINDS = new Set(SUBJECT_KINDS);
const SINGLE_OUTPUT = /仅返回 JSON：\{[\s\S]*$/;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function classificationPayload(item) {
  const body = String(item?.body || '');
  const included = body.length > CLASSIFICATION_BODY_LIMIT ? body.slice(0, CLASSIFICATION_BODY_LIMIT) : body;
  return {
    title: item?.title || '',
    summary: item?.summary ?? item?.text ?? '',
    body: included,
    inputScope: body.length > CLASSIFICATION_BODY_LIMIT ? 'saved-body-prefix' : 'saved-article',
    bodyChars: body.length,
    includedChars: included.length,
  };
}

export function batchClassificationInstruction(single = READING_CLASS_INSTRUCTION) {
  const rules = String(single).replace(SINGLE_OUTPUT, '').trimEnd();
  return `${rules}
一次判断下面全部材料。每条都要单独给出结论，id 必须与输入 id 完全一致，不能增删或改写。
primaryDirection、subjectKind、domainTagIds、classificationStatus、evidenceQuote 的取值规则与单条分类相同。
仅返回 JSON：{"items":[{"id":"输入id","primaryDirection":"pending","subjectKind":"unknown","domainTagIds":[],"classificationStatus":"pending","evidenceQuote":"输入中的短句"}]}。`;
}

export function singleResponseSchema() {
  return {
    type: 'OBJECT',
    properties: {
      primaryDirection: { type: 'STRING', enum: [...PRIMARY_DIRECTIONS] },
      subjectKind: { type: 'STRING', enum: [...SUBJECT_KINDS] },
      domainTagIds: { type: 'ARRAY', items: { type: 'STRING' } },
      classificationStatus: { type: 'STRING', enum: ['classified', 'out-of-scope', 'pending'] },
      evidenceQuote: { type: 'STRING' },
    },
    required: ['primaryDirection', 'subjectKind', 'domainTagIds', 'classificationStatus', 'evidenceQuote'],
    propertyOrdering: ['primaryDirection', 'subjectKind', 'domainTagIds', 'classificationStatus', 'evidenceQuote'],
  };
}

export function batchResponseSchema() {
  return {
    type: 'OBJECT',
    properties: {
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' },
            ...singleResponseSchema().properties,
          },
          required: ['id', ...singleResponseSchema().required],
          propertyOrdering: ['id', ...singleResponseSchema().propertyOrdering],
        },
      },
    },
    required: ['items'],
    propertyOrdering: ['items'],
  };
}

export function readClassificationFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!DIRECTIONS.has(raw.primaryDirection) || !KINDS.has(raw.subjectKind)) return null;
  const status = raw.primaryDirection === 'other' || raw.classificationStatus === 'out-of-scope'
    ? 'out-of-scope'
    : raw.primaryDirection === 'pending' ? 'pending' : 'classified';
  return {
    primaryDirection: raw.primaryDirection,
    subjectKind: raw.subjectKind,
    status,
    domainTagIds: Array.isArray(raw.domainTagIds) ? raw.domainTagIds.filter((id) => typeof id === 'string').slice(0, 8) : [],
    evidenceQuote: String(raw.evidenceQuote || '').slice(0, 240),
  };
}

export function extractJson(answer) {
  const source = String(answer || '').trim();
  if (!source) throw new Error('empty');
  const arrayAt = source.indexOf('[');
  const objectAt = source.indexOf('{');
  if (arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt)) {
    const end = source.lastIndexOf(']');
    if (end <= arrayAt) throw new Error('no-json');
    return JSON.parse(source.slice(arrayAt, end + 1));
  }
  if (objectAt < 0) throw new Error('no-json');
  const end = source.lastIndexOf('}');
  if (end <= objectAt) throw new Error('no-json');
  return JSON.parse(source.slice(objectAt, end + 1));
}

export function parseSingleClassification(answer) {
  let raw;
  try {
    raw = extractJson(answer);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Array.isArray(raw.items)) return null;
  return readClassificationFields(raw);
}

export function parseBatchClassification(answer) {
  let raw;
  try {
    raw = extractJson(answer);
  } catch {
    return { ok: false, reason: 'parse-failure', rows: [] };
  }
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : null);
  if (!list) return { ok: false, reason: 'parse-failure', rows: [] };
  return {
    ok: true,
    rows: list.map((item) => {
      const id = item && typeof item === 'object' && !Array.isArray(item) && item.id != null ? String(item.id).trim() : '';
      const fields = readClassificationFields(item);
      if (!fields) return { id, invalid: true };
      return { id, invalid: false, ...fields };
    }),
  };
}

export function usableBaseline(baseline, source = baseline?.source || '') {
  if (!baseline || !DIRECTIONS.has(baseline.primaryDirection) || !KINDS.has(baseline.subjectKind || 'unknown')) return null;
  const status = baseline.status || (baseline.primaryDirection === 'other' ? 'out-of-scope' : baseline.primaryDirection === 'pending' ? 'pending' : 'classified');
  if (status !== 'classified' && status !== 'out-of-scope') return null;
  return {
    primaryDirection: baseline.primaryDirection,
    subjectKind: baseline.subjectKind || 'unknown',
    status,
    source,
  };
}

export function baselineFromStored(node, stage) {
  const saved = node?.readingClassification;
  const fromNode = usableBaseline(saved, 'stored-node');
  if (fromNode) return fromNode;
  if (stage?.status === 'completed') return usableBaseline(stage.output, 'stored-stage');
  return null;
}

export function itemsFromFixture(raw) {
  const list = Array.isArray(raw) ? raw : raw?.items;
  if (!Array.isArray(list)) throw new Error('样本文件需要 items 数组');
  const seen = new Set();
  return list.map((item, index) => {
    const id = text(item?.id);
    if (!id) throw new Error(`第 ${index + 1} 条缺少 id`);
    if (seen.has(id)) throw new Error(`样本 id 重复：${id}`);
    seen.add(id);
    if (item?.baseline && item.baseline.primaryDirection && !DIRECTIONS.has(item.baseline.primaryDirection)) {
      throw new Error(`基线主类无效：${id}`);
    }
    if (item?.baseline && item.baseline.subjectKind && !KINDS.has(item.baseline.subjectKind)) {
      throw new Error(`基线细类无效：${id}`);
    }
    return {
      id,
      title: item.title || '',
      summary: item.summary ?? item.text ?? '',
      body: item.body || '',
      baseline: usableBaseline(item.baseline, item.baseline?.source || 'fixture'),
    };
  });
}

export function selectEvalItems(items, sampleSize, baseline) {
  const unique = [];
  const seen = new Set();
  for (const item of items || []) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  const selected = baseline === 'stored' ? unique.filter((item) => item.baseline) : unique;
  return selected.slice(0, sampleSize);
}

export function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export function resolveEvalOptions({ sample = '200', batches = '10,20,30', baseline = 'auto' } = {}) {
  const sampleSize = Number(sample);
  if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > 2000) throw new Error('--sample 需要 1 到 2000 的整数');
  const batchSizes = String(batches || '').split(',').map((item) => item.trim()).filter(Boolean).map(Number);
  if (!batchSizes.length || batchSizes.some((size) => !Number.isInteger(size) || size < 1 || size > 200)) {
    throw new Error('--batches 需要逗号分隔的正整数，每个不超过 200');
  }
  const mode = String(baseline || 'auto');
  if (!['auto', 'stored', 'reclassify'].includes(mode)) throw new Error('--baseline 只能是 auto、stored 或 reclassify');
  return { sampleSize, batchSizes, baseline: mode };
}

export function resolveClassifyBatchModel(env = process.env) {
  return text(env.AI_CENTER_CLASSIFY_BATCH_MODEL) || text(env.AI_CENTER_HARNESS_HOURLY_MODEL) || 'gemini-3.1-flash-lite';
}

export function estimateClassifyCalls(itemCount, unlabeledCount, batchSizes, baselineMode) {
  const count = Math.max(0, itemCount);
  const baselineCalls = baselineMode === 'reclassify' ? count : baselineMode === 'stored' ? 0 : Math.max(0, unlabeledCount);
  const batchCalls = batchSizes.reduce((sum, size) => sum + (count ? Math.ceil(count / size) : 0), 0);
  return { baselineCalls, batchCalls, total: baselineCalls + batchCalls };
}

export function readGeminiUsage(payload) {
  const usage = payload?.usageMetadata || {};
  const inputTokens = integer(usage.promptTokenCount);
  const outputTokens = integer(usage.candidatesTokenCount);
  const totalTokens = integer(usage.totalTokenCount) ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null);
  return { inputTokens, outputTokens, totalTokens };
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, complete: true };
}

function absorbUsage(bucket, usage) {
  if (!usage || usage.inputTokens == null || usage.outputTokens == null || usage.totalTokens == null) {
    bucket.complete = false;
    return;
  }
  bucket.inputTokens += usage.inputTokens;
  bucket.outputTokens += usage.outputTokens;
  bucket.totalTokens += usage.totalTokens;
}

export function alignClassificationIds(expectedIds, rows) {
  const expected = new Set(expectedIds);
  const counts = new Map();
  const unknownIds = [];
  for (const row of rows || []) {
    const id = row?.id ? String(row.id) : '';
    if (!id || !expected.has(id)) {
      unknownIds.push(id);
      continue;
    }
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const duplicateIds = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const missingIds = expectedIds.filter((id) => !counts.has(id));
  const byId = new Map();
  const invalidIds = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (!row?.id || !expected.has(row.id) || counts.get(row.id) !== 1 || seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.invalid) invalidIds.push(row.id);
    else byId.set(row.id, row);
  }
  return { missingIds, duplicateIds, unknownIds, invalidIds, byId };
}

export function scoreAlignment(items, byId) {
  const perCategory = Object.fromEntries(PRIMARY_DIRECTIONS.map((direction) => [direction, { total: 0, agree: 0 }]));
  let agree = 0;
  for (const item of items) {
    const baseline = item.baseline?.primaryDirection || '';
    if (perCategory[baseline]) perCategory[baseline].total += 1;
    const predicted = byId.get(item.id);
    if (!predicted || predicted.primaryDirection !== baseline) continue;
    agree += 1;
    if (perCategory[baseline]) perCategory[baseline].agree += 1;
  }
  return { agree, total: items.length, perCategory };
}

export function summarizeBatchCalls(items, calls) {
  const byId = new Map();
  const usage = emptyUsage();
  let missing = 0;
  let duplicate = 0;
  let unknown = 0;
  let invalid = 0;
  let parseFailures = 0;
  let transportFailures = 0;
  let truncated = 0;
  let latencyMs = 0;
  for (const call of calls || []) {
    latencyMs += Number(call.latencyMs) || 0;
    absorbUsage(usage, call.usage);
    if (call.truncated) truncated += 1;
    if (call.transportFailure) {
      transportFailures += 1;
      continue;
    }
    if (call.parseFailure) {
      parseFailures += 1;
      continue;
    }
    const alignment = alignClassificationIds(call.expectedIds || [], call.rows || []);
    missing += alignment.missingIds.length;
    duplicate += alignment.duplicateIds.length;
    unknown += alignment.unknownIds.length;
    invalid += alignment.invalidIds.length;
    for (const [id, row] of alignment.byId) byId.set(id, row);
  }
  if (!calls?.length) usage.complete = false;
  return {
    calls: calls?.length || 0,
    parseFailures,
    transportFailures,
    truncated,
    latencyMs,
    meanLatencyMs: calls?.length ? Math.round(latencyMs / calls.length) : 0,
    missing,
    duplicate,
    unknown,
    invalid,
    usage,
    ...scoreAlignment(items, byId),
  };
}

async function gap(state, pauseMs, sleep) {
  if (state.called && pauseMs > 0) await sleep(pauseMs);
  state.called = true;
}

export async function runClassifyBatchEvaluation({
  items,
  batchSizes,
  baselineMode = 'auto',
  complete,
  pauseMs = 0,
  onCall = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof complete !== 'function') throw new Error('缺少模型调用');
  const state = { called: false };
  const working = (items || []).map((item) => ({
    ...item,
    baseline: baselineMode === 'reclassify' ? null : item.baseline || null,
  }));
  const baselineStats = { calls: 0, parseFailures: 0, transportFailures: 0, unusable: 0, latencyMs: 0, failedIds: [] };
  for (const item of working) {
    if (item.baseline) continue;
    if (baselineMode === 'stored') {
      baselineStats.failedIds.push(item.id);
      continue;
    }
    await gap(state, pauseMs, sleep);
    baselineStats.calls += 1;
    onCall({ kind: 'single', index: baselineStats.calls, batchSize: 1 });
    const prompt = JSON.stringify(classificationPayload(item));
    try {
      const result = await complete({
        kind: 'single',
        system: READING_CLASS_INSTRUCTION,
        prompt,
        schema: singleResponseSchema(),
      });
      baselineStats.latencyMs += Number(result?.latencyMs) || 0;
      const parsed = parseSingleClassification(result?.text);
      const usable = usableBaseline(parsed, 'reclassified');
      if (!parsed) {
        baselineStats.parseFailures += 1;
        baselineStats.failedIds.push(item.id);
        continue;
      }
      if (!usable) {
        baselineStats.unusable += 1;
        baselineStats.failedIds.push(item.id);
        continue;
      }
      item.baseline = usable;
    } catch (error) {
      baselineStats.transportFailures += 1;
      baselineStats.latencyMs += Number(error?.latencyMs) || 0;
      baselineStats.failedIds.push(item.id);
    }
  }
  const compared = working.filter((item) => item.baseline);
  const rows = [];
  for (const batchSize of batchSizes) {
    const calls = [];
    const chunks = chunkItems(compared, batchSize);
    for (const chunk of chunks) {
      await gap(state, pauseMs, sleep);
      onCall({ kind: 'batch', batchSize, index: calls.length + 1, total: chunks.length });
      const expectedIds = chunk.map((item) => item.id);
      const prompt = JSON.stringify({
        items: chunk.map((item) => ({ id: item.id, ...classificationPayload(item) })),
      });
      try {
        const result = await complete({
          kind: 'batch',
          system: batchClassificationInstruction(),
          prompt,
          schema: batchResponseSchema(),
        });
        const parsed = parseBatchClassification(result?.text);
        calls.push({
          latencyMs: Number(result?.latencyMs) || 0,
          parseFailure: !parsed.ok,
          transportFailure: false,
          truncated: result?.finishReason === 'MAX_TOKENS',
          expectedIds,
          rows: parsed.rows,
          usage: result?.usage || null,
        });
      } catch (error) {
        calls.push({
          latencyMs: Number(error?.latencyMs) || 0,
          parseFailure: false,
          transportFailure: true,
          truncated: false,
          expectedIds,
          rows: [],
          usage: null,
        });
      }
    }
    rows.push({ batchSize, summary: summarizeBatchCalls(compared, calls) });
  }
  return { compared, baselineStats, rows };
}

export function formatRate(agree, total) {
  if (!total) return '—';
  return `${((100 * agree) / total).toFixed(1)}%（${agree}/${total}）`;
}

function tokenLine(summary) {
  const usage = summary.usage;
  if (!usage?.complete) return '未完整返回';
  return `输入 ${usage.inputTokens}，输出 ${usage.outputTokens}，合计 ${usage.totalTokens}`;
}

export function countBaselineSources(items) {
  const counts = { storedNode: 0, storedStage: 0, fixture: 0, reclassified: 0 };
  for (const item of items || []) {
    if (item.baseline?.source === 'stored-node') counts.storedNode += 1;
    else if (item.baseline?.source === 'stored-stage') counts.storedStage += 1;
    else if (item.baseline?.source === 'reclassified') counts.reclassified += 1;
    else if (item.baseline) counts.fixture += 1;
  }
  return counts;
}

export function renderClassifyBatchReport(input) {
  const headers = ['批大小', '调用次数', '解析失败', '请求失败', '截断', '平均延迟 ms', '总延迟 ms', '一致率', '缺失 id', '重复 id', '未知 id', '非法标签', ...PRIMARY_DIRECTIONS];
  const lines = [
    '# 阅读分类批量对照',
    '',
    `请求 ${input.requested ?? input.sampleSize} 条。读入 ${input.loaded ?? input.sampleSize} 条，候选 ${input.selected ?? input.sampleSize} 条，进入对照 ${input.sampleSize} 条，基线失败或不可用 ${input.excluded ?? 0} 条。`,
    `基线来源：节点上已有分类 ${input.baselineCounts.storedNode}，分类缓存 ${input.baselineCounts.storedStage}，样本文件 ${input.baselineCounts.fixture}，本轮单条重分 ${input.baselineCounts.reclassified}。`,
    `单条重分调用 ${input.baselineStats.calls} 次，解析失败 ${input.baselineStats.parseFailures}，请求失败 ${input.baselineStats.transportFailures}，结果不可用 ${input.baselineStats.unusable}，总延迟 ${input.baselineStats.latencyMs} ms。`,
    `模型 ${input.model}。批量温度 0，输出上限 ${input.maxOutputTokens}。类别和判断规则使用线上阅读分类提示词，批量结果在 JSON 的 items 里带回输入 id。`,
    '脚本只读数据库，不写分类，不改小时报任务。',
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map((_, index) => (index === 0 ? '---' : '---:')).join(' | ')} |`,
  ];
  for (const row of input.rows) {
    const summary = row.summary;
    const values = [
      row.batchSize,
      summary.calls,
      summary.parseFailures,
      summary.transportFailures,
      summary.truncated,
      summary.meanLatencyMs,
      summary.latencyMs,
      formatRate(summary.agree, summary.total),
      summary.missing,
      summary.duplicate,
      summary.unknown,
      summary.invalid,
      ...PRIMARY_DIRECTIONS.map((direction) => formatRate(summary.perCategory[direction].agree, summary.perCategory[direction].total)),
    ];
    lines.push(`| ${values.join(' | ')} |`);
  }
  lines.push(
    '',
    '一致率的分母是进入对照的样本条数。分子是该 id 只出现一次、主类和细类都通过线上取值校验，且 primaryDirection 与基线相同的条数。',
    '各类一致率的分母是基线 primaryDirection 落在该类的条数。',
    '缺失 id 统计已经解析出条目数组、其中没有该输入 id 的条数。解析失败和请求失败另计，这些条目留在分母里。',
    '重复 id 按 id 计数。同一个 id 出现多次时计入重复。',
    '未知 id 按返回条数计数，包括空 id。',
    '非法标签是 id 只出现一次，但主类或细类不在线上允许的取值里。',
    '截断表示上游 finishReason 为 MAX_TOKENS。',
    '',
  );
  for (const row of input.rows) lines.push(`批大小 ${row.batchSize} 的用量：${tokenLine(row.summary)}。`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function stageKeyFor(sourceId, sourceVersion) {
  return `reading-class:${sourceId}:${sourceVersion}`;
}

export function loadRecentClassifications(database, workspace, limit) {
  const safe = Math.max(1, Math.min(Number(limit) || 200, 2000));
  const rows = database.prepare(`
    SELECT n.value_json AS valueJson, h.event_at AS eventAt, h.source_id AS sourceId, h.source_version AS sourceVersion
    FROM information_tree_information_heads h
    JOIN information_tree_nodes n ON n.workspace_id = h.workspace_id AND n.id = h.node_id
    WHERE h.workspace_id = ?
    ORDER BY h.event_at DESC, h.source_id DESC
    LIMIT ?`).all(workspace, safe);
  const prepared = rows.map((row) => {
    const node = JSON.parse(row.valueJson);
    const sourceId = node.sourceId || row.sourceId;
    const sourceVersion = String(row.sourceVersion || node.sourceVersion || node.version || '');
    return { node, sourceId, sourceVersion, stageKey: stageKeyFor(sourceId, sourceVersion), eventAt: Number(row.eventAt) || 0 };
  });
  const stages = new Map();
  for (let index = 0; index < prepared.length; index += 200) {
    const part = prepared.slice(index, index + 200);
    const found = database.prepare(`
      SELECT stage_key AS stageKey, output_json AS outputJson, status
      FROM daily_analysis_stages
      WHERE workspace_id = ? AND report_date = 'reading-class' AND input_hash = ?
        AND stage_key IN (${part.map(() => '?').join(',')})
    `).all(workspace, READING_CLASS_VERSION, ...part.map((row) => row.stageKey));
    for (const stage of found) {
      stages.set(stage.stageKey, { status: stage.status, output: stage.outputJson ? JSON.parse(stage.outputJson) : null });
    }
  }
  return prepared.map((row) => ({
    id: String(row.node.id || row.sourceId || '').trim(),
    title: row.node.title || '',
    summary: row.node.text || '',
    body: row.node.body || '',
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    eventAt: row.eventAt,
    baseline: baselineFromStored(row.node, stages.get(row.stageKey)),
  })).filter((item) => item.id);
}

export { READING_CLASS_INSTRUCTION, READING_CLASS_VERSION };
