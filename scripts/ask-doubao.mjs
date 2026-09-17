import { createConfiguredBrowserRuntime } from '../packages/connectors/src/browser/index.js';
import { createDoubaoConnector } from '../packages/connectors/src/doubao/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

function parseArgs(argv) {
  const rest = [];
  let inspect = false;
  let asJson = false;
  for (const arg of argv) {
    if (arg === '--inspect') inspect = true;
    else if (arg === '--as-json' || arg === '--json') asJson = true;
    else rest.push(arg);
  }
  return { inspect, asJson, question: rest.join(' ').trim() };
}

const args = parseArgs(process.argv.slice(2));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot });
const runtime = createConfiguredBrowserRuntime({ defaultBrowserId: instance.browserId });
const health = await runtime.health();
if (!health.available) {
  console.error('浏览器扩展未连接。请在 Chrome 打开 BrowserSkill 扩展并连上当前 daemon。');
  process.exitCode = 1;
} else {
  const { chat, queue } = createDoubaoConnector({ browserRuntime: runtime });
  if (args.inspect) {
    const snapshot = await chat.inspect();
    console.log(JSON.stringify(snapshot, null, 2));
    if (!snapshot.loggedIn) process.exitCode = 2;
  } else if (!args.question) {
    console.error('用法: node scripts/ask-doubao.mjs "问题"');
    console.error('      node scripts/ask-doubao.mjs --inspect');
    process.exitCode = 1;
  } else {
    const result = await queue.enqueue({ question: args.question, purpose: 'cli.ask' });
    if (args.asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === 'ok') {
      console.log(result.reply_text);
    } else {
      console.error(JSON.stringify(result, null, 2));
    }
    if (result.status !== 'ok') process.exitCode = 2;
  }
}
