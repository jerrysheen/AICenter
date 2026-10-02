import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { loadMediaConfig } from '../packages/instance/src/media-config.js';
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
import { createStore } from '../packages/database/src/index.js';

const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
if (!process.argv.includes('--run')) {console.log('dry-run: add --run for a bounded public article sample capture');process.exit(0);}
const config = loadMediaConfig(instance.configDirectory);
const port = createMediaConnector(config);
const db = new Database(instance.databasePath, { readonly: true });
const directory = path.join(instance.runtimeDirectory, 'media-audit', 'samples');
fs.mkdirSync(directory, { recursive: true });
const observations = fs.existsSync(path.join(directory,'observations.json')) ? JSON.parse(fs.readFileSync(path.join(directory,'observations.json'),'utf8')) : [];
const requestStore = createStore(instance.databasePath);
for (const key of ['dcd','nextplatform','decoder']) {
  const source = config.sources.find(s => s.sourceKey === key);
  const entries = db.prepare('SELECT external_id,canonical_url,title,summary FROM media_index_entries WHERE source_key=? ORDER BY published_at DESC').all(key)
    .filter(e => source.articleHosts.includes(new URL(e.canonical_url).hostname)).slice(0,5);
  if (key === 'nextplatform' && entries.length < 5) entries.push({ external_id: 'sample:nextplatform:quantum', canonical_url: 'https://www.nextplatform.com/compute/2026/09/23/improving-quantum-error-correction-by-meshing-surface-code-with-ibms-heavy-hex-architecture/5298457', title: '', summary: '' });
  for (const entry of entries) {
    if (observations.some(o=>o.url===entry.canonical_url)) continue;
    const response = await port.fetch({ url: entry.canonical_url, allowedHosts: source.articleHosts, redirectHosts: source.redirectHosts, kind: 'article' }, { maxAttempts: 1, timeoutMs: 12000,
      onRequest:()=>requestStore.repositories.media.reserveRequest('local',new Intl.DateTimeFormat('en-CA',{timeZone:config.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now()),key,Date.now(),config.budget.maxBodyRequestsPerDay,config.budget.maxSourceRequestsPerDay) });
    const hash = createHash('sha256').update(entry.canonical_url).digest('hex').slice(0,16);
    if (response.body) fs.writeFileSync(path.join(directory, `${key}-${hash}.html`), response.body);
    const observation = { sourceKey: key, externalId: entry.external_id, url: entry.canonical_url, observedAt: Date.now(), status: response.status, responseBytes: response.bytes, finalUrl: response.finalUrl, health: response.health, rawFile: response.body ? `${key}-${hash}.html` : null, title: entry.title, summary: entry.summary };
    observations.push(observation);
    fs.writeFileSync(path.join(directory, 'observations.json'), JSON.stringify(observations, null, 2));
    console.log(JSON.stringify({ sourceKey: key, status: response.status, bytes: response.bytes, file: observation.rawFile, health: response.health }));
  }
}
db.close();
requestStore.close();
