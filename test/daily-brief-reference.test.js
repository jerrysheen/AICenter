import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReferenceInputSchema } from '../packages/contracts/src/agent.js';
import { createAiCenterServer } from '../apps/web/src/server.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';
import { createStore } from '../packages/database/src/index.js';
import { createAgentJobHandlers } from '../packages/runtime/src/agent-module.js';
import { projectAnswerSourceFooter } from '../packages/domain/src/answer-source-footer.js';

const generatedAt = Date.UTC(2026, 9, 2, 0);
const types = ['news', 'official-release', 'upcoming-event', 'market', 'strategy', 'strategy-transition'];
const reference = (date = '2026-10-02', candidateId = 'news:sample', revision = generatedAt) => ({
  resourceType: 'daily-brief-item', resourceId: `${date}/${candidateId}`, revision,
});

function saveBrief(app, { date = '2026-10-02', workspaceId = 'local', at = generatedAt, reversed = false, candidateId } = {}) {
  const board = (key) => ({ board: key, mode: 'unavailable', fetchedAt: null, asOf: null, indices: [], note: '' });
  const report = app.store.repositories.report.upsertDailyReport({
    workspaceId, reportDate: date, status: 'ready', sourceRefs: [],
    content: {
      reportDate: date, timezone: 'Asia/Shanghai', generatedAt: at,
      window: { startAt: at - 86_400_000, endAt: at },
      upcomingWindow: { startAt: at, endAt: at + 86_400_000 },
      news: [], officialReleases: [], upcoming: [],
      market: { cn: board('cn'), global: board('global') }, warnings: [],
    },
  });
  const candidates = types.map((type) => ({
    id: type === 'news' && candidateId ? candidateId : `${type}:sample`, type, occurredAt: at - 1,
    title: `${type} 的原始候选标题`, summary: `${type} 的候选事实摘要`,
    sourceRefs: [{ type: 'content-item', id: `${type}-original`, at: at - 1 }],
    data: type === 'market' ? { symbol: 'TEST', changePct: 0.02 } : {},
  }));
  const items = candidates.map((candidate) => ({
    candidateId: candidate.id, type: candidate.type, occurredAt: candidate.occurredAt,
    headline: `${date} ${candidate.type} 观点`, whyItMatters: '解释该变化为什么值得关注。',
    watchNext: '继续观察公开数据。', sourceRefs: candidate.sourceRefs,
  }));
  return app.store.repositories.report.upsertDailyBrief({
    workspaceId, reportId: report.id, reportDate: date, status: 'ready',
    sourceReportUpdatedAt: report.updatedAt, inputHash: 'test',
    inputSnapshot: { candidates }, providerId: 'private-provider', modelId: 'private-model',
    brief: {
      id: `brief-${workspaceId}-${date}`, reportId: report.id, reportDate: date, generatedAt: at,
      overview: '今天看这些。', items: reversed ? items.reverse() : items,
      providerId: 'private-provider', modelId: 'private-model', sourceReportUpdatedAt: report.updatedAt,
    },
  });
}

async function withApp(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-brief-ref-'));
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory });
  try { await run(app); }
  finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('daily brief references require a date, candidate id and generation version', () => {
  assert.equal(ReferenceInputSchema.safeParse(reference()).success, true);
  assert.equal(ReferenceInputSchema.safeParse({ ...reference(), revision: undefined }).success, false);
  assert.equal(ReferenceInputSchema.safeParse({ ...reference(), resourceId: 'row-0' }).success, false);
  assert.equal(ReferenceInputSchema.safeParse(reference('2026-10-02', 'x'.repeat(256))).success, true);
  assert.equal(ReferenceInputSchema.safeParse(reference('2026-10-02', 'x'.repeat(257))).success, false);
  assert.equal(ReferenceInputSchema.safeParse({ resourceType: 'post', resourceId: 'x'.repeat(257) }).success, false);
  assert.equal(ReferenceInputSchema.safeParse({ ...reference(), headline: '客户端伪造正文' }).success, false);
});

test('all six brief viewpoint types resolve through saved candidates and keep dates separate', async () => {
  await withApp(async (app) => {
    saveBrief(app);
    saveBrief(app, { date: '2026-10-01', reversed: true });
    const refs = types.map((type) => reference('2026-10-02', `${type}:sample`));
    const resolved = await app.services.context.resolveReferences({ workspaceId: 'local', references: [...refs, refs[0]] });
    assert.equal(resolved.items.length, 6);
    assert.equal(resolved.missing.length, 0);
    assert.equal(resolved.refs[0].origin, 'selected');
    assert.equal(resolved.refs[0].revision, generatedAt);
    assert.match(resolved.promptText, /模型筛选观点，不是新增事实或原始消息/);
    assert.match(resolved.promptText, /候选事实摘要/);
    assert.match(resolved.promptText, /为什么值得看/);
    assert.match(resolved.promptText, /接着看/);
    assert.match(resolved.promptText, /"changePct":0.02/);
    assert.doesNotMatch(resolved.promptText, /private-provider|private-model/);
    const earlier = await app.services.context.resolveReferences({ workspaceId: 'local', references: [reference('2026-10-01')] });
    assert.equal(earlier.items.length, 1);
    assert.match(earlier.items[0].content, /2026-10-01 news 观点/);
    assert.doesNotMatch(earlier.items[0].content, /2026-10-02 news 观点/);
    const isolated = await app.services.context.resolveReferences({ workspaceId: 'other', references: [reference()] });
    assert.equal(isolated.items.length, 0);
    assert.equal(isolated.missing.length, 1);
    const absent = await app.services.context.resolveReferences({ workspaceId: 'local', references: [reference('2026-10-02', 'missing')] });
    assert.equal(absent.missing.length, 1);
  });
});

