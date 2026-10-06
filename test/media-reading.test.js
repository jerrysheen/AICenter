import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import vm from 'node:vm';
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
import {extractArticleText} from '../packages/connectors/src/media/article-html.js';
import {createFeedRoutes} from '../apps/web/src/routes/feed-routes.js';
import {createRouter} from '../apps/web/src/http/router.js';

const now=Date.parse('2026-10-02T09:00:00Z');
function fixture(fetchImpl) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'media-reader-'));
  const store=createStore(path.join(dir,'test.db'));
  const port=createMediaConnector({...config,fetchImpl,lookupImpl:async()=>[{address:'93.184.216.34'}]});
  const service=createMediaIngestionService({mediaRepository:store.repositories.media,feedRepository:store.repositories.feed,taggingRepository:store.repositories.tagging,mediaPort:port,now:()=>now});
  return {store,port,service,databasePath:path.join(dir,'test.db'),close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
function seed(f,id='decoder:one',extra={}) {
  f.store.repositories.media.saveState({workspaceId:'local',sourceKey:id.split(':')[0],enabled:true,hostDirectVerified:true,bodyUseAcknowledged:true,health:'ready',updatedAt:now});
  f.store.repositories.media.upsertEntry({workspaceId:'local',externalId:id,sourceKey:id.split(':')[0],publisherKey:id.split(':')[0],channel:'tech',canonicalUrl:'https://the-decoder.com/one/',title:'API price',summary:'Source preview',publishedAt:now,publishedAtRaw:'',contentLevel:'summary_only',contentHash:'index',revision:1,status:'indexed',observedAt:now,createdAt:now,updatedAt:now,...extra});
}

test('saved article reads directly by stable ID outside listing pages without fetching or crossing workspaces',async()=>{
  let network=0;const f=fixture(async()=>{network++;throw Error('read must not fetch');});
  try {
    seed(f,'decoder:older');seed(f,'decoder:newest',{publishedAt:now+1000});
    assert.equal(f.service.readFeed({channel:'tech',limit:1}).items[0].externalId,'decoder:newest');
    const originalList=f.store.repositories.media.listEntries;
    f.store.repositories.media.listEntries=()=>{throw Error('direct read must not scan a listing');};
    const item=f.service.getSavedArticle({externalId:'decoder:older'},{workspaceId:'local'});
    assert.equal(item.externalId,'decoder:older');assert.equal(item.title,'API price');assert.equal(item.id,'media:decoder:older');
    assert.equal(f.service.getSavedArticle({externalId:'decoder:older'},{workspaceId:'other'}),null);
    assert.equal(f.service.getSavedArticle({externalId:'missing'}),null);
    assert.throws(()=>f.service.getSavedArticle({externalId:'decoder:older',command:'fetch'}));
    const response={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
    await createRouter(createFeedRoutes()).dispatch({request:{method:'GET'},response,services:{media:f.service},identity:{kind:'device',device:{workspaceId:'local'}},url:new URL('http://localhost/api/v1/feed/media/article?externalId=decoder%3Aolder')});
    assert.equal(response.status,200);assert.equal(response.body.item.externalId,'decoder:older');assert.equal(network,0);
    f.store.repositories.media.listEntries=originalList;
  }finally{f.close();}
});

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
    assert.deepEqual(f.service.getSavedArticle({externalId:'decoder:one'}).paragraphs,item.paragraphs);
    assert.equal(f.service.getSavedArticle({externalId:'decoder:one'}).body,item.body);
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

test('media read state uses the real ContentItem, survives reopening and sorts before pagination', async()=>{
  const f=fixture(async()=>new Response('<article><div class="content-wrapper"><p>'+ 'A synthetic policy report with complete evidence. '.repeat(10) +'</p><p>FINAL policy statement.</p></div></article>'));
  let reopened;
  try {
    seed(f,'decoder:older',{publishedAt:now-1000});seed(f,'decoder:newer');
    await f.service.fetchBodies({externalIds:['decoder:older','decoder:newer']});
    const newer=f.service.readFeed({channel:'tech',view:'full',limit:1}).items[0];
    assert.equal(newer.externalId,'decoder:newer');assert.ok(newer.contentItemId);assert.equal(newer.isRead,false);
    assert.notEqual(newer.resourceId,newer.contentItemId);
    const feed=createFeedService({legacyRepository:{},sourcePort:{},feedRepository:f.store.repositories.feed});
    feed.patchContentItemState({workspaceId:'local',contentItemId:newer.contentItemId,isRead:true});
    const first=f.service.readFeed({channel:'tech',view:'full',limit:1});
    assert.equal(first.items[0].externalId,'decoder:older');assert.equal(first.nextOffset,1);
    assert.equal(f.service.readFeed({channel:'tech',view:'full',offset:1,limit:1}).items[0].isRead,true);
    reopened=createStore(f.databasePath);
    const service=createMediaIngestionService({mediaRepository:reopened.repositories.media,feedRepository:reopened.repositories.feed,mediaPort:f.port});
    assert.equal(service.readFeed({channel:'tech',view:'full',offset:1,limit:1}).items[0].isRead,true);
    assert.equal(reopened.repositories.feed.listContentItemStatesByExternalIds('other','media',['decoder:newer']).length,0);
  }finally{reopened?.close();f.close();}
});

test('media UI marks the stored list item and writes the ContentItem state without changing tag identity',()=>{
  const js=readFileSync('apps/web/public/app.js','utf8');
  const names=['mediaAsItem','markFeedItemRead','sortFeedItems'];
  const calls=[];
  const row={id:'media-id',resourceId:'media-id',externalId:'fed:one',contentItemId:'content-id',contentLevel:'full',createdAt:123};
  const state={mediaItems:[row],xItems:[],bilibiliItems:[],trendforceItems:[],xueqiuItems:[],posts:[],focusItems:{},session:{role:'device',device:{id:'reader'}},channel:'social',feedSort:'created'};
  const cacheReads=[];
  const context=vm.createContext({state,mediaFeedCache:{markRead(scope,id){cacheReads.push({scope,id});}},formatTime:()=>'',rememberRecentItem:()=>{},api:(url,input)=>{calls.push({url,input});return Promise.resolve();}});
  for(const name of names)vm.runInContext(js.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0],context);
  context.row=row;
  vm.runInContext('const post=mediaAsItem(row);markFeedItemRead(post);markFeedItemRead(post);',context);
  assert.equal(row.isRead,true);assert.equal(calls.length,1);
  assert.deepEqual(cacheReads,[{scope:'device:reader',id:'media-id'}]);
  assert.equal(calls[0].url,'/api/v1/content-items/content-id/state');
  assert.deepEqual(JSON.parse(calls[0].input.body),{isRead:true});
  assert.equal(vm.runInContext('post.resourceId',context),'media-id');
  assert.equal(vm.runInContext('sortFeedItems([post,{id:"unread",createdAt:1}])[0].id',context),'unread');
});

test('official release lookback admits a week-old policy while RSS retains the 48-hour window',async()=>{
  const f=fixture(async()=>new Response(''));
  try {
    const old=now-7*86400_000;
    const sources=[config.sources.find(s=>s.sourceKey==='pboc'),{...config.sources.find(s=>s.sourceKey==='fed'),sourceKey:'short',backfillHours:48}];
    const port=createMediaConnector({...config,sources,readExisting:async entry=>({ok:true,health:'ready',items:[{externalId:entry.sourceKey+':old',sourceUrl:entry.probeUrl,title:'Policy change',summary:'',publishedAt:old,publishedAtRaw:''}]})});
    const service=createMediaIngestionService({mediaRepository:f.store.repositories.media,mediaPort:port,now:()=>now});
    for(const s of sources)service.enableSource('local',s.sourceKey);
    await service.syncEnabled({workspaceId:'local',channel:'macro',force:true});
    assert.deepEqual(service.readFeed({channel:'macro'}).items.map(i=>i.externalId),['pboc:old']);
    for(const hours of [0,2161,1.5])assert.equal(MediaConfigSchema.safeParse({...config,sources:[{...sources[0],backfillHours:hours}]}).success,false);
  }finally{f.close();}
});

test('body selection shares a small batch between sources even when tech has higher scores',()=>{
  const f=fixture(async()=>new Response(''));
  try {
    for(let i=0;i<10;i++)seed(f,`decoder:${i}`,{title:`AI inference API price ${i}`});
    seed(f,'pboc:policy',{channel:'macro',title:'货币政策委员会例会',canonicalUrl:'https://www.pbc.gov.cn/policy.html',publishedAt:now-86400_000});
    const selected=f.service.selectBodyCandidates('local',2);
    assert.equal(selected.length,2);assert.deepEqual(new Set(selected.map(r=>r.sourceKey)),new Set(['decoder','pboc']));
  }finally{f.close();}
});

test('official DOM bodies exclude metadata and duplicated mobile content',()=>{
  const prose='<p>'+ '本次政策公布了货币政策、利率和财政方面的明确安排。'.repeat(15) +'</p><p>政策正文最后一句。</p>';
  for(const [sourceKey,html] of [
    ['govcn',`<div class="policyLibraryOverview_content"><div>METADATA</div><div class="trs_editor_view">${prose}</div><div class="trs_editor_view">${prose}</div></div>`],
    ['govnews',`<div id="UCAP-CONTENT"><div class="trs_editor_view">${prose}</div></div>`],
    ['pboc',`<table><tr><td class="content"><div id="zoom">${prose}</div></td></tr></table>`],
    ['whitehouse',`<main><div class="entry-content wp-block-post-content">${prose}</div><aside>RELATED</aside></main>`],
  ]) {
    const result=extractArticleText(html,{sourceKey});
    assert.equal(result.contentLevel,'full',sourceKey);assert.equal(result.paragraphs.length,2);
    assert.equal(result.text.split('政策正文最后一句。').length,2);assert.doesNotMatch(result.text,/METADATA|RELATED/);
  }
});

test('an explicitly fetched older policy remains eligible for translation beyond the recent list limit',()=>{
  const f=fixture(async()=>new Response(''));
  try {
    seed(f,'pboc:old',{channel:'macro',publishedAt:now-7*86400_000});
    for(let i=0;i<125;i++)seed(f,`decoder:recent-${i}`);
    assert.equal(f.service.listEnrichmentItems('local').some(i=>i.externalId==='pboc:old'),false);
    assert.equal(f.service.listEnrichmentItems('local',120,['pboc:old'])[0].externalId,'pboc:old');
  }finally{f.close();}
});
