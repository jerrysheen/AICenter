import test from 'node:test';
import assert from 'node:assert/strict';
import {READING_CLASS_VERSION} from '../packages/domain/src/reading-focus-route.js';
import {READING_CLASS_BATCH_APPENDIX, READING_CLASS_INSTRUCTION, createReadingHourService, readingClassBatchInstruction, readingClassBatchSize, readingClassKeyEnvs, readingClassKeySuffix} from '../packages/domain/src/reading-hour-service.js';
import {hourlyReadingFlushRemainder} from '../packages/runtime/src/report-module.js';

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

function open({env = {}, nodes, stages = new Map(), run, log = () => {}}) {
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
    saveAnalysisStage(workspace, kind, key, version, input, output, status, error) {
      saves.push([workspace, kind, key, version, input, output, status, error]);
      stages.set(`${workspace}:${kind}:${key}:${version}`, {status, input, output, error});
    },
  };
  const agentRuntime = {async run(input) { calls.push(input); return run(input, calls.length - 1); }};
  const service = createReadingHourService({repository, reportRepository, agentRuntime, enabled: true, env, now: () => 5, log});
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
  assert.equal(readingClassKeySuffix('GEMINI_API_KEY'), 'KEY');
  assert.equal(readingClassKeySuffix('GEMINI_API_KEY2'), 'KEY2');
  assert.equal(readingClassKeySuffix(''), '-');
  assert.equal(hourlyReadingFlushRemainder(null), true);
  assert.equal(hourlyReadingFlushRemainder({pendingIds: [], pending: []}), true);
  assert.equal(hourlyReadingFlushRemainder({pendingIds: ['later'], pending: [{id: 'later', reason: 'information-not-ready', retryable: false}]}), false);
  assert.equal(hourlyReadingFlushRemainder({pendingIds: ['again'], pending: [{id: 'again', reason: 'budget-deferred', retryable: true}]}), false);
  assert.equal(hourlyReadingFlushRemainder({pendingIds: ['gone'], pending: [{id: 'gone', reason: 'needs-content', retryable: false}]}), true);
  assert.equal(hourlyReadingFlushRemainder({pendingIds: ['unknown']}), false);
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

test('items from separate arrivals pool into full batches and a closed hour flushes the remainder', async () => {
  const nodes = [];
  const lines = [];
  const pooled = open({
    env: {...googleKeys, AI_CENTER_READING_CLASS_BATCH: '4'},
    nodes,
    log: (line) => lines.push(line),
    run(input) {
      const message = JSON.parse(input.message);
      return {answer: JSON.stringify(message.map((item) => classified('finance', 'market_asset', item.title, item.idx)))};
    },
  });
  nodes.push(node('a', '甲'), node('b', '乙'));
  const held = await pooled.service.scoreWindow({workspace: 'local', window, flushRemainder: false});
  assert.equal(pooled.calls.length, 0);
  assert.equal(pooled.saves.length, 0);
  assert.equal(held.snapshot.items.every((item) => item.disposition === 'classification-missing'), true);
  nodes.push(node('c', '丙'), node('d', '丁'), node('e', '戊'));
  const partial = await pooled.service.scoreWindow({workspace: 'local', window, flushRemainder: false});
  assert.equal(pooled.calls.length, 1);
  assert.deepEqual(JSON.parse(pooled.calls[0].message).map((item) => item.title), ['甲', '乙', '丙', '丁']);
  assert.equal(partial.snapshot.items[4].disposition, 'classification-missing');
  assert.match(lines[0], /^\[worker\] reading-class batch=4 fallback=0 key=KEY outcome=ok status=- name=- model=- latencyMs=\d+ inputBytes=\d+$/);
  const flushed = await pooled.service.scoreWindow({workspace: 'local', window, flushRemainder: true});
  assert.equal(pooled.calls.length, 2);
  assert.deepEqual(JSON.parse(pooled.calls[1].message).map((item) => item.title), ['戊']);
  assert.match(lines[1], /^\[worker\] reading-class batch=1 fallback=0 key=KEY2 outcome=ok status=- name=- model=- latencyMs=\d+ inputBytes=\d+$/);
  assert.equal(lines.length, pooled.calls.length);
  assert.deepEqual(flushed.snapshot.items.map((item) => item.evidenceQuote), ['甲', '乙', '丙', '丁', '戊']);
});

