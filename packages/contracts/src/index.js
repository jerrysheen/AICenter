import { parseContract, ValidationError } from './errors.js';
import { PageRequestSchema } from './common.js';
import { BuildContextInputSchema, PackReferencesInputSchema } from './context.js';
import { CreateAgentRunInputSchema } from './agent.js';
import { CreateArticleAnalysisInputSchema } from './article-analysis.js';
import {
  ClaimWorkPackageInputSchema,
  CompleteWorkPackageInputSchema,
  CreateAttachmentInputSchema,
  CreateInspirationFromRunInputSchema,
  CreateInspirationInputSchema,
  CreateKnowledgeFromRunInputSchema,
  CreateKnowledgeFromUserInputSchema,
  ContinueWorkPackageInputSchema,
  CreateWorkPackageInputSchema,
  DispatchWorkPackageJobInputSchema,
  FailWorkPackageInputSchema,
  KnowledgeMentionQuerySchema,
  NotifyWorkPackageInputSchema,
  WorkPackageGoalSchema,
  WorkPackageListQuerySchema,
  WorkPackageParentTraceSchema,
  WorkPackageProgressSchema,
  WorkPackageTraceSchema,
  WorkPackageTraceStepSchema,
  projectWorkPackageTimeline,
} from './knowledge.js';
import { TagAnalyzeJobInputSchema } from './tagging.js';
import { PatchUserItemStateInputSchema } from './feed.js';
import { WorkerJobConcurrencySchema } from './runtime.js';

export * from './errors.js';
export * from './common.js';
export * from './feed.js';
export * from './trading.js';
export * from './knowledge.js';
export * from './taxonomy.js';
export * from './context.js';
export * from './agent.js';
export * from './article-analysis.js';
export * from './runtime.js';
export * from './source.js';
export * from './tagging.js';

function cleanText(value, { field, max, required = false } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new ValidationError(`${field} 不能为空`, [field]);
  if (text.length > max) throw new ValidationError(`${field} 不能超过 ${max} 个字符`, [field]);
  return text;
}

function cleanUrl(value) {
  const sourceUrl = cleanText(value, { field: '来源链接', max: 2048 });
  if (!sourceUrl) return '';
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new ValidationError('来源链接格式不正确', ['sourceUrl']);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ValidationError('来源链接只支持 http 或 https', ['sourceUrl']);
  }
  return parsed.toString();
}

function cleanTags(value) {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，]/) : [];
  const seen = new Set();
  const tags = [];
  for (const item of input) {
    const tag = String(item || '').trim();
    if (!tag) continue;
    if (tag.length > 24) throw new ValidationError('每个标签不能超过 24 个字符', ['tags']);
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > 8) throw new ValidationError('最多填写 8 个标签', ['tags']);
  return tags;
}

export function parsePostInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  const body = cleanText(value.body, { field: '正文', max: 10_000 });
  let title = cleanText(value.title, { field: '标题', max: 120 });
  if (!title && !body) throw new ValidationError('标题和正文至少填写一项', ['title', 'body']);
  if (!title) title = `${body.slice(0, 28)}${body.length > 28 ? '…' : ''}`;
  return {
    title,
    body,
    sourceUrl: cleanUrl(value.sourceUrl),
    tags: cleanTags(value.tags),
  };
}

export function parsePairInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  return {
    code: cleanText(value.code, { field: '配对凭证', max: 128, required: true }),
    deviceName: cleanText(value.deviceName, { field: '设备名称', max: 60, required: true }),
  };
}

export function parseLoginInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  return {
    username: cleanText(value.username, { field: '账号', max: 64, required: true }),
    password: cleanText(value.password, { field: '密码', max: 128, required: true }),
    deviceName: cleanText(value.deviceName, { field: '设备名称', max: 60, required: true }),
  };
}

export function parseBehaviorEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  const allowed = new Set(['app.open', 'feed.loaded', 'composer.started', 'post.opened']);
  const name = cleanText(value.name, { field: '事件名称', max: 64, required: true });
  if (!allowed.has(name)) throw new ValidationError('不支持的行为事件', ['name']);
  const metadata = value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
    ? value.metadata
    : {};
  const encoded = JSON.stringify(metadata);
  if (encoded.length > 2048) throw new ValidationError('行为事件信息过大', ['metadata']);
  return { name, metadata };
}

export function parseMarketQuery(value) {
  const query = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const board = cleanText(query.board || 'overview', { field: '行情看板', max: 16 }) || 'overview';
  if (!['overview', 'us', 'asia', 'cn', 'global'].includes(board)) throw new ValidationError('不支持的行情看板', ['board']);
  return {
    board,
    extra: cleanText(query.extra, { field: '自选代码', max: 400 }),
    extraUs: cleanText(query.extraUs || query.extra, { field: '美股自选', max: 400 }),
    extraAsia: cleanText(query.extraAsia || query.extra, { field: '亚洲自选', max: 400 }),
    extraCn: cleanText(query.extraCn || query.extra, { field: 'A股自选', max: 400 }),
  };
}

