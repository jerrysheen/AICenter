export const CHATGPT_CHAT_URL = 'https://chatgpt.com/';
export const CHATGPT_FILL_CHUNK_CHARS = 1_500;
export const CHATGPT_SEND_SELECTOR = '[data-testid="send-button"]';
export const CHATGPT_MODEL_PILL_SELECTOR = 'button.__composer-pill';
export const CHATGPT_THINKING_TICK_SELECTOR = '[data-model-reasoning-effort-slider] ._9wXMRW_TickRail ._9wXMRW_Tick';
export const PREFERRED_THINKING_LEVELS = Object.freeze(['极高', '高']);
export const THINKING_TICK_BY_LEVEL = Object.freeze({ 极高: 4, 高: 3 });

export function thinkingTickNumber(level) {
  return Number(THINKING_TICK_BY_LEVEL[String(level || '').trim()] || 0);
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function parseConversationUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const href = /^https?:\/\//i.test(raw) ? raw : `https://chatgpt.com${raw.startsWith('/') ? raw : `/${raw}`}`;
  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  if (!/^(chatgpt\.com|chat\.openai\.com)$/i.test(parsed.hostname)) return null;
  const match = parsed.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
  if (!match) return null;
  return {
    conversationId: match[1],
    pageUrl: `https://chatgpt.com/c/${match[1]}`,
  };
}

export function conversationIdFromUrl(value) {
  return parseConversationUrl(value)?.conversationId || '';
}

export function splitFillChunks(text, chunkChars = CHATGPT_FILL_CHUNK_CHARS) {
  const source = String(text || '');
  const size = Math.max(200, Number(chunkChars) || CHATGPT_FILL_CHUNK_CHARS);
  if (!source) return [''];
  const chunks = [];
  for (let index = 0; index < source.length; index += size) {
    chunks.push(source.slice(index, index + size));
  }
  return chunks;
}

export function confirmSend(snapshot, question) {
  const expected = normalizeText(question);
  const echoed = (snapshot.userMessages || []).some((item) => normalizeText(item).includes(expected));
  const urlChanged = Boolean(conversationIdFromUrl(snapshot.url));
  const inputCleared = Boolean(snapshot.editorEmpty);
  const generationObserved = Boolean(snapshot.generating || snapshot.streaming);
  return {
    sendConfirmed: inputCleared || echoed || generationObserved || urlChanged,
    inputCleared,
    questionEchoed: echoed,
    generationObserved,
    urlChanged,
  };
}

export function isStubAssistantReply(value) {
  return /^#\d+$/.test(normalizeText(value));
}

export function selectAssistantReply(replies, beforeReplyCount = 0) {
  const slice = (Array.isArray(replies) ? replies : []).slice(Math.max(0, Number(beforeReplyCount) || 0));
  const real = slice.filter((item) => normalizeText(item) && !isStubAssistantReply(item));
  return real.at(-1) || '';
}

export function snapshotExpression() {
  return `(() => {
    const text = (el) => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const editor = document.querySelector('#prompt-textarea');
    const editorText = editor ? String(editor.innerText || '').trim() : '';
    const send = document.querySelector(${JSON.stringify(CHATGPT_SEND_SELECTOR)});
    const stop = document.querySelector('[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="停止流式传输"], button[aria-label="Stop generating"], button[aria-label="停止生成"]');
    const login = document.querySelector('button[data-testid="login-button"], a[href*="/auth/login"], button[data-testid="welcome-login-button"]');
    const profile = document.querySelector('[data-testid="accounts-profile-button"], [data-testid="profile-button"]');
    const roleNodes = [...document.querySelectorAll('[data-message-author-role]')];
    const keep = 6;
    const userMessages = [];
    const assistantReplies = [];
    roleNodes.forEach((el, index) => {
      const role = el.getAttribute('data-message-author-role') || '';
      const value = index < roleNodes.length - keep ? '#' + index : text(el);
      if (role === 'user') userMessages.push(value);
      if (role === 'assistant') assistantReplies.push(value);
    });
    const bodyText = text(document.body);
    const loginWall = Boolean(login) && !editor;
    const quotaBlocked = /添加额度以继续|可用额度：0|剩余 0%/.test(bodyText);
    const match = String(location.href).match(/\\/c\\/([a-zA-Z0-9-]+)/);
    const radios = [...document.querySelectorAll('[role="radio"]')];
    const chatOn = radios.some((el) => text(el) === '聊天' && el.getAttribute('aria-checked') === 'true');
    const workOn = radios.some((el) => text(el) === '工作' && el.getAttribute('aria-checked') === 'true');
    const modelItem = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.getAttribute('aria-label') === '选择模型');
    const pill = document.querySelector(${JSON.stringify(CHATGPT_MODEL_PILL_SELECTOR)});
    const thinkingLevel = text(modelItem) || text(pill);
    return {
      url: location.href,
      title: document.title || '',
      conversationId: match ? match[1] : '',
      loggedIn: Boolean(editor || profile) && !loginWall,
      loginWall,
      quotaBlocked,
      hasEditor: Boolean(editor),
      hasModelPill: Boolean(pill),
      editorText,
      editorEmpty: !editorText,
      hasSendButton: Boolean(send) && send.getAttribute('aria-disabled') !== 'true' && !send.disabled,
      generating: Boolean(stop),
      streaming: Boolean(stop),
      userMessages,
      assistantReplies,
      chatSurface: chatOn ? '聊天' : (workOn ? '工作' : ''),
      thinkingLevel,
    };
  })()`;
}

