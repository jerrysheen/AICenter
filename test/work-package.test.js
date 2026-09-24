import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiCenterServer } from '../apps/web/src/server.js';
import {
  parseClaimWorkPackageInput,
  parseContinueWorkPackageInput,
  parseCreateWorkPackageInput,
  parseWorkPackageListQuery,
  parseWorkPackageTrace,
  parseWorkPackageTraceStep,
  projectWorkPackageTimeline,
  parseWorkerJobConcurrency,
  ValidationError,
} from '../packages/contracts/src/index.js';
import { buildContinuedWorkPackageBody, parseContinuedWorkPackageBody } from '../packages/domain/src/knowledge-service.js';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';
import {
  buildCursorAgentArgs,
  buildCursorSessionPrompt,
  createCursorAgentSpawnOptions,
  createCursorSessionPort,
  resolveVisibleCursorAgentLaunch,
  requestLauncherRestart,
  resolveCursorAgentBin,
  resolveCursorAgentLaunch,
  restartRequestPath,
  workPackageTraceId,
} from '../packages/connectors/src/index.js';
import { createKnowledgeService } from '../packages/domain/src/knowledge-service.js';
import { classifyProcessRestart } from '../packages/domain/src/process-restart.js';
import { createWorkPackageJobHandlers } from '../packages/runtime/src/work-package-module.js';
import { createWorkPackageTracePort } from '../packages/runtime/src/work-package-trace.js';
import { decodeWorkPackageStepLine, workPackageStepTextLooksGarbled } from '../packages/runtime/src/work-package-step-text.js';

function temporaryStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-work-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    directory,
    store,
    remove() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('work package steps project to the same run timeline as Ask', () => {
  const timeline = projectWorkPackageTimeline([
    { at: 1, step: 'claim', status: 'done', summary: 'Worker 已领取并写好提示词', paths: [] },
    { at: 2, step: 'plan', status: 'started', summary: '正在拆步骤', paths: [] },
  ], { live: true });
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].status, 'done');
  assert.equal(timeline[0].label, 'Worker 已领取并写好提示词');
  assert.equal(timeline[1].status, 'active');
  assert.equal(timeline[1].event, 'work.plan');
  const parsed = parseWorkPackageTrace({
    hashId: '2f3e9d797b18',
    workPackageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    steps: [
      { at: 1, step: 'claim', status: 'done', summary: '已领取', paths: [] },
    ],
    progress: { status: 'claimed', summary: '执行中', updatedAt: 1 },
  });
  assert.equal(parsed.timeline[0].label, '已领取');
  assert.equal(parsed.timeline[0].status, 'done');
});

test('work package contract trims body and defaults claim actor', () => {
  assert.deepEqual(parseCreateWorkPackageInput({
    body: '  信息流筛选按钮错位  ',
    sourceUrl: 'https://example.com/bug',
  }), {
    title: '',
    body: '信息流筛选按钮错位',
    parentWorkPackageId: '',
    sourceUrl: 'https://example.com/bug',
    sourceTitle: '',
    captureChannel: 'web',
    sourceApp: '',
    clientMutationId: '',
    attachmentIds: [],
  });
  assert.equal(parseClaimWorkPackageInput({}).claimedBy, 'cursor-session');
  assert.equal(parseWorkPackageListQuery({}).status, 'active');
  assert.equal(parseContinueWorkPackageInput({ body: '  再改一下底栏  ' }).body, '再改一下底栏');
  assert.throws(() => parseCreateWorkPackageInput({ body: '' }), ValidationError);
  assert.throws(() => parseContinueWorkPackageInput({ body: '   ' }), ValidationError);
});

test('restart classifier only asks for process bounce when server code changes', () => {
  assert.deepEqual(classifyProcessRestart([
    'apps/web/public/app.js',
    'apps/web/public/styles.css',
    'docs/progress/2026-09-19-work-package-inbox.md',
  ]), {
    required: false,
    scope: 'none',
    reasons: [],
    restartRequired: 'not_required',
  });
  const webOnly = classifyProcessRestart(['apps/web/src/routes/knowledge-routes.js']);
  assert.equal(webOnly.required, true);
  assert.equal(webOnly.scope, 'web');
  const both = classifyProcessRestart([
    'packages/domain/src/knowledge-service.js',
    'apps/web/public/index.html',
  ]);
  assert.equal(both.scope, 'both');
  assert.equal(both.required, true);
});

