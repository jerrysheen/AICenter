import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createMediaRepository } from '../packages/database/src/repositories/media-repository.js';
import config from '../config/media.json' with { type: 'json' };
import { createStore } from '../packages/database/src/index.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
import { extractArticleText } from '../packages/connectors/src/media/article-html.js';
import { parseFeedXml } from '../packages/connectors/src/media/feed-xml.js';
import { fetchAllowlisted } from '../packages/connectors/src/media/http.js';
import { buildDailyBriefCandidates } from '../packages/domain/src/daily-brief-candidates.js';
import { createMediaEnrichJobHandlers } from '../packages/runtime/src/media-enrich-module.js';
import { createAiCenterServer } from '../apps/web/src/server.js';
import { createMediaBriefPort } from '../packages/runtime/src/media-brief-port.js';

const NOW = Date.parse('2026-10-02T06:00:00Z');
const lookupImpl = async () => [{ address: '93.184.216.34' }];
const prose = 'Synthetic company report: factory output increased; financing is a credit facility rather than recognized sales. ';
const article = number => `<article><div class="content-wrapper"><p>The API price changed by ${number} dollars per million tokens. ${prose.repeat(3)}</p><p>${prose.repeat(3)}The end of this report.</p></div></article>`;
function fixture(fetchImpl,budget = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(),'media-audit-'));
  const store = createStore(path.join(directory,'test.db'));
  let clock = NOW;
  const service = createMediaIngestionService({ mediaRepository: store.repositories.media, feedRepository: store.repositories.feed,
    mediaPort: createMediaConnector({ ...config,fetchImpl,lookupImpl }), budget, now: () => clock });
  function seed(externalId = 'decoder:1', extra = {}) {
    const sourceKey = externalId.split(':')[0];
    store.repositories.media.upsertEntry({ workspaceId: 'local',externalId,sourceKey,publisherKey: sourceKey,channel: 'tech',
      canonicalUrl: `https://the-decoder.com/${externalId.split(':')[1]}/`,title: 'API price change',summary: 'Source summary.',publishedAt: NOW,publishedAtRaw: '',
      contentLevel: 'summary_only',contentHash: 'index1',revision: 1,status: 'indexed',observedAt: NOW,createdAt: NOW,updatedAt: NOW,...extra });
    store.repositories.media.saveState({ workspaceId: 'local',sourceKey,enabled: true,hostDirectVerified: true,bodyUseAcknowledged: true,health: 'ready',updatedAt: NOW });
  }
  return { directory,store,service,seed,setClock: value => { clock = value; },close() { store.close(); rmSync(directory,{recursive:true,force:true}); } };
}

test('media index and source writes roll back when their outbox event fails', () => {
  const f = fixture(async () => new Response(article(2)));
  let database;
  try {
    f.seed();
    database = new Database(path.join(f.directory, 'test.db'));
    const failing = createMediaRepository(database, () => { throw new Error('outbox unavailable'); });
    const original = f.store.repositories.media.getEntries('local', ['decoder:1'])[0];
    const state = f.store.repositories.media.getState('local', 'decoder');
    assert.throws(() => failing.upsertEntry({ ...original, title: 'Changed', revision: 2 }), /outbox unavailable/);
    assert.deepEqual(f.store.repositories.media.getEntries('local', ['decoder:1'])[0], original);
    assert.throws(() => failing.saveState({ ...state, enabled: false }), /outbox unavailable/);
    assert.deepEqual(f.store.repositories.media.getState('local', 'decoder'), state);
  } finally { database?.close(); f.close(); }
});

