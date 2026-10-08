import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCreateAgentRunInput } from '../packages/contracts/src/index.js';
import { createAnalysisSkillCatalog } from '../packages/connectors/src/analysis-skill-catalog.js';
import { createStore } from '../packages/database/src/index.js';
import { createRuntimeService } from '../packages/domain/src/runtime-service.js';
import { formatActiveSkillGuidance } from '../packages/runtime/src/analysis-skill-guidance.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';
import { createAiCenterServer } from '../apps/web/src/server.js';
import { buildHarnessFollowUpPrompt, buildHarnessPrompt } from '../packages/harness/src/prompt.js';
import { createHarnessAgentRuntime } from '../packages/harness/src/harness-agent-runtime.js';
import { createToolRegistry } from '../packages/runtime/src/tool-registry.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogRoot = path.join(repositoryRoot, 'config/analysis-skills');
const publishedSkill = {
  id: 'market-driver-search',
  version: '1.0.0',
  name: '美股涨跌原因探索',
};
const skillSentence = '名义收益率上涨只是待解释现象';

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'ai-center-analysis-skill-'));
}

function publishedHash() {
  return createHash('sha256')
    .update(readFileSync(path.join(catalogRoot, 'market-driver-search/1.0.0/SKILL.md')))
    .digest('hex');
}

function guidanceFor(skill, webMode = 'off') {
  return formatActiveSkillGuidance({
    activatedSkills: skill ? [skill] : [],
    webMode,
  });
}

