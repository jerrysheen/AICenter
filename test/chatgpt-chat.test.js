import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFillExpression,
  beginFillExpression,
  commitFillExpression,
  confirmSend,
  conversationIdFromUrl,
  createChatGptChatClient,
  parseConversationUrl,
  selectAssistantReply,
  selectChatSurfaceExpression,
  splitFillChunks,
  thinkingTickNumber,
} from '../packages/connectors/src/chatgpt/chat-browser.js';

test('conversation URL keeps the /c/ id and drops extra path noise', () => {
  assert.deepEqual(parseConversationUrl('https://chatgpt.com/c/6a98161f-a6dc-83ee-885f-8419ec6274ef?foo=1'), {
    conversationId: '6a98161f-a6dc-83ee-885f-8419ec6274ef',
    pageUrl: 'https://chatgpt.com/c/6a98161f-a6dc-83ee-885f-8419ec6274ef',
  });
  assert.equal(parseConversationUrl('/c/6a98161f-a6dc-83ee-885f-8419ec6274ef').conversationId, '6a98161f-a6dc-83ee-885f-8419ec6274ef');
  assert.equal(conversationIdFromUrl('https://chat.openai.com/c/abc-123'), 'abc-123');
  assert.equal(parseConversationUrl('https://chatgpt.com/'), null);
  assert.equal(parseConversationUrl('https://example.com/c/abc'), null);
});

test('long ChatGPT fill is split into short evaluate chunks', () => {
  const text = '汉'.repeat(4_000);
  const chunks = splitFillChunks(text, 1_500);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks.join(''), text);
  assert.ok(appendFillExpression(chunks[0]).length < 4_000);
  assert.match(beginFillExpression(), /__AI_CENTER_CHATGPT_TEXT/);
  assert.match(commitFillExpression(), /insertText/);
});

test('send is confirmed by echo, cleared input, streaming or conversation url', () => {
  assert.equal(confirmSend({
    editorEmpty: false,
    userMessages: [],
    generating: false,
    url: 'https://chatgpt.com/',
  }, 'hello').sendConfirmed, false);
  assert.equal(confirmSend({
    editorEmpty: true,
    userMessages: [],
    url: 'https://chatgpt.com/',
  }, 'hello').sendConfirmed, true);
  assert.equal(confirmSend({
    editorEmpty: false,
    userMessages: ['hello'],
    url: 'https://chatgpt.com/',
  }, 'hello').questionEchoed, true);
  assert.equal(confirmSend({
    editorEmpty: false,
    userMessages: [],
    url: 'https://chatgpt.com/c/6a98161f-a6dc-83ee-885f-8419ec6274ef',
  }, 'hello').urlChanged, true);
});

test('latest real assistant reply is used, stubs are skipped', () => {
  assert.equal(selectAssistantReply(['#0', '第一段', '最终结论']), '最终结论');
  assert.equal(selectAssistantReply(['#0', '#1']), '');
});

test('thinking ticks prefer 极高 then 高', () => {
  assert.equal(thinkingTickNumber('极高'), 4);
  assert.equal(thinkingTickNumber('高'), 3);
  assert.match(selectChatSurfaceExpression(), /聊天/);
});

function fakeRuntime(handler) {
  return {
    async withSession(_options, callback) {
      return callback(handler);
    },
  };
}