const controls = [
  ['C01',`<article><h1>Synthetic report</h1><p>${prose.repeat(12)}</p></article>`,r => r.ok && r.text.includes('factory output')],
  ['D01',`<script src="recaptcha.js"></script><article><p>${prose.repeat(12)}</p></article>`,r => r.ok],
  ['D02',`<article><p>New captcha product announced. ${prose.repeat(12)}</p></article>`,r => r.ok],
  ['D03',`<div id="news-body"><p>${prose.repeat(12)}</p></div>`,r => r.ok],
  ['D04',`<article><p>Teaser</p></article><main><p>${prose.repeat(12)}</p></main>`,r => r.ok && r.text.includes('factory output')],
  ['D05',`<article><p>${'This is only a summary. '.repeat(6)}</p></article><script type="application/ld+json">${JSON.stringify({'@type':'NewsArticle',articleBody:prose.repeat(12)+'END_OF_FULL_ARTICLE'})}</script>`,r => r.ok && r.text.includes('END_OF_FULL_ARTICLE')],
  ['D06',`<article><p>Subscribe to read the rest. ${prose.repeat(12)}</p></article>`,r => !r.ok || r.contentLevel !== 'full'],
  ['D07',`<article><p>${'中'.repeat(60_000)}</p></article>`,r => Buffer.byteLength(r.text) <= 100_000 && r.contentLevel !== 'full'],
  ['D08',`<article><h1>Synthetic report</h1><p>${prose}</p><p>${prose}</p><table><tr><th>Period</th><th>Capacity</th></tr><tr><td>2026</td><td>120</td></tr></table></article>`,r => r.ok && r.text.includes('\n') && r.text.includes('2026 | 120')],
  ['C02',`<article><p>${prose.repeat(12)}</p></article>`,r => !r.ok,403],
];
for (const [id,html,good,status = 200] of controls) test(`audit counterexample ${id}`,() => assert.ok(good(extractArticleText(html,{status}))));

test('failures persist, requests stay charged, cooldown and bounded retry prevent repeated bad pages',async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return new Response('',{status:503}); });
  try {
    f.seed();
    const first = await f.service.fetchBodies({externalIds:['decoder:1']});
    assert.equal(first.health,'partial'); assert.equal(first.stats.failed,1);
    const state = f.store.repositories.media.getEntries('local',['decoder:1'])[0].fetchState;
    assert.equal(state.httpStatus,503); assert.equal(state.attemptCount,1); assert.ok(state.nextRetryAt > NOW);
    assert.equal(f.store.repositories.media.budgetDay('local','2026-10-02').bodyRequests,1);
    assert.equal(f.store.repositories.media.budgetDay('local','2026-10-02').selectedBodies,0);
    await f.service.fetchBodies({externalIds:['decoder:1']}); assert.equal(calls,1);
    for (let n=2;n<=5;n++) { const row=f.store.repositories.media.getEntries('local',['decoder:1'])[0]; f.setClock(row.fetchState.nextRetryAt); await f.service.fetchBodies({externalIds:['decoder:1']}); }
    const terminal=f.store.repositories.media.getEntries('local',['decoder:1'])[0].fetchState;
    assert.equal(terminal.attemptCount,5); assert.equal(terminal.nextRetryAt,null);
    await f.service.fetchBodies({externalIds:['decoder:1']}); assert.equal(calls,5);
  } finally { f.close(); }
});

test('mixed success and failure, input order, and independent request limit',async () => {
  const f=fixture(async url => new Response(url.endsWith('/2/') ? '' : article(2),{ status: url.endsWith('/2/') ? 403 : 200 }),{maxBodyRequestsPerDay:2});
  try {
    f.seed('decoder:1'); f.seed('decoder:2'); f.seed('decoder:3');
    const r=await f.service.fetchBodies({externalIds:['decoder:2','decoder:1','decoder:3']});
    assert.deepEqual(r.fetched.map(r=>r.externalId),['decoder:2','decoder:1','decoder:3']);
    assert.equal(r.stats.validFull,1);assert.equal(r.stats.failed,1);assert.equal(r.stats.deferred,1);assert.equal(r.stats.requests,2);
    assert.equal(f.store.repositories.media.budgetDay('local','2026-10-02').selectedBodies,1);
  } finally { f.close(); }
});

test('saved acknowledgement controls automated reads',async () => {
  let calls=0;
  const f=fixture(async () => {calls++;return new Response(article(2));});
  try {
    f.seed();const current=f.store.repositories.media.getState('local','decoder');
    f.store.repositories.media.saveState({...current,bodyUseAcknowledged:false});
    const r=await f.service.fetchBodies({externalIds:['decoder:1']});assert.equal(r.stats.policySkipped,1);assert.equal(calls,0);
    f.service.acknowledgeBodyUse('local',['decoder']);
    await f.service.fetchBodies({externalIds:['decoder:1']});assert.equal(calls,1);
  } finally { f.close(); }
});

