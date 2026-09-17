import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTranslateService,
  needsTranslation,
  parseGeminiBatchTranslations,
  parseGeminiGenerateContent,
  parseGoogleTranslatePayload,
} from '../packages/connectors/src/translate/index.js';
import { createDoubaoJsonlTranslatePort } from '../packages/connectors/src/doubao/translate.js';

test('google payload concatenates translated segments', () => {
  assert.equal(parseGoogleTranslatePayload([[['你好', 'hello'], ['世界', 'world']]]), '你好世界');
});

test('gemini generateContent payload reads candidate text', () => {
  assert.equal(parseGeminiGenerateContent({
    candidates: [{ content: { parts: [{ text: 'SK海力士表示将扩大 HBM 产能。' }] } }],
  }), 'SK海力士表示将扩大 HBM 产能。');
});

test('needsTranslation skips already-chinese text and keeps english/korean', () => {
  assert.equal(needsTranslation('今天市场整体偏强，沪深成交额放大。'), false);
  assert.equal(needsTranslation('NVIDIA announced a new HBM partnership.'), true);
  assert.equal(needsTranslation('SK하이닉스가 HBM 생산능력을 확대할 계획이라고 밝혔다.'), true);
});

test('translate service prefers Gemini when a key is configured', async () => {
  const calls = [];
  const service = createTranslateService({
    geminiApiKey: 'gemini-test',
    geminiApiRoot: 'https://generativelanguage.googleapis.com/v1beta',
    geminiModel: 'gemini-3.1-flash-lite',
    authKey: 'deepl-unused',
    ttlMs: 60_000,
    now: () => 1,
    async fetch(url, options = {}) {
      calls.push([String(url), options.method || 'GET', options.headers, options.body]);
      return {
        ok: true,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: 'SK海力士表示将扩大 HBM 产能。' }] } }],
          };
        },
      };
    },
  });
  const first = await service.translate({
    text: 'SK하이닉스가 HBM 생산능력을 확대할 계획이라고 밝혔다.',
    targetLang: 'zh',
  });
  const second = await service.translate({
    text: 'SK하이닉스가 HBM 생산능력을 확대할 계획이라고 밝혔다.',
  });
  assert.equal(first.engine, 'gemini');
  assert.equal(first.cached, false);
  assert.equal(first.translatedText, 'SK海力士表示将扩大 HBM 产能。');
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /models\/gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(calls[0][2]['x-goog-api-key'], 'gemini-test');
  const body = JSON.parse(String(calls[0][3]));
  assert.equal(body.contents[0].parts[0].text.includes('SK하이닉스'), true);
});

test('translate service never calls Elucid even if an Elucid Grok key is in the environment', async () => {
  const previous = process.env.ELUCID_GROK_API_KEY;
  process.env.ELUCID_GROK_API_KEY = 'elucid-must-not-be-used';
  try {
    const service = createTranslateService({
      geminiApiKey: '',
      authKey: '',
      async fetch(url) {
        assert.doesNotMatch(String(url), /getelucid\.com/);
        assert.match(String(url), /translate\.googleapis\.com/);
        return {
          ok: true,
          async json() {
            return [[['测试', 'test']]];
          },
        };
      },
    });
    const result = await service.translate({ text: 'test' });
    assert.equal(result.engine, 'google');
  } finally {
    if (previous === undefined) delete process.env.ELUCID_GROK_API_KEY;
    else process.env.ELUCID_GROK_API_KEY = previous;
  }
});

test('translate service prefers DeepL when a key is configured', async () => {
  const calls = [];
  const service = createTranslateService({
    geminiApiKey: '',
    authKey: 'test-key',
    apiUrl: 'https://api-free.deepl.com/v2/translate',
    ttlMs: 60_000,
    now: () => 1,
    async fetch(url, options = {}) {
      calls.push([String(url), options.method || 'GET']);
      return {
        ok: true,
        async json() {
          return { translations: [{ text: '你好' }] };
        },
      };
    },
  });
  const first = await service.translate({ text: 'hello', targetLang: 'zh' });
  const second = await service.translate({ text: 'hello' });
  assert.equal(first.engine, 'deepl');
  assert.equal(first.translatedText, '你好');
  assert.equal(second.translatedText, '你好');
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1);
});

