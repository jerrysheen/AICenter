import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { loadMediaConfig } from '../packages/instance/src/media-config.js';
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
import { normalizeMediaUrl } from '../packages/domain/src/media-url.js';

// Read-only network sampling. Production SQLite is opened readonly; no jobs,
// enabled states, model calls, BrowserRuntime or external notifications are created.
const instance = resolveInstanceConfig();
const config = loadMediaConfig(instance.configDirectory);
const keys = process.argv.filter(arg => arg.startsWith('--source=')).map(arg => arg.slice(9));
const selected = keys.length ? keys : ['bbctech','bbcscience','guardianai','guardianenergy','guardianmanufacturing','guardiantrade','eia','utilitydive','thelec'];
if (selected.some(key => !config.sources.some(source => source.sourceKey === key))) throw new Error('Unknown source');
const baselines = ['bbc','bbcworld','guardian','guardianworld'];
const port = createMediaConnector(config);
const directory = path.join(instance.runtimeDirectory,'media-audit','expansion');
fs.mkdirSync(directory,{recursive:true});
const endAt = Date.now();
const startAt = endAt - 24 * 3600_000;
const weekStartAt = endAt - 7 * 86400_000;
const hash = text => createHash('sha256').update(text).digest('hex');
const production = new Database(instance.databasePath,{readonly:true});
const existing = new Set(production.prepare('SELECT canonical_url FROM media_index_entries WHERE workspace_id=?').all('local').map(row => normalizeMediaUrl(row.canonical_url)));
const statesBefore = production.prepare('SELECT * FROM media_source_states ORDER BY source_key').all();
production.close();
const report = { observedAt:new Date(endAt).toISOString(), mode:'readonly', window:{startAt,endAt}, lowFrequencyWindow:{startAt:weekStartAt,endAt}, requests:0, results:[] };
const baselineUrls = new Set(), newUrls = new Set();
for (const key of [...baselines,...selected]) {
  const source = config.sources.find(row => row.sourceKey === key);
  let requests = 0;
  const onRequest = () => { requests++; report.requests++; return true; };
  const fetched = await port.fetch({url:source.probeUrl,allowedHosts:source.allowedHosts,redirectHosts:source.redirectHosts},{maxBytes:config.budget.maxFeedBytes,maxAttempts:1,onRequest});
  const parsed = fetched.ok ? port.parseFeed(fetched.body,source) : null;
  if (fetched.body) fs.writeFileSync(path.join(directory,key+'.xml'),fetched.body);
  const items = parsed?.items || [];
  const within = (item,cutoff) => item.publishedAt != null && item.publishedAt >= cutoff && item.publishedAt < endAt;
  const row = {sourceKey:key,url:source.probeUrl,finalUrl:fetched.finalUrl,status:fetched.status,health:parsed?.health || fetched.health,note:fetched.note,
    format:parsed?.format,rawCandidates:items.length,uniqueUrls:new Set(items.map(item=>item.sourceUrl)).size,
    within24h:items.filter(item=>within(item,startAt)).length,within7d:items.filter(item=>within(item,weekStartAt)).length,
    unknownDates:items.filter(item=>item.publishedAt==null).length,overlapBaseline24h:0,newToBaseline24h:0,newToProduction24h:0,samples:[],
    coverage:'current_feed_only',stopReason:'feed_end; historical pagination not attempted'};
  const urls = items.filter(item=>within(item,startAt)).map(item=>normalizeMediaUrl(item.sourceUrl,source.trackingParams));
  if (baselines.includes(key)) urls.forEach(url=>baselineUrls.add(url));
  else {
    row.overlapBaseline24h=urls.filter(url=>baselineUrls.has(url)).length;
    row.newToBaseline24h=urls.filter(url=>!baselineUrls.has(url)).length;
    row.newToProduction24h=urls.filter(url=>!existing.has(url)).length;
    urls.filter(url=>!baselineUrls.has(url)).forEach(url=>newUrls.add(url));
    const special = item => /\/(?:live|video)\/|\/av\/|^(?:Watch|Listen|Video):/i.test(item.sourceUrl+' '+item.title) || /^(?:Watch|Listen|Video):/i.test(item.title);
    const ordinary = items.filter(item=>!special(item)).slice(0,2);
    const extra = items.find(special);
    for (const item of [...ordinary,...(extra?[extra]:[])]) {
      const response = await port.fetch({url:item.sourceUrl,allowedHosts:source.articleHosts,redirectHosts:source.redirectHosts,kind:'article'},{maxBytes:config.budget.maxFeedBytes,maxAttempts:1,onRequest});
      if(response.body)fs.writeFileSync(path.join(directory,key+'-'+row.samples.length+'.html'),response.body);
      const article = response.ok ? port.extract(response.body,{sourceKey:key,status:response.status,title:item.title,summary:item.summary,maxBytes:config.budget.maxBodyBytes}) : null;
      row.samples.push({url:item.sourceUrl,title:item.title,special:special(item),sampleWindow:within(item,startAt)?'24h':within(item,weekStartAt)?'7d':'latest_outside_window',
        status:response.status,finalUrl:response.finalUrl,quality:article?.contentLevel || 'unavailable',reason:article?.reason || response.health,
        paragraphs:article?.paragraphs?.length || 0,characters:article?.text?.length || 0,method:article?.extractionMethod || '',canonical:article?.canonical || '',
        author:article?.author || '',publishedAtRaw:article?.publishedAtRaw || '',bodyHash:hash(article?.text || ''),
        firstHash:hash(article?.paragraphs?.[0]?.text || ''),lastHash:hash(article?.paragraphs?.at(-1)?.text || '')});
    }
  }
  row.requests=requests;report.results.push(row);
  console.log(JSON.stringify({sourceKey:key,health:row.health,items:row.rawCandidates,within24h:row.within24h,newToBaseline24h:row.newToBaseline24h,samples:row.samples.map(s=>({quality:s.quality,reason:s.reason,paragraphs:s.paragraphs,status:s.status}))}));
}
report.distinctNewUrls24h=newUrls.size;
const after = new Database(instance.databasePath,{readonly:true});
const afterStates=after.prepare('SELECT * FROM media_source_states ORDER BY source_key').all();after.close();
report.productionSourceStatesUnchanged=JSON.stringify(statesBefore)===JSON.stringify(afterStates);
// A running Worker may legitimately update these rows during the sample window.
// This comparison is observational; the script never holds a writable handle.
fs.writeFileSync(path.join(directory,'acceptance.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({complete:true,requests:report.requests,distinctNewUrls24h:report.distinctNewUrls24h,sourceStatesUnchanged:report.productionSourceStatesUnchanged,report:path.relative(instance.repositoryRoot,path.join(directory,'acceptance.json'))}));