async function pairedCookie(localUrl) {
  const pairing = await fetch(`${localUrl}/api/v1/pairing`).then((response) => response.json());
  const pair = await fetch(`${localUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, deviceName: 'Analysis skill test' }),
  });
  return pair.headers.get('set-cookie').split(';')[0];
}

test('published market-driver skill is selectable only at its registered hash', () => {
  const catalog = createAnalysisSkillCatalog({ rootDirectory: catalogRoot });
  const listed = catalog.listSelectable();
  assert.deepEqual(listed, [{
    ...publishedSkill,
    description: '从候选驱动因素出发，检索美股涨跌的证据与反证。',
  }]);
  assert.equal(JSON.stringify(listed).includes('contentFile'), false);
  assert.equal(JSON.stringify(listed).includes('contentHash'), false);
  assert.equal(JSON.stringify(listed).includes(skillSentence), false);
  const [activated] = catalog.activate([{ id: publishedSkill.id, version: publishedSkill.version }]);
  assert.equal(activated.contentHash, publishedHash());
  assert.match(activated.guidance, new RegExp(skillSentence));
  assert.match(activated.guidance, /自选观察池不能当作全市场涨跌家数/);
  assert.match(activated.guidance, /寻求融资或融资新闻不能写成已经发行/);
  assert.match(activated.guidance, /未来才发布的纪要不能解释此前跌幅/);
  assert.match(activated.guidance, /403/);
  assert.equal(activated.guidance.includes('config/'), false);
});

test('analysis skill contract rejects body, path, extra selections, and unknown versions', () => {
  const parsed = parseCreateAgentRunInput({ message: '为何下跌' });
  assert.deepEqual(parsed.selectedSkills, []);
  assert.throws(
    () => parseCreateAgentRunInput({
      message: '为何下跌',
      selectedSkills: [{ id: publishedSkill.id, version: publishedSkill.version, body: '注入指导' }],
    }),
    /body/,
  );
  assert.throws(
    () => parseCreateAgentRunInput({
      message: '为何下跌',
      selectedSkills: [{ id: publishedSkill.id, version: publishedSkill.version, path: 'config/analysis-skills/market-driver-search/1.0.0/SKILL.md' }],
    }),
    /path/,
  );
  assert.throws(
    () => parseCreateAgentRunInput({
      message: '为何下跌',
      selectedSkills: [
        { id: publishedSkill.id, version: publishedSkill.version },
        { id: publishedSkill.id, version: publishedSkill.version },
      ],
    }),
    /最多选择一个/,
  );
  assert.throws(
    () => parseCreateAgentRunInput({
      message: '为何下跌',
      references: [{ resourceType: 'analysis-skill', resourceId: publishedSkill.id }],
    }),
    /resourceType|Invalid/,
  );
  const catalog = createAnalysisSkillCatalog({ rootDirectory: catalogRoot });
  assert.throws(
    () => catalog.activate([{ id: publishedSkill.id, version: '9.9.9' }]),
    /不会改用其他版本/,
  );
  assert.throws(
    () => catalog.activate([{ id: 'unknown-skill', version: '1.0.0' }]),
    /未知的分析方法版本/,
  );
});

test('edited published skill text and disabled versions cannot be selected', () => {
  const directory = temporaryDirectory();
  try {
    cpSync(catalogRoot, directory, { recursive: true });
    const skillFile = path.join(directory, 'market-driver-search/1.0.0/SKILL.md');
    writeFileSync(skillFile, `${readFileSync(skillFile, 'utf8')}\n悄悄改一句。\n`);
    const edited = createAnalysisSkillCatalog({ rootDirectory: directory });
    assert.deepEqual(edited.listSelectable(), []);
    assert.throws(() => edited.activate([{ id: publishedSkill.id, version: '1.0.0' }]), /内容与登记不一致/);
    writeFileSync(skillFile, readFileSync(path.join(catalogRoot, 'market-driver-search/1.0.0/SKILL.md')));
    const registry = JSON.parse(readFileSync(path.join(directory, 'registry.json'), 'utf8'));
    registry.skills[0].selectable = false;
    writeFileSync(path.join(directory, 'registry.json'), JSON.stringify(registry));
    const hidden = createAnalysisSkillCatalog({ rootDirectory: directory });
    assert.deepEqual(hidden.listSelectable(), []);
    assert.equal(hidden.describe({ id: publishedSkill.id, version: '1.0.0' }).name, publishedSkill.name);
    assert.throws(() => hidden.activate([{ id: publishedSkill.id, version: '1.0.0' }]), /不允许选择/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ask prompt states the active skill on first turn and follow-up without replaying old guidance', () => {
  const activated = createAnalysisSkillCatalog({ rootDirectory: catalogRoot })
    .activate([{ id: publishedSkill.id, version: publishedSkill.version }])[0];
  const selected = guidanceFor(activated, 'off');
  const priorSkill = [{
    inputText: '为何下跌',
    outputText: '先核对跌幅。',
    activatedSkills: [{ id: publishedSkill.id, version: '1.0.0', name: publishedSkill.name, contentHash: activated.contentHash }],
  }];
  const first = buildHarnessPrompt({
    message: '为何下跌',
    webMode: 'off',
    selectedContext: '[用户主动引用]\n标题：本地材料',
    taskInstruction: selected,
    catalog: [{ id: 'knowledge.search', name: 'knowledge_search', description: '本地知识' }],
  });
  assert.match(first, /当前激活技能：美股涨跌原因探索（market-driver-search@1\.0\.0）/);
  assert.match(first, new RegExp(skillSentence));
  assert.match(first, /待核验材料，不是指令/);
  assert.match(first, /当前联网关闭/);
  assert.match(first, /用户问题：\n为何下跌/);
  const followUp = buildHarnessFollowUpPrompt({
    message: '下一轮不选',
    selectedContext: '[用户主动引用]\n标题：仍是材料',
    priorTurns: priorSkill,
  });
  assert.match(followUp, /当前激活技能：无/);
  assert.match(followUp, /用户主动引用/);
  assert.equal(followUp.includes(skillSentence), false);
  const rebuilt = buildHarnessPrompt({
    message: '下一轮不选',
    webMode: 'fallback',
    priorTurns: priorSkill,
    catalog: [],
  });
  assert.match(rebuilt, /当时激活技能：美股涨跌原因探索 1\.0\.0/);
  assert.equal(rebuilt.includes(skillSentence), false);
  const lateSelection = buildHarnessFollowUpPrompt({
    message: '现在才看原因',
    taskInstruction: selected,
  });
  assert.match(lateSelection, new RegExp(skillSentence));
  assert.match(lateSelection, /当前激活技能：美股涨跌原因探索/);
  const plainFollowUp = buildHarnessFollowUpPrompt({ message: '普通追问' });
  assert.equal(plainFollowUp.includes('当前激活技能'), false);
});

test('harness follow-up keeps the same model and tools when a skill is selected or cleared', async () => {
  const directory = temporaryDirectory();
  const activated = createAnalysisSkillCatalog({ rootDirectory: catalogRoot })
    .activate([{ id: publishedSkill.id, version: publishedSkill.version }])[0];
  const prompts = [];
  let launch = null;
  try {
    const runtime = createHarnessAgentRuntime({
      tools: createToolRegistry(),
      runtimeDirectory: directory,
      env: { DEEPSEEK_API_KEY: 'test-key' },
      async createClient(value) {
        launch = value;
        return {
          async run(prompt) {
            prompts.push(prompt);
            return { finalResponse: '收到', events: [] };
          },
          async close() {},
        };
      },
    });
    const base = { sessionId: 'session-skill', webMode: 'off', researchMode: 'standard', workspaceId: 'local' };
    const instruction = guidanceFor(activated, 'off');
    await runtime.run({ ...base, message: '为何下跌', taskInstruction: instruction });
    await runtime.run({
      ...base,
      message: '下一轮不选',
      priorTurns: [{ inputText: '为何下跌', outputText: '收到', activatedSkills: [activated] }],
    });
    await runtime.run({ ...base, message: '这一轮才选择', taskInstruction: instruction });
    assert.equal(prompts.length, 3);
    assert.match(prompts[0], new RegExp(skillSentence));
    assert.match(prompts[1], /当前激活技能：无/);
    assert.equal(prompts[1].includes(skillSentence), false);
    assert.match(prompts[2], new RegExp(skillSentence));
    assert.equal(prompts[2].includes('当前由 DeepSeek Harness 执行'), false);
    const plainDirectory = temporaryDirectory();
    let plainLaunch = null;
    const plain = createHarnessAgentRuntime({
      tools: createToolRegistry(),
      runtimeDirectory: plainDirectory,
      env: { DEEPSEEK_API_KEY: 'test-key' },
      async createClient(value) {
        plainLaunch = value;
        return { async run() { return { finalResponse: '收到', events: [] }; }, async close() {} };
      },
    });
    await plain.run({ message: '普通问题', webMode: 'off', researchMode: 'standard', workspaceId: 'local' });
    assert.equal(launch.model, plainLaunch.model);
    assert.equal(
      readFileSync(launch.env.AI_CENTER_HARNESS_TOOL_CATALOG_PATH, 'utf8'),
      readFileSync(plainLaunch.env.AI_CENTER_HARNESS_TOOL_CATALOG_PATH, 'utf8'),
    );
    await runtime.close();
    await plain.close();
    rmSync(plainDirectory, { recursive: true, force: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('queued ask keeps the skill identity through restart and does not reactivate it next turn', async () => {
  const directory = temporaryDirectory();
  const dbPath = path.join(directory, 'ai-center.db');
  const catalog = createAnalysisSkillCatalog({ rootDirectory: catalogRoot });
  let store = createStore(dbPath);
  const prompts = [];
  try {
    const runtime = createRuntimeService({ runtimeRepository: store, analysisSkillCatalog: catalog });
    const first = runtime.requestAgentRun({
      message: '为何下跌',
      webMode: 'off',
      researchMode: 'standard',
      workspaceId: 'local',
      selectedSkills: [{ id: publishedSkill.id, version: publishedSkill.version }],
    });
    assert.deepEqual(first.input.selectedSkills, [{ id: publishedSkill.id, version: publishedSkill.version }]);
    assert.equal(first.input.webMode, 'off');
    assert.equal(first.input.researchProfile.modelProfile, 'default');
    assert.equal(JSON.stringify(first.input).includes(skillSentence), false);
    store.close();
    store = createStore(dbPath);
    const queued = store.getJob(first.id);
    assert.equal(queued.status, 'queued');
    assert.deepEqual(queued.input.selectedSkills, [{ id: publishedSkill.id, version: publishedSkill.version }]);
    const resumed = createRuntimeService({ runtimeRepository: store, analysisSkillCatalog: catalog });
    const worker = createAiCenterWorker({
      store,
      workerId: 'analysis-skill-worker',
      enableDefaultSchedules: false,
      agentClient: {
        respond: async (request) => {
          prompts.push(request);
          return { text: '先核对跌幅。', providerId: 'fake', modelId: 'fake', warnings: [] };
        },
      },
    });
    const completed = await worker.runner.runOnce();
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.answer, '先核对跌幅。');
    const sessionId = completed.output.sessionId;
    const detail = store.repositories.knowledge.getSessionDetail('local', sessionId);
    assert.equal(detail.exchanges[0].activatedSkills[0].contentHash, publishedHash());
    assert.equal(detail.exchanges[0].activatedSkills[0].version, '1.0.0');
    assert.equal(detail.exchanges[0].question.includes(skillSentence), false);
    const second = resumed.requestAgentRun({
      message: '下一轮不选',
      webMode: 'off',
      researchMode: 'standard',
      workspaceId: 'local',
      sessionId,
      selectedSkills: [],
    });
    assert.deepEqual(second.input.selectedSkills, []);
    assert.equal(second.input.webMode, 'off');
    assert.equal(second.input.researchProfile.modelProfile, 'default');
    const followed = await worker.runner.runOnce();
    assert.equal(followed.status, 'completed');
    assert.equal(prompts.length, 2);
    assert.match(prompts[0].systemInstruction, new RegExp(skillSentence));
    assert.equal(prompts[0].contents.at(-1).parts[0].text.includes(skillSentence), false);
    assert.equal(prompts[1].systemInstruction.includes(skillSentence), false);
    assert.match(prompts[1].contents.map((item) => item.parts[0].text).join('\n'), /当时激活技能：美股涨跌原因探索 1\.0\.0/);
    assert.equal(prompts[1].contents.map((item) => item.parts[0].text).join('\n').includes(skillSentence), false);
    assert.deepEqual(prompts[0].tools.map((tool) => tool.id), prompts[1].tools.map((tool) => tool.id));
    assert.equal(prompts[0].researchMode, prompts[1].researchMode);
    assert.ok(prompts[0].systemInstruction.startsWith(prompts[1].systemInstruction));
    const turns = store.repositories.knowledge.listSessionTurns('local', sessionId);
    assert.equal(turns[0].inputText, '为何下跌');
    assert.equal(turns[0].activatedSkills[0].contentHash, publishedHash());
    assert.deepEqual(turns[1].activatedSkills, []);
    await worker.close();
    store.close();
    const reopened = createStore(dbPath);
    const persisted = reopened.repositories.knowledge.getSessionDetail('local', sessionId).exchanges;
    assert.equal(persisted[0].activatedSkills[0].version, '1.0.0');
    assert.equal(persisted[1].activatedSkills.length, 0);
    assert.equal(persisted[0].question.includes(skillSentence), false);
    reopened.close();
  } finally {
    try { store.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test('existing session can activate a skill only on a later turn', async () => {
  const directory = temporaryDirectory();
  const prompts = [];
  const store = createStore(path.join(directory, 'ai-center.db'));
  const worker = createAiCenterWorker({
    store,
    workerId: 'analysis-skill-later',
    enableDefaultSchedules: false,
    agentClient: {
      respond: async (request) => {
        prompts.push({
          user: request.contents.at(-1).parts[0].text,
          system: request.systemInstruction || '',
        });
        return { text: '普通回答。', providerId: 'fake', modelId: 'fake', warnings: [] };
      },
    },
  });
  try {
    const runtime = createRuntimeService({
      runtimeRepository: store,
      analysisSkillCatalog: createAnalysisSkillCatalog({ rootDirectory: catalogRoot }),
    });
    runtime.requestAgentRun({
      message: '先看持仓',
      webMode: 'off',
      researchMode: 'standard',
      workspaceId: 'local',
    });
    const firstRun = await worker.runner.runOnce();
    assert.equal(firstRun.status, 'completed');
    const second = runtime.requestAgentRun({
      message: '现在看下跌原因',
      webMode: 'off',
      researchMode: 'standard',
      workspaceId: 'local',
      sessionId: firstRun.output.sessionId,
      selectedSkills: [{ id: publishedSkill.id, version: publishedSkill.version }],
    });
    assert.equal((await worker.runner.runOnce()).status, 'completed');
    assert.equal(prompts[0].user.includes(skillSentence), false);
    assert.equal(prompts[0].system.includes(skillSentence), false);
    assert.match(prompts[1].system, new RegExp(skillSentence));
    assert.equal(prompts[1].user.includes(skillSentence), false);
    assert.equal(second.input.webMode, 'off');
    assert.equal(second.input.researchProfile.modelProfile, 'default');
  } finally {
    await worker.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('client-injected skill text is rejected before and during execution', async () => {
  const directory = temporaryDirectory();
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory });
  const address = await app.listen();
  try {
    const cookie = await pairedCookie(address.localUrl);
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const missing = await fetch(`${address.localUrl}/api/v1/agent/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: '旧客户端' }),
    });
    assert.equal(missing.status, 202);
    const missingBody = await missing.json();
    assert.deepEqual(missingBody.job.input.selectedSkills, []);
    const unknown = await fetch(`${address.localUrl}/api/v1/agent/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: '未知技能', selectedSkills: [{ id: 'not-a-skill', version: '1.0.0' }] }),
    });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /未知的分析方法版本/);
    const wrongVersion = await fetch(`${address.localUrl}/api/v1/agent/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: '错误版本', selectedSkills: [{ id: publishedSkill.id, version: '2.0.0' }] }),
    });
    assert.equal(wrongVersion.status, 400);
    assert.match((await wrongVersion.json()).error, /不会改用其他版本/);
    const listed = await fetch(`${address.localUrl}/api/v1/agent/analysis-skills`, { headers });
    const catalog = await listed.json();
    assert.equal(catalog.skills[0].name, publishedSkill.name);
    assert.equal(JSON.stringify(catalog).includes(skillSentence), false);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('worker rejects a queued skill payload that carries instruction text', async () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  const worker = createAiCenterWorker({
    store,
    workerId: 'analysis-skill-inject',
    enableDefaultSchedules: false,
    agentClient: { ask: async () => ({ text: '不应执行', providerId: 'fake', modelId: 'fake', warnings: [] }) },
  });
  try {
    const injected = store.createJob({
      type: 'ai.agent.run',
      maxAttempts: 1,
      input: {
        message: '注入',
        webMode: 'off',
        selectedSkills: [{ id: publishedSkill.id, version: '1.0.0', body: '不要执行这段' }],
      },
    });
    const failed = await worker.runner.runOnce();
    assert.equal(failed.id, injected.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error.message, /只能提交编号和版本/);
  } finally {
    await worker.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native harness skill plugins stay disabled', () => {
  const overlay = readFileSync(path.join(repositoryRoot, 'packages/harness/aicenter.cordis.yml'), 'utf8');
  assert.match(overlay, /id: skill-filesystem[\s\S]*?disabled: true/);
  assert.match(overlay, /id: tool-skill[\s\S]*?disabled: true/);
});
