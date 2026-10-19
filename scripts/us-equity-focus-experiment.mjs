import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createGeminiTagPort } from '../packages/connectors/src/gemini-tag.js';
import { createTypeSafeSystemOneClient } from '../packages/connectors/src/typesafe-system-one.js';
import { openJevClient } from '../packages/domain/src/jev-enabled.js';
import { loadTagCatalog } from '../packages/domain/src/tag-catalog.js';
import { TAG_PROMPT_VERSION } from '../packages/domain/src/tag-prompt.js';
import { createTaggingService } from '../packages/domain/src/tagging-service.js';
import { createUsEquityFocusEvaluator, focusHit, loadUsEquityFocus, stratifySample } from '../packages/domain/src/us-equity-focus.js';
import { loadInstanceEnvironment, resolveInstanceConfig } from '../packages/instance/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'data', 'experiments', 'us-equity-focus-v1');
const resultsPath = path.join(outputDir, 'results.json');
const reportPath = path.join(outputDir, 'report.html');
const cachePath = path.join(outputDir, 'cache.json');
const reviewPath = path.join(outputDir, 'review.json');
const limit = Math.max(1, Number(process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 150));
const tagLimit = Math.min(50, limit);
const renderOnly = process.argv.includes('--render-only');
const maxRequests = Math.max(limit, Number(process.env.AI_CENTER_FOCUS_MAX_REQUESTS || limit + 20));

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function chunks(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

function chooseWindow(db, now) {
  const rows = db.prepare(`SELECT period_key, start_at, published_id FROM information_tree_heads
    WHERE workspace_id = 'local' AND layer = 'daily' ORDER BY start_at DESC`).all();
  for (const row of rows) {
    const [, startText, endText] = String(row.period_key).split(':');
    const startAt = Number(startText);
    const endAt = Number(endText);
    if (Number.isFinite(endAt) && endAt <= now) {
      return { startAt, endAt, published: Boolean(row.published_id), periodKey: row.period_key };
    }
  }
  return null;
}

function loadCandidates(db, window) {
  const nodes = db.prepare(`SELECT h.source_id, h.event_at, h.source_version, n.id AS node_id, n.value_json
    FROM information_tree_information_heads h
    JOIN information_tree_nodes n ON n.workspace_id = h.workspace_id AND n.id = h.node_id
    WHERE h.workspace_id = 'local' AND h.event_at >= ? AND h.event_at < ?`).all(window.startAt, window.endAt);
  const parsed = [];
  for (const row of nodes) {
    let node;
    try { node = JSON.parse(row.value_json); } catch { continue; }
    const title = String(node.title || '').trim();
    const summary = String(node.text || '').trim();
    const sourceId = String(row.source_id || '');
    if (!title || !summary || !sourceId) continue;
    parsed.push({
      id: sourceId, sourceId, nodeId: row.node_id, sourceVersion: row.source_version, eventAt: row.event_at,
      title, summary, columnTag: node.tagId || '', lane: sourceId.startsWith('media:') ? 'media' : 'feed',
    });
  }
  const feedIds = [...new Set(parsed.filter((item) => item.lane === 'feed' && item.sourceId.startsWith('feed:')).map((item) => item.sourceId.slice(5)))];
  const mediaIds = [...new Set(parsed.filter((item) => item.lane === 'media').map((item) => item.sourceId.slice(6)))];
  const feedMeta = new Map();
  for (const group of chunks(feedIds, 400)) {
    const rows = db.prepare(`SELECT ci.id, c.provider, c.external_id, ci.source_url,
      json_extract(c.metadata_json, '$.filterDecision') AS decision
      FROM content_items ci
      JOIN captures c ON c.id = ci.capture_id AND c.workspace_id = ci.workspace_id
      WHERE ci.workspace_id = 'local' AND ci.id IN (${group.map(() => '?').join(',')})`).all(...group);
    for (const row of rows) feedMeta.set(row.id, row);
  }
  const mediaMeta = new Map();
  for (const group of chunks(mediaIds, 400)) {
    const rows = db.prepare(`SELECT external_id, channel, canonical_url, publisher_name, source_key
      FROM media_index_entries WHERE workspace_id = 'local' AND external_id IN (${group.map(() => '?').join(',')})`).all(...group);
    for (const row of rows) mediaMeta.set(row.external_id, row);
  }
  const seen = new Set();
  const kept = [];
  let excluded = 0;
  for (const item of parsed) {
    if (seen.has(item.sourceId)) continue;
    seen.add(item.sourceId);
    if (item.lane === 'feed') {
      const meta = feedMeta.get(item.sourceId.slice(5));
      if (!meta || meta.decision !== 'KEEP') { excluded += 1; continue; }
      item.provider = meta.provider || 'feed';
      item.sourceUrl = meta.source_url || '';
      item.externalId = meta.external_id || '';
      item.stratum = `feed:${item.provider}`;
    } else {
      const meta = mediaMeta.get(item.sourceId.slice(6));
      item.provider = meta?.source_key || 'media';
      item.channel = meta?.channel || 'media';
      item.sourceUrl = meta?.canonical_url || '';
      item.publisher = meta?.publisher_name || '';
      item.stratum = `media:${item.channel || 'media'}`;
    }
    kept.push(item);
  }
  return { kept, excluded, scanned: parsed.length };
}

function fileCache(file) {
  const entries = readJson(file, {});
  return {
    get(key) { return entries[key] || null; },
    set(key, value) {
      entries[key] = value;
      writeJson(file, entries);
    },
  };
}

function retryable(result) {
  return Object.values(result?.answers || {}).some((row) => ['TYPESAFE_TIMEOUT', 'TYPESAFE_NETWORK_ERROR'].includes(row.errorCode));
}

function fatal(result) {
  return Object.values(result?.answers || {}).some((row) => ['TYPESAFE_UNAUTHORIZED', 'jev-unavailable'].includes(row.errorCode));
}

function protocolReady(result) {
  const rows = Object.values(result?.answers || {});
  return rows.length === 8 && rows.some((row) => row.status === 'success' && typeof row.score === 'number');
}

async function scoreAll(evaluator, items) {
  const scored = new Array(items.length);
  const budget = { used: 0, max: maxRequests };
  let stopReason = '';
  async function once(item) {
    if (budget.used >= budget.max) return { requestCount: 0, answers: {}, usage: {}, stopped: 'budget' };
    const result = await evaluator.evaluate({ title: item.title, summary: item.summary });
    budget.used += result.requestCount || 0;
    if ((result.requestCount || 0) > 0 && retryable(result) && budget.used < budget.max) {
      const again = await evaluator.evaluate({ title: item.title, summary: item.summary });
      budget.used += again.requestCount || 0;
      return again;
    }
    return result;
  }
  const first = await once(items[0]);
  scored[0] = { ...items[0], focus: first };
  console.log(`protocol ${items[0].id} requests=${budget.used} ready=${protocolReady(first)}`);
  if (!protocolReady(first)) return { scored: scored.filter(Boolean), budget, stopReason: fatal(first) ? '凭证或服务不可用' : '协议验证没有返回可用分数' };
  let cursor = 1;
  let checkedPilot = false;
  async function loop() {
    while (cursor < items.length && !stopReason) {
      const index = cursor;
      cursor += 1;
      if (budget.used >= budget.max) { stopReason = '达到请求上限'; return; }
      const result = await once(items[index]);
      scored[index] = { ...items[index], focus: result };
      if (fatal(result)) { stopReason = '凭证或服务不可用'; return; }
      const done = scored.filter((item) => item?.focus);
      if (done.length % 10 === 0) console.log(`scored ${done.length}/${items.length} requests=${budget.used}`);
      if (!checkedPilot && done.length >= 50) {
        checkedPilot = true;
        const failed = done.filter((item) => Object.values(item.focus.answers || {}).every((row) => row.status !== 'success')).length;
        if (failed / done.length > 0.2) { stopReason = '前50条失败率超过20%'; return; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, items.length - 1) }, () => loop()));
  return { scored: scored.filter(Boolean), budget, stopReason };
}

function blankUsage() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, inputKnown: 0, outputKnown: 0, cost: null };
}

