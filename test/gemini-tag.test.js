import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiTagPort } from '../packages/connectors/src/gemini-tag.js';

test('gemini tag port posts generateContent and returns reply text', async () => {
  const calls = [];
  const port = createGeminiTagPort({
    apiKey: 'gemini-test',
    apiRoot: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.1-flash-lite',
    async fetch(url, options = {}) {
      calls.push([String(url), options.method || 'GET', options.headers, options.body]);
      return {
        ok: true,
        async json() {
          return {
            candidates: [{
              content: { parts: [{ text: '{"items":[{"item_id":"x1","tags":["ai"]}]}' }] },
            }],
          };
        },
      };
    },
  });
  const result = await port.tagBatch({
    systemPrompt: '只打 catalog 里的标签',
    userPayload: { items: [{ item_id: 'x1', text: 'OpenAI released a model' }] },
  });
  assert.equal(result.model, 'gemini');
  assert.equal(result.reply_text, '{"items":[{"item_id":"x1","tags":["ai"]}]}');
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /models\/gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(calls[0][2]['x-goog-api-key'], 'gemini-test');
  const body = JSON.parse(String(calls[0][3]));
  assert.match(body.systemInstruction.parts[0].text, /只打 catalog 里的标签/);
  assert.match(body.contents[0].parts[0].text, /OpenAI released a model/);
});

test('gemini tag port fails closed without a key', async () => {
  const port = createGeminiTagPort({ apiKey: '' });
  await assert.rejects(() => port.tagBatch({ userPayload: { items: [] } }), /GEMINI_API_KEY/);
});
