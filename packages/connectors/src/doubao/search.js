import { createDoubaoAskQueue } from './ask-queue.js';
import { createDoubaoChatClient } from './chat-browser.js';

const MAX_NOTE_CHARS = 4_000;
const DEFAULT_IDLE_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_TIMEOUT_MS = 80_000;

function clip(value, max) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildDoubaoWebSearchPrompt({ question, query } = {}) {
  const asked = clip(question, 1_200) || '（无）';
  const term = clip(query, 300) || asked;
  return [
    '请用你能检索到的公开网页，补充下面问题的最新事实。',
    '只写事实、时间和来源名称。不确定就写不确定。不要投资建议，不要复述问题。',
    '',
    `用户问题：${asked}`,
    `检索词：${term}`,
  ].join('\n');
}

export function noteFromDoubaoAsk(result) {
  if (!result || result.status !== 'ok') return '';
  return clip(result.reply_text, MAX_NOTE_CHARS);
}

export function createDoubaoAuxiliarySearch(options = {}) {
  const idleTimeoutMs = Number(options.idleTimeoutMs) > 0
    ? Number(options.idleTimeoutMs)
    : DEFAULT_IDLE_TIMEOUT_MS;
  const maxTimeoutMs = Number(options.maxTimeoutMs) > 0
    ? Number(options.maxTimeoutMs)
    : DEFAULT_MAX_TIMEOUT_MS;
  const now = options.now || (() => Date.now());
  const queue = options.queue || createDoubaoAskQueue({
    client: options.client || createDoubaoChatClient({
      browserRuntime: options.browserRuntime,
      now,
      idleTimeoutMs,
      maxTimeoutMs,
    }),
    now,
  });

  return Object.freeze({
    begin({ question, query, signal } = {}) {
      const startedAt = now();
      if (signal?.aborted) {
        return { startedAt, promise: Promise.resolve({ text: '', status: 'aborted' }) };
      }
      const promise = queue.ask(buildDoubaoWebSearchPrompt({ question, query }), {
        purpose: 'web-search',
        idleTimeoutMs,
        maxTimeoutMs,
      }).then((asked) => ({
        text: noteFromDoubaoAsk(asked),
        status: String(asked?.status || 'ask_failed'),
      })).catch(() => ({ text: '', status: 'ask_failed' }));
      return { startedAt, promise };
    },
  });
}
