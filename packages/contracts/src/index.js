export class ValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

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
    code: cleanText(value.code, { field: '配对码', max: 16, required: true }),
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
  if (!['overview', 'us', 'asia'].includes(board)) throw new ValidationError('不支持的行情看板', ['board']);
  return {
    board,
    extra: cleanText(query.extra, { field: '自选代码', max: 400 }),
    extraUs: cleanText(query.extraUs || query.extra, { field: '美股自选', max: 400 }),
    extraAsia: cleanText(query.extraAsia || query.extra, { field: '亚洲自选', max: 400 }),
  };
}

export function parseMarketSearchQuery(value) {
  const query = cleanText(value, { field: '搜索关键字', max: 64 });
  return query;
}

export function parseNoteInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求内容必须是对象');
  }
  return {
    body: cleanText(value.body, { field: '灵感', max: 4000, required: true }),
    wantAi: Boolean(value.wantAi),
  };
}
