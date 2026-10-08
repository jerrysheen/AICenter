import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const arg=(name,fallback)=>process.argv.includes(name) ? process.argv[process.argv.indexOf(name)+1] : fallback;
const base=arg('--url','http://127.0.0.1:8787'),output=path.resolve(arg('--output','.ai-data/brief-navigation'));
if(!process.env.UIUX_RUNTIME_PACKAGE || !process.env.UIUX_BROWSER)throw new Error('Set UIUX_RUNTIME_PACKAGE and UIUX_BROWSER for headless verification');
const {chromium}=createRequire(process.env.UIUX_RUNTIME_PACKAGE)('playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.UIUX_BROWSER});
mkdirSync(output,{recursive:true});
const result={realService:true,checks:[],errors:[],requests:[]};
try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(()=>{
    window.briefToasts=[];
    document.addEventListener('DOMContentLoaded',()=>{const toast=document.getElementById('toast');if(toast)new MutationObserver(()=>{if(toast.textContent)window.briefToasts.push(toast.textContent);}).observe(toast,{childList:true,subtree:true});});
  });
  page.on('pageerror',e=>result.errors.push(e.message));
  page.on('request',r=>{const u=new URL(r.url());if(u.pathname.startsWith('/api/v1/reports/'))result.requests.push({method:r.method(),path:u.pathname});});
  // Authoring checks must not enqueue generation or any other business write.
  await page.route('**/api/v1/**',route=>route.request().method()==='GET' ? route.continue() : route.abort());
  const ready=()=>page.waitForFunction(()=>document.querySelector('.tree-card') && !document.querySelector('.tree-list')?.textContent.includes('读取中…'));
  const click=name=>page.getByRole('button',{name,exact:true}).evaluate(n=>n.click());
  await page.goto(`${base}/#report`);await ready();
  const edition=await page.locator('.tree-page').getAttribute('data-edition-id');
  const initialRequests=result.requests.length;
  await click('往期');await page.getByRole('button',{name:'旧版存档',exact:true}).waitFor();await ready();
  assert.equal(new URL(page.url()).hash,'#report');
  const period=page.getByRole('combobox',{name:'选择往期'});
  const available=await period.locator('option').evaluateAll(nodes=>nodes.map(n=>n.value));
  if(available.length>1){await period.selectOption(available[1]);await ready();assert.equal(await page.locator('.tree-page').getAttribute('data-window-start'),available[1]);}
  await click('旧版存档');await page.getByRole('button',{name:'返回历史简报',exact:true}).waitFor();
  assert.equal(new URL(page.url()).hash,'#report/archive');
  assert.match(await page.locator('#report-list').textContent(),/旧版存档（停止更新）/);
  await click('返回历史简报');await page.getByRole('button',{name:'返回最新简报',exact:true}).waitFor();await ready();
  await click('返回最新简报');await page.getByRole('button',{name:'往期',exact:true}).waitFor();await ready();
  assert.equal(new URL(page.url()).hash,'#report');assert.equal(await page.locator('.tree-page').getAttribute('data-edition-id'),edition);
  assert.equal(result.requests.filter(r=>r.path==='/api/v1/reports/tree').length,1,'warm navigation should reuse the manifest');
  assert.equal(result.requests.filter(r=>r.path==='/api/v1/reports/tree/node').length,0,'edition reading should be batched');
  result.checks.push({navigation:'current/history/archive/history/current',initialRequests});
  await page.goBack();await page.getByRole('button',{name:'返回最新简报',exact:true}).waitFor();await ready();
  assert.equal(new URL(page.url()).hash,'#report/history');
  for(const width of [390,1440]) {
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:path.join(output,`history-${width}.png`),fullPage:true});
    result.checks.push({width,overflow:false});
  }
  result.toasts=await page.evaluate(()=>window.briefToasts);
  assert.ok(result.toasts.every(message=>! /Cannot|undefined|Error|读取失败/.test(message)),JSON.stringify(result.toasts));
  assert.deepEqual(result.errors,[]);assert.ok(result.requests.every(r=>r.method==='GET'));
  writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({checks:result.checks,errors:result.errors,reportRequests:result.requests.length}));
}finally{await browser.close();}