test('knowledge service creates, claims and completes a work package', () => {
  const temporary = temporaryStore();
  try {
    const knowledge = createKnowledgeService({
      legacyRepository: temporary.store,
      knowledgeRepository: temporary.store.repositories.knowledge,
    });
    const created = knowledge.createWorkPackage({
      body: '灵感列表展开后标题被截断',
      clientMutationId: 'phone-1',
    });
    assert.equal(created.status, 'open');
    assert.match(created.hashId, /^[0-9a-f]{12}$/);
    assert.equal(created.hashId, workPackageTraceId(created.id));
    assert.equal(created.note.body, '灵感列表展开后标题被截断');
    assert.equal(knowledge.createWorkPackage({
      body: '重复投递',
      clientMutationId: 'phone-1',
    }).id, created.id);
    assert.equal(knowledge.listWorkPackages('local', 'open').length, 1);
    assert.equal(knowledge.listInspirations('inbox').some((note) => note.id === created.note.id), false);
    assert.equal(knowledge.notifyWorkPackages('local', { id: created.id }).openCount, 1);

    const claimed = knowledge.claimWorkPackage('local', { claimedBy: 'cursor-local', leaseMs: 1_800_000 });
    assert.equal(claimed.id, created.id);
    assert.equal(claimed.status, 'claimed');
    assert.throws(
      () => knowledge.claimWorkPackage('local', { claimedBy: 'other', leaseMs: 1_800_000 }),
      ValidationError,
    );

    const completed = knowledge.completeWorkPackage('local', claimed.id, {
      claimedBy: 'cursor-local',
      resultSummary: '已加宽标题容器',
      changedPaths: ['apps/web/public/styles.css'],
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.restartRequired, 'not_required');
    assert.equal(completed.restart.required, false);
    assert.equal(knowledge.listWorkPackages('local', 'open').length, 0);
    assert.match(buildContinuedWorkPackageBody(completed, '再加宽一点'), /上一任务：/);
    assert.match(buildContinuedWorkPackageBody(completed, '再加宽一点'), /上一目标：/);
    assert.match(buildContinuedWorkPackageBody(completed, '再加宽一点'), /上一步骤：/);
    assert.match(buildContinuedWorkPackageBody(completed, '再加宽一点'), /继续指令：\n再加宽一点/);
    const parsed = parseContinuedWorkPackageBody(buildContinuedWorkPackageBody(completed, '再加宽一点'));
    assert.equal(parsed.continued, true);
    assert.equal(parsed.instruction, '再加宽一点');
    assert.equal(parsed.result, '已加宽标题容器');
    assert.match(parsed.previous, /灵感列表展开后标题被截断/);
    assert.match(parsed.goal, /灵感列表展开后标题被截断/);
    assert.match(parsed.progress, /completed/);
  } finally {
    temporary.remove();
  }
});

test('schema v26 keeps attachment tables and parent session column', () => {
  const temporary = temporaryStore();
  try {
    assert.equal(temporary.store.getRuntimeStatus().schemaVersion, latestSchemaVersion());
    assert.equal(latestSchemaVersion(), 32);
    assert.deepEqual(temporary.store.repositories.knowledge.listWorkPackages('local', 'all'), []);
  } finally {
    temporary.remove();
  }
});

test('HTTP allows paired phones to submit work packages and only desktop can claim', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-work-http-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    runtimeDirectory: directory,
    publicUrl: 'https://center.example.com',
  });
  const address = await app.listen();
  const publicHeaders = { Host: 'center.example.com', 'CF-Connecting-IP': '203.0.113.9' };
  try {
    const pairing = await fetch(`${address.localUrl}/api/v1/pairing`).then((response) => response.json());
    const publicCandidate = pairing.candidates.find((candidate) => candidate.scope === 'public');
    const pairToken = new URL(publicCandidate.webPairUrl).searchParams.get('pair');
    const pairResponse = await fetch(`${address.localUrl}/api/v1/pair`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairToken, deviceName: '工作包测试手机' }),
    });
    const cookie = pairResponse.headers.get('set-cookie').split(';')[0];

    const created = await fetch(`${address.localUrl}/api/v1/work-packages`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ body: '外网投递：底栏在小屏上被裁切' }),
    }).then((response) => response.json());
    assert.equal(created.ok, true);
    assert.equal(created.workPackage.status, 'open');
    assert.match(created.workPackage.hashId, /^[0-9a-f]{12}$/);
    const emptyTrace = await fetch(`${address.localUrl}/api/v1/work-packages/${created.workPackage.id}/trace`, {
      headers: { ...publicHeaders, Cookie: cookie },
    }).then((response) => response.json());
    assert.equal(emptyTrace.ok, true);
    assert.equal(emptyTrace.trace.hashId, created.workPackage.hashId);
    assert.equal(emptyTrace.trace.goal.objective, '外网投递：底栏在小屏上被裁切');
    assert.equal(emptyTrace.trace.progress.status, 'open');
    assert.deepEqual(emptyTrace.trace.steps, []);
    const inbox = await fetch(`${address.localUrl}/api/v1/notes?status=inbox`, {
      headers: { ...publicHeaders, Cookie: cookie },
    }).then((response) => response.json());
    assert.equal(inbox.notes.some((note) => note.id === created.workPackage.inspirationId), false);

    const notified = await fetch(`${address.localUrl}/api/v1/work-packages/notify`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ id: created.workPackage.id }),
    }).then((response) => response.json());
    assert.equal(notified.ok, true);
    assert.equal(notified.openCount, 1);
    assert.equal(notified.jobs?.[0]?.type, 'work-package.dispatch');

    const phoneClaim = await fetch(`${address.localUrl}/api/v1/work-packages/claim`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(phoneClaim.status, 403);

    const desktopClaim = await fetch(`${address.localUrl}/api/v1/work-packages/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimedBy: 'cursor-local' }),
    }).then((response) => response.json());
    assert.equal(desktopClaim.ok, true);
    assert.equal(desktopClaim.workPackage.id, created.workPackage.id);

    const completed = await fetch(`${address.localUrl}/api/v1/work-packages/${created.workPackage.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimedBy: 'cursor-local',
        resultSummary: '已调整底栏安全区',
        changedPaths: ['apps/web/src/server.js'],
      }),
    }).then((response) => response.json());
    assert.equal(completed.ok, true);
    assert.equal(completed.restart.required, true);
    assert.equal(completed.workPackage.restartRequired, 'required');
    assert.equal(existsSync(restartRequestPath(directory)), false);

    const phoneRestart = await fetch(`${address.localUrl}/api/v1/runtime/restart`, {
      method: 'POST',
      headers: { ...publicHeaders, Cookie: cookie },
    });
    assert.equal(phoneRestart.status, 202);
    const phoneRestartBody = await phoneRestart.json();
    assert.equal(phoneRestartBody.restart.requested, true);
    assert.equal(existsSync(restartRequestPath(directory)), true);

    const retried = await fetch(`${address.localUrl}/api/v1/work-packages/${created.workPackage.id}/retry`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    }).then((response) => response.json());
    assert.equal(retried.ok, true);
    assert.equal(retried.workPackage.parentWorkPackageId, created.workPackage.id);
    assert.match(retried.workPackage.body, /继续指令：\n重新执行：/);
    assert.equal(retried.jobs?.[0]?.type, 'work-package.dispatch');

    const continued = await fetch(`${address.localUrl}/api/v1/work-packages/${created.workPackage.id}/continue`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ body: '安全区还要再让一点' }),
    }).then((response) => response.json());
    assert.equal(continued.ok, true);
    assert.equal(continued.workPackage.parentWorkPackageId, created.workPackage.id);
    assert.match(continued.workPackage.body, /上一任务：/);
    assert.match(continued.workPackage.body, /上一目标：/);
    assert.match(continued.workPackage.body, /上一进展：/);
    assert.match(continued.workPackage.body, /上一步骤：/);
    assert.match(continued.workPackage.body, /继续指令：\n安全区还要再让一点/);
    assert.equal(continued.jobs?.[0]?.type, 'work-package.dispatch');
    const continuedTrace = await fetch(`${address.localUrl}/api/v1/work-packages/${continued.workPackage.id}/trace`, {
      headers: { ...publicHeaders, Cookie: cookie },
    }).then((response) => response.json());
    assert.equal(continuedTrace.trace.goal.parentWorkPackageId, created.workPackage.id);
    assert.equal(continuedTrace.trace.goal.objective, '安全区还要再让一点');
    assert.equal(continuedTrace.trace.progress.status, 'open');
    assert.equal(continuedTrace.trace.parentTrace.workPackageId, created.workPackage.id);
    assert.equal(continuedTrace.trace.parentTrace.progress.status, 'completed');

    const anonymous = await fetch(`${address.localUrl}/api/v1/runtime/restart`, {
      method: 'POST',
      headers: publicHeaders,
    });
    assert.equal(anonymous.status, 401);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('work package hashId journal is written before CLI starts', () => {
  const temporary = temporaryStore();
  try {
    const created = { id: '11111111-1111-4111-8111-111111111111', title: '步骤账本' };
    const port = createWorkPackageTracePort({
      logDirectory: path.join(temporary.directory, 'logs'),
      repositoryRoot: temporary.directory,
      now: () => 1_700_000_000_000,
    });
    const prepared = port.prepare({ workPackage: created, prompt: '先写 plan' });
    assert.equal(prepared.hashId, workPackageTraceId(created.id));
    const promptFile = path.join(temporary.directory, 'logs', 'work-packages', prepared.hashId, 'prompt.txt');
    const stepFile = path.join(temporary.directory, 'logs', 'work-packages', prepared.hashId, 'steps.jsonl');
    assert.equal(readFileSync(promptFile, 'utf8'), '先写 plan');
    const first = parseWorkPackageTraceStep(JSON.parse(readFileSync(stepFile, 'utf8').trim()));
    assert.equal(first.step, 'claim');
    assert.equal(first.status, 'done');
    const journal = port.read(created.id);
    assert.equal(journal.steps.length, 1);
    assert.equal(journal.goal.objective, '步骤账本');
    assert.equal(journal.progress.status, 'claimed');
  } finally {
    temporary.remove();
  }
});

