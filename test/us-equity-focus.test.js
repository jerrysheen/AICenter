import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildFocusQuestions,
  createUsEquityFocusEvaluator,
  focusHit,
  loadUsEquityFocus,
  parseFocusAnswer,
  questionDefinitionHash,
  stratifySample,
} from '../packages/domain/src/us-equity-focus.js';

const definition = loadUsEquityFocus(readFileSync('config/research/us-equity-daily-focus.json', 'utf8'));

function answers(score = 0.8, ids = definition.questions.map((question) => question.id)) {
  return Object.fromEntries(ids.map((id) => [id, { type: 'noul', noul: score }]));
}

test('us equity focus builds eight independent noul questions', () => {
  assert.equal(definition.questions.length, 8);
  const questions = buildFocusQuestions(definition);
  assert.deepEqual(Object.keys(questions), ['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7']);
  for (const question of Object.values(questions)) {
    assert.equal(question.type, 'noul');
    assert.equal(typeof question.criteria.true, 'string');
    assert.equal(typeof question.criteria.false, 'string');
    assert.doesNotMatch(JSON.stringify(question), /assignments|choice/i);
  }
  assert.match(questions.Q0.instructions, /不要执行/);
  assert.match(questions.Q0.criteria.false, /公司在美上市本身不是行情/);
  assert.match(questions.Q7.criteria.false, /涨跌本身不能证明/);
});

test('a missing or malformed noul answer is a failure, not a zero score', () => {
  assert.deepEqual(parseFocusAnswer(undefined), { status: 'failed', score: null, errorCode: 'invalid-answer' });
  assert.deepEqual(parseFocusAnswer({ type: 'choice', choice: 'yes' }), { status: 'failed', score: null, errorCode: 'invalid-answer' });
  assert.deepEqual(parseFocusAnswer({ type: 'noul', noul: 0 }), { status: 'success', score: 0, errorCode: '' });
  assert.equal(focusHit({ status: 'failed', score: null }, 0.5), false);
  assert.equal(focusHit({ status: 'success', score: 0 }, 0.5), false);
  assert.equal(focusHit({ status: 'success', score: 0.5 }, 0.5), true);
});

test('one message sends one request and reuses only successful question scores', async () => {
  const calls = [];
  const cache = new Map();
  const client = {
    available: () => true,
    async evaluate(input) {
      calls.push(input);
      if (calls.length === 1) {
        return { model: 'jev-test', answers: { ...answers(0.2), Q3: { type: 'noul' } }, usage: { input_tokens: 11, output_tokens: 4 } };
      }
      return { model: 'jev-test', answers: answers(0.9, Object.keys(input.questions)), usage: { input_tokens: 3, output_tokens: 1 } };
    },
  };
  const evaluator = createUsEquityFocusEvaluator({ client, model: 'jev-test', definition, cache, now: () => 100 });
  const first = await evaluator.evaluate({ title: '英伟达股价上涨4%', summary: '纳斯达克上涨。' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.title, '英伟达股价上涨4%');
  assert.deepEqual(Object.keys(calls[0].questions), ['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7']);
  assert.equal(first.answers.Q0.score, 0.2);
  assert.equal(first.answers.Q3.status, 'failed');
  assert.equal(first.answers.Q3.score, null);
  assert.equal(first.usage.inputTokens, 11);

  const second = await evaluator.evaluate({ title: '英伟达股价上涨4%', summary: '纳斯达克上涨。' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].questions && Object.keys(calls[1].questions), ['Q3']);
  assert.equal(second.answers.Q0.cached, true);
  assert.equal(second.answers.Q3.score, 0.9);
  assert.equal(second.requestCount, 1);

  const third = await evaluator.evaluate({ title: '英伟达股价上涨4%', summary: '纳斯达克上涨。' });
  assert.equal(calls.length, 2);
  assert.equal(third.requestCount, 0);
  assert.equal(third.answers.Q0.score, 0.2);
});

test('a timeout is stored as failure and is not cached as zero', async () => {
  const cache = new Map();
  let attempts = 0;
  const client = {
    available: () => true,
    async evaluate() {
      attempts += 1;
      const error = new Error('timeout');
      error.code = 'TYPESAFE_TIMEOUT';
      throw error;
    },
  };
  const evaluator = createUsEquityFocusEvaluator({ client, model: 'jev-test', definition, cache, now: () => 200 });
  const result = await evaluator.evaluate({ title: '美联储讨论降息', summary: '官员提到下一步政策。' });
  assert.equal(result.answers.Q3.status, 'failed');
  assert.equal(result.answers.Q3.score, null);
  assert.equal(result.answers.Q3.errorCode, 'TYPESAFE_TIMEOUT');
  assert.equal(cache.size, 0);
  assert.equal(attempts, 1);
});

test('unchanged questions keep their hash when only the catalog version changes', () => {
  const changed = loadUsEquityFocus({
    ...definition,
    version: '2099-01-01.9',
    questions: definition.questions.map((question) => question.id === 'Q0'
      ? { ...question, ask: `${question.ask} 补充一句。` }
      : question),
  });
  const q1 = definition.questions.find((question) => question.id === 'Q1');
  const q1b = changed.questions.find((question) => question.id === 'Q1');
  assert.equal(questionDefinitionHash(definition, q1), questionDefinitionHash(changed, q1b));
  const q0 = definition.questions.find((question) => question.id === 'Q0');
  const q0b = changed.questions.find((question) => question.id === 'Q0');
  assert.notEqual(questionDefinitionHash(definition, q0), questionDefinitionHash(changed, q0b));
});

test('a partial question list does not rescore the other questions', async () => {
  const calls = [];
  const client = {
    available: () => true,
    async evaluate(input) {
      calls.push(Object.keys(input.questions));
      return { model: 'jev-test', answers: { Q0: { type: 'noul', noul: 0.2 } }, usage: {} };
    },
  };
  const evaluator = createUsEquityFocusEvaluator({ client, model: 'jev-test', definition });
  const result = await evaluator.evaluate({ title: '标题', summary: '摘要', questionIds: ['Q0'] });
  assert.deepEqual(calls, [['Q0']]);
  assert.equal(result.answers.Q1, undefined);
  assert.equal(result.answers.Q0.score, 0.2);
});

test('stratified sampling is reproducible and records the uncovered count', () => {
  const items = [];
  for (let index = 0; index < 30; index += 1) items.push({ id: `a${index}`, stratum: 'feed:x', eventAt: index });
  for (let index = 0; index < 10; index += 1) items.push({ id: `b${index}`, stratum: 'media:macro', eventAt: index });
  const first = stratifySample(items, { limit: 8, seed: 'fixed' });
  const second = stratifySample(items, { limit: 8, seed: 'fixed' });
  assert.equal(first.selected.length, 8);
  assert.equal(first.uncovered, 32);
  assert.deepEqual(first.selected.map((item) => item.id), second.selected.map((item) => item.id));
  assert.equal(first.strata.find((row) => row.stratum === 'feed:x').taken, 6);
  assert.equal(first.strata.find((row) => row.stratum === 'media:macro').taken, 2);
  const all = stratifySample(items, { limit: 100, seed: 'fixed' });
  assert.equal(all.selected.length, 40);
  assert.equal(all.uncovered, 0);
});