export function parseMarketSearchQuery(value) {
  const query = cleanText(value, { field: '搜索关键字', max: 64 });
  return query;
}

export function parseHoldingsQuery(value) {
  const query = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const refresh = query.refresh === true || query.refresh === '1' || query.refresh === 'true';
  return { refresh };
}

export function parseBilibiliFeedQuery(value) {
  const query = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const platform = cleanText(query.platform || 'bilibili', { field: '平台', max: 16 }) || 'bilibili';
  if (platform !== 'bilibili') throw new ValidationError('当前只支持 B 站链接抓取', ['platform']);
  const refresh = query.refresh === true || query.refresh === '1' || query.refresh === 'true';
  const url = cleanText(query.url || query.text || query.sourceUrl, { field: 'B站链接', max: 2048 });
  return { platform: 'bilibili', feed: 'imports', url, refresh };
}

export function parseBilibiliImportInput(value) {
  const query = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const url = cleanText(query.url || query.text || query.sourceUrl, { field: 'B站链接', max: 2048, required: true });
  return { platform: 'bilibili', feed: 'imports', url, refresh: true };
}

export function parseXFeedQuery(value) {
  const query = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const platform = cleanText(query.platform || 'x', { field: '平台', max: 16 }) || 'x';
  if (platform !== 'x') throw new ValidationError('当前只支持 X 时间线', ['platform']);
  const feedKey = cleanText(query.feed || 'for-you', { field: '时间线', max: 24 }).toLowerCase().replace(/[_\s]+/g, '-');
  const feed = ['following', 'latest', 'chronological'].includes(feedKey) ? 'following' : 'for-you';
  const rawLimit = query.limit === undefined || query.limit === '' ? 50 : Number(query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
    throw new ValidationError('条数必须是 1 到 50', ['limit']);
  }
  const refresh = query.refresh === true || query.refresh === '1' || query.refresh === 'true';
  return { platform: 'x', feed, limit: rawLimit, refresh };
}

export function parseXueqiuFeedQuery(value) {
  const query = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const platform = cleanText(query.platform || 'xueqiu', { field: '平台', max: 16 }) || 'xueqiu';
  if (platform !== 'xueqiu') throw new ValidationError('当前只支持雪球时间线', ['platform']);
  const feedKey = cleanText(query.feed || 'following', { field: '栏目', max: 24 }).toLowerCase().replace(/[_\s]+/g, '-');
  const feed = feedKey === 'featured' || feedKey === 'selected' || feedKey === 'jingxuan'
    ? 'featured'
    : (feedKey === 'livenews' || feedKey === '7x24' || feedKey === 'live' || feedKey === 'news'
      ? 'livenews'
      : 'following');
  const rawLimit = query.limit === undefined || query.limit === '' ? 50 : Number(query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
    throw new ValidationError('条数必须是 1 到 50', ['limit']);
  }
  const refresh = query.refresh === true || query.refresh === '1' || query.refresh === 'true';
  return { platform: 'xueqiu', feed, limit: rawLimit, refresh };
}

export function parseTrendForceFeedQuery(value) {
  const query = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const platform = cleanText(query.platform || 'trendforce', { field: '平台', max: 16 }) || 'trendforce';
  if (platform !== 'trendforce') throw new ValidationError('当前只支持 TrendForce 公开页', ['platform']);
  const refresh = query.refresh === true || query.refresh === '1' || query.refresh === 'true';
  return { platform: 'trendforce', feed: 'public', refresh };
}

export function parseNoteInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  const payload = {
    title: value.title ?? '',
    body: value.body,
    inspirationType: value.inspirationType ?? '',
    wantAi: Boolean(value.wantAi),
    sourceType: value.sourceType ?? '',
    sourceId: value.sourceId ?? '',
    sourceUrl: value.sourceUrl ?? '',
    sourceTitle: value.sourceTitle ?? '',
    captureChannel: value.captureChannel ?? 'web',
    sourceApp: value.sourceApp ?? '',
    clientMutationId: value.clientMutationId ?? '',
    attachmentIds: Array.isArray(value.attachmentIds) ? value.attachmentIds : [],
  };
  if (value.capturedAt !== undefined) payload.capturedAt = value.capturedAt;
  return parseContract(CreateInspirationInputSchema, payload);
}

export function parseCreateAttachmentInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  return parseContract(CreateAttachmentInputSchema, {
    mime: value.mime ?? '',
    originalName: value.originalName ?? '',
    data: value.data,
  });
}