test('translate service falls back to Google without a DeepL or Gemini key', async () => {
  const service = createTranslateService({
    geminiApiKey: '',
    authKey: '',
    async fetch(url) {
      assert.match(String(url), /translate\.googleapis\.com/);
      return {
        ok: true,
        async json() {
          return [[['测试', 'test']]];
        },
      };
    },
  });
  const result = await service.translate({ text: 'test' });
  assert.equal(result.engine, 'google');
  assert.equal(result.translatedText, '测试');
});

test('already-chinese text does not call an engine', async () => {
  const service = createTranslateService({
    geminiApiKey: 'gemini-test',
    authKey: 'deepl-unused',
    async fetch() {
      throw new Error('should not fetch');
    },
  });
  const result = await service.translate({ text: '这条推文已经是简体中文正文。' });
  assert.equal(result.engine, 'passthrough');
  assert.equal(result.translatedText, '这条推文已经是简体中文正文。');
});

test('gemini 429 falls back to DeepL', async () => {
  const calls = [];
  const service = createTranslateService({
    geminiApiKey: 'gemini-test',
    authKey: 'deepl-key',
    apiUrl: 'https://api-free.deepl.com/v2/translate',
    async fetch(url) {
      calls.push(String(url));
      if (String(url).includes('generativelanguage.googleapis.com')) {
        return {
          ok: false,
          status: 429,
          async json() {
            return { error: { message: 'RESOURCE_EXHAUSTED' } };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { translations: [{ text: '你好' }] };
        },
      };
    },
  });
  const result = await service.translate({ text: 'hello' });
  assert.equal(result.engine, 'deepl');
  assert.equal(result.translatedText, '你好');
  assert.equal(calls.length, 2);
});

test('gemini batch payload maps ids without changing them', () => {
  assert.deepEqual(parseGeminiBatchTranslations(`
\`\`\`json
[{"id":"x:1","translated":"英伟达宣布扩产。"},{"id":"x:2","translatedText":"SK海力士将扩大产能。"}]
\`\`\`
`), [
    { id: 'x:1', translatedText: '英伟达宣布扩产。' },
    { id: 'x:2', translatedText: 'SK海力士将扩大产能。' },
  ]);
});

test('translateMany sends one Gemini request for pending english and korean items', async () => {
  const calls = [];
  const service = createTranslateService({
    geminiApiKey: 'gemini-test',
    geminiApiRoot: 'https://generativelanguage.googleapis.com/v1beta',
    geminiModel: 'gemini-3.1-flash-lite',
    authKey: '',
    ttlMs: 60_000,
    now: () => 1,
    async fetch(url, options = {}) {
      calls.push(String(url));
      const body = JSON.parse(String(options.body));
      const user = JSON.parse(body.contents[0].parts[0].text);
      assert.equal(user.length, 2);
      return {
        ok: true,
        async json() {
          return {
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify([
                    { id: 'x:1', translated: '英伟达宣布扩产。' },
                    { id: 'x:2', translated: 'SK海力士将扩大产能。' },
                  ]),
                }],
              },
            }],
          };
        },
      };
    },
  });
  const first = await service.translateMany({
    items: [
      { id: 'x:zh', text: '这条已经是简体中文正文。' },
      { id: 'x:1', text: 'NVIDIA announced a capacity expansion.' },
      { id: 'x:2', text: 'SK하이닉스가 HBM 생산능력을 확대할 계획이라고 밝혔다.' },
    ],
  });
  const second = await service.translateMany({
    items: [{ id: 'x:1', text: 'NVIDIA announced a capacity expansion.' }],
  });
  assert.equal(calls.length, 1);
  assert.equal(first.translations.find((row) => row.id === 'x:zh').engine, 'passthrough');
  assert.equal(first.translations.find((row) => row.id === 'x:1').engine, 'gemini');
  assert.equal(first.translations.find((row) => row.id === 'x:2').translatedText, 'SK海力士将扩大产能。');
  assert.equal(second.translations[0].cached, true);
});