function addUsage(total, result) {
  if (!result?.requestCount) return;
  total.requests += result.requestCount;
  if (Number.isFinite(result.usage?.inputTokens)) { total.inputTokens += result.usage.inputTokens; total.inputKnown += 1; }
  if (Number.isFinite(result.usage?.outputTokens)) { total.outputTokens += result.usage.outputTokens; total.outputKnown += 1; }
  if (Number.isFinite(result.usage?.cost)) total.cost = (total.cost || 0) + result.usage.cost;
}

async function classifySample(items, catalog) {
  const port = createGeminiTagPort();
  const service = createTaggingService({ catalog, taggingPort: port });
  const started = Date.now();
  const result = await service.analyzeItems({
    workspaceId: 'local',
    resourceType: 'content-item',
    items: items.map((item) => ({ id: item.id, title: item.title, summary: item.summary })),
  });
  return {
    promptVersion: result.promptVersion || TAG_PROMPT_VERSION,
    elapsedMs: Date.now() - started,
    missingItemIds: result.missingItemIds || [],
    rows: (result.saved || []).map((row) => ({ id: row.resourceId, tags: row.tags || [], model: row.model || '' })),
  };
}

const shanghai = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function render(data, review = {}) {
  const names = new Map(data.catalog.map((tag) => [tag.id, tag.name]));
  const questions = data.definition.questions;
  const items = data.items || [];
  const hits = Object.fromEntries(questions.map((question) => [question.id, []]));
  const unmatched = [];
  const failed = [];
  for (const item of items) {
    const answers = item.focus?.answers || {};
    let any = false;
    let broken = false;
    for (const question of questions) {
      const row = answers[question.id];
      if (!row || row.status !== 'success') broken = true;
      else if (focusHit(row, data.definition.threshold)) { hits[question.id].push(item); any = true; }
    }
    if (!any && !broken && item.focus) unmatched.push(item);
    if (broken) failed.push(item);
  }
  const tagRows = new Map((data.tagging?.rows || []).map((row) => [row.id, row]));
  const card = (item, questionId) => {
    const score = item.focus?.answers?.[questionId];
    const tags = tagRows.get(item.id);
    const when = item.eventAt ? shanghai.format(item.eventAt) : '';
    return `<article id="${esc(item.id)}">
      <h3>${esc(item.title)}</h3>
      <p>${esc(item.summary)}</p>
      <p class="meta">${esc(item.stratum)} · ${esc(when)} · 栏目 ${esc(names.get(item.columnTag) || item.columnTag || '未分类')}
        ${item.sourceUrl ? ` · <a href="${esc(item.sourceUrl)}">原文</a>` : ''} · <code>${esc(item.sourceId)}</code></p>
      ${questionId ? `<p>本题分数 <strong>${score?.status === 'success' ? Number(score.score).toFixed(2) : '失败'}</strong></p>` : ''}
      <p class="scores">${questions.map((question) => {
        const row = item.focus?.answers?.[question.id];
        const text = row?.status === 'success' ? Number(row.score).toFixed(2) : '失败';
        return `${esc(question.id)} ${text}`;
      }).join(' · ')}</p>
      ${tags ? `<p>AI Tag：${tags.tags.map((id) => esc(names.get(id) || id)).join('、') || '无'}</p>` : ''}
    </article>`;
  };
  const newTags = new Set(data.newTagIds);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>美股关注筛选实验</title>
<style>
body{font-family:"Segoe UI",sans-serif;max-width:980px;margin:32px auto;padding:0 16px;line-height:1.5;color:#1c1917}
h1,h2{line-height:1.25} article{border-top:1px solid #e7e5e4;padding:12px 0} .meta,.scores{color:#57534e;font-size:14px}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #e7e5e4;text-align:left;padding:6px;vertical-align:top}
.note{background:#fafaf9;padding:12px 16px}
</style></head><body>
<h1>信息流 AI Tag 与美股 JEV 关注筛选</h1>
<div class="note"><p>样本是已结束日报窗口里质量筛选通过、且已有标题和摘要的消息。没有只取栏目为美股的消息。本轮按要求只评 ${data.sample.selected} 条，池子里还有 ${data.sample.uncovered} 条没有进入实验。</p>
<p>窗口 ${esc(data.window.label)}。JEV 命中阈值 ${data.definition.threshold} 只用于浏览，原始分数都保留。命中数量不是日报采用数量。</p>
<p>请求 ${data.usage.requests} 次。输入 token ${data.usage.inputKnown ? data.usage.inputTokens : '未知'}，输出 token ${data.usage.outputKnown ? data.usage.outputTokens : '未知'}。费用 ${data.usage.cost == null ? '没有可核实价格，不补零' : data.usage.cost}。</p>
${data.stopReason ? `<p>提前停止：${esc(data.stopReason)}</p>` : ''}</div>
<h2>32 个全局标签</h2>
<ul>${data.catalog.map((tag) => `<li>${newTags.has(tag.id) ? '<strong>新增</strong> ' : ''}${esc(tag.name)} <code>${esc(tag.id)}</code>${tag.description ? `：${esc(tag.description)}` : ''}</li>`).join('')}</ul>
<h2>50 条 AI Tag</h2>
<table><tr><th>标题</th><th>标签</th></tr>${(data.tagSample || []).map((item) => {
    const row = tagRows.get(item.id);
    return `<tr><td>${esc(item.title)}</td><td>${row ? row.tags.map((id) => `${esc(names.get(id) || id)}${newTags.has(id) ? '（新）' : ''}`).join('、') || '无' : '未完成'}</td></tr>`;
  }).join('')}</table>
${review.aiNotes ? `<div class="note"><p>${esc(review.aiNotes)}</p></div>` : ''}
<h2>八个关注问题</h2>
${questions.map((question) => `<details><summary>${esc(question.id)} ${esc(question.name)} · ${hits[question.id].length} 条</summary>
<p>${esc(question.ask)}</p>
${hits[question.id].map((item) => card(item, question.id)).join('') || '<p>没有达到临时阈值的消息。</p>'}
</details>`).join('')}
<h2>未命中任何关注点</h2>
${unmatched.map((item) => card(item)).join('') || '<p>没有。</p>'}
<h2>评分失败</h2>
${failed.map((item) => card(item)).join('') || '<p>没有。</p>'}
<h2>逐条分数</h2>
${items.map((item) => card(item)).join('')}
${review.findings ? `<h2>人工抽查</h2><div class="note">${review.findings.map((line) => `<p>${esc(line)}</p>`).join('')}</div>` : ''}
</body></html>`;
}

async function retryFailed() {
  loadInstanceEnvironment({ repositoryRoot: root });
  const data = readJson(resultsPath, null);
  if (!data) throw new Error('还没有结果文件');
  const definition = loadUsEquityFocus(readFileSync(path.join(root, 'config', 'research', 'us-equity-daily-focus.json'), 'utf8'));
  const client = openJevClient(process.env, undefined, (options) => createTypeSafeSystemOneClient({ ...options, timeoutMs: 45_000 }));
  if (!client) throw new Error('AI_CENTER_JEV_ENABLED=false，不调用 TypeSafe');
  const evaluator = createUsEquityFocusEvaluator({ client, definition, cache: fileCache(cachePath) });
  const pending = data.items.filter((item) => Object.values(item.focus?.answers || {}).some((row) => row.status !== 'success'));
  console.log(`retry ${pending.length}`);
  for (const item of pending) {
    const again = await evaluator.evaluate({ title: item.title, summary: item.summary });
    item.focus = again;
    addUsage(data.usage, again);
    const ok = Object.values(again.answers).filter((row) => row.status === 'success').length;
    console.log(`${ok}/8 ${item.id}`);
    if (fatal(again)) break;
  }
  data.usageNote = '失败项已补请求一次；成功项沿用缓存，不重复计费。';
  writeJson(resultsPath, data);
  writeFileSync(reportPath, render(data, readJson(reviewPath, {})));
  const counts = Object.fromEntries(definition.questions.map((question) => [question.id, data.items.filter((item) => focusHit(item.focus?.answers?.[question.id], definition.threshold)).length]));
  const still = data.items.filter((item) => Object.values(item.focus?.answers || {}).some((row) => row.status !== 'success')).length;
  console.log(JSON.stringify({ requests: data.usage.requests, inputTokens: data.usage.inputTokens, outputTokens: data.usage.outputTokens, counts, stillFailed: still }, null, 2));
}

async function main() {
  if (process.argv.includes('--retry-failed')) {
    await retryFailed();
    return;
  }
  if (renderOnly) {
    const data = readJson(resultsPath, null);
    if (!data) throw new Error('还没有结果文件');
    writeFileSync(reportPath, render(data, readJson(reviewPath, {})));
    console.log(reportPath);
    return;
  }
  loadInstanceEnvironment({ repositoryRoot: root });
  const config = resolveInstanceConfig({ repositoryRoot: root });
  const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
  const window = chooseWindow(db, Date.now());
  if (!window) throw new Error('没有已结束的日报窗口');
  const pool = loadCandidates(db, window);
  db.close();
  const sample = stratifySample(pool.kept, { limit, seed: `us-equity-focus:${window.startAt}` });
  const tagSample = stratifySample(sample.selected, { limit: tagLimit, seed: `us-equity-tags:${window.startAt}` });
  const catalog = loadTagCatalog(readFileSync(path.join(root, 'config', 'tags.json'), 'utf8'));
  const definition = loadUsEquityFocus(readFileSync(path.join(root, 'config', 'research', 'us-equity-daily-focus.json'), 'utf8'));
  const newTagIds = ['macro_rates', 'macro_credit', 'fx', 'corporate_results', 'corporate_financing', 'geopolitics_conflict', 'geopolitics_diplomacy', 'geopolitics_trade'];
  console.log(`window ${new Date(window.startAt).toISOString()} pool=${pool.kept.length} excluded=${pool.excluded} selected=${sample.selected.length}`);
  let tagging = null;
  let taggingError = '';
  try {
    tagging = tagSample.selected.length ? await classifySample(tagSample.selected, catalog) : null;
    console.log(`tags saved=${tagging?.rows.length || 0} missing=${tagging?.missingItemIds.length || 0}`);
  } catch (error) {
    taggingError = String(error?.message || error);
    console.log(`tags failed ${taggingError}`);
  }
  const client = openJevClient(process.env, undefined, (options) => createTypeSafeSystemOneClient({ ...options, timeoutMs: 45_000 }));
  if (!client?.available()) throw new Error('未配置 JEV 凭证，不使用模拟分数');
  const evaluator = createUsEquityFocusEvaluator({ client, definition, cache: fileCache(cachePath) });
  const started = Date.now();
  const run = await scoreAll(evaluator, sample.selected);
  const usage = blankUsage();
  for (const item of run.scored) addUsage(usage, item.focus);
  const data = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    limit,
    window: { ...window, label: `${shanghai.format(window.startAt)} 至 ${shanghai.format(window.endAt)}（上海）${window.published ? '，日报已发布' : '，窗口已结束但日报未发布'}` },
    sample: { scanned: pool.scanned, qualityExcluded: pool.excluded, pool: pool.kept.length, selected: sample.selected.length, uncovered: sample.uncovered, strata: sample.strata },
    definition: { version: definition.version, threshold: definition.threshold, questions: definition.questions },
    catalog: catalog.tags.map((tag) => ({ id: tag.id, name: tag.name, parent_id: tag.parent_id, description: tag.description || '' })),
    newTagIds,
    tagging,
    taggingError,
    tagSample: tagSample.selected.map((item) => ({ id: item.id, title: item.title })),
    usage,
    stopReason: run.stopReason,
    items: run.scored,
  };
  writeJson(resultsPath, data);
  writeFileSync(reportPath, render(data, readJson(reviewPath, {})));
  const counts = Object.fromEntries(definition.questions.map((question) => [question.id, data.items.filter((item) => focusHit(item.focus?.answers?.[question.id], definition.threshold)).length]));
  console.log(JSON.stringify({ selected: data.items.length, requests: usage.requests, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, counts, stopReason: run.stopReason, reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
