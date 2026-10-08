import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const arg=name=>process.argv[process.argv.indexOf(name)+1];
const url=process.argv.includes('--url') ? arg('--url') : 'http://127.0.0.1:8791';
if(!process.env.UIUX_RUNTIME_PACKAGE || !process.env.UIUX_BROWSER)throw new Error('Set bundled UIUX_RUNTIME_PACKAGE and UIUX_BROWSER for headless DOM verification');
const require=createRequire(process.env.UIUX_RUNTIME_PACKAGE),{chromium}=require('playwright');
const directory=path.resolve(process.argv.includes('--output') ? arg('--output') : '.ai-data/tree-replay/ui');mkdirSync(directory,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.UIUX_BROWSER});
const checks=[],errors=[],requests=[];
try {
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/v1/'))requests.push({method:r.method(),path:new URL(r.url()).pathname});});
  await page.goto(`${url}/#report`);
  await page.waitForFunction(()=>document.querySelector('.tree-page') || [...document.querySelectorAll('button')].some(n=>n.textContent==='三层浓缩树'));
  // Legacy hosts retain the explicit button; enabled instances enter the tree directly.
  if(!await page.locator('.tree-page').count())await page.getByRole('button',{name:'三层浓缩树',exact:true}).evaluate(n=>n.click());
  await page.waitForFunction(()=>document.querySelector('.tree-card'));
  for(const width of [320,375,390,502,699,700,768,1024,1199,1200,1366,1440,1920]) {
    await page.setViewportSize({width,height:900});
    for(const mode of (process.argv.includes('--hours-only') ? ['小时报'] : ['日报','小时报'])) {
      await page.getByRole('tab',{name:mode,exact:true}).evaluate(n=>n.click());
      // Direction is a display filter; choose a nonempty direction before testing ref traversal.
      for(const direction of ['金融与市场','时事与政策','科技与产业','其他']) {
        if(await page.locator('.tree-card').count())break;
        await page.getByRole('tab',{name:direction,exact:true}).evaluate(n=>n.click());
        await page.waitForFunction(()=>!document.querySelector('.tree-list')?.textContent.includes('读取中…'));
      }
      await page.waitForFunction(()=>document.querySelector('.tree-card') && !document.querySelector('.tree-list')?.textContent.includes('读取中…'));
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false,`${width}/${mode} overflow`);
      const blanks=await page.locator('.tree-text').evaluateAll(nodes=>nodes.some(n=>!n.textContent.trim()));assert.equal(blanks,false);
      if(mode!=='本期材料') {
        assert.equal(await page.locator('.tree-card').evaluateAll(nodes=>nodes.filter(n=>n.dataset.layer!=='information').some(n=>[...n.children].filter(c=>c.matches('.tree-ref')).length!==1)),false);
        await page.locator('.tree-ref').first().evaluate(n=>{n.open=true;});
        await page.waitForFunction(()=>document.querySelector('.tree-children .tree-card'));
        if(mode==='日报') {
          const children=page.locator('.tree-children .tree-ref');assert.ok(await children.count());
          await children.first().evaluate(n=>{n.open=true;});
          await page.waitForFunction(()=>document.querySelector('.tree-children .tree-children .tree-card'));
        }
      }
      if([390,1440].includes(width))await page.screenshot({path:path.join(directory,`${mode}-${width}.png`),fullPage:true});
      checks.push({width,mode,overflow,blank:false});
    }
  }
  await page.getByRole('button',{name:'本期材料',exact:true}).evaluate(n=>n.click());
  await page.waitForFunction(()=>document.querySelector('.tree-card') || document.querySelector('.tree-list')?.textContent.includes('本期没有'));
  await page.getByRole('button',{name:'Tag',exact:true}).click();
  const tag=page.getByRole('combobox',{name:'主Tag筛选'}),options=await tag.locator('option').count();
  if(options>1) {
    await tag.evaluate(n=>{n.selectedIndex=1;n.dispatchEvent(new Event('change'));});
    await page.waitForFunction(()=>document.querySelector('.tree-card') && !document.querySelector('.tree-list')?.textContent.includes('读取中…'));
  }
  let sourceReadAndReturn=false;
  const original=page.locator('.tree-card').getByRole('button',{name:'原文',exact:true}).first();
  if(await original.count()) {
    const before=await page.locator('.tree-card').first().getAttribute('data-node-id');
    await original.evaluate(n=>n.click());
    await page.waitForFunction(()=>document.body.dataset.reader==='1');
    await page.locator('#nav-back').evaluate(n=>n.click());
    await page.waitForFunction(()=>document.body.dataset.view==='report' && document.querySelector('.tree-card'));
    assert.equal(await page.locator('.tree-card').first().getAttribute('data-node-id'),before);
    sourceReadAndReturn=true;
  }
  assert.deepEqual(errors,[]);assert.equal(requests.filter(r=>r.path.startsWith('/api/v1/reports/tree') && r.method!=='GET').length,0);
  writeFileSync(path.join(directory,'checks.json'),JSON.stringify({realLocalService:true,checks,errors,treeReadOnly:true,sourceReadAndReturn},null,2));
  console.log(JSON.stringify({checks:checks.length,errors,output:path.relative(process.cwd(),directory)}));
} finally {await browser.close();}
