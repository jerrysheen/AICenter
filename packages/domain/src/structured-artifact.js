import {
  InspirationTypeSchema,
  KnowledgeTypeSchema,
  StructuredArtifactSchema,
  TaxonomyKeySchema,
  parseContract,
  ValidationError,
} from '../../contracts/src/index.js';

const INSPIRATION_FROM_KNOWLEDGE = Object.freeze({
  fact: 'observation',
  mechanism: 'hypothesis',
  thesis: 'hypothesis',
  framework: 'idea',
  case: 'observation',
  procedure: 'idea',
});

const KNOWLEDGE_FROM_INSPIRATION = Object.freeze({
  observation: 'fact',
  hypothesis: 'thesis',
  question: 'thesis',
  idea: 'framework',
});

export function looksLikeSaveReceipt(text) {
  const body = String(text || '');
  if (!body.trim()) return false;
  const hasId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(body);
  return /^\s*已落库/.test(body)
    || (/已落库/.test(body) && (/去向/.test(body) || /分类路径/.test(body)))
    || (hasId && /分类路径/.test(body) && /(?:类型|contentType)/.test(body));
}

export function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new ValidationError('模型没有返回 JSON', ['bodyMarkdown']);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = (fenced ? fenced[1] : trimmed).trim();
  const start = payload.indexOf('{');
  const end = payload.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ValidationError('模型没有返回 JSON 对象', ['bodyMarkdown']);
  try {
    const parsed = JSON.parse(payload.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ValidationError('模型 JSON 必须是对象', ['bodyMarkdown']);
    }
    return parsed;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('模型 JSON 无法解析', ['bodyMarkdown']);
  }
}

export function coerceContentType(target, contentType) {
  const raw = String(contentType || '').trim();
  if (target === 'inspiration') {
    if (InspirationTypeSchema.safeParse(raw).success) return raw;
    return INSPIRATION_FROM_KNOWLEDGE[raw] || 'hypothesis';
  }
  if (KnowledgeTypeSchema.safeParse(raw).success) return raw;
  return KNOWLEDGE_FROM_INSPIRATION[raw] || 'thesis';
}

function catalogMap(catalog) {
  return new Map((catalog || []).map((node) => [node.key, node]));
}

function nearestExistingKey(key, byKey) {
  let current = key;
  while (current) {
    if (byKey.has(current)) return current;
    const parts = current.split('.');
    if (parts.length <= 2) return null;
    current = parts.slice(0, -1).join('.');
  }
  return null;
}

function sanitizeAssignments(items, byKey) {
  const byDimension = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const parsedKey = TaxonomyKeySchema.safeParse(item?.key);
    if (!parsedKey.success) continue;
    const resolved = nearestExistingKey(parsedKey.data, byKey);
    if (!resolved) continue;
    const node = byKey.get(resolved);
    if (!node || node.status === 'disabled') continue;
    const confidence = Number.isFinite(item?.confidence) ? Math.min(1, Math.max(0, Number(item.confidence))) : null;
    const primary = Boolean(item?.primary);
    const existing = byDimension.get(resolved) || {
      key: resolved,
      primary: false,
      confidence,
    };
    existing.primary = existing.primary || primary;
    if (confidence != null && (existing.confidence == null || confidence > existing.confidence)) {
      existing.confidence = confidence;
    }
    byDimension.set(resolved, existing);
  }

  const grouped = new Map();
  for (const assignment of byDimension.values()) {
    const dimension = assignment.key.split('.')[0];
    if (!grouped.has(dimension)) grouped.set(dimension, []);
    grouped.get(dimension).push(assignment);
  }
  const result = [];
  for (const assignments of grouped.values()) {
    assignments.sort((left, right) => (right.confidence || 0) - (left.confidence || 0));
    if (!assignments.some((item) => item.primary) && assignments[0]) assignments[0].primary = true;
    let primaryUsed = false;
    for (const item of assignments) {
      if (item.primary && primaryUsed) item.primary = false;
      if (item.primary) primaryUsed = true;
      result.push(item);
    }
  }
  return result;
}

function sanitizeProposal(items, byKey) {
  const proposal = Array.isArray(items) ? items[0] : null;
  if (!proposal || typeof proposal !== 'object') return [];
  const key = TaxonomyKeySchema.safeParse(proposal.key);
  const parentKey = TaxonomyKeySchema.safeParse(proposal.parentKey);
  if (!key.success || !parentKey.success) return [];
  if (byKey.has(key.data)) return [];
  const parent = byKey.get(parentKey.data);
  if (!parent || parent.status === 'disabled') return [];
  const dimension = key.data.split('.')[0];
  if (dimension !== parent.dimension) return [];
  if (proposal.dimension && proposal.dimension !== dimension) return [];
  if (!key.data.startsWith(`${parentKey.data}.`)) return [];
  const name = String(proposal.name || '').trim();
  const reason = String(proposal.reason || '').trim();
  if (!name || !reason) return [];
  return [{
    dimension,
    key: key.data,
    name: name.slice(0, 80),
    parentKey: parentKey.data,
    reason: reason.slice(0, 500),
  }];
}

