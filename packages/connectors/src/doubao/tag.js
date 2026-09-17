import { jsonlEnvelopeLine } from './envelope.js';
import { createDoubaoChatClient } from './chat-browser.js';
import { createDoubaoAskQueue } from './ask-queue.js';

export const TAG_INPUT_SCHEMA = 'tag_texts_input.v0.1';
export const TAG_OUTPUT_SCHEMA = 'tag_texts_output.v0.1';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function tagReplyLooksComplete(reply, itemIds = []) {
  const source = text(reply).replace(/展开全部/g, '');
  if (!/"tags"\s*:\s*\[/.test(source)) return false;
  const ids = (Array.isArray(itemIds) ? itemIds : []).map((id) => text(id)).filter(Boolean);
  if (!ids.length) return true;
  return ids.every((id) => new RegExp(
    `"item_id"\\s*:\\s*"${escapeRegExp(id)}"[\\s\\S]{0,240}"tags"\\s*:\\s*\\[`,
  ).test(source));
}

export function buildTagEnvelope(options = {}) {
  const customId = String(options.customId || 'tag_0001').trim();
  const systemPrompt = String(options.systemPrompt || '').trim();
  const userPayload = options.userPayload && typeof options.userPayload === 'object'
    ? options.userPayload
    : {};
  return {
    custom_id: customId,
    task: 'tag_texts',
    input_schema_version: TAG_INPUT_SCHEMA,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: '请基于下面输入 JSON 为每条文本打标签，并只输出固定 JSON。\n\n输入 JSON：\n{{INPUT_JSON}}',
      },
    ],
    input_template: {
      schema_version: TAG_INPUT_SCHEMA,
      ...userPayload,
    },
    output_schema_hint: TAG_OUTPUT_SCHEMA,
  };
}

function resolveAsk(options = {}) {
  if (typeof options.ask === 'function') return options.ask;
  if (options.queue && typeof options.queue.enqueue === 'function') {
    return (question, askOptions) => options.queue.enqueue({
      question,
      purpose: text(askOptions?.purpose) || 'tag.analyze',
      askOptions,
    });
  }
  if (options.client && typeof options.client.ask === 'function') {
    const queue = createDoubaoAskQueue({ client: options.client, now: options.now });
    return (question, askOptions) => queue.enqueue({
      question,
      purpose: text(askOptions?.purpose) || 'tag.analyze',
      askOptions,
    });
  }
  if (options.browserRuntime) {
    const client = createDoubaoChatClient({ browserRuntime: options.browserRuntime, now: options.now });
    const queue = createDoubaoAskQueue({ client, now: options.now });
    return (question, askOptions) => queue.enqueue({
      question,
      purpose: text(askOptions?.purpose) || 'tag.analyze',
      askOptions,
    });
  }
  throw new Error('豆包 JSONL 标注需要 browserRuntime、queue、client 或 ask');
}

export function createDoubaoJsonlTagPort(options = {}) {
  const runAsk = resolveAsk(options);
  return {
    async tagBatch(input = {}) {
      const envelope = buildTagEnvelope(input);
      const itemIds = (Array.isArray(input.userPayload?.items) ? input.userPayload.items : [])
        .map((item) => text(item?.item_id || item?.itemId || item?.id))
        .filter(Boolean);
      const asked = await runAsk(jsonlEnvelopeLine(envelope), {
        purpose: 'tag.analyze',
        reloadOnce: false,
        idleTimeoutMs: 20_000,
        maxTimeoutMs: 12 * 60_000,
        stableChecks: 3,
        isComplete(reply) {
          return tagReplyLooksComplete(reply, itemIds);
        },
      });
      const reply = text(asked?.reply_text);
      if (!reply) {
        throw new Error(`豆包标注失败：${asked?.status || 'ask_failed'}`);
      }
      return {
        reply_text: asked.reply_text,
        model: asked.model || 'doubao-web',
      };
    },
  };
}