test('a short remainder is not sent while the hour is still admitting items', async () => {
  const nodes = Array.from({length: 25}, (_item, index) => node(`n${index}`, `标题${index}`));
  const {service, calls} = open({
    env: {AI_CENTER_READING_CLASS_BATCH: '10'},
    nodes,
    run(input) {
      const message = JSON.parse(input.message);
      return {answer: JSON.stringify(message.map((item) => classified('industry', 'company_event', item.title, item.idx)))};
    },
  });
  const held = await service.scoreWindow({workspace: 'local', window, flushRemainder: false});
  assert.deepEqual(calls.map((call) => JSON.parse(call.message).length), [10, 10]);
  assert.equal(held.snapshot.items.filter((item) => item.disposition === 'classification-missing').length, 5);
  assert.equal(held.snapshot.items.filter((item) => item.evidenceQuote).length, 20);
});

test('classification logs record per-item fallback reason and quota does not log a fallback', async () => {
  const lines = [];
  const parsed = open({
    env: {...googleKeys, AI_CENTER_READING_CLASS_BATCH: '3'},
    nodes: [node('a', '甲'), node('b', '乙')],
    log: (line) => lines.push(line),
    run(input) {
      const message = JSON.parse(input.message);
      if (Array.isArray(message)) return {answer: '不是 JSON'};
      return {answer: singleAnswer(message)};
    },
  });
  await parsed.service.scoreWindow({workspace: 'local', window});
  assert.match(lines[0], /^\[worker\] reading-class batch=2 fallback=0 key=KEY outcome=ok status=- name=- model=- latencyMs=\d+ inputBytes=\d+$/);
  assert.match(lines[1], /^\[worker\] reading-class batch=1 fallback=1 reason=parse-failure key=- outcome=ok status=- name=- model=- latencyMs=\d+ inputBytes=\d+$/);
  assert.match(lines[2], /^\[worker\] reading-class batch=1 fallback=1 reason=parse-failure key=- outcome=ok status=- name=- model=- latencyMs=\d+ inputBytes=\d+$/);
  assert.equal(lines.length, parsed.calls.length);

  const quotaLines = [];
  const quota = open({
    env: {...googleKeys, AI_CENTER_READING_CLASS_BATCH: '10'},
    nodes: [node('a', '甲'), node('b', '乙'), node('c', '丙'), node('d', '丁')],
    log: (line) => quotaLines.push(line),
    run() {
      const error = new Error('quota=daily key=KEY cooldownUntil=1');
      error.code = 'budget-deferred';
      error.quotaExhausted = true;
      throw error;
    },
  });
  await quota.service.scoreWindow({workspace: 'local', window});
  assert.equal(quota.calls.length, 3);
  assert.equal(quotaLines.length, quota.calls.length);
  assert.match(quotaLines[0], /^\[worker\] reading-class batch=4 fallback=0 key=KEY outcome=budget-deferred status=- name=Error model=- latencyMs=\d+ inputBytes=\d+ body=- message=quota=daily key=KEY cooldownUntil=1$/);
  assert.match(quotaLines[1], /key=KEY2 outcome=budget-deferred /);
  assert.match(quotaLines[2], /key=KEY3 outcome=budget-deferred /);
  assert.equal(quotaLines.some((line) => line.includes('fallback=1')), false);
});