test('regenerated brief does not substitute a new viewpoint for an old selected reference', async () => {
  await withApp(async (app) => {
    saveBrief(app);
    saveBrief(app, { at: generatedAt + 1, reversed: true });
    const resolved = await app.services.context.resolveReferences({ workspaceId: 'local', references: [reference()] });
    assert.equal(resolved.items.length, 0);
    assert.equal(resolved.missing.length, 1);
    assert.match(resolved.promptText, /不得猜测缺失观点/);
    const latest = await app.services.context.resolveReferences({ workspaceId: 'local', references: [reference('2026-10-02', 'news:sample', generatedAt + 1)] });
    assert.equal(latest.items.length, 1);
  });
});

test('existing context pack endpoint exports a selected brief viewpoint and rejects forged payload fields', async () => {
  await withApp(async (app) => {
    saveBrief(app);
    const address = await app.listen();
    const response = await fetch(`${address.localUrl}/api/v1/context/pack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ references: [reference()] }),
    });
    assert.equal(response.status, 200);
    const { pack } = await response.json();
    assert.equal(pack.itemCount, 1);
    assert.equal(pack.items[0].typeLabel, '日报观点');
    assert.equal(pack.items[0].revision, generatedAt);
    assert.match(pack.markdown, /2026-10-02 news 观点/);
    assert.match(pack.markdown, /news 的候选事实摘要/);
    const forged = await fetch(`${address.localUrl}/api/v1/context/pack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ references: [{ ...reference(), content: '伪造内容' }] }),
    });
    assert.equal(forged.status, 400);
  });
});

test('selected brief reaches AI context and persists as a clickable source in the session', async () => {
  await withApp(async (app) => {
    saveBrief(app);
    let received;
    const handlers = createAgentJobHandlers({
      contextService: app.services.context,
      knowledgeService: app.services.knowledge,
      agentRuntime: { async run(input) {
        received = input;
        return { answer: '围绕引用观点展开讨论。', providerId: 'fake', modelId: 'fake', refs: [], toolCalls: [] };
      } },
    });
    const result = await handlers['ai.agent.run']({
      message: '这条观点的依据充分吗？', references: [reference()], webMode: 'off',
    }, { job: { id: 'job-brief-ref', workspaceId: 'local' } });
    assert.match(received.selectedContext, /news 的候选事实摘要/);
    assert.match(received.selectedContext, /解释该变化为什么值得关注/);
    const exchange = app.services.knowledge.getAiSession('local', result.sessionId).exchanges[0];
    const source = exchange.sourceFooter.groups.find((group) => group.id === 'report').items[0];
    assert.equal(source.resourceId, reference().resourceId);
    assert.equal(source.revision, generatedAt);
    assert.equal(source.selected, true);
    assert.equal(source.resourceType, 'daily-brief-item');
  });
});

test('brief source footer keeps different generation versions distinct', () => {
  const footer = projectAnswerSourceFooter([
    { ...reference(), origin: 'selected', label: '第一版' },
    { ...reference('2026-10-02', 'news:sample', generatedAt + 1), origin: 'selected', label: '第二版' },
  ]);
  assert.equal(footer.total, 2);
  assert.equal(footer.groups[0].label, '日报');
});

test('worker resolves and persists a brief reference with the maximum candidate id length', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-brief-worker-'));
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory });
  const candidateId = `news:${'x'.repeat(251)}`;
  saveBrief(app, { candidateId });
  let seen;
  const worker = createAiCenterWorker({
    store: createStore(path.join(directory, 'ai-center.db')),
    enableDefaultSchedules: false,
    agentClient: { async respond({ contents }) {
      seen = contents.at(-1).parts[0].text;
      return { text: '依据日报观点回答。', providerId: 'fake', modelId: 'fake', warnings: [] };
    } },
  });
  try {
    const selected = reference('2026-10-02', candidateId);
    const job = app.store.createJob({
      type: 'ai.agent.run', maxAttempts: 1,
      input: { message: '解释这条日报观点', webMode: 'off', references: [selected] },
    });
    const completed = await worker.runner.runOnce();
    assert.equal(completed.id, job.id);
    assert.equal(completed.status, 'completed');
    assert.match(seen, /news 的候选事实摘要/);
    const exchange = app.services.knowledge.getAiSession('local', completed.output.sessionId).exchanges[0];
    assert.equal(exchange.refs[0].resourceId.length, 267);
    assert.equal(exchange.sourceFooter.groups[0].items[0].resourceId, selected.resourceId);
    assert.equal(exchange.sourceFooter.groups[0].items[0].revision, generatedAt);
    assert.equal(app.services.knowledge.listSessionTurns('local', completed.output.sessionId)[0].selectedRefs[0].resourceId, selected.resourceId);
  } finally {
    await worker.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
