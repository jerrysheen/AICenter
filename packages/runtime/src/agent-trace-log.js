import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SENSITIVE_KEY = /api.?key|authorization|cookie|password|secret|token/i;
const MAX_VALUE_LENGTH = 24_000;
const MAX_PROGRESS_STEPS = 40;
const SNIPPET_MAX = 100;

const TOOL_LABELS = Object.freeze({
  'context.build': '上下文摘要',
  'feed.search': '信息流',
  'feed.tag.search': 'Tag 信息流',
  'tag.list': 'Tag 字典',
  'knowledge.search': '知识库',
  'knowledge.get': '知识文档',
  'user.method.get': '投资方法',
  'market.overview.get': '市场概览',
  'market.global.get': '全球资产',
  'holdings.get': '当前持仓',
  'holdings.rank': '持仓排序',
  'assets.get': '个人资产',
  'web.search': '联网搜索',
  'taxonomy.list': '分类目录',
  'memory.save': '保存记录',
});

function safeValue(value) {
  if (typeof value === 'string') return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…[truncated]` : value;
  if (Array.isArray(value)) return value.map(safeValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    SENSITIVE_KEY.test(key) ? '[redacted]' : safeValue(item),
  ]));
}

function logFile(logDirectory, at) {
  return path.join(logDirectory, 'agent-runs', `${new Date(at).toISOString().slice(0, 10)}.jsonl`);
}

function utcDay(at) {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function daysBetween(fromAt, toAt) {
  const start = utcDay(fromAt);
  const end = utcDay(toAt);
  const days = [];
  for (let cursor = start; cursor <= end; cursor += 86_400_000) days.push(cursor);
  return days;
}

function normalizeToolId(value) {
  return String(value || '').replaceAll('_', '.');
}

function toolLabel(value) {
  const id = normalizeToolId(value);
  return TOOL_LABELS[id] || id || '工具';
}

function toolNames(detail) {
  const calls = Array.isArray(detail?.toolCalls) ? detail.toolCalls : [];
  const names = calls.map((call) => toolLabel(call?.name || call?.id)).filter(Boolean);
  if (names.length) return [...new Set(names)].join('、');
  const requested = Array.isArray(detail?.requested) ? detail.requested.map(toolLabel) : [];
  return [...new Set(requested)].join('、');
}

function clipSnippet(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
}

function firstTitle(items) {
  if (!Array.isArray(items)) return '';
  for (const item of items.slice(0, 3)) {
    const title = clipSnippet(item?.title || item?.name || item?.snippet || item?.summary || '');
    if (title) return title;
  }
  return '';
}

function snippetFromInput(input) {
  if (!input || typeof input !== 'object') return '';
  if (input.tag) return clipSnippet([input.tag, input.timeRange].filter(Boolean).join(' / '));
  if (input.query) return clipSnippet(`检索：${input.query}`);
  if (input.metric) return clipSnippet(`按 ${input.metric} 排序`);
  if (input.knowledgeId) return clipSnippet(`文档 ${input.knowledgeId}`);
  if (input.limit) return clipSnippet(`取 ${input.limit} 条`);
  return '';
}

function snippetFromData(toolId, data) {
  const id = normalizeToolId(toolId);
  if (!data) return '';
  if (Array.isArray(data)) return firstTitle(data);
  if (typeof data !== 'object') return clipSnippet(data);
  if (id === 'feed.search' || id === 'knowledge.search') {
    return firstTitle(data.items || data.rows || data.knowledge || data);
  }
  if (id === 'feed.tag.search') {
    const hit = firstTitle(data.items);
    const count = Number.isFinite(data.matchedCount) ? `命中 ${data.matchedCount} 条` : '';
    return clipSnippet([count, hit].filter(Boolean).join(' · '));
  }
  if (id === 'context.build') {
    const feed = firstTitle(data.recentFeed);
    const knowledge = firstTitle(data.knowledge);
    return clipSnippet([knowledge && `知识：${knowledge}`, feed && `信息流：${feed}`].filter(Boolean).join('；'));
  }
  if (id === 'holdings.get' || id === 'holdings.rank') {
    const names = (data.positions || []).slice(0, 4).map((item) => item.name || item.symbol).filter(Boolean);
    const lines = (data.summary?.lines || []).map((item) => item.label).filter(Boolean);
    if (names.length) return clipSnippet(names.join('、'));
    if (lines.length) return clipSnippet(lines.join('、'));
  }
  if (id === 'assets.get' && data.latest?.label) {
    return clipSnippet(`最新 ${data.latest.label}，总资产 ${data.latest.total || ''}`.trim());
  }
  if (id === 'web.search') {
    const hit = firstTitle(data.results);
    const query = data.query ? `检索：${data.query}` : '';
    return clipSnippet([query, hit && `命中：${hit}`].filter(Boolean).join(' · '));
  }
  if (id === 'market.overview.get' || id === 'market.global.get') {
    const names = (data.watchlist || data.indices || []).slice(0, 4)
      .map((item) => item.name || item.symbol).filter(Boolean);
    const section = data.sections?.[0]?.title || '';
    if (names.length) return clipSnippet(names.join('、'));
    return clipSnippet([section, data.board, data.note].filter(Boolean).join(' · '));
  }
  return firstTitle(data.knowledge) || clipSnippet(data.title || data.note || data.summary || '');
}

function snippetFromToolCalls(detail) {
  const calls = Array.isArray(detail?.toolCalls) ? detail.toolCalls : [];
  const bits = calls.map((call) => {
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    if (args.tag) return `${toolLabel(call.name)}：${[args.tag, args.timeRange].filter(Boolean).join(' / ')}`;
    if (args.query) return `${toolLabel(call.name)}：${args.query}`;
    if (args.metric) return `${toolLabel(call.name)}：${args.metric}`;
    return '';
  }).filter(Boolean);
  return clipSnippet(bits.join('；'));
}

function progressSnippet(event, detail, toolId) {
  if (event === 'run.started') return clipSnippet(detail.message);
  if (event === 'model.requested') return '';
  if (event === 'model.responded') {
    return snippetFromToolCalls(detail) || clipSnippet(detail.answerPreview);
  }
  if (event === 'answer.rejected') {
    if (detail.reason === 'fabricated-web-search') return clipSnippet(detail.answerPreview || '草稿声称已搜索，但没有 web.search 调用');
    if (detail.reason === 'claimed-findings-without-results') return clipSnippet(detail.answerPreview || '搜索没有可用结果，不能当作已核实');
    if (detail.reason === 'missing-web-search') return clipSnippet(detail.answerPreview || '用户要求联网，但没有 web.search 调用');
    return clipSnippet(detail.answerPreview || '回答未采纳');
  }
  if (event === 'tool.failed') return clipSnippet(detail.error?.message || detail.message);
  if (event === 'tool.started') return snippetFromInput(detail.input);
  if (event === 'tool.completed') {
    return snippetFromData(toolId || detail.id, detail.data) || snippetFromInput(detail.input);
  }
  if (event === 'tool.batch.skipped') return clipSnippet(toolNames(detail) && `未执行：${toolNames(detail)}`);
  if (event === 'run.failed') return clipSnippet(detail.message);
  if (event === 'run.completed') return clipSnippet(detail.answer);
  return '';
}

export function projectAgentProgress(records) {
  const steps = [];
  const index = new Map();

  const upsert = (key, step) => {
    if (index.has(key)) {
      Object.assign(index.get(key), step);
      return;
    }
    const item = { key, toolId: null, round: null, ...step };
    index.set(key, item);
    steps.push(item);
  };

  for (const record of records) {
    const detail = record?.detail && typeof record.detail === 'object' ? record.detail : {};
    const at = Number(record?.at) || 0;
    const event = String(record?.event || '');
    const round = Number.isInteger(detail.round) ? detail.round : null;
    const toolId = detail.id ? normalizeToolId(detail.id) : null;

    const snippet = progressSnippet(event, detail, toolId);

    if (event === 'run.started') {
      upsert('run', { at, event, label: '开始处理问题', detail: snippet, status: 'done' });
      continue;
    }
    if (event === 'model.requested') {
      upsert(`model-${round ?? 0}-wait`, {
        at, event, round,
        label: '正在判断这一轮要读取什么',
        detail: snippet || '等待模型决定这一轮要读什么',
        status: 'active',
      });
      continue;
    }
    if (event === 'model.responded') {
      const names = toolNames(detail);
      const waitKey = `model-${round ?? 0}-wait`;
      if (index.has(waitKey)) upsert(waitKey, { status: 'done' });
      const firstId = normalizeToolId(detail.toolCalls?.[0]?.name || detail.toolCalls?.[0]?.id);
      upsert(`model-${round ?? 0}`, {
        at, event, round,
        label: names
          ? (firstId === 'web.search' ? '准备联网搜索' : `准备读取${names}`)
          : '正在整理回答',
        detail: snippet,
        status: names ? 'done' : 'active',
      });
      continue;
    }
    if (event === 'answer.rejected') {
      const modelKey = `model-${round ?? 0}`;
      if (index.has(modelKey)) upsert(modelKey, { status: 'done' });
      upsert(`reject-${round ?? 0}`, {
        at, event, round,
        label: detail.reason === 'missing-web-search'
          ? '回答未采纳，用户要求联网但未调用搜索'
          : '回答未采纳，来源声称与 Tool 调用不符',
        detail: snippet,
        status: 'done',
      });
      continue;
    }
    if (event === 'tool.started' || event === 'tool.completed' || event === 'tool.failed') {
      const key = String(detail.callId || `${toolId}-${at}`);
      const status = event === 'tool.completed' ? 'done' : event === 'tool.failed' ? 'error' : 'active';
      const count = Number(detail.data?.matchedCount);
      const label = event === 'tool.completed'
        ? (toolId === 'web.search'
          ? '已获取联网结果'
          : toolId === 'feed.tag.search' && Number.isFinite(count)
            ? `已读取 Tag 信息流 · 命中 ${count} 条`
            : `已读取${toolLabel(toolId)}`)
        : event === 'tool.failed'
          ? `${toolLabel(toolId)}读取失败`
          : (toolId === 'web.search' ? '正在联网搜索' : `正在读取${toolLabel(toolId)}`);
      upsert(key, { at, event, toolId, round, label, detail: snippet, status });
      continue;
    }
    if (event === 'tool.batch.skipped') {
      upsert(`skip-${at}`, {
        at, event, round, label: '工具预算已满，改为根据已有结果作答', detail: snippet, status: 'done',
      });
      continue;
    }
    if (event === 'run.completed') {
      upsert('run-end', { at, event, label: '回答已生成', detail: snippet, status: 'done' });
      continue;
    }
    if (event === 'run.failed') {
      upsert('run-end', { at, event, label: '问答未能完成', detail: snippet, status: 'error' });
    }
  }

  return steps.slice(-MAX_PROGRESS_STEPS).map((step) => ({
    at: step.at,
    event: step.event,
    label: step.label,
    detail: step.detail || '',
    status: step.status,
    toolId: step.toolId ?? null,
    round: step.round ?? null,
  }));
}

/** Append-only local trace for agent runs. Trace failures must not fail a run. */
export function createAgentTraceLog({ dataDirectory, logDirectory: configuredLogDirectory, now = () => Date.now() }) {
  const logDirectory = configuredLogDirectory || (dataDirectory ? path.join(dataDirectory, 'logs') : '');
  if (!logDirectory) throw new Error('agent trace log requires dataDirectory or logDirectory');
  return Object.freeze({
    async append({ runId, workspaceId, event, detail = {}, at = now() }) {
      const filePath = logFile(logDirectory, at);
      const record = {
        version: 1, at, runId: String(runId || ''), workspaceId: String(workspaceId || ''),
        event: String(event || ''), detail: safeValue(detail),
      };
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
      } catch {}
      return filePath;
    },
    async list(runId, { fromAt = now() - 86_400_000, toAt = now() } = {}) {
      const target = String(runId || '');
      if (!target) return [];
      const records = [];
      for (const day of daysBetween(fromAt, toAt)) {
        const filePath = logFile(logDirectory, day);
        if (!existsSync(filePath)) continue;
        let text = '';
        try { text = await readFile(filePath, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          if (!line.includes(target)) continue;
          try {
            const record = JSON.parse(line);
            if (record.runId === target) records.push(record);
          } catch {}
        }
      }
      return records.sort((left, right) => (left.at || 0) - (right.at || 0));
    },
    async listSteps(runId, options) {
      return projectAgentProgress(await this.list(runId, options));
    },
  });
}
