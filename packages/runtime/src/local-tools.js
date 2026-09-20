import { createToolRegistry } from './tool-registry.js';
import {
  ContextBuildToolInputSchema, EmptyAgentToolInputSchema, FeedSearchToolInputSchema,
  FeedTagSearchToolInputSchema, HoldingsRankToolInputSchema, KnowledgeGetToolInputSchema, KnowledgeSearchToolInputSchema,
  OfficialSourceGetToolInputSchema, SaveStructuredArtifactToolInputSchema, StaticSignalsListToolInputSchema,
  WebSearchToolInputSchema,
} from '../../contracts/src/index.js';
import { formatTaxonomyPath } from '../../domain/src/knowledge-service.js';
import { sanitizeStructuredArtifact } from '../../domain/src/structured-artifact.js';
import {
  projectBuiltContext, projectHoldingPosition, projectHoldingsBoard, projectPersonalAssets,
} from './tool-projections.js';
import { marketBoardAiWarnings, projectMarketBoardForAI } from '../../source/src/source-projections.js';
import { readStaticSignalBoard } from '../../source/src/static/board.js';
import { contentItemInTimeRange, resolveTimeRangeWindow } from './runtime-context.js';

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ref(resourceType, resourceId, label, { revision = null, asOf = null } = {}) {
  return { resourceType, resourceId: String(resourceId), revision, asOf, label };
}

function result(data, refs, observedAt = Date.now(), warnings = []) {
  return { data, refs, observedAt, warnings };
}

function revisionRef(item) {
  return ref('knowledge-revision', item.knowledgeId, item.title, { revision: item.revision });
}

function decimalCompare(left, right) {
  const a = String(left ?? '0');
  const b = String(right ?? '0');
  return number(b) - number(a);
}

function clipBody(value, max = 800) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function projectTaggedFeedItem(item) {
  return {
    id: item.id,
    title: item.title || '',
    summary: item.summary || '',
    body: clipBody(item.body),
    provider: item.provider || '',
    authorName: item.authorName || '',
    sourceUrl: item.sourceUrl || '',
    publishedAt: item.publishedAt ?? null,
    createdAt: item.createdAt ?? null,
  };
}

const MARKET_GLOBAL_DESCRIPTION = '读取当前全球市场价格与行情快照，例如：美股指数、市场涨跌、债券收益率、黄金、原油、美元等。它是 market data tool，不是新闻搜索工具。不要使用本工具核实：美联储/FOMC 是否加息或降息、央行声明、新闻事件、政策决定、最新公开消息。上述事实使用 web.search。本工具可以在 web.search 确认事件后，辅助观察市场价格反应。';

/**
 * Wires Agent tools to domain services and the shared Source Port.
 * This module does not import a repository, database handle, or connector implementation.
 */
