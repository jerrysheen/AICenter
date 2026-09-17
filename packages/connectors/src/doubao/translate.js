import { createDoubaoChatClient } from './chat-browser.js';
import { createDoubaoAskQueue } from './ask-queue.js';
import {
  acceptFeedTranslateOutput,
  buildFeedTranslateEnvelope,
  feedTranslateOutputComplete,
  jsonlEnvelopeLine,
} from './envelope.js';

const JSONL_HANG_REASONS = new Set([
  'reply_not_observed',
  'ask_failed',
  'send_not_confirmed',
  'login_required',
  'timeout',
  'invalid_input',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isDoubaoTranslateHangReason(reason) {
  return JSONL_HANG_REASONS.has(text(reason));
}

function resolveAsk(options = {}) {
  if (typeof options.ask === 'function') return options.ask;
  if (options.queue && typeof options.queue.enqueue === 'function') {
    return (question, askOptions) => options.queue.enqueue({
      question,
      purpose: text(askOptions?.purpose) || 'feed.translate',
      askOptions,
    });
  }
  if (options.client && typeof options.client.enqueue === 'function') {
    return (question, askOptions) => options.client.enqueue({
      question,
      purpose: text(askOptions?.purpose) || 'feed.translate',
      askOptions,
    });
  }
  if (options.client && typeof options.client.ask === 'function') {
    const queue = createDoubaoAskQueue({ client: options.client, now: options.now });
    return (question, askOptions) => queue.enqueue({
      question,
      purpose: text(askOptions?.purpose) || 'feed.translate',
      askOptions,
    });
  }
  if (options.browserRuntime) {
    const queue = createDoubaoAskQueue({
      client: createDoubaoChatClient({
        browserRuntime: options.browserRuntime,
        now: options.now,
        maxTimeoutMs: options.maxTimeoutMs || 75_000,
        idleTimeoutMs: options.idleTimeoutMs || 12_000,
        stableChecks: options.stableChecks || 2,
      }),
      now: options.now,
    });
    return (question, askOptions) => queue.enqueue({
      question,
      purpose: text(askOptions?.purpose) || 'feed.translate',
      askOptions,
    });
  }
  return null;
}

export function createDoubaoJsonlTranslatePort(options = {}) {
  const runAsk = resolveAsk(options);
  if (typeof runAsk !== 'function') {
    throw new Error('Doubao JSONL 翻译需要 browserRuntime、client、queue 或 ask');
  }
  const now = options.now || (() => Date.now());

  return {
    async translateBatch({ items = [], targetLang = 'zh' } = {}) {
      const rows = (Array.isArray(items) ? items : [])
        .map((item) => ({ id: text(item?.id), text: text(item?.text || item?.body) }))
        .filter((item) => item.id && item.text);
      if (!rows.length) return { ok: false, reason: 'empty_input', translations: [] };
      const batchId = text(options.batchId) || `translate_batch_${now()}`;
      const itemIds = rows.map((item) => item.id);
      const envelope = buildFeedTranslateEnvelope({
        batchId,
        customId: `feed_translate_${batchId}`,
        targetLang,
        items: rows,
      });
      let asked;
      try {
        asked = await runAsk(jsonlEnvelopeLine(envelope), {
          purpose: 'feed.translate',
          reloadOnce: true,
          isComplete(reply) {
            return feedTranslateOutputComplete(reply, { batchId, itemIds });
          },
        });
      } catch (error) {
        return {
          ok: false,
          reason: 'ask_failed',
          translations: [],
          note: error instanceof Error ? error.message : String(error),
        };
      }
      const accepted = acceptFeedTranslateOutput(asked?.reply_text, { batchId, itemIds });
      if (accepted.ok) return accepted;
      if (!asked || asked.status !== 'ok') {
        return { ok: false, reason: asked?.status || 'ask_failed', translations: [] };
      }
      return accepted;
    },
  };
}
