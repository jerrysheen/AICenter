import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config/media.json' with { type:'json' };
import { MediaConfigSchema } from '../packages/contracts/src/media.js';
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';
import { createStore } from '../packages/database/src/index.js';

const keys=['bbctech','bbcscience','guardianai','guardianenergy','guardianmanufacturing','guardiantrade','eia','utilitydive','thelec'];
const prose='A synthetic report explains capacity constraints, construction plans and the costs of connecting new facilities. '.repeat(4).trim();
const bbcHtml=`<link rel="canonical" href="https://www.bbc.com/news/articles/shared"><main><article><p class="ssrcss-Paragraph">${prose}</p><p class="ssrcss-Paragraph">Final source evidence.</p><p class="ssrcss-Paragraph">Follow BBC for newsletter updates</p><div class="related"><p>${prose.repeat(4)}</p></div></article></main>`;
const port=createMediaConnector(config);

test('expanded Instance catalog is bounded and old configurations remain compatible',()=>{
  assert.equal(MediaConfigSchema.parse(config).sources.length,42);
  assert.equal(MediaConfigSchema.parse({version:1,sources:[]}).budget.maxActiveSources,6);
  assert.equal(MediaConfigSchema.safeParse({...config,budget:{...config.budget,maxActiveSources:16}}).success,true);
  assert.equal(MediaConfigSchema.safeParse({...config,budget:{...config.budget,maxActiveSources:25}}).success,false);
  assert.equal(MediaConfigSchema.safeParse({...config,sources:[...config.sources,{...config.sources[0],sourceKey:'extra'}]}).success,false);
  for(const key of keys){const source=config.sources.find(s=>s.sourceKey===key);assert.ok(source);assert.equal(source.transport,'rss');assert.equal(source.contentAccess,'body');assert.equal(source.enabled,false);assert.equal(source.deployment,'first');}
  const elec=config.sources.find(s=>s.sourceKey==='thelec');
  assert.deepEqual(elec.allowedHosts,['cdn.thelec.net']);assert.deepEqual(elec.articleHosts,['www.thelec.net']);
});

test('BBC new source keys inherit publisher body boundaries and reject video/live templates',()=>{
  for(const sourceKey of ['bbc','bbcworld','bbctech','bbcscience']){
    const article=port.extract(bbcHtml,{sourceKey});assert.equal(article.contentLevel,'full');
    assert.deepEqual(article.paragraphs.map(p=>p.text),[prose,'Final source evidence.']);
    assert.equal(port.extract(bbcHtml,{sourceKey,title:'Watch: source video'}).reason,'non_article');
    assert.equal(port.extract(bbcHtml.replace('/news/articles/shared','/news/live/shared'),{sourceKey}).reason,'live_template_unverified');
  }
});

test('Guardian body excludes newsletter, callout and larger main recommendations; special pages never become full',()=>{
  const html=`<link rel="canonical" href="https://www.theguardian.com/business/2026/oct/05/sample"><main><div class="article-body-commercial-selector article-body-viewer-selector"><p>${prose}</p><figure data-spacefinder-type="model.NewsletterSignupBlockElement"><p>Newsletter promotion.</p></figure><aside><p>Sidebar.</p></aside><figure data-spacefinder-type="model.CalloutBlockElement"><p>Send us your opinion.</p></figure><p>Final evidence.</p></div><section><h2>Most viewed</h2><p>${prose.repeat(10)}</p></section></main>`;
  const a=port.extract(html,{sourceKey:'guardianmanufacturing'});assert.equal(a.contentLevel,'full');assert.deepEqual(a.paragraphs.map(p=>p.text),[prose,'Final evidence.']);
  assert.equal(port.extract(html.replace('/business/2026/','/business/live/2026/'),{sourceKey:'guardiantrade'}).reason,'live_template_unverified');
  assert.equal(port.extract(html.replace('/business/2026/','/news/video/2026/'),{sourceKey:'guardianenergy'}).reason,'non_article');
  assert.equal(port.extract('<main><p>'+prose+'</p></main>',{sourceKey:'guardianai'}).reason,'unsupported_template');
});

