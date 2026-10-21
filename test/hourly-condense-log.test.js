import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../packages/database/src/index.js';
import {createInformationTreeService} from '../packages/domain/src/information-tree-service.js';
import {loadInformationTreeSkills} from '../packages/runtime/src/information-tree/skills.js';
import {cachedFlashQuotaWait, classifyCondenseError, formatCondenseFailureLog, formatTreeHourlyCallLog, redactCondenseLog, treeHourlyFinishReason} from '../packages/domain/src/information-tree-policy.js';
import {createReportJobHandlers} from '../packages/runtime/src/report-module.js';

const H = 3600000;
const start = 10 * H;
const body = `UNIQUE_BODY_MARKER_9f3a${'。'.repeat(80)}`;

test('condense error kinds stay distinct and logs redact secrets', () => {
  assert.equal(classifyCondenseError(Object.assign(new Error('模型调用失败：500: down'), {name: 'HarnessModelError', upstreamStatus: 500, upstreamCode: '500'})).kind, 'model-5xx');
  assert.equal(classifyCondenseError(Object.assign(new Error('模型调用失败：429: slow'), {name: 'HarnessModelError', upstreamStatus: 429})).kind, 'model-4xx');
  assert.equal(classifyCondenseError(Object.assign(new Error('模型调用失败：PI_AI_ERROR: Request could not be completed.'), {name: 'HarnessModelError', upstreamCode: 'PI_AI_ERROR'})).kind, 'model-error');
  assert.equal(classifyCondenseError(new Error('Harness 没有返回回答')).kind, 'model-empty');
  assert.equal(classifyCondenseError(Object.assign(new SyntaxError('Unexpected token'), {code: 'invalid-output'})).kind, 'parse');
  assert.equal(classifyCondenseError(Object.assign(new Error('模型执行超时，已停止本轮调用'), {name: 'ModelExecutionTimeout'})).kind, 'timeout-execution');
  assert.equal(classifyCondenseError(Object.assign(new Error('等待模型执行队列超时；本轮未获得执行机会'), {name: 'ModelQueueTimeout'})).kind, 'timeout-queue');
  assert.equal(classifyCondenseError(Object.assign(new Error('阶段总耗时预算耗尽；已完成检查点保留'), {name: 'StageBudgetTimeout'})).kind, 'timeout-budget');
  assert.equal(classifyCondenseError(Object.assign(new Error('浓缩树预算耗尽'), {code: 'budget-deferred'})).kind, 'timeout-budget');
  assert.equal(classifyCondenseError(new Error('单条输入超过预算，须在信息阶段处理完整内容块')).kind, 'input-too-long');
  assert.equal(classifyCondenseError(Object.assign(new Error('完整请求超过文章整理预算；保留原文待处理'), {code: 'budget-deferred'})).kind, 'input-too-long');
  const cached = classifyCondenseError(Object.assign(new Error('retryable-model-error'), {code: 'retryable-model-error', priorError: '模型调用失败：503: upstream', cachedPending: {reason: 'retryable-model-error'}}));
  assert.equal(cached.kind, 'model-5xx');
  assert.equal(cached.status, 503);
  const secret = '模型调用失败：500: bad AIzaSyDUMMYKEY1234567890 authorization: Bearer abc.def.ghi sk-supersecretvalue api_key=plain-secret';
  const redacted = redactCondenseLog(secret);
  assert.equal(redacted.includes('AIzaSyDUMMYKEY1234567890'), false);
  assert.equal(redacted.includes('sk-supersecretvalue'), false);
  assert.equal(redacted.includes('abc.def.ghi'), false);
  assert.equal(redacted.includes('plain-secret'), false);
  assert.match(redacted, /\[redacted\]/);
  assert.equal(redactCondenseLog('x'.repeat(800)).length, 500);
  const line = formatCondenseFailureLog(Object.assign(new Error(secret), {name: 'HarnessModelError', upstreamStatus: 500, upstreamCode: '500', timing: {queueMs: 12, executionMs: 3400}}), {
    layer: 'hourly', task: 'hourly-brief', provider: 'elucid-grok', model: 'sk-not-a-model-name-123456', tagId: 'macro', windowStart: start,
    inputCount: 3, inputBytes: 4096, skillBytes: 1800, calls: 2, elapsedMs: 3500,
  });
  assert.match(line, /kind=model-5xx/);
  assert.match(line, /status=500/);
  assert.match(line, /inputs=3/);
  assert.match(line, /inputBytes=4096/);
  assert.match(line, /queueMs=12/);
  assert.match(line, /executionMs=3400/);
  assert.match(line, /provider=elucid-grok/);
  assert.match(line, /model=-/);
  assert.match(line, /key=-/);
  assert.match(line, /body=-/);
  assert.match(line, /inputChars=-/);
  assert.match(line, /finish=-/);
  assert.equal(line.includes('AIzaSyDUMMYKEY1234567890'), false);
  assert.equal(line.includes(body), false);
  const detailed = formatCondenseFailureLog(Object.assign(new Error('模型调用失败：429: slow'), {
    name: 'HarnessModelError', upstreamStatus: 429, upstreamCode: '429', googleKeyEnv: 'GEMINI_API_KEY2', admittedModel: 'gemini-3.1-flash-lite',
    finishReason: 'MAX_TOKENS', inputBytes: 8000, inputChars: 4200,
    upstreamBody: '{"error":{"message":"truncated AIzaSyDUMMYKEY1234567890"}}',
  }), {layer: 'hourly', task: 'hourly-brief', provider: 'google', model: 'gemini-3.1-flash-lite', inputCount: 6, inputBytes: 12000, inputChars: 9000});
  assert.match(detailed, /status=429/);
  assert.match(detailed, /model=gemini-3\.1-flash-lite/);
  assert.match(detailed, /key=KEY2/);
  assert.match(detailed, /inputBytes=8000/);
  assert.match(detailed, /inputChars=4200/);
  assert.match(detailed, /finish=MAX_TOKENS/);
  assert.match(detailed, /body=.*\[redacted\]/);
  assert.equal(detailed.includes('AIzaSyDUMMYKEY1234567890'), false);
});

