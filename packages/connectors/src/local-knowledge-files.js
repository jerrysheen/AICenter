import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;

function unquote(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function coerce(value) {
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

export function parseKnowledgeFrontMatter(raw) {
  const source = String(raw || '').replace(/^\uFEFF/, '');
  if (!source.startsWith('---')) return null;
  const end = source.indexOf('\n---', 3);
  if (end < 0) return null;
  const yaml = source.slice(3, end).trim();
  const body = source.slice(end + 4).replace(/^\s*\n/, '');
  const meta = {};
  let listKey = null;
  for (const line of yaml.split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && listKey) {
      meta[listKey].push(unquote(item[1]));
      continue;
    }
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1];
    const value = pair[2].trim();
    if (!value) {
      listKey = key;
      meta[key] = [];
      continue;
    }
    listKey = null;
    meta[key] = coerce(unquote(value));
  }
  const id = String(meta.id || '').trim();
  if (!ID_PATTERN.test(id)) return null;
  return {
    id,
    type: String(meta.type || '').trim(),
    domain: String(meta.domain || '').trim(),
    tags: Array.isArray(meta.tags) ? meta.tags.map((item) => String(item).trim()).filter(Boolean) : [],
    version: Number.isInteger(meta.version) && meta.version > 0 ? meta.version : 1,
    body,
  };
}

function headingText(body) {
  const match = String(body || '').match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function summaryFromBody(body) {
  const chain = String(body || '').match(/## Analysis Chain\s+([\s\S]*?)(?:\n## |\s*$)/i);
  if (chain) {
    const steps = [...chain[1].matchAll(/^\d+\.\s+(.+)$/gm)].map((item) => item[1].trim());
    if (steps.length) return steps.join(' → ');
  }
  const goal = String(body || '').match(/## Goal\s+([\s\S]*?)(?:\n## |\s*$)/i);
  if (goal) return goal[1].trim().split(/\r?\n/)[0].slice(0, 200);
  return '';
}

function walkMarkdown(rootDirectory) {
  const files = [];
  const stack = [rootDirectory];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = path.relative(rootDirectory, full);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      if (entry.name.toLowerCase() === 'readme.md') continue;
      files.push(full);
    }
  }
  return files;
}

function loadDocuments(rootDirectory) {
  const byId = new Map();
  for (const filePath of walkMarkdown(rootDirectory)) {
    let raw;
    let stats;
    try {
      raw = readFileSync(filePath, 'utf8');
      stats = statSync(filePath);
    } catch {
      continue;
    }
    const parsed = parseKnowledgeFrontMatter(raw);
    if (!parsed || byId.has(parsed.id)) continue;
    const title = headingText(parsed.body) || parsed.id;
    byId.set(parsed.id, {
      knowledgeId: parsed.id,
      revision: parsed.version,
      title,
      body: parsed.body.trim(),
      snippet: summaryFromBody(parsed.body) || title,
      createdAt: Number.isFinite(stats.mtimeMs) ? Math.round(stats.mtimeMs) : Date.now(),
      type: parsed.type,
      domain: parsed.domain,
      tags: parsed.tags,
      haystack: [parsed.id, title, parsed.type, parsed.domain, parsed.tags.join(' '), parsed.body]
        .join('\n')
        .toLowerCase(),
    });
  }
  return [...byId.values()];
}

function tokens(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/([a-z0-9_+/-])(\p{Script=Han})/gu, '$1 $2')
    .replace(/(\p{Script=Han})([a-z0-9_+/-])/gu, '$1 $2')
    .split(/[^\p{L}\p{N}+/]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 1);
}

const STOP_TOKENS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'for', 'in', 'on',
  '的', '和', '与', '或', '了', '在', '是', '把', '被', '对', '从', '为',
  '也', '很', '到', '等', '以及', '一下', '一家', '怎么', '如何', '帮我',
  '看看', '这个', '那个', '分析',
]);

function queryTokensOf(query) {
  return tokens(query).filter((item) => !STOP_TOKENS.has(item) && item.length > 1);
}

function scoreDocument(document, queryTokens) {
  if (!queryTokens.length) return 0;
  let score = 0;
  let hits = 0;
  for (const token of queryTokens) {
    let add = 0;
    if (document.knowledgeId.toLowerCase().includes(token)) add = 4;
    else if (document.title.toLowerCase().includes(token)) add = 3;
    else if (document.tags.some((tag) => tag.toLowerCase().includes(token))) add = 3;
    else if (document.haystack.includes(token)) add = 1;
    if (!add) continue;
    hits += 1;
    score += add;
  }
  return hits ? score : 0;
}

/**
 * Scoped local-file adapter for reusable Knowledge Markdown.
 * Agent tools must not receive paths; only search/get by semantic id.
 */
export function createLocalKnowledgeFiles({ rootDirectory } = {}) {
  if (!rootDirectory) throw new Error('file knowledge rootDirectory is required');
  const root = path.resolve(rootDirectory);

  function documents() {
    return loadDocuments(root);
  }

  return Object.freeze({
    search(input = {}) {
      const query = String(input.query || '').trim();
      if (!query) return [];
      const cap = Math.max(1, Math.min(Number(input.limit) || 8, 100));
      const queryTokens = queryTokensOf(query);
      if (!queryTokens.length) return [];
      return documents()
        .map((item) => ({ item, score: scoreDocument(item, queryTokens) }))
        .filter((row) => row.score > 0)
        .sort((left, right) => right.score - left.score || left.item.knowledgeId.localeCompare(right.item.knowledgeId))
        .slice(0, cap)
        .map(({ item, score }) => ({
          knowledgeId: item.knowledgeId,
          revision: item.revision,
          title: item.title,
          snippet: item.snippet,
          kind: item.type || 'knowledge',
          score,
        }));
    },

    list(input = {}) {
      const cap = Math.max(1, Math.min(Number(input.limit) || 20, 100));
      return documents()
        .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'))
        .slice(0, cap)
        .map((item) => ({
          knowledgeId: item.knowledgeId,
          revision: item.revision,
          title: item.title,
          snippet: item.snippet,
          kind: item.type || 'knowledge',
        }));
    },

    get(knowledgeId) {
      const id = String(knowledgeId || '').trim();
      const item = documents().find((entry) => entry.knowledgeId === id);
      if (!item) return null;
      return {
        knowledgeId: item.knowledgeId,
        revision: item.revision,
        title: item.title,
        body: item.body,
        createdAt: item.createdAt,
      };
    },
  });
}
