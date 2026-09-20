import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWaitSnapshot,
  appendFillExpression,
  beginFillExpression,
  commitFillExpression,
  confirmSend,
  createWaitAccumulator,
  createDoubaoChatClient,
  splitFillChunks,
  toTipTapHtml,
} from '../packages/connectors/src/doubao/chat-browser.js';

test('TipTap HTML escapes the question', () => {
  assert.equal(toTipTapHtml('a<b>\nc'), '<p>a&lt;b&gt;</p><p>c</p>');
});

test('long Doubao fill is split into short evaluate chunks', () => {
  const html = `<p>${'汉'.repeat(4_000)}</p>`;
  const chunks = splitFillChunks(html, 1_500);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks.join(''), html);
  assert.ok(appendFillExpression(chunks[0]).length < 4_000);
  assert.match(beginFillExpression(), /__AI_CENTER_DOUBAO_HTML/);
  assert.match(commitFillExpression(), /setContent/);
});

test('send is confirmed by echo, cleared input, streaming or chat url', () => {
  assert.equal(confirmSend({
    editorEmpty: false,
    userMessages: [],
    generating: false,
    url: 'https://www.doubao.com/chat',
  }, 'hello').sendConfirmed, false);
  assert.equal(confirmSend({
    editorEmpty: true,
    userMessages: [],
    url: 'https://www.doubao.com/chat',
  }, 'hello').sendConfirmed, true);
  assert.equal(confirmSend({
    editorEmpty: false,
    userMessages: ['hello'],
    url: 'https://www.doubao.com/chat',
  }, 'hello').questionEchoed, true);
  assert.equal(confirmSend({
    editorEmpty: false,
    userMessages: [],
    streaming: true,
    url: 'https://www.doubao.com/chat',
  }, 'hello').generationObserved, true);
  assert.equal(confirmSend({
    editorEmpty: false,
    userMessages: [],
    url: 'https://www.doubao.com/chat/38442187632877058',
  }, 'hello').urlChanged, true);
});

test('wait uses an earlier assistant bubble when the latest is a follow-up', () => {
  let acc = createWaitAccumulator(0);
  const facts = '公开报道：美联储维持利率。来源：美联储。';
  const ctx = {
    startedAt: 0,
    beforeReplyCount: 1,
    idleTimeoutMs: 30_000,
    maxTimeoutMs: 180_000,
    stableChecks: 1,
    isComplete: (text) => text.includes('维持利率'),
  };
  let stepped = applyWaitSnapshot(acc, {
    assistantReplies: ['#0', facts, '还需要我继续补充吗？'],
    generating: false,
  }, { ...ctx, now: 100 });
  acc = stepped.acc;
  stepped = applyWaitSnapshot(acc, {
    assistantReplies: ['#0', facts, '还需要我继续补充吗？'],
    generating: false,
  }, { ...ctx, now: 200 });
  assert.equal(stepped.done, true);
  assert.equal(stepped.acc.lastCandidate.includes('维持利率'), true);
});

test('wait does not finish while assistant text is still growing, even past max timeout', () => {
  let acc = createWaitAccumulator(0);
  const ctx = {
    startedAt: 0,
    beforeReplyCount: 0,
    idleTimeoutMs: 5_000,
    maxTimeoutMs: 1_000,
    stableChecks: 2,
  };
  let stepped = applyWaitSnapshot(acc, { assistantReplies: ['公开报道：'], generating: true }, { ...ctx, now: 2_000 });
  acc = stepped.acc;
  assert.equal(stepped.done, false);
  stepped = applyWaitSnapshot(acc, { assistantReplies: ['公开报道：美联储维持'], generating: true }, { ...ctx, now: 3_000 });
  assert.equal(stepped.done, false);
  assert.equal(stepped.grewThisPoll, true);
});

test('wait takes a settled reply without calling it a timeout while streaming flag is stuck', () => {
  let acc = createWaitAccumulator(0);
  const ctx = {
    startedAt: 0,
    beforeReplyCount: 0,
    idleTimeoutMs: 400,
    maxTimeoutMs: 180_000,
    stableChecks: 2,
  };
  const reply = '公开报道：美联储维持利率。来源：美联储。';
  let stepped = applyWaitSnapshot(acc, { assistantReplies: [reply], generating: true }, { ...ctx, now: 100 });
  acc = stepped.acc;
  stepped = applyWaitSnapshot(acc, { assistantReplies: [reply], generating: true }, { ...ctx, now: 200 });
  acc = stepped.acc;
  stepped = applyWaitSnapshot(acc, { assistantReplies: [reply], generating: true }, { ...ctx, now: 800 });
  assert.equal(stepped.done, true);
  assert.equal(stepped.completion, 'complete');
});

