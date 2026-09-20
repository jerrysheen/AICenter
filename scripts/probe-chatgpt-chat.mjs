import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredBrowserRuntime } from '../packages/connectors/src/browser/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot });
const chatUrl = String(process.env.AI_CHATGPT_URL || 'https://chatgpt.com/').trim();
const conversationUrl = String(process.env.AI_CHATGPT_CONVERSATION_URL || '').trim();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const INSPECT = `(() => {
  const text = (el) => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const attrs = (el) => {
    if (!el) return null;
    return {
      tag: el.tagName,
      id: el.id || '',
      role: el.getAttribute('role') || '',
      testid: el.getAttribute('data-testid') || '',
      aria: el.getAttribute('aria-label') || '',
      contenteditable: el.getAttribute('contenteditable') || '',
      className: String(el.className || '').slice(0, 120),
    };
  };
  const pick = (selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return { selector, ...attrs(el), text: text(el).slice(0, 80) };
    }
    return null;
  };
  const editor = document.querySelector('#prompt-textarea');
  const editorText = editor ? String(editor.innerText || '').trim() : '';
  const sendCandidates = [
    '[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="发送提示"]',
    'button[aria-label="发送"]',
  ];
  const stopCandidates = [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="停止流式传输"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="停止生成"]',
  ];
  const roles = [...document.querySelectorAll('[data-message-author-role]')].map((el, index) => ({
    index,
    role: el.getAttribute('data-message-author-role') || '',
    testid: el.getAttribute('data-testid') || '',
    turn: el.closest('[data-testid^="conversation-turn"]')?.getAttribute('data-testid') || '',
    chars: text(el).length,
    preview: text(el).slice(0, 180),
  }));
  const turns = [...document.querySelectorAll('[data-testid^="conversation-turn"]')].map((el) => ({
    testid: el.getAttribute('data-testid') || '',
    chars: text(el).length,
    preview: text(el).slice(0, 120),
  }));
  const markdown = [...document.querySelectorAll('.markdown')].slice(-4).map((el) => ({
    className: String(el.className || '').slice(0, 80),
    chars: text(el).length,
    preview: text(el).slice(0, 160),
  }));
  const buttons = [...document.querySelectorAll('button')].map((el) => ({
    testid: el.getAttribute('data-testid') || '',
    aria: el.getAttribute('aria-label') || '',
    text: text(el).slice(0, 40),
  })).filter((item) => item.testid || /send|stop|speech|voice|提交|发送|停止/i.test(item.aria + ' ' + item.text)).slice(0, 20);
  const conversationId = (String(location.href).match(/\\/c\\/([a-zA-Z0-9-]+)/) || [])[1] || '';
  return {
    url: location.href,
    title: document.title || '',
    conversationId,
    loggedIn: Boolean(editor) || Boolean(document.querySelector('[data-testid="accounts-profile-button"]')),
    editor: attrs(editor),
    editorText: editorText.slice(0, 200),
    editorEmpty: !editorText,
    composerIsProseMirror: Boolean(editor && editor.classList.contains('ProseMirror')),
    send: pick(sendCandidates),
    stop: pick(stopCandidates),
    buttons,
    roleCount: roles.length,
    roles: roles.slice(-8),
    turns: turns.slice(-8),
    markdown,
    articleCount: document.querySelectorAll('article').length,
    generating: Boolean(pick(stopCandidates)),
  };
})()`;

const runtime = createConfiguredBrowserRuntime({ defaultBrowserId: instance.browserId });
const health = await runtime.health();
console.log('[chatgpt-probe] health', JSON.stringify(health));
if (!health.available) {
  console.error('[chatgpt-probe] BrowserSkill 未连接。请先在 Chrome 打开扩展并连上 daemon。');
  process.exitCode = 1;
} else {
  const snapshot = await runtime.withSession({ purpose: 'chatgpt.inspect', focused: true }, async (session) => {
    await session.navigate(chatUrl, { timeoutMs: 60_000 });
    await delay(2_000);
    const home = await session.evaluate(INSPECT, { timeoutMs: 30_000 });
    let reopenUrl = conversationUrl;
    if (!reopenUrl) {
      reopenUrl = await session.evaluate(`(() => {
        const link = document.querySelector('a[href*="/c/"]');
        return link ? String(link.href || '') : '';
      })()`, { timeoutMs: 15_000 });
    }
    let opened = null;
    if (reopenUrl) {
      await session.navigate(reopenUrl, { timeoutMs: 60_000 });
      await delay(8_000);
      opened = await session.evaluate(INSPECT, { timeoutMs: 30_000 });
      const deep = await session.evaluate(`(() => {
        const text = (el) => String(el?.innerText || '').replace(/\\s+/g, ' ').trim();
        const main = document.querySelector('main') || document.body;
        const interesting = [...document.querySelectorAll('[data-testid], [data-message-author-role], article, [class*="markdown"], [class*="agent"], [class*="turn"]')]
          .slice(0, 40)
          .map((el) => ({
            tag: el.tagName,
            testid: el.getAttribute('data-testid') || '',
            role: el.getAttribute('data-message-author-role') || el.getAttribute('role') || '',
            className: String(el.className || '').slice(0, 80),
            chars: text(el).length,
            preview: text(el).slice(0, 80),
          }));
        return {
          url: location.href,
          title: document.title || '',
          mainChars: text(main).length,
          mainPreview: text(main).slice(0, 400),
          interesting,
        };
      })()`, { timeoutMs: 30_000 });
      opened = { ...opened, deep };
    }
    return { home, reopenUrl, opened };
  });
  console.log('[chatgpt-probe] snapshot');
  console.log(JSON.stringify(snapshot, null, 2));
}