test('create seeds goal and progress immediately; continue opens a new session', () => {
  const temporary = temporaryStore();
  try {
    const tracePort = createWorkPackageTracePort({
      logDirectory: path.join(temporary.directory, 'logs'),
      repositoryRoot: temporary.directory,
      now: () => 1_700_000_000_100,
    });
    const knowledge = createKnowledgeService({
      legacyRepository: temporary.store,
      knowledgeRepository: temporary.store.repositories.knowledge,
      workPackageTracePort: tracePort,
    });
    const created = knowledge.createWorkPackage({ body: '列表点不进去' });
    const seeded = tracePort.read(created.id);
    assert.equal(seeded.goal.objective, '列表点不进去');
    assert.equal(seeded.progress.status, 'open');
    assert.equal(seeded.steps.length, 0);
    assert.equal(existsSync(path.join(temporary.directory, 'logs', 'work-packages', created.hashId, 'goal.json')), true);
    assert.equal(existsSync(path.join(temporary.directory, 'logs', 'work-packages', created.hashId, 'progress.json')), true);

    tracePort.prepare({ workPackage: created, prompt: '先写 plan' });
    const claimed = knowledge.claimWorkPackage('local', { id: created.id, claimedBy: 'cursor-session' });
    knowledge.completeWorkPackage('local', claimed.id, {
      claimedBy: 'cursor-session',
      resultSummary: '已可点进详情',
      changedPaths: ['apps/web/public/app.js'],
    });
    const next = knowledge.continueWorkPackage('local', created.id, { body: '详情里再显示步骤' });
    assert.equal(next.parentWorkPackageId, created.id);
    assert.match(next.body, /上一任务：\n列表点不进去/);
    assert.match(next.body, /上一目标：/);
    assert.match(next.body, /上一进展：/);
    assert.match(next.body, /上一步骤：/);
    assert.match(next.body, /claim done: Worker 已领取并写好提示词/);
    assert.match(next.body, /上一结果：\n已可点进详情/);
    assert.match(next.body, /继续指令：\n详情里再显示步骤/);
    const nextTrace = knowledge.getWorkPackageTrace('local', next.id);
    assert.equal(nextTrace.goal.parentWorkPackageId, created.id);
    assert.equal(nextTrace.goal.objective, '详情里再显示步骤');
    assert.equal(nextTrace.progress.status, 'open');
    assert.equal(nextTrace.parentTrace.workPackageId, created.id);
    assert.equal(nextTrace.parentTrace.steps[0].step, 'claim');
    const nextPrompt = buildCursorSessionPrompt(next, { trace: nextTrace });
    assert.match(nextPrompt, /上一轮全过程/);
    assert.match(nextPrompt, /不能 resume/);
  } finally {
    temporary.remove();
  }
});