export function selectChatSurfaceExpression() {
  return `(() => {
    const __AI_CENTER_CHATGPT_SELECT_CHAT = true;
    const text = (el) => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const chat = [...document.querySelectorAll('[role="radio"]')].find((el) => text(el) === '聊天');
    const work = [...document.querySelectorAll('[role="radio"]')].find((el) => text(el) === '工作');
    if (!chat) {
      return { ok: false, reason: 'no_chat_radio', surface: work && work.getAttribute('aria-checked') === 'true' ? '工作' : '' };
    }
    if (chat.getAttribute('aria-checked') === 'true') {
      return { ok: true, already: true, surface: '聊天' };
    }
    chat.click();
    return { ok: true, already: false, surface: '聊天' };
  })()`;
}

export function clickThinkingTickExpression(tickNumber) {
  const index = Math.max(1, Number(tickNumber) || 0);
  return `(() => {
    const ticks = [...document.querySelectorAll(${JSON.stringify(CHATGPT_THINKING_TICK_SELECTOR)})];
    const tick = ticks[${index - 1}];
    if (!tick) return { ok: false, reason: 'no_tick', count: ticks.length };
    if (tick.getAttribute('data-locked') === 'true') return { ok: false, reason: 'locked', count: ticks.length };
    tick.click();
    return { ok: true, index: ${index}, selected: tick.getAttribute('data-selected') || '' };
  })()`;
}