test('translateMany prefers Doubao JSONL and leaves missing ids for a later click', async () => {
  const calls = [];
  const service = createTranslateService({
    geminiApiKey: 'gemini-test',
    geminiApiRoot: 'https://generativelanguage.googleapis.com/v1beta',
    geminiModel: 'gemini-3.1-flash-lite',
    authKey: '',
    ttlMs: 60_000,
    now: () => 1,
    jsonlTranslatePort: {
      async translateBatch({ items }) {
        assert.equal(items.length, 2);
        return {
          ok: true,
          translations: [{ id: 'x:1', translatedText: '英伟达宣布扩产。' }],
        };
      },
    },
    async fetch(url) {
      calls.push(String(url));
      return { ok: true, async json() { return {}; } };
    },
  });
  const result = await service.translateMany({
    items: [
      { id: 'x:1', text: 'NVIDIA announced a capacity expansion.' },
      { id: 'x:2', text: 'SK하이닉스가 HBM 생산능력을 확대할 계획이라고 밝혔다.' },
    ],
  });
  assert.equal(result.translations.find((row) => row.id === 'x:1').engine, 'doubao-jsonl');
  assert.equal(result.translations.find((row) => row.id === 'x:2'), undefined);
  assert.equal(calls.length, 0);
});

test('translateMany falls back to Gemini when Doubao JSONL format is rejected', async () => {
  const warnings = [];
  const calls = [];
  const service = createTranslateService({
    geminiApiKey: 'gemini-test',
    geminiApiRoot: 'https://generativelanguage.googleapis.com/v1beta',
    geminiModel: 'gemini-3.1-flash-lite',
    authKey: '',
    ttlMs: 60_000,
    now: () => 1,
    logger: { warn(message) { warnings.push(String(message)); } },
    jsonlTranslatePort: {
      async translateBatch() {
        return { ok: false, reason: 'schema_version', translations: [] };
      },
    },
    async fetch(url, options = {}) {
      calls.push(String(url));
      const user = JSON.parse(JSON.parse(String(options.body)).contents[0].parts[0].text);
      assert.equal(user.length, 1);
      return {
        ok: true,
        async json() {
          return {
            candidates: [{
              content: { parts: [{ text: JSON.stringify([{ id: 'x:1', translated: '英伟达宣布扩产。' }]) }] },
            }],
          };
        },
      };
    },
  });
  const result = await service.translateMany({
    items: [{ id: 'x:1', text: 'NVIDIA announced a capacity expansion.' }],
  });
  assert.equal(result.translations[0].engine, 'gemini');
  assert.equal(calls.length, 1);
  assert.match(warnings[0], /格式验收失败/);
});

test('translateMany returns immediately when Doubao hangs and does not start Gemini', async () => {
  const calls = [];
  const service = createTranslateService({
    geminiApiKey: 'gemini-test',
    geminiApiRoot: 'https://generativelanguage.googleapis.com/v1beta',
    geminiModel: 'gemini-3.1-flash-lite',
    authKey: '',
    ttlMs: 60_000,
    now: () => 1,
    jsonlTranslatePort: {
      async translateBatch() {
        return { ok: false, reason: 'reply_not_observed', translations: [] };
      },
    },
    async fetch(url) {
      calls.push(String(url));
      return { ok: true, async json() { return {}; } };
    },
  });
  await assert.rejects(
    () => service.translateMany({
      items: [{ id: 'x:1', text: 'NVIDIA announced a capacity expansion.' }],
    }),
    /再点一次翻译/,
  );
  assert.equal(calls.length, 0);
});

test('Doubao JSONL translate port accepts JSON even if wait status is not ok', async () => {
  let asked = '';
  const port = createDoubaoJsonlTranslatePort({
    now: () => 1,
    async ask(line) {
      asked = line;
      const parsed = JSON.parse(line);
      return {
        status: 'reply_not_observed',
        reply_text: JSON.stringify({
          schema_version: 'feed_translate_output.v0.1',
          batch_id: parsed.input_template.batch_id,
          translations: [{ id: 'x:1', translated: '你好' }],
        }),
      };
    },
  });
  const result = await port.translateBatch({ items: [{ id: 'x:1', text: 'hello' }] });
  assert.equal(JSON.parse(asked).task, 'translate_feed_items');
  assert.equal(asked.includes('\n'), false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.translations, [{ id: 'x:1', translatedText: '你好' }]);
});
