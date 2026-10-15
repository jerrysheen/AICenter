import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion, runMigrations } from '../packages/database/src/migrations.js';
import { createHardwareArtifactStore } from '../packages/connectors/src/hardware-artifacts.js';
import { parseStructuredPricePage,legacyPriceSnapshot,PRICE_PARSER_VERSION } from '../packages/connectors/src/trendforce-prices.js';
import { hardwareMarketItem,hardwareQuoteCaption,quoteIsStale } from '../apps/web/public/hardware-prices.js';
import { createHardwarePriceService } from '../packages/domain/src/hardware-price-service.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';
import { createContentRoutingService } from '../packages/domain/src/content-routing-service.js';
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
import { createMediaFeedCache,createMediaFeedLoader } from '../apps/web/public/media-feed.js';
import { prepareDailyMaterials } from '../packages/domain/src/daily-materials.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { HardwarePriceSnapshotInputSchema,ImportedMediaArticleSchema } from '../packages/contracts/src/hardware-prices.js';
import mediaConfig from '../config/media.json' with {type:'json'};
import { createAiCenterServer } from '../apps/web/src/server.js';
import { captureHardwarePrices } from '../packages/runtime/src/web-snapshot-jobs.js';
import {createTrendForceJobHandlers,createTrendForceService} from '../packages/connectors/src/trendforce.js';
import {ensureTrendForcePriceSchedules} from '../packages/runtime/src/trendforce-price-schedule.js';
const at=Date.parse('2026-10-05T04:00:00Z');
const html=(average='10.00',date='2026-10-05',extra='')=>`<div class="price-title">DRAM Spot Price (US$/chip, 未稅)</div>
<div class="price-last-update">Last Update ${date} 18:10 (GMT+8)</div>
<table class="price-table"><tr><th>Item</th><th>High</th><th>Low</th><th>Average</th><th>Change</th></tr>
<tr><td>DDR5 16Gb (2Gx8) 4800/5600</td><td>12.00</td><td>8.00</td><td>${average}</td><td>+2%</td></tr></table>${extra}`;
const parsed=(raw=html(),capturedAt=at)=>parseStructuredPricePage(raw,{pageKey:'dram',title:'DRAM价表',sourceUrl:'https://www.trendforce.com.tw/price/dram/dram_spot',capturedAt});
function fixture({readSource,feedFilter}={}) {
  const directory=mkdtempSync(path.join(os.tmpdir(),'hardware-prices-')),store=createStore(path.join(directory,'test.db'));
  const hardware=createHardwarePriceService({repository:store.repositories.hardwarePrices,artifactStore:createHardwareArtifactStore({dataDirectory:directory})});
  const media=createMediaIngestionService({mediaRepository:store.repositories.media,feedRepository:store.repositories.feed,taggingRepository:store.repositories.tagging,now:()=>at,feedFilter,mediaPort:createMediaConnector({...mediaConfig,readSource})});
  const routing=createContentRoutingService({mediaService:media,hardwarePrices:hardware,feedRepository:store.repositories.feed,legacyPricePort:legacyPriceSnapshot});
  return {directory,store,hardware,media,routing,close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}
test('DOM table parsing preserves complete specifications, sections, decimal values, timestamps and unknown fields',()=>{
  const value=parsed();const row=value.rows[0];assert.equal(row.specification,'DDR5 16Gb (2Gx8) 4800/5600');
  assert.equal(row.average,'10.00');assert.equal(row.high,'12.00');assert.equal(row.currency,'USD');assert.equal(row.unit,'chip');assert.equal(row.period,'2026-10-05');
  assert.equal(row.sourceUpdatedAt,Date.parse('2026-10-05T18:10:00+08:00'));assert.equal(row.changeBasis,null);
  const unknown=parsed(html().replace(' (US$/chip, 未稅)','').replace(' (GMT+8)','')).rows[0];
  assert.equal(unknown.currency,null);assert.equal(unknown.unit,null);assert.equal(unknown.period,null);assert.equal(unknown.sourceUpdatedAt,null);
  assert.throws(()=>HardwarePriceSnapshotInputSchema.parse({...value,rows:[{...row,average:'NaN'}]}));
  const card=parsed(html('10.00','2026-10-05',`<div class="price-title">MicroSD Retail Price TWD/unit</div><table class="price-table"><tr><th>规格</th><th>均价</th></tr><tr><td>MicroSD 128GB</td><td>20</td></tr></table>`)).rows[1];
  assert.equal(card.category,'other-storage');assert.equal(card.currency,'TWD');assert.equal(card.sourceUpdatedAt,null);
});
test('repeated acquisition is idempotent, new periods append and same-period A-B-A revisions retain all versions',()=>{
  const f=fixture();try {
    const first=f.hardware.ingest('local',parsed());f.hardware.ingest('local',parsed(html(),at+1));
    let row=f.hardware.list('local').items[0];assert.equal(f.hardware.detail('local',row.seriesKey).revisions.length,1);assert.equal(f.hardware.detail('local',row.seriesKey).hasHistory,false);
    f.hardware.ingest('local',parsed(html('11.00')+'<!--rev 2-->',at+2));
    f.hardware.ingest('local',parsed(html('10.00')+'<!--rev 3-->',at+3));
    let detail=f.hardware.detail('local',row.seriesKey);assert.deepEqual(detail.revisions.map(r=>r.average),['10.00','11.00','10.00']);assert.equal(detail.current.revision,3);assert.equal(detail.hasHistory,false);
    f.hardware.ingest('local',parsed(html('12.00','2026-10-06'),at+86400000));detail=f.hardware.detail('local',row.seriesKey);
    assert.equal(detail.hasHistory,true);assert.equal(detail.current.changePct,20);assert.equal(detail.observations.length,2);
    assert.equal(f.hardware.snapshot('local',first.id).items[0].average,'10.00');assert.equal(f.hardware.snapshot('other',first.id),null);
    assert.equal(JSON.stringify(detail).includes('artifactPath'),false);
  }finally{f.close();}
});
test('missing units and periods stay pending with no calculated change or synthetic history',()=>{
  const f=fixture();try {
    const input=parsed(html().replace(' (US$/chip, 未稅)','').replace(' (GMT+8)',''));
    f.hardware.ingest('local',input);f.hardware.ingest('local',{...input,capturedAt:at+1});
    const row=f.hardware.list('local').items[0],detail=f.hardware.detail('local',row.seriesKey);
    assert.equal(row.verification,'pending');assert.equal(row.changePct,null);assert.equal(detail.hasHistory,false);assert.equal(detail.revisions.length,1);
  }finally{f.close();}
});
test('migration preserves old body, identity, read/save/tags and whole-table old links; repeat migration changes nothing',async()=>{
  const f=fixture();try {
    const repo=f.store.repositories.feed;
    const source=repo.upsertSourceAccount({workspaceId:'local',provider:'trendforce',externalId:'trendforce:public',displayName:'TrendForce'});
    const old=(externalId,body)=>{const c=repo.saveCapture({workspaceId:'local',provider:'trendforce',externalId,sourceAccountId:source.id,sourceUrl:'https://www.trendforce.com.tw/insights/test',contentHash:externalId,status:'ready',metadata:{originalText:body}});
      return repo.saveContentItem({workspaceId:'local',captureId:c.id,originType:'subscription',contentType:'article',title:'留存材料',body,summary:'介绍',sourceUrl:c.sourceUrl,authorName:'TrendForce',publishedAt:at});};
    const intro=old('research:RP1','会员报告，仅收录标题与介绍，不是 PDF 全文。原始简介');
    const insight=old('insight:one','留存文章第一段\n\n留存文章最后一段');
    const price=old('price:dram','DRAM Spot Price\n\n| 项目 | 均价 |\n| --- | --- |\n| DDR5 16Gb | 10 |\n| DDR4 8Gb | 5 |');
    repo.upsertUserItemState({workspaceId:'local',contentItemId:intro.id,isRead:true,isSaved:true});
    f.store.repositories.tagging.saveTaggings({workspaceId:'local',resourceType:'content-item',resourceId:intro.id,tags:['memory'],tagCatalogVersion:'1',promptVersion:'fixture',model:'fixture'});
    const first=await f.routing.migrate('local'),second=await f.routing.migrate('local');assert.equal(first.snapshots,1);assert.deepEqual(second,{snapshots:0,articles:0});
    const feed=f.media.readFeed({channel:'tech',view:'all',sourceKey:'trendforce'});assert.equal(feed.items.length,2);
    const item=feed.items.find(i=>i.articleKind==='report-intro');assert.equal(item.contentLevel,'summary_only');assert.equal(item.contentItemId,intro.id);assert.equal(item.isRead,true);assert.equal(item.isSaved,true);assert.deepEqual(item.tags,['memory']);
    assert.equal(repo.getContentItem('local',insight.id).body,insight.body);assert.equal(f.media.readFeed({channel:'tech',view:'full'}).items.length,0);
    const s=f.hardware.legacySnapshot('local',price.id);assert.equal(f.hardware.snapshot('local',s.id).items.length,2);assert.equal(s.format,'legacy-text');
    const service=createFeedService({legacyRepository:f.store,feedRepository:repo,sourcePort:{},mediaPort:f.media,contentRoutingPort:f.routing});
    const original=service.getOriginalContent('local','trendforce:price:dram');assert.equal(original.body,price.body);assert.equal(original.hardwareSnapshot.id,s.id);
    const materials=await prepareDailyMaterials({feedService:service,mediaPort:f.media,workspaceId:'local',time:{contentWindow:{startAt:at-1,endAt:at+1}},frozenAt:at+1});
    assert.equal(materials.materials.filter(m=>m.id.startsWith('feed:')).length,0);assert.equal(materials.materials.find(m=>m.title===intro.title && m.contentLevel==='summary_only').contentLevel,'summary_only');
    repo.upsertUserItemState({workspaceId:'local',contentItemId:intro.id,isHidden:true});assert.equal(f.media.readFeed({sourceKey:'trendforce'}).items.length,1);
    assert.equal(f.media.dailyMaterials('local',{startAt:at-1,endAt:at+1,sourceId:'trendforce'}).length,1);
  }finally{f.close();}
});
test('media report intro cannot be full, articles are ingested once and media sync does not reacquire TrendForce',async()=>{
  let calls=0;const f=fixture({readSource:()=>{calls++;throw new Error('unexpected media acquisition');}});try {
    const article={externalId:'insight:a',title:'供需预测仍是文章',summary:'介绍',body:'这是已验证文章正文。',sourceUrl:'https://www.trendforce.com.tw/insights/a',publishedAt:at,
      articleKind:'article',contentLevel:'full',extractorVersion:'media-dom-2',paragraphs:[{id:'p0001',text:'这是已验证文章正文。',kind:'paragraph'}]};
    assert.throws(()=>ImportedMediaArticleSchema.parse({...article,articleKind:'report-intro'}));
    await f.routing.ingest('local',{items:[article],priceSnapshots:[parsed()]});await f.routing.ingest('local',{items:[article],priceSnapshots:[parsed()]});
    assert.equal(f.media.readFeed({sourceKey:'trendforce',view:'full'}).items.length,1);assert.equal(f.hardware.list('local').items.length,1);
    const other=f.media.readFeed({sourceKey:'bbc'});assert.equal(other.items.length,0);assert.equal(other.counts.all,0);
    f.media.enableSource('local','trendforce');await f.media.syncEnabled({force:true});assert.equal(calls,0);
    await f.media.fetchBodies({externalIds:['trendforce:insight:a']});assert.equal(calls,0);
    assert.equal(f.media.dailyMaterials('local',{startAt:at-1,endAt:at+1,sourceId:'trendforce'})[0].effectiveLevel,'full');
    // A summary fallback must not erase the successfully saved body.
    await f.routing.ingest('local',{items:[{...article,contentLevel:'summary_only',body:'摘要',paragraphs:[]}],priceSnapshots:[]});
    assert.equal(f.media.readFeed({sourceKey:'trendforce',view:'full'}).items.length,1);
  }finally{f.close();}
});
test('day high/low headers never become specification or change series identity with price',()=>{
  const daily=html().replace('High','日高點').replace('Low','日低點');
  const row=parsed(daily).rows[0];assert.equal(row.specification,'DDR5 16Gb (2Gx8) 4800/5600');assert.equal(row.high,'12.00');assert.equal(row.low,'8.00');
  const f=fixture();try {
    f.hardware.ingest('local',parsed(daily));f.hardware.ingest('local',parsed(daily.replace('12.00','13.00')+'<!-- revised -->',at+1));
    const items=f.hardware.list('local').items;assert.equal(items.length,1);assert.equal(f.hardware.detail('local',items[0].seriesKey).revisions.length,2);
  }finally{f.close();}
});
test('market history exposes dated latest revisions only and saved HTML reparse keeps old links and snapshots',async()=>{
  const f=fixture();try {
    const old=parsed(html().replace('High','日高點').replace('Low','日低點'));
    old.parserVersion='trendforce-tables-1';old.rows[0].specification='項目: DDR5 16Gb (2Gx8) 4800/5600 · 日高點: 12.00 · 日低點: 8.00';old.rows[0].high=null;old.rows[0].low=null;
    const snapshot=f.hardware.ingest('local',old);
    const legacy={...old,format:'legacy-text',parserVersion:'legacy-text-1',raw:'old preserved raw',capturedAt:at-1,rows:[{...old.rows[0],period:null,periodStart:null,periodEnd:null}]};f.hardware.ingest('local',legacy);
    const handlers=createTrendForceJobHandlers({hardwarePriceService:f.hardware});
    assert.equal((await handlers['feed.trendforce.reparse']({workspaceId:'local'},{job:{workspaceId:'local'}})).added,1);
    assert.equal((await handlers['feed.trendforce.reparse']({workspaceId:'local'},{job:{workspaceId:'local'}})).added,0);
    const item=f.hardware.list('local').items[0];assert.equal(f.hardware.list('local').items.length,1);assert.equal(item.specification,'DDR5 16Gb (2Gx8) 4800/5600');
    assert.equal(f.hardware.snapshot('local',snapshot.id).items[0].specification,old.rows[0].specification);
    f.hardware.ingest('local',parsed(html('11.00','2026-10-06'),at+86400000));f.hardware.ingest('local',parsed(html('12.00','2026-10-06')+'<!-- revise -->',at+86400001));
    assert.deepEqual(f.hardware.list('local').items[0].history.map(p=>p.average),['10.00','12.00']);
    assert.deepEqual(f.hardware.list('local').items[0].history.map(p=>p.period),['2026-10-05','2026-10-06']);
    assert.equal(f.hardware.savedSnapshots('other').length,0);
  }finally{f.close();}
});
test('real dated observations with unknown currency or units remain visible as history without comparable change',()=>{
  const f=fixture();try {
    f.hardware.ingest('local',parsed(html().replace(' (US$/chip, 未稅)','')));
    f.hardware.ingest('local',parsed(html('11.00','2026-10-06').replace(' (US$/chip, 未稅)',''),at+86400000));
    const row=f.hardware.list('local').items[0],detail=f.hardware.detail('local',row.seriesKey);
    assert.equal(detail.hasHistory,true);assert.equal(detail.observations.length,2);assert.equal(row.verification,'pending');assert.equal(row.changePct,null);
  }finally{f.close();}
});
test('current board excludes retired table rows while their exact snapshots stay readable',()=>{
  const f=fixture();try {
    const input=parsed(html().replace('</table>','<tr><td>Retired DDR3 4Gb</td><td>6</td><td>4</td><td>5</td><td>0%</td></tr></table>')),old=f.hardware.ingest('local',input);
    f.hardware.ingest('local',parsed(html('11.00','2026-10-06')+'<!-- current table -->',at+86400000));
    assert.deepEqual(f.hardware.list('local').items.map(r=>r.specification),['DDR5 16Gb (2Gx8) 4800/5600']);
    assert.equal(f.hardware.snapshot('local',old.id).items.length,2);assert.equal(f.hardware.list('local').items[0].history.length,2);
  }finally{f.close();}
});
test('a verified extraction upgrades a migrated partial body even when all its saved text is identical',async()=>{
  const f=fixture();try {
    const article={externalId:'insight:upgrade',title:'现有正文核验',summary:'摘要',body:'保存的正文内容。',sourceUrl:'https://www.trendforce.com.tw/insights/upgrade',publishedAt:at,
      articleKind:'article',contentLevel:'partial',extractorVersion:'',paragraphs:[{id:'p0001',text:'保存的正文内容。',kind:'paragraph'}]};
    await f.routing.ingest('local',{items:[article]});assert.equal(f.media.readFeed({sourceKey:'trendforce',view:'full'}).items.length,0);
    await f.routing.ingest('local',{items:[{...article,contentLevel:'full',extractorVersion:'media-dom-2'}]});
    assert.equal(f.media.readFeed({sourceKey:'trendforce',view:'full'}).items.length,1);
    assert.deepEqual(f.routing.knownFullArticleIds('local'),['insight:upgrade']);
    assert.equal(f.media.dailyMaterials('local',{startAt:at-1,endAt:at+1,sourceId:'trendforce'})[0].effectiveLevel,'full');
  }finally{f.close();}
});
test('native high/low headers, SSD multi-column identity and half-month or quarter periods remain distinct',()=>{
  const raw=`<div class="price-title">NAND Flash Contract Price in Memory Card/UFD (2H Aug)</div>
    <div class="price-last-update">Last Update 2026-08-31 18:00 (GMT+8)</div>
    <table class="price-table"><tr><th>項目</th><th>高點</th><th>低點</th><th>均價</th></tr><tr><td>NAND 128Gb 16Gx8 MLC</td><td>30.60</td><td>30.25</td><td>30.475</td></tr></table>
    <div class="price-title">PC-Client OEM SSD Contract Price (3Q'26)</div><table class="price-table"><tr><th>項目</th><th>高點</th><th>低點</th><th>均價</th></tr><tr><td>1TB M.2 TLC PCIe</td><td>385</td><td>265</td><td>321</td></tr></table>
    <div class="price-title">SSD Street Price</div><div class="price-last-update">Last Update 2026-09-24 11:30 (GMT+8)</div>
    <table class="price-table"><tr><th>品牌</th><th>規格</th><th>系列</th><th>容量</th><th>高點</th><th>低點</th><th>均價</th></tr><tr><td>Brand A</td><td>PCIe 4.0 X4</td><td>Model A</td><td>1 TB</td><td>239.99</td><td>229.99</td><td>234.99</td></tr></table>`;
  const rows=parseStructuredPricePage(raw,{pageKey:'flash',sourceUrl:'https://www.trendforce.com.tw/price/flash/flash_spot'}).rows;
  assert.equal(rows[0].category,'nand');assert.equal(rows[0].period,'2026-08 2H');assert.equal(rows[0].high,'30.60');assert.equal(rows[0].lowBasis,'低點');
  assert.equal(rows[1].period,'2026 Q3');assert.equal(rows[2].quoteType,'retail');assert.match(rows[2].specification,/Brand A.*PCIe 4.0 X4.*Model A.*1 TB/);assert.equal(rows[2].currency,null);
});
test('unchanged quote reuses an observation but retains every original table and its latest source timestamp',()=>{
  const f=fixture();try {
    const first=f.hardware.ingest('local',parsed());const second=f.hardware.ingest('local',parsed(html().replace('18:10','18:11'),at+60000));
    const row=f.hardware.list('local').items[0],detail=f.hardware.detail('local',row.seriesKey);
    assert.equal(detail.revisions.length,1);assert.equal(detail.snapshots.length,2);assert.equal(detail.current.snapshotId,second.id);
    assert.equal(detail.current.sourceUpdatedAt,Date.parse('2026-10-05T18:11:00+08:00'));assert.equal(detail.current.capturedAt,at+60000);
    assert.equal(f.hardware.snapshot('local',first.id).items[0].sourceUpdatedAt,Date.parse('2026-10-05T18:10:00+08:00'));
  }finally{f.close();}
});
test('registered owner task normalizes its query and queues media enrichment without another acquisition',async()=>{
  const f=fixture();try {
    let args;const handler=createTrendForceJobHandlers({syncFeed:async(...values)=>{args=values;return {mode:'cached',items:[],note:'saved',mediaExternalIds:['trendforce:insight:a']};}})['feed.trendforce.sync'];
    await handler({workspaceId:'local'},{store:f.store,job:{workspaceId:'local'}});
    assert.deepEqual(args,['trendforce',{feed:'public',refresh:true},{workspaceId:'local'}]);
    assert.ok(f.store.listJobs(10).some(j=>j.type==='media.index.enrich' && j.input.externalIds[0]==='trendforce:insight:a'));
    await assert.rejects(()=>handler({command:'anything'},{store:f.store}));
    let requests=0;const service=createTrendForceService({delay:async()=>{},fetch:async()=>{requests++;await Promise.resolve();return {ok:true,status:200,text:async()=>html(),url:'https://www.trendforce.com.tw'};}});
    const [one,two]=await Promise.all([service.getFeed({bypassCache:true}),service.getFeed({bypassCache:true})]);
    assert.equal(requests,4);assert.strictEqual(one,two);
  }finally{f.close();}
});
test('source filtering isolates display caches and discards late responses from the previous source',async()=>{
  const values=new Map(),cache=createMediaFeedCache({storage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}});
  let selection={channel:'tech',view:'all',sourceKey:'trendforce'},shown=[];const pending=[];
  const loader=createMediaFeedLoader({cache,getScope:()=> 'device:test',getSelection:()=>selection,readFeed:()=>new Promise(resolve=>pending.push(resolve)),onFeed:feed=>shown.push(feed),onLoading:()=>{}});
  const first=loader.load();await Promise.resolve();selection={...selection,sourceKey:'bbc'};const second=loader.load();await Promise.resolve();
  pending[1]({feed:{items:[{id:'bbc'}]}});await second;pending[0]({feed:{items:[{id:'trendforce'}]}});await first;
  assert.equal(shown.at(-1).items[0].id,'bbc');assert.equal(cache.get('device:test','tech:all:trendforce'),null);assert.equal(cache.get('device:test','tech:all:bbc').items[0].id,'bbc');
});
const liveNand=`<div id="flash_spot" class="price-content">
  <div class="price-title">NAND Flash Spot Price <small>(未稅)</small></div>
  <div class="price-last-update"><p>Last Update 2026-09-28 14:40 (GMT+8)</p></div>
  <table class="price-table"><tr><th>項目</th><th>日高點</th><th>日低點</th><th>盤高點</th><th>盤低點</th><th>盤平均</th><th>盤漲跌幅</th></tr>
  <tr><td><span title="Samsung">SLC 2Gb 256MBx8</span></td><td>4.55</td><td>4.20</td><td>4.80</td><td>4.10</td><td>4.348</td><td>0.07 %</td></tr></table></div>
  <div class="price-title">NAND Flash Contract Price in Memory Card/UFD (2H Aug)</div>
  <ul class="price-notice"><li>Sep. NAND Flash contract price updated on 9/30/2026.</li></ul>
  <div class="price-last-update"><p>Last Update 2026-08-31 18:00 (GMT+8)</p></div>
  <table class="price-table"><tr><th>項目</th><th>高點</th><th>低點</th><th>均價</th></tr><tr><td>NAND 128Gb 16Gx8 MLC</td><td>30.60</td><td>30.25</td><td>30.475</td></tr></table>`;