export function clickModelPillExpression() {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(CHATGPT_MODEL_PILL_SELECTOR)});
    if (!el) return { ok: false, reason: 'no_pill' };
    el.click();
    return { ok: true, text: String(el.innerText || '').replace(/\\s+/g, ' ').trim() };
  })()`;
}

export function beginFillExpression() {
  return `(() => {
    const el = document.querySelector('#prompt-textarea');
    if (!el) return { ok: false, reason: 'no_editor' };
    el.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    window.__AI_CENTER_CHATGPT_TEXT = '';
    return { ok: true, stage: 'begin' };
  })()`;
}

export function appendFillExpression(chunk) {
  return `(() => {
    window.__AI_CENTER_CHATGPT_TEXT = String(window.__AI_CENTER_CHATGPT_TEXT || '') + ${JSON.stringify(String(chunk || ''))};
    return { ok: true, stage: 'append', length: window.__AI_CENTER_CHATGPT_TEXT.length };
  })()`;
}

export function commitFillExpression() {
  return `(() => {
    const el = document.querySelector('#prompt-textarea');
    if (!el) return { ok: false, reason: 'no_editor' };
    el.focus();
    const text = String(window.__AI_CENTER_CHATGPT_TEXT || '');
    const ok = document.execCommand('insertText', false, text);
    window.__AI_CENTER_CHATGPT_TEXT = '';
    const after = String(el.innerText || '').trim();
    return { ok: Boolean(ok) || Boolean(after), text: after, isEmpty: !after };
  })()`;
}

export function clickSendExpression() {
  return `(() => {
    const trigger = document.querySelector(${JSON.stringify(CHATGPT_SEND_SELECTOR)});
    if (!trigger || trigger.disabled || trigger.getAttribute('aria-disabled') === 'true') {
      return { ok: false, reason: 'no_send_button', hasButton: Boolean(trigger) };
    }
    trigger.click();
    return { ok: true, method: 'send-button' };
  })()`;
}

function emptySnapshot() {
  return {
    url: '',
    title: '',
    conversationId: '',
    loggedIn: false,
    loginWall: false,
    quotaBlocked: false,
    hasEditor: false,
    hasModelPill: false,
    editorText: '',
    editorEmpty: true,
    hasSendButton: false,
    generating: false,
    streaming: false,
    userMessages: [],
    assistantReplies: [],
    chatSurface: '',
    thinkingLevel: '',
  };
}

function emptyResult(status, extra = {}) {
  return {
    status,
    sent_message: '',
    reply_text: '',
    conversation_id: '',
    page_url: '',
    send_confirmed: false,
    generation_observed: false,
    reply_observed: false,
    note: '',
    ...extra,
  };
}

export function createChatGptChatClient(options = {}) {
  const browserRuntime = options.browserRuntime;
  if (!browserRuntime) throw new Error('ChatGPT chat client 需要 browserRuntime');
  const now = options.now || (() => Date.now());
  const wait = options.delay || delay;
  const chatUrl = options.chatUrl || CHATGPT_CHAT_URL;
  const pollIntervalMs = Math.max(200, Number(options.pollIntervalMs) || 800);
  const sendWaitMs = Math.max(200, Number(options.sendWaitMs) || 8_000);
  const urlWaitMs = Math.max(1_000, Number(options.urlWaitMs) || 20_000);
  const harvestTimeoutMs = Math.max(1_000, Number(options.harvestTimeoutMs) || 20_000);

  async function readSnapshot(session) {
    const value = await session.evaluate(snapshotExpression(), { timeoutMs: 30_000 });
    return value && typeof value === 'object' ? value : emptySnapshot();
  }

  async function waitForEditor(session, timeoutMs) {
    const deadline = now() + timeoutMs;
    let last = emptySnapshot();
    while (now() < deadline) {
      last = await readSnapshot(session);
      if (last.hasEditor || (last.loggedIn && last.hasModelPill)) return last;
      await wait(400);
    }
    return last;
  }

  async function waitForSendButton(session, timeoutMs) {
    const deadline = now() + timeoutMs;
    let last = emptySnapshot();
    while (now() < deadline) {
      last = await readSnapshot(session);
      if (last.hasSendButton) return last;
      await wait(250);
    }
    return last;
  }

  async function confirmSendState(session, question, timeoutMs) {
    const deadline = now() + timeoutMs;
    let last = confirmSend(emptySnapshot(), question);
    while (now() < deadline) {
      const snapshot = await readSnapshot(session);
      last = confirmSend(snapshot, question);
      last.snapshot = snapshot;
      if (last.sendConfirmed) return last;
      await wait(400);
    }
    return last;
  }

  async function waitForConversationUrl(session, timeoutMs) {
    const deadline = now() + timeoutMs;
    let last = emptySnapshot();
    while (now() < deadline) {
      last = await readSnapshot(session);
      if (last.conversationId) return last;
      await wait(pollIntervalMs);
    }
    return last;
  }

  async function waitForHarvest(session, timeoutMs) {
    const deadline = now() + timeoutMs;
    let last = emptySnapshot();
    while (now() < deadline) {
      last = await readSnapshot(session);
      if (last.loginWall) return last;
      if (last.generating) return last;
      if (last.assistantReplies.some((item) => normalizeText(item) && !isStubAssistantReply(item))) return last;
      if (last.userMessages.some((item) => normalizeText(item) && !isStubAssistantReply(item))) return last;
      await wait(pollIntervalMs);
    }
    return last;
  }

  async function clickMaybe(session, selector) {
    if (typeof session.click === 'function') {
      try {
        await session.click(selector, { timeoutMs: 8_000 });
        return true;
      } catch {
        // Fall through to evaluate.
      }
    }
    return false;
  }

  async function ensureChatSettings(session) {
    const settings = {
      surface: '',
      thinkingLevel: '',
      surfaceApplied: false,
      thinkingApplied: false,
    };

    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
      opened = await clickMaybe(session, CHATGPT_MODEL_PILL_SELECTOR);
      if (!opened) {
        const clicked = await session.evaluate(clickModelPillExpression(), { timeoutMs: 15_000 });
        opened = Boolean(clicked?.ok);
      }
      if (!opened) await wait(600);
    }
    if (opened) await wait(600);

    const selected = await session.evaluate(selectChatSurfaceExpression(), { timeoutMs: 15_000 });
    settings.surface = selected?.surface || '';
    settings.surfaceApplied = selected?.ok === true && selected.surface === '聊天';

    let snapshot = await readSnapshot(session);
    settings.thinkingLevel = snapshot.thinkingLevel || '';
    if (settings.thinkingLevel === '极高') {
      settings.thinkingApplied = true;
    } else {
      for (const level of PREFERRED_THINKING_LEVELS) {
        const tickNumber = thinkingTickNumber(level);
        if (!tickNumber) continue;
        let clicked = await clickMaybe(session, `${CHATGPT_THINKING_TICK_SELECTOR}:nth-child(${tickNumber})`);
        if (!clicked) {
          clicked = Boolean((await session.evaluate(clickThinkingTickExpression(tickNumber), { timeoutMs: 15_000 }))?.ok);
        }
        if (!clicked) continue;
        await wait(350);
        snapshot = await readSnapshot(session);
        if (snapshot.thinkingLevel === '极高' || (level === '高' && snapshot.thinkingLevel === '高')) {
          settings.thinkingLevel = snapshot.thinkingLevel;
          settings.thinkingApplied = true;
          if (snapshot.thinkingLevel === '极高') break;
          if (level === '高') break;
        }
      }
      if (!settings.thinkingApplied && PREFERRED_THINKING_LEVELS.includes(settings.thinkingLevel)) {
        settings.thinkingApplied = true;
      }
    }

    if (opened) {
      await clickMaybe(session, CHATGPT_MODEL_PILL_SELECTOR);
      await wait(250);
    }

    return settings;
  }

  async function fillEditor(session, question) {
    const chunks = splitFillChunks(question);
    await session.evaluate(beginFillExpression(), { timeoutMs: 15_000 });
    for (const chunk of chunks) {
      await session.evaluate(appendFillExpression(chunk), { timeoutMs: 15_000 });
    }
    return session.evaluate(commitFillExpression(), { timeoutMs: 30_000 });
  }

  function resultFromSnapshot(status, snapshot, extra = {}) {
    const conversationId = snapshot.conversationId || conversationIdFromUrl(snapshot.url);
    return {
      status,
      sent_message: extra.sent_message || '',
      reply_text: extra.reply_text || selectAssistantReply(snapshot.assistantReplies),
      conversation_id: conversationId,
      page_url: conversationId ? `https://chatgpt.com/c/${conversationId}` : (snapshot.url || ''),
      send_confirmed: Boolean(extra.send_confirmed),
      generation_observed: Boolean(snapshot.generating || snapshot.streaming || extra.generation_observed),
      reply_observed: Boolean(extra.reply_observed || selectAssistantReply(snapshot.assistantReplies)),
      user_messages: snapshot.userMessages || [],
      assistant_replies: snapshot.assistantReplies || [],
      generating: Boolean(snapshot.generating || snapshot.streaming),
      chat_surface: extra.chat_surface || snapshot.chatSurface || '',
      thinking_level: extra.thinking_level || snapshot.thinkingLevel || '',
      note: extra.note || '',
      recovery_hint: extra.recovery_hint,
    };
  }

  return {
    async inspect() {
      return browserRuntime.withSession({ purpose: 'chatgpt.inspect', focused: true }, async (session) => {
        await session.navigate(chatUrl, { timeoutMs: 60_000 });
        await wait(1_500);
        return readSnapshot(session);
      });
    },

    async prepare() {
      return browserRuntime.withSession({ purpose: 'chatgpt.prepare', focused: true }, async (session) => {
        await session.navigate(chatUrl, { timeoutMs: 60_000 });
        await wait(1_500);
        const ready = await waitForEditor(session, 20_000);
        if (!ready.hasEditor && !ready.loggedIn) return { ...ready, surfaceApplied: false, thinkingApplied: false };
        const settings = await ensureChatSettings(session);
        const snapshot = await readSnapshot(session);
        return { ...snapshot, ...settings };
      });
    },

    async dispatch(question, dispatchOptions = {}) {
      const text = String(question || '').trim();
      if (!text) return emptyResult('invalid_input', { note: '问题不能为空' });

      return browserRuntime.withSession({ purpose: 'chatgpt.dispatch', focused: true }, async (session) => {
        await session.navigate(chatUrl, { timeoutMs: 60_000 });
        await wait(1_500);
        const ready = await waitForEditor(session, 20_000);
        if (!ready.hasEditor && !ready.loggedIn) {
          return resultFromSnapshot('login_required', ready, {
            sent_message: text,
            note: 'ChatGPT 输入框不可用，请先在 BrowserSkill 所连 Chrome 里登录 chatgpt.com',
            recovery_hint: 'user_login_then_retry',
          });
        }

        const settings = await ensureChatSettings(session);
        const settingsExtra = {
          chat_surface: settings.surface,
          thinking_level: settings.thinkingLevel,
        };
        const settingsNote = settings.surfaceApplied && settings.thinkingApplied
          ? ''
          : [
            settings.surfaceApplied ? '' : '没有切到聊天',
            settings.thinkingApplied ? '' : '没有切到极高/高',
          ].filter(Boolean).join('，');

        const filled = await fillEditor(session, text);
        if (!filled?.ok) {
          return resultFromSnapshot('send_not_confirmed', ready, {
            sent_message: text,
            ...settingsExtra,
            note: filled?.reason || '未能写入 ChatGPT 输入框',
            recovery_hint: 'safe_to_resend',
          });
        }

        await wait(800);
        const withButton = await waitForSendButton(session, sendWaitMs);
        if (!withButton.hasSendButton) {
          return resultFromSnapshot('send_not_confirmed', withButton, {
            sent_message: text,
            ...settingsExtra,
            note: withButton.quotaBlocked ? '写入后没有可点的发送按钮，页面提示额度不足' : '写入后没有出现发送按钮',
            recovery_hint: 'safe_to_resend',
          });
        }

        await wait(500);
        let clicked = { ok: false };
        if (typeof session.click === 'function') {
          try {
            await session.click(CHATGPT_SEND_SELECTOR, { timeoutMs: 15_000 });
            clicked = { ok: true };
          } catch {
            clicked = await session.evaluate(clickSendExpression(), { timeoutMs: 15_000 });
          }
        } else {
          clicked = await session.evaluate(clickSendExpression(), { timeoutMs: 15_000 });
        }
        if (!clicked?.ok) {
          return resultFromSnapshot('send_not_confirmed', withButton, {
            sent_message: text,
            ...settingsExtra,
            note: clicked?.reason || '未能点击发送',
            recovery_hint: 'safe_to_resend',
          });
        }

        const sendState = await confirmSendState(session, text, sendWaitMs);
        if (!sendState.sendConfirmed) {
          return resultFromSnapshot('send_not_confirmed', sendState.snapshot || withButton, {
            sent_message: text,
            ...settingsExtra,
            note: '页面没有确认已发出（输入未清空、用户气泡未出现、也未开始生成）',
            recovery_hint: 'safe_to_resend',
          });
        }

        const afterUrl = sendState.snapshot?.conversationId
          ? sendState.snapshot
          : await waitForConversationUrl(session, Number(dispatchOptions.urlWaitMs) || urlWaitMs);
        if (!afterUrl.conversationId) {
          return resultFromSnapshot('sent_without_url', afterUrl, {
            sent_message: text,
            ...settingsExtra,
            send_confirmed: true,
            generation_observed: sendState.generationObserved,
            note: ['已发出但还没有出现 /c/<id>，稍后不要重发，先打开当前页再读', settingsNote].filter(Boolean).join('；'),
            recovery_hint: 'read_again_do_not_resend',
          });
        }

        return resultFromSnapshot('sent', afterUrl, {
          sent_message: text,
          ...settingsExtra,
          send_confirmed: true,
          generation_observed: sendState.generationObserved || afterUrl.generating,
          note: [
            afterUrl.generating ? '已发出并记下对话地址，仍在生成，稍后 harvest' : '已发出并记下对话地址，稍后 harvest',
            settingsNote,
          ].filter(Boolean).join('；'),
          recovery_hint: 'read_again_do_not_resend',
        });
      });
    },

    async harvest(conversationUrl, harvestOptions = {}) {
      const parsed = parseConversationUrl(conversationUrl);
      if (!parsed) return emptyResult('invalid_url', { note: '需要 chatgpt.com/c/<id> 对话地址' });

      return browserRuntime.withSession({ purpose: 'chatgpt.harvest', focused: true }, async (session) => {
        await session.navigate(parsed.pageUrl, { timeoutMs: 60_000 });
        const snapshot = await waitForHarvest(session, Number(harvestOptions.harvestTimeoutMs) || harvestTimeoutMs);
        if (!snapshot.loggedIn && snapshot.loginWall) {
          return resultFromSnapshot('login_required', snapshot, {
            note: '打开已有对话时需要先登录',
            recovery_hint: 'user_login_then_retry',
          });
        }
        const replyText = selectAssistantReply(snapshot.assistantReplies);
        if (snapshot.generating) {
          return resultFromSnapshot('generating', snapshot, {
            reply_text: replyText,
            reply_observed: Boolean(replyText),
            note: replyText ? '对话仍在生成，先收回当前正文' : '对话仍在生成，还没有稳定正文',
            recovery_hint: 'read_again_do_not_resend',
          });
        }
        if (!replyText) {
          return resultFromSnapshot('reply_not_observed', snapshot, {
            note: '已打开同一条对话，但没有读到助手正文',
            recovery_hint: 'read_again_do_not_resend',
          });
        }
        return resultFromSnapshot('ok', snapshot, {
          reply_text: replyText,
          reply_observed: true,
        });
      });
    },
  };
}
