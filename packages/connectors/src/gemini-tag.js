import { createGeminiGrokTaskRouter } from './gemini-grok-task.js';

const OUTPUT_HINT = '只返回 JSON 对象，不要解释。格式固定为：\n{"items":[{"item_id":"原始id","tags":["catalog里的tag_id"]}]}';
export function createGeminiTagPort(options = {}) {
  const router = createGeminiGrokTaskRouter({...options,geminiApiKey:options.apiKey,geminiApiRoot:options.apiRoot,geminiModel:options.model});
  return Object.freeze({
    async tagBatch(input = {}) {
      const system = [String(input.systemPrompt || '').trim(),OUTPUT_HINT].filter(Boolean).join('\n\n');
      const result = await router.generate({system,prompt:JSON.stringify(input.userPayload || {})});
      return {reply_text:result.text,model:result.engine};
    },
  });
}
