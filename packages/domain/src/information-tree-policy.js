import {materialHash} from './daily-materials.js';

export function treeCatalog(catalog) {
  const tags=catalog.tags.map(t=>({id:t.id,name:t.name,parent_id:t.parent_id || null,description:t.description || `${t.name}：${(t.keywords || []).join('、')}`}));
  const ids=new Set(tags.map(t=>t.id)),mapping=catalog.reading?.groupByTag || {};
  for(const [key,value] of Object.entries(mapping))if(!ids.has(key) || !ids.has(value))throw new Error('阅读分类映射包含未知Tag');
  for(const value of Object.values(mapping))if(mapping[value] && mapping[value]!==value)throw new Error('阅读分类映射须在小时与日报保持同一层级');
  const migration=catalog.reading?.reclassification;
  return {tags,ids,classificationVersion:materialHash(tags),groupVersion:materialHash({version:catalog.reading?.version || 'unmapped',mapping}),group:id=>ids.has(id) ? mapping[id] || id : null,
    needsReclassification:node=>!migration || node.catalogVersion!==migration.fromVersion || migration.keywords.some(word=>`${node.title}\n${node.text}`.toLowerCase().includes(word.toLowerCase()))};
}

export function redactCondenseLog(value) {
  return String(value ?? '')
    .replace(/AIza[0-9A-Za-z\-_]{8,}/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, '[redacted]')
    .replace(/(api[_-]?key|x-goog-api-key|authorization|bearer)(["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',}]+/gi, '$1$2[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._\-+/=]+/gi, 'bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function condenseHttpStatus(error, message) {
  const direct = Number(error?.upstreamStatus ?? error?.status ?? error?.statusCode);
  if (Number.isInteger(direct) && direct >= 400 && direct <= 599) return direct;
  const matched = String(message).match(/(?:模型调用失败：|HTTP\s*|status[=:\s]+)(\d{3})\b/i);
  const code = Number(matched?.[1]);
  return Number.isInteger(code) && code >= 400 && code <= 599 ? code : null;
}

function condenseUpstreamCode(error, message) {
  const raw = error?.upstreamCode != null && String(error.upstreamCode).trim() ? String(error.upstreamCode) : '';
  const matched = raw || String(message).match(/模型调用失败：([^\s:]{1,80})/)?.[1] || '';
  return redactCondenseLog(matched).slice(0, 80);
}

function safeCondenseRouteId(value) {
  const text = String(value || '').trim().slice(0, 80);
  if (!text || /AIza|sk-|api[_-]?key|bearer|secret/i.test(text)) return '-';
  return text;
}

const CONDENSE_FAILURE_KINDS = new Set([
  'model-4xx', 'model-5xx', 'model-empty', 'model-error', 'parse', 'input-too-long',
  'timeout-queue', 'timeout-execution', 'timeout-budget',
]);

function finiteDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 24 * 60 * 60 * 1000) return null;
  return Math.round(number);
}

function httpStatusOrNull(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

export function describeCondenseFailure(error, meta = {}) {
  const described = classifyCondenseError(error);
  const timing = error?.timing || {};
  const durationMs = finiteDuration(timing.executionMs) ?? finiteDuration(meta.executionMs)
    ?? finiteDuration(timing.queueMs) ?? finiteDuration(meta.queueMs) ?? finiteDuration(meta.elapsedMs);
  const group = safeCondenseRouteId(meta.tagName || meta.group || meta.tagId || '未分类');
  const model = safeCondenseRouteId(meta.model);
  return {
    kind: described.kind,
    code: described.code || described.upstream || described.kind,
    message: described.message,
    group: group === '-' ? '未分类' : group,
    model: model === '-' ? null : model,
    durationMs,
    httpStatus: described.status,
  };
}

function groupFailureDiagnostic(item) {
  const reason = String(item?.reason || '').trim();
  const kind = reason === 'queue-timeout' ? 'timeout-queue'
    : reason === 'execution-timeout' ? 'timeout-execution'
    : reason === 'budget-deferred' ? 'timeout-budget'
    : reason === 'invalid-output' ? 'parse'
    : 'model-error';
  return {
    kind,
    code: reason || kind,
    message: reason || '小时浓缩临时失败',
    group: item?.tagName || item?.tagId || '未分类',
    model: item?.model || null,
    durationMs: finiteDuration(item?.executionMs) ?? finiteDuration(item?.queueMs),
    httpStatus: item?.httpStatus ?? item?.status ?? null,
  };
}

function sanitizeCondenseDiagnostic(item) {
  const kind = CONDENSE_FAILURE_KINDS.has(item?.kind) ? item.kind : 'model-error';
  const code = redactCondenseLog(item?.code || '').slice(0, 80) || kind;
  const message = redactCondenseLog(item?.message || '') || '-';
  const group = safeCondenseRouteId(item?.group || '未分类');
  const model = safeCondenseRouteId(item?.model);
  return {
    kind,
    code,
    message,
    group: group === '-' ? '未分类' : group,
    model: model === '-' ? null : model,
    durationMs: finiteDuration(item?.durationMs),
    httpStatus: httpStatusOrNull(item?.httpStatus),
  };
}

export function condenseJobFailure(summary, { diagnostics = [], failures = [] } = {}) {
  const source = (Array.isArray(diagnostics) && diagnostics.length ? diagnostics : (failures || []).map(groupFailureDiagnostic)).slice(0, 12);
  const groups = source.map(sanitizeCondenseDiagnostic);
  const primary = groups[0] || sanitizeCondenseDiagnostic({ kind: 'model-error', code: 'unknown', message: summary });
  return {
    kind: primary.kind,
    code: primary.code,
    message: primary.message,
    summary: redactCondenseLog(summary).slice(0, 200) || primary.message,
    group: primary.group,
    model: primary.model,
    durationMs: primary.durationMs,
    httpStatus: primary.httpStatus,
    groups,
  };
}

export function classifyCondenseError(error) {
  const name = error?.name || 'Error';
  const code = typeof error?.code === 'string' ? error.code : '';
  const prior = String(error?.priorError || '');
  const own = String(error?.message || error || '');
  const message = prior && prior !== own ? prior : own;
  const status = condenseHttpStatus(error, message);
  const budgetTimeout = name === 'StageBudgetTimeout' || (code === 'budget-deferred' && /超时|预算耗尽|总耗时/.test(message));
  const tooLong = /超过预算|超过文章整理预算|单条输入超过|context length|maximum context|token limit|max tokens|上下文|输入过长/i.test(message);
  let kind = 'model-error';
  if (name === 'ModelQueueTimeout' || code === 'queue-timeout') kind = 'timeout-queue';
  else if (name === 'ModelExecutionTimeout' || code === 'execution-timeout') kind = 'timeout-execution';
  else if (budgetTimeout) kind = 'timeout-budget';
  else if (tooLong || code === 'input-too-long') kind = 'input-too-long';
  else if (status >= 500) kind = 'model-5xx';
  else if (status >= 400) kind = 'model-4xx';
  else if (name === 'ZodError' || error instanceof SyntaxError || code === 'invalid-output' || /JSON|未通过校验|响应中止或截断/.test(message)) kind = 'parse';
  else if (/没有返回回答|响应为空|empty response/i.test(message)) kind = 'model-empty';
  return {kind, name, code, status, upstream: condenseUpstreamCode(error, message), message: redactCondenseLog(message) || '-'};
}

export function formatCondenseFailureLog(error, meta = {}) {
  const described = classifyCondenseError(error);
  const timing = error?.timing || {};
  const numberOrDash = value => Number.isFinite(value) ? value : '-';
  return [
    '[worker] 浓缩失败',
    `layer=${meta.layer || '-'}`,
    `task=${meta.task || '-'}`,
    `kind=${described.kind}`,
    `name=${described.name}`,
    `code=${described.code || '-'}`,
    `upstream=${described.upstream || '-'}`,
    `status=${described.status ?? '-'}`,
    `provider=${safeCondenseRouteId(meta.provider)}`,
    `model=${safeCondenseRouteId(meta.model)}`,
    `tag=${meta.tagId ?? 'null'}`,
    `windowStart=${numberOrDash(meta.windowStart)}`,
    `inputs=${numberOrDash(meta.inputCount)}`,
    `inputBytes=${numberOrDash(meta.inputBytes)}`,
    `skillBytes=${numberOrDash(meta.skillBytes)}`,
    `calls=${numberOrDash(meta.calls)}`,
    `queueMs=${numberOrDash(Number.isFinite(timing.queueMs) ? timing.queueMs : meta.queueMs)}`,
    `executionMs=${numberOrDash(Number.isFinite(timing.executionMs) ? timing.executionMs : meta.executionMs)}`,
    `elapsedMs=${numberOrDash(meta.elapsedMs)}`,
    `cached=${error?.cachedPending ? 1 : 0}`,
    `message=${described.message}`,
  ].join(' ');
}

export function treeFailure(error,id,sourceVersion='',at=Date.now()) {
  let reason=error.code;
  if(!reason)reason=error.name==='ModelQueueTimeout' ? 'queue-timeout' : error.name==='ModelExecutionTimeout' ? 'execution-timeout' : error.name==='StageBudgetTimeout' ? 'budget-deferred' : error.name==='ZodError' || error instanceof SyntaxError ? 'invalid-output' : 'retryable-model-error';
  if(!['needs-content','retryable-model-error','queue-timeout','execution-timeout','budget-deferred','lease-conflict','invalid-output','information-not-ready','stale-policy'].includes(reason))reason='retryable-model-error';
  const retryable=!['needs-content','information-not-ready','stale-policy'].includes(reason);
  return {id,reason,retryable,retryAt:retryable ? Number.isFinite(error.retryAt) ? Math.max(at+1000,error.retryAt) : at+30*60000 : null,sourceVersion,...(error.timing ? {queueMs:error.timing.queueMs,executionMs:error.timing.executionMs} : {})};
}

export function treeSource(m) {
  const paragraphs=(m.paragraphs || []).filter(p=>p.text?.trim() && !['metadata','comment'].includes(p.role));
  return {id:m.id,title:m.title,author:m.author || '',publisher:m.publisher || '',publishedAt:m.publishedAt ?? null,
    inputScope:m.contentLevel==='full' && paragraphs.some(p=>p.role==='body') ? 'full' : 'excerpt',
    sourceRoles:{author:m.author || '',excludedThirdPartyComments:(m.paragraphs || []).filter(p=>p.role==='comment').length},paragraphs:paragraphs.map(p=>({role:p.role,text:p.text}))};
}