test('wait does not idle-abort while Doubao is still generating with no text yet', () => {
  let acc = createWaitAccumulator(0);
  const ctx = {
    startedAt: 0,
    beforeReplyCount: 0,
    idleTimeoutMs: 5_000,
    maxTimeoutMs: 20_000,
    stableChecks: 2,
  };
  const stepped = applyWaitSnapshot(acc, { assistantReplies: [], generating: true }, { ...ctx, now: 8_000 });
  assert.equal(stepped.done, false);
});

test('wait finishes after assistant text stops growing', () => {
  let acc = createWaitAccumulator(0);
  const ctx = {
    startedAt: 0,
    beforeReplyCount: 0,
    idleTimeoutMs: 5_000,
    maxTimeoutMs: 20_000,
    stableChecks: 2,
  };
  let stepped = applyWaitSnapshot(acc, { assistantReplies: ['DO'], generating: true }, { ...ctx, now: 100 });
  acc = stepped.acc;
  assert.equal(stepped.done, false);
  stepped = applyWaitSnapshot(acc, { assistantReplies: ['DOUBAO_RUNTIME_OK'], generating: true }, { ...ctx, now: 200 });
  acc = stepped.acc;
  stepped = applyWaitSnapshot(acc, { assistantReplies: ['DOUBAO_RUNTIME_OK'], generating: false }, { ...ctx, now: 300 });
  acc = stepped.acc;
  stepped = applyWaitSnapshot(acc, { assistantReplies: ['DOUBAO_RUNTIME_OK'], generating: false }, { ...ctx, now: 400 });
  assert.equal(stepped.done, true);
  assert.equal(stepped.completion, 'complete');
  assert.equal(stepped.acc.lastCandidate, 'DOUBAO_RUNTIME_OK');
});

test('doubao client asks through BrowserRuntime evaluate, not CDP', async () => {
  const snapshots = [
    {
      url: 'https://www.doubao.com/chat',
      loggedIn: true,
      editorEmpty: true,
      hasSendButton: false,
      userMessages: [],
      assistantReplies: [],
    },
    {
      url: 'https://www.doubao.com/chat',
      loggedIn: true,
      editorEmpty: true,
      hasSendButton: false,
      userMessages: [],
      assistantReplies: [],
    },
    {
      url: 'https://www.doubao.com/chat',
      loggedIn: true,
      editorEmpty: false,
      hasSendButton: true,
      userMessages: [],
      assistantReplies: [],
    },
    {
      url: 'https://www.doubao.com/chat/1',
      loggedIn: true,
      editorEmpty: true,
      hasSendButton: false,
      userMessages: ['请只回复：OK'],
      assistantReplies: ['OK'],
      generating: false,
      streaming: false,
    },
    {
      url: 'https://www.doubao.com/chat/1',
      loggedIn: true,
      editorEmpty: true,
      hasSendButton: false,
      userMessages: ['请只回复：OK'],
      assistantReplies: ['OK'],
      generating: false,
      streaming: false,
    },
    {
      url: 'https://www.doubao.com/chat/1',
      loggedIn: true,
      editorEmpty: true,
      hasSendButton: false,
      userMessages: ['请只回复：OK'],
      assistantReplies: ['OK'],
      generating: false,
      streaming: false,
    },
  ];
  let index = 0;
  const calls = [];
  const runtime = {
    async withSession(_options, callback) {
      return callback({
        async navigate(url) {
          calls.push(['navigate', url]);
        },
        async evaluate(expression) {
          if (String(expression).includes('__AI_CENTER_DOUBAO_HTML') && !String(expression).includes('setContent')) {
            calls.push(['fill-chunk']);
            return { ok: true };
          }
          if (String(expression).includes('setContent')) {
            calls.push(['fill']);
            return { ok: true, text: '请只回复：OK', isEmpty: false };
          }
          if (String(expression).includes('trigger.click()')) {
            calls.push(['click']);
            return { ok: true, method: 'send-btn-wrapper' };
          }
          const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
          index += 1;
          return snapshot;
        },
        async fill(selector, value) {
          calls.push(['fill', selector, value]);
        },
        async click(selector) {
          calls.push(['click', selector]);
        },
      });
    },
  };

  const client = createDoubaoChatClient({
    browserRuntime: runtime,
    delay: async () => {},
    now: (() => {
      let t = 0;
      return () => {
        t += 1_000;
        return t;
      };
    })(),
    pollIntervalMs: 1,
    sendWaitMs: 5_000,
    idleTimeoutMs: 30_000,
    stableChecks: 1,
  });
  const result = await client.ask('请只回复：OK');
  assert.equal(result.status, 'ok');
  assert.equal(result.reply_text, 'OK');
  assert.deepEqual(calls[0], ['navigate', 'https://www.doubao.com/chat']);
  assert.ok(calls.some((item) => item[0] === 'click' && item[1] === '.send-btn-wrapper button'));
});