export function sanitizeStructuredArtifact(raw, { target, catalog }) {
  const byKey = catalogMap(catalog);
  const source = raw && typeof raw === 'object' ? raw : {};
  const bodyMarkdown = source.bodyMarkdown || source.body || source.content;
  if (looksLikeSaveReceipt(bodyMarkdown)) {
    throw new ValidationError('正文不能是落库回执，必须是可独立阅读的内容', ['bodyMarkdown']);
  }
  const artifact = parseContract(StructuredArtifactSchema, {
    schemaVersion: 1,
    target,
    title: source.title,
    contentType: coerceContentType(target, source.contentType),
    bodyMarkdown: source.bodyMarkdown || source.body || source.content,
    taxonomy: [],
    taxonomyProposals: [],
  });
  artifact.taxonomy = sanitizeAssignments(source.taxonomy, byKey);
  artifact.taxonomyProposals = sanitizeProposal(source.taxonomyProposals, byKey);
  return artifact;
}

export function formatTaxonomyCatalog(catalog) {
  return (catalog || [])
    .filter((node) => node.status !== 'disabled')
    .map((node) => `${node.key}\t${node.name}\t${node.parentKey || ''}`)
    .join('\n');
}

export function compilerSystemInstruction(target) {
  const typeHint = target === 'inspiration'
    ? 'Inspiration 的 contentType 只能是 observation / hypothesis / question / idea。保留探索性和待验证项。'
    : 'Knowledge 的 contentType 只能是 fact / mechanism / thesis / framework / case / procedure。必须可以脱离当前聊天单独阅读。';
  return [
    '你负责把现有内容整理为可长期保存的结构化内容。',
    '你不能发明来源中不存在的事实。',
    '如果内容仍属于推测：不得保存成 fact；优先保存成 hypothesis 或 thesis。',
    '分类必须优先使用提供的 Taxonomy Catalog。',
    '禁止自行创造 taxonomy key。',
    '确实无法分类时，最多返回 1 个 taxonomyProposal，且 parentKey 必须已存在。',
    typeHint,
    'bodyMarkdown 只写可独立阅读的正文，禁止写入已落库、去向、分类路径、资源 ID 或任何落库回执。',
    '若待整理内容本身只是落库回执，不要照抄，应回到会话里的研究观点重新整理。',
    '只返回符合 StructuredArtifactSchema 的 JSON，不要 markdown 解释。',
    '不要返回 sourceRefs 或任何数据库 ID。',
  ].join('\n');
}

export function buildCompilerPrompt({ target, sourceText, instruction, catalogText, question = '' }) {
  return [
    `target = ${target}`,
    instruction ? `额外整理要求：\n${instruction}` : '',
    question ? `原问题：\n${question}` : '',
    '待整理内容：',
    sourceText,
    '',
    'Taxonomy Catalog（key / name / parentKey）：',
    catalogText || '（空）',
    '',
    '返回 JSON：schemaVersion, target, title, contentType, bodyMarkdown, taxonomy, taxonomyProposals。',
  ].filter(Boolean).join('\n');
}

export async function generateStructured({
  generateText,
  systemInstruction,
  prompt,
  parse = extractJsonObject,
  validate,
}) {
  if (typeof generateText !== 'function') throw new Error('generateText is required');
  if (typeof validate !== 'function') throw new Error('validate is required');
  const first = await generateText({ prompt, systemInstruction, repair: false });
  try {
    return validate(parse(first));
  } catch (error) {
    const repairPrompt = [
      `上一次 JSON 无法通过校验：${error.message}`,
      '请只返回修正后的完整 JSON。',
      prompt,
    ].join('\n\n');
    const second = await generateText({
      prompt: repairPrompt,
      systemInstruction,
      repair: true,
    });
    return validate(parse(second));
  }
}

export async function compileStructuredArtifact({
  generateText,
  catalog,
  target,
  sourceText,
  instruction = '',
  question = '',
}) {
  const catalogText = formatTaxonomyCatalog(catalog);
  const prompt = buildCompilerPrompt({ target, sourceText, instruction, catalogText, question });
  return generateStructured({
    generateText,
    systemInstruction: compilerSystemInstruction(target),
    prompt,
    validate: (raw) => sanitizeStructuredArtifact(raw, { target, catalog }),
  });
}
