import { ARTICLE_ANALYSIS_TASK_TYPE } from '../../../contracts/src/index.js';
import {
  ARTICLE_READER_INSTRUCTION,
  ARTICLE_READER_TOOL_IDS,
  buildArticleReaderMessage,
} from './article-analysis-prompts.js';

const SOURCE_BODY_MAX = 200_000;
export const ARTICLE_OUTPUT_MAX = 40_000;
export const ARTICLE_LLM_TIMEOUT_MS = 480_000;
export const ARTICLE_WAIT_TICK_MS = 10_000;
export const ARTICLE_SLOW_WAIT_MS = 40_000;

function clip(value, max) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function uniqueText(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const text = String(part || '').trim();
    if (!text) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.join('\n\n');
}

function formatWaitLabel(elapsedMs) {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (elapsedMs >= ARTICLE_SLOW_WAIT_MS) {
    return `模型响应较慢，仍在等待 · 已 ${seconds} 秒`;
  }
  return `模型正在生成 · 已等待 ${seconds} 秒`;
}

function startWaitHeartbeat(record, stage) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    void record?.('article.wait', {
      stage,
      elapsedMs,
      label: formatWaitLabel(elapsedMs),
    });
  }, ARTICLE_WAIT_TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function occurredAt(item = {}) {
  return Number(item.publishedAt || item.capturedAt || item.updatedAt || item.createdAt || 0) || 0;
}

export async function loadArticleSource({ source, workspaceId, feedService, knowledgeService }) {
  if (source.type === 'inline') {
    const body = clip(source.body, SOURCE_BODY_MAX);
    return {
      title: clip(source.title || body, 1_000),
      body,
      sourceUrl: source.sourceUrl || '',
      publishedAt: source.publishedAt || null,
      refs: [],
      sourceText: uniqueText([source.title, body]),
    };
  }
  const reference = source.reference;
  if (reference.resourceType === 'content-item') {
    const item = feedService.getLocalizedContentItem?.(workspaceId, reference.resourceId)
      || feedService.getContentItem(workspaceId, reference.resourceId);
    if (!item) throw new Error('引用的信息流条目不存在');
    const original = uniqueText([item.summary, item.body, item.title]);
    const translated = item.translation?.text || '';
    const body = clip(uniqueText([translated, original]), SOURCE_BODY_MAX);
    return {
      title: clip(item.title || item.authorName || '未命名信息', 1_000),
      body,
      sourceUrl: item.sourceUrl || '',
      publishedAt: occurredAt(item) || null,
      refs: [{
        resourceType: 'content-item',
        resourceId: item.id,
        revision: null,
        asOf: occurredAt(item) || null,
        label: clip(item.title || '未命名信息', 1_000),
        origin: 'selected',
      }],
      sourceText: body,
    };
  }
  if (reference.resourceType === 'post') {
    const post = feedService.getLegacyPost(reference.resourceId);
    if (!post) throw new Error('引用的手工信息不存在');
    const body = clip(uniqueText([post.title, post.body]), SOURCE_BODY_MAX);
    return {
      title: clip(post.title || '未命名信息', 1_000),
      body,
      sourceUrl: post.sourceUrl || '',
      publishedAt: occurredAt(post) || null,
      refs: [{
        resourceType: 'post',
        resourceId: post.id,
        revision: null,
        asOf: post.createdAt || null,
        label: clip(post.title || '未命名信息', 1_000),
        origin: 'selected',
      }],
      sourceText: body,
    };
  }
  if (reference.resourceType === 'inspiration') {
    const note = knowledgeService.getInspiration(workspaceId, reference.resourceId);
    if (!note) throw new Error('引用的灵感不存在');
    const body = clip(note.body, SOURCE_BODY_MAX);
    return {
      title: clip(note.title || note.body || '灵感', 1_000),
      body,
      sourceUrl: note.sourceUrl || '',
      publishedAt: occurredAt(note) || null,
      refs: [{
        resourceType: 'inspiration',
        resourceId: note.id,
        revision: null,
        asOf: note.updatedAt || note.createdAt || null,
        label: clip(note.title || '灵感', 1_000),
        origin: 'selected',
      }],
      sourceText: uniqueText([note.title, body]),
    };
  }
  throw new Error('不支持的材料引用类型');
}

export function createArticleAnalysisRunner({
  agentRuntime,
  knowledgeService,
  feedService,
} = {}) {
  if (!agentRuntime?.run) throw new Error('article analysis requires an agentRuntime');
  if (!knowledgeService || !feedService) throw new Error('article analysis requires knowledge and feed services');

  return Object.freeze({
    async run({ source, workspaceId = 'local', jobId, sessionId = '', signal, trace } = {}) {
      const record = (event, detail) => trace?.({ event, detail });
      const loaded = await loadArticleSource({
        source,
        workspaceId,
        feedService,
        knowledgeService,
      });
      const sourceText = clip(loaded.sourceText || loaded.body, SOURCE_BODY_MAX);
      if (!sourceText) throw new Error('材料正文为空');

      await record('article.started', {
        sourceType: source.type,
        chars: sourceText.length,
        title: loaded.title,
      });
      await record('article.stage', {
        stage: 'running',
        label: '开始阅读材料',
        summary: `${sourceText.length.toLocaleString('zh-CN')} 字`,
      });

      const stopHeartbeat = startWaitHeartbeat(record, 'running');
      let result;
      try {
        result = await agentRuntime.run({
          message: buildArticleReaderMessage({
            title: loaded.title,
            sourceUrl: loaded.sourceUrl,
            sourceText,
          }),
          workspaceId,
          sessionId,
          jobId,
          selectedRefs: loaded.refs,
          signal,
          webMode: 'always',
          taskInstruction: ARTICLE_READER_INSTRUCTION,
          allowedToolIds: ARTICLE_READER_TOOL_IDS,
          timeoutMs: ARTICLE_LLM_TIMEOUT_MS,
          enableAuxiliarySearch: false,
          trace,
        });
      } finally {
        stopHeartbeat();
      }

      const outputText = clip(result.answer, ARTICLE_OUTPUT_MAX);
      const warnings = [...new Set((result.warnings || []).filter(Boolean))];
      await record('article.stage', { stage: 'running', label: '正在整理回答' });
      const aiRun = knowledgeService.recordAgentRun({
        jobId,
        workspaceId,
        sessionId,
        message: loaded.title || clip(sourceText, 120),
        answer: outputText,
        providerId: result.providerId,
        modelId: result.modelId,
        refs: [...loaded.refs, ...(result.refs || [])],
        warnings,
        sourceType: 'article-analysis',
        sourceId: jobId,
        taskType: ARTICLE_ANALYSIS_TASK_TYPE,
        output: { outputText, evidenceGate: result.evidenceGate || null },
      });
      return {
        stage: 'completed',
        aiRunId: aiRun.id,
        sessionId: aiRun.sessionId,
        outputText,
        providerId: result.providerId,
        modelId: result.modelId,
        warnings,
        evidenceGate: result.evidenceGate || null,
        qualityPrior: result.qualityPrior || null,
        toolAudits: result.toolAudits || [],
        visibleTools: result.visibleTools || [],
        rejectedAnswers: result.rejectedAnswers || 0,
        reviewMessage: loaded.title || clip(sourceText, 120),
      };
    },
  });
}
