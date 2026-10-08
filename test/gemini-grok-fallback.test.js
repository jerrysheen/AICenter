import test from 'node:test';
import assert from 'node:assert/strict';
import {createTranslateService as createService} from '../packages/connectors/src/translate/index.js';
import {createGeminiGrokTaskRouter} from '../packages/connectors/src/gemini-grok-task.js';
// Legacy shared router is still used by tagging; production translation uses Gemma only.
const createTranslateService = options => createService({...options, router:createGeminiGrokTaskRouter(options)});
import {createGeminiTagPort} from '../packages/connectors/src/gemini-tag.js';
import {geminiQuotaCooldown,nextGeminiDailyReset} from '../packages/connectors/src/gemini-grok-task.js';
import {parseTagBatchOutput} from '../packages/domain/src/tag-parser.js';

const NOW=Date.parse('2026-10-04T14:00:00Z');
const quota=(details=[],message='Quota exceeded')=>new Response(JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',message,details}}),{status:429});
const gemini=reply=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:reply}]}}]}));
const grok=reply=>new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:reply}]}]}));
const settings=()=>({geminiApiKey:'gemini-test',elucidApiKey:'elucid-test',elucidApiRoot:'https://elucid.test/v1',quotaState:new Map(),now:()=>NOW});

test('Gemini batch quota exhaustion uses one Grok batch and caches its translations',async()=>{
 const calls=[];const service=createTranslateService({...settings(),authKey:'unused-deepl-key',async fetch(url,init){
  calls.push(String(url));
  if(!String(url).endsWith('/responses'))return quota([{violations:[{quotaId:'GenerateRequestsPerModelPerDay'}]}]);
  assert.equal(init.headers.Authorization,'Bearer elucid-test');
  const request=JSON.parse(init.body);assert.equal(request.model,'grok-4.7');assert.deepEqual(request.tools,[]);
  const items=JSON.parse(request.input[0].content);assert.equal(items.length,2);
  return grok(JSON.stringify(items.map(i=>({id:i.id,translated:'正文译文：'+i.id}))));
 }});
 const items=[{id:'a',text:'A business announced a factory expansion.'},{id:'b',text:'Another business announced a new product.'}];
 const result=await service.translateMany({items});assert.deepEqual(result.translations.map(r=>r.engine),['elucid-grok','elucid-grok']);
 assert.deepEqual(result.translations.map(r=>r.id),['a','b']);assert.equal(calls.length,2);
 const repeat=await service.translateMany({items});assert.ok(repeat.translations.every(r=>r.cached));assert.equal(calls.length,2);
});

test('translation quota knowledge is shared with tagging, cooldown expires back to Gemini',async()=>{
 const options=settings();let at=NOW;options.now=()=>at;const calls=[];
 options.fetch=async(url,init)=>{
  calls.push(String(url));
  if(String(url).endsWith('/responses'))return grok(JSON.parse(init.body).instructions.includes('catalog')?' {"items":[{"item_id":"a","tags":["macro","invented"]}]}':'测试译文');
  return calls.length===1?quota([{retryDelay:'12s'}]):gemini('{"items":[{"item_id":"a","tags":["macro"]}]}');
 };
 await createTranslateService(options).translate({text:'A business opened another factory.'});
 const tag=createGeminiTagPort({...options,apiKey:options.geminiApiKey});
 const output=await tag.tagBatch({systemPrompt:'Use only catalog tags',userPayload:{items:[{item_id:'a',text:'Economic news'}]}});
 assert.equal(output.model,'elucid-grok');assert.equal(calls.length,3);assert.ok(calls[2].endsWith('/responses'));
 const parsed=parseTagBatchOutput(output.reply_text,{itemIds:['a'],catalogIds:['macro'],maxTags:4});
 assert.deepEqual(parsed.accepted[0].tags,['macro']);assert.ok(parsed.unknownTags.some(row=>row.tagId==='invented'));
 at+=12001;assert.equal((await tag.tagBatch({})).model,'gemini');assert.equal(calls.length,4);
});

