import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { createStore } from '../packages/database/src/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
resolveInstanceConfig({ repositoryRoot });

const hasDeepSeek = Boolean(String(process.env.DEEPSEEK_API_KEY || '').trim());
const hasElucid = Boolean(String(process.env.ELUCID_GROK_API_KEY || process.env.AI_CENTER_GROK_API_KEY || '').trim());
if (!hasDeepSeek && !hasElucid) {
  console.error('live-harness-ask: missing ELUCID_GROK_API_KEY or DEEPSEEK_API_KEY');
  process.exit(2);
}

const message = process.argv.slice(2).join(' ').trim() || '用一句话介绍你自己。不要调用工具。';
const webMode = String(process.env.AI_CENTER_LIVE_WEB_MODE || 'off').trim() || 'off';
const directory = mkdtempSync(path.join(os.tmpdir(), 'aicenter-live-harness-'));
const store = createStore(path.join(directory, 'ai-center.db'));
const worker = createAiCenterWorker({
  store,
  workerId: 'live-harness-ask',
  instanceRoot: directory,
  dataDirectory: directory,
  runtimeDirectory: path.join(directory, 'runtime'),
  agentQuality: null,
  env: process.env,
});

try {
  const job = store.createJob({
    type: 'ai.agent.run',
    input: { message, webMode },
    maxAttempts: 1,
  });
  const completed = await worker.runner.runOnce();
  const failed = completed.status !== 'completed';
  const error = completed.error || completed.output?.error || null;
  const errorText = typeof error === 'string'
    ? error
    : error?.message
      ? `${error.name || 'Error'}: ${error.message}`
      : error
        ? JSON.stringify(error)
        : '';
  console.log(JSON.stringify({
    ok: !failed,
    status: completed.status,
    providerId: completed.output?.providerId || null,
    modelId: completed.output?.modelId || null,
    sessionId: completed.output?.sessionId || null,
    warnings: completed.output?.warnings || [],
    error: failed ? errorText.slice(0, 2_000) : '',
    answer: String(completed.output?.answer || '').slice(0, 800),
  }, null, 2));
  if (failed) process.exitCode = 1;
} finally {
  await worker.close();
  rmSync(directory, { recursive: true, force: true });
}
