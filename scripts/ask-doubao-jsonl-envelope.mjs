import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredBrowserRuntime } from '../packages/connectors/src/browser/index.js';
import { createDoubaoConnector } from '../packages/connectors/src/doubao/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import {
  buildConceptSeedExtractEnvelope,
  jsonlEnvelopeLine,
  normalizeConceptSeedOutput,
} from '../packages/connectors/src/doubao/envelope.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot: root });
const relativePath = 'knowledge/finance/frameworks/tech-growth-company.md';
const content = await readFile(path.join(instance.knowledgeDirectory, 'finance/frameworks/tech-growth-company.md'), 'utf8');

const envelope = buildConceptSeedExtractEnvelope({
  customId: 'concept_seed_extract_0001',
  batchId: 'seed_batch_0001',
  files: [{
    path: relativePath.replaceAll('\\', '/'),
    title: 'Technology Growth Company Analysis',
    content,
  }],
});
const line = jsonlEnvelopeLine(envelope);

const runtime = createConfiguredBrowserRuntime({ defaultBrowserId: instance.browserId });
const health = await runtime.health();
if (!health.available) {
  console.error('浏览器扩展未连接。请在 Chrome 打开 BrowserSkill 扩展并连上当前 daemon。');
  process.exitCode = 1;
} else {
  const { queue } = createDoubaoConnector({ browserRuntime: runtime });
  const asked = await queue.enqueue({ question: line, purpose: 'cli.concept-seed' });
  const output = normalizeConceptSeedOutput(asked.reply_text || '', {
    fallbackPath: relativePath.replaceAll('\\', '/'),
  });
  const report = {
    status: asked.status,
    page_url: asked.page_url,
    completion: asked.completion,
    sent_bytes: Buffer.byteLength(line),
    sent_is_single_jsonl_line: !line.includes('\n'),
    custom_id: envelope.custom_id,
    output,
    raw_reply: asked.reply_text || '',
  };
  console.log(JSON.stringify(report, null, 2));
  if (asked.status !== 'ok' || !output || !Array.isArray(output.concept_seeds)) {
    process.exitCode = 2;
  }
}
