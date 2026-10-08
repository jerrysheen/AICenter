import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const arg=(name,fallback)=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:fallback;
const base=arg('--url','http://127.0.0.1:8787'),targetId=arg('--node-id'),output=path.resolve(arg('--output','.ai-data/tree-ref-resume'));
if(!targetId || !process.env.UIUX_RUNTIME_PACKAGE || !process.env.UIUX_BROWSER)throw new Error('Set --node-id, UIUX_RUNTIME_PACKAGE and UIUX_BROWSER');
const {chromium}=createRequire(process.env.UIUX_RUNTIME_PACKAGE)('playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.UIUX_BROWSER});mkdirSync(output,{recursive:true});
const result={checks:[],errors:[],requests:[]};
try{
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:844}});
    page.on('pageerror',e=>result.errors.push(e.message));
    page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/v1/reports/'))result.requests.push({method:r.method(),path:new URL(r.url()).pathname});});
    await page.route('**/api/v1/**',r=>r.request().method()==='GET'?r.continue():r.abort());
    const chooseTarget=async()=>{
      await page.goto(`${base}/#report`);await page.locator('.tree-card').first().waitFor();
      const edition=await page.evaluate(async id=>{const endAt=Date.now(),m=await(await fetch(`/api/v1/reports/tree?view=reading&startAt=${endAt-7*86400000}&endAt=${endAt}`)).json();return m.hours.find(r=>r.edition?.roots.includes(id))?.edition;},targetId);
      assert.ok(edition,'target must be in a published edition');
      await page.getByRole('tab',{name:'小时报',exact:true}).click();
      await page.getByRole('button',{name:'往期',exact:true}).click();
      await page.getByRole('combobox',{name:'选择往期'}).selectOption(String(edition.window.startAt));
      await page.getByRole('tab',{name:'金融与市场',exact:true}).click();
      const target=page.locator(`[data-node-id="${targetId}"]`);await target.waitFor();return target;
    };
    let target=await chooseTarget();
    const other=page.locator(`.tree-list > .tree-card[data-layer="hourly"]:not([data-node-id="${targetId}"])`).first();
    await other.locator(':scope > details > summary').click();await other.locator('.tree-children .tree-card').first().waitFor();
    await other.locator('.tree-children .tree-card').first().getByRole('button',{name:'原文',exact:true}).click();
    await page.waitForFunction(()=>document.body.dataset.reader==='1');await page.locator('#nav-back').evaluate(n=>n.click());await target.waitFor();
    await target.locator(':scope > details > summary').click();await target.locator('.tree-children .tree-card').first().waitFor({timeout:5000});
    result.checks.push({width,scenario:'read source, return, expand another ref',children:await target.locator('.tree-children > .tree-card').count()});
    await target.locator(':scope > details > summary').click();
    await page.waitForFunction(id=>!document.querySelector(`[data-node-id="${id}"] > details`).open,targetId);
    // Re-render fresh handlers with the same cached content, then pause/resume the page.
    await page.getByRole('tab',{name:'金融与市场',exact:true}).click();await target.waitFor();
    const visibility=()=>page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
    await visibility();await target.locator(':scope > details > summary').click();await target.locator('.tree-children .tree-card').first().waitFor({timeout:5000});
    result.checks.push({width,scenario:'background and resume cached ref',children:await target.locator('.tree-children > .tree-card').count()});
    await page.reload();target=await chooseTarget();
    await page.route('**/api/v1/reports/tree/children?*',async r=>{await new Promise(resolve=>setTimeout(resolve,500));await r.continue();});
    const requested=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/v1/reports/tree/children');
    await target.locator(':scope > details > summary').click();await requested;await visibility();
    await target.locator('.tree-children .tree-card').first().waitFor({timeout:5000});
    result.checks.push({width,scenario:'background while ref request is pending',children:await target.locator('.tree-children > .tree-card').count()});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:path.join(output,`ref-${width}.png`),fullPage:true});await page.close();
  }
  assert.deepEqual(result.errors,[]);assert.ok(result.requests.every(r=>r.method==='GET'));
  writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({checks:result.checks,errors:result.errors}));
}finally{await browser.close();}