test('revision snapshots are immutable, old full repair is explicit, briefs and conditional requests follow body versions',async () => {
  let number=2,headers;
  const f=fixture(async (_url,request) => {headers=request.headers;return new Response(article(number),{headers:{etag:`"v${number}"`}});});
  try {
    f.seed(); await f.service.fetchBodies({externalIds:['decoder:1']});
    const first=f.store.repositories.media.listSnapshots('local','decoder:1')[0];
    await f.service.generateBodyBriefs({externalIds:['decoder:1'],briefPort:{ async generate({paragraphs}) {return {text:'根据公司公开说明，接口价格发生了变化。这是本期新增的信息，所述资金属于信贷额度而不是已经确认的销售收入。需要结合正文中的期间和单位理解数字，避免把融资误读为收入。报告还说明了工厂产出的变化及相关背景。本提要仅复述已经保存的原文材料，不推断价格未来走势，也不把公司的表述改写为独立核实的结论。原文结尾继续提供了报告背景，后续应关注新的正式披露。',evidence:[{paragraphId:paragraphs[0].id,quote:'The API price changed by 2 dollars per million tokens.'}]};} }});
    const content=f.store.repositories.feed.listContentItems('local',{limit:10})[0];
    const brief=f.service.briefForContentItem('local',content.id);assert.ok(brief);
    const pool=buildDailyBriefCandidates({reportDate:'2026-10-02',content:{news:[{...content,eventAt:NOW,generatedBrief:brief}]}});
    assert.equal(pool.candidates[0].summary,brief.text);assert.equal(pool.candidates[0].data.bodyHash,first.bodyHash);
    const row=f.store.repositories.media.getEntries('local',['decoder:1'])[0];
    f.store.repositories.media.upsertEntry({...row,revision:2});assert.equal(f.service.briefForContentItem('local',content.id),null);
    number=3;await f.service.fetchBodies({externalIds:['decoder:1']});assert.equal(headers['If-None-Match'],'"v2"');
    const snapshots=f.store.repositories.media.listSnapshots('local','decoder:1');assert.equal(snapshots.length,2);assert.deepEqual(snapshots[0],{...first,brief});
    assert.notEqual(snapshots[0].bodyHash,snapshots[1].bodyHash);assert.equal(f.service.briefForContentItem('local',content.id),null);
    assert.equal(f.store.repositories.media.budgetDay('local','2026-10-02').selectedBodies,1);
    const current=f.store.repositories.media.getEntries('local',['decoder:1'])[0];
    f.store.repositories.media.saveFetchState('local','decoder:1',{...current.fetchState,extractorVersion:'legacy'});
    assert.equal(f.service.readFeed({channel:'tech'}).items[0].contentLevel,'partial');
    await f.service.fetchBodies({externalIds:['decoder:1'],repair:true});assert.equal(headers['If-None-Match'],undefined);
  } finally {f.close();}
});

test('RSS content is a candidate, previews are not full, and full feed content avoids HTTP',async () => {
  const source=config.sources.find(s=>s.sourceKey==='decoder');
  const xml=`<rss><channel><item><title>Price</title><link>https://the-decoder.com/1/</link><guid>1</guid><description>preview</description><content:encoded><![CDATA[${article(2)}]]></content:encoded></item></channel></rss>`;
  const parsed=parseFeedXml(xml,source);assert.match(parsed.items[0].feedBodyHtml,/content-wrapper/);
  let calls=0;const f=fixture(async()=>{calls++;return new Response(article(2));});
  try {f.seed(); f.store.repositories.media.saveFeedBody('local','decoder:1',parsed.items[0].feedBodyHtml);const r=await f.service.fetchBodies({externalIds:['decoder:1']});assert.equal(r.stats.validFull,1);assert.equal(calls,0);assert.equal(r.stats.requests,0);}finally{f.close();}
});

test('streamed HTTP stops at byte limit and article Accept is HTML',async()=> {
  let accept;
  const result=await fetchAllowlisted({url:'https://the-decoder.com/1/',allowedHosts:['the-decoder.com'],kind:'article'},{lookupImpl,maxBytes:30,fetchImpl:async(_url,options)=> {accept=options.headers.Accept;return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(31));c.close();}}));}});
  assert.equal(result.health,'oversized');assert.match(accept,/text\/html/);
});

