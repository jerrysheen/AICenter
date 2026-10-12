import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../packages/database/src/index.js';
import {createInformationTreeService,packTreeInputs} from '../packages/domain/src/information-tree-service.js';
import {validateTreeModules} from '../packages/contracts/src/information-tree.js';
import {loadInformationTreeSkills} from '../packages/runtime/src/information-tree/skills.js';
import {mediaTranslationUnits} from '../packages/domain/src/media-translation.js';
import {createFeedService} from '../packages/domain/src/feed-service.js';
const H=3600000,start=10*H;
const material=(id,text=`原文内容 ${id}：厂商计划下季度交付，当前仅部分用户测试。`)=>({id,title:`标题 ${id}`,author:'作者',publisher:'来源',publishedAt:start+1,contentLevel:'full',paragraphs:[{role:'body',text}],sourceRefs:[]});
function fixture(budget={}) {
  const store=createStore(':memory:'),calls=[];
  const runtime={async run(input) {
    calls.push(input);const p=JSON.parse(input.message);
    if(input.usageStage==='tree-information')return {answer:JSON.stringify({title:p.source.title,text:p.source.paragraphs.map(p=>p.text).join('').slice(0,160),tagId:null})};
    return {answer:JSON.stringify({modules:[{title:'未分类进展',text:'厂商计划交付，目前仍在测试。',tagId:null,inputIds:p.inputs.map(n=>n.id)}]})};
  }};
  return {store,calls,runtime,service:createInformationTreeService({repository:store.repositories.informationTree,reportRepository:store.repositories.report,agentRuntime:runtime,skills:loadInformationTreeSkills(),budget,sleep:async()=>{}})};
}
test('whole-input ownership rejects omissions, duplicate parents and invented IDs',()=>{
  const inputs=[{id:'a'},{id:'b'}],module={title:'类',text:'主体计划交付。',tagId:null,inputIds:['a','b']};
  assert.equal(validateTreeModules({modules:[module]},inputs,new Set()).modules.length,1);
  for(const ids of [['a'],['a','b','a'],['a','unknown']])assert.throws(()=>validateTreeModules({modules:[{...module,inputIds:ids}]},inputs,new Set()));
  assert.throws(()=>validateTreeModules({modules:[module,module]},inputs,new Set()));
});

test('explicit hourly resume retries transient failures only; automatic and quota waits remain intact',async()=>{
 for(const quota of [false,true]) {
  const f=fixture();let attempts=0;
  try {
   const original=f.runtime.run;
   f.runtime.run=async input=>{
    if(input.usageStage==='tree-hourly') {
      attempts++;
      if(quota && attempts===1) throw Object.assign(new Error('429 quota'),{code:'budget-deferred',retryAt:Date.now()+60000});
      if(!quota && attempts<=4) throw Object.assign(new Error('503 unavailable'),{upstreamStatus:503});
    }
    return original(input);
   };
   const first=await f.service.generateHour({hourStart:start,materials:[material('a'),material('b')]});
   assert.equal(first.status,'failed');assert.equal(attempts,quota?1:4);
   await f.service.generateHour({hourStart:start});assert.equal(attempts,quota?1:4);
   const resumed=(await f.service.generateHourlyDigests({hourStart:start,mode:'resume'}))[0];
   assert.equal(attempts,quota?1:5);assert.equal(resumed.status,quota?'failed':'ready');
  }finally{f.store.close();}
 }
});

