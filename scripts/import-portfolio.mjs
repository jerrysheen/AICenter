import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../packages/database/src/index.js';
import { createTradingService } from '../packages/domain/src/trading-service.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '..');
const sourceFile = process.argv[2];

if (!sourceFile) {
  console.error('用法: npm run import:portfolio -- <portfolio-import.json>');
  process.exitCode = 2;
} else {
  const instance = resolveInstanceConfig({ repositoryRoot });
  const payload = JSON.parse(readFileSync(path.resolve(sourceFile), 'utf8'));
  const store = createStore(instance.databasePath);
  try {
    const trading = createTradingService({
      tradingRepository: store.repositories.trading,
      sourcePort: Object.freeze({
        async read() {
          throw new Error('PortfolioImport 不需要行情端口');
        },
      }),
    });
    const result = trading.importPortfolio(payload);
    console.log(JSON.stringify({ instanceId: instance.instanceId, ...result }, null, 2));
  } finally {
    store.close();
  }
}
