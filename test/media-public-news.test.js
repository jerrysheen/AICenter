import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {yahooListItems,yahooVisibleArticle,readYahooArticle} from '../packages/connectors/src/media/yahoo-public.js';
import {createMediaConnector} from '../packages/connectors/src/media/port.js';
import {createMediaIngestionService} from '../packages/domain/src/media-ingestion-service.js';
import {createStore} from '../packages/database/src/index.js';
import {MediaConfigSchema} from '../packages/contracts/src/media.js';
import {parseFeedXml} from '../packages/connectors/src/media/feed-xml.js';
import {extractArticleText} from '../packages/connectors/src/media/article-html.js';
import {createMediaEnrichJobHandlers} from '../packages/runtime/src/media-enrich-module.js';
import config from '../config/media.json' with {type:'json'};
const entry=config.sources.find(s=>s.sourceKey==='yahooeconomy');
const url='https://finance.yahoo.com/economy/policy/articles/synthetic-policy-123456789.html';
const prose='This is a synthetic economic report about prices, employment, trade and monetary policy. '.repeat(4);
const snapshot=(extra={})=>({url,title:'Synthetic policy report',header:'Reuters\nSynthetic Reporter',paragraphs:[{kind:'p',text:prose},{kind:'p',text:prose+'(Reporting by Synthetic Reporter; Editing by Synthetic Editor)'}],tail:'(Reporting by Synthetic Reporter; Editing by Synthetic Editor)',wall:false,continues:false,date:'2026-10-03T02:00:00Z',...extra});

test('channel discovery retains different publishers and excludes duplicate or unregistered links',()=>{
 const cards=[{url,title:'Economic policy report',publisherName:'Reuters',date:'2026-10-03T02:00:00Z'},
  {url,title:'Duplicate economic report',publisherName:'Reuters'},
  {url:url.replace('synthetic','mentions-reuters'),title:'Reuters mentioned in press release',publisherName:'PR Newswire'},
  {url:'https://evil.example/article.html',title:'Economic policy report',publisherName:'Reuters'}];
 const items=yahooListItems(cards,entry);
 assert.equal(items.length,2);assert.equal(items[0].discoveredVia.sourceKey,'yahoo');assert.equal(items[0].publishedAt,Date.parse(cards[0].date));
 assert.equal(items[0].externalId.startsWith('yahooeconomy:'),true);assert.equal(items[1].publisherName,'PR Newswire');assert.equal(items[1].publisherKey,'prnewswire');
});

test('visible public reprints keep partial status without end evidence or resolved continuation',()=>{
 const full=yahooVisibleArticle(snapshot(),entry);assert.equal(full.contentLevel,'full');assert.equal(full.paragraphs.length,2);
 for(const change of [{continues:true},{tail:''}])assert.equal(yahooVisibleArticle(snapshot(change),entry).contentLevel,'partial');
 assert.equal(yahooVisibleArticle(snapshot({wall:true}),entry).reason,'paywall');
 assert.equal(yahooVisibleArticle(snapshot({header:'PR Newswire\nReuters mentioned in the article'}),{...entry,expectedPublisherKey:'reuters'}).reason,'publisher_mismatch');
 assert.equal(yahooVisibleArticle(snapshot({header:'PR Newswire'}),entry).reason,'publisher_adapter_pending');
 const bloom=entry;
 const b=yahooVisibleArticle(snapshot({header:'Bloomberg · Bloomberg LP',tail:'©2026 Bloomberg L.P.',paragraphs:[{kind:'p',text:prose},{kind:'p',text:prose},{kind:'h2',text:'Most Read from Bloomberg'},{kind:'p',text:'©2026 Bloomberg L.P.'}],visualEvidenceRequired:true}),bloom);
 assert.equal(b.contentLevel,'full');assert.equal(b.paragraphs.length,2);assert.equal(b.visualEvidenceRequired,true);
});

test('browser news respects request reservation and stops challenges without expansion',async()=>{
 let started=0,evaluated=0;
 const runtime={withSession:async(_options,callback)=>{started++;return callback({navigate:async()=>{},evaluate:async()=>{evaluated++;return {url,challenge:true};}});}};
 assert.equal((await readYahooArticle(runtime,entry,{url},{onRequest:()=>false})).health,'budget_deferred');assert.equal(started,0);
 assert.equal((await readYahooArticle(runtime,entry,{url},{onRequest:()=>true})).health,'blocked');assert.equal(evaluated,1);
 assert.equal((await readYahooArticle(runtime,entry,{url:'https://evil.example/article'})).health,'blocked_url');assert.equal(started,1);
});