test('hourly condense failure log keeps the cause and omits prompt text', async () => {
  const store = createStore(':memory:');
  const calls = [];
  const skills = loadInformationTreeSkills();
  const runtime = {async run(input) {
    calls.push(input);
    const payload = JSON.parse(input.message);
    if (input.usageStage === 'tree-hourly') {
      throw Object.assign(new Error('模型调用失败：500: upstream AIzaSyDUMMYKEY1234567890'), {
        name: 'HarnessModelError', upstreamStatus: 500, upstreamCode: '500', googleKeyEnv: 'GEMINI_API_KEY3',
        upstreamBody: '{"error":{"message":"upstream AIzaSyDUMMYKEY1234567890"}}', finishReason: 'OTHER',
      });
    }
    return {answer: JSON.stringify({title: payload.source.title, text: payload.source.paragraphs.map(item => item.text).join(''), tagId: null})};
  }};
  const service = createInformationTreeService({
    repository: store.repositories.informationTree,
    reportRepository: store.repositories.report,
    agentRuntime: runtime,
    skills,
    generationConfig: {'hourly-brief': {provider: 'elucid-grok', model: 'grok-4.7', apiKey: 'must-not-log'}},
    sleep: async () => {},
  });
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(item => String(item)).join(' ')); };
  try {
    const material = {id: 'a', title: '标题', publishedAt: start + 1, updatedAt: start + 2, version: '1', contentLevel: 'full', paragraphs: [{role: 'body', text: body}], sourceRefs: []};
    const hour = await service.generateHour({hourStart: start, materials: [material]});
    assert.equal(hour.status, 'failed');
    assert.equal(hour.groupFailures[0].reason, 'retryable-model-error');
    const logged = lines.filter(line => line.includes('浓缩失败'));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /layer=hourly/);
    assert.match(logged[0], /task=hourly-brief/);
    assert.match(logged[0], /kind=model-5xx/);
    assert.match(logged[0], /status=500/);
    assert.match(logged[0], /provider=elucid-grok/);
    assert.match(logged[0], /model=grok-4\.7/);
    assert.match(logged[0], /inputs=1/);
    assert.match(logged[0], /inputBytes=\d+/);
    assert.match(logged[0], /inputChars=\d+/);
    assert.match(logged[0], /key=KEY3/);
    assert.match(logged[0], /status=500/);
    assert.match(logged[0], /finish=OTHER/);
    assert.match(logged[0], /body=.*\[redacted\]/);
    assert.match(logged[0], /skillBytes=\d+/);
    assert.match(logged[0], /queueMs=\d+/);
    assert.match(logged[0], /executionMs=\d+/);
    assert.match(logged[0], /cached=0/);
    assert.equal(logged[0].includes('AIzaSyDUMMYKEY1234567890'), false);
    assert.equal(logged[0].includes('must-not-log'), false);
    assert.equal(logged[0].includes('UNIQUE_BODY_MARKER_9f3a'), false);
    const diagnostic = hour.condenseDiagnostics[0];
    assert.equal(diagnostic.kind, 'model-5xx');
    assert.equal(diagnostic.code, '500');
    assert.equal(diagnostic.httpStatus, 500);
    assert.equal(diagnostic.model, 'grok-4.7');
    assert.equal(diagnostic.group, '未分类');
    assert.equal(Number.isFinite(diagnostic.durationMs), true);
    assert.equal(diagnostic.message.includes('AIzaSyDUMMYKEY1234567890'), false);
    assert.equal(diagnostic.message.includes('must-not-log'), false);
    assert.equal(diagnostic.message.includes('UNIQUE_BODY_MARKER_9f3a'), false);
    assert.equal(JSON.stringify(hour).includes('condenseDiagnostics'), false);
    const stored = store.repositories.informationTree.getEdition('local', hour.id);
    assert.equal(stored.condenseDiagnostics, undefined);
    assert.equal(JSON.stringify(stored).includes('AIzaSyDUMMYKEY1234567890'), false);
    const bridge = createReportJobHandlers({
      reportService: {generateDailyReport() {}},
      treeService: {},
      informationService: {async generateHourlyDigests() { return [hour]; }},
    });
    await assert.rejects(bridge['report.hourly.extract']({hourStart: start}), (error) => {
      assert.equal(error.message, '小时浓缩临时失败；成功分类及检查点已保留');
      assert.equal(error.reportFailure.kind, 'model-5xx');
      assert.equal(error.reportFailure.code, '500');
      assert.equal(error.reportFailure.httpStatus, 500);
      assert.equal(error.reportFailure.model, 'grok-4.7');
      assert.equal(error.reportFailure.message.includes('AIzaSyDUMMYKEY1234567890'), false);
      return true;
    });
    const before = calls.length;
    const cooledHour = await service.generateHour({hourStart: start, materials: [material]});
    assert.equal(calls.length, before);
    const cooled = lines.filter(line => line.includes('浓缩失败'));
    assert.equal(cooled.length, 2);
    assert.match(cooled[1], /cached=1/);
    assert.match(cooled[1], /kind=model-5xx/);
    assert.equal(cooled[1].includes('AIzaSyDUMMYKEY1234567890'), false);
    assert.equal(cooled[1].includes('UNIQUE_BODY_MARKER_9f3a'), false);
    assert.equal(cooledHour.condenseDiagnostics[0].kind, 'model-5xx');
    assert.equal(cooledHour.condenseDiagnostics[0].message.includes('AIzaSyDUMMYKEY1234567890'), false);
  } finally {
    console.error = original;
    store.close();
  }
});

