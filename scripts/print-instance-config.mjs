import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '..');
const args = process.argv.slice(2);

function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '').trim() : '';
}

const instance = resolveInstanceConfig({
  repositoryRoot,
  overrides: {
    instanceId: argument('--instance-id'),
    instanceRoot: argument('--instance-root'),
    port: argument('--port'),
  },
});

console.log(JSON.stringify({
  instanceId: instance.instanceId,
  instanceRoot: instance.instanceRoot,
  legacyLayout: instance.legacyLayout,
  runtimeDirectory: instance.runtimeDirectory,
  port: instance.port,
}));
