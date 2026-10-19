import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGeminiTagPort } from '../packages/connectors/src/gemini-tag.js';
import { createTypeSafeSystemOneClient } from '../packages/connectors/src/typesafe-system-one.js';
import { openJevClient } from '../packages/domain/src/jev-enabled.js';
import { loadTagCatalog } from '../packages/domain/src/tag-catalog.js';
import { TAG_PROMPT_VERSION } from '../packages/domain/src/tag-prompt.js';
import { createTaggingService } from '../packages/domain/src/tagging-service.js';
import { createUsEquityFocusEvaluator, focusHit, loadUsEquityFocus } from '../packages/domain/src/us-equity-focus.js';
import { loadInstanceEnvironment } from '../packages/instance/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const v1Path = path.join(root, 'data', 'experiments', 'us-equity-focus-v1', 'results.json');
const outputDir = path.join(root, 'data', 'experiments', 'us-equity-focus-v1-1');
const resultsPath = path.join(outputDir, 'results.json');
const reportPath = path.join(outputDir, 'report.html');
const cachePath = path.join(outputDir, 'cache.json');
const reviewPath = path.join(outputDir, 'review.json');
const modelPin = 'jev-1.13.0';
const rescoreIds = ['Q0', 'Q5', 'Q6', 'Q7'];
const reuseIds = ['Q1', 'Q2', 'Q3', 'Q4'];
const renderOnly = process.argv.includes('--render-only');

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}
function fileCache(file) {
  const entries = readJson(file, {});
  return {
    get(key) { return entries[key] || null; },
    set(key, value) { entries[key] = value; writeJson(file, entries); },
  };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function succeeded(item) {
  return reuseIds.every((id) => item.focus?.answers?.[id]?.status === 'success');
}
function blankUsage() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, inputKnown: 0, outputKnown: 0, cost: null, elapsedMs: 0 };
}
function addUsage(total, result) {
  if (!result?.requestCount) return;
  total.requests += result.requestCount;
  total.elapsedMs += result.elapsedMs || 0;
  if (Number.isFinite(result.usage?.inputTokens)) { total.inputTokens += result.usage.inputTokens; total.inputKnown += 1; }
  if (Number.isFinite(result.usage?.outputTokens)) { total.outputTokens += result.usage.outputTokens; total.outputKnown += 1; }
  if (Number.isFinite(result.usage?.cost)) total.cost = (total.cost || 0) + result.usage.cost;
}

async function scoreFour(evaluator, item) {
  let wait = 0;
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (wait) await sleep(wait);
    last = await evaluator.evaluate({ title: item.title, summary: item.summary, questionIds: rescoreIds });
    last.attempt = attempt;
    if (last.requestCount && last.model && last.model !== modelPin) {
      const error = new Error(`模型从 ${modelPin} 变成 ${last.model}`);
      error.code = 'MODEL_CHANGED';
      throw error;
    }
    if (last.errorStatus === 429 || last.errorStatus === 503) {
      wait = Math.min(30_000, 4_000 * attempt);
      console.log(`backoff ${last.errorStatus} attempt ${attempt} ${item.id}`);
      continue;
    }
    return last;
  }
  return last;
}

