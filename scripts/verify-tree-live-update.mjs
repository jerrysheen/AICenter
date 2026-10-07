import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(process.env.UIUX_RUNTIME_PACKAGE)('playwright');
const directory='.ai-data/tree-hour-2026-10-07/ui-fixture';mkdirSync(directory,{recursive:true});
// Controlled browser fixture, never news or production publish evidence.
const at=1791295200000,window={startAt:at,endAt:at+3600000};let revision=1;
const nodes=Object.fromEntries([1,2].flatMap(version=>Array.from({length:12},(_,i)=>{
  const id=`h${version}-${i}`;return [id,{id,layer:'hourly',title:`通信项目${i}：海缆连接卫星网络`,text:'这是界面版本检测测试夹具。'.repeat(8),tagId:'communications',articleIds:[`source${i}`],children:[`i${i}`],articleCount:1}];
})));
const edition=version=>({id:`edition-${version}`,window,status:'ready',roots:Array.from({length:12},(_,i)=>`h${version}-${i}`),inputIds:Array.from({length:12},(_,i)=>`i${i}`),pendingIds:[],missingHours:[],generatedAt:at+3600000+version});
const manifest=()=>({timezone:'Asia/Shanghai',pipeline:'tree-v3',directions:{communications:'tech'},hours:[{edition:edition(revision),attempt:edition(revision)}],days:[],information:[]});
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');res.setHeader('Content-Type',url.pathname.endsWith('.js') ? 'text/javascript' : 'application/json');
  if(['/brief-page.js','/information-tree.js'].includes(url.pathname))return res.end(readFileSync(`apps/web/public${url.pathname}`));
  if(url.pathname==='/styles.css'){res.setHeader('Content-Type','text/css');return res.end(readFileSync('apps/web/public/styles.css'));}
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><link rel="stylesheet" href="/styles.css"><main id="root"></main><script type="module">import{createBriefPage}from"/brief-page.js";window.page=createBriefPage({api:async path=>{const r=await fetch(path);if(!r.ok)throw Error(path);return r.json()},session:()=>({role:"desktop"}),active:()=>true});await window.page.mount(document.getElementById("root"));</script>');}
  if(url.pathname==='/api/v1/reports/tree')return res.end(JSON.stringify(manifest()));
  if(url.pathname==='/api/v1/tags')return res.end(JSON.stringify({catalog:{tags:[{id:'communications',name:'通信与网络'}]}}));
  if(url.pathname==='/api/v1/reports/tree/node')return res.end(JSON.stringify({node:nodes[url.searchParams.get('id')]}));
  if(url.pathname==='/api/v1/reports/tree/children')return res.end(JSON.stringify({children:[{id:'i0',layer:'information',title:'原始材料夹具',text:'完整信息稿夹具。',articleIds:['source0'],articleCount:1,sourceRefs:[]}]}));
  res.statusCode=404;res.end('{}');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.UIUX_BROWSER});
const checks=[];
try{
  for(const width of [390,1440]){
    revision=1;
    const context=await browser.newContext({viewport:{width,height:900},timezoneId:'UTC'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install();await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForSelector('.tree-card');
    assert.equal(await page.locator('#root').getAttribute('data-edition-id'),'edition-1');
    assert.equal(await page.getByRole('tab',{name:'科技与产业'}).getAttribute('aria-selected'),'true');
    await page.getByRole('combobox',{name:'主Tag筛选'}).selectOption('communications');await page.waitForSelector('.tree-card');
    await page.locator('.tree-ref').first().evaluate(n=>{n.open=true;});await page.waitForSelector('.tree-children .tree-card');
    await page.evaluate(()=>window.scrollTo(0,600));const before=await page.evaluate(()=>scrollY);
    revision=2;await page.clock.runFor(30001);await page.getByRole('button',{name:'接受更新'}).waitFor();
    assert.equal(await page.locator('#root').getAttribute('data-edition-id'),'edition-1');assert.equal(await page.evaluate(()=>scrollY),before);
    await page.getByRole('button',{name:'接受更新'}).evaluate(n=>n.click());await page.waitForFunction(()=>document.querySelector('#root').dataset.editionId==='edition-2' && !document.querySelector('.tree-list').textContent.includes('读取中…'));
    assert.equal(await page.getByRole('combobox',{name:'选择树刊期'}).inputValue(),String(at));assert.equal(await page.getByRole('combobox',{name:'主Tag筛选'}).inputValue(),'communications');
    assert.equal(await page.evaluate(()=>scrollY),before);assert.equal(await page.locator('.tree-ref').first().evaluate(n=>n.open),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);
    await page.screenshot({path:`${directory}/${width}.png`,fullPage:true});checks.push({width,browserTimezone:'UTC',instanceTimezone:'Asia/Shanghai',oldVersion:'edition-1',acceptedVersion:'edition-2',window:at,filter:'communications',scrollBefore:before,scrollAfter:await page.evaluate(()=>scrollY),errors});await context.close();
  }
  writeFileSync(`${directory}/result.json`,JSON.stringify({kind:'controlled-ui-fixture',checks},null,2));console.log(JSON.stringify(checks));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
