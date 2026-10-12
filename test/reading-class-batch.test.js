import test from 'node:test';
import assert from 'node:assert/strict';
import {READING_CLASS_VERSION} from '../packages/domain/src/reading-focus-route.js';
import {READING_CLASS_BATCH_APPENDIX, READING_CLASS_INSTRUCTION, createReadingHourService, readingClassBatchInstruction, readingClassBatchSize, readingClassKeyEnvs} from '../packages/domain/src/reading-hour-service.js';

const window = {startAt: 10, endAt: 20};

function node(id, title, extra = {}) {
  return {id, sourceId: id, version: '1', title, text: `${title}摘要`, body: `${title}正文`, publisher: '来源', ...extra};
}

function classified(primaryDirection, subjectKind, evidenceQuote, idx) {
  return {idx, primaryDirection, subjectKind, domainTagIds: [], classificationStatus: 'classified', evidenceQuote};
}

function singleAnswer(message) {
  return JSON.stringify({primaryDirection: 'industry', subjectKind: 'company_event', domainTagIds: [], classificationStatus: 'classified', evidenceQuote: message.title});
}

function open({env = {}, nodes, stages = new Map(), run}) {
  const calls = [];
  const saves = [];
  const repository = {
    listInformationInWindow: () => nodes,
    publishReadingHour: (_workspace, snapshot) => ({published: true, snapshot}),
  };
  const reportRepository = {
    getAnalysisStage(workspace, kind, key, version) {
      return stages.get(`${workspace}:${kind}:${key}:${version}`) || null;
    },
    saveAnalysisStage(...args) { saves.push(args); },
  };
  const agentRuntime = {async run(input) { calls.push(input); return run(input, calls.length - 1); }};
  const service = createReadingHourService({repository, reportRepository, agentRuntime, enabled: true, env, now: () => 5});
  return {service, calls, saves};
}

const googleKeys = {
  AI_CENTER_HARNESS_HOURLY_PROVIDER: 'google',
  AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY,GEMINI_API_KEY2,GEMINI_API_KEY3',
  GEMINI_API_KEY: 'key-a',
  GEMINI_API_KEY2: 'key-b',
  GEMINI_API_KEY3: 'key-c',
};

test('reading class batch size defaults to 10 and rejects a non-positive value', () => {
  assert.equal(readingClassBatchSize({}), 10);
  assert.equal(readingClassBatchSize({AI_CENTER_READING_CLASS_BATCH: ' 10 '}), 10);
  assert.equal(readingClassBatchSize({AI_CENTER_READING_CLASS_BATCH: '1'}), 1);
  assert.throws(() => readingClassBatchSize({AI_CENTER_READING_CLASS_BATCH: '0'}), /AI_CENTER_READING_CLASS_BATCH/);
  assert.throws(() => readingClassBatchSize({AI_CENTER_READING_CLASS_BATCH: '1.5'}), /AI_CENTER_READING_CLASS_BATCH/);
  assert.throws(() => createReadingHourService({repository: {}, env: {AI_CENTER_READING_CLASS_BATCH: 'no'}}), /AI_CENTER_READING_CLASS_BATCH/);
  assert.deepEqual(readingClassKeyEnvs({AI_CENTER_HARNESS_HOURLY_PROVIDER: 'elucid-grok', GEMINI_API_KEY: 'a'}), []);
  assert.deepEqual(readingClassKeyEnvs({...googleKeys, GEMINI_API_KEY2: 'key-a'}), ['GEMINI_API_KEY', 'GEMINI_API_KEY3']);
  assert.equal(readingClassBatchInstruction(), `${READING_CLASS_INSTRUCTION}\n${READING_CLASS_BATCH_APPENDIX}`);
  assert.equal(READING_CLASS_INSTRUCTION.includes('idx'), false);
});

