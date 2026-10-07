import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(process.env.UIUX_RUNTIME_PACKAGE),{chromium}=require('playwright');
const dir=path.resolve(process.argv[2]),browser=await chromium.launch({headless:true,executablePath:process.env.UIUX_BROWSER});
try{const page=await browser.newPage(),checks=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(path.join(dir,'preview.html')).href);
 for(const width of [390,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.locator('article').count(),6+JSON.parse(fs.readFileSync(path.join(dir,'results.json'),'utf8')).stability.length);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('article details:last-child').evaluateAll(ns=>ns.some(n=>n.open)),false);await page.screenshot({path:path.join(dir,`preview-${width}.png`),fullPage:true});checks.push({width,overflow:false,articles:6,originalCollapsed:true});}
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(dir,'ui-check.json'),JSON.stringify(checks,null,2));
}finally{await browser.close();}
