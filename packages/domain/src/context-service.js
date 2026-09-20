import { parseContract, BuildContextInputSchema, ReferenceInputSchema } from '../../contracts/src/index.js';

const tradingTerms = /持仓|仓位|组合|交易|资产|收益|资金|股票|市场|行情|指数|涨跌|今日|今天/;
const feedTerms = /信息流|新闻|最近|消息|发生|市场|行情|事件|影响|今天|今日/;
const MAX_REFERENCE_CHARS = 12_000;

const TYPE_LABELS = Object.freeze({
  'content-item': '信息',
  post: '手工信息',
  inspiration: '灵感',
  'knowledge-revision': '知识',
  'ai-run': 'AI 回答',
});

function knowledgeRef(item) {
  return {
    resourceType: 'knowledge-revision', resourceId: item.knowledgeId,
    revision: item.revision, asOf: null, label: item.title,
  };
}

function feedRef(item) {
  return {
    resourceType: 'content-item', resourceId: item.id,
    revision: null, asOf: item.updatedAt || item.publishedAt || item.createdAt || null,
    label: item.title || '未命名信息',
  };
}

function clipText(value, max = MAX_REFERENCE_CHARS) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function formatPackTime(value) {
  const at = Number(value);
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function occurredAt(item = {}) {
  return Number(item.publishedAt || item.capturedAt || item.updatedAt || item.createdAt || 0) || 0;
}

function selectedRef(resourceType, resourceId, label, extra = {}) {
  return {
    resourceType,
    resourceId: String(resourceId),
    revision: extra.revision ?? null,
    asOf: extra.asOf ?? null,
    label: clipText(label || TYPE_LABELS[resourceType] || resourceType, 1_000) || resourceType,
    origin: 'selected',
  };
}

export function formatResolvedReferences(items) {
  if (!items.length) return '';
  const blocks = items.map((item, index) => {
    const lines = [
      `Reference ${index + 1}`,
      `类型：${item.typeLabel}`,
      `标题：${item.title}`,
    ];
    const when = formatPackTime(item.occurredAt);
    if (when) lines.push(`日期：${when}`);
    if (item.sourceUrl) lines.push(`链接：${item.sourceUrl}`);
    lines.push(`正文：\n${item.translatedText || item.content || '（无正文）'}`);
    return lines.join('\n');
  });
  return [
    '[用户主动引用]',
    '以上是用户主动指定的来源，回答时直接使用，不要再用工具搜索同一条内容。',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

export function formatReferencePack(items, { generatedAt = Date.now() } = {}) {
  const stamped = formatPackTime(generatedAt);
  const header = ['# 材料包'];
  if (stamped) header.push(`导出时间：${stamped}`);
  if (!items.length) return `${header.join('\n')}\n\n（没有可用材料）\n`;
  const blocks = items.map((item, index) => {
    const lines = [`## ${index + 1}. ${item.typeLabel} · ${item.title}`];
    const when = formatPackTime(item.occurredAt);
    if (when) lines.push(`- 日期：${when}`);
    if (item.authorName) lines.push(`- 作者：${item.authorName}`);
    if (item.sourceUrl) lines.push(`- 来源：${item.sourceUrl}`);
    if (item.translatedText) {
      lines.push('', '### 译文', item.translatedText);
      if (item.originalText && item.originalText !== item.translatedText) {
        lines.push('', '### 原文', item.originalText);
      }
    } else {
      lines.push('', item.content || '（无正文）');
    }
    return lines.join('\n');
  });
  return `${header.join('\n')}\n\n${blocks.join('\n\n')}\n`;
}

export function createContextService({ feedService, tradingService, knowledgeService }) {
  if (!feedService || !tradingService || !knowledgeService) throw new Error('context services are required');

  function decorateResolved(base, extra = {}) {
    const originalText = clipText(extra.originalText || base.content || '');
    const translatedText = clipText(extra.translatedText || '');
    return {
      ...base,
      occurredAt: Number(extra.occurredAt || 0) || 0,
      authorName: clipText(extra.authorName || '', 200),
      sourceUrl: extra.sourceUrl ?? base.sourceUrl ?? '',
      originalText,
      translatedText,
      content: translatedText || originalText || base.content || '',
    };
  }

  async function resolveOne(workspaceId, input) {
    const reference = parseContract(ReferenceInputSchema, input);
    if (reference.resourceType === 'content-item') {
      const item = feedService.getLocalizedContentItem
        ? feedService.getLocalizedContentItem(workspaceId, reference.resourceId)
        : feedService.getContentItem(workspaceId, reference.resourceId);
      if (!item) return null;
      const title = item.title || item.authorName || '未命名信息';
      const original = [item.summary, item.body].filter(Boolean).join('\n\n') || title;
      return decorateResolved({
        ref: selectedRef('content-item', item.id, title, { asOf: occurredAt(item) }),
        typeLabel: TYPE_LABELS['content-item'],
        title,
        content: clipText(original),
        sourceUrl: item.sourceUrl || '',
      }, {
        occurredAt: occurredAt(item),
        authorName: item.authorName || '',
        originalText: original,
        translatedText: item.translation?.text || '',
      });
    }
    if (reference.resourceType === 'post') {
      const post = feedService.getLegacyPost(reference.resourceId);
      if (!post) return null;
      const title = post.title || '未命名信息';
      return decorateResolved({
        ref: selectedRef('post', post.id, title, { asOf: post.createdAt }),
        typeLabel: TYPE_LABELS.post,
        title,
        content: clipText(post.body || title),
        sourceUrl: post.sourceUrl || '',
      }, {
        occurredAt: occurredAt(post),
        originalText: post.body || title,
      });
    }
    if (reference.resourceType === 'inspiration') {
      const note = knowledgeService.getInspiration(workspaceId, reference.resourceId);
      if (!note) return null;
      const title = clipText(note.title || note.body, 36) || '灵感';
      return decorateResolved({
        ref: selectedRef('inspiration', note.id, title, { asOf: note.updatedAt || note.createdAt }),
        typeLabel: TYPE_LABELS.inspiration,
        title,
        content: clipText(note.body),
        sourceUrl: note.sourceUrl || '',
      }, {
        occurredAt: occurredAt(note),
        originalText: note.body,
        sourceUrl: note.sourceUrl || '',
      });
    }
    if (reference.resourceType === 'knowledge-revision') {
      const item = reference.revision
        ? knowledgeService.getRevision(workspaceId, reference.resourceId, reference.revision)
        : knowledgeService.getCurrentRevision(workspaceId, reference.resourceId);
      if (!item) return null;
      return decorateResolved({
        ref: selectedRef('knowledge-revision', item.knowledgeId, item.title, {
          revision: item.revision, asOf: item.createdAt,
        }),
        typeLabel: TYPE_LABELS['knowledge-revision'],
        title: item.title,
        content: clipText(item.body || item.title),
        sourceUrl: '',
      }, {
        occurredAt: occurredAt(item),
        originalText: item.body || item.title,
      });
    }
    if (reference.resourceType === 'ai-run') {
      const run = knowledgeService.getAgentRun(workspaceId, reference.resourceId);
      if (!run) return null;
      const title = clipText(run.inputText || run.outputText, 36) || 'AI 回答';
      const content = `问题：\n${run.inputText || '（无）'}\n\n回答：\n${run.outputText || '（无）'}`;
      return decorateResolved({
        ref: selectedRef('ai-run', run.id, title, { asOf: run.completedAt || run.createdAt }),
        typeLabel: TYPE_LABELS['ai-run'],
        title,
        content: clipText(content),
        sourceUrl: '',
      }, {
        occurredAt: run.completedAt || run.createdAt,
        originalText: content,
      });
    }
    return null;
  }

  return Object.freeze({
    async build(value) {
      const input = parseContract(BuildContextInputSchema, value);
      const includeTrading = input.includeTrading ?? tradingTerms.test(input.query);
      const includeRecentFeed = input.includeRecentFeed ?? feedTerms.test(input.query);
      const knowledge = knowledgeService.search(input.workspaceId, input.query, input.limit);
      const recentFeed = includeRecentFeed
        ? feedService.listContentItems(input.workspaceId, { limit: input.limit })
        : [];
      const holdings = includeTrading ? await tradingService.getHoldingsBoard({ workspaceId: input.workspaceId }) : null;
      const refs = [...knowledge.map(knowledgeRef), ...recentFeed.map(feedRef)];
      if (holdings) {
        refs.push({
          resourceType: 'holdings-board', resourceId: `${input.workspaceId}:current`,
          revision: null, asOf: holdings.updatedAt || null, label: '当前持仓与行情快照',
        });
      }
      return {
        generatedAt: Date.now(), query: input.query, workspaceId: input.workspaceId,
        knowledge, recentFeed, holdings, refs,
      };
    },

    async resolveReferences({ workspaceId, references = [] }) {
      const items = [];
      const missing = [];
      const seen = new Set();
      for (const value of Array.isArray(references) ? references : []) {
        let parsed;
        try {
          parsed = parseContract(ReferenceInputSchema, value);
        } catch {
          missing.push(value);
          continue;
        }
        const key = `${parsed.resourceType}:${parsed.resourceId}:${parsed.revision || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const resolved = await resolveOne(workspaceId, parsed);
        if (!resolved) {
          missing.push(parsed);
          continue;
        }
        items.push({ ...resolved, input: parsed });
      }
      return {
        items,
        missing,
        promptText: formatResolvedReferences(items),
        refs: items.map((item) => item.ref),
      };
    },

    async packReferences({ workspaceId, references = [] } = {}) {
      const resolved = await this.resolveReferences({ workspaceId, references });
      const generatedAt = Date.now();
      const markdown = formatReferencePack(resolved.items, { generatedAt });
      const title = resolved.items[0]?.title
        ? (resolved.items.length > 1
          ? `${resolved.items[0].title} 等 ${resolved.items.length} 条`
          : resolved.items[0].title)
        : '材料包';
      return {
        generatedAt,
        title,
        markdown,
        itemCount: resolved.items.length,
        items: resolved.items.map((item) => ({
          resourceType: item.ref.resourceType,
          resourceId: item.ref.resourceId,
          revision: item.ref.revision,
          typeLabel: item.typeLabel,
          title: item.title,
          sourceUrl: item.sourceUrl || '',
          occurredAt: item.occurredAt || null,
          hasTranslation: Boolean(item.translatedText),
        })),
        missing: resolved.missing,
      };
    },
  });
}