test('daily quota ignores short retry hints and resumes at midnight Pacific across DST',()=>{
 for(const [at,reset] of [['2026-10-04T14:00:00Z','2026-10-05T07:00:00Z'],['2026-12-04T14:00:00Z','2026-12-05T08:00:00Z'],['2026-11-01T07:30:00Z','2026-11-02T08:00:00Z']]) {
  const time=Date.parse(at);assert.equal(nextGeminiDailyReset(time),Date.parse(reset));
  const cooldown=geminiQuotaCooldown({status:429},{error:{details:[{violations:[{quotaId:'GenerateContentInputTokensPerModelPerDay-FreeTier'}]},{retryDelay:'3s'}]}},time);
  assert.equal(cooldown.reason,'daily_quota');assert.equal(cooldown.blockedUntil,Date.parse(reset));
 }
});

test('short quota uses Retry-After or RetryInfo and unknown 429 has bounded cooldown',()=>{
 assert.equal(geminiQuotaCooldown({status:429,headers:new Headers({'retry-after':'120'})},{error:{details:[{retryDelay:'44s'}]}},NOW).blockedUntil,NOW+120000);
 assert.equal(geminiQuotaCooldown({status:429,headers:new Headers({'retry-after':new Date(NOW+180000).toUTCString()})},{},NOW).blockedUntil,NOW+180000);
 assert.equal(geminiQuotaCooldown({status:429},{},NOW).blockedUntil,NOW+60000);
 assert.equal(geminiQuotaCooldown({status:403},{error:{status:'PERMISSION_DENIED'}},NOW),null);
});

test('quota state does not mix different Gemini credentials or models',async()=>{
 const options=settings();let geminiCalls=0;
 options.fetch=async url=>String(url).endsWith('/responses')?grok('测试译文'):(++geminiCalls,geminiCalls===1?quota():gemini('测试译文'));
 await createTranslateService(options).translate({text:'First business expands factory capacity.'});
 await createTranslateService({...options,geminiApiKey:'different-key'}).translate({text:'Second business expands factory capacity.'});
 await createTranslateService({...options,geminiModel:'different-model'}).translate({text:'Third business expands factory capacity.'});
 assert.equal(geminiCalls,3);
});

test('quota failure without an Elucid key is explicit and cannot call removed providers',async()=>{
 let calls=0;const service=createTranslateService({...settings(),elucidApiKey:'',authKey:'ignored',fetch:async()=>{calls++;return quota();}});
 await assert.rejects(service.translate({text:'Business demand grows this year.'}),/ELUCID_GROK_API_KEY/);
 await assert.rejects(service.translate({text:'Another business grows this year.'}),/ELUCID_GROK_API_KEY/);assert.equal(calls,1);
});

test('permission failures are not misclassified as quota and Grok failures propagate',async()=>{
 let calls=0;const service=createTranslateService({...settings(),fetch:async()=>{calls++;return new Response('{}',{status:403});}});
 await assert.rejects(service.translate({text:'Business demand grows this year.'}),/403/);assert.equal(calls,1);
 const unavailable=createTranslateService({...settings(),fetch:async url=>String(url).endsWith('/responses')?new Response('{}',{status:503}):quota()});
 await assert.rejects(unavailable.translateMany({items:[{id:'a',text:'Business demand grows this year.'}]}),/503/);
});

test('Grok batch must return matching IDs, incomplete output only translates missing items',async()=>{
 const options=settings();let calls=0;
 const incomplete=createTranslateService({...options,geminiApiKey:'',fetch:async()=>++calls===1?grok('[{"id":"a","translated":"甲译文"}]'):grok('乙译文')});
 const result=await incomplete.translateMany({items:[{id:'a',text:'First report describes business activity.'},{id:'b',text:'Second report describes business activity.'}]});
 assert.deepEqual(result.translations.map(r=>r.translatedText),['甲译文','乙译文']);assert.equal(calls,2);
 const invalid=createTranslateService({...settings(),geminiApiKey:'',fetch:async()=>grok('[{"id":"wrong","translated":"错译文"}]')});
 await assert.rejects(invalid.translateMany({items:[{id:'a',text:'First report describes business activity.'}]}),/有效项目/);
});