test('cursor CLI args start a one-shot agent and then exit', () => {
  assert.equal(resolveCursorAgentBin({ env: { AI_CENTER_CURSOR_AGENT: 'C:\\\\bin\\\\agent.cmd' } }), 'C:\\\\bin\\\\agent.cmd');
  assert.throws(
    () => resolveCursorAgentBin({ env: {}, lookup: () => { throw new Error('missing'); } }),
    /本机没有 Cursor CLI/,
  );
  assert.match(
    resolveCursorAgentBin({ env: { LOCALAPPDATA: process.env.LOCALAPPDATA } }),
    /agent\.cmd$/i,
  );
  const launch = resolveCursorAgentLaunch({ env: process.env });
  assert.match(launch.command, /powershell\.exe$/i);
  assert.equal(launch.args.includes('-File'), true);
  assert.match(launch.args.at(-1), /cursor-agent\.ps1$/i);
  assert.deepEqual(buildCursorAgentArgs({ workspace: 'C:\\\\repo', prompt: '做这一条然后退出' }), [
    '-p', '--force', '--trust', '--workspace', 'C:\\\\repo',
    '--model', 'cursor-grok-4.6-high-fast',
    '--output-format', 'text', '做这一条然后退出',
  ]);
  assert.deepEqual(buildCursorAgentArgs({
    workspace: 'C:\\\\repo',
    prompt: '看这张图',
    imagePaths: ['C:\\\\data\\\\blobs\\\\attachments\\\\a.png'],
  }), [
    '-p', '--force', '--trust', '--workspace', 'C:\\\\repo',
    '--model', 'cursor-grok-4.6-high-fast',
    '--output-format', 'text',
    '--image', 'C:\\\\data\\\\blobs\\\\attachments\\\\a.png',
    '看这张图',
  ]);
  const spawnOptions = createCursorAgentSpawnOptions({ cwd: 'C:\\\\repo' });
  assert.equal(spawnOptions.windowsHide, true);
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
  if (process.platform === 'win32') {
    const visible = resolveVisibleCursorAgentLaunch({
      workspace: process.cwd(),
      promptFile: 'C:\\\\temp\\\\prompt.txt',
      model: 'cursor-grok-4.6-high-fast',
    });
    assert.match(visible.command, /cmd\.exe$/i);
    assert.equal(visible.args.includes('start'), true);
    assert.equal(visible.args.includes('/wait'), true);
    assert.equal(visible.args.includes('AI-Center-task'), false);
    assert.match(visible.args.join(' '), /run-cursor-cli-window\.ps1/);
    const windowScript = readFileSync(path.join(process.cwd(), 'scripts/run-cursor-cli-window.ps1'), 'utf8');
    assert.match(windowScript, /ReadAllText\(\$PromptFile,\s*\$utf8\)/);
    assert.match(windowScript, /\[string\[\]\]\$Image/);
    assert.match(windowScript, /--image/);
    assert.match(windowScript, /Add-Content:Encoding/);
    assert.match(windowScript, /0x4EFB/);
    assert.doesNotMatch(windowScript, /任务/);
  }
});

