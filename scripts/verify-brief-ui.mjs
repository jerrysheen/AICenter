import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createStaticFileHandler} from '../apps/web/src/http/static-files.js';
import {assembleBriefEditorial} from '../packages/domain/src/information-digest-service.js';
import {briefDate,briefDayWindow} from '../apps/web/public/brief-page.js';

if (!process.env.UIUX_RUNTIME_PACKAGE || !process.env.UIUX_BROWSER) throw Error('Set UIUX_RUNTIME_PACKAGE and UIUX_BROWSER to the Host bundled runtime and Chromium.');
const require=createRequire(process.env.UIUX_RUNTIME_PACKAGE),{chromium}=require('playwright');
const serve=createStaticFileHandler(fileURLToPath(new URL('../apps/web/public',import.meta.url)));
const output=new URL('../.ai-data/brief-ui-probe/',import.meta.url);await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if (url.pathname==='/app.js') {res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile(new URL('../apps/web/public/app.js',import.meta.url),'utf8')+'\nwindow.briefProbe={controller:briefPage,state,setView,showUnpairedPage};');return;}
  if (url.pathname==='/api/v1/ui/revision') {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({revision:await serve.getUiRevision()}));return;}
  if (url.pathname==='/api/v1/events/stream') {res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': fixture\n\n');return;}
  if (!await serve(url.pathname,req,res)) {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.UIUX_BROWSER});