test('a cached Flash quota wait is retried so the hour can fall back', async () => {
  assert.equal(cachedFlashQuotaWait({
    status: 'failed',
    error: 'quota=window key=- model=gemini-3.5-flash-lite cooldownUntil=1 Gemini 文章任务等待流量窗口',
    input: { failure: { reason: 'budget-deferred', retryAt: Date.now() + 3600000 } },
  }), true);
  assert.equal(cachedFlashQuotaWait({
    status: 'failed',
    error: '浓缩树预算耗尽',
    input: { failure: { reason: 'budget-deferred', retryAt: Date.now() + 3600000 } },
  }), false);
  const store = createStore(':memory:');
  const calls = [];
  const skills = loadInformationTreeSkills();
  let hourlyCalls = 0;
  const runtime = {async run(input) {
    calls.push(input.usageStage);
    if (input.usageStage === 'tree-hourly' && hourlyCalls === 0) {
      hourlyCalls += 1;
      throw Object.assign(new Error('quota=daily key=- model=gemini-3.5-flash-lite cooldownUntil=999 Gemini 文章任务等待流量窗口'), {
        code: 'budget-deferred', retryAt: Date.now() + 3600000,
      });
    }
    if (input.usageStage === 'tree-hourly') {
      hourlyCalls += 1;
      return { answer: JSON.stringify({ modules: [{ title: '小时', text: '补上了', tagId: null, inputIds: ['n1'] }] }) };
    }
    const payload = JSON.parse(input.message);
    return { answer: JSON.stringify({ title: payload.source.title, text: payload.source.paragraphs.map(item => item.text).join(''), tagId: null }) };
  }};
  const service = createInformationTreeService({
    repository: store.repositories.informationTree,
    reportRepository: store.repositories.report,
    agentRuntime: runtime,
    skills,
    sleep: async () => {},
  });
  try {
    const material = {id: 'quota-a', title: '标题', publishedAt: start + 1, updatedAt: start + 2, version: '1', contentLevel: 'full', paragraphs: [{role: 'body', text: body}], sourceRefs: []};
    const failed = await service.generateHour({hourStart: start, materials: [material]});
    assert.equal(failed.groupFailures.some(item => item.reason === 'budget-deferred'), true);
    const again = await service.generateHour({hourStart: start, materials: [material]});
    assert.equal(hourlyCalls, 2);
    assert.equal(again.groupFailures.some(item => item.reason === 'budget-deferred'), false);
  } finally {
    store.close();
  }
});