test('site fixture shapes exclude recommendations, subscription chrome, and preserve safe tables',()=> {
  const directory=new URL('./fixtures/media/',import.meta.url);
  for (const source of ['dcd','nextplatform','decoder','fed']) {
    const html=readFileSync(new URL(`${source}.html`,directory),'utf8');
    const result=extractArticleText(html,{sourceKey:source});assert.equal(result.contentLevel,'full',source);
    assert.match(result.text,/ORIGINAL_START/);assert.match(result.text,/ORIGINAL_END/);assert.doesNotMatch(result.text,/RECOMMENDED_RESIDUE|SUBSCRIPTION_RESIDUE/);
  }
});

test('partial repair keeps previous full and later full takes a new immutable revision',async()=> {
  let mode=0;
  const f=fixture(async()=>new Response(mode===1 ? `<article><p>${prose.repeat(3)}</p></article>` : article(mode===0 ? 2 : 3)));
  try {
    f.seed();await f.service.fetchBodies({externalIds:['decoder:1']});
    const first=f.store.repositories.media.latestBodies('local',['decoder:1'])[0];
    mode=1;await f.service.fetchBodies({externalIds:['decoder:1'],repair:true});
    assert.equal(f.store.repositories.media.latestBodies('local',['decoder:1'])[0].bodyHash,first.bodyHash);
    assert.equal(f.service.readFeed({channel:'tech'}).items[0].contentLevel,'partial');
    mode=2;await f.service.fetchBodies({externalIds:['decoder:1'],repair:true});
    const snapshots=f.store.repositories.media.listSnapshots('local','decoder:1');
    assert.deepEqual(snapshots.map(s=>s.revision),[1,2,3]);assert.equal(snapshots[0].bodyHash,first.bodyHash);
    assert.equal(f.service.readFeed({channel:'tech'}).items[0].contentLevel,'full');
  }finally{f.close();}
});

test('304 refresh keeps a snapshot and false model evidence is persisted as failure',async()=> {
  let modified=true;
  const f=fixture(async()=>modified ? new Response(article(2),{headers:{etag:'"v2"'}}) : new Response(null,{status:304}));
  try {
    f.seed();await f.service.fetchBodies({externalIds:['decoder:1']});
    const row=f.store.repositories.media.getEntries('local',['decoder:1'])[0];
    f.store.repositories.media.upsertEntry({...row,revision:2});modified=false;
    const result=await f.service.fetchBodies({externalIds:['decoder:1']});assert.equal(result.stats.requests,1);
    assert.equal(f.store.repositories.media.listSnapshots('local','decoder:1').length,1);
    const briefs=await f.service.generateBodyBriefs({externalIds:['decoder:1'],briefPort:{generate:async()=>({text:'仅依据公开正文核对变化，不把模型生成的内容当作已经核实的事实。'.repeat(6),evidence:[{paragraphId:'p0001',quote:'Invented data'}]})}});
    assert.equal(briefs[0].status,'failed');assert.match(briefs[0].reason,/evidence/);
    const feed=f.service.readFeed({channel:'tech'});assert.equal(feed.items[0].generatedBrief,null);assert.equal(feed.items[0].briefState.status,'failed');
  }finally{f.close();}
});

test('headline localization cannot hide all failed bodies in job health',async()=> {
  const f=fixture(async()=>new Response('',{status:403}));
  try {
    f.seed();
    const handlers=createMediaEnrichJobHandlers({mediaService:f.service,feedService:{localizeTexts:async()=>({pendingIds:[]})},taggingService:{analyzeItems:async()=>({saved:[],missingItemIds:[]})}});
    const result=await handlers['media.index.enrich']({externalIds:['decoder:1']});
    assert.equal(result.health,'partial');assert.equal(result.bodyStats.failed,1);assert.equal(result.bodiesFetched,0);
  }finally{f.close();}
});

