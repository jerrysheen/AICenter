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

function condenseKeySuffix(keyEnv) {
  const name = String(keyEnv || '').trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return '-';
  const digits = name.match(/(\d+)$/);
  if (digits) return `KEY${digits[1]}`;
  if (/GEMINI_API_KEY$/.test(name)) return 'KEY';
  return name.slice(-12);
}

function condenseBodySnippet(error) {
  const raw = error?.upstreamBody ?? error?.responseBody ?? '';
  return redactCondenseLog(raw) || '-';
}

function treeHourlyOutcome(error) {
  if (!error) return 'ok';
  if (error.code === 'budget-deferred' || error.quotaExhausted === true || Number(error.status) === 429) return 'budget-deferred';
  const name = String(error.name || '');
  const message = String(error.message || error || '');
  if (name === 'AbortError' || name === 'TimeoutError' || name === 'ModelExecutionTimeout' || name === 'ModelQueueTimeout' || /超时|timed out|\btimeout\b/i.test(message)) return 'timeout';
  return 'error';
}

// Provider and harness finish enums stay whole. Only body and message are shortened.
export function treeHourlyFinishReason(value) {
  let raw = value;
  if (raw && typeof raw === 'object') {
    const nested = typeof raw.finishReason === 'string' ? raw.finishReason : '';
    const kind = typeof raw.kind === 'string' ? raw.kind : '';
    raw = nested.trim() || kind.trim();
  }
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text || /AIza[0-9A-Za-z_-]{8,}|sk-[A-Za-z0-9_-]{8,}|\bbearer\s+\S+/i.test(text)) return '-';
  return text;
}

// One physical line per hourly condense call. stdout (console.log) is what the Node daily logger writes to worker.out.*.log.
export function formatTreeHourlyCallLog({error = null, result = null, keyEnv = '', model = '', inputBytes = 0, latencyMs = 0, finishReason = ''} = {}) {
  const described = error ? classifyCondenseError(error) : null;
  const body = error ? (redactCondenseLog(error.upstreamBody ?? error.responseBody ?? '').slice(0, 300) || '-') : '-';
  const message = error ? (redactCondenseLog(described?.message || error.message || error).slice(0, 300) || '-') : '-';
  const finish = treeHourlyFinishReason(finishReason || error?.finishReason || result?.finishReason || '');
  const chosenModel = error?.admittedModel || result?.modelId || model || '';
  return [
    '[worker] tree-hourly',
    `kind=${described?.kind || 'ok'}`,
    `status=${described?.status ?? '-'}`,
    `message=${message}`,
    `body=${body}`,
    `model=${safeCondenseRouteId(chosenModel)}`,
    `key=${condenseKeySuffix(keyEnv || error?.googleKeyEnv)}`,
    `inputBytes=${Number.isFinite(inputBytes) ? Math.max(0, Math.round(inputBytes)) : 0}`,
    `finishReason=${finish}`,
    `latencyMs=${Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : 0}`,
    `outcome=${treeHourlyOutcome(error)}`,
  ].join(' ');
}

export function formatCondenseFailureLog(error, meta = {}) {
  const described = classifyCondenseError(error);
  const timing = error?.timing || {};
  const numberOrDash = value => Number.isFinite(value) ? value : '-';
  const inputBytes = Number.isFinite(Number(error?.inputBytes)) ? Number(error.inputBytes) : meta.inputBytes;
  const inputChars = Number.isFinite(Number(error?.inputChars)) ? Number(error.inputChars) : meta.inputChars;
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
    `model=${safeCondenseRouteId(error?.admittedModel || meta.model)}`,
    `key=${condenseKeySuffix(error?.googleKeyEnv || meta.keyEnv)}`,
    `tag=${meta.tagId ?? 'null'}`,
    `windowStart=${numberOrDash(meta.windowStart)}`,
    `inputs=${numberOrDash(meta.inputCount)}`,
    `inputBytes=${numberOrDash(inputBytes)}`,
    `inputChars=${numberOrDash(inputChars)}`,
    `skillBytes=${numberOrDash(meta.skillBytes)}`,
    `calls=${numberOrDash(meta.calls)}`,
    `splits=${numberOrDash(meta.splitRuns)}`,
    `queueMs=${numberOrDash(Number.isFinite(timing.queueMs) ? timing.queueMs : meta.queueMs)}`,
    `executionMs=${numberOrDash(Number.isFinite(timing.executionMs) ? timing.executionMs : meta.executionMs)}`,
    `elapsedMs=${numberOrDash(meta.elapsedMs)}`,
    `finish=${safeCondenseRouteId(error?.finishReason)}`,
    `cached=${error?.cachedPending ? 1 : 0}`,
    `body=${condenseBodySnippet(error)}`,
    `message=${described.message}`,
  ].join(' ');
}

