import { createConfiguredBrowserRuntime } from '../packages/connectors/src/browser/index.js';
import { createDoubaoConnector } from '../packages/connectors/src/doubao/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import {
  DOUBAO_TRANSLATE_JSONL_SAMPLE,
  buildDoubaoTranslateJsonlPrompt,
  parseDoubaoTranslateJsonl,
} from '../packages/connectors/src/doubao/jsonl.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot });
const runtime = createConfiguredBrowserRuntime({ defaultBrowserId: instance.browserId });
const health = await runtime.health();
if (!health.available) {
  console.error('浏览器扩展未连接。请在 Chrome 打开 BrowserSkill 扩展并连上当前 daemon。');
  process.exitCode = 1;
} else {
  const { queue } = createDoubaoConnector({ browserRuntime: runtime });
  const prompt = buildDoubaoTranslateJsonlPrompt(DOUBAO_TRANSLATE_JSONL_SAMPLE);
  const asked = await queue.enqueue({ question: prompt, purpose: 'cli.translate-sample' });
  const translations = parseDoubaoTranslateJsonl(asked.reply_text || '');
  const expectedIds = DOUBAO_TRANSLATE_JSONL_SAMPLE.map((item) => item.id);
  const gotIds = translations.map((item) => item.id);
  const missing = expectedIds.filter((id) => !gotIds.includes(id));
  const extra = gotIds.filter((id) => !expectedIds.includes(id));
  const report = {
    status: asked.status,
    page_url: asked.page_url,
    completion: asked.completion,
    expected_count: expectedIds.length,
    parsed_count: translations.length,
    missing_ids: missing,
    extra_ids: extra,
    looks_like_json_array: /^\s*\[/.test(String(asked.reply_text || '').trim()),
    translations,
    raw_reply: asked.reply_text || '',
  };
  console.log(JSON.stringify(report, null, 2));
  if (asked.status !== 'ok' || missing.length || translations.length !== expectedIds.length) {
    process.exitCode = 2;
  }
}