test('dispatch starts cursor CLI and the process reports itself before exit', async () => {
  const temporary = temporaryStore();
  try {
    const knowledge = createKnowledgeService({
      legacyRepository: temporary.store,
      knowledgeRepository: temporary.store.repositories.knowledge,
    });
    const created = knowledge.createWorkPackage({ body: '任务卡完成后要自己写回状态' });
    const tracePort = createWorkPackageTracePort({
      logDirectory: path.join(temporary.directory, 'logs'),
      repositoryRoot: temporary.directory,
    });
    const handlers = createWorkPackageJobHandlers({
      knowledgeService: knowledge,
      workPackageTracePort: tracePort,
      cursorSessionPort: createCursorSessionPort({
        startSession: async ({ prompt, workPackage }) => {
          assert.match(prompt, /Cursor CLI/);
          assert.match(prompt, /steps\.jsonl/);
          assert.match(prompt, new RegExp(created.hashId));
          assert.equal(workPackage.id, created.id);
          const journal = tracePort.read(created.id);
          assert.equal(journal.hashId, created.hashId);
          assert.equal(journal.steps[0].step, 'claim');
          assert.match(journal.prompt, /步骤目录 hashId/);
          knowledge.completeWorkPackage('local', created.id, {
            claimedBy: 'cursor-session',
            resultSummary: 'CLI 做完已退出',
            changedPaths: ['apps/web/public/app.js'],
          });
          return { agentId: 'cursor-cli', runId: '0', posted: true };
        },
      }),
    });
    const output = await handlers['work-package.dispatch']({ workPackageId: created.id });
    assert.equal(output.status, 'completed');
    assert.equal(output.agentId, 'cursor-cli');
    assert.equal(output.restartRequested, false);
    assert.equal(knowledge.getWorkPackage('local', created.id).resultSummary, 'CLI 做完已退出');
  } finally {
    temporary.remove();
  }
});

