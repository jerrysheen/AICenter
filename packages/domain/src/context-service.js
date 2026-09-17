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
    if (item.sourceUrl) lines.push(`链接：${item.sourceUrl}`);
    lines.push(`正文：\n${item.content || '（无正文）'}`);
    return lines.join('\n');
  });
  return [
    '[用户主动引用]',
    '以上是用户主动指定的来源，回答时直接使用，不要再用工具搜索同一条内容。',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

export function createContextService({ feedService, tradingService, knowledgeService }) {
  if (!feedService || !tradingService || !knowledgeService) throw new Error('context services are required');

  async function resolveOne(workspaceId, input) {
    const reference = parseContract(ReferenceInputSchema, input);
    if (reference.resourceType === 'content-item') {
      const item = feedService.getContentItem(workspaceId, reference.resourceId);
      if (!item) return null;
      const title = item.title || '未命名信息';
      return {
        ref: selectedRef('content-item', item.id, title, { asOf: item.updatedAt || item.publishedAt || item.createdAt }),
        typeLabel: TYPE_LABELS['content-item'],
        title,
        content: clipText([item.summary, item.body].filter(Boolean).join('\n\n') || title),
        sourceUrl: item.sourceUrl || '',
      };
    }
    if (reference.resourceType === 'post') {
      const post = feedService.getLegacyPost(reference.resourceId);
      if (!post) return null;
      const title = post.title || '未命名信息';
      return {
        ref: selectedRef('post', post.id, title, { asOf: post.createdAt }),
        typeLabel: TYPE_LABELS.post,
        title,
        content: clipText(post.body || title),
        sourceUrl: post.sourceUrl || '',
      };
    }
    if (reference.resourceType === 'inspiration') {
      const note = knowledgeService.getInspiration(workspaceId, reference.resourceId);
      if (!note) return null;
      const title = clipText(note.body, 36) || '灵感';
      return {
        ref: selectedRef('inspiration', note.id, title, { asOf: note.updatedAt || note.createdAt }),
        typeLabel: TYPE_LABELS.inspiration,
        title,
        content: clipText(note.body),
        sourceUrl: '',
      };
    }
    if (reference.resourceType === 'knowledge-revision') {
      const item = reference.revision
        ? knowledgeService.getRevision(workspaceId, reference.resourceId, reference.revision)
        : knowledgeService.getCurrentRevision(workspaceId, reference.resourceId);
      if (!item) return null;
      return {
        ref: selectedRef('knowledge-revision', item.knowledgeId, item.title, {
          revision: item.revision, asOf: item.createdAt,
        }),
        typeLabel: TYPE_LABELS['knowledge-revision'],
        title: item.title,
        content: clipText(item.body || item.title),
        sourceUrl: '',
      };
    }
    if (reference.resourceType === 'ai-run') {
      const run = knowledgeService.getAgentRun(workspaceId, reference.resourceId);
      if (!run) return null;
      const title = clipText(run.inputText || run.outputText, 36) || 'AI 回答';
      return {
        ref: selectedRef('ai-run', run.id, title, { asOf: run.completedAt || run.createdAt }),
        typeLabel: TYPE_LABELS['ai-run'],
        title,
        content: clipText(`问题：\n${run.inputText || '（无）'}\n\n回答：\n${run.outputText || '（无）'}`),
        sourceUrl: '',
      };
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
  });
}
