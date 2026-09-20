import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredBrowserRuntime } from '../packages/connectors/src/browser/index.js';
import { createChatGptChatClient, parseConversationUrl } from '../packages/connectors/src/chatgpt/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot });

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function usage() {
  console.log(`用法：
  node scripts/ask-chatgpt.mjs --inspect
  node scripts/ask-chatgpt.mjs --prepare
  node scripts/ask-chatgpt.mjs --dispatch "问题"
  node scripts/ask-chatgpt.mjs --harvest https://chatgpt.com/c/<id>
`);
}

const args = process.argv.slice(2);
const asJson = args.includes('--as-json');
const inspect = args.includes('--inspect');
const prepare = args.includes('--prepare');
const dispatchFlag = args.includes('--dispatch');
const harvestFlag = args.includes('--harvest');
const rest = args.filter((item) => !item.startsWith('--'));
const runtime = createConfiguredBrowserRuntime({ defaultBrowserId: instance.browserId });
const client = createChatGptChatClient({ browserRuntime: runtime });

const health = await runtime.health();
if (!health.available) {
  console.error('BrowserSkill 未连接。请先在 Chrome 打开扩展并连上 daemon。');
  process.exitCode = 1;
} else if (inspect) {
  const snapshot = await client.inspect();
  printJson(snapshot);
} else if (prepare) {
  const snapshot = await client.prepare();
  printJson(snapshot);
  if (!snapshot.surfaceApplied || !snapshot.thinkingApplied) process.exitCode = 2;
} else if (harvestFlag || parseConversationUrl(rest[0] || '')) {
  const target = rest[0] || '';
  const result = await client.harvest(target);
  if (asJson) printJson(result);
  else {
    console.log(`[chatgpt] status=${result.status} url=${result.page_url}`);
    if (result.reply_text) console.log(result.reply_text);
    else if (result.note) console.log(result.note);
  }
  if (result.status !== 'ok' && result.status !== 'generating') process.exitCode = 2;
} else if (dispatchFlag || rest[0]) {
  const question = rest.join(' ').trim();
  const result = await client.dispatch(question);
  if (asJson) printJson(result);
  else {
    console.log(`[chatgpt] status=${result.status} url=${result.page_url}`);
    if (result.note) console.log(result.note);
  }
  if (result.status !== 'sent') process.exitCode = 2;
} else {
  usage();
  process.exitCode = 1;
}