test('registered browser news flows through repository, budgets, provenance and saved reading state',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'media-public-news-'));const store=createStore(path.join(directory,'test.db'));
 let navigations=0,activeUrl;
 const browserRuntime={withSession:async(_options,callback)=>callback({navigate:async target=>{navigations++;activeUrl=target;},evaluate:async script=>{
  if(script.includes('section.story-item'))return [{url,title:'Economic policy report',publisherName:'Reuters',date:'2026-10-03T02:00:00Z'}];
  if(script.includes('providerName'))return snapshot();
  return {url:activeUrl,challenge:false};
 }})};
 const mediaPort=createMediaConnector({sources:[entry],browserRuntime,fetchImpl:async()=>{throw new Error('Unexpected HTTP fallback');}});
 const service=createMediaIngestionService({mediaRepository:store.repositories.media,feedRepository:store.repositories.feed,mediaPort,now:()=>Date.parse('2026-10-03T03:00:00Z')});
 try{
  const probe=await service.probe({sourceKeys:[entry.sourceKey],policyReviewed:true,run:true});assert.equal(probe.results[0].itemCount,1);
  assert.equal(service.enableSource('local',entry.sourceKey).ok,true);service.acknowledgeBodyUse('local',[entry.sourceKey]);
  await service.syncEnabled({force:true});const selected=service.selectBodyCandidates('local');assert.equal(selected.length,1);
  const result=await service.fetchBodies({externalIds:[selected[0].externalId]});assert.equal(result.stats.validFull,1);assert.equal(result.stats.requests,1);
  const item=service.readFeed({channel:'macro',view:'full'}).items[0];assert.equal(item.publisherKey,'reuters');assert.equal(item.readingVia,'Yahoo Finance');assert.equal(item.sourceUrl,url);assert.ok(item.contentItemId);
  store.repositories.feed.upsertUserItemState({workspaceId:'local',contentItemId:item.contentItemId,isRead:true});
  assert.equal(service.readFeed({channel:'macro'}).items[0].isRead,true);assert.equal(navigations,3);
  await service.syncEnabled({force:true});assert.equal(service.readFeed({channel:'macro'}).items.length,1);
 }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('official weekly RSS can carry a complete edition and oversized fragments require article reading',()=>{
 const port=createMediaConnector();const weekly=port.extract(`<p>${prose}</p><p>${prose}</p><img src="https://example.com/chart.png" alt="">`,{sourceKey:'ftav',fragment:true});assert.equal(weekly.contentLevel,'full');assert.equal(weekly.visualEvidenceRequired,true);
 const feed=`<rss><channel><item><title>Weekly</title><link>https://ftav.substack.com/p/synthetic</link><content:encoded><![CDATA[<p>${'x'.repeat(200001)}</p>]]></content:encoded></item></channel></rss>`;
 assert.equal(parseFeedXml(feed,config.sources.find(s=>s.sourceKey==='ftav')).items[0].feedBodyHtml,'');
 assert.equal(MediaConfigSchema.parse(config).sources.length,40);assert.equal(MediaConfigSchema.parse({version:1,sources:[]}).budget.maxActiveSources,6);
 assert.equal(MediaConfigSchema.safeParse({...config,budget:{...config.budget,maxActiveSources:25}}).success,false);
});

test('BBC video descriptions are not accepted as complete articles',()=>{
 const html=`<article><div itemprop="articleBody"><p>${prose}</p><p>${prose}</p></div></article>`;
 assert.equal(extractArticleText(html,{sourceKey:'bbc',title:'Watch: A synthetic oil price report'}).reason,'non_article');
});

test('legacy topic configuration cannot filter index, body queue or historical projection',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'media-topics-'));const store=createStore(path.join(directory,'test.db'));
 const source={...entry,transport:'rss',listReadMethod:'http',includeKeywords:['war'],excludeKeywords:['film']};
 const items=[['war','War disrupts international oil trade'],['award','Annual awards celebrate music'],['film','War film wins an award']].map(([id,title])=>({externalId:'yahooeconomy:'+id,sourceUrl:url.replace('synthetic-policy',id),title,summary:'',publishedAt:null}));
 const mediaPort={sources:[source],extractorVersion:'test',fetch:async()=>({ok:true,body:'rss',redirectChain:[]}),parseFeed:()=>({ok:true,items})};
 const service=createMediaIngestionService({mediaRepository:store.repositories.media,mediaPort});
 try{
  store.repositories.media.saveState({workspaceId:'local',sourceKey:source.sourceKey,enabled:true,hostDirectVerified:true,bodyUseAcknowledged:true,health:'ready',updatedAt:Date.now()});
  await service.syncEnabled({force:true});assert.equal(store.repositories.media.listEntries('local').length,3);
  const row=store.repositories.media.listEntries('local')[0];store.repositories.media.upsertEntry({...row,externalId:'reuterswire:legacy',canonicalUrl:url.replace('synthetic-policy','legacy-film'),title:'Legacy war film'});
  assert.equal(store.repositories.media.listEntries('local').length,4);assert.equal(service.readFeed({channel:'macro'}).items.length,4);
  assert.equal(service.selectBodyCandidates('local').length,4);
  assert.deepEqual(service.selectBodyCandidates('local').filter(r=>r.externalId.startsWith('yahooeconomy:')).map(r=>r.externalId),['yahooeconomy:war','yahooeconomy:award','yahooeconomy:film']);
 }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('tag provider failure leaves completed reading available and reports pending tags',async()=>{
 let briefCalls=0;
 const handlers=createMediaEnrichJobHandlers({mediaService:{fetchBodies:async()=>({health:'ready',stats:{validFull:1},fetched:[{externalId:'reuterswire:one',health:'ready',contentLevel:'full'}]}),listBodyCandidates:()=>['reuterswire:one'],listEnrichmentItems:()=>[{externalId:'reuterswire:one',resourceId:'one',contentLevel:'full',body:prose,text:prose}],listArticleTranslationUnits:()=>[{id:'chunk-one',text:prose}],generateBodyBriefs:async()=>{briefCalls++;return [];}},feedService:{localizeTexts:async()=>({pendingIds:[]})},taggingService:{analyzeItems:async()=>{throw new Error('Provider quota exhausted');}}});
 const output=await handlers['media.index.enrich']({});
 assert.equal(output.health,'partial');assert.equal(output.bodiesFetched,1);assert.equal(output.translationStats.pendingChunks,0);assert.equal(output.taggingStatus,'pending');assert.deepEqual(output.pendingTagIds,['one']);assert.equal(briefCalls,1);
});
