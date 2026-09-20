import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTypeSafeSystemOneClient } from '../packages/connectors/src/index.js';
import { createStore } from '../packages/database/src/index.js';
import { createFeedFilter } from '../packages/domain/src/feed-filter.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot });
const store = createStore(instance.databasePath);
const client = createTypeSafeSystemOneClient();
const filter = createFeedFilter({ client });

const fixtures = [
  { provider: 'fixture', externalId: 'cta', title: '查看更多...', body: '查看更多...', expected: 'ignore' },
  { provider: 'fixture', externalId: 'emoji', title: '😂😂', body: '😂😂', expected: 'ignore' },
  { provider: 'fixture', externalId: 'hello', title: 'Great!', body: 'Great!', expected: 'ignore' },
  { provider: 'fixture', externalId: 'nand', title: '三星 NAND 报价上调 10%', body: '三星 NAND 报价上调 10%', expected: 'keep' },
  { provider: 'fixture', externalId: 'nvda', title: 'NVDA +5%', body: 'NVDA +5%', expected: 'keep' },
];

function preview(item) {
  const text = String(item.body || item.summary || item.title || '').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function sample(provider, limit = 4) {
  return (store.repositories.feed.listContentItemsByProvider('local', provider, { limit }) || [])
    .map((item) => ({
      provider,
      externalId: item.externalId,
      title: item.title || '',
      body: item.body || item.summary || '',
      summary: item.summary || '',
      authorName: item.authorName || '',
    }));
}

const items = [...fixtures, ...sample('x'), ...sample('bilibili')];

console.log(JSON.stringify({
  available: client.available(),
  mode: filter.config.mode,
  version: filter.config.version,
  itemCount: items.length,
}, null, 2));

const rows = [];
for (const item of items) {
  const started = Date.now();
  const verdict = await filter.evaluate({ item, provider: item.provider });
  rows.push({
    provider: item.provider,
    expected: item.expected || '',
    preview: preview(item),
    action: verdict.wouldKeep ? 'KEEP' : 'IGNORE',
    applied: verdict.action,
    stage: verdict.stage,
    reason: verdict.reason,
    failOpen: Boolean(verdict.failOpen),
    scores: verdict.scores || {},
    model: verdict.model || '',
    ms: Date.now() - started,
  });
}

store.close();
console.log(JSON.stringify(rows, null, 2));
