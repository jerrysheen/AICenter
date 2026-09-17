import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiCenterServer } from '../apps/web/src/server.js';

test('translate API returns injected engine payload', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-translate-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    translateService: {
      async translate(input) {
        return {
          sourceText: input.text,
          translatedText: '你好',
          targetLang: input.targetLang,
          engine: 'deepl',
        };
      },
    },
  });
  const address = await app.listen();
  try {
    const payload = await fetch(`${address.localUrl}/api/v1/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    }).then((response) => response.json());
    assert.equal(payload.ok, true);
    assert.equal(payload.translation.engine, 'deepl');
    assert.equal(payload.translation.translatedText, '你好');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('translate batch API returns injected item translations', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-translate-batch-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    translateService: {
      async translate() {
        throw new Error('single translate should not run');
      },
      async translateMany(input) {
        return {
          targetLang: input.targetLang,
          translations: input.items.map((item) => ({
            id: item.id,
            sourceText: item.text,
            translatedText: `译:${item.text}`,
            targetLang: input.targetLang,
            engine: 'gemini',
            cached: false,
          })),
        };
      },
    },
  });
  const address = await app.listen();
  try {
    const payload = await fetch(`${address.localUrl}/api/v1/translate/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { id: 'x:1', text: 'hello' },
          { id: 'x:2', text: 'world' },
        ],
      }),
    }).then((response) => response.json());
    assert.equal(payload.ok, true);
    assert.equal(payload.translations.length, 2);
    assert.equal(payload.translations[0].translatedText, '译:hello');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('feed translation persist API accepts client-uploaded translations', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-translate-persist-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
  });
  const address = await app.listen();
  try {
    const payload = await fetch(`${address.localUrl}/api/v1/feed/translations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        translations: [{
          id: 'x:1',
          sourceText: 'hello',
          translatedText: '你好',
          engine: 'gemini',
        }],
      }),
    }).then((response) => response.json());
    assert.equal(payload.ok, true);
    assert.equal(payload.saved, 1);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
