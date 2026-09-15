import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnectorHandlers } from '../../../packages/connectors/src/index.js';
import { createStore } from '../../../packages/database/src/index.js';
import { createJobRunner } from '../../../packages/runtime/src/job-runner.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '../../..');

export function createAiCenterWorker(options = {}) {
  const dataDirectory = path.resolve(options.dataDirectory || process.env.AI_CENTER_DATA_DIR || path.join(repositoryRoot, 'data'));
  const store = options.store || createStore(path.join(dataDirectory, 'ai-center.db'));
  store.recoverStaleJobs(Number(process.env.AI_CENTER_WORKER_LEASE_MS) || 10 * 60_000);
  const runner = createJobRunner({
    store,
    handlers: options.handlers || createConnectorHandlers(),
    workerId: options.workerId || `${hostname()}-${process.pid}`,
    pollIntervalMs: options.pollIntervalMs || process.env.AI_CENTER_WORKER_POLL_MS,
    onError(error, job) {
      console.error(`[worker] ${job.type} ${job.id}:`, error);
    },
  });
  let runPromise = null;

  return {
    store,
    runner,
    start() {
      runPromise ||= runner.start();
      return runPromise;
    },
    async close() {
      runner.stop();
      try {
        await runPromise;
      } finally {
        store.close();
      }
    },
  };
}

async function main() {
  const worker = createAiCenterWorker();
  console.log(`AI Center worker ${worker.runner.workerId}`);
  const runPromise = worker.start();
  const shutdown = async () => {
    await worker.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await runPromise;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
