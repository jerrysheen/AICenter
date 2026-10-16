import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../packages/database/src/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, eventId] = process.argv.slice(2);
const instance = resolveInstanceConfig({ repositoryRoot: root });
const store = createStore(instance.databasePath);

function printCandidate(row) {
  const volume = row.volume24h || '0';
  const total = row.totalVolume || '0';
  console.log(`${row.eventId}\t${row.tagSlug}\t24h ${volume}\t累计 ${total}\t${row.title}`);
}

try {
  const repository = store.repositories.polymarket;
  if (command === 'list') {
    const rows = repository.listCandidates('pending');
    if (!rows.length) console.log('没有待审核的候选市场');
    for (const row of rows) printCandidate(row);
  } else if ((command === 'approve' || command === 'reject') && eventId) {
    const ok = repository.reviewCandidate(eventId, command === 'approve' ? 'approved' : 'rejected', Date.now());
    if (!ok) {
      console.error(`没有待审核的候选：${eventId}`);
      process.exitCode = 1;
    } else {
      console.log(command === 'approve' ? `已通过 ${eventId}，下一次观察清单抓取会把它加到页面` : `已拒绝 ${eventId}`);
    }
  } else {
    console.error('用法：node scripts/polymarket-review.mjs list | approve <eventId> | reject <eventId>');
    process.exitCode = 1;
  }
} finally {
  store.close();
}
