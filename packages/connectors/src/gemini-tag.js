import { extractTagBatchObject } from '../../domain/src/tag-parser.js';
import { GEMMA_26B, createGemmaTranslationRouter, gemmaPreprocessInput, gemmaTagInput } from './translate/gemma.js';

const OUTPUT_HINT = '只返回 JSON 对象，不要解释。格式固定为：\n{"items":[{"item_id":"原始id","tags":["catalog里的tag_id"]}]}';
const PREPROCESS_HINT = '只返回一个 JSON 对象，不要解释。格式固定为：\n{"item_id":"原始id","translated_text":"简体中文译文","tags":["catalog里的tag_id"]}';

export const GEMMA_TAG_MODEL = GEMMA_26B;
export const GEMMA_TAG_TOKEN_LIMIT = 16_000;
export const GEMMA_TAG_OUTPUT_TOKENS = 4096;

export function estimateGemmaTagTokens(value) {
  let quarters = 0;
  for (const char of String(value ?? '')) quarters += char.codePointAt(0) > 127 ? 4 : 1;
  return Math.ceil(quarters / 4);
}

export function resolveGemmaTagModel(env = process.env) {
  const configured = String(env.AI_CENTER_GEMMA_TAG_MODEL || '').trim();
  const model = configured || GEMMA_TAG_MODEL;
  if (model !== GEMMA_TAG_MODEL) throw new Error('信息流标注只使用 Gemma 26B');
  return model;
}

function tagPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { items: [] };
  return { ...payload, items: Array.isArray(payload.items) ? payload.items : [] };
}

function tagCost(system, shell, items) {
  const prompt = JSON.stringify({ ...shell, items });
  return estimateGemmaTagTokens(gemmaTagInput(system, prompt)) + GEMMA_TAG_OUTPUT_TOKENS;
}

export function packGemmaTagPayloads(system, payload) {
  const source = tagPayload(payload);
  const items = source.items;
  const shell = { ...source, items: [] };
  const whole = tagCost(system, shell, items);
  if (!items.length || whole <= GEMMA_TAG_TOKEN_LIMIT) return [{ payload: source, estimatedTokens: whole }];
  const groups = [];
  let current = [];
  for (const item of items) {
    if (!current.length) {
      current = [item];
      continue;
    }
    if (tagCost(system, shell, current.concat(item)) > GEMMA_TAG_TOKEN_LIMIT) {
      groups.push(current);
      current = [item];
    } else {
      current = current.concat(item);
    }
  }
  if (current.length) groups.push(current);
  return groups.map((group) => {
    const estimatedTokens = tagCost(system, shell, group);
    if (estimatedTokens > GEMMA_TAG_TOKEN_LIMIT) {
      throw Object.assign(new Error('Gemma 标注这一条超过每分钟 token 上限'), { code: 'budget-deferred' });
    }
    return { payload: { ...shell, items: group }, estimatedTokens };
  });
}

export function createGeminiTagPort(options = {}) {
  const env = options.env || process.env;
  const model = resolveGemmaTagModel(env);
  const router = options.router || createGemmaTranslationRouter({
    env,
    apiKey: options.apiKey,
    fetch: options.fetch,
    quotaRepository: options.quotaRepository,
    now: options.now,
    sleep: options.sleep,
    random: options.random,
    usageObserver: options.usageObserver,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    models: model,
    usageStage: 'tagging',
  });
  return Object.freeze({
    async tagBatch(input = {}) {
      const system = [String(input.systemPrompt || '').trim(), OUTPUT_HINT].filter(Boolean).join('\n\n');
      const parts = packGemmaTagPayloads(system, input.userPayload || {});
      const items = [];
      for (const part of parts) {
        const result = await router.generate({
          system,
          prompt: JSON.stringify(part.payload),
          model,
          task: 'tag',
          estimatedTokens: part.estimatedTokens,
        });
        const extracted = extractTagBatchObject(result?.text);
        if (!extracted?.items) throw new Error('Gemma 标注没有返回标签');
        items.push(...extracted.items);
      }
      return { reply_text: JSON.stringify({ items }), model };
    },
    async preprocessItem(input = {}) {
      const system = [String(input.systemPrompt || '').trim(), PREPROCESS_HINT].filter(Boolean).join('\n\n');
      const prompt = JSON.stringify(input.userPayload || {});
      const estimatedTokens = estimateGemmaTagTokens(gemmaPreprocessInput(system, prompt)) + GEMMA_TAG_OUTPUT_TOKENS;
      if (estimatedTokens > GEMMA_TAG_TOKEN_LIMIT) {
        throw Object.assign(new Error('Gemma 预处理这一条超过每分钟 token 上限'), { code: 'budget-deferred' });
      }
      const result = await router.generate({
        system,
        prompt,
        model,
        task: 'preprocess',
        estimatedTokens,
      });
      return { reply_text: result?.text || '', model: result?.engine || model };
    },
  });
}