export function createLocalToolRegistry({
  contextService, feedService, knowledgeService, tradingService, taggingService = null, sourcePort,
} = {}) {
  if (!contextService || !feedService || !knowledgeService || !tradingService) {
    throw new Error('local agent tools require context, feed, knowledge, and trading services');
  }
  const registry = createToolRegistry();

  registry.register({
    id: 'context.build', effect: 'read', description: '用于用户需要同时快速浏览多个本地域摘要时使用。如果问题明确指向单一来源，例如 Tag、持仓、Knowledge，优先专用 Tool。与 holdings.get / feed.search / knowledge.search 重叠，不要为同一事实再调那些工具。',
    inputSchema: ContextBuildToolInputSchema,
    async execute(input, context) {
      const contextData = await contextService.build({
        workspaceId: context.workspaceId,
        query: input.query || context.message,
        limit: input.limit,
      });
      return result(projectBuiltContext(contextData), contextData.refs, contextData.generatedAt);
    },
  });

  registry.register({
    id: 'feed.search', effect: 'read', description: '对已经落库的 ContentItem 做文本关键词搜索。它不是结构化 Tag 查询。用户明确按 Tag 查询时使用 feed.tag.search；只有需要扩大文本语义召回时才使用本工具。不会联网。',
    inputSchema: FeedSearchToolInputSchema,
    execute(input, context) {
      const rows = feedService.searchContentItems(context.workspaceId, input.query, { limit: input.limit });
      return result(rows, rows.map((item) => ref('content-item', item.id, item.title || '信息流条目', { asOf: item.publishedAt || item.createdAt })));
    },
  });

  if (taggingService) {
    registry.register({
      id: 'tag.list', effect: 'read', description: '查看当前 Tag Catalog。用户问「有哪些 Tag」或确实需要解析 Catalog 时使用。按 Tag 查信息流时直接用 feed.tag.search，不必先调本工具。',
      inputSchema: EmptyAgentToolInputSchema,
      execute() {
        const catalog = taggingService.listCatalog();
        return result({
          version: catalog.version,
          tags: (catalog.tags || []).map((tag) => ({
            id: tag.id,
            name: tag.name,
            parent_id: tag.parent_id ?? null,
            keywords: tag.keywords || [],
          })),
        }, [], Date.now());
      },
    });

    registry.register({
      id: 'feed.tag.search', effect: 'read',
      description: '按已经落盘的 Tag 查询 ContentItem。tag 可以是稳定 id（如 technology）、显示名或目录中声明的关键词。时间范围由工具按当前本地时区计算，不要自己换算时间戳。用户明确按 Tag 查询时优先使用本工具，不要用 feed.search 模拟。',
      inputSchema: FeedTagSearchToolInputSchema,
      execute(input, context) {
        const resolvedTags = taggingService.resolveTagQuery(input.tag);
        if (!resolvedTags.length) {
          return result({
            resolvedTags: [],
            timeRange: input.timeRange,
            matchedCount: 0,
            items: [],
          }, [], Date.now(), [`未解析到 Tag：${input.tag}`]);
        }
        const tagged = taggingService.findTaggedResources({
          workspaceId: context.workspaceId,
          resourceType: 'content-item',
          tagIds: resolvedTags.map((tag) => tag.id),
          limit: 500,
        });
        const ids = tagged.map((row) => row.resourceId);
        const loaded = typeof feedService.listContentItemsByIds === 'function'
          ? feedService.listContentItemsByIds(context.workspaceId, ids)
          : ids.map((id) => feedService.getContentItem(context.workspaceId, id)).filter(Boolean);
        const window = resolveTimeRangeWindow(input.timeRange, context.runtimeContext || {});
        const platforms = new Set((input.platforms || []).map((item) => item.toLowerCase()));
        const matched = loaded.filter((item) => {
          if (!contentItemInTimeRange(item, window)) return false;
          if (platforms.size && !platforms.has(String(item.provider || '').toLowerCase())) return false;
          return true;
        }).sort((left, right) => {
          const a = Number.isFinite(left.publishedAt) ? left.publishedAt : (left.createdAt || 0);
          const b = Number.isFinite(right.publishedAt) ? right.publishedAt : (right.createdAt || 0);
          return b - a;
        });
        const items = matched.slice(0, input.limit).map(projectTaggedFeedItem);
        return result({
          resolvedTags: resolvedTags.map((tag) => ({ id: tag.id, name: tag.name })),
          timeRange: input.timeRange,
          matchedCount: matched.length,
          items,
        }, items.map((item) => ref('content-item', item.id, item.title || '信息流条目', { asOf: item.publishedAt || item.createdAt })));
      },
    });
  }

  registry.register({
    id: 'knowledge.search', effect: 'read', description: '检索可复用的本地 Knowledge（含 finance framework Markdown）和当前知识文档。返回 id、标题和摘要，不返回底层路径。需要判断结构时先搜再 knowledge.get。context.build 已含相关知识时，仅在需要更多片段时再搜。',
    inputSchema: KnowledgeSearchToolInputSchema,
    execute(input, context) {
      const rows = knowledgeService.search(context.workspaceId, {
        query: input.query,
        taxonomy: input.taxonomy,
        limit: input.limit,
      });
      return result(rows, rows.map(revisionRef));
    },
  });

  registry.register({
    id: 'knowledge.get', effect: 'read', description: '按 knowledge.search 返回的 id 读取完整 Knowledge。文件框架与知识库文档使用同一接口；不要猜测路径。',
    inputSchema: KnowledgeGetToolInputSchema,
    execute(input, context) {
      const item = knowledgeService.getCurrentRevision(context.workspaceId, input.knowledgeId);
      if (!item) return result(null, [], Date.now(), ['未找到该知识文档的当前版本']);
      return result(item, [ref('knowledge-revision', item.knowledgeId, item.title, { revision: item.revision, asOf: item.createdAt })], item.createdAt);
    },
  });

  registry.register({
    id: 'user.method.get', effect: 'read', description: '读取用户投资方法文档。解释当日行情或持仓涨跌时通常不需要。',
    inputSchema: EmptyAgentToolInputSchema,
    execute(_input, context) {
      const item = knowledgeService.getCurrentRevisionByMetadataKind(context.workspaceId, 'investment-method');
      if (!item) return result(null, [], Date.now(), ['尚未创建 metadata.kind 为 investment-method 的知识文档']);
      return result(item, [ref('knowledge-revision', item.knowledgeId, item.title, { revision: item.revision, asOf: item.createdAt })], item.createdAt);
    },
  });

  registry.register({
    id: 'market.overview.get', effect: 'read',
    description: '读取当前市场概览、涨跌和宽度。北京时间工作日 17:00 前是 A 股与港股观察，之后及周末是美股观察。不要顺手再调 market.global.get。',
    inputSchema: EmptyAgentToolInputSchema,
    async execute() {
      if (!sourcePort) {
        const data = await tradingService.getBoard({ board: 'overview' });
        const observedAt = data.fetchedAt || Date.now();
        return result(projectMarketBoardForAI(data), [ref('market-board', 'overview', '市场概览', { asOf: observedAt })], observedAt);
      }
      const snapshot = await sourcePort.projectForAI('market.overview', {});
      return result(snapshot.data, [ref('source', 'market.overview', '市场概览', { asOf: snapshot.observedAt })], snapshot.observedAt, snapshot.warnings);
    },
  });

  registry.register({
    id: 'market.global.get', effect: 'read',
    description: MARKET_GLOBAL_DESCRIPTION,
    inputSchema: EmptyAgentToolInputSchema,
    async execute() {
      if (!sourcePort) {
        const data = await tradingService.getBoard({ board: 'global' });
        const observedAt = data.fetchedAt || Date.now();
        const projected = projectMarketBoardForAI(data);
        return result(
          projected,
          [ref('market-board', 'global', '全球资产', { asOf: observedAt })],
          observedAt,
          marketBoardAiWarnings(projected),
        );
      }
      const snapshot = await sourcePort.projectForAI('market.global', {});
      return result(snapshot.data, [ref('source', 'market.global', '全球资产', { asOf: snapshot.observedAt })], snapshot.observedAt, snapshot.warnings);
    },
  });

  registry.register({
    id: 'holdings.get', effect: 'read', description: '读取当前持仓、估值和当日涨跌。已含每条持仓的涨跌幅和盈亏额；不要仅为排序再调 holdings.rank。',
    inputSchema: EmptyAgentToolInputSchema,
    async execute(_input, context) {
      const data = await tradingService.getHoldingsBoard({ workspaceId: context.workspaceId });
      return result(projectHoldingsBoard(data), [ref('holdings-board', `${context.workspaceId}:current`, '当前持仓与行情快照', { asOf: data.updatedAt })], data.updatedAt,
        data.missingQuotes.length ? [`缺少行情：${data.missingQuotes.join(', ')}`] : []);
    },
  });

  registry.register({
    id: 'holdings.rank', effect: 'read', description: '从当前持仓快照按盈亏排序并截取短列表。不提供 holdings.get 以外的新行情；看今日涨跌请先用 holdings.get。',
    inputSchema: HoldingsRankToolInputSchema,
    async execute(input, context) {
      const data = await tradingService.getHoldingsBoard({ workspaceId: context.workspaceId });
      const metric = input.metric;
      const positions = data.positions.slice().sort((left, right) => decimalCompare(left[metric], right[metric]))
        .slice(0, input.limit).map(projectHoldingPosition);
      return result({
        metric,
        positions,
        returnedCount: positions.length,
        totalCount: data.positions.length,
        truncated: data.positions.length > positions.length,
      }, [ref('holdings-board', `${context.workspaceId}:current`, '当前持仓与行情快照', { asOf: data.updatedAt })], data.updatedAt,
        data.missingQuotes.length ? [`缺少行情：${data.missingQuotes.join(', ')}`] : []);
    },
  });

  registry.register({
    id: 'assets.get', effect: 'read', description: '读取个人资产账本：类型、账户和期间统计。',
    inputSchema: EmptyAgentToolInputSchema,
    async execute() {
      const data = await tradingService.getPersonalAssetDashboard();
      return result(projectPersonalAssets(data), [ref('personal-assets', 'current', '个人资产工作簿快照', { asOf: data.updatedAt })], data.updatedAt,
        data.note ? [data.note] : []);
    },
  });

  const sourceManifests = sourcePort?.list({ includeInternal: true }) || [];
  const hasStaticSignalSources = sourceManifests.some((source) => (
    source.viewKind === 'calendar' || source.viewKind === 'official-release'
  ));
  if (hasStaticSignalSources) {
    registry.register({
      id: 'static.signals.list', effect: 'read',
      description: '读取中美官方宏观日程、央行日程和最新政策/会议发布。返回标题、时间、机构和官方 sourceUrl；需要理解某条发布或模板化会议预告的具体内容时，再把该 sourceUrl 传给 official.source.get。',
      inputSchema: StaticSignalsListToolInputSchema,
      async execute(input, context) {
        const current = Date.parse(context.runtimeContext?.currentTime || context.runtimeContext?.currentUtcTime || '');
        const at = Number.isFinite(current) ? current : Date.now();
        const board = await readStaticSignalBoard(sourcePort, {
          from: input.from ?? at - 7 * 86_400_000,
          to: input.to ?? at + 90 * 86_400_000,
          focus: input.focus,
          includeUndated: input.includeUndated,
          limit: input.limit,
          releaseLimit: input.releaseLimit,
        });
        const refs = [
          ...board.upcoming.map((item) => ref('scheduled-event', item.eventId.slice(0, 256), item.title, { asOf: item.scheduledAt })),
          ...board.releases.map((item) => ref('official-release', item.releaseId.slice(0, 256), item.title, { asOf: item.publishedAt })),
        ];
        return result(board, refs, board.generatedAt,
          board.sourceHealth.filter((item) => item.status !== 'ready').map((item) => `${item.title}：${item.note || item.status}`));
      },
    });
  }

  if (sourceManifests.some((source) => source.id === 'policy.official-detail')) {
    registry.register({
      id: 'official.source.get', effect: 'read',
      description: '按 static.signals.list 返回的官方 sourceUrl 读取官方页面详情。返回官网标题、官方摘要和经过清理、限长的正文；不生成解释、影响判断或投资结论。只允许已登记的政府/央行/官方统计域名。',
      inputSchema: OfficialSourceGetToolInputSchema,
      maxResultBytes: 64 * 1024,
      async execute(input, context) {
        const snapshot = await sourcePort.projectForAI('policy.official-detail', { sourceUrl: input.sourceUrl }, {
          signal: context.signal,
        });
        const label = snapshot.data.title || input.title || '官方信源详情';
        return result(snapshot.data, [ref('official-source', input.sourceUrl.slice(0, 256), label, {
          asOf: snapshot.data.publishedAt || snapshot.observedAt,
        })], snapshot.observedAt, snapshot.warnings);
      },
    });
  }

  const hasWebSearchSource = sourceManifests.some((source) => source.id === 'search.web');
  if (hasWebSearchSource) {
    registry.register({
      id: 'web.search', effect: 'read', description: '搜索公开互联网网页。不要用它代替本地 Feed、Tag、Knowledge、持仓等已经存在的本地数据源。不抓取正文。',
      inputSchema: WebSearchToolInputSchema,
      async execute(input, context) {
        try {
          const snapshot = await sourcePort.projectForAI('search.web', {
            query: input.query,
            limit: input.limit,
          }, { signal: context.signal });
          const data = snapshot.data;
          const rows = Array.isArray(data?.results) ? data.results : [];
          const refs = rows.map((item) => ref('web-result', String(item.url || '').slice(0, 256), item.title || item.url, {
            asOf: Number.isFinite(Date.parse(item.publishedAt)) ? Date.parse(item.publishedAt) : snapshot.observedAt,
          }));
          return result({
            query: data.query || input.query,
            available: data.available !== false,
            results: rows.map((item) => ({
              title: item.title,
              url: item.url,
              snippet: item.snippet || '',
              engine: item.engine || '',
              publishedAt: item.publishedAt ?? null,
            })),
            note: data.note || '',
          }, refs, snapshot.observedAt, snapshot.warnings);
        } catch (error) {
          if (error?.name === 'AbortError' || context.signal?.aborted) throw error;
          if (error?.name === 'WebSearchUnavailableError' || /unavailable|ECONNREFUSED|超时/i.test(String(error?.message || ''))) {
            return result(
              { query: input.query, available: false, results: [], note: 'Web 搜索不可用' },
              [],
              Date.now(),
              [`web.search unavailable：${String(error.message || 'Web 搜索不可用').slice(0, 240)}`],
            );
          }
          throw error;
        }
      },
    });
  }

  registry.register({
    id: 'taxonomy.list', effect: 'read', description: '读取可用 Taxonomy Catalog。用户要求记录灵感或沉淀知识时先调这个，再用 memory.save 填写已有 key。',
    inputSchema: EmptyAgentToolInputSchema,
    execute(_input, context) {
      const nodes = (knowledgeService.listTaxonomy(context.workspaceId) || []).map((node) => ({
        key: node.key,
        dimension: node.dimension,
        name: node.name,
        parentKey: node.parentKey || null,
      }));
      return result({ nodes }, [], Date.now());
    },
  });

  registry.register({
    id: 'memory.save', effect: 'write', description: '把当前会话整理后的 Structured Artifact 写入灵感或知识库。bodyMarkdown 只写可独立阅读的正文，禁止写入已落库/去向/分类路径/资源ID。不要传入 sourceRefs。只有本工具成功后才能声称已落库。Inspiration：observation/hypothesis/question/idea。Knowledge：fact/mechanism/thesis/framework/case/procedure。',
    inputSchema: SaveStructuredArtifactToolInputSchema,
    execute(input, context) {
      const sourceType = context.sessionId ? 'ai-session' : 'agent-run';
      const sourceId = context.sessionId || context.jobId;
      if (!sourceId) throw new Error('当前没有可记录的会话');
      const catalog = knowledgeService.listTaxonomy(context.workspaceId) || [];
      const artifact = sanitizeStructuredArtifact({
        schemaVersion: 1,
        ...input,
      }, { target: input.target, catalog });
      const saved = knowledgeService.persistStructuredArtifact({
        workspaceId: context.workspaceId,
        artifact,
        sourceType,
        sourceId,
        extraLinks: context.selectedRefs || [],
      });
      const pathLabel = formatTaxonomyPath(saved.taxonomy);
      return result({
        ...saved,
        savedTo: saved.resourceType === 'inspiration' ? '灵感' : '知识库',
        pathLabel,
      }, [saved.resourceType === 'inspiration'
        ? ref('inspiration', saved.resourceId, saved.title)
        : ref('knowledge-revision', saved.resourceId, saved.title)], Date.now());
    },
  });

  return registry;
}
