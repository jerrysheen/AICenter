import { createDoubaoChatClient } from './chat-browser.js';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function createDoubaoAskQueue(options = {}) {
  const client = options.client || null;
  const runAsk = options.ask || (client && typeof client.ask === 'function'
    ? (question, askOptions) => client.ask(question, askOptions)
    : null);
  if (typeof runAsk !== 'function') {
    throw new Error('豆包发消息队列需要 client.ask 或 ask');
  }
  const now = options.now || (() => Date.now());
  const waiting = [];
  let active = null;
  let pumping = false;

  function snapshot() {
    return {
      queued: waiting.length,
      active: active
        ? { id: active.id, purpose: active.purpose, enqueuedAt: active.enqueuedAt }
        : null,
    };
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (waiting.length) {
        const job = waiting.shift();
        active = { id: job.id, purpose: job.purpose, enqueuedAt: job.enqueuedAt };
        try {
          const asked = await runAsk(job.question, job.askOptions);
          job.resolve({
            ...(asked && typeof asked === 'object' ? asked : { status: 'ask_failed', reply_text: '' }),
            queue: { id: job.id, purpose: job.purpose },
          });
        } catch (error) {
          job.reject(error);
        } finally {
          active = null;
        }
      }
    } finally {
      pumping = false;
      if (waiting.length) await pump();
    }
  }

  function enqueue(input = {}) {
    const question = text(input.question || input.text);
    const purpose = text(input.purpose) || 'ask';
    const id = text(input.id) || `doubao_ask_${now()}`;
    return new Promise((resolve, reject) => {
      waiting.push({
        id,
        purpose,
        question,
        askOptions: input.askOptions && typeof input.askOptions === 'object' ? input.askOptions : {},
        enqueuedAt: now(),
        resolve,
        reject,
      });
      pump();
    });
  }

  return {
    enqueue,
    ask(question, askOptions = {}) {
      return enqueue({
        question,
        purpose: text(askOptions.purpose) || 'ask',
        askOptions,
      });
    },
    inspect() {
      if (client && typeof client.inspect === 'function') return client.inspect();
      throw new Error('当前豆包队列没有 inspect');
    },
    snapshot,
  };
}

export function createDoubaoConnector(options = {}) {
  const chat = options.client || createDoubaoChatClient({
    browserRuntime: options.browserRuntime,
    now: options.now,
  });
  const queue = options.queue || createDoubaoAskQueue({
    client: chat,
    now: options.now,
  });
  return { chat, queue };
}