test('batch classification aligns shuffled idx values and skips a cached item', async () => {
  const nodes = [node('a', '甲'), node('b', '乙'), node('cached', '已缓存'), node('c', '丙')];
  const stageKey = 'reading-class:cached:1';
  const stages = new Map([[
    `local:reading-class:${stageKey}:${READING_CLASS_VERSION}`,
    {status: 'completed', output: {status: 'classified', primaryDirection: 'geopolitics', subjectKind: 'geopolitics_event', domainTagIds: [], evidenceQuote: '缓存句', inputScope: 'saved-article', promptHash: READING_CLASS_VERSION}},
  ]]);
  const rows = [
    classified('ai', 'ai_model_method', '丙句', '2'),
    classified('finance', 'market_asset', '甲句', 0),
    classified('industry', 'company_event', '乙句', 1),
  ];
  const {service, calls, saves} = open({
    env: {AI_CENTER_READING_CLASS_BATCH: '10'},
    nodes,
    stages,
    run() { return {answer: '```json\n' + JSON.stringify(rows) + '\n```'}; },
  });
  const result = await service.scoreWindow({workspace: 'local', window});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskInstruction, readingClassBatchInstruction());
  assert.equal(calls[0].usageStage, 'reading-classification');
  assert.equal(calls[0].closedTask, 'hourly-brief');
  const message = JSON.parse(calls[0].message);
  assert.deepEqual(message.map((item) => item.idx), [0, 1, 2]);
  assert.deepEqual(message.map((item) => item.title), ['甲', '乙', '丙']);
  assert.equal(message.some((item) => item.title === '已缓存'), false);
  assert.deepEqual(result.snapshot.items.map((item) => item.evidenceQuote), ['甲句', '乙句', '缓存句', '丙句']);
  assert.deepEqual(result.snapshot.items.map((item) => item.readingDirectionName), ['金融', '产业个股', '地缘政治', '科技与AI']);
  assert.equal(result.snapshot.items[2].classificationSource, 'classification-cache');
  assert.equal(saves.length, 3);
  assert.deepEqual(saves.map((save) => save[2]), ['reading-class:a:1', 'reading-class:b:1', 'reading-class:c:1']);
  assert.equal(saves[0][3], READING_CLASS_VERSION);
  assert.equal(saves[0][6], 'completed');
  assert.equal(saves[0][5].primaryDirection, 'finance');
  assert.equal(saves[0][5].promptHash, READING_CLASS_VERSION);
  assert.equal(saves[0][5].source, undefined);
});

test('missing and invalid batch rows fall back to per-item classification only for those rows', async () => {
  const nodes = [node('a', '甲'), node('b', '乙'), node('c', '丙')];
  const {service, calls} = open({
    env: {AI_CENTER_READING_CLASS_BATCH: '10'},
    nodes,
    run(input) {
      const message = JSON.parse(input.message);
      if (Array.isArray(message)) {
        return {answer: JSON.stringify([
          classified('finance', 'market_asset', '甲句', 0),
          {idx: 1, primaryDirection: 'nope', subjectKind: 'unknown', domainTagIds: [], classificationStatus: 'classified', evidenceQuote: '坏'},
        ])};
      }
      return {answer: singleAnswer(message)};
    },
  });
  const result = await service.scoreWindow({workspace: 'local', window});
  assert.equal(calls.length, 3);
  assert.equal(Array.isArray(JSON.parse(calls[0].message)), true);
  assert.deepEqual(calls.slice(1).map((call) => JSON.parse(call.message).title), ['乙', '丙']);
  assert.deepEqual(calls.slice(1).map((call) => call.taskInstruction), [READING_CLASS_INSTRUCTION, READING_CLASS_INSTRUCTION]);
  assert.equal(calls[1].googleKeyEnv, undefined);
  assert.deepEqual(result.snapshot.items.map((item) => item.evidenceQuote), ['甲句', '乙', '丙']);
  assert.deepEqual(result.snapshot.items.map((item) => item.readingDirectionName), ['金融', '产业个股', '产业个股']);
});

test('a batch that fails to parse falls back to per-item classification', async () => {
  const nodes = [node('a', '甲'), node('b', '乙')];
  const {service, calls, saves} = open({
    env: {AI_CENTER_READING_CLASS_BATCH: '10'},
    nodes,
    run(input) {
      const message = JSON.parse(input.message);
      if (Array.isArray(message)) return {answer: '不是 JSON'};
      return {answer: singleAnswer(message)};
    },
  });
  const result = await service.scoreWindow({workspace: 'local', window});
  assert.equal(calls.length, 3);
  assert.equal(calls[0].taskInstruction, readingClassBatchInstruction());
  assert.deepEqual(calls.slice(1).map((call) => [call.taskInstruction, JSON.parse(call.message).title]), [
    [READING_CLASS_INSTRUCTION, '甲'],
    [READING_CLASS_INSTRUCTION, '乙'],
  ]);
  assert.deepEqual(result.snapshot.items.map((item) => item.evidenceQuote), ['甲', '乙']);
  assert.equal(saves.length, 2);
  assert.deepEqual(saves.map((save) => save[2]), ['reading-class:a:1', 'reading-class:b:1']);
});

