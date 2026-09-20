import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDoubaoWebSearchPrompt,
  createDoubaoAuxiliarySearch,
  noteFromDoubaoAsk,
} from '../packages/connectors/src/doubao/search.js';
import {
  appendAuxiliarySearchNote,
  auxiliarySearchWarning,
  takeAuxiliarySearch,
} from '../packages/runtime/src/auxiliary-web-search.js';
import { createOptionalAuxiliarySearch } from '../apps/worker/src/worker.js';

test('doubao web search prompt asks for public facts without investment advice', () => {
  const prompt = buildDoubaoWebSearchPrompt({
    question: '今天美联储有没有加息',
    query: 'FOMC September 2026',
  });
  assert.match(prompt, /公开网页/);
  assert.match(prompt, /不要投资建议/);
  assert.match(prompt, /今天美联储有没有加息/);
  assert.match(prompt, /FOMC September 2026/);
});

test('doubao ask note keeps ok replies and drops login or empty status', () => {
  assert.equal(noteFromDoubaoAsk({ status: 'ok', reply_text: ' 维持利率。 ' }), '维持利率。');
  assert.equal(noteFromDoubaoAsk({ status: 'login_required', reply_text: '不应采用' }), '');
  assert.equal(noteFromDoubaoAsk(null), '');
});

test('doubao auxiliary search begins one queued ask and normalizes the reply', async () => {
  const asks = [];
  const port = createDoubaoAuxiliarySearch({
    queue: {
      ask(question, askOptions) {
        asks.push({ question, askOptions });
        return Promise.resolve({ status: 'ok', reply_text: '来源：美联储。决定：维持利率。' });
      },
    },
  });
  const handle = port.begin({ question: '今天加息了吗', query: 'FOMC' });
  const settled = await handle.promise;
  assert.equal(asks.length, 1);
  assert.equal(asks[0].askOptions.purpose, 'web-search');
  assert.match(asks[0].question, /今天加息了吗/);
  assert.equal(settled.status, 'ok');
  assert.match(settled.text, /维持利率/);
});

test('auxiliary note is appended only when text exists, and a late ask is not awaited', async () => {
  assert.equal(appendAuxiliarySearchNote('模型回答', ''), '模型回答');
  assert.match(appendAuxiliarySearchNote('模型回答', '公开报道维持利率。'), /### 补充资讯/);
  assert.match(appendAuxiliarySearchNote('模型回答', '公开报道维持利率。'), /模型回答/);
  assert.match(auxiliarySearchWarning({ status: 'login_required' }), /需要先登录网页助手/);
  assert.equal(auxiliarySearchWarning({ status: 'login_required' }).includes('豆包'), false);

  const pending = takeAuxiliarySearch({
    startedAt: Date.now() - 80_000,
    promise: new Promise(() => {}),
  }, { graceMs: 35_000, budgetMs: 80_000 });
  const settled = await pending;
  assert.equal(settled, null);
});

test('worker only creates auxiliary search when browser is available and not disabled', () => {
  assert.equal(createOptionalAuxiliarySearch(undefined, { withSession() {} }, {
    AI_CENTER_DOUBAO_SEARCH_DISABLED: '1',
  }), null);
  assert.equal(createOptionalAuxiliarySearch(undefined, null, {}), null);
  assert.equal(createOptionalAuxiliarySearch(null, { withSession() {} }, {}), null);
  const port = createOptionalAuxiliarySearch(undefined, { withSession() {} }, {});
  assert.equal(typeof port.begin, 'function');
});

test('aborted begin does not enqueue a Doubao ask', async () => {
  const asks = [];
  const port = createDoubaoAuxiliarySearch({
    queue: {
      ask(question) {
        asks.push(question);
        return Promise.resolve({ status: 'ok', reply_text: '不应发出' });
      },
    },
  });
  const handle = port.begin({
    question: '今天加息了吗',
    query: 'FOMC',
    signal: { aborted: true },
  });
  const settled = await handle.promise;
  assert.deepEqual(asks, []);
  assert.equal(settled.status, 'aborted');
  assert.equal(settled.text, '');
});
