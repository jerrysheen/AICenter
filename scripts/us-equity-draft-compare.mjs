import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createElucidGrokAgentClient } from '../packages/connectors/src/elucid-grok-agent.js';
import { resolveHarnessLlm } from '../packages/harness/src/llm-route.js';
import { loadInstanceEnvironment, resolveInstanceConfig } from '../packages/instance/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'data', 'experiments', 'us-equity-focus-v1-1', 'results.json');
const v1Path = path.join(root, 'data', 'experiments', 'us-equity-focus-v1', 'results.json');
const outputDir = path.join(root, 'data', 'experiments', 'us-equity-draft-compare-v1');
const WINDOW_END = 1791417600000;
const INDEXES = ['^GSPC', '^DJI', '^IXIC', '^SOX', '^VIX'];

function clip(value, max = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function loadQuotes(db) {
  const rows = db.prepare(`SELECT i.canonical_symbol AS symbol, i.name AS name, q.price, q.previous_close,
      q.currency, q.market_time, q.provider_id, q.quality
    FROM quote_snapshots q JOIN instruments i ON i.id = q.instrument_id
    WHERE i.canonical_symbol IN (${INDEXES.map(() => '?').join(',')})
      AND q.market_time IS NOT NULL AND q.market_time <= ?
    ORDER BY q.market_time DESC`).all(...INDEXES, WINDOW_END + 6 * 3600000);
  const picked = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.symbol)) continue;
    if (row.market_time < WINDOW_END - 7 * 86400000) continue;
    seen.add(row.symbol);
    picked.push(row);
  }
  return picked;
}

function line(item, index, tags, hints) {
  const hits = hints ? ['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'].flatMap((id) => {
    const row = item.focus?.answers?.[id];
    return row?.status === 'success' && row.score >= 0.5 ? [`${id}:${Number(row.score).toFixed(2)}`] : [];
  }).join(' ') : '';
  return `n${index} | ${tags.column} | ${tags.gemini} | ${clip(item.title, 48)}${hits ? ` | ${hits}` : ''}`;
}

function tagOf(item, names, gemini) {
  const column = names[item.columnTag] || item.columnTag || '空';
  const fresh = gemini.get(item.id);
  return { column, gemini: fresh ? fresh.join('、') || '无' : '未测' };
}

const selectRules = `你在为美股日报挑选材料。这不是正式刊。材料是当天约 1491 条里抽出的 150 条，不能当成全天覆盖。
只选出最多 8 条真正值得写进美股日报的消息。预测、目标价和技术教学不要选。每条用一行：材料 id，然后一句话说明为什么选它。不要写正文。`;

function marketText(quotes) {
  return quotes.length
    ? quotes.map((row) => `${row.name} ${row.symbol} 价格 ${row.price} 前收 ${row.previous_close ?? '无'} ${row.currency} 时间 ${new Date(row.market_time).toISOString()} 来源 ${row.provider_id} 质量 ${row.quality}`).join('\n')
    : '本窗口没有可用的美股指数快照。不要用新闻凑出指数点位。';
}

function selectPrompt(arm, items, quotes, names, gemini) {
  const hint = arm === 'B'
    ? '行末出现的 Q 分数表示达到 0.5。它只是提示，不是必须采用，也不是重要性。没有分数不代表没有这件事。指数点位以行情快照为准，Q0 不能代替快照。'
    : '本轮没有关注分数。请自己从这些标题里决定美股日报值得写什么。指数点位只能源自行情快照。';
  return `${hint}\n\n行情快照\n${marketText(quotes)}\n\n材料\n${items.map((item, index) => line(item, index + 1, tagOf(item, names, gemini), arm === 'B')).join('\n')}`;
}

function writePrompt(arm, chosen, quotes) {
  return `根据已经选定的材料写一份短草稿。这不是正式刊，材料也不是全天覆盖。
指数点位只能源自行情快照。消息里的涨跌要写成“该消息如此说”。预测不要写成事实。不要写交易指令。事实后面注明材料编号。全文控制在 700 字内。
${arm === 'B' ? '关注分数只帮助选材，不能把分数写成事件本身。' : '本稿没有使用关注分数。'}

行情快照
${marketText(quotes)}

选定材料
${chosen.map((item) => `${item.label} | ${clip(item.title, 80)} | ${clip(item.summary, 360)}`).join('\n')}`;
}

