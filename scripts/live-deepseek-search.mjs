import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeepSeekSearchProvider } from '../packages/connectors/src/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
resolveInstanceConfig({ repositoryRoot });

const query = process.argv[2] || 'FOMC September 2026 interest rate decision';
const limit = Number(process.argv[3]) || 5;
const provider = createDeepSeekSearchProvider();
const started = Date.now();

try {
  const result = await provider.search({ query, limit });
  console.log(JSON.stringify({
    ok: true,
    providerId: provider.id,
    elapsedMs: Date.now() - started,
    query: result.query,
    available: result.available,
    note: result.note,
    resultCount: result.results.length,
    results: result.results.map((row) => ({
      title: row.title,
      url: row.url,
      snippet: String(row.snippet || '').slice(0, 180),
      publishedAt: row.publishedAt ?? null,
    })),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    providerId: provider.id,
    elapsedMs: Date.now() - started,
    errorName: error?.name || 'Error',
    error: String(error?.message || error).slice(0, 400),
  }, null, 2));
  process.exitCode = 1;
}
