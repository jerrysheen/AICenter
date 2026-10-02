import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../packages/database/src/index.js';
import {createFeedService} from '../packages/domain/src/feed-service.js';
import {createMediaIngestionService} from '../packages/domain/src/media-ingestion-service.js';
import {createMediaConnector} from '../packages/connectors/src/media/port.js';
import {createMediaEnrichJobHandlers} from '../packages/runtime/src/media-enrich-module.js';
import {createTaggingService} from '../packages/domain/src/tagging-service.js';
import {mediaTranslationUnits,projectMediaTranslation} from '../packages/domain/src/media-translation.js';
import {createMediaJobHandlers,ensureMediaIndexSyncSchedule} from '../packages/connectors/src/media/index.js';
import {createScheduler} from '../packages/runtime/src/scheduler.js';
import {MediaArticleTranslationSchema,MediaConfigSchema} from '../packages/contracts/src/media.js';
import config from '../config/media.json' with {type:'json'};

const now=Date.parse('2026-10-02T09:00:00Z');
function fixture(fetchImpl) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'media-reader-'));
  const store=createStore(path.join(dir,'test.db'));
  const port=createMediaConnector({...config,fetchImpl,lookupImpl:async()=>[{address:'93.184.216.34'}]});
  const service=createMediaIngestionService({mediaRepository:store.repositories.media,feedRepository:store.repositories.feed,taggingRepository:store.repositories.tagging,mediaPort:port,now:()=>now});
  return {store,port,service,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
function seed(f,id='decoder:one',extra={}) {
  f.store.repositories.media.saveState({workspaceId:'local',sourceKey:id.split(':')[0],enabled:true,hostDirectVerified:true,bodyUseAcknowledged:true,health:'ready',updatedAt:now});
  f.store.repositories.media.upsertEntry({workspaceId:'local',externalId:id,sourceKey:id.split(':')[0],publisherKey:id.split(':')[0],channel:'tech',canonicalUrl:'https://the-decoder.com/one/',title:'API price',summary:'Source preview',publishedAt:now,publishedAtRaw:'',contentLevel:'summary_only',contentHash:'index',revision:1,status:'indexed',observedAt:now,createdAt:now,updatedAt:now,...extra});
}

test('full translation reaches the end beyond 5000 chars, keeps structure, caches and invalidates a revised article',async()=>{
  let price=2;
  const source='A synthetic report describes artificial intelligence and inference API capacity. '.repeat(140);
  const f=fixture(async()=>new Response(`<article><div class="content-wrapper"><h2>Pricing</h2><p>${source}</p><ul><li>Input price is ${price} dollars.</li><li>Output price is 10 dollars.</li></ul><table><tr><th>Period</th><th>USD</th></tr><tr><td>October</td><td>${price}</td></tr></table><p>FINAL_SENTENCE price is ${price} dollars per million tokens.</p></div></article>`));
  const sent=[];let tagCalls=0;
  const feed=createFeedService({legacyRepository:{},sourcePort:{},feedRepository:f.store.repositories.feed,translationPort:{translateMany:async({items})=>{sent.push(...items);return {translations:items.map(i=>({id:i.id,translatedText:'中文全文：'+i.text,engine:'test'}))};}}});
  const tags=createTaggingService({catalog:{version:'test',tags:[{id:'ai_compute',name:'算力',keywords:[]},{id:'semiconductor',name:'芯片',keywords:[]}]},taggingRepository:f.store.repositories.tagging,now:()=>now+1000,taggingPort:{tagBatch:async input=>{tagCalls++;assert.equal(input.selection,'multi');const payload=input.userPayload;return {reply_text:JSON.stringify(payload.items.map(i=>({item_id:i.item_id,tags:['ai_compute','semiconductor']})))};}}});
  try {
    seed(f);
    const handler=createMediaEnrichJobHandlers({mediaService:f.service,feedService:feed,taggingService:tags})['media.index.enrich'];
    await handler({externalIds:['decoder:one']});
    const item=f.service.readFeed({channel:'tech'}).items[0];
    assert.equal(item.articleTranslation.status,'ready');
    assert.deepEqual(item.articleTranslation.paragraphs.map(p=>[p.id,p.kind]),item.paragraphs.map(p=>[p.id,p.kind]));
    assert.match(item.articleTranslation.paragraphs.at(-1).text,/FINAL_SENTENCE price is 2/);
    assert.ok(sent.every(i=>i.text.length<=2400));
    assert.ok(sent.map(i=>i.text).join('').includes('FINAL_SENTENCE'));
    assert.equal(sent.filter(i=>i.text.includes('synthetic')).map(i=>i.text.replace(/^中文全文：/,'' )).join(' ').replace(/\s+/g,' ').trim(),source.trim());
    assert.deepEqual(item.tags,['ai_compute','semiconductor']);
    assert.equal(item.publisherName,'The Decoder');
    const count=sent.length;await handler({externalIds:['decoder:one']});assert.equal(sent.length,count);assert.equal(tagCalls,1);
    price=3;const row=f.store.repositories.media.getEntries('local',['decoder:one'])[0];f.store.repositories.media.upsertEntry({...row,revision:2});
    await f.service.fetchBodies({externalIds:['decoder:one']});
    const changed=f.service.readFeed({channel:'tech'}).items[0];assert.notEqual(changed.bodyHash,item.bodyHash);assert.notEqual(changed.articleTranslation.status,'ready');
    await handler({externalIds:['decoder:one']});assert.match(f.service.readFeed({channel:'tech'}).items[0].articleTranslation.paragraphs.at(-1).text,/price is 3/);
  }finally{f.close();}
});

test('missing translation chunks stay partial and old short translation never counts as a full article',()=>{
  const article={externalId:'decoder:a',bodyHash:'a'.repeat(64),snapshotRevision:1,title:'English title',paragraphs:[{id:'p0001',kind:'paragraph',text:'First English paragraph.'},{id:'p0002',kind:'paragraph',text:'Last English paragraph.'}]};
  const units=mediaTranslationUnits(article);
  assert.equal(projectMediaTranslation(article,[{itemId:'media:decoder:a',sourceHash:'wrong',translatedText:'旧摘要'}]).status,'pending');
  const rows=units.slice(0,2).map(u=>({itemId:u.id,sourceHash:'' ,translatedText:'测试',updatedAt:now}));
  assert.equal(projectMediaTranslation(article,rows).completedChunks,0);
  rows[0].sourceHash=createHash('sha256').update(units[0].text).digest('hex');
  const partial=projectMediaTranslation(article,rows);
  assert.equal(partial.status,'partial');assert.equal(partial.completedChunks,1);
  assert.deepEqual(partial.paragraphs,[]);
  assert.equal(MediaArticleTranslationSchema.safeParse({status:'ready',bodyHash:article.bodyHash,snapshotRevision:1,title:'',paragraphs:[],completedChunks:1,totalChunks:3,updatedAt:null}).success,false);
  assert.equal(MediaArticleTranslationSchema.safeParse({status:'ready',bodyHash:article.bodyHash,snapshotRevision:1,title:'',paragraphs:[],completedChunks:0,totalChunks:0,updatedAt:null}).success,false);
});

test('Techmeme resolves only registered original hosts and paths, deduplicates and respects a disabled publisher',async()=>{
  const f=fixture(async()=>new Response('<article><div class="entry-content"><p>'+('Public original article. '.repeat(20))+'</p><p>Final paragraph in original report.</p></div></article>'));
  try {
    seed(f,'techmeme:a',{contentLevel:'discovery',canonicalUrl:'https://www.techmeme.com/a',originUrl:'https://blog.cryptographyengineering.com/2026/09/30/example/'});
    seed(f,'techmeme:b',{contentLevel:'discovery',canonicalUrl:'https://www.techmeme.com/b',originUrl:'https://blog.cryptographyengineering.com/2026/09/30/example/'});
    assert.equal(f.service.discoverOriginals().added,1);assert.equal(f.service.discoverOriginals().added,0);
    const original=f.store.repositories.media.listEntries('local').find(r=>r.sourceKey==='cryptography');
    assert.equal(original.summary,'');assert.equal(original.discoveredVia.sourceKey,'techmeme');
    const result=await f.service.fetchBodies({externalIds:[original.externalId]});assert.equal(result.stats.validFull,1);
    const total=f.store.repositories.media.budgetDay('local','2026-10-02');assert.equal(total.bodyRequests,1);
    for(const url of ['http://blog.cryptographyengineering.com/2026/post','https://blog.cryptographyengineering.com.evil.test/2026/post','https://127.0.0.1/2026/post','https://blog.cryptographyengineering.com/private/post']) assert.equal(f.port.matchOriginal({originUrl:url}),null);
    f.service.disableSource('local','cryptography');seed(f,'techmeme:c',{contentLevel:'discovery',originUrl:'https://blog.cryptographyengineering.com/2026/new/'});
    assert.equal(f.service.discoverOriginals().added,0);
  }finally{f.close();}
});

test('scheduled media sync enqueues registered enrichment and advances to the next hour',async()=>{
  const f=fixture(async()=>new Response(''));
  try {
    const schedule=ensureMediaIndexSyncSchedule(f.store,now);
    const scheduler=createScheduler({store:f.store,allowedJobTypes:['media.sources.sync'],now:()=>now});
    assert.equal((await scheduler.tick(now)).length,1);assert.equal((await scheduler.tick(now)).length,0);
    assert.equal(f.store.getJobSchedule('local',schedule.key).nextRunAt,now+60*60_000);
    const handler=createMediaJobHandlers({syncEnabled:async()=>({results:[{sourceKey:'fed',health:'ready',added:1}],feed:{items:[{id:'fresh'}]}})})['media.sources.sync'];
    await handler({}, {store:f.store});await handler({}, {store:f.store});
    assert.equal(f.store.listJobs(20).filter(j=>j.type==='media.index.enrich').length,1);
  }finally{f.close();}
});

test('original discovery config requires explicit hosts and absolute path prefixes',()=>{
  assert.equal(MediaConfigSchema.safeParse({version:1,sources:[],discoveryPublishers:[{sourceKey:'bad',publisher:'Bad',articleHosts:[],pathPrefixes:['/'],detailDailyCap:1}]}).success,false);
  assert.equal(MediaConfigSchema.safeParse({version:1,sources:[],discoveryPublishers:[{sourceKey:'bad',publisher:'Bad',articleHosts:['example.com'],pathPrefixes:['news/'],detailDailyCap:1}]}).success,false);
  assert.equal(MediaConfigSchema.safeParse({...config,discoveryPublishers:[...config.discoveryPublishers,{...config.discoveryPublishers[0]}]}).success,false);
  assert.equal(MediaConfigSchema.safeParse({...config,discoveryPublishers:[{...config.discoveryPublishers[0],sourceKey:config.sources[0].sourceKey}]}).success,false);
});