test('dispatch records the conversation URL and does not wait for a finished reply', async () => {
  const idle = {
    url: 'https://chatgpt.com/',
    loggedIn: true,
    hasEditor: true,
    hasModelPill: true,
    editorEmpty: true,
    hasSendButton: false,
    userMessages: [],
    assistantReplies: [],
    thinkingLevel: '极高',
    chatSurface: '聊天',
  };
  const readyToSend = {
    ...idle,
    editorEmpty: false,
    hasSendButton: true,
  };
  const sent = {
    url: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
    conversationId: '11111111-2222-3333-4444-555555555555',
    loggedIn: true,
    hasEditor: true,
    hasModelPill: true,
    editorEmpty: true,
    hasSendButton: false,
    generating: true,
    userMessages: ['请只回复：OK'],
    assistantReplies: [],
    thinkingLevel: '极高',
    chatSurface: '聊天',
  };
  const snapshots = [idle, idle, readyToSend, sent, sent, sent];
  let index = 0;
  const calls = [];
  const runtime = fakeRuntime({
    async navigate(url) { calls.push(['navigate', url]); },
    async evaluate(expression) {
      if (String(expression).includes('__AI_CENTER_CHATGPT_SELECT_CHAT')) {
        calls.push(['select-chat']);
        return { ok: true, already: true, surface: '聊天' };
      }
      if (String(expression).includes('__AI_CENTER_CHATGPT_TEXT') && !String(expression).includes('insertText')) {
        calls.push(['fill-chunk']);
        return { ok: true };
      }
      if (String(expression).includes('insertText')) {
        calls.push(['fill']);
        return { ok: true, text: '请只回复：OK', isEmpty: false };
      }
      if (String(expression).includes('trigger.click()')) {
        calls.push(['click']);
        return { ok: true, method: 'send-button' };
      }
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      return snapshot;
    },
    async click(selector) {
      calls.push(['click', selector]);
    },
  });

  const client = createChatGptChatClient({
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
  });
  const result = await client.dispatch('请只回复：OK');
  assert.equal(result.status, 'sent');
  assert.equal(result.conversation_id, '11111111-2222-3333-4444-555555555555');
  assert.equal(result.page_url, 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555');
  assert.equal(result.send_confirmed, true);
  assert.equal(result.recovery_hint, 'read_again_do_not_resend');
  assert.deepEqual(calls[0], ['navigate', 'https://chatgpt.com/']);
  assert.ok(calls.some((item) => item[0] === 'select-chat'));
  assert.ok(calls.some((item) => item[0] === 'click' && item[1] === 'button.__composer-pill'));
  assert.ok(calls.some((item) => item[0] === 'click' && item[1] === '[data-testid="send-button"]'));
});

test('harvest reopens the same /c/ URL and reads the assistant body', async () => {
  const calls = [];
  const runtime = fakeRuntime({
    async navigate(url) { calls.push(['navigate', url]); },
    async evaluate() {
      return {
        url: 'https://chatgpt.com/c/6a98161f-a6dc-83ee-885f-8419ec6274ef',
        conversationId: '6a98161f-a6dc-83ee-885f-8419ec6274ef',
        loggedIn: true,
        generating: false,
        userMessages: ['先叙述结构'],
        assistantReplies: ['#0', '第一步只整理物理结构'],
      };
    },
  });
  const client = createChatGptChatClient({
    browserRuntime: runtime,
    delay: async () => {},
    now: (() => {
      let t = 0;
      return () => {
        t += 1_000;
        return t;
      };
    })(),
    harvestTimeoutMs: 5_000,
    pollIntervalMs: 1,
  });
  const result = await client.harvest('https://chatgpt.com/c/6a98161f-a6dc-83ee-885f-8419ec6274ef?utm=1');
  assert.equal(result.status, 'ok');
  assert.equal(result.reply_text, '第一步只整理物理结构');
  assert.deepEqual(calls[0], ['navigate', 'https://chatgpt.com/c/6a98161f-a6dc-83ee-885f-8419ec6274ef']);
});

test('harvest reports generating when the same conversation is still streaming', async () => {
  const runtime = fakeRuntime({
    async navigate() {},
    async evaluate() {
      return {
        url: 'https://chatgpt.com/c/abc',
        conversationId: 'abc',
        loggedIn: true,
        generating: true,
        assistantReplies: ['还在写'],
        userMessages: ['继续'],
      };
    },
  });
  const client = createChatGptChatClient({
    browserRuntime: runtime,
    delay: async () => {},
    now: () => 1,
    harvestTimeoutMs: 1_000,
  });
  const result = await client.harvest('/c/abc');
  assert.equal(result.status, 'generating');
  assert.equal(result.reply_text, '还在写');
  assert.equal(result.recovery_hint, 'read_again_do_not_resend');
});