test('dispatch requests launcher bounce only after CLI exits for server code', async () => {
  const temporary = temporaryStore();
  try {
    const knowledge = createKnowledgeService({
      legacyRepository: temporary.store,
      knowledgeRepository: temporary.store.repositories.knowledge,
    });
    const created = knowledge.createWorkPackage({ body: '服务端路由要热切换' });
    const restarts = [];
    const handlers = createWorkPackageJobHandlers({
      knowledgeService: knowledge,
      requestProcessRestart: (input) => {
        restarts.push(input);
        return { requested: true };
      },
      cursorSessionPort: createCursorSessionPort({
        startSession: async () => {
          knowledge.completeWorkPackage('local', created.id, {
            claimedBy: 'cursor-session',
            resultSummary: '已改路由',
            changedPaths: ['apps/web/src/routes/knowledge-routes.js'],
          });
          return { agentId: 'cursor-cli', runId: '0', posted: true };
        },
      }),
    });
    const output = await handlers['work-package.dispatch']({ workPackageId: created.id });
    assert.equal(output.status, 'completed');
    assert.equal(output.restartRequested, true);
    assert.equal(restarts.length, 1);
    assert.equal(restarts[0].workPackageId, created.id);
  } finally {
    temporary.remove();
  }
});

test('launcher restart request is cooldown-safe and prompt never kills processes', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-restart-'));
  try {
    const first = requestLauncherRestart(directory, { now: 1_000, reason: 'manual' });
    const second = requestLauncherRestart(directory, { now: 2_000, reason: 'manual' });
    const later = requestLauncherRestart(directory, { now: 10_000, reason: 'work-package' });
    assert.equal(first.requested, true);
    assert.equal(second.requested, false);
    assert.equal(second.reason, 'cooldown');
    assert.equal(later.requested, true);
    const prompt = buildCursorSessionPrompt({ id: '00000000-0000-4000-8000-000000000001', body: '改底栏' });
    assert.match(prompt, /changedPaths 必须如实列出/);
    assert.match(prompt, /启动器弹 Web\/Worker/);
    assert.match(prompt, /steps\.jsonl/);
    assert.match(prompt, /步骤目录 hashId/);
    assert.match(prompt, /UTF-8 无 BOM/);
    assert.match(prompt, /Add-Content/);
    assert.doesNotMatch(prompt, /restart-ai-center\.ps1/);
    assert.equal(parseWorkPackageTraceStep({
      at: 1_000,
      step: 'plan',
      status: 'started',
      summary: '先看路由',
    }).step, 'plan');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('step journal decodes GBK lines and repairs garbled parent snapshots', () => {
  const gbkSummary = Buffer.from('b6d4c6ebc8cecef1bfa8d3ebc9beb3fdccf5b5c4b2c3c7d0bad0bacdb2e3bcb6', 'hex');
  assert.equal(decodeWorkPackageStepLine(gbkSummary), '对齐任务卡与删除条的裁切盒和层级');
  assert.equal(workPackageStepTextLooksGarbled('对齐任务卡'), false);
  assert.equal(workPackageStepTextLooksGarbled(`\uFFFD\uFFFD\u5220\u9664`), true);

  const temporary = temporaryStore();
  try {
    const parentId = '22222222-2222-4222-8222-222222222222';
    const childId = '33333333-3333-4333-8333-333333333333';
    const port = createWorkPackageTracePort({
      logDirectory: path.join(temporary.directory, 'logs'),
      repositoryRoot: temporary.directory,
      now: () => 1_700_000_000_200,
    });
    port.prepare({ workPackage: { id: parentId, title: '删除条' }, prompt: '先写 plan' });
    const parentDir = path.join(temporary.directory, 'logs', 'work-packages', workPackageTraceId(parentId));
    appendFileSync(path.join(parentDir, 'steps.jsonl'), Buffer.concat([
      Buffer.from('{"at":1700000000300,"step":"plan","status":"done","summary":"'),
      gbkSummary,
      Buffer.from('","paths":[]}\n'),
    ]));
    const parent = port.read(parentId);
    assert.equal(parent.steps[0].summary, 'Worker 已领取并写好提示词');
    assert.equal(parent.steps.at(-1).summary, '对齐任务卡与删除条的裁切盒和层级');

    port.prepare({
      workPackage: { id: childId, title: '修乱码', parentWorkPackageId: parentId },
      prompt: '检查乱码',
    });
    const childDir = path.join(temporary.directory, 'logs', 'work-packages', workPackageTraceId(childId));
    writeFileSync(path.join(childDir, 'parent-trace.json'), `${JSON.stringify({
      workPackageId: parentId,
      hashId: workPackageTraceId(parentId),
      goal: { objective: '删除条', parentWorkPackageId: '', createdAt: 1_700_000_000_200 },
      progress: { status: 'completed', summary: 'ok', updatedAt: 1_700_000_000_200 },
      steps: [{
        at: 1_700_000_000_300,
        step: 'plan',
        status: 'done',
        summary: '\uFFFD\uFFFD\u5220\u9664\u6761\u7684\u88c1\u5207',
        paths: [],
      }],
    }, null, 2)}\n`, 'utf8');
    const child = port.read(childId);
    assert.equal(child.parentTrace.steps.at(-1).summary, '对齐任务卡与删除条的裁切盒和层级');
  } finally {
    temporary.remove();
  }
});

test('task list cards keep theme and preview, not the full body', () => {
  const app = readFileSync(path.join(process.cwd(), 'apps/web/public/app.js'), 'utf8');
  const css = readFileSync(path.join(process.cwd(), 'apps/web/public/styles.css'), 'utf8');
  assert.match(app, /function workPackageCardTitle/);
  assert.match(app, /function workPackageCardPreview/);
  assert.match(app, /task-card-theme/);
  assert.match(app, /task-card-preview/);
  assert.doesNotMatch(app, /fillNoteBody\(card, pack\.body/);
  assert.match(css, /\.task-card-theme/);
  assert.match(css, /\.task-card-preview[\s\S]*-webkit-line-clamp:\s*2/);
  assert.match(css, /#task-list \.task-row \{[\s\S]*padding:\s*0/);
  assert.match(css, /#task-list \.task-row \{[\s\S]*overflow:\s*hidden/);
  assert.match(css, /#task-list \.task-row \.task-card[\s\S]*border-radius:\s*0/);
  assert.match(css, /#task-list \.task-row\.is-open \.swipe-actions[\s\S]*z-index:\s*0/);
  assert.match(css, /#task-list \.task-row \.swipe-delete[\s\S]*height:\s*100%/);
});

test('continued work package body keeps last instruction readable', () => {
  const nested = buildContinuedWorkPackageBody({
    body: buildContinuedWorkPackageBody({
      body: '查看信息源 hash 去重',
      resultSummary: '已有 fingerprint，无需再改代码',
    }, '检查上一任务传过来的是不是乱码'),
    resultSummary: '列表把上一任务整段当了标题',
  }, '刷新后对话还在吗');
  const parsed = parseContinuedWorkPackageBody(nested);
  assert.equal(parsed.continued, true);
  assert.equal(parsed.instruction, '刷新后对话还在吗');
  assert.equal(parsed.result, '列表把上一任务整段当了标题');
  assert.match(parsed.steps, /无步骤账本|claim|step/);
  const previous = parseContinuedWorkPackageBody(parsed.previous);
  assert.equal(previous.instruction, '检查上一任务传过来的是不是乱码');
  assert.equal(parseContinuedWorkPackageBody('普通投递正文').continued, false);
  assert.equal(parseContinuedWorkPackageBody('普通投递正文').instruction, '普通投递正文');
});

test('task detail refreshes from progress and keeps local drafts', () => {
  const app = readFileSync(path.join(process.cwd(), 'apps/web/public/app.js'), 'utf8');
  const css = readFileSync(path.join(process.cwd(), 'apps/web/public/styles.css'), 'utf8');
  const contracts = readFileSync(path.join(process.cwd(), 'docs/contracts-v1.md'), 'utf8');
  assert.match(app, /function workPackageTraceFingerprint/);
  assert.match(app, /function refreshSelectedWorkPackageProgress/);
  assert.match(app, /function persistTaskContinueDraft/);
  assert.match(app, /function persistTaskComposerDraft/);
  assert.match(app, /function parseContinuedWorkPackageBody/);
  assert.match(app, /sections\.continued && sections\.instruction/);
  assert.match(app, /function takeContinuedSection/);
  assert.match(app, /parentTrace/);
  assert.match(app, /上一过程/);
  assert.match(app, /persistFeedBrowseState\(\);\r?\n\s*syncAskKeyboard/);
  assert.match(app, /WORK_PACKAGE_PROGRESS_POLL_MS = 2500/);
  assert.match(app, /api\(`\/api\/v1\/work-packages\/\$\{id\}\/trace`\)/);
  assert.match(app, /area\.value = readTaskContinueDraft\(pack\.id\)/);
  assert.match(app, /TASK_COMPOSE_DRAFT_KEY/);
  assert.match(app, /TASK_CONTINUE_DRAFT_KEY/);
  assert.match(css, /\.task-progress-when/);
  assert.match(contracts, /progress\.updatedAt/);
  assert.match(contracts, /localStorage/);
  assert.match(contracts, /继续指令/);
  assert.match(contracts, /上一目标/);
  assert.match(contracts, /parentTrace/);
  assert.match(contracts, /GBK/);
  assert.match(contracts, /默认同行最多 3 个 `work-package.dispatch`/);
  assert.match(contracts, /AI_CENTER_WORKER_WORK_PACKAGE_CONCURRENCY/);
  assert.equal(parseWorkerJobConcurrency({}).workPackageDispatchLimit, 3);
});

test('task detail reuses the Ask run progress list', () => {
  const app = readFileSync(path.join(process.cwd(), 'apps/web/public/app.js'), 'utf8');
  const css = readFileSync(path.join(process.cwd(), 'apps/web/public/styles.css'), 'utf8');
  const contracts = readFileSync(path.join(process.cwd(), 'docs/contracts-v1.md'), 'utf8');
  assert.match(app, /function workPackageIsLive/);
  assert.match(app, /function renderRunProgress/);
  assert.match(app, /function createRunProgressList/);
  assert.match(app, /task:\$\{pack\.id\}/);
  assert.match(app, /trace\.timeline/);
  assert.match(css, /\.ask-progress/);
  assert.match(contracts, /AgentRunProgressStep/);
});