test('NAND spot uses the session quote, keeps its own update date, and restores USD per chip',()=>{
  const value=parseStructuredPricePage(liveNand,{pageKey:'flash',sourceUrl:'https://www.trendforce.com.tw/price/flash/flash_spot',title:'NAND'});
  const spot=value.rows.find(row=>row.specification==='SLC 2Gb 256MBx8');
  assert.equal(spot.average,'4.348');assert.equal(spot.high,'4.80');assert.equal(spot.low,'4.10');
  assert.equal(spot.highBasis,'盤高點');assert.equal(spot.averageBasis,'盤平均');
  assert.equal(spot.period,'2026-09-28');assert.equal(spot.currency,'USD');assert.equal(spot.unit,'chip');assert.equal(spot.taxBasis,'excluding-tax');
  assert.equal(value.rows.find(row=>row.specification.startsWith('NAND 128Gb')).period,'2026-08 2H');
  assert.match(value.warnings.join('\n'),/2026-09-30/);
});
test('an unchanged page records a new check without a new quote revision',()=>{
  const f=fixture();try {
    const first=f.hardware.ingest('local',parsed());
    const second=f.hardware.ingest('local',parsed(html(),at+60000));
    assert.equal(second.id,first.id);
    const page=f.hardware.pageChecks('local').find(item=>item.pageKey==='dram');
    assert.equal(page.lastChangedAt,at);assert.equal(page.lastCheckedAt,at+60000);assert.equal(page.unchanged,true);
    assert.equal(f.hardware.detail('local',f.hardware.list('local').items[0].seriesKey).revisions.length,1);
    assert.equal(f.hardware.list('local').pages[0].unchanged,true);
  }finally{f.close();}
});
test('a renamed average column stays on the existing series when currency was already known',()=>{
  const f=fixture();try {
    f.hardware.ingest('local',parsed());
    const renamed=liveNand.replace('SLC 2Gb 256MBx8','DDR5 16Gb (2Gx8) 4800/5600').replace('2026-09-28','2026-10-12').replace('id="flash_spot"','id="dram_spot"');
    const next=parseStructuredPricePage(renamed,{pageKey:'dram',sourceUrl:'https://www.trendforce.com.tw/price/dram/dram_spot',title:'DRAM',capturedAt:at+86400000});
    const spot=next.rows.find(row=>row.specification.includes('DDR5'));
    spot.category='dram';
    f.hardware.ingest('local',{...next,pageKey:'dram',rows:next.rows.map(row=>row.specification.includes('DDR5')?{...row,category:'dram'}:row)});
    const items=f.hardware.list('local').items.filter(row=>row.specification.includes('DDR5'));
    assert.equal(items.length,1);assert.equal(items[0].history.length,2);assert.equal(items[0].currency,'USD');assert.equal(items[0].unit,'chip');
    assert.deepEqual(items[0].rawCells,[]);
  }finally{f.close();}
});
test('worker price schedules run twice each Shanghai day and can be turned off',()=>{
  const f=fixture();try {
    const now=Date.parse('2026-10-12T02:00:00Z');
    const saved=ensureTrendForcePriceSchedules(f.store,{AI_CENTER_TRENDFORCE_PRICE_AT:'10:30,17:30',AI_CENTER_TRENDFORCE_PRICE_TIMEZONE:'Asia/Shanghai'},now);
    assert.deepEqual(saved.filter(item=>item.enabled).map(item=>`${item.schedule.hour}:${String(item.schedule.minute).padStart(2,'0')}`),['10:30','17:30']);
    assert.ok(saved[0].nextRunAt>now);assert.ok(saved[1].nextRunAt>now);
    const off=ensureTrendForcePriceSchedules(f.store,{AI_CENTER_TRENDFORCE_PRICE_SYNC:'0'},now+1);
    assert.equal(off.every(item=>item.enabled===false),true);
  }finally{f.close();}
});
test('forward migration upgrades V39 with existing content and states intact',()=>{
  const f=fixture();try {
    f.store.close();const db=new Database(path.join(f.directory,'test.db'));
    db.exec(`DROP TABLE IF EXISTS gpu_rent_observations;DROP TABLE IF EXISTS token_price_observations;DROP TABLE IF EXISTS compute_price_checks;DROP TABLE IF EXISTS compute_price_snapshots;DROP TABLE IF EXISTS hardware_price_page_checks;DROP TABLE hardware_price_legacy_links;DROP TABLE hardware_price_snapshot_rows;DROP TABLE hardware_price_observations;DROP TABLE hardware_price_snapshots;
      DROP TABLE media_entry_legacy_links;ALTER TABLE media_index_entries DROP COLUMN article_kind;
      ALTER TABLE investor_discussion_digests DROP COLUMN question_set;
      DROP TABLE IF EXISTS api_token_access_log;DROP TABLE IF EXISTS api_access_tokens;DROP TABLE IF EXISTS runtime_snapshots;
      DROP INDEX IF EXISTS idx_captures_feed_sort;DROP INDEX IF EXISTS idx_captures_provider_captured;DROP INDEX IF EXISTS idx_captures_feed_filter;
      DROP INDEX IF EXISTS idx_content_items_capture_cover;DROP INDEX IF EXISTS idx_user_item_states_feed_flags;
      DROP TABLE IF EXISTS gemini_model_cursors;
      DELETE FROM schema_migrations WHERE version IN (40,54,55,56,57,58,59,60,61,62,64,65,66,67,68,69);PRAGMA user_version=39;`);
    const before=db.prepare('SELECT count(*) n FROM content_items').get().n;runMigrations(db);runMigrations(db);
    assert.equal(db.pragma('user_version',{simple:true}),latestSchemaVersion());assert.equal(db.prepare('SELECT count(*) n FROM content_items').get().n,before);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM pragma_table_info('hardware_price_snapshots') WHERE name='last_checked_at'`).get().n,1);db.close();
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});
const contractHtml=`<div class="price-title">DRAM Contract Price (2H Aug) <small>(未稅)</small></div>
<div class="price-last-update">Last Update 2026-08-31 14:00 (GMT+8)</div>
<table class="price-table"><tr><th>項目</th><th>盤高點</th><th>盤低點</th><th>盤平均</th></tr>
<tr><td>DDR5 8GB SO-DIMM</td><td>141.00</td><td>118.00</td><td>133.00</td></tr>
<tr><td>DDR4 16GB SO-DIMM</td><td>290.00</td><td>245.00</td><td>270.00</td></tr>
<tr><td>DDR4 8GB SO-DIMM</td><td>148.00</td><td>125.00</td><td>142.00</td></tr>
<tr><td>DDR4 8Gb 1Gx8</td><td>34.50</td><td>22.50</td><td>25.00</td></tr></table>
<div class="price-title">Module Spot Price <small>(未稅)</small></div>
<div class="price-last-update">Last Update 2026-10-05 14:40 (GMT+8)</div>
<table class="price-table"><tr><th>項目</th><th>盤高點</th><th>盤低點</th><th>盤平均</th></tr>
<tr><td>DDR5 UDIMM 16GB 4800/5600</td><td>265.00</td><td>223.00</td><td>239.00</td></tr></table>
<div class="price-title">GDDR Spot Price <small>(未稅)</small></div>
<div class="price-last-update">Last Update 2026-10-05 14:40 (GMT+8)</div>
<table class="price-table"><tr><th>項目</th><th>盤高點</th><th>盤低點</th><th>盤平均</th></tr>
<tr><td>GDDR6 8Gb</td><td>18.00</td><td>10.20</td><td>12.45</td></tr></table>`;
const flashBoards=`<div class="price-title">NAND Flash Contract Price in Memory Card/UFD (2H Aug) <small>(未稅)</small></div>
<div class="price-last-update">Last Update 2026-08-31 18:00 (GMT+8)</div>
<table class="price-table"><tr><th>項目</th><th>高點</th><th>低點</th><th>均價</th></tr>
<tr><td>NAND 128Gb 16Gx8 MLC</td><td>30.60</td><td>30.25</td><td>30.475</td></tr></table>
<div class="price-title">Wafer Spot Price <small>(未稅)</small></div>
<div class="price-last-update">Last Update 2026-10-05 14:40 (GMT+8)</div>
<table class="price-table"><tr><th>項目</th><th>盤高點</th><th>盤低點</th><th>盤平均</th></tr>
<tr><td>512Gb TLC</td><td>21.00</td><td>16.80</td><td>18.833</td></tr></table>
<div class="price-title">Memory Card Spot Price <small>(未稅)</small></div>
<div class="price-last-update">Last Update 2026-10-05 14:40 (GMT+8)</div>
<table class="price-table"><tr><th>項目</th><th>盤高點</th><th>盤低點</th><th>盤平均</th></tr>
<tr><td>MicroSD 128GB</td><td>13.00</td><td>12.00</td><td>12.29</td></tr></table>
<div class="price-title">PC-Client OEM SSD Contract Price (3Q'26) <small>(未稅)</small></div>
<div class="price-last-update">Last Update 2026-08-05 11:00 (GMT+8)</div>
<table class="price-table"><tr><th>項目</th><th>高點</th><th>低點</th><th>均價</th></tr>
<tr><td>1TB-mSATA/M.2 TLC PCIe-Value Grade</td><td>385.00</td><td>265.00</td><td>321.00</td></tr></table>
<div class="price-title">SSD Street Price <small>(未稅)</small></div>
<div class="price-last-update">Last Update 2026-09-24 11:30 (GMT+8)</div>
<table class="price-table"><tr><th>品牌</th><th>規格</th><th>系列</th><th>容量</th><th>高點</th><th>低點</th><th>均價</th></tr>
<tr><td>Samsung</td><td>PCIe 4.0 X4</td><td>990 Pro</td><td>1 TB</td><td>239.99</td><td>239.99</td><td>239.99</td></tr></table>`;
test('DRAM contract SO-DIMM is priced per module and the other storage boards keep USD units without changing numbers',()=>{
  assert.equal(PRICE_PARSER_VERSION,'trendforce-tables-4');
  const dram=parseStructuredPricePage(contractHtml,{pageKey:'dram',sourceUrl:'https://www.trendforce.com.tw/price/dram/dram_spot',title:'DRAM'}).rows;
  assert.deepEqual(dram.filter(row=>/SO-DIMM/.test(row.specification)).map(row=>[row.specification,row.unit,row.currency,row.average]),[
    ['DDR5 8GB SO-DIMM','module','USD','133.00'],
    ['DDR4 16GB SO-DIMM','module','USD','270.00'],
    ['DDR4 8GB SO-DIMM','module','USD','142.00'],
  ]);
  const granule=dram.find(row=>row.specification==='DDR4 8Gb 1Gx8');
  assert.equal(granule.unit,'chip');assert.equal(granule.currency,'USD');assert.equal(granule.average,'25.00');
  assert.equal(dram.find(row=>row.specification.startsWith('DDR5 UDIMM')).unit,'module');
  assert.equal(dram.find(row=>row.specification==='GDDR6 8Gb').unit,'chip');
  assert.equal(dram.find(row=>row.specification==='GDDR6 8Gb').average,'12.45');
  const flash=parseStructuredPricePage(flashBoards,{pageKey:'flash',sourceUrl:'https://www.trendforce.com.tw/price/flash/flash_spot',title:'NAND'}).rows;
  const bySpec=spec=>flash.find(row=>row.specification===spec || row.specification.includes(spec));
  assert.equal(bySpec('NAND 128Gb').unit,'chip');assert.equal(bySpec('NAND 128Gb').currency,'USD');assert.equal(bySpec('NAND 128Gb').average,'30.475');
  assert.equal(bySpec('512Gb TLC').unit,'wafer');assert.equal(bySpec('512Gb TLC').average,'18.833');
  assert.equal(bySpec('MicroSD 128GB').unit,'card');assert.equal(bySpec('MicroSD 128GB').category,'other-storage');assert.equal(bySpec('MicroSD 128GB').average,'12.29');
  assert.equal(bySpec('1TB-mSATA').unit,'unit');assert.equal(bySpec('1TB-mSATA').currency,'USD');assert.equal(bySpec('1TB-mSATA').average,'321.00');
  assert.equal(bySpec('990 Pro').currency,'USD');assert.equal(bySpec('990 Pro').unit,'unit');assert.equal(bySpec('990 Pro').average,'239.99');
});
test('reading keeps the dated quote with a unit and marks the old current rows without deleting them',()=>{
  const f=fixture();try {
    const base=parsed();
    const mixed={...base,raw:html()+'<!--mixed-->',rows:[
      {...base.rows[0],specification:'DDR5 16Gb (2Gx8) 4800/5600 · 日高點: 12.00',currency:null,unit:null,high:null,low:null},
      {...base.rows[0],tableIndex:1,rowIndex:1},
      {...base.rows[0],period:null,periodStart:null,periodEnd:null,tableIndex:2,rowIndex:1},
    ]};
    const saved=f.hardware.ingest('local',mixed);
    const spot=f.hardware.list('local').items.filter(row=>row.specification.includes('DDR5 16Gb'));
    assert.equal(spot.length,1);assert.equal(spot[0].unit,'chip');assert.equal(spot[0].specification.includes('日高點'),false);
    const chipRows=parseStructuredPricePage(contractHtml,{pageKey:'dram',sourceUrl:'https://www.trendforce.com.tw/price/dram/dram_spot',title:'DRAM'}).rows.map(row=>row.specification.includes('SO-DIMM')?{...row,unit:'chip'}:row);
    f.hardware.ingest('local',{...parseStructuredPricePage(contractHtml,{pageKey:'dram',sourceUrl:'https://www.trendforce.com.tw/price/dram/dram_spot',title:'DRAM',capturedAt:at+2}),parserVersion:'trendforce-tables-3',raw:contractHtml+'<!--chip sodimm-->',capturedAt:at+2,rows:chipRows});
    f.hardware.ingest('local',parseStructuredPricePage(contractHtml+'<!--module-->',{pageKey:'dram',sourceUrl:'https://www.trendforce.com.tw/price/dram/dram_spot',title:'DRAM',capturedAt:at+3}));
    const items=f.hardware.list('local').items;
    assert.equal(items.filter(row=>/SO-DIMM/.test(row.specification)).every(row=>row.unit==='module'),true);
    assert.equal(items.some(row=>row.period==null),false);
    const db=new Database(path.join(f.directory,'test.db'),{readonly:true});
    const flags=db.prepare(`SELECT is_current current,json_extract(row_json,'$.specification') spec,json_extract(row_json,'$.unit') unit,period_key periodKey FROM hardware_price_observations`).all();
    assert.equal(flags.some(row=>row.spec.includes('日高點') && row.current===0),true);
    assert.equal(flags.some(row=>String(row.periodKey).startsWith('unverified:') && row.current===0),true);
    assert.equal(flags.some(row=>/SO-DIMM/.test(row.spec) && row.unit==='chip' && row.current===0),true);
    assert.equal(flags.some(row=>/SO-DIMM/.test(row.spec) && row.unit==='module' && row.current===1),true);
    assert.equal(flags.filter(row=>row.spec.includes('日高點')).length,1);
    db.close();
    assert.equal(f.hardware.snapshot('local',saved.id).items.some(row=>row.specification.includes('日高點')),true);
  }finally{f.close();}
});
test('each hardware quote shows its source date, marks week-old prints, and names the DRAM contract half',()=>{
  const now=Date.parse('2026-10-15T04:00:00Z');
  const contract={category:'dram',quoteType:'contract',currency:'USD',unit:'module',specification:'DDR5 8GB SO-DIMM',seriesKey:'a'.repeat(64),
    period:'2026-08 2H',periodStart:Date.parse('2026-08-16T00:00:00+08:00'),sourceUpdatedAt:Date.parse('2026-08-31T14:00:00+08:00'),verification:'verified',average:'133.00',changePct:null,history:[]};
  const caption=hardwareQuoteCaption(contract,now);
  assert.match(caption.text,/8 月下半月/);assert.match(caption.text,/08-31/);assert.match(caption.text,/已过期/);
  assert.equal(caption.text.includes('9 月'),false);assert.equal(caption.text.includes('09-30'),false);
  assert.equal(hardwareMarketItem(contract,now).stale,true);
  const spot={category:'dram',quoteType:'spot',currency:'USD',unit:'chip',specification:'DDR5 16Gb (2Gx8) 4800/5600',seriesKey:'b'.repeat(64),
    period:'2026-10-15',periodStart:Date.parse('2026-10-15T00:00:00+08:00'),sourceUpdatedAt:Date.parse('2026-10-15T14:40:00+08:00'),verification:'verified',average:'60.433',changePct:null,history:[]};
  const live=hardwareQuoteCaption(spot,now);
  assert.match(live.text,/10-15/);assert.equal(live.stale,false);assert.equal(live.text.includes('已过期'),false);
  const ssd={category:'ssd',quoteType:'contract',currency:'USD',unit:'unit',specification:'1TB-mSATA/M.2 TLC PCIe-Value Grade',seriesKey:'c'.repeat(64),
    period:'2026 Q3',periodStart:Date.parse('2026-07-01T00:00:00+08:00'),sourceUpdatedAt:Date.parse('2026-08-05T11:00:00+08:00'),verification:'verified',average:'321.00',changePct:null,history:[]};
  assert.match(hardwareQuoteCaption(ssd,now).text,/2026 Q3/);assert.match(hardwareQuoteCaption(ssd,now).text,/08-05/);assert.equal(hardwareQuoteCaption(ssd,now).stale,true);
  assert.equal(quoteIsStale(now-7*86400000,now),false);
  assert.equal(quoteIsStale(now-7*86400000-1,now),true);
});
test('migration 69 clears superseded current flags and keeps every observation row',()=>{
  const f=fixture();try {
    f.store.close();
    const db=new Database(path.join(f.directory,'test.db'));
    const row=(id,spec,unit,periodKey,period,periodStart,current)=>db.prepare('INSERT INTO hardware_price_observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id,'local','series-'+id,periodKey,1,null,'hash-'+id,'snapshot-'+id,at,periodStart,at,current,JSON.stringify({specification:spec,category:'dram',quoteType:'spot',unit,period,average:'10.00',high:null,low:null}));
    row('old-dirty','DDR5 16Gb (2Gx8) 4800/5600 · 日高點: 19.70',null,'["2026-10-05",1,2]','2026-10-05',at,1);
    row('new-clean','DDR5 16Gb (2Gx8) 4800/5600','chip','["2026-10-12",1,2]','2026-10-12',at+86400000,1);
    row('undated','DDR5 16Gb (2Gx8) 4800/5600','chip','unverified:snapshot-undated',null,null,1);
    db.prepare('DELETE FROM schema_migrations WHERE version=69').run();
    db.pragma('user_version = 68');
    runMigrations(db);
    const flags=db.prepare('SELECT id,is_current current FROM hardware_price_observations ORDER BY id').all();
    assert.equal(flags.length,3);
    assert.equal(flags.find(item=>item.id==='old-dirty').current,0);
    assert.equal(flags.find(item=>item.id==='undated').current,0);
    assert.equal(flags.find(item=>item.id==='new-clean').current,1);
    assert.equal(db.prepare(`SELECT json_extract(row_json,'$.average') average FROM hardware_price_observations WHERE id='old-dirty'`).get().average,'10.00');
    assert.equal(db.pragma('user_version',{simple:true}),69);
    assert.equal(db.prepare(`SELECT name FROM schema_migrations WHERE version=68`).get().name,'article_dedup_keys');
    assert.equal(db.prepare(`SELECT name FROM schema_migrations WHERE version=69`).get().name,'hardware_price_current_spec');
    db.close();
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});
test('hardware HTTP endpoints are read-only, scoped and explicit legacy migration queues a registered job',async()=>{
  const f=fixture();const databasePath=path.join(f.directory,'test.db');
  const app=createAiCenterServer({host:'127.0.0.1',port:0,dataDirectory:f.directory,databasePath,store:f.store,feedFilter:null,hardwarePriceService:f.hardware});
  const address=await app.listen();try {
    f.hardware.ingest('local',parsed());
    await captureHardwarePrices({hardwarePriceService:f.hardware,repository:f.store.repositories.runtimeSnapshots});
    assert.equal(await app.refreshPreparedSlots(),true);
    const read=await fetch(`${address.localUrl}/api/v1/hardware-prices`);assert.equal(read.status,200);
    const json=await read.json();assert.equal(json.items.length,1);assert.equal(JSON.stringify(json).includes('artifactPath'),false);
    assert.deepEqual(json.items[0].rawCells,[]);
    assert.equal((await fetch(`${address.localUrl}/api/v1/hardware-prices?category=invalid`)).status,400);
    assert.equal((await fetch(`${address.localUrl}/api/v1/sources/content.trendforce.collection`)).status,404);
    const migrate=await fetch(`${address.localUrl}/api/v1/feed/trendforce/migrate`,{method:'POST'});assert.equal(migrate.status,202);
    const {jobId}=await migrate.json();assert.equal(f.store.getJob(jobId).type,'feed.trendforce.migrate');
  }finally{await app.close();rmSync(f.directory,{recursive:true,force:true});}
});