function mergeItem(item, fresh, supplement) {
  const answers = {};
  for (const id of reuseIds) {
    answers[id] = { ...item.focus.answers[id], reused: true, version: '2026-10-08.1' };
  }
  for (const id of rescoreIds) {
    answers[id] = fresh?.answers?.[id] || { questionId: id, status: 'failed', score: null, errorCode: 'not-run' };
  }
  return {
    id: item.id, sourceId: item.sourceId, title: item.title, summary: item.summary,
    stratum: item.stratum, columnTag: item.columnTag || '', eventAt: item.eventAt, sourceUrl: item.sourceUrl || '',
    v1: Object.fromEntries(rescoreIds.map((id) => [id, item.focus.answers[id]?.score ?? null])),
    focus: { model: fresh?.model || '', answers },
    supplement: supplement || null,
  };
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function scoreText(row) {
  return row?.status === 'success' && typeof row.score === 'number' ? Number(row.score).toFixed(2) : '失败';
}

function render(data, review = {}) {
  const names = new Map((data.catalog || []).map((tag) => [tag.id, tag.name]));
  const questions = data.definition.questions.filter((question) => rescoreIds.includes(question.id));
  const items = data.items || [];
  const section = (id) => {
    const v1Hits = items.filter((item) => (item.v1?.[id] ?? -1) >= 0.5);
    const nowHits = items.filter((item) => focusHit(item.focus.answers[id], 0.5));
    const v1Ids = new Set(v1Hits.map((item) => item.id));
    const nowIds = new Set(nowHits.map((item) => item.id));
    const dropped = v1Hits.filter((item) => !nowIds.has(item.id));
    const added = nowHits.filter((item) => !v1Ids.has(item.id));
    const row = (item) => `<li>${esc(item.title)} <span>V1 ${item.v1?.[id] ?? '无'} → V1.1 ${scoreText(item.focus.answers[id])}</span></li>`;
    return `<section><h3>${id}</h3>
      <p>V1 命中 ${v1Hits.length}，V1.1 命中 ${nowHits.length}。去掉 ${dropped.length}，新出现 ${added.length}。</p>
      <h4>V1.1 仍命中</h4><ul>${nowHits.map(row).join('') || '<li>无</li>'}</ul>
      <h4>被排除</h4><ul>${dropped.map(row).join('') || '<li>无</li>'}</ul>
      <h4>新出现</h4><ul>${added.map(row).join('') || '<li>无</li>'}</ul></section>`;
  };
  const tagRows = data.tagProbe?.rows || [];
  const oldTags = new Map((data.v1Tags || []).map((row) => [row.id, row.tags]));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>美股关注 V1.1</title>
<style>body{font-family:"Segoe UI",sans-serif;max-width:980px;margin:32px auto;padding:0 16px;line-height:1.5;color:#1c1917}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #e7e5e4;text-align:left;padding:6px;vertical-align:top}
.note{background:#fafaf9;padding:12px 16px} li span{color:#57534e}</style></head><body>
<h1>JEV 关注微调与 AI Tag 复核</h1>
<div class="note"><p>沿用 V1 冻结的 ${items.length} 条。只重评 Q0、Q5、Q6、Q7。Q1–Q4 复用原成功分数。模型固定 ${esc(modelPin)}。阈值仍是 0.5。</p>
<p>本轮请求 ${data.usage?.requests ?? 0} 次，耗时 ${Math.round((data.usage?.elapsedMs || 0) / 1000)} 秒。输入 token ${data.usage?.inputKnown ? data.usage.inputTokens : '未知'}，输出 token ${data.usage?.outputKnown ? data.usage.outputTokens : '未知'}。费用没有可核实单价。</p>
<p>${esc(data.note || '')}</p></div>
<h2>A. JEV 问题对比</h2>
${questions.map((question) => section(question.id)).join('')}
<h3>未改的四题</h3>
<p>Q1、Q2、Q3、Q4 使用 V1 成功分数，定义版本仍是 2026-10-08.1。</p>
<h2>B. AI Tag</h2>
<table><tr><th>标题</th><th>V1 Gemini</th><th>本轮 Gemini</th><th>旧信息树栏目</th></tr>
${(data.tagProbe?.sample || []).map((item) => {
    const old = (oldTags.get(item.id) || []).map((id) => names.get(id) || id).join('、') || (oldTags.has(item.id) ? '无' : '不在原50条');
    const now = tagRows.find((row) => row.id === item.id);
    return `<tr><td>${esc(item.title)}<br><small>${esc(item.reason || '')}</small></td><td>${esc(old)}</td><td>${now ? esc(now.tags.map((id) => names.get(id) || id).join('、') || '无') : '未测'}</td><td>${esc(names.get(item.columnTag) || item.columnTag || '空')}</td></tr>`;
  }).join('')}
</table>
<h2>C. 新标签候选</h2>
<ul>${(data.candidates || []).map((item) => `<li><strong>${esc(item.name)}</strong>（${esc(item.recommendation)}）：${esc(item.why)}</li>`).join('')}</ul>
${review.findings ? `<h2>复核</h2><div class="note">${review.findings.map((line) => `<p>${esc(line)}</p>`).join('')}</div>` : ''}
${review.purity ? `<h2>命中纯度</h2><table><tr><th>问题</th><th>V1命中</th><th>V1.1命中</th><th>正确</th><th>误命中</th><th>边界</th><th>纯度</th></tr>
${review.purity.map((row) => `<tr><td>${esc(row.id)}</td><td>${row.v1}</td><td>${row.v11}</td><td>${row.correct}</td><td>${row.wrong}</td><td>${row.unsure}</td><td>${esc(row.ratio)}</td></tr>`).join('')}
</table>` : ''}
</body></html>`;
}

function pickProbe(items, oldIds) {
  const wanted = [
    ['韩国KOSPI', '其他市场，检查会不会被打成美股'],
    ['越南证券', '旧信息树栏目是港股'],
    ['备兑看涨', '交易方法，现有标签经常是空的'],
    ['移动平均线', '交易方法，旧栏目是美股'],
    ['Strata', '上一轮误标为企业经营与财报'],
    ['Floorplan', '三维装修是否被打成图形引擎'],
    ['傅里叶变换', '非模型算法是否进入模型与算法'],
    ['节后开盘前全球金融', '美债收益率，上一轮 Gemini 为空'],
    ['纽约联储', '已有宏观，检查利率标签'],
    ['美股医疗保健', '美股正例'],
    ['欧元/美元', '外汇正例'],
    ['美元指数', '外汇正例'],
    ['派拉蒙', '并购，应保持企业融资'],
    ['泛欧交易所', '其他海外市场'],
    ['木鱼ETF', '一条里同时有美股和港股'],
    ['标普指数反弹', '预测行情，标签是否仍只给美股'],
    ['交易流程的核心要素', '交易方法'],
    ['法国据称将从储备', '大宗商品正例，不应扩成空泛宏观'],
  ];
  const chosen = [];
  const seen = new Set();
  for (const [needle, reason] of wanted) {
    const item = items.find((row) => `${row.title}${row.summary}`.includes(needle));
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    chosen.push({ ...item, reason });
  }
  for (const item of items) {
    if (chosen.length >= 30) break;
    if (seen.has(item.id) || !oldIds.has(item.id)) continue;
    const tags = oldIds.get(item.id);
    if (tags && tags.length) continue;
    seen.add(item.id);
    chosen.push({ ...item, reason: '原50条里的空标签' });
  }
  return chosen.slice(0, 30);
}

async function main() {
  if (renderOnly) {
    writeFileSync(reportPath, render(readJson(resultsPath, {}), readJson(reviewPath, {})));
    console.log(reportPath);
    return;
  }
  loadInstanceEnvironment({ repositoryRoot: root });
  const v1 = readJson(v1Path, null);
  if (!v1?.items?.length) throw new Error('找不到 V1 冻结结果');
  const definition = loadUsEquityFocus(readFileSync(path.join(root, 'config', 'research', 'us-equity-daily-focus.json'), 'utf8'));
  const client = openJevClient(process.env, undefined, (options) => createTypeSafeSystemOneClient({ ...options, timeoutMs: 45_000, model: modelPin }));
  if (!client?.available()) throw new Error('未配置 JEV 凭证');
  const evaluator = createUsEquityFocusEvaluator({ client, model: modelPin, definition, cache: fileCache(cachePath) });
  const ready = v1.items.filter(succeeded);
  const failedBefore = v1.items.filter((item) => !succeeded(item));
  const usage = blankUsage();
  const scored = [];
  console.log(`rescore ${ready.length}, keep-failed ${failedBefore.length}`);
  for (const item of ready) {
    const fresh = await scoreFour(evaluator, item);
    addUsage(usage, fresh);
    scored.push(mergeItem(item, fresh, null));
    if (scored.length % 10 === 0) console.log(`scored ${scored.length}/${ready.length} requests=${usage.requests}`);
    await sleep(250);
  }
  const supplements = [];
  for (const item of failedBefore) {
    const fresh = await scoreFour(evaluator, item);
    addUsage(usage, fresh);
    const record = {
      id: item.id,
      title: item.title,
      v1Status: 'failed',
      attempts: fresh.attempt || 1,
      errorStatus: fresh.errorStatus,
      errorCode: fresh.errorCode,
      scores: Object.fromEntries(rescoreIds.map((id) => [id, fresh.answers?.[id]?.status === 'success' ? fresh.answers[id].score : null])),
    };
    supplements.push(record);
    const merged = mergeItem(item, fresh, record);
    for (const id of reuseIds) merged.focus.answers[id] = { ...item.focus.answers[id], reused: true, keptFailure: true };
    scored.push(merged);
    console.log(`supplement ${item.title} attempts=${record.attempts}`);
  }
  const catalog = loadTagCatalog(readFileSync(path.join(root, 'config', 'tags.json'), 'utf8'));
  const oldTagMap = new Map((v1.tagging?.rows || []).map((row) => [row.id, row.tags]));
  const probe = pickProbe(scored, oldTagMap);
  let tagRows = [];
  let tagError = '';
  try {
    const service = createTaggingService({ catalog, taggingPort: createGeminiTagPort() });
    const tagged = await service.analyzeItems({
      workspaceId: 'local',
      resourceType: 'content-item',
      items: probe.map((item) => ({ id: item.id, title: item.title, summary: item.summary })),
    });
    tagRows = (tagged.saved || []).map((row) => ({ id: row.resourceId, tags: row.tags || [], model: row.model || '', promptVersion: tagged.promptVersion || TAG_PROMPT_VERSION }));
    console.log(`tags ${tagRows.length}/${probe.length}`);
  } catch (error) {
    tagError = String(error?.message || error);
    console.log(`tags failed ${tagError}`);
  }
  const candidates = readJson(path.join(root, 'config', 'research', 'tag-candidates.json'), {}).candidates || [];
  const data = {
    generatedAt: new Date().toISOString(),
    modelPin,
    definition: { version: definition.version, threshold: definition.threshold, questions: definition.questions.map(({ history, ...question }) => question) },
    usage,
    note: `V1 已成功的 ${ready.length} 条只重评四题。原先失败的 ${failedBefore.length} 条保留失败记录，并单独补测四题。`,
    catalog: catalog.tags.map((tag) => ({ id: tag.id, name: tag.name, description: tag.description || '' })),
    v1Tags: v1.tagging?.rows || [],
    tagProbe: { sample: probe.map((item) => ({ id: item.id, title: item.title, reason: item.reason, columnTag: item.columnTag })), rows: tagRows, error: tagError },
    candidates,
    supplements,
    items: scored,
  };
  writeJson(resultsPath, data);
  writeFileSync(reportPath, render(data, readJson(reviewPath, {})));
  const counts = Object.fromEntries(rescoreIds.map((id) => [id, scored.filter((item) => focusHit(item.focus.answers[id], 0.5)).length]));
  console.log(JSON.stringify({ requests: usage.requests, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, counts, reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
