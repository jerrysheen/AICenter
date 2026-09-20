import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createConfiguredBrowserRuntime,
  createTwitterService,
  createTypeSafeSystemOneClient,
} from '../packages/connectors/src/index.js';
import { createStore } from '../packages/database/src/index.js';
import { createFeedFilter } from '../packages/domain/src/feed-filter.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot });
const store = createStore(instance.databasePath);
const client = createTypeSafeSystemOneClient();
const filter = createFeedFilter({ client });

function preview(item, max = 120) {
  const text = String(item.body || item.summary || item.title || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function fromStored(limit, seen) {
  return (store.repositories.feed.listContentItemsByProvider('local', 'x', { limit: 200 }) || [])
    .filter((item) => item.externalId && !seen.has(String(item.externalId)))
    .slice(0, limit)
    .map((item) => ({
      source: 'cached',
      provider: 'x',
      externalId: String(item.externalId),
      title: item.title || '',
      body: item.body || item.summary || '',
      summary: item.summary || '',
      authorName: item.authorName || '',
      sourceUrl: item.sourceUrl || '',
    }));
}

const browserRuntime = createConfiguredBrowserRuntime({
  env: process.env,
  defaultBrowserId: instance.browserId,
});
const twitter = createTwitterService({ browserRuntime });
const snapshot = await twitter.getFeed({
  feed: 'for-you',
  limit: 50,
  bypassCache: true,
  excludeExternalIds: [],
});

const liveItems = (snapshot.items || []).map((item) => ({
  source: 'live',
  provider: 'x',
  externalId: String(item.externalId || ''),
  title: item.title || '',
  body: item.body || item.originalText || item.summary || '',
  summary: item.summary || '',
  authorName: item.authorName || '',
  sourceUrl: item.sourceUrl || '',
})).filter((item) => item.externalId);

const seen = new Set(liveItems.map((item) => item.externalId));
const items = [...liveItems];
if (items.length < 50) items.push(...fromStored(50 - items.length, seen));

const rows = [];
for (const item of items) {
  const started = Date.now();
  const verdict = await filter.evaluate({ item, provider: 'x' });
  rows.push({
    source: item.source,
    author: item.authorName || '',
    preview: preview(item),
    action: verdict.wouldKeep ? 'KEEP' : 'IGNORE',
    stage: verdict.stage,
    reason: verdict.reason,
    failOpen: Boolean(verdict.failOpen),
    scores: verdict.scores || {},
    ms: Date.now() - started,
  });
}

const summary = {
  fetchedAt: snapshot.fetchedAt,
  liveMode: snapshot.mode,
  liveNote: snapshot.note,
  liveCount: liveItems.length,
  evaluated: rows.length,
  jevAvailable: client.available(),
  model: rows.find((row) => row.scores && Object.keys(row.scores).length)?.stage ? 'jev' : '',
  keep: rows.filter((row) => row.action === 'KEEP').length,
  ignore: rows.filter((row) => row.action === 'IGNORE').length,
  failOpen: rows.filter((row) => row.failOpen).length,
  deterministicIgnore: rows.filter((row) => row.action === 'IGNORE' && row.stage === 'deterministic').length,
  jevIgnore: rows.filter((row) => row.action === 'IGNORE' && row.stage === 'jev').length,
};

store.close();
const outDir = path.join(instance.runtimeDirectory, 'logs');
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'feed-filter-x50.json');
writeFileSync(outPath, `${JSON.stringify({ summary, snapshotNote: snapshot.note, rows }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ summary, outPath, ignores: rows.filter((row) => row.action === 'IGNORE'), borderline: rows.filter((row) => {
  const residue = Number(row.scores.is_residue);
  const worth = Number(row.scores.worth_keeping);
  return row.action === 'KEEP' && (residue >= 0.6 || (Number.isFinite(worth) && worth <= 0.4));
}) }, null, 2));