test('hourly job still throws the generic message and logs group reasons', async () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(item => String(item)).join(' ')); };
  try {
    const handlers = createReportJobHandlers({
      reportService: {generateDailyReport() {}},
      treeService: {},
      informationService: {async generateHourlyDigests() {
        return [{id: 'edition:failed', status: 'failed', published: false, window: {startAt: start, endAt: start + H}, pendingIds: [], groupFailures: [
          {id: 'tree-hourly:1', reason: 'execution-timeout', retryable: true, retryAt: start, tagId: 'macro', queueMs: 40, executionMs: 180000},
        ]}];
      }},
    });
    await assert.rejects(handlers['report.hourly.extract']({hourStart: start}), {message: '小时浓缩临时失败；成功分类及检查点已保留'});
    assert.match(lines.join('\n'), /小时浓缩临时失败 groups=1 retryable=1 tag=macro reason=execution-timeout queueMs=40 executionMs=180000/);
  } finally {
    console.error = original;
  }
});

test('tree-hourly finishReason keeps the full enum and only body and message are shortened', () => {
  const full = `MAX_TOKENS_${'H'.repeat(80)}`;
  assert.equal(treeHourlyFinishReason({kind: 'max-tokens'}), 'max-tokens');
  assert.equal(treeHourlyFinishReason({kind: 'error', finishReason: 'SAFETY'}), 'SAFETY');
  assert.equal(treeHourlyFinishReason('HarnessModelError'), 'HarnessModelError');
  const line = formatTreeHourlyCallLog({
    error: Object.assign(new Error('m'.repeat(400)), {
      name: 'HarnessModelError', upstreamStatus: 500, upstreamBody: 'b'.repeat(400), finishReason: 'HarnessModelError',
    }),
    finishReason: {kind: 'max-tokens', finishReason: full},
  });
  assert.match(line, new RegExp(`finishReason=${full}( |$)`));
  assert.equal(line.includes('Ha…'), false);
  assert.equal(line.includes('HarnessModelError'), false);
  const body = line.split(' ').find((part) => part.startsWith('body='));
  const message = line.split(' ').find((part) => part.startsWith('message='));
  assert.equal(body.slice('body='.length).length, 300);
  assert.equal(message.slice('message='.length).length, 300);
  const named = formatTreeHourlyCallLog({finishReason: 'HarnessModelError'});
  assert.match(named, /finishReason=HarnessModelError /);
});
