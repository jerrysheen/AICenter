export const DOUBAO_CHAT_URL = 'https://www.doubao.com/chat';

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function toTipTapHtml(question) {
  const lines = String(question || '').split('\n');
  return lines.map((line) => {
    const escaped = line
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    return `<p>${escaped || '<br>'}</p>`;
  }).join('');
}

export function confirmSend(snapshot, question) {
  const expected = normalizeText(question);
  const echoed = (snapshot.userMessages || []).some((item) => normalizeText(item).includes(expected));
  const urlChanged = /\/chat\/[^/?#]+/.test(String(snapshot.url || ''));
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

export function createWaitAccumulator(now) {
  return {
    lastCandidate: '',
    previousLatestReply: '',
    stablePollCount: 0,
    lastIdleActivityAt: now,
    observedReply: false,
    previousGenerating: false,
    maxTimeoutExceeded: false,
  };
}

export function isStubAssistantReply(value) {
  return /^#\d+$/.test(normalizeText(value));
}

export function selectAssistantReply(replies, beforeReplyCount = 0, isComplete) {
  const slice = (Array.isArray(replies) ? replies : []).slice(Math.max(0, Number(beforeReplyCount) || 0));
  const real = slice.filter((item) => normalizeText(item) && !isStubAssistantReply(item));
  if (typeof isComplete === 'function') {
    for (let index = real.length - 1; index >= 0; index -= 1) {
      try {
        if (isComplete(real[index])) return real[index];
      } catch {
        // Keep scanning older bubbles.
      }
    }
  }
  return real.reduce((best, item) => (item.length >= (best || '').length ? item : best), real.at(-1) || '');
}

export function applyWaitSnapshot(acc, snapshot, ctx) {
  const replies = Array.isArray(snapshot.assistantReplies) ? snapshot.assistantReplies : [];
  const latestReply = selectAssistantReply(replies, ctx.beforeReplyCount, ctx.isComplete);
  const generating = Boolean(snapshot.generating || snapshot.streaming);
  const next = { ...acc };
  const grewThisPoll = Boolean(normalizeText(latestReply) && latestReply !== acc.previousLatestReply);

  if (normalizeText(latestReply)) {
    next.lastCandidate = latestReply;
    next.observedReply = true;
  }

  if (grewThisPoll) {
    next.lastIdleActivityAt = ctx.now;
    next.previousLatestReply = latestReply;
    next.stablePollCount = 0;
  } else if (next.observedReply && normalizeText(latestReply)) {
    next.stablePollCount += 1;
  }

  if (generating !== acc.previousGenerating) {
    next.lastIdleActivityAt = ctx.now;
    next.previousGenerating = generating;
  }

  if (ctx.now - ctx.startedAt > ctx.maxTimeoutMs) {
    next.maxTimeoutExceeded = true;
  }

  const stable = next.stablePollCount >= ctx.stableChecks;
  const idleFor = ctx.now - next.lastIdleActivityAt;
  let done = false;
  let completion = null;

  if (grewThisPoll) {
    done = false;
  } else if (next.observedReply && next.lastCandidate && stable && !generating) {
    done = true;
    completion = 'complete';
  } else if (next.observedReply && next.lastCandidate && stable && idleFor > ctx.idleTimeoutMs) {
    done = true;
    completion = 'complete';
  } else if (next.maxTimeoutExceeded && next.observedReply && next.lastCandidate && stable) {
    done = true;
    completion = 'complete';
  } else if (next.maxTimeoutExceeded && !next.observedReply && !generating && idleFor > ctx.idleTimeoutMs) {
    done = true;
    completion = 'reply_not_observed';
  } else if (!next.observedReply && !generating && idleFor > ctx.idleTimeoutMs) {
    done = true;
    completion = 'reply_not_observed';
  }

  return { acc: next, done, completion, generating, grewThisPoll };
}

export function snapshotExpression() {
  return `(() => {
    const bodyText = document.body ? document.body.innerText || '' : '';
    const editorEl = document.querySelector('.tiptap.ProseMirror, .ProseMirror');
    const editor = editorEl && editorEl.editor;
    const editorText = editor && typeof editor.getText === 'function'
      ? editor.getText()
      : String(editorEl && editorEl.innerText || '').trim();
    const userMessages = [...document.querySelectorAll('[class*="send-msg-bubble"]')]
      .map((el) => String(el.innerText || '').trim())
      .filter(Boolean);
    const assistantNodes = [...document.querySelectorAll('[data-reply-message="true"]')];
    const keep = 4;
    const assistantReplies = assistantNodes.map((el, index) => {
      if (index < assistantNodes.length - keep) return '#' + index;
      return String(el.innerText || '').trim();
    });
    const streaming = Boolean(document.querySelector('[data-streaming="true"]'));
    const generating = streaming || /停止生成|停止回答|停止输出/.test(bodyText);
    const loginWall = /验证码登录|手机号登录|扫码登录/.test(bodyText) && !editorEl;
    return {
      url: location.href,
      title: document.title || '',
      loggedIn: Boolean(editorEl) && !loginWall,
      loginWall,
      editorText,
      editorEmpty: editor ? Boolean(editor.isEmpty) : !editorText,
      hasSendButton: Boolean(document.querySelector('.send-btn-wrapper button')),
      generating,
      streaming,
      userMessages,
      assistantReplies,
    };
  })()`;
}

export const DOUBAO_FILL_CHUNK_CHARS = 1_500;

export function splitFillChunks(html, chunkChars = DOUBAO_FILL_CHUNK_CHARS) {
  const source = String(html || '');
  const size = Math.max(200, Number(chunkChars) || DOUBAO_FILL_CHUNK_CHARS);
  if (!source) return [''];
  const chunks = [];
  for (let index = 0; index < source.length; index += size) {
    chunks.push(source.slice(index, index + size));
  }
  return chunks;
}

export function beginFillExpression() {
  return '(() => { window.__AI_CENTER_DOUBAO_HTML = ""; return { ok: true, stage: "begin" }; })()';
}

export function appendFillExpression(chunk) {
  return `(() => { window.__AI_CENTER_DOUBAO_HTML += ${JSON.stringify(String(chunk || ''))}; return { ok: true, stage: "append", length: window.__AI_CENTER_DOUBAO_HTML.length }; })()`;
}

export function commitFillExpression() {
  return `(() => {
    const el = document.querySelector('.tiptap.ProseMirror, .ProseMirror');
    const editor = el && el.editor;
    if (!editor || typeof editor.commands.setContent !== 'function') {
      return { ok: false, reason: 'no_tiptap' };
    }
    editor.commands.focus('end');
    const html = String(window.__AI_CENTER_DOUBAO_HTML || '');
    const ok = editor.commands.setContent(html);
    window.__AI_CENTER_DOUBAO_HTML = '';
    return {
      ok: Boolean(ok),
      text: typeof editor.getText === 'function' ? editor.getText() : '',
      isEmpty: Boolean(editor.isEmpty),
    };
  })()`;
}

export function fillExpression(question) {
  const html = toTipTapHtml(question);
  return `(() => {
    const el = document.querySelector('.tiptap.ProseMirror, .ProseMirror');
    const editor = el && el.editor;
    if (!editor || typeof editor.commands.setContent !== 'function') {
      return { ok: false, reason: 'no_tiptap' };
    }
    editor.commands.focus('end');
    const ok = editor.commands.setContent(${JSON.stringify(html)});
    return {
      ok: Boolean(ok),
      text: typeof editor.getText === 'function' ? editor.getText() : '',
      isEmpty: Boolean(editor.isEmpty),
    };
  })()`;
}

export function clickSendExpression() {
  return `(() => {
    const trigger = document.querySelector('.send-btn-wrapper button');
    if (!trigger || trigger.getAttribute('data-disabled') === 'true') {
      return { ok: false, reason: 'no_send_button', hasButton: Boolean(trigger) };
    }
    trigger.click();
    return { ok: true, method: 'send-btn-wrapper' };
  })()`;
}

function emptySnapshot() {
  return {
    url: '',
    title: '',
    loggedIn: false,
    loginWall: false,
    editorText: '',
    editorEmpty: true,
    hasSendButton: false,
    generating: false,
    streaming: false,
    userMessages: [],
    assistantReplies: [],
  };
}

export function createDoubaoChatClient(options = {}) {
  const browserRuntime = options.browserRuntime;
  if (!browserRuntime) throw new Error('Doubao chat client 需要 browserRuntime');
  const now = options.now || (() => Date.now());
  const wait = options.delay || delay;
  const chatUrl = options.chatUrl || DOUBAO_CHAT_URL;
  const pollIntervalMs = Math.max(200, Number(options.pollIntervalMs) || 800);
  const sendWaitMs = Math.max(200, Number(options.sendWaitMs) || 8_000);
  const idleTimeoutMs = Math.max(1_000, Number(options.idleTimeoutMs) || 30_000);
  const maxTimeoutMs = Math.max(idleTimeoutMs, Number(options.maxTimeoutMs) || 180_000);
  const stableChecks = Math.max(1, Number(options.stableChecks) || 4);

  async function readSnapshot(session) {
    const value = await session.evaluate(snapshotExpression(), { timeoutMs: 30_000 });
    return value && typeof value === 'object' ? value : emptySnapshot();
  }

  async function waitForEditor(session, timeoutMs) {
    const deadline = now() + timeoutMs;
    let last = emptySnapshot();
    while (now() < deadline) {
      last = await readSnapshot(session);
      if (last.loggedIn) return last;
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

  function latestReplyText(snapshot, beforeReplyCount, isComplete) {
    return selectAssistantReply(snapshot?.assistantReplies, beforeReplyCount, isComplete);
  }

  async function waitForReply(session, question, beforeReplyCount, askOptions = {}) {
    const startedAt = now();
    let acc = createWaitAccumulator(startedAt);
    while (true) {
      const snapshot = await readSnapshot(session);
      const stepped = applyWaitSnapshot(acc, snapshot, {
        now: now(),
        startedAt,
        beforeReplyCount,
        idleTimeoutMs: Number(askOptions.idleTimeoutMs) || idleTimeoutMs,
        maxTimeoutMs: Number(askOptions.maxTimeoutMs) || maxTimeoutMs,
        stableChecks: Number(askOptions.stableChecks) || stableChecks,
        isComplete: askOptions.isComplete,
      });
      acc = stepped.acc;
      if (stepped.done) {
        return {
          snapshot,
          replyText: acc.lastCandidate,
          completion: stepped.completion,
          generationObserved: Boolean(acc.previousGenerating || snapshot.generating || snapshot.streaming),
          replyObserved: acc.observedReply,
        };
      }
      await wait(pollIntervalMs);
    }
  }

  async function rereadAfterReload(session, beforeReplyCount, isComplete) {
    const snapshot = await readSnapshot(session);
    return {
      snapshot,
      replyText: latestReplyText(snapshot, beforeReplyCount, isComplete),
    };
  }

  async function fillEditor(session, question) {
    const html = toTipTapHtml(question);
    const chunks = splitFillChunks(html);
    await session.evaluate(beginFillExpression(), { timeoutMs: 15_000 });
    for (const chunk of chunks) {
      await session.evaluate(appendFillExpression(chunk), { timeoutMs: 15_000 });
    }
    return session.evaluate(commitFillExpression(), { timeoutMs: 30_000 });
  }

  return {
    async inspect() {
      return browserRuntime.withSession({ purpose: 'doubao.inspect', focused: true }, async (session) => {
        await session.navigate(chatUrl, { timeoutMs: 60_000 });
        await wait(1_500);
        return readSnapshot(session);
      });
    },

    async ask(question, askOptions = {}) {
      const text = String(question || '').trim();
      if (!text) {
        return {
          status: 'invalid_input',
          sent_message: '',
          reply_text: '',
          page_url: '',
          send_confirmed: false,
          generation_observed: false,
          reply_observed: false,
          note: '问题不能为空',
        };
      }

      return browserRuntime.withSession({ purpose: 'doubao.ask', focused: true }, async (session) => {
        await session.navigate(chatUrl, { timeoutMs: 60_000 });
        const ready = await waitForEditor(session, 20_000);
        if (!ready.loggedIn) {
          return {
            status: 'login_required',
            sent_message: text,
            reply_text: '',
            page_url: ready.url,
            send_confirmed: false,
            generation_observed: false,
            reply_observed: false,
            note: '豆包输入框不可用，请先在 BrowserSkill 所连 Chrome 里登录 doubao.com',
            recovery_hint: 'user_login_then_retry',
          };
        }
        await wait(2_000);

        const before = await readSnapshot(session);
        const beforeReplyCount = Array.isArray(before.assistantReplies) ? before.assistantReplies.length : 0;
        const filled = await fillEditor(session, text);
        if (!filled?.ok) {
          return {
            status: 'send_not_confirmed',
            sent_message: text,
            reply_text: '',
            page_url: ready.url,
            send_confirmed: false,
            generation_observed: false,
            reply_observed: false,
            note: filled?.reason || '未能写入豆包输入框',
            recovery_hint: 'safe_to_resend',
          };
        }

        await wait(800);
        const withButton = await waitForSendButton(session, sendWaitMs);
        if (!withButton.hasSendButton) {
          return {
            status: 'send_not_confirmed',
            sent_message: text,
            reply_text: '',
            page_url: withButton.url,
            send_confirmed: false,
            generation_observed: false,
            reply_observed: false,
            note: '写入后没有出现发送按钮',
            recovery_hint: 'safe_to_resend',
          };
        }

        await wait(500);
        let clicked = { ok: false };
        if (typeof session.click === 'function') {
          try {
            await session.click('.send-btn-wrapper button', { timeoutMs: 15_000 });
            clicked = { ok: true };
          } catch {
            clicked = await session.evaluate(clickSendExpression(), { timeoutMs: 15_000 });
          }
        } else {
          clicked = await session.evaluate(clickSendExpression(), { timeoutMs: 15_000 });
        }
        if (!clicked?.ok) {
          return {
            status: 'send_not_confirmed',
            sent_message: text,
            reply_text: '',
            page_url: withButton.url,
            send_confirmed: false,
            generation_observed: false,
            reply_observed: false,
            note: clicked?.reason || '未能点击发送',
            recovery_hint: 'safe_to_resend',
          };
        }

        const sendState = await confirmSendState(session, text, sendWaitMs);
        if (!sendState.sendConfirmed) {
          return {
            status: 'send_not_confirmed',
            sent_message: text,
            reply_text: '',
            page_url: sendState.snapshot?.url || withButton.url,
            send_confirmed: false,
            generation_observed: false,
            reply_observed: false,
            note: '页面没有确认已发出（输入未清空、用户气泡未出现、也未开始生成）',
            recovery_hint: 'safe_to_resend',
          };
        }

        let waited = await waitForReply(session, text, beforeReplyCount, askOptions);
        if (askOptions.reloadOnce && !waited.replyObserved) {
          const reloadUrl = waited.snapshot?.url || chatUrl;
          await session.navigate(reloadUrl, { timeoutMs: 30_000 });
          await wait(2_000);
          const reread = await rereadAfterReload(session, beforeReplyCount, askOptions.isComplete);
          waited = {
            ...waited,
            snapshot: reread.snapshot,
            replyText: reread.replyText || waited.replyText,
            replyObserved: Boolean(reread.replyText || waited.replyObserved),
            generationObserved: Boolean(waited.generationObserved || reread.snapshot?.generating || reread.snapshot?.streaming),
            completion: reread.replyText ? 'complete' : waited.completion,
          };
        }
        if (!waited.replyObserved || !String(waited.replyText || '').trim()) {
          return {
            status: 'reply_not_observed',
            sent_message: text,
            reply_text: waited.replyText || '',
            page_url: waited.snapshot?.url || '',
            send_confirmed: true,
            generation_observed: waited.generationObserved,
            reply_observed: Boolean(waited.replyObserved),
            note: '已发出但没有读到稳定的助手回复',
            recovery_hint: 'read_again_do_not_resend',
            completion: waited.completion,
          };
        }

        return {
          status: 'ok',
          sent_message: text,
          reply_text: waited.replyText,
          page_url: waited.snapshot?.url || '',
          send_confirmed: true,
          generation_observed: waited.generationObserved,
          reply_observed: true,
          completion: waited.completion,
          note: waited.completion === 'complete' ? '' : `completion=${waited.completion}`,
        };
      });
    },
  };
}