test('batch requests round-robin across configured keys and quota does not split into per-item calls', async () => {
  const nodes = [node('a', '甲'), node('b', '乙'), node('c', '丙'), node('d', '丁'), node('e', '戊'), node('f', '己')];
  const distributed = open({
    env: {...googleKeys, AI_CENTER_READING_CLASS_BATCH: '2'},
    nodes,
    run(input) {
      const message = JSON.parse(input.message);
      return {answer: JSON.stringify(message.map((item) => classified('finance', 'market_asset', item.title, item.idx)))};
    },
  });
  await distributed.service.scoreWindow({workspace: 'local', window});
  assert.deepEqual(distributed.calls.map((call) => call.googleKeyEnv), ['GEMINI_API_KEY', 'GEMINI_API_KEY2', 'GEMINI_API_KEY3']);
  assert.deepEqual(distributed.calls.map((call) => JSON.parse(call.message).map((item) => item.title)), [['甲', '乙'], ['丙', '丁'], ['戊', '己']]);
  assert.equal(distributed.calls.every((call) => call.taskInstruction === readingClassBatchInstruction()), true);

  const quota = open({
    env: {...googleKeys, AI_CENTER_READING_CLASS_BATCH: '10'},
    nodes: nodes.slice(0, 4),
    run() {
      const error = new Error('quota=daily key=KEY cooldownUntil=1');
      error.code = 'budget-deferred';
      error.quotaExhausted = true;
      throw error;
    },
  });
  const blocked = await quota.service.scoreWindow({workspace: 'local', window});
  assert.equal(quota.calls.length, 3);
  assert.deepEqual(quota.calls.map((call) => call.googleKeyEnv), ['GEMINI_API_KEY', 'GEMINI_API_KEY2', 'GEMINI_API_KEY3']);
  assert.equal(quota.calls.every((call) => Array.isArray(JSON.parse(call.message)) && JSON.parse(call.message).length === 4), true);
  assert.equal(blocked.snapshot.items.every((item) => item.disposition === 'budget-deferred'), true);

  const rotated = open({
    env: {...googleKeys, AI_CENTER_READING_CLASS_BATCH: '10'},
    nodes: nodes.slice(0, 2),
    run(input, index) {
      if (index === 0) {
        const error = new Error('429 RESOURCE_EXHAUSTED');
        error.code = 'budget-deferred';
        throw error;
      }
      const message = JSON.parse(input.message);
      return {answer: JSON.stringify(message.map((item) => classified('ai', 'ai_application', item.title, item.idx)))};
    },
  });
  const rescued = await rotated.service.scoreWindow({workspace: 'local', window});
  assert.deepEqual(rotated.calls.map((call) => call.googleKeyEnv), ['GEMINI_API_KEY', 'GEMINI_API_KEY2']);
  assert.equal(rotated.calls.length, 2);
  assert.deepEqual(rescued.snapshot.items.map((item) => item.readingDirectionName), ['科技与AI', '科技与AI']);
});

test('batch size 1 keeps the per-item request and cache contract', async () => {
  const long = '字'.repeat(8001);
  const nodes = [node('a', '甲', {body: long}), node('b', '乙')];
  const {service, calls, saves} = open({
    env: {...googleKeys, AI_CENTER_READING_CLASS_BATCH: '1'},
    nodes,
    run(input) { return {answer: singleAnswer(JSON.parse(input.message))}; },
  });
  const result = await service.scoreWindow({workspace: 'local', window});
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.taskInstruction), [READING_CLASS_INSTRUCTION, READING_CLASS_INSTRUCTION]);
  assert.equal(calls.every((call) => call.googleKeyEnv === undefined), true);
  const first = JSON.parse(calls[0].message);
  assert.equal(first.idx, undefined);
  assert.equal(first.title, '甲');
  assert.equal(first.summary, '甲摘要');
  assert.equal(first.body.length, 8000);
  assert.equal(first.bodyChars, 8001);
  assert.equal(first.includedChars, 8000);
  assert.equal(first.inputScope, 'saved-body-prefix');
  assert.deepEqual(Object.keys(first).sort(), ['body', 'bodyChars', 'includedChars', 'inputScope', 'summary', 'title']);
  assert.equal(JSON.parse(calls[1].message).inputScope, 'saved-article');
  assert.equal(saves.length, 2);
  assert.equal(saves[0][1], 'reading-class');
  assert.equal(saves[0][2], 'reading-class:a:1');
  assert.equal(saves[0][3], READING_CLASS_VERSION);
  assert.deepEqual(saves[0][4], {inputScope: 'saved-body-prefix', includedChars: 8000, bodyChars: 8001});
  assert.equal(saves[0][6], 'completed');
  assert.equal(result.snapshot.items[0].classificationSource, 'classification-request');
  assert.equal(result.snapshot.items[0].inputScope, 'saved-body-prefix');
});

test('the default batch size sends ten items and does not split a non-quota request error', async () => {
  const nodes = Array.from({length: 11}, (_item, index) => node(`n${index}`, `标题${index}`));
  const sized = open({
    nodes,
    run(input) {
      const message = JSON.parse(input.message);
      return {answer: JSON.stringify(message.map((item) => classified('finance', 'market_asset', item.title, item.idx)))};
    },
  });
  await sized.service.scoreWindow({workspace: 'local', window});
  assert.deepEqual(sized.calls.map((call) => JSON.parse(call.message).length), [10, 1]);
  assert.equal(sized.calls.every((call) => call.googleKeyEnv === undefined && call.taskInstruction === readingClassBatchInstruction()), true);

  const failed = open({
    env: {AI_CENTER_READING_CLASS_BATCH: '10'},
    nodes: nodes.slice(0, 3),
    run() { throw new Error('upstream 500'); },
  });
  const result = await failed.service.scoreWindow({workspace: 'local', window});
  assert.equal(failed.calls.length, 1);
  assert.equal(result.snapshot.items.every((item) => item.disposition === 'classification-failed'), true);
});