export function parseBuildContextInput(value) {
  return parseContract(BuildContextInputSchema, value);
}

export function parsePackReferencesInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  return parseContract(PackReferencesInputSchema, {
    references: Array.isArray(value.references) ? value.references : [],
  });
}

export function parseCreateArticleAnalysisInput(value) {
  return parseContract(CreateArticleAnalysisInputSchema, value);
}

export function parseCreateAgentRunInput(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value;
  if (input && (input.sessionId === '' || input.sessionId === 'new')) delete input.sessionId;
  return parseContract(CreateAgentRunInputSchema, input);
}

export function parseCreateInspirationFromRunInput(value) {
  return parseContract(CreateInspirationFromRunInputSchema, value);
}

export function parseCreateKnowledgeFromRunInput(value) {
  return parseContract(CreateKnowledgeFromRunInputSchema, value);
}

export function parseCreateKnowledgeFromUserInput(value) {
  return parseContract(CreateKnowledgeFromUserInputSchema, value);
}

export function parseCreateWorkPackageInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  const payload = {
    title: value.title ?? '',
    body: value.body,
    parentWorkPackageId: value.parentWorkPackageId ?? '',
    sourceUrl: value.sourceUrl ?? '',
    sourceTitle: value.sourceTitle ?? '',
    captureChannel: value.captureChannel ?? 'web',
    sourceApp: value.sourceApp ?? '',
    clientMutationId: value.clientMutationId ?? '',
    attachmentIds: Array.isArray(value.attachmentIds) ? value.attachmentIds : [],
  };
  if (value.capturedAt !== undefined) payload.capturedAt = value.capturedAt;
  return parseContract(CreateWorkPackageInputSchema, payload);
}

export function parseContinueWorkPackageInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  const payload = { body: value.body };
  if (value.attachmentIds !== undefined) payload.attachmentIds = value.attachmentIds;
  return parseContract(ContinueWorkPackageInputSchema, payload);
}

export function parseClaimWorkPackageInput(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  if (input.leaseMs !== undefined && input.leaseMs !== null && input.leaseMs !== '') {
    input.leaseMs = Number(input.leaseMs);
  }
  if (!input.id) delete input.id;
  return parseContract(ClaimWorkPackageInputSchema, input);
}

export function parseCompleteWorkPackageInput(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  delete input.claimedBy;
  if (input.changedPaths !== undefined && !Array.isArray(input.changedPaths)) {
    input.changedPaths = [input.changedPaths];
  }
  return parseContract(CompleteWorkPackageInputSchema, input);
}

export function parseFailWorkPackageInput(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  delete input.claimedBy;
  return parseContract(FailWorkPackageInputSchema, input);
}

export function parseNotifyWorkPackageInput(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  if (!input.id) delete input.id;
  return parseContract(NotifyWorkPackageInputSchema, input);
}

export function parseDispatchWorkPackageJobInput(value) {
  return parseContract(DispatchWorkPackageJobInputSchema, value || {});
}

export function parseWorkerJobConcurrency(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  for (const key of ['defaultLimit', 'workPackageDispatchLimit']) {
    if (input[key] === undefined || input[key] === null || input[key] === '') {
      delete input[key];
    } else {
      input[key] = Number(input[key]);
    }
  }
  return parseContract(WorkerJobConcurrencySchema, input);
}

export function parseWorkPackageTraceStep(value) {
  return parseContract(WorkPackageTraceStepSchema, value || {});
}

export function parseWorkPackageGoal(value) {
  return parseContract(WorkPackageGoalSchema, value || {});
}

export function parseWorkPackageProgress(value) {
  return parseContract(WorkPackageProgressSchema, value || {});
}

export function parseWorkPackageParentTrace(value) {
  return parseContract(WorkPackageParentTraceSchema, value || {});
}

export function parseWorkPackageTrace(value, { live } = {}) {
  const parsed = parseContract(WorkPackageTraceSchema, value || {});
  const running = live ?? parsed.progress?.status === 'claimed';
  const parent = parsed.parentTrace
    ? {
      ...parsed.parentTrace,
      timeline: parsed.parentTrace.timeline.length
        ? parsed.parentTrace.timeline
        : projectWorkPackageTimeline(parsed.parentTrace.steps, { live: false }),
    }
    : null;
  return parseContract(WorkPackageTraceSchema, {
    ...parsed,
    timeline: parsed.timeline.length
      ? parsed.timeline
      : projectWorkPackageTimeline(parsed.steps, { live: running }),
    parentTrace: parent,
  });
}

export function parseWorkPackageListQuery(value) {
  const query = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return parseContract(WorkPackageListQuerySchema, {
    status: query.status || 'active',
  });
}