test('EIA and THE ELEC use narrow article bodies and preserve evidence metadata',()=>{
  const eia=`<div class="tie-article"><span class="date">October 2, 2026</span><h1>Capacity report</h1><img src="chart.svg" alt="Capacity estimates"><div class="source">Data source: survey</div><p>${prose}</p><table><tr><th>Year</th><th>Capacity</th></tr><tr><td>2026</td><td>100</td></tr></table><p>Principal contributor: Test Author</p><div class="do-not-print"><p>Tags: navigation</p></div></div>`;
  const a=port.extract(eia,{sourceKey:'eia'});assert.equal(a.contentLevel,'full');assert.equal(a.author,'Test Author');assert.equal(a.publishedAtRaw,'October 2, 2026');assert.ok(a.paragraphs.some(p=>p.kind==='table'));assert.doesNotMatch(a.text,/Tags: navigation/);assert.match(a.text,/Data source: survey/);assert.equal(a.visualEvidenceRequired,true);
  const elec=`<meta name="author" content="Test Reporter"><article id="article-view-content-div"><p>${prose}</p><p>Final evidence.</p></article><article class="article-writer"><p>Author links</p></article>`;
  const b=port.extract(elec,{sourceKey:'thelec'});assert.equal(b.contentLevel,'full');assert.equal(b.author,'Test Reporter');assert.equal(b.paragraphs.length,2);
  assert.equal(port.extract('<article><p>'+prose+'</p></article>',{sourceKey:'thelec'}).reason,'unsupported_template');
  assert.equal(port.extract(elec+'<div class="paywall">Subscribe to read</div>',{sourceKey:'thelec'}).reason,'paywall');
});

test('new BBC channels reuse one article and keep discoveries, full body and reading state after Service recreation',async()=>{
  const sources=config.sources.filter(s=>['bbctech','bbcscience'].includes(s.sourceKey));
  const store=createStore(':memory:');let requests=0;
  const connector=createMediaConnector({sources,budget:config.budget,lookupImpl:async()=>[{address:'93.184.216.34'}],fetchImpl:async url=>{
    if(String(url).includes('rss.xml'))return new Response('<rss><channel><item><title>Capacity report</title><link>https://www.bbc.com/news/articles/shared?at_campaign=rss#0</link></item></channel></rss>');
    requests++;return new Response(bbcHtml);
  }});
  const makeService=()=>createMediaIngestionService({mediaRepository:store.repositories.media,feedRepository:store.repositories.feed,mediaPort:connector});
  try{
    let service=makeService();const probe=await service.probe({sourceKeys:sources.map(s=>s.sourceKey),policyReviewed:true,run:true});assert.ok(probe.results.every(r=>r.health==='ready'));
    for(const source of sources)assert.equal(service.enableSource('local',source.sourceKey).ok,true);
    service.acknowledgeBodyUse('local',sources.map(s=>s.sourceKey));await service.syncEnabled({force:true});
    assert.equal(store.repositories.media.listEntries('local').length,1);
    const ids=service.listBodyCandidates('local');assert.equal(ids.length,1);
    assert.equal((await service.fetchBodies({externalIds:ids})).stats.validFull,1);assert.equal(requests,1);
    const feed=service.readFeed({channel:'tech'});assert.equal(feed.items.length,1);assert.equal(feed.items[0].publisherKey,'bbc');
    assert.deepEqual(new Set(feed.items[0].discoveryChannels.map(d=>d.sourceKey)),new Set(['bbctech','bbcscience']));
    store.repositories.feed.upsertUserItemState({workspaceId:'local',contentItemId:feed.items[0].contentItemId,isRead:true});
    service=makeService();await service.syncEnabled({force:true});assert.equal(service.readFeed({channel:'tech'}).items[0].isRead,true);assert.equal(service.listBodyCandidates('local').length,0);assert.equal(requests,1);
  }finally{store.close();}
});

test('active source expansion is still enforced by Service including discovery publishers',()=>{
  const sources=Array.from({length:25},(_,i)=>({...config.sources[0],sourceKey:'source'+i}));
  const store=createStore(':memory:');
  try{
    const service=createMediaIngestionService({mediaRepository:store.repositories.media,mediaPort:createMediaConnector({sources,budget:{maxActiveSources:24},discoveryPublishers:[{sourceKey:'original',publisher:'Original',articleHosts:['example.org'],pathPrefixes:['/']} ]})});
    for(const source of sources)store.repositories.media.saveState({workspaceId:'local',sourceKey:source.sourceKey,enabled:false,hostDirectVerified:true,health:'ready',updatedAt:Date.now()});
    store.repositories.media.saveState({workspaceId:'local',sourceKey:'original',enabled:true,health:'ready',updatedAt:Date.now()});
    for(const source of sources.slice(0,23))assert.equal(service.enableSource('local',source.sourceKey).ok,true);
    assert.deepEqual(service.enableSource('local',sources[23].sourceKey),{ok:false,health:'budget_deferred'});
  }finally{store.close();}
});