const errors=[],requests=[];
const today=briefDate(Date.now(),'Asia/Shanghai'),window=briefDayWindow(today,'Asia/Shanghai');
const start=window.startAt+2*3600000;
const item=(id,snapshot='h1')=>({id,sentence:`合成信息 ${id}：作者自报试验方法与结果，目前仅部分测试者使用，结论尚未独立验证。`,evidence:[{snapshotId:snapshot,materialId:'source1',paragraphId:'p1',materialHash:'a'.repeat(64),materialVersion:'1'},{snapshotId:snapshot,materialId:'source1',paragraphId:'p2',materialHash:'a'.repeat(64),materialVersion:'1'}],occurredAt:start+1000,processedAt:start+3600000,supersedes:[]});
const editorial=items=>{
  const finance=items.slice(0,Math.ceil(items.length/2)),tech=items.slice(finance.length);
  const dir=(key,label,rows)=>({key,label,articleTitle:`${label}：试验方法与交付边界`,lead:{text:rows[0].sentence,itemIds:[rows[0].id]},
    sections:Array.from({length:Math.ceil(rows.length/4)},(_,n)=>({heading:`关键进展 ${n+1}`,paragraphs:rows.slice(n*4,n*4+4).map(i=>({text:i.sentence,itemIds:[i.id]}))}))});
  return assembleBriefEditorial(items,{overview:'合成概览：作者自报，尚未独立验证。',overviewItemIds:[items[0].id],
    directions:[dir('finance','金融与市场',finance),...(tech.length ? [dir('tech','科技与产业',tech)] : [])]});
};
const digest=(id,at,items)=>({id,window:{startAt:at,endAt:at+3600000},timezone:'Asia/Shanghai',generatedAt:at+3600000+120000,items,editorial:editorial(items),coverage:[],warnings:[]});
const digests={h1:digest('h1',start,Array.from({length:7},(_,i)=>item(`i${i}`))),h2:digest('h2',start+3600000,[item('new','h2')]),h3:digest('h3',start,Array.from({length:7},(_,i)=>({...item(`replaced${i}`,'h3'),sentence:item(`i${i}`).sentence})))};
const daily={schemaVersion:2,reportDate:today,generatedAt:start+6*3600000,overview:'合成概览',items:[],informationItems:Array.from({length:12},(_,i)=>item(`d${i}`)),coverage:[],trackingUpdates:[]};
daily.editorial=editorial(daily.informationItems);daily.informationItems.push(item('omitted-raw'));
const legacyDaily={...daily,editorial:undefined,informationItems:undefined,items:Array.from({length:7},(_,i)=>({candidateId:`legacy${i}`,body:`已保存日报原文 ${i}：保留原有叙述及限定。`,evidence:[{materialId:'source1',paragraphId:'p1'}]}))};
const legacySections={...legacyDaily,items:legacyDaily.items.map(({evidence,...i})=>i),sections:legacyDaily.items.map(i=>({id:i.candidateId,title:`兼容日报 ${i.candidateId}`,body:i.body,evidence:i.evidence}))};
let version=1,revision=daily.generatedAt,offline=false,slowDate='',noHours=false,legacyMode=false,draftsOnly=false,mixedOldHour=false,phaseSlots=false,phaseAdvanced=false;
const displayedDaily=()=>legacyMode==='sections' ? legacySections : legacyMode ? legacyDaily : daily;
async function rowAction(page,selector) {
  const control=page.locator(selector).first();await control.evaluate(n=>{n.closest('details').open=true;});await control.click();
}
try {
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  await context.route('**/api/v1/**',async route=>{
    const url=new URL(route.request().url()),p=url.pathname;requests.push({path:p,method:route.request().method()});
    if (p==='/api/v1/ui/revision'||p==='/api/v1/events/stream') return route.continue();
    let body={ok:true},status=200;
    if (p==='/api/v1/session') body={ok:true,role:'device',serverName:'合成界面验收',device:{id:'fixture',name:'fixture'}};
    else if (p==='/api/v1/reports/hourly/index') {
      if (offline) {status=503;body={error:'合成离线故障'};} else body={ok:true,timezone:'Asia/Shanghai',hours:(noHours ? [] : version>=2 ? [digests.h2,version===3 ? digests.h3 : digests.h1] : [digests.h1]).map(d=>({hourStart:d.window.startAt,id:d.id,generatedAt:d.generatedAt,itemCount:d.items.length,status:'completed',updatedAt:d.generatedAt,unread:0,failed:0}))};
      if(phaseSlots && !offline) {
        body.hours=body.hours.map(h=>({...h,readable:true,phase:'ready'}));
        body.hours.unshift(...['not-started','queued-extraction','extracting','queued-editing','editing','failed'].map((phase,i)=>({
          hourStart:start+(7-i)*3600000,id:null,generatedAt:null,itemCount:0,updatedAt:Date.now(),unread:0,failed:0,readable:false,
          status:phase==='not-started' ? 'not-started' : phase==='failed' ? 'failed' : 'running',
          phase:phaseAdvanced && phase==='queued-editing' ? 'editing' : phase,
          ...(phase==='failed' ? {failureStage:'editing',failureReason:'execution-timeout',draftItemCount:7,queueMs:30000,executionMs:360000} : {})
        })));
      }
      if (slowDate && Number(url.searchParams.get('startAt'))===briefDayWindow(slowDate,'Asia/Shanghai').startAt) await new Promise(r=>setTimeout(r,400));
    } else if (p==='/api/v1/reports/hourly/snapshot') {
      const d=digests[url.searchParams.get('snapshotId')];
      body={digest:{...d,...(draftsOnly ? {editorial:undefined} : mixedOldHour && d.id==='h2' ? {editorial:{status:'ready',version:'brief-editorial-v2',overview:'旧主题稿',directions:[{title:'金融与市场',topics:d.items.map(i=>({...i,title:'旧主题',body:i.sentence,itemIds:[i.id]}))}]}} : {})}};
    }
    else if (p==='/api/v1/reports/daily/brief') body={brief:{...displayedDaily(),reportDate:url.searchParams.get('date'),generatedAt:revision}};
    else if (p==='/api/v1/reports/daily/latest/brief') body={brief:{...displayedDaily(),generatedAt:revision}};
    else if (p==='/api/v1/reports/daily/brief/window') body={window:{startAt:window.startAt-16*3600000,endAt:window.startAt+8*3600000},timezone:'Asia/Shanghai'};
    else if (p==='/api/v1/reports/daily/briefs') body={briefs:[{reportDate:today,generatedAt:revision,itemCount:12,overview:'合成内容'}]};
    else if (p.endsWith('/evidence')) body={evidence:{material:{id:'source1',title:'合成来源标题',publisher:'合成出版商',author:'作者',sourceUrl:'https://example.com/fixture',publishedAt:start,obtainedAt:start+100,hash:'a'.repeat(64),version:'1',contentLevel:'full',sourceRefs:[{type:'media-body',id:'fixture'}]},paragraph:{id:url.searchParams.get('paragraphId'),text:'合成支持段落：作者自报，尚未独立验证。',role:'body'},context:[{id:'p3',text:'合成相邻上下文。',role:'body'}]}};
    else if (p==='/api/v1/feed/media/article') body={item:{id:'media:fixture',externalId:'fixture',resourceId:'media:fixture',title:'合成资料库文章',body:'合成文章正文。',bodyHash:'a'.repeat(64),snapshotRevision:1,contentLevel:'full',paragraphs:[{id:'p1',text:'合成文章正文。',kind:'paragraph'}],articleTranslation:{status:'ready',title:'合成资料库文章',bodyHash:'a'.repeat(64),paragraphs:[{id:'p1',text:'合成文章正文。',kind:'paragraph'}]}}};
    else if (p.startsWith('/api/v1/feed')) body={feed:{items:[],mode:'ready'},subscriptions:[]};
    else if (p.startsWith('/api/v1/agent/')) body={runs:[],sessions:[],pendingRuns:[]};
    else if (p.startsWith('/api/v1/tagging')) body={catalog:{tags:[]},taggings:[]};
    else if (p==='/api/v1/notes') body={notes:[]};
    else if (p==='/api/v1/knowledge') body={items:[]};
    else if (p==='/api/v1/work-packages') body={workPackages:[]};
    else if (p==='/api/v1/posts') body={posts:[]};
    else if (p==='/api/v1/sources') body={sources:[]};
    else if (p.startsWith('/api/v1/reports')) body={brief:null,analysis:null,questions:[]};
    else if (p==='/api/v1/static-signals/board') body={board:{upcoming:[],releases:[],sourceHealth:[]}};
    else if (p==='/api/v1/market-native/board') body={board:{predictionMarkets:[],cryptoDerivatives:[],stablecoinLiquidity:null,sourceHealth:[]}};
    else {status=503;body={error:'合成未配置能力'};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/#report`);
  await page.waitForFunction(()=>window.briefProbe?.state.bootstrapped && document.querySelectorAll('.brief-article').length===1);
  assert.equal(await page.locator('#page-title').textContent(),'简报');
  assert.equal(await page.locator('.brief-item').count(),0);
  await rowAction(page,'.brief-article-operations .brief-read');await rowAction(page,'.brief-article-operations .brief-save');
  await rowAction(page,'.brief-article-operations .brief-cite');
  assert.match(await page.evaluate(()=>briefProbe.state.referenceDraft[0].resourceId),/^h1\/[a-f0-9]{48}$/);
  await rowAction(page,'.brief-article-operations .brief-cite');assert.equal(await page.evaluate(()=>briefProbe.state.referenceDraft.length),0);
  assert.equal(await page.locator('.brief-source').first().textContent(),'〔1〕');
  for(const width of [320,375,390,502,699,700,768,1024,1199,1200,1366,1440,1920]) {
    await page.setViewportSize({width,height:[375,390,502].includes(width)?740:900});
    for(const mode of ['hourly','daily']) {
      await page.locator(`#brief-tab-${mode}`).click();await page.waitForFunction(mode=>!briefProbe.controller.state.loading && briefProbe.controller.state.mode===mode,mode);
      for(const direction of ['finance','tech']) {
        await page.locator(`[data-direction="${direction}"]`).click();
        assert.equal(await page.locator('.brief-article').count(),1);assert.equal(await page.locator('.brief-hour').count(),mode==='hourly'?1:0);
        assert.equal(await page.locator('.brief-item').count(),0);assert.equal(await page.locator('[data-item-id="omitted-raw"]').count(),0);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${mode} ${direction} overflow ${width}`);
        const controls=await page.locator('.brief-source,.brief-tab,.brief-direction-tab,.brief-tools > summary,.brief-date-picker > summary').evaluateAll(ns=>ns.map(n=>n.getBoundingClientRect().height));
        assert.ok(controls.every(h=>h>=44),`${width}: ${controls}`);
        assert.equal(await page.locator('#bottom-tab').isVisible(),width<1200);assert.equal(await page.locator('.brief-rail').isVisible(),width>=1440);
        assert.equal(await page.locator('.brief-prose > p').first().evaluate(n=>getComputedStyle(n).fontSize),'16px');
        if([375,390,502].includes(width)) {
          await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
          const top=await page.locator('.brief-article-lead').evaluate(n=>n.getBoundingClientRect().top);assert.ok(top<420,`${width} ${mode}: lead starts at ${top}`);
          assert.equal(await page.locator('.brief-filters').isVisible(),false);assert.equal(await page.locator('.brief-outline').count(),0);
        }
        await rowAction(page,'.brief-prose .brief-evidence-link');await page.waitForSelector('.brief-quote');
        assert.equal(await page.locator('.brief-evidence-claim').textContent(),await page.locator('.brief-prose > p').first().evaluate(n=>n.firstChild.textContent));
        const geom=await page.locator('#brief-evidence').boundingBox();assert.ok(geom.x>=-1 && geom.x+geom.width<=width+1);
        await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#brief-evidence').open && !document.body.classList.contains('is-dialog-open'));
        if([390,1440].includes(width)) {await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.waitForTimeout(50);await page.screenshot({path:fileURLToPath(new URL(`${mode}-${direction}-${width}.png`,output)),fullPage:false});}
      }
    }
  }
  await page.setViewportSize({width:390,height:740});await page.locator('#brief-tab-hourly').click();await page.waitForFunction(()=>!briefProbe.controller.state.loading);
  await page.locator('[data-direction="finance"]').click();
  await page.evaluate(()=>window.scrollTo({top:350,behavior:'instant'}));const financeScroll=await page.evaluate(()=>window.scrollY);
  await page.locator('[data-direction="tech"]').evaluate(n=>n.click());await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>briefProbe.controller.state.hourStart),start);
  await page.locator('[data-direction="finance"]').evaluate(n=>n.click());await page.waitForTimeout(50);
  assert.ok(Math.abs(await page.evaluate(()=>window.scrollY)-financeScroll)<2);
  await page.locator('[data-direction="finance"]').focus();await page.keyboard.press('End');assert.equal(await page.locator('[data-direction="tech"]').getAttribute('aria-selected'),'true');
  await page.keyboard.press('Home');assert.equal(await page.locator('[data-direction="finance"]').getAttribute('aria-selected'),'true');
  await page.locator('[data-direction="policy"]').click();assert.match(await page.locator('.brief-content').textContent(),/本期没有该方向/);assert.equal(await page.evaluate(()=>briefProbe.controller.state.hourStart),start);
  await page.locator('[data-direction="finance"]').click();
  await page.locator('.brief-prose').nth(2).evaluate(n=>n.scrollIntoView({block:'center',behavior:'instant'}));
  const anchor=await page.locator('.brief-prose').nth(2).evaluate(n=>n.getBoundingClientRect().top);
  await rowAction(page,'.brief-prose:nth-of-type(3) .brief-evidence-link');await page.waitForSelector('.brief-quote');
  version=2;await page.evaluate(()=>briefProbe.controller.check());assert.equal(await page.locator('#brief-evidence').evaluate(n=>n.open),true);
  assert.equal(await page.locator('.brief-hour').count(),1);assert.equal(await page.locator('.brief-update').isVisible(),true);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#brief-evidence').open);
  assert.ok(Math.abs(await page.locator('.brief-prose').nth(2).evaluate(n=>n.getBoundingClientRect().top)-anchor)<2);
  await page.locator('.brief-update button').click();await page.waitForFunction(()=>briefProbe.controller.state.hours.length===2 && !briefProbe.controller.state.loading);
  assert.equal(await page.evaluate(()=>briefProbe.controller.state.hourStart),start);assert.equal(await page.locator('.brief-hour').count(),1);
  await page.locator('.brief-period').selectOption(String(start+3600000));assert.equal(await page.evaluate(()=>briefProbe.controller.state.hourStart),start+3600000);
  await page.locator('[data-direction="tech"]').click();assert.match(await page.locator('.brief-content').textContent(),/本期没有该方向/);assert.equal(await page.evaluate(()=>briefProbe.controller.state.hourStart),start+3600000);
  await page.locator('.brief-period').selectOption(String(start));await page.locator('[data-direction="finance"]').click();
  version=3;await page.evaluate(()=>{window.scrollTo(0,0);return briefProbe.controller.check();});
  assert.ok(await page.locator('.brief-update').isVisible());assert.equal(await page.evaluate(()=>briefProbe.controller.state.hours.some(h=>h.id==='h3')),false);
  await page.locator('.brief-update button').click();await page.waitForFunction(()=>briefProbe.controller.state.hours.some(h=>h.id==='h3'));
  assert.equal(await page.locator('.brief-article-operations .brief-read').textContent(),'已读');assert.equal(await page.locator('.brief-article-operations .brief-save').textContent(),'已收藏');
  offline=true;await page.evaluate(()=>briefProbe.controller.check());assert.match(await page.locator('.brief-status').textContent(),/暂时未能更新/);assert.equal(await page.locator('.brief-hour').count(),1);
  offline=false;await page.evaluate(()=>briefProbe.controller.check());
  await page.locator('#brief-tab-daily').click();await page.waitForFunction(()=>briefProbe.controller.state.brief && !briefProbe.controller.state.loading);
  const prior=await page.evaluate(()=>briefProbe.controller.state.brief.generatedAt);revision++;await page.evaluate(()=>briefProbe.controller.check());
  assert.equal(await page.evaluate(()=>briefProbe.controller.state.brief.generatedAt),prior);assert.match(await page.locator('.brief-update').textContent(),/修订/);
  await page.locator('.brief-update button').click();await page.waitForFunction(prior=>briefProbe.controller.state.brief.generatedAt>prior,prior);
  const yesterday=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);slowDate=yesterday;
  for(const date of [yesterday,today]) {await page.locator('.brief-date-picker > summary').click();await page.locator('.brief-date').fill(date);await page.locator('.brief-date').dispatchEvent('change');}
  await page.waitForTimeout(600);assert.equal(await page.evaluate(()=>briefProbe.controller.state.date),today);assert.equal(await page.evaluate(()=>briefProbe.controller.state.brief.reportDate),today);
  await page.evaluate(()=>{briefProbe.state.mediaItems=[];});
  await page.locator('.brief-prose').first().evaluate(n=>n.scrollIntoView({block:'center',behavior:'instant'}));
  const sourceAnchor=await page.locator('.brief-prose').first().evaluate(n=>n.getBoundingClientRect().top);
  await page.locator('.brief-prose .brief-source').first().click();await page.waitForFunction(()=>document.body.dataset.view==='page');
  assert.ok(requests.some(r=>r.path==='/api/v1/feed/media/article'));assert.equal(await page.locator('#brief-evidence').evaluate(n=>n.open),false);
  await page.goBack();await page.waitForFunction(()=>document.body.dataset.view==='report');assert.equal(await page.locator('.brief-article').count(),1);
  assert.ok(Math.abs(await page.locator('.brief-prose').first().evaluate(n=>n.getBoundingClientRect().top)-sourceAnchor)<2);
  assert.equal(requests.filter(r=>r.path.includes('/reports/') && r.method!=='GET').length,0);
  await page.evaluate(async()=>{briefProbe.controller.reset(true);await briefProbe.controller.mount(document.querySelector('#report-list'));});
  assert.equal(await page.evaluate(()=>briefProbe.controller.state.hourStart),start+3600000);
  assert.equal(await page.locator('.brief-hour').count(),1);
  mixedOldHour=true;
  await page.evaluate(async()=>{briefProbe.controller.reset(true);await briefProbe.controller.mount(document.querySelector('#report-list'));});
  assert.equal(await page.evaluate(()=>briefProbe.controller.state.hourStart),start+3600000);
  await page.locator('.brief-period').selectOption(String(start+3600000));
  assert.equal(await page.locator('.brief-item').count(),1);assert.match(await page.locator('.brief-content').textContent(),/此前主题稿/);
  mixedOldHour=false;
  phaseSlots=true;
  await page.evaluate(async()=>{briefProbe.controller.reset(true);await briefProbe.controller.mount(document.querySelector('#report-list'));});
  assert.equal(await page.locator('.brief-period option').count(),8);
  const phaseLabels=await page.locator('.brief-period').textContent();
  for(const label of ['尚未开始','等待提炼','正在提炼','等待成稿','正在成稿','模型执行超时']) assert.ok(phaseLabels.includes(label),label);
  assert.match(await page.locator('.brief-publication').textContent(),/最新发布到 04:00/);
  assert.equal(await page.evaluate(()=>briefProbe.controller.state.hourStart),start+3600000);
  await page.locator('.brief-period').selectOption(String(start+7*3600000));
  assert.equal(await page.locator('.brief-article').count(),0);assert.match(await page.locator('.brief-content').textContent(),/尚未开始/);
  await page.locator('.brief-period').selectOption(String(start+4*3600000));
  assert.match(await page.locator('.brief-content').textContent(),/等待成稿/);
  phaseAdvanced=true;await page.evaluate(()=>briefProbe.controller.check());
  assert.equal(await page.evaluate(()=>briefProbe.controller.state.hourStart),start+4*3600000);
  assert.match(await page.locator('.brief-content').textContent(),/正在成稿/);
  assert.match(await page.locator('.brief-publication').textContent(),/最新发布到 04:00/);
  await page.locator('.brief-period').selectOption(String(start));
  assert.equal(await page.locator('.brief-article').count(),1);
  await page.locator('.brief-prose').nth(2).evaluate(n=>n.scrollIntoView({block:'center',behavior:'instant'}));
  const statusAnchor=await page.locator('.brief-prose').nth(2).evaluate(n=>n.getBoundingClientRect().top);
  await page.evaluate(()=>briefProbe.controller.check());
  assert.ok(Math.abs(await page.locator('.brief-prose').nth(2).evaluate(n=>n.getBoundingClientRect().top)-statusAnchor)<2);
  for(const width of [375,390,502]) {
    await page.setViewportSize({width,height:740});await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.ok(await page.locator('.brief-article-lead').evaluate(n=>n.getBoundingClientRect().top)<450);
    await page.screenshot({path:fileURLToPath(new URL(`hourly-status-${width}.png`,output)),fullPage:false});
  }
  phaseSlots=false;phaseAdvanced=false;
  draftsOnly=true;
  await page.evaluate(async()=>{briefProbe.controller.reset(true);await briefProbe.controller.mount(document.querySelector('#report-list'));});
  assert.equal(await page.locator('#brief-tab-daily').getAttribute('aria-selected'),'true');
  await page.locator('#brief-tab-hourly').click();await page.waitForFunction(()=>!briefProbe.controller.state.loading);
  assert.equal(await page.locator('.brief-item').count(),0);assert.match(await page.locator('.brief-content').textContent(),/主题整理未完成/);
  draftsOnly=false;
  noHours=true;legacyMode=true;
  await page.evaluate(async()=>{briefProbe.controller.reset(true);await briefProbe.controller.mount(document.querySelector('#report-list'));});
  assert.equal(await page.locator('#brief-tab-daily').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.brief-item').count(),7);
  assert.match(await page.locator('.brief-sentence').first().textContent(),/已保存日报原文/);
  await page.locator('.brief-tools > summary').click();
  await page.locator('.brief-search').fill('原文 3');assert.equal(await page.locator('.brief-item').count(),1);
  await page.locator('.brief-search').fill('');
  await page.locator('.brief-tools > summary').click();
  await rowAction(page,'.brief-evidence-link');await page.waitForSelector('.brief-quote');
  assert.ok(requests.some(r=>r.path==='/api/v1/reports/daily/evidence'));
  await page.keyboard.press('Escape');
  await rowAction(page,'.brief-save');
  legacyMode='sections';await page.evaluate(async()=>{briefProbe.controller.reset(true);await briefProbe.controller.mount(document.querySelector('#report-list'));});
  assert.equal(await page.locator('.brief-legacy-entry').count(),7);
  assert.equal(await page.locator('#report-list .note-card').count(),0);
  assert.ok(await page.locator('.brief-legacy-entry').first().evaluate(n=>n.getBoundingClientRect().top)<360);
  assert.equal(await page.locator('.brief-legacy-entry').first().evaluate(n=>getComputedStyle(n).fontSize),'16px');
  await page.evaluate(()=>briefProbe.showUnpairedPage('fixture'));
  assert.equal(await page.locator('.brief-item').count(),0);
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('ai-center.brief.'))),false);
  await context.route('**/brief-page.js*',route=>route.fulfill({status:404,body:'old server'}));
  await context.route('**/hardware-prices.js*',route=>route.fulfill({status:404,body:'old server'}));
  const old=await context.newPage();old.on('pageerror',e=>errors.push(e.message));
  await old.goto(`http://127.0.0.1:${server.address().port}/#report`);
  await old.waitForFunction(()=>window.briefProbe?.state.bootstrapped && document.querySelector('#report-list').textContent.includes('小时信息摘选'));
  assert.match(await old.locator('#report-list').textContent(),/等待服务重载/);
  await old.close();
  assert.deepEqual(errors,[]);
  const summary={synthetic:true,widths:13,views:2,directions:2,visibleArticles:1,preservedRawItems:13,checks:'first-screen lead at 375/390/502, direction articles and paragraph evidence, latest frozen hour only, direction keeps window, absent direction empty, keyboard tabs, per-direction positions, omitted raw item absent from body, collapsed tools, touch targets, shell breakpoints, secondary evidence, focus/scroll, update notice, read continuity, offline recovery, daily revision, stale date, uncached source direct read and return position, legacy daily fallback, read-only report requests, auth cleanup',errors};
  await writeFile(new URL('result.json',output),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
