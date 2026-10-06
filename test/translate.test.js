import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTranslateService,
  needsTranslation,
  parseGeminiBatchTranslations,
  parseGeminiGenerateContent,
} from '../packages/connectors/src/translate/index.js';

test('gemini generateContent payload reads candidate text', () => {
  assert.equal(parseGeminiGenerateContent({
    candidates: [{ content: { parts: [{ text: 'SK海力士表示将扩大 HBM 产能。' }] } }],
  }), 'SK海力士表示将扩大 HBM 产能。');
});

test('needsTranslation skips already-chinese text and keeps english/korean', () => {
  assert.equal(needsTranslation('今天市场整体偏强，沪深成交额放大。'), false);
  assert.equal(needsTranslation('NVIDIA announced a new HBM partnership.'), true);
  assert.equal(needsTranslation('SK하이닉스가 HBM 생산능력을 확대할 계획이라고 밝혔다.'), true);
  assert.equal(needsTranslation('推荐一个挺硬核的开源量化项目：stock，作者直接把量化交易代码扔 GitHub 了。'), false);
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

test('translation requires Gemini or Elucid credentials and never uses removed providers',async()=>{
 const service=createTranslateService({geminiApiKey:'',elucidApiKey:'',authKey:'ignored',fetch:async()=>{throw new Error('Unexpected provider request');}});
 await assert.rejects(service.translate({text:'Hello from another business report.'}),/GEMINI_API_KEY.*ELUCID_GROK_API_KEY/);
});