test('reading manifest omits article prose and edition batches only immutable roots in its workspace',async()=>{
  const f=fixture();try {
    const edition=await f.service.generateHour({hourStart:start,materials:[material('a'),material('b')]});
    const window={startAt:start,endAt:start+H};
    const full=f.service.list('local',window),reading=f.service.list('local',{...window,view:'reading'});
    assert.ok(full.information[0].text);
    assert.equal(reading.information[0].text,undefined);
    assert.equal(reading.information[0].title,undefined);
    assert.deepEqual(reading.hours,full.hours);
    assert.deepEqual(reading.information.map(n=>n.id),full.information.map(n=>n.id));
    const batch=f.service.edition('local',edition.id);
    assert.deepEqual(batch.nodes.map(n=>n.id),edition.roots);
    assert.ok(batch.nodes.every(n=>n.layer==='hourly' && n.articleCount>0));
    assert.equal(f.service.edition('other',edition.id),null);
    assert.equal(f.service.edition('local','missing'),null);
  }finally{f.store.close();}
});
test('bounded repair tells the model the concrete ownership failure',async()=>{
  const f=fixture();try {
    const original=f.runtime.run;let attempts=0,repair;
    f.runtime.run=async input=>{
      if(input.usageStage!=='tree-hourly')return original(input);
      const p=JSON.parse(input.message);attempts++;
      if(attempts===1)return {answer:JSON.stringify({modules:[{title:'错误引用',text:'计划仍待实现。',tagId:null,inputIds:['unknown']}]})};
      repair=p.correction;return original(input);
    };
    const h=await f.service.generateHour({hourStart:start,materials:[material('a'),material('b')]});
    assert.equal(h.status,'ready');assert.equal(attempts,2);assert.match(repair,/unknown|未知|输入/);
  }finally{f.store.close();}
});
test('explicit needs_content is negatively cached until source changes; prose identifier is valid',async()=>{
  const f=fixture();try {
    let calls=0;f.runtime.run=async()=>{calls++;return {answer:JSON.stringify({status:'needs_content'})};};
    const m=material('missing'),first=await f.service.prepareInformation({materials:[m]});
    assert.equal(first.pending[0].reason,'needs-content');assert.equal(calls,1);
    await f.service.prepareInformation({materials:[m]});assert.equal(calls,1);
    f.runtime.run=async()=>{calls++;return {answer:JSON.stringify({id:'harmless',title:'教程',text:'协议用 needs_content 表示缺正文。',tagId:null})};};
    const changed=await f.service.prepareInformation({materials:[{...m,paragraphs:[{role:'body',text:'新版教程正文'}],version:'2'}]});
    assert.equal(changed.nodes.length,1);assert.equal(calls,2);assert.match(changed.nodes[0].text,/needs_content/);
  }finally{f.store.close();}
});
test('one source one short node, direct projections, frozen refs and incremental reuse',async()=>{
  const f=fixture();try {
    const h=await f.service.generateHour({hourStart:start,materials:[material('a'),material('b')]});assert.equal(h.status,'ready');
    assert.equal(f.calls.filter(c=>c.usageStage==='tree-information').length,2);
    const oldChildren=f.service.children('local',h.roots[0]);assert.equal(oldChildren.length,2);
    assert.equal(f.calls[2].message.includes('paragraphs'),false);
    await f.service.generateHour({hourStart:start,materials:[material('b'),material('a')]});assert.equal(f.calls.length,3);
    const newer=await f.service.generateHour({hourStart:start,materials:[material('a'),material('b'),material('late')]});assert.equal(f.calls.length,5);
    assert.deepEqual(f.service.children('local',h.roots[0]),oldChildren);
    const h2=await f.service.generateHour({hourStart:start+H,materials:[{...material('c'),publishedAt:start+H+1}]});
    const daily=await f.service.generateDaily({window:{startAt:start,endAt:start+2*H},hours:[newer,h2]});assert.equal(daily.status,'ready');
    const direct=f.service.children('local',daily.roots[0]);assert.ok(direct.every(n=>n.layer==='hourly'));assert.equal(direct.length,2);
    assert.ok(f.calls.at(-1).message.includes('paragraphs')===false);assert.equal(f.service.node('local',daily.roots[0]).articleCount,4);
  }finally{f.store.close();}
});
test('aborted output cannot complete; missing bodies and hours remain explicit; sparse failures preserve publication',async()=>{
  const f=fixture();try {
    const good=await f.service.generateHour({hourStart:start,materials:[material('good')]});
    f.runtime.run=async()=>{throw Object.assign(new Error('aborted'),{name:'AbortError'});};
    const failed=await f.service.generateHour({hourStart:start,materials:[material('changed')]});assert.notEqual(failed.status,'ready');assert.equal(failed.published,false);
    assert.equal(f.service.list('local',{startAt:start,endAt:start+H}).hours[0].edition.id,good.id);
    const daily=await f.service.generateDaily({window:{startAt:start,endAt:start+2*H},hours:[good]});assert.ok(daily.missingHours.includes(start+H));
    const missing=await f.service.generateHour({hourStart:start+H,materials:[{...material('missing'),contentLevel:'discovery'}]});assert.equal(missing.status,'partial');assert.deepEqual(missing.pendingIds,['missing']);
  }finally{f.store.close();}
});
test('database lease isolates workers and workspaces',()=>{
  const f=fixture();try{const r=f.store.repositories.informationTree;assert.equal(r.acquire('local','key','one',100),true);assert.equal(r.acquire('local','key','two',200),false);assert.equal(r.acquire('other','key','two',200),true);assert.equal(r.acquire('local','key','two',200000),true);assert.throws(()=>r.renew('local','key','one',200001));}finally{f.store.close();}
});
test('oversized single paragraph is fully processed internally and yields one information node',async()=>{
  const f=fixture();try {
    const text='完整长文🙂保留计划状态。'.repeat(1800),h=await f.service.generateHour({hourStart:start,materials:[material('long',text)]});
    assert.equal(h.status,'ready');assert.equal(h.inputIds.length,1);
    const bodies=f.calls.filter(c=>c.usageStage==='tree-information').flatMap(c=>JSON.parse(c.message).source.paragraphs).filter(p=>p.role==='body');
    assert.ok(bodies.length>1);assert.equal(bodies.map(p=>p.text).join(''),text);
    assert.equal(f.service.node('local',h.inputIds[0]).articleIds.length,1);
  }finally{f.store.close();}
});
test('translation reuses unchanged non-adjacent blocks while changed context invalidates neighboring blocks',()=>{
  const article={externalId:'article',bodyHash:'old',title:'Report',paragraphs:Array.from({length:5},(_,i)=>({id:`p${i}`,kind:'paragraph',text:`English paragraph ${i}.`}))};
  const before=mediaTranslationUnits(article),next=mediaTranslationUnits({...article,bodyHash:'new',paragraphs:article.paragraphs.map((p,i)=>i===4 ? {...p,text:'New information at the end.'} : p)});
  assert.equal(before[1].id,next[1].id);assert.equal(before[2].id,next[2].id);assert.notEqual(before[4].id,next[4].id);
  assert.notEqual(before[5].id,next[5].id);assert.notEqual(before[1].legacyId,next[1].legacyId);
});
test('invalid Tag cannot block valid information; non-integral boundaries use saved information only',async()=>{
  const f=fixture();try {
    const original=f.runtime.run;f.runtime.run=async input=>{const result=await original(input);if(input.usageStage==='tree-information'){const output=JSON.parse(result.answer);output.tagId='nonexistent';return {answer:JSON.stringify(output)};}return result;};
    const first=await f.service.generateHour({hourStart:start,materials:[{...material('early'),eventAt:start+1000},{...material('late'),eventAt:start+H-1000}]});
    const second=await f.service.generateHour({hourStart:start+H,materials:[{...material('second'),eventAt:start+H+1000}]});
    const infoCalls=f.calls.filter(c=>c.usageStage==='tree-information').length;
    const day=await f.service.generateDaily({window:{startAt:start+H/2,endAt:start+H+H/2},hours:[first,second]});
    assert.equal(day.status,'ready');assert.equal(f.calls.filter(c=>c.usageStage==='tree-information').length,infoCalls);
    assert.equal(f.service.node('local',day.roots[0]).articleCount,2);assert.ok(f.service.children('local',day.roots[0]).every(n=>n.layer==='hourly'));
  }finally{f.store.close();}
});
test('1000 synthetic items batch and flatten without dropping or creating another visible layer',async()=>{
  const f=fixture({batchBytes:3500,maxCalls:2000,totalMs:60000});try {
    const materials=Array.from({length:1000},(_,i)=>material(`stress-${i}`));
    const h=await f.service.generateHour({hourStart:start,materials});assert.equal(h.status,'ready');
    const children=h.roots.flatMap(id=>f.service.children('local',id));assert.equal(children.length,1000);assert.equal(new Set(children.map(n=>n.sourceId)).size,1000);
    assert.ok(children.every(n=>n.layer==='information'));
    assert.throws(()=>packTreeInputs([{text:'x'.repeat(100)}],50));
  }finally{f.store.close();}
});
test('adding to one Tag preserves the other cached module; source corrections cannot publish older content',async()=>{
  const f=fixture();try {
    const runtime={async run(input){const p=JSON.parse(input.message);f.calls.push(input);return {answer:JSON.stringify(input.usageStage==='tree-information' ? {title:p.source.title,text:'厂商计划交付，仍在测试。',tagId:p.source.title.includes('b') ? 'B':'A'} : {modules:[{title:p.tagName,text:'厂商计划交付。',tagId:p.tagId,inputIds:p.inputs.map(i=>i.id)}]})};}};
    const service=createInformationTreeService({repository:f.store.repositories.informationTree,reportRepository:f.store.repositories.report,agentRuntime:runtime,skills:loadInformationTreeSkills(),catalog:{tags:[{id:'A',name:'分类A'},{id:'B',name:'分类B'}]}});
    const old=await service.generateHour({hourStart:start,materials:[{...material('a'),updatedAt:100},{...material('b'),updatedAt:100}]});
    const b=old.roots.map(id=>service.node('local',id)).find(n=>n.tagId==='B');
    const updated=await service.generateHour({hourStart:start,materials:[{...material('a','更正后的原文'),updatedAt:200},{...material('b'),updatedAt:100},material('new')]});
    assert.ok(updated.roots.includes(b.id));
    const stale=await service.generateHour({hourStart:start,materials:[{...material('a'),updatedAt:100},{...material('b'),updatedAt:100},material('new')]});assert.equal(stale.published,false);
  }finally{f.store.close();}
});
test('translation persists each successful batch and retries only missing units beyond the old thirty-item quota',async()=>{
  const f=fixture();try {
    let batches=0;const submitted=[];
    const port={async translateMany({items}){submitted.push(items.map(i=>i.id));if(++batches===2)throw new Error('provider interrupted');return {translations:items.map(i=>({id:i.id,translatedText:'保存的中文译文',engine:'test'}))};}};
    const feed=createFeedService({legacyRepository:{},feedRepository:f.store.repositories.feed,sourcePort:{read:async()=>{}},translationPort:port});
    const units=Array.from({length:60},(_,i)=>({id:`unit${i}`,localizationId:`unit${i}`,text:'English paragraph with some context. '.repeat(60)}));
    const first=await feed.localizeTexts(units,{workspaceId:'local'});assert.ok(first.pendingIds.length>0 && first.pendingIds.length<60);
    const completed=submitted[0];
    const next=await feed.localizeTexts(units,{workspaceId:'local'});assert.equal(next.pendingIds.length,0);assert.ok(submitted.at(-1).every(id=>!completed.includes(id)));
  }finally{f.store.close();}
});
test('late Tag completion updates classification without regenerating the saved draft',async()=>{
  const f=fixture();try {
    let assigned;
    const service=createInformationTreeService({repository:f.store.repositories.informationTree,reportRepository:f.store.repositories.report,agentRuntime:f.runtime,skills:loadInformationTreeSkills(),catalog:{tags:[{id:'A',name:'分类A'}]},primaryTag:()=>assigned});
    const old=await service.generateHour({hourStart:start,materials:[material('a')]});const before=f.calls.filter(c=>c.usageStage==='tree-information').length;
    assigned={locked:true,tagId:'A'};const next=await service.generateHour({hourStart:start,materials:[material('a')]});
    assert.equal(f.calls.filter(c=>c.usageStage==='tree-information').length,before);assert.equal(service.children('local',next.roots[0])[0].tagId,'A');
    assert.equal(service.children('local',old.roots[0])[0].tagId,null);assert.equal(service.children('local',old.roots[0])[0].text,service.children('local',next.roots[0])[0].text);
  }finally{f.store.close();}
});
