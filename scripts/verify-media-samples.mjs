// Offline replay of locally captured responses. Never fetches or writes the Instance database.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { loadMediaConfig } from '../packages/instance/src/media-config.js';
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';
import { createStore } from '../packages/database/src/index.js';

const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
const samples = path.join(instance.runtimeDirectory,'media-audit','samples');
const observations = JSON.parse(fs.readFileSync(path.join(samples,'observations.json'),'utf8'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'media-real-validation-'));
const store = createStore(path.join(directory,'validation.db'));
const config = loadMediaConfig(instance.configDirectory);
// Higher limits apply only to this disposable replay database; no network requests occur.
const port = createMediaConnector({ ...config, sources: config.sources.map(s => ({...s,detailDailyCap:20})),
  budget: {...config.budget,maxSelectedBodiesPerDay:100,maxBodyRequestsPerDay:100,maxSourceRequestsPerDay:50},
  lookupImpl: async () => [{address:'93.184.216.34'}],
  fetchImpl: async url => {
    const observation = observations.find(o => o.url === url);
    if (!observation) throw new Error('Uncaptured URL');
    return new Response(observation.rawFile ? fs.readFileSync(path.join(samples,observation.rawFile),'utf8') : '', {status:observation.status || 503});
  } });
const service = createMediaIngestionService({mediaRepository:store.repositories.media,feedRepository:store.repositories.feed,mediaPort:port});
const hash = value => createHash('sha256').update(value).digest('hex');
const rows = [];
try {
  for (const o of observations.filter(o => o.sourceKey !== 'bbc')) {
    const source = config.sources.find(s => s.sourceKey === o.sourceKey);
    const at = Date.now();
    store.repositories.media.saveState({workspaceId:'local',sourceKey:o.sourceKey,enabled:true,bodyUseAcknowledged:true,hostDirectVerified:true,health:'ready',updatedAt:at});
    store.repositories.media.upsertEntry({workspaceId:'local',externalId:o.externalId,sourceKey:o.sourceKey,publisherKey:source.publisher,channel:source.channel,
      canonicalUrl:o.url,title:o.title || 'Historical validation sample',summary:o.summary || '',publishedAt:o.publishedAt || null,publishedAtRaw:'',
      contentLevel:'summary_only',contentHash:hash(o.title || o.url),revision:1,status:'indexed',observedAt:at,createdAt:at,updatedAt:at});
    const result = await service.fetchBodies({externalIds:[o.externalId]});
    const entry = store.repositories.media.getEntries('local',[o.externalId])[0];
    const snapshot = store.repositories.media.latestBodies('local',[o.externalId])[0];
    const item = service.readFeed({channel:source.channel,limit:100}).items.find(i => i.externalId === o.externalId);
    const content = store.repositories.feed.listContentItems('local',{limit:100}).find(i => i.sourceUrl === o.url);
    if (snapshot) {
      assert.equal(hash(snapshot.bodyText),snapshot.bodyHash);
      assert.equal(content.body,snapshot.bodyText);
      assert.ok(item.body.endsWith(snapshot.bodyText));
      assert.deepEqual(item.paragraphs,snapshot.article.paragraphs);
      assert.equal(snapshot.bodyText,snapshot.article.paragraphs.map(p => p.text).join('\n\n'));
    }
    rows.push({sourceKey:o.sourceKey,externalId:o.externalId,url:o.url,httpStatus:o.status,responseBytes:o.responseBytes,
      contentLevel:item.contentLevel,reason:entry.fetchState.extractionReason,extractionMethod:entry.fetchState.extractionMethod,
      paragraphCount:item.paragraphs.length,bodyChars:snapshot?.bodyText.length || 0,bodyBytes:entry.fetchState.extractedBytes,
      bodyHash:snapshot?.bodyHash || null,firstParagraphHash:item.paragraphs[0] ? hash(item.paragraphs[0].text) : null,
      lastParagraphHash:item.paragraphs.length ? hash(item.paragraphs.at(-1).text) : null,
      firstText:item.paragraphs[0]?.text.slice(0,180) || '',lastText:item.paragraphs.at(-1)?.text.slice(-180) || '',
      tables:item.paragraphs.filter(p => p.kind === 'table').length,projectionConsistent:!!snapshot,stats:result.stats});
  }
  const output = {mode:'offline-real-response-replay',observedAt:new Date().toISOString(),networkRequests:0,
    historicalSamples:true,rows,sources:[...new Set(rows.map(r=>r.sourceKey))].map(sourceKey => {
      const group=rows.filter(r=>r.sourceKey===sourceKey); return {sourceKey,samples:group.length,full:group.filter(r=>r.contentLevel==='full').length,
        partial:group.filter(r=>r.contentLevel==='partial').length,failed:group.filter(r=>!r.projectionConsistent).length};
    })};
  const destination = path.join(instance.runtimeDirectory,'media-audit','real-validation.json');
  fs.writeFileSync(destination,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({mode:output.mode,networkRequests:0,sources:output.sources},null,2));
} finally {store.close();fs.rmSync(directory,{recursive:true,force:true});}
