import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createXLikeBrowserPort,buildXLikeExpression} from '../packages/connectors/src/x/like-browser.js';
import {LikeResultSchema} from '../packages/contracts/src/feed-interaction.js';
import {nextAutoLikeSettings} from '../packages/domain/src/x-focus.js';
const state=status=>({status,accountHandle:'reader',checkedAt:1});
function fixture({readErrors=0,clickError=false,error=()=>Object.assign(Error('The media source changed; synchronize and replan'),{details:{kind:'refused'}})}={}) {
  let reads=0,clicks=0,navigations=0;
  const options=[];
  const port=createXLikeBrowserPort({delay:async()=>{},browserRuntime:{withSession:async(_,run)=>run({
    navigate:async()=>{navigations++;},
    evaluate:async(expression,opts)=>{
      options.push(opts);
      if(expression.includes(', true,')){clicks++;if(clickError)throw error();return state('unconfirmed');}
      if(reads++<readErrors)throw error();
      return state(clicks?'already-liked':'unconfirmed');
    },
  })}});
  return {port,counts:()=>({reads,clicks,navigations}),options};
}
test('like recovers bounded read-only page changes and verifies a single persisted click',async()=>{
  const f=fixture({readErrors:2});
  assert.equal((await f.port.like('123')).status,'liked');
  assert.equal(f.counts().clicks,1);assert.equal(f.counts().navigations,2);
  assert.ok(f.options.every(x=>x.dependsOn[0]==='a[data-testid="AppTabBar_Profile_Link"]'));
  assert.ok(f.options.every(x=>x.timeoutMs===30000));
});
test('persistent read failure stays unavailable with a sanitized reason',async()=>{
  const f=fixture({readErrors:100});const result=await f.port.like('123');
  assert.equal(result.status,'unavailable');assert.equal(result.reason,'page-changed');
  assert.equal(f.counts().reads,3);assert.equal(f.counts().clicks,0);
  const bad=fixture({readErrors:100,error:()=>Error('secret browser id and command text')});
  assert.equal((await bad.port.probe('123')).reason,'browser-error');
  assert.equal(bad.counts().reads,1);
});
test('uncertain writes are never retried and preserve the verified account',async()=>{
  const f=fixture({clickError:true});const result=await f.port.like('123');
  assert.equal(result.status,'unconfirmed');assert.equal(result.accountHandle,'reader');
  assert.equal(result.reason,'page-changed');assert.equal(f.counts().clicks,1);
});
test('timeout before a click recovers but never exceeds three reads',async()=>{
  const f=fixture({readErrors:100,error:()=>Object.assign(Error('bsk timed out'),{details:{kind:'timeout'}})});
  const result=await f.port.like('123');assert.equal(result.reason,'browser-timeout');
  assert.equal(f.counts().reads,3);assert.equal(f.counts().clicks,0);
});
test('navigation content-script startup recovers reads but genuine permission errors do not retry',async()=>{
  const warming=fixture({readErrors:2,error:()=>Object.assign(Error('Could not establish connection. Receiving end does not exist.'),{details:{code:'permission_denied'}})});
  assert.equal((await warming.port.like('123')).status,'liked');assert.equal(warming.counts().clicks,1);
  const denied=fixture({readErrors:100,error:()=>Object.assign(Error('Permission denied'),{details:{code:'permission_denied'}})});
  assert.equal((await denied.port.like('123')).reason,'browser-error');assert.equal(denied.counts().reads,1);assert.equal(denied.counts().clicks,0);
});
test('post-click read timeout and an explicitly undispatched settling read recover without a second click',async()=>{
  let clicked=false,failures=0,clicks=0;
  const port=createXLikeBrowserPort({delay:async()=>{},browserRuntime:{withSession:async(_,run)=>run({navigate:async()=>{},evaluate:async expression=>{
    if(expression.includes(', true,')){clicked=true;clicks++;return state('unconfirmed');}
    if(!clicked)return state('unconfirmed');
    if(failures++===0)throw Object.assign(Error('bsk timed out'),{details:{kind:'timeout'}});
    if(failures===2)throw Error('Previous operation is still settling; this action was not dispatched');
    return state('already-liked');
  }})}});
  assert.equal((await port.like('123')).status,'liked');assert.equal(clicks,1);
});
test('account shell failure differs from unavailable buttons without bypassing account checks',()=>{
  const run=({profile=true,switcher=true,expectedAccount=''}={})=>vm.runInNewContext(buildXLikeExpression('123',{click:true,expectedAccount}),{
    location:{origin:'https://x.com',pathname:'/reader/status/123'},Date,
    document:{querySelector:s=>s==='a[data-testid="AppTabBar_Profile_Link"]'?(profile?{getAttribute:()=>'/reader'}:null):s==='[data-testid="SideNav_AccountSwitcher_Button"]'?(switcher?{}:null):null,querySelectorAll:()=>[]},
  });
  assert.equal(run({profile:false}).reason,'account-not-ready');
  assert.equal(run({switcher:false}).accountHandle,'reader');
  assert.equal(run({expectedAccount:'other'}).status,'blocked');
});
test('three failures retain the safety stop and report the correct class',()=>{
  let settings={pageEnabled:true};
  for(let i=0;i<3;i++)settings=nextAutoLikeSettings(settings,'unavailable','browser-timeout');
  assert.equal(settings.suspended,true);assert.equal(settings.pageEnabled,false);
  assert.match(settings.notice,/浏览器操作超时/);
  assert.equal(LikeResultSchema.safeParse({...state('unavailable'),reason:'secret command'}).success,false);
});

test('live expression clicks only the exact original post and keeps repeated likes idempotent',()=>{
  let clicks=0;
  const article=(id,{liked=false,disabled=false}={})=>({
    querySelector:()=>({closest:()=>({getAttribute:()=>`/author/status/${id}`})}),
    querySelectorAll:selector=>selector==='button[data-testid="unlike"]'?(liked?[{}]:[]):selector==='button[data-testid="like"]'?[{disabled,getAttribute:()=>null,click:()=>clicks++}]:[],
  });
  const run=articles=>vm.runInNewContext(buildXLikeExpression('123',{click:true,expectedAccount:'reader'}),{
    location:{origin:'https://x.com',pathname:'/author/status/123'},Date,
    document:{
      querySelector:s=>s==='a[data-testid="AppTabBar_Profile_Link"]'?{getAttribute:()=>'/reader'}:s==='[data-testid="SideNav_AccountSwitcher_Button"]'?{}:null,
      querySelectorAll:s=>s==='article[data-testid="tweet"]'?articles:[],
    },
  });
  assert.equal(run([article('999'),article('123')]).status,'unconfirmed');assert.equal(clicks,1);
  assert.equal(run([article('123',{liked:true})]).status,'already-liked');assert.equal(clicks,1);
  assert.equal(run([article('999')]).status,'not-found');assert.equal(clicks,1);
  assert.equal(run([article('123'),article('123')]).status,'not-found');assert.equal(clicks,1);
  assert.equal(run([article('123',{disabled:true})]).reason,'button-unavailable');assert.equal(clicks,1);
});
