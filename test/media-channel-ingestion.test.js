import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createStore} from '../packages/database/src/index.js';
import {createMediaConnector} from '../packages/connectors/src/media/port.js';
import {createMediaIngestionService,MEDIA_INGESTION_POLICY} from '../packages/domain/src/media-ingestion-service.js';
import {createMediaJobHandlers,ensureMediaIndexSyncSchedule} from '../packages/connectors/src/media/index.js';
import {createMediaEnrichJobHandlers} from '../packages/runtime/src/media-enrich-module.js';
import {createScheduler} from '../packages/runtime/src/scheduler.js';
import {createJobRunner} from '../packages/runtime/src/job-runner.js';
import {createFeedService} from '../packages/domain/src/feed-service.js';
import {MediaConfigSchema} from '../packages/contracts/src/media.js';
import {ContentFeedViewSchema} from '../packages/source/src/schemas.js';
import {YAHOO_LIST_READER} from '../packages/connectors/src/media/yahoo-public.js';
import config from '../config/media.json' with {type:'json'};

const NOW=Date.parse('2026-10-04T02:00:00Z');
const article='<article><div itemprop="articleBody"><p>'+'A synthetic complete report describes a business with no topic keyword requirements. '.repeat(5)+'</p><p>A final paragraph records the source evidence.</p></div></article>';
const feed=items=>'<rss><channel>'+items.map((item,i)=>`<item><title>${item.title}</title><guid>${item.id || i}</guid><link>${item.url}</link>${item.date?`<pubDate>${item.date}</pubDate>`:''}</item>`).join('')+'</channel></rss>';
function fixture(sources,fetchImpl,budget={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-channels-'));
 const store=createStore(path.join(dir,'test.db'));
 let at=NOW;
 const port=createMediaConnector({sources,fetchImpl,lookupImpl:async()=>[{address:'93.184.216.34'}],focusKeywords:['AI','price'],budget});
 const service=createMediaIngestionService({mediaRepository:store.repositories.media,feedRepository:store.repositories.feed,mediaPort:port,now:()=>at});
 const enable=(key,extra={})=>store.repositories.media.saveState({workspaceId:'local',sourceKey:key,enabled:true,hostDirectVerified:true,bodyUseAcknowledged:true,health:'ready',updatedAt:at,...extra});
 return {store,port,service,enable,setAt:value=>{at=value;},close(){store.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
const bbc=config.sources.find(s=>s.sourceKey==='bbc');
const world=config.sources.find(s=>s.sourceKey==='bbcworld');
const yahoo=config.sources.find(s=>s.sourceKey==='yahooeconomy');

test('unlimited ingestion keeps counters and resumes old budget cooldowns immediately',async()=>{
 let bodyReads=0;
 const f=fixture([bbc],async url=>String(url).includes('/rss.xml')?new Response(feed(Array.from({length:9},(_,i)=>({title:'Report '+i,url:'https://www.bbc.com/news/articles/unlimited'+i})))):(bodyReads++,new Response(article)));
 try {
  f.enable('bbc');const repo=f.store.repositories.media;
  repo.reserveMetadata('local','2026-10-04',300,NOW,null);
  for(let i=0;i<96;i++) assert.equal(repo.reserveRequest('local','2026-10-04','bbc',NOW,null,null),true);
  for(let i=0;i<56;i++) assert.equal(repo.reserveBody('local','2026-10-04','bbc',NOW,{globalMax:null,sourceMax:null}).reserved,true);
  const sync=await f.service.syncEnabled({force:true});assert.equal(sync.results[0].added,9);assert.equal(sync.results[0].deferred,0);
  const rows=repo.listEntries('local');
  for(const [i,row] of rows.entries()) repo.saveFetchState('local',row.externalId,{httpStatus:null,attemptCount:0,lastAttemptAt:null,responseBytes:0,extractedBytes:0,paragraphCount:0,extractionMethod:'',extractorVersion:f.port.extractorVersion,fetchedRevision:row.revision,etag:'',lastModified:'',finalUrl:'',author:'',publishedAtRaw:'',updatedAtRaw:'',selectedReason:'',visualEvidenceRequired:false,...row.fetchState,fetchStatus:'deferred',extractionReason:i%2?'request_budget':'success_budget',nextRetryAt:NOW+3600000});
  const selected=f.service.selectBodyCandidates('local');assert.equal(selected.length,9);
  const fetched=await f.service.fetchBodies({externalIds:selected.map(r=>r.externalId)});
  assert.equal(bodyReads,9);assert.equal(fetched.stats.validFull,9);assert.equal(fetched.stats.deferred,0);
  assert.equal(repo.budgetDay('local','2026-10-04').bodyRequests,105);
  assert.equal(repo.budgetDay('local','2026-10-04').selectedBodies,65);
  assert.equal(repo.budgetDay('local','2026-10-04').newMetadata,309);
 }finally{f.close();}
});

test('automatic enrichment processes candidates beyond the first forty',async()=>{
 const ids=Array.from({length:43},(_,i)=>'entry:'+i);const batches=[];
 const handlers=createMediaEnrichJobHandlers({mediaService:{selectBodyCandidates:()=>ids.map(externalId=>({externalId})),listBodyCandidates:()=>ids,listEnrichmentItems:()=>[],
  fetchBodies:async({externalIds})=>{batches.push(externalIds);return {fetched:externalIds.map(externalId=>({externalId,health:'ready',contentLevel:'full'})),stats:{validFull:externalIds.length}};}},feedService:{localizeTexts:async()=>({pendingIds:[]})}});
 const result=await handlers['media.index.enrich']({});
 assert.deepEqual(batches.map(batch=>batch.length),[40,3]);assert.deepEqual(batches.flat(),ids);assert.equal(result.bodiesFetched,43);assert.equal(result.bodyStats.validFull,43);
});

test('policy upgrade bypasses old ETag once, restores unfiltered entries, preserves list order and resumes 304 caching',async()=>{
 const calls=[];
 const items=[{title:'Film industry opens a new studio',url:'https://www.bbc.com/news/articles/studio'},
  {title:'Identical headline',url:'https://www.bbc.com/news/articles/one'},
  {title:'Identical headline',url:'https://www.bbc.com/news/articles/two',date:new Date(NOW-3600000).toUTCString()},
  {title:'Old item',url:'https://www.bbc.com/news/articles/old',date:new Date(NOW-72*3600000).toUTCString()}];
 const source={...bbc,includeKeywords:['inflation'],excludeKeywords:['Film']};
 const f=fixture([source],async(_url,options)=>{
  calls.push(options.headers);
  return options.headers['If-None-Match']?new Response(null,{status:304,headers:{etag:'"old"'}}):new Response(feed(items),{headers:{etag:'"old"'}});
 });
 try {
  f.enable(source.sourceKey,{etag:'"old"',feedHash:'old-filtered-hash',lastSyncAt:NOW});
  const first=await f.service.syncEnabled({channel:'macro'});
  assert.equal(calls[0]['If-None-Match'],undefined);
  assert.equal(first.results[0].policyReparsed,true);
  assert.deepEqual(first.results[0].comparisons.map(r=>r.indexed),[true,true,true,false]);
  assert.equal(f.store.repositories.media.getState('local','bbc').ingestionPolicy,MEDIA_INGESTION_POLICY);
  assert.deepEqual(f.service.selectBodyCandidates('local').map(r=>r.title),items.slice(0,3).map(r=>r.title));
  assert.equal(f.service.readFeed({channel:'macro'}).items.find(r=>r.title.includes('Film')).publishedAt,null);
  assert.equal(ContentFeedViewSchema.safeParse(f.service.readFeed({channel:'macro'})).success,true);
  await f.service.syncEnabled({channel:'macro'});assert.equal(calls.length,1);
  f.setAt(NOW+3*3600000);
  const second=await f.service.syncEnabled({channel:'macro'});assert.equal(second.results[0].health,'not_modified');
  assert.equal(calls[1]['If-None-Match'],'"old"');assert.equal(f.service.readFeed({channel:'macro'}).total,3);
 }finally{f.close();}
});

test('scheduled worker reuses a cross-channel body and translations, tolerates absent tagging, and preserves read and hidden state',async()=>{
 let bodyReads=0,translated=0;
 const shared='https://www.bbc.com/news/articles/shared';
 const f=fixture([bbc,world],async url=>String(url).includes('/rss.xml')?new Response(feed([{title:'A studio opens',url:shared}])):(bodyReads++,new Response(article)));
 try {
  f.enable('bbc');f.enable('bbcworld');
  const feedService=createFeedService({legacyRepository:{},sourcePort:{},feedRepository:f.store.repositories.feed,translationPort:{translateMany:async({items})=>{
   translated+=items.length;return {translations:items.map(i=>({id:i.id,translatedText:'测试译文：'+i.text,engine:'test'}))};
  }}});
  const handlers={...createMediaJobHandlers(f.service),...createMediaEnrichJobHandlers({mediaService:f.service,feedService})};
  ensureMediaIndexSyncSchedule(f.store,NOW);
  const scheduler=createScheduler({store:f.store,allowedJobTypes:Object.keys(handlers),now:()=>NOW});
  const runner=createJobRunner({store:f.store,handlers,workerId:'channel-test'});
  assert.equal((await scheduler.tick(NOW)).length,1);
  await runner.runOnce();await runner.runOnce();
  assert.equal(bodyReads,1);assert.ok(translated>0);
  const all=f.service.readFeed({channel:'macro'});assert.equal(all.total,1);assert.equal(all.items[0].articleTranslation.status,'ready');
  assert.deepEqual(new Set(all.items[0].discoveryChannels.map(d=>d.sourceKey)),new Set(['bbc','bbcworld']));
  const item=all.items[0];const translationCount=translated;
  f.store.repositories.feed.upsertUserItemState({workspaceId:'local',contentItemId:item.contentItemId,isRead:true});
  f.setAt(NOW+2*86400000);
  f.store.createJob({type:'media.sources.sync',input:{channel:'macro',force:true}});
  await runner.runOnce();await runner.runOnce();
  assert.equal(bodyReads,1);assert.equal(translated,translationCount);
  assert.equal(f.service.readFeed({channel:'macro'}).items[0].isRead,true);
  assert.deepEqual(f.service.selectBodyCandidates('local'),[]);
  f.store.repositories.feed.upsertUserItemState({workspaceId:'local',contentItemId:item.contentItemId,isHidden:true,isRead:true});
  await f.service.syncEnabled({force:true,channel:'macro'});
  assert.equal(f.service.readFeed({channel:'macro'}).total,0);assert.equal(f.service.selectBodyCandidates('local').length,0);
 }finally{f.close();}
});

test('metadata and body budgets leave ordered pending work with explicit reasons',async()=>{
 const f=fixture([bbc],async url=>String(url).includes('/rss.xml')?new Response(feed([0,1,2].map(i=>({title:'Studio '+i,url:'https://www.bbc.com/news/articles/studio'+i})))):new Response(article),{maxNewMetadataPerDay:2,maxSelectedBodiesPerDay:1});
 try {
  f.enable('bbc');const sync=await f.service.syncEnabled({force:true});assert.equal(sync.results[0].deferred,1);
  const queue=f.service.selectBodyCandidates('local');assert.equal(queue.length,2);
  const body=await f.service.fetchBodies({externalIds:queue.map(r=>r.externalId)});
  assert.equal(body.stats.validFull,1);assert.equal(body.stats.deferred,1);
  assert.equal(f.store.repositories.media.getEntries('local',[queue[1].externalId])[0].fetchState.extractionReason,'success_budget');
  f.setAt(NOW+86400000);
  await f.service.syncEnabled({force:true});
  const next=f.service.selectBodyCandidates('local');assert.equal(next.length,2);assert.match(next[0].title,/Studio 1/);
 }finally{f.close();}
});

test('Yahoo aliases keep historical IDs and reading state while opening one list and preserving all publisher names',async()=>{
 const cards=[{title:'Legacy report',url:'https://finance.yahoo.com/economy/articles/legacy.html',publisherName:'Reuters'},
  {title:'Cinema business',url:'https://finance.yahoo.com/economy/articles/cinema.html',publisherName:'USA TODAY'},
  {title:'Unknown reporter',url:'https://finance.yahoo.com/economy/articles/unknown.html'}];
 let lists=0,active;
 const browserRuntime={withSession:async(_o,callback)=>callback({navigate:async url=>{active=url;if(url===yahoo.probeUrl)lists++;},evaluate:async script=>{
  if(script.includes('section.story-item'))return cards;
  return {url:active,challenge:false};
 }})};
 const f=fixture([yahoo],async()=>{throw new Error('Unexpected HTTP');});
 const port=createMediaConnector({sources:[yahoo],browserRuntime});
 const service=createMediaIngestionService({mediaRepository:f.store.repositories.media,feedRepository:f.store.repositories.feed,mediaPort:port,now:()=>NOW});
 try {
  f.enable('reuterswire');f.enable('bloombergwire');
  f.store.repositories.media.upsertEntry({workspaceId:'local',externalId:'reuterswire:old',sourceKey:'reuterswire',publisherKey:'reuters',channel:'macro',canonicalUrl:cards[0].url,title:cards[0].title,summary:'',publishedAt:null,contentLevel:'summary_only',contentHash:'old',revision:1,status:'indexed',observedAt:NOW-1000,createdAt:NOW-1000,updatedAt:NOW-1000});
  await service.syncEnabled({channel:'macro'});assert.equal(lists,1);
  const entries=f.store.repositories.media.listEntries('local');assert.equal(entries.length,3);
  assert.equal(entries.find(r=>r.canonicalUrl===cards[0].url).externalId,'reuterswire:old');
  assert.equal(entries.find(r=>r.title==='Cinema business').publisherName,'USA TODAY');
  assert.equal(entries.find(r=>r.title==='Unknown reporter').publisherKey,'unknown');
  assert.deepEqual(service.catalogView('local').map(s=>s.sourceKey),['yahooeconomy']);
  const unsupported=entries.filter(r=>r.publisherKey!=='reuters').map(r=>r.externalId);
  const bodies=await service.fetchBodies({externalIds:unsupported});assert.equal(bodies.stats.requests,0);assert.equal(bodies.stats.policySkipped,2);
  const repository=f.store.repositories.media;
  for(let i=0;i<4;i++)assert.equal(repository.reserveBody('local','2026-10-04','reuterswire',NOW,{globalMax:56,sourceMax:4}).reserved,true);
  assert.equal(repository.reserveBody('local','2026-10-04','yahooeconomy',NOW,{globalMax:56,sourceMax:4,sourceAliases:yahoo.sourceAliases}).reserved,false);
 }finally{f.close();}
});

test('Yahoo DOM reader restricts discovery to the channel stream and skips sponsored cards',()=>{
 const card=(title,url,publisherName,sponsored=false)=>({
  getClientRects:()=>[{}],closest:()=>sponsored?{}:null,querySelector:selector=>selector.includes('title-row')?{href:url,innerText:title}:selector==='.publisher'?{innerText:publisherName}:null,
 });
 const inside=card('A film studio opens','https://finance.yahoo.com/economy/articles/film.html','USA TODAY');
 const ad=card('Sponsored product','https://finance.yahoo.com/news/product.html','Ad',true);
 const outside=card('Outside recommendation','https://finance.yahoo.com/news/other.html','Reuters');
 const selectors=[];
 const context=vm.createContext({getComputedStyle:()=>({display:'block',visibility:'visible'}),document:{querySelectorAll:selector=>{
  selectors.push(selector);return selector==='main .stream section.story-item'?[inside,ad]:[inside,ad,outside];
 }}});
 const result=vm.runInContext(YAHOO_LIST_READER,context);
 assert.equal(result.length,1);assert.equal(result[0].publisherName,'USA TODAY');
 assert.equal(selectors[0],'main .stream section.story-item');
});

test('channel aliases are unambiguous and source order does not merge identical headlines',()=>{
 assert.equal(MediaConfigSchema.safeParse({...config,sources:[yahoo,{...bbc,sourceKey:'reuterswire'}]}).success,false);
 assert.equal(MediaConfigSchema.safeParse({...config,sources:[{...yahoo,sourceAliases:['reuterswire','reuterswire']}]}).success,false);
});

test('legacy entries for the same URL cannot consume two normal body requests',async()=>{
 let requests=0;
 const f=fixture([bbc,world],async()=>{requests++;return new Response(article);});
 try {
  f.enable('bbc');f.enable('bbcworld');
  const row={workspaceId:'local',publisherKey:'bbc',channel:'macro',canonicalUrl:'https://www.bbc.com/news/articles/shared-legacy',title:'A studio opens',summary:'',publishedAt:NOW,contentLevel:'summary_only',contentHash:'legacy',revision:1,status:'indexed',observedAt:NOW,createdAt:NOW,updatedAt:NOW};
  f.store.repositories.media.upsertEntry({...row,sourceKey:'bbc',externalId:'bbc:legacy'});
  f.store.repositories.media.upsertEntry({...row,sourceKey:'bbcworld',externalId:'bbcworld:legacy'});
  const selected=f.service.selectBodyCandidates('local');assert.equal(selected.length,1);
  await f.service.fetchBodies({externalIds:selected.map(r=>r.externalId)});assert.equal(requests,1);
  assert.equal(f.service.selectBodyCandidates('local').length,0);
  assert.equal(f.store.repositories.media.getEntries('local',['bbc:legacy','bbcworld:legacy']).length,2);
 }finally{f.close();}
});