test('a non-quota batch error is logged once per call, retried on the next key, then deferred', async () => {
  const lines = [];
  const failed = open({
    env: {...googleKeys, AI_CENTER_READING_CLASS_BATCH: '10'},
    nodes: [node('a', '甲'), node('b', '乙')],
    log: (line) => lines.push(line),
    run(input) {
      const error = new Error('upstream 500 body');
      error.name = 'HarnessModelError';
      error.upstreamStatus = 500;
      error.upstreamBody = 'internal error token=sk-secretvalue';
      error.admittedModel = 'gemini-3.1-flash-lite';
      error.googleKeyEnv = input.googleKeyEnv;
      throw error;
    },
  });
  const result = await failed.service.scoreWindow({workspace: 'local', window});
  assert.equal(failed.calls.length, 2);
  assert.deepEqual(failed.calls.map((call) => call.googleKeyEnv), ['GEMINI_API_KEY', 'GEMINI_API_KEY2']);
  assert.equal(failed.calls[0].timeoutMs, 180000);
  assert.equal(lines.length, failed.calls.length);
  assert.match(lines[0], /batch=2 fallback=0 key=KEY outcome=error status=500 name=HarnessModelError model=gemini-3\.1-flash-lite latencyMs=\d+ inputBytes=\d+ body=internal error token=\[redacted\] message=upstream 500 body/);
  assert.match(lines[1], /key=KEY2 outcome=error status=500 /);
  assert.equal(lines[0].includes('\n'), false);
  assert.equal(result.snapshot.items.every((item) => item.disposition === 'classification-failed'), true);

  const onlyKey = open({
    env: {...googleKeys, AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY', GEMINI_API_KEY2: '', GEMINI_API_KEY3: '', AI_CENTER_READING_CLASS_BATCH: '10'},
    nodes: [node('a', '甲')],
    run() { throw new Error('upstream 500'); },
  });
  await onlyKey.service.scoreWindow({workspace: 'local', window});
  assert.equal(onlyKey.calls.length, 1);
});

test('a timeout retries one other key and a quota rejection between errors does not use that retry', async () => {
  const recoveredLines = [];
  const recovered = open({
    env: {...googleKeys, AI_CENTER_READING_CLASS_BATCH: '2'},
    nodes: [node('a', '甲'), node('b', '乙')],
    log: (line) => recoveredLines.push(line),
    run(input) {
      if (input.googleKeyEnv === 'GEMINI_API_KEY') {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      }
      const message = JSON.parse(input.message);
      return {answer: JSON.stringify(message.map((item) => classified('finance', 'market_asset', item.title, item.idx))), modelId: 'gemini-3.1-flash-lite'};
    },
  });
  const saved = await recovered.service.scoreWindow({workspace: 'local', window});
  assert.deepEqual(recovered.calls.map((call) => call.googleKeyEnv), ['GEMINI_API_KEY', 'GEMINI_API_KEY2']);
  assert.equal(recoveredLines.length, 2);
  assert.match(recoveredLines[0], /key=KEY outcome=timeout status=- name=AbortError /);
  assert.match(recoveredLines[1], /key=KEY2 outcome=ok status=- name=- model=gemini-3\.1-flash-lite /);
  assert.deepEqual(saved.snapshot.items.map((item) => item.evidenceQuote), ['甲', '乙']);

  const mixed = open({
    env: {...googleKeys, AI_CENTER_READING_CLASS_BATCH: '2'},
    nodes: [node('a', '甲'), node('b', '乙')],
    run(input) {
      if (input.googleKeyEnv === 'GEMINI_API_KEY2') {
        const error = new Error('quota=daily');
        error.code = 'budget-deferred';
        error.quotaExhausted = true;
        throw error;
      }
      const error = new Error('upstream 500');
      error.upstreamStatus = 500;
      throw error;
    },
  });
  await mixed.service.scoreWindow({workspace: 'local', window});
  assert.deepEqual(mixed.calls.map((call) => call.googleKeyEnv), ['GEMINI_API_KEY', 'GEMINI_API_KEY2', 'GEMINI_API_KEY3']);
});

test('a one-item object is accepted and a multi-item object still falls back', async () => {
  const single = open({
    env: {AI_CENTER_READING_CLASS_BATCH: '10'},
    nodes: [node('a', '甲')],
    run() {
      return {answer: JSON.stringify({primaryDirection: 'finance', subjectKind: 'market_asset', domainTagIds: [], classificationStatus: 'classified', evidenceQuote: '甲句'})};
    },
  });
  const saved = await single.service.scoreWindow({workspace: 'local', window});
  assert.equal(single.calls.length, 1);
  assert.equal(saved.snapshot.items[0].evidenceQuote, '甲句');

  const many = open({
    env: {AI_CENTER_READING_CLASS_BATCH: '10'},
    nodes: [node('a', '甲'), node('b', '乙'), node('c', '丙')],
    run(input) {
      const message = JSON.parse(input.message);
      if (Array.isArray(message)) {
        return {answer: JSON.stringify({primaryDirection: 'finance', subjectKind: 'market_asset', domainTagIds: [], classificationStatus: 'classified', evidenceQuote: '只一条'})};
      }
      return {answer: singleAnswer(message)};
    },
  });
  await many.service.scoreWindow({workspace: 'local', window});
  assert.equal(many.calls.length, 4);
  assert.equal(many.calls[0].taskInstruction, readingClassBatchInstruction());
  assert.deepEqual(many.calls.slice(1).map((call) => call.taskInstruction), [READING_CLASS_INSTRUCTION, READING_CLASS_INSTRUCTION, READING_CLASS_INSTRUCTION]);
});
