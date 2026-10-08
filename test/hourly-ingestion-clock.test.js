import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../packages/database/src/index.js';
import {createTreeMaterialPort} from '../packages/domain/src/information-tree-materials.js';
import {createInformationTreeService} from '../packages/domain/src/information-tree-service.js';
import {loadInformationTreeSkills} from '../packages/runtime/src/information-tree/skills.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const H=3600000,start=10*H;

test('late social posts use first ingestion for tree candidates, cursor and material, preserving publication',async t=>{
  const store=createStore(':memory:');try {
    const repo=store.repositories.feed,items=[];let at=start+1;
    t.mock.method(Date,'now',()=>at);
    for(let i=0;i<2;i++) {
      at=start+i+1;
      const capture=repo.saveCapture({workspaceId:'local',provider:'x',externalId:String(i),contentHash:String(i)});
      const item=repo.saveContentItem({workspaceId:'local',captureId:capture.id,originType:'import',contentType:'post',title:'旧文新收录',body:'厂商计划下一季度交付。',publishedAt:1});
      items.push(repo.getContentItem('local',item.id));
    }
    const window={startAt:start,endAt:start+H};
    assert.equal(repo.listContentItemsInWindow('local',window).length,0);
    const first=repo.listContentItemsInWindow('local',{...window,timeBasis:'ingested',metadataOnly:true,limit:1});
    const second=repo.listContentItemsInWindow('local',{...window,timeBasis:'ingested',metadataOnly:true,cursor:{eventAt:first[0].eventAt,id:first[0].id.slice(5)}});
    assert.equal(first[0].eventAt,start+1);assert.equal(second.length,1);assert.notEqual(first[0].id,second[0].id);
    const port=createTreeMaterialPort({feedService:{listContentItemsInWindow:(w,q)=>repo.listContentItemsInWindow(w,q),listTaggableItems:()=>items,getContentItem:(w,id)=>repo.getContentItem(w,id)}});
    assert.equal((await port.candidates('local',window)).length,2);
    const materials=await port.materials('local',items.map(i=>`feed:${i.id}`));
    assert.ok(materials.every(m=>m.publishedAt===1 && m.eventAt>=start && m.eventAt<start+H));
  }finally{t.mock.restoreAll();store.close();}
});

test('media repeated discovery preserves first ingestion; publication and observed time cannot move its hour',()=>{
  const store=createStore(':memory:');try {
    const repo=store.repositories.media,entry={workspaceId:'local',externalId:'test:one',sourceKey:'test',publisherKey:'test',channel:'tech',canonicalUrl:'https://example.com/one',title:'旧文章',contentLevel:'summary_only',contentHash:'hash',revision:1,status:'ready',publishedAt:1,observedAt:start+1,createdAt:start+1,updatedAt:start+1};
    repo.upsertEntry(entry);repo.upsertEntry({...entry,createdAt:start+2*H,observedAt:start+2*H,updatedAt:start+2*H});
    const rows=repo.informationCandidates('local',{startAt:start,endAt:start+H,extractorVersion:'fixture'});
    assert.equal(rows.length,1);assert.equal(rows[0].eventAt,start+1);
    assert.equal(repo.informationCandidates('local',{startAt:start+2*H,endAt:start+3*H,extractorVersion:'fixture'}).length,0);
  }finally{store.close();}
});

test('regrouping reuses completed prose, creates immutable node and preserves old edition references',async()=>{
  const store=createStore(':memory:');try {
    let calls=0;
    const runtime={async run(input){calls++;const p=JSON.parse(input.message);return {answer:JSON.stringify(input.usageStage==='tree-information'?{title:'计划交付',text:'厂商计划下季度交付。',tagId:null}:{modules:[{title:'交付计划',text:'厂商计划下季度交付。',tagId:null,inputIds:p.inputs.map(n=>n.id)}]})};}};
    const service=createInformationTreeService({repository:store.repositories.informationTree,reportRepository:store.repositories.report,agentRuntime:runtime,skills:loadInformationTreeSkills()});
    const material={id:'feed:late',title:'交付计划',publishedAt:start+1,contentLevel:'full',paragraphs:[{role:'body',text:'厂商计划下季度交付。'}],sourceRefs:[]};
    const old=await service.generateHour({hourStart:start,materials:[material]}),before=calls;
    const oldNode=service.children('local',old.roots[0])[0];
    const moved=await service.prepareInformation({materials:[{...material,eventAt:start+H+1}]});
    assert.equal(calls,before);assert.notEqual(moved.nodes[0].id,oldNode.id);
    assert.equal(moved.nodes[0].window.startAt,start+H);assert.equal(moved.nodes[0].eventAt,start+H+1);
    assert.deepEqual(service.children('local',old.roots[0])[0],oldNode);
    assert.equal(store.repositories.informationTree.listInformation('local',{startAt:start+H,endAt:start+2*H}).length,1);
  }finally{store.close();}
});

test('social lists render and finish loading while supplementary tag reads remain pending',async()=>{
  const source=readFileSync('apps/web/public/app.js','utf8');
  for(const name of ['loadXFeed','loadXueqiuFeed']) {
    let rendered=0;
    const context=vm.createContext({URLSearchParams,state:{session:{},xFeed:'for-you',xueqiuFeed:'home'},api:async()=>({feed:{items:[{id:'saved'}]}}),isHiddenFeedItem:()=>false,hydrateFeedTranslations:()=>{},renderPosts:()=>{rendered++;},renderXToolbar:()=>{},renderXueqiuToolbar:()=>{},syncLocalTranslationsToServer:()=>new Promise(()=>{}),loadFeedTaggings:()=>new Promise(()=>{}),translateXBatch:async()=>{}});
    const fn=source.match(new RegExp('async function '+name+'\\([^]*?\\n\\}'))[0];
    vm.runInContext(fn+`;this.load=${name}`,context);
    await context.load({autoTranslate:false});
    assert.ok(rendered>=2);assert.equal(context.state[name==='loadXFeed'?'xLoading':'xueqiuLoading'],false);
    assert.equal(context.state[name==='loadXFeed'?'xItems':'xueqiuItems'].length,1);
  }
});

test('normal hour upgrades a cached head from candidate metadata without preparing original again',async()=>{
  const store=createStore(':memory:');try {
    let informationCalls=0;
    const runtime={async run(input){const p=JSON.parse(input.message);if(input.usageStage==='tree-information')informationCalls++;return {answer:JSON.stringify(input.usageStage==='tree-information'?{title:'原稿',text:'厂商计划交付。',tagId:null}:{modules:[{title:'交付',text:'厂商计划交付。',tagId:null,inputIds:p.inputs.map(n=>n.id)}]})};}};
    const options={repository:store.repositories.informationTree,reportRepository:store.repositories.report,agentRuntime:runtime,skills:loadInformationTreeSkills()};
    const old=createInformationTreeService(options),material={id:'feed:late',version:'1',title:'原稿',publishedAt:start+1,contentLevel:'full',paragraphs:[{role:'body',text:'厂商计划交付。'}],sourceRefs:[]};
    await old.prepareInformation({materials:[material]});
    const next=createInformationTreeService({...options,candidatePort:async()=>[{id:material.id,version:'1',eventAt:start+H+1}],materialPort:()=>{throw Error('normal report must not reread original');}});
    const edition=await next.generateHour({hourStart:start+H});
    assert.equal(edition.status,'ready');assert.equal(edition.inputIds.length,1);assert.equal(informationCalls,1);
    assert.equal(next.children('local',edition.roots[0])[0].eventAt,start+H+1);
  }finally{store.close();}
});