test('media API reads stored body, paginates counts and queues all network work',async()=> {
  let calls=0;
  const f=fixture(async()=>{calls++;return new Response(article(2));});
  const directory=mkdtempSync(path.join(os.tmpdir(),'media-api-'));
  const app=createAiCenterServer({host:'127.0.0.1',port:0,dataDirectory:directory,mediaService:f.service});
  try {
    f.seed();f.seed('decoder:2',{title:'Second price change'});await f.service.fetchBodies({externalIds:['decoder:1']});
    const address=await app.listen();
    const before=calls;
    const read=await fetch(`${address.localUrl}/api/v1/feed?platform=media&channel=tech&view=full&limit=1`).then(r=>r.json());
    assert.equal(read.feed.counts.full,1);assert.equal(read.feed.total,1);assert.match(read.feed.items[0].body,/2 dollars/);
    const refresh=await fetch(`${address.localUrl}/api/v1/feed?platform=media&channel=tech&refresh=1`).then(r=>r.json());
    assert.ok(refresh.jobId);
    const response=await fetch(`${address.localUrl}/api/v1/feed/media/bodies`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({externalIds:['decoder:2']})});
    assert.equal(response.status,202);assert.equal(calls,before);
    const invalid=await fetch(`${address.localUrl}/api/v1/feed/media/bodies`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"repair":true}'});
    assert.equal(invalid.status,400);
  }finally{await app.close();f.close();rmSync(directory,{recursive:true,force:true});}
});

test('shared Harness brief port corrects invalid format once and keeps a closed bounded task',async()=> {
  const calls=[];
  const port=createMediaBriefPort({run:async input=>{calls.push(input);return {answer:JSON.stringify({text:calls.length===1 ? '超长文本'.repeat(100) : '仅依据公开正文核对变化，不把模型生成的内容当作已经核实的事实。'.repeat(6),evidenceIds:['p0001.1']})};}});
  const result=await port.generate({title:'Report',paragraphs:[{id:'p0001',text:'Saved evidence'}]});
  assert.equal(calls.length,2);assert.ok(result.text.length>=150&&result.text.length<=300);
  assert.deepEqual(result.evidence,[{paragraphId:'p0001',quote:'Saved evidence'}]);
  assert.equal(calls[0].closedContext,true);assert.equal(calls[0].webMode,'off');assert.equal(calls[0].timeoutMs,180_000);
  assert.match(calls[1].message,/correction/);
});

test('reader projection exposes evidence and never calls old or truncated body complete',async()=> {
  const source=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  const functionSource=source.slice(source.indexOf('function mediaAsItem('),source.indexOf('\nfunction renderMediaToolbar('));
  const project=new Function('formatTime',`${functionSource};return mediaAsItem;`)(()=> 'date');
  const f=fixture(async()=>new Response(article(2)));
  try {
    f.seed();await f.service.fetchBodies({externalIds:['decoder:1']});
    const item=f.service.readFeed({channel:'tech'}).items[0];
    assert.equal(project(item).complete,true);assert.equal(project(item).body,item.body);
    assert.equal(project({...item,contentLevel:'partial',truncated:true}).complete,false);
    assert.match(project({...item,fetchState:{...item.fetchState,extractionReason:'paywall'}}).processing,/付费/);
    const brief={text:'saved summary',evidence:[{paragraphId:'p0001',quote:'saved quote'}]};
    assert.deepEqual(project({...item,generatedBrief:brief}).generatedBrief,brief);
  }finally{f.close();}
});

test('challenge page is blocked and official speaker metadata survives DOM extraction',()=> {
  assert.notEqual(extractArticleText('<div class="content-wrapper"><p>Short summary.</p><p>Updates later.</p></div>',{sourceKey:'decoder'}).contentLevel,'full');
  assert.equal(extractArticleText('<title>Just a moment</title><form id="captcha-challenge">Verify you are human</form>').reason,'blocked');
  const result=extractArticleText(`<div id="article"><p class="article__time">October 1, 2026</p><p class="speaker">Governor Example</p><div class="col-xs-12 col-sm-8 col-md-8"><p>${prose.repeat(3)}</p><p>${prose.repeat(3)}</p></div></div>`,{sourceKey:'fed'});
  assert.equal(result.author,'Governor Example');assert.equal(result.publishedAtRaw,'October 1, 2026');assert.equal(result.contentLevel,'full');
});
