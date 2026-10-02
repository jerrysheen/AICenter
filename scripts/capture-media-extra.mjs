import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { loadMediaConfig } from '../packages/instance/src/media-config.js';
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
import { createSourceModuleRegistry } from '../packages/source/src/module-registry.js';
import { createSourceHub } from '../packages/source/src/source-hub.js';
import { createStore } from '../packages/database/src/index.js';

const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
if (!process.argv.includes('--run')) {console.log('dry-run: add --run to capture at most three new samples per source');process.exit(0);}
const config = loadMediaConfig(instance.configDirectory);
const hub = createSourceHub(createSourceModuleRegistry());
const port = createMediaConnector({ ...config, readSource: (...args) => hub.read(...args) });
const directory = path.join(instance.runtimeDirectory,'media-audit','samples');
const observations = JSON.parse(fs.readFileSync(path.join(directory,'observations.json'),'utf8'));
const db = new Database(instance.databasePath,{ readonly: true });
const requestStore = createStore(instance.databasePath);
for (const key of ['dcd','decoder','fed']) {
  const source = config.sources.find(s => s.sourceKey === key);
  const candidates = (key === 'fed' ? (await port.readExisting(source)).items : db.prepare('SELECT external_id externalId,canonical_url sourceUrl,title,summary FROM media_index_entries WHERE source_key=? ORDER BY published_at DESC').all(key)).filter(e => !observations.some(o => o.url === e.sourceUrl)).slice(0,3);
  for (const entry of candidates) {
    const fetched = await port.fetch({ url: entry.sourceUrl, allowedHosts: source.articleHosts, redirectHosts: source.redirectHosts, kind: 'article' },{ timeoutMs: 12000,
      onRequest:()=>requestStore.repositories.media.reserveRequest('local',new Intl.DateTimeFormat('en-CA',{timeZone:config.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now()),key,Date.now(),config.budget.maxBodyRequestsPerDay,config.budget.maxSourceRequestsPerDay) });
    const hash = createHash('sha256').update(entry.sourceUrl).digest('hex').slice(0,16);
    const file = `${key}-${hash}.html`;
    if (fetched.body) fs.writeFileSync(path.join(directory,file),fetched.body);
    observations.push({ sourceKey: key, externalId: entry.externalId,url: entry.sourceUrl,title: entry.title,summary: entry.summary || '',publishedAt: entry.publishedAt || null,
      observedAt: Date.now(),status: fetched.status,responseBytes: fetched.bytes,finalUrl: fetched.finalUrl,health: fetched.health,rawFile: fetched.body ? file : null });
    console.log(JSON.stringify({ sourceKey: key,status: fetched.status,bytes: fetched.bytes,file }));
    fs.writeFileSync(path.join(directory,'observations.json'),JSON.stringify(observations,null,2));
  }
}
db.close();
requestStore.close();