export function parseKnowledgeMentionQuery(value) {
  const query = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const payload = { q: String(query.q ?? query.query ?? '') };
  if (query.limit !== undefined && query.limit !== null && query.limit !== '') payload.limit = Number(query.limit);
  return parseContract(KnowledgeMentionQuerySchema, payload);
}

export function parseTagAnalyzeInput(value) {
  const query = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  if (query.resourceIds !== undefined && !Array.isArray(query.resourceIds)) {
    query.resourceIds = [query.resourceIds];
  }
  if (query.force === '1' || query.force === 'true') query.force = true;
  if (query.limit !== undefined && query.limit !== null && query.limit !== '') query.limit = Number(query.limit);
  return parseContract(TagAnalyzeJobInputSchema, query);
}

export function parsePageRequest(value) {
  const query = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const cursor = cleanText(query.cursor, { field: '分页游标', max: 512 });
  const payload = {};
  if (cursor) payload.cursor = cursor;
  if (query.limit !== undefined && query.limit !== null && query.limit !== '') payload.limit = query.limit;
  return parseContract(PageRequestSchema, payload);
}

export function parseTranslateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  const sourceText = cleanText(value.text || value.body, { field: '译文原文', max: 20_000, required: true });
  const target = cleanText(value.targetLang || value.target || 'zh', { field: '目标语言', max: 16 }) || 'zh';
  const targetLang = ['en', 'en-us', 'english'].includes(target.toLowerCase()) ? 'en' : 'zh';
  const id = cleanText(value.id, { field: '条目 id', max: 128 });
  return id ? { id, text: sourceText, targetLang } : { text: sourceText, targetLang };
}

const TRANSLATE_BATCH_LIMIT = 30;

export function parseTranslateBatchInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  const rawItems = Array.isArray(value.items) ? value.items : [];
  if (!rawItems.length) throw new ValidationError('没有可翻译的条目', ['items']);
  if (rawItems.length > TRANSLATE_BATCH_LIMIT) {
    throw new ValidationError(`一次最多翻译 ${TRANSLATE_BATCH_LIMIT} 条`, ['items']);
  }
  const target = cleanText(value.targetLang || value.target || 'zh', { field: '目标语言', max: 16 }) || 'zh';
  const targetLang = ['en', 'en-us', 'english'].includes(target.toLowerCase()) ? 'en' : 'zh';
  const seen = new Set();
  const items = [];
  for (const [index, row] of rawItems.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new ValidationError('翻译条目必须是对象', ['items']);
    }
    const id = cleanText(row.id, { field: `条目 ${index + 1} 的 id`, max: 256, required: true });
    if (seen.has(id)) throw new ValidationError('翻译条目 id 不能重复', ['items']);
    seen.add(id);
    items.push({
      id,
      text: cleanText(row.text || row.body, { field: `条目 ${index + 1} 的正文`, max: 20_000, required: true }),
    });
  }
  return { items, targetLang };
}

const PERSIST_TRANSLATION_LIMIT = 200;

export function parsePersistFeedTranslationsInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  const rawItems = Array.isArray(value.translations) ? value.translations : [];
  if (!rawItems.length) throw new ValidationError('没有可保存的译文', ['translations']);
  if (rawItems.length > PERSIST_TRANSLATION_LIMIT) {
    throw new ValidationError(`一次最多保存 ${PERSIST_TRANSLATION_LIMIT} 条译文`, ['translations']);
  }
  const target = cleanText(value.targetLang || value.target || 'zh', { field: '目标语言', max: 16 }) || 'zh';
  const targetLang = ['en', 'en-us', 'english'].includes(target.toLowerCase()) ? 'en' : 'zh';
  const seen = new Set();
  const translations = [];
  for (const [index, row] of rawItems.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new ValidationError('译文条目必须是对象', ['translations']);
    }
    const id = cleanText(row.id, { field: `译文 ${index + 1} 的 id`, max: 128, required: true });
    if (seen.has(id)) throw new ValidationError('译文条目 id 不能重复', ['translations']);
    seen.add(id);
    translations.push({
      id,
      sourceText: cleanText(row.sourceText || row.body, { field: `译文 ${index + 1} 的原文`, max: 20_000, required: true }),
      translatedText: cleanText(row.translatedText, { field: `译文 ${index + 1}`, max: 8_000, required: true }),
      engine: cleanText(row.engine, { field: '翻译引擎', max: 32 }),
      targetLang,
    });
  }
  return { translations, targetLang };
}

export function parsePatchUserItemStateInput(value) {
  return parseContract(PatchUserItemStateInputSchema, value);
}

export function parseHideFlag(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  if (value.isHidden !== true && value.hidden !== true) {
    throw new ValidationError('目前只支持隐藏信息流条目', ['isHidden']);
  }
  return { isHidden: true };
}