export const TERMINAL_PENDING_REASONS = Object.freeze(['needs-content', 'stale-policy', 'prep-exhausted', 'flash-source']);

export function isTerminalPendingReason(reason) {
  return TERMINAL_PENDING_REASONS.includes(reason);
}

export const HOURLY_TRUNCATION_FALLBACK_MODEL = 'gemini-3.5-flash-lite';
export const HOURLY_TRUNCATION_MAX_TOKENS = 8192;

export function isTruncatedModelFailure(error, result = null) {
  const finish = treeHourlyFinishReason(error?.finishReason || result?.finishReason || '');
  if (finish === 'MAX_TOKENS' || finish === 'LENGTH' || finish === 'length') return true;
  if (error?.code === 'truncated') return true;
  const message = String(error?.message || '');
  if (/截断|MAX_TOKENS/.test(message)) return true;
  const answer = String(result?.answer || '');
  const trimmed = answer.trim().replace(/```$/, '').trim();
  if (trimmed && !/[}\]]\s*$/.test(trimmed) && /截断|MAX_TOKENS/.test(message)) return true;
  return false;
}

export function cachedTruncationFailure(cached) {
  return /截断|MAX_TOKENS|\btruncated\b/i.test(`${cached?.error || ''} ${cached?.input?.failure?.reason || ''}`);
}

// A saved Flash admission failure keeps retryAt at Pacific midnight. Replaying it
// skips the model, so the Gemma daily-cap fallback never runs and the hour stays empty.
export function cachedFlashQuotaWait(cached) {
  if (cached?.status !== 'failed' || cached.input?.failure?.reason !== 'budget-deferred') return false;
  return /Gemini 文章任务等待流量窗口|cooldownUntil=/.test(String(cached.error || ''));
}

// One in-flight call can take timeoutMs, and the latest hour is allowed to cut in once.
// The waiter must survive both or it dies before onExecutionStart.
export function hourlyModelQueueTimeoutMs({queueTimeoutMs=120000,timeoutMs=180000}={}) {
  return Math.max(Number(queueTimeoutMs) || 0, Number(timeoutMs) * 2 + 30_000);
}

export function treeFailure(error,id,sourceVersion='',at=Date.now()) {
  let reason=error.code;
  if(!reason)reason=error.name==='ModelQueueTimeout' ? 'queue-timeout' : error.name==='ModelExecutionTimeout' ? 'execution-timeout' : error.name==='StageBudgetTimeout' ? 'budget-deferred' : error.name==='ZodError' || error instanceof SyntaxError ? 'invalid-output' : 'retryable-model-error';
  if(!['needs-content','retryable-model-error','queue-timeout','execution-timeout','budget-deferred','lease-conflict','invalid-output','information-not-ready','stale-policy','prep-exhausted'].includes(reason))reason='retryable-model-error';
  const retryable=!isTerminalPendingReason(reason) && reason!=='information-not-ready';
  const waitMs=reason==='queue-timeout' ? 60_000 : 30*60_000;
  return {id,reason,retryable,retryAt:retryable ? Number.isFinite(error.retryAt) ? Math.max(at+1000,error.retryAt) : at+waitMs : null,sourceVersion,...(error.timing ? {queueMs:error.timing.queueMs,executionMs:error.timing.executionMs} : {})};
}

export function treeSource(m) {
  const paragraphs=(m.paragraphs || []).filter(p=>p.text?.trim() && !['metadata','comment'].includes(p.role));
  return {id:m.id,title:m.title,author:m.author || '',publisher:m.publisher || '',publishedAt:m.publishedAt ?? null,
    inputScope:m.contentLevel==='full' && paragraphs.some(p=>p.role==='body') ? 'full' : 'excerpt',
    sourceRoles:{author:m.author || '',excludedThirdPartyComments:(m.paragraphs || []).filter(p=>p.role==='comment').length},paragraphs:paragraphs.map(p=>({role:p.role,text:p.text}))};
}