async function complete(llm, system, user) {
  const started = Date.now();
  if (llm.protocol === 'openai-responses') {
    const observed = [];
    const client = createElucidGrokAgentClient({
      model: llm.model,
      apiKey: llm.apiKey,
      apiRoot: llm.baseURL,
      timeoutMs: 420000,
      usageObserver: async (row) => observed.push(row),
    });
    const result = await client.respond({
      systemInstruction: system,
      contents: [{ role: 'user', parts: [{ text: user }] }],
      tools: [],
      timeoutMs: 420000,
    });
    const usage = observed.at(-1)?.usage || {};
    return {
      text: result.text,
      model: result.modelId || llm.model,
      provider: llm.provider,
      elapsedMs: Date.now() - started,
      usage: { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null },
    };
  }
  if (llm.protocol === 'google-generative-ai') {
    const response = await fetch(`${llm.baseURL}/models/${encodeURIComponent(llm.model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': llm.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] }),
      signal: AbortSignal.timeout(480000),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`日报模型失败（${response.status}）`);
    const text = (payload.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('');
    const usage = payload.usageMetadata || {};
    return { text, model: llm.model, provider: llm.provider, elapsedMs: Date.now() - started, usage: { inputTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount ?? null } };
  }
  const response = await fetch(`${llm.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${llm.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: llm.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(480000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`日报模型失败（${response.status}）`);
  return { text: payload.choices?.[0]?.message?.content || '', model: payload.model || llm.model, provider: llm.provider, elapsedMs: Date.now() - started, usage: { inputTokens: payload.usage?.prompt_tokens ?? null, outputTokens: payload.usage?.completion_tokens ?? null } };
}

function cited(text, ids) {
  return [...ids].filter((id) => text.includes(id));
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

loadInstanceEnvironment({ repositoryRoot: root });
const llm = resolveHarnessLlm(process.env);
if (!llm.apiKey) throw new Error('未配置日报模型凭证');
const config = resolveInstanceConfig({ repositoryRoot: root });
const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
const quotes = loadQuotes(db);
db.close();
const current = JSON.parse(readFileSync(sourcePath, 'utf8'));
const previous = JSON.parse(readFileSync(v1Path, 'utf8'));
const names = Object.fromEntries(current.catalog.map((tag) => [tag.id, tag.name]));
const gemini = new Map();
for (const row of previous.tagging?.rows || []) gemini.set(row.id, (row.tags || []).map((id) => names[id] || id));
for (const row of current.tagProbe?.rows || []) gemini.set(row.id, (row.tags || []).map((id) => names[id] || id));
const items = current.items;
const ids = new Set(items.map((item) => item.id));
mkdirSync(outputDir, { recursive: true });
const drafts = {};
for (const arm of ['A', 'B']) {
  const selectionInput = selectPrompt(arm, items, quotes, names, gemini);
  console.log(`select ${arm} chars=${selectionInput.length}`);
  const selection = await complete(llm, selectRules, selectionInput);
  console.log(`${arm} select in=${selection.usage.inputTokens} out=${selection.usage.outputTokens} ms=${selection.elapsedMs}`);
  const chosen = [...selection.text.matchAll(/\bn(\d+)\b/g)].map((match) => {
    const item = items[Number(match[1]) - 1];
    return item ? { ...item, label: `n${match[1]}` } : null;
  }).filter(Boolean).slice(0, 8);
  const writingInput = writePrompt(arm, chosen.length ? chosen : items.slice(0, 8).map((item, index) => ({ ...item, label: `n${index + 1}` })), quotes);
  const draft = await complete(llm, '按给定材料写美股日报短稿。', writingInput);
  console.log(`${arm} draft in=${draft.usage.inputTokens} out=${draft.usage.outputTokens} ms=${draft.elapsedMs}`);
  drafts[arm] = { selection, draft, cited: chosen.map((item) => item.id) };
}
function pack(arm) {
  const row = drafts[arm];
  return {
    selection: row.selection,
    draft: row.draft,
    selectedIds: row.cited,
    draftCitedIds: cited(row.draft.text, ids),
  };
}
const result = {
  generatedAt: new Date().toISOString(),
  sample: { used: items.length, pool: 1491, note: '150 条是分层样本，不是 1491 条的完整覆盖。' },
  model: { provider: llm.provider, requested: llm.model, a: drafts.A.draft.model, b: drafts.B.draft.model },
  quotes,
  jev: { requests: 150, inputTokens: 239943, outputTokens: 10800, note: '这是生成这批 V1.1 提示的四题重评开销，不含更早的八题首轮。' },
  drafts: { A: pack('A'), B: pack('B') },
};
writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify(result, null, 2));
const usageLine = (arm) => {
  const row = result.drafts[arm];
  const input = [row.selection.usage.inputTokens, row.draft.usage.inputTokens].filter((value) => value != null);
  const output = [row.selection.usage.outputTokens, row.draft.usage.outputTokens].filter((value) => value != null);
  return `${arm} 选材+成稿输入 ${input.length ? input.reduce((sum, value) => sum + value, 0) : '未知'}，输出 ${output.length ? output.reduce((sum, value) => sum + value, 0) : '未知'}`;
};
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>美股日报选材对照</title>
<style>body{font-family:"Segoe UI",sans-serif;max-width:980px;margin:32px auto;padding:0 16px;line-height:1.55;color:#1c1917}
pre{white-space:pre-wrap;background:#fafaf9;padding:12px 16px} .note{background:#f5f5f4;padding:12px 16px}</style></head><body>
<h1>同一批 150 条的离线日报对照</h1>
<div class="note"><p>A 组没有 JEV 分数。B 组有 Q0 到 Q7 的分数，仍可阅读未命中材料。两组先从 150 条里各选最多 8 条，再按选定材料写短稿。指数快照两组相同。正式日报没有改写。</p>
<p>模型 ${esc(result.model.provider)} / ${esc(result.model.a)}。${esc(usageLine('A'))}。${esc(usageLine('B'))}。JEV 提示本身是 150 次请求、输入 239943、输出 10800。没有可核实单价。</p>
<p>行情快照 ${quotes.length ? quotes.map((row) => `${esc(row.symbol)} ${row.price}`).join('，') : '没有可用指数快照'}。</p></div>
<h2>A 组选材</h2><pre>${esc(drafts.A.selection.text)}</pre>
<h2>A 组草稿</h2><pre>${esc(drafts.A.draft.text)}</pre>
<h2>B 组选材</h2><pre>${esc(drafts.B.selection.text)}</pre>
<h2>B 组草稿</h2><pre>${esc(drafts.B.draft.text)}</pre>
</body></html>`;
writeFileSync(path.join(outputDir, 'report.html'), html);
console.log(path.join(outputDir, 'report.html'));
