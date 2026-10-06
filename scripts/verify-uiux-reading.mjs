import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { createStaticFileHandler } from '../apps/web/src/http/static-files.js';
if (!process.env.UIUX_RUNTIME_PACKAGE || !process.env.UIUX_BROWSER) {
  throw new Error('Set UIUX_RUNTIME_PACKAGE to the bundled Node package.json and UIUX_BROWSER to a Chromium executable.');
}
const require = createRequire(process.env.UIUX_RUNTIME_PACKAGE);
const { chromium } = require('playwright');
// Headless synthetic fixtures only. Runtime/browser locations come from the Host environment.
const output = new URL('../.ai-data/uiux-probe/', import.meta.url);
await mkdir(output, { recursive: true });
const serve = createStaticFileHandler(new URL('../apps/web/public', import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/app.js') {
    const source = await readFile(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(source + '\nwindow.uiProbe = {state, setView, openArticle, leaveArticle, renderPosts, renderArticlePage, renderDividendInspection, renderPersonalAssetDashboard, renderMarketNativeBoard, renderStaticSignalBoard, renderStaticSourceCatalog, loadAskSessions, loadAskSession, renderAskRecords, renderQuantPage, renderSources, renderKnowledge, restorePersistedFeedBrowseState, renderReport, setReport(brief){dailyBriefSnapshot={brief,loaded:true,error:""};}};');
    return;
  }
  if (url.pathname === '/api/v1/ui/revision') {
    res.writeHead(200, { 'Content-Type': 'application/json' });res.end(JSON.stringify({revision:await serve.getUiRevision()}));return;
  }
  if (url.pathname === '/api/v1/events/stream') {res.writeHead(200, {'Content-Type':'text/event-stream'});res.write(': idle\n\n');return;}
  if (!await serve(url.pathname,req,res)) {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.UIUX_BROWSER});
const errors=[];
let sessionsMode='ready', quantMode='error', calendarMode='empty';
const quantPayload={lab:{overview:{ready:false,sampleLabel:'合成样本',sampleNote:'等待准备',source:'fixture',segments:null},experiments:[],prepareJobs:[]}};
try {
  const context=await browser.newContext({viewport:{width:1188,height:848}});
  await context.route('**/api/v1/**',async route=>{
    const url=new URL(route.request().url()),p=url.pathname;
    if(p==='/api/v1/ui/revision'||p==='/api/v1/events/stream') return route.continue();
    let payload={ok:true};let status=200;
    if(p==='/api/v1/session') payload={ok:true,role:'device',serverName:'UI fixture',device:{id:'fixture',name:'test'}};
    else if(p==='/api/v1/agent/sessions') {
      await new Promise(resolve=>setTimeout(resolve,500));
      if(sessionsMode==='error') {status=502;payload={error:'合成离线故障'};}
      else payload={sessions:sessionsMode==='empty'?[]:[{id:'s1',title:'已有历史记录',preview:'合成内容',updatedAt:Date.now(),runCount:1}],pendingRuns:[]};
    } else if(p.startsWith('/api/v1/agent/sessions/')) {
      const id=p.split('/').at(-1);await new Promise(resolve=>setTimeout(resolve,id==='slow'?400:30));
      payload={session:{id,kind:'question-answer',title:`会话${id}`},exchanges:[{id:`run-${id}`,question:`问题${id}`,answer:`回答${id}`,status:'completed'}]};
    } else if(p==='/api/v1/quant/lab') {
      await new Promise(resolve=>setTimeout(resolve,300));
      if(quantMode==='error') {status=503;payload={error:'合成环境暂不可用'};}else payload=quantPayload;
    } else if(p==='/api/v1/sources') payload={sources:[{id:'calendar.fixture',title:'合成日程来源',category:'calendar',viewKind:'calendar'}]};
    else if(p==='/api/v1/static-signals/board') {
      if(calendarMode==='error') {status=502;payload={error:'合成离线故障'};}else payload={board:{upcoming:[],releases:[],sourceHealth:[],generatedAt:Date.now()}};
    } else if(p==='/api/v1/market-native/board') payload={board:{predictionMarkets:[],cryptoDerivatives:[],stablecoinLiquidity:null,sourceHealth:[],generatedAt:Date.now()}};
    else if(p.startsWith('/api/v1/feed/')) payload={feed:{items:[],mode:'ready'}};
    else if(p==='/api/v1/knowledge') payload={items:[]};
    else if(p==='/api/v1/notes') payload={notes:[]};
    else if(p==='/api/v1/work-packages') payload={workPackages:[]};
    else if(p==='/api/v1/posts') payload={posts:[]};
    else if(p.startsWith('/api/v1/agent/runs')) payload={runs:[]};
    else if(p.endsWith('/tagging/catalog')) payload={catalog:{tags:[]}};
    else if(p.endsWith('/tagging/resources')) payload={taggings:[]};
    else if(p.startsWith('/api/v1/reports/')) payload={timezone:'Asia/Shanghai',hours:[],brief:null,briefs:[],analysis:null};
    else if(p.startsWith('/api/v1/market')||p.startsWith('/api/v1/assets')||p.startsWith('/api/v1/holdings')) {status=503;payload={error:'fixture unavailable'};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(payload)});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/#/article/missing-fixture');
  await page.waitForFunction(()=>window.uiProbe?.state.bootstrapped);
  await page.waitForFunction(()=>document.querySelector('#page-root').textContent.includes('当前未找到'));
  await page.evaluate(()=>document.querySelector('#page-root button').click());
  await page.waitForFunction(()=>document.body.dataset.view==='feed');
  await page.goto(base+'/#/sources/catalog');
  await page.waitForFunction(()=>window.uiProbe?.state.sourceCatalogLoaded);
  await page.waitForTimeout(700);
  assert.equal(await page.locator('#page-title').textContent(),'信源目录');
  assert.equal(await page.locator('#overview-catalog').isVisible(),true);
  await page.reload();await page.waitForFunction(()=>window.uiProbe?.state.sourceCatalogLoaded);
  assert.equal(await page.locator('#page-title').textContent(),'信源目录');
  await page.evaluate(()=>{uiProbe.state.bootstrapped=false;uiProbe.setView('tools');document.querySelector('#bottom-tab [data-nav="sources"]').click();});
  assert.equal(await page.locator('#page-title').textContent(),'信息流');
  for (const route of ['market','market/global','report','sources','feed']) {
    await page.evaluate(()=>document.querySelector('#side-nav-list [data-nav="sources"]').click());
    assert.equal(await page.evaluate(()=>location.hash),`#${route}`);
    assert.equal(await page.locator('#overview-subnav [aria-current="page"]').count(),1);
  }
  await page.evaluate(()=>{uiProbe.setView('market/global');document.querySelector('#bottom-tab [data-nav="sources"]').click();});
  assert.equal(await page.evaluate(()=>location.hash),'#report');
  await page.evaluate(()=>{uiProbe.setView('tools');document.querySelector('#bottom-tab [data-nav="assets"]').click();});
  assert.equal(await page.evaluate(()=>uiProbe.state.tradePane),'holdings');
  await page.evaluate(()=>document.querySelector('#bottom-tab [data-nav="assets"]').click());
  assert.equal(await page.evaluate(()=>location.hash),'#assets/analysis');
  assert.equal(await page.evaluate(()=>uiProbe.state.tradePane),'analysis');
  await page.goBack();await page.waitForFunction(()=>uiProbe.state.tradePane==='holdings');
  await page.goForward();await page.waitForFunction(()=>uiProbe.state.tradePane==='analysis');
  await page.evaluate(()=>document.querySelector('#side-nav-list [data-nav="assets"]').click());
  assert.equal(await page.evaluate(()=>location.hash),'#assets');
  await page.evaluate(()=>[...document.querySelectorAll('#book-tabs button')].find(n=>n.textContent==='个人资产分析').click());
  assert.equal(await page.evaluate(()=>location.hash),'#assets/analysis');
  await page.evaluate(()=>{uiProbe.setView('tools');document.querySelector('#bottom-tab [data-nav="assets"]').click();});
  assert.equal(await page.evaluate(()=>uiProbe.state.tradePane),'holdings');
  await page.evaluate(()=>{
    const s=uiProbe.state;s.feedPlatform=s.platform='media';s.mediaView='full';s.channel='all';s.feedRange='all';s.feedShown=30;
    s.mediaItems=Array.from({length:30},(_,i)=>({id:`fixture-${i}`,externalId:`fixture-${i}`,title:`合成长文 ${i}：中文和 English 123`,publisherName:'合成来源',body:'合成中文。'.repeat(150),bodyHash:'a'.repeat(64),snapshotRevision:1,contentLevel:'full',tags:[],publishedAt:Date.now()-i*1000,paragraphs:Array.from({length:24},(_,j)=>({id:`p${j}`,kind:'paragraph',text:'合成中文阅读内容。English mixed text 12345。'.repeat(7)})),articleTranslation:{status:'ready',title:`中文合成文章 ${i}`,bodyHash:'a'.repeat(64),paragraphs:Array.from({length:24},(_,j)=>({id:`p${j}`,kind:'paragraph',text:'合成中文阅读内容。English mixed text 12345。'.repeat(7)}))}}));
    uiProbe.setView('feed');uiProbe.renderPosts();window.scrollTo(0,600);
  });
  await page.waitForTimeout(150);
  await page.evaluate(()=>window.scrollTo(0,600));
  await page.waitForTimeout(50);
  console.log('before reading',await page.evaluate(()=>({scroll:scrollY, cards:document.querySelectorAll('#feed .post-card').length, height:document.documentElement.scrollHeight, state:uiProbe.state.feedPlatform, text:document.querySelector('#feed').textContent.slice(0,150)})));
  for(let i=0;i<5;i++) {
    await page.evaluate(i=>{uiProbe.openArticle({id:`fixture-${i}`,platform:'media',body:'synthetic'});window.scrollTo(0,900);},i);
    await page.waitForTimeout(100);
    assert.equal((await page.locator('.reading-back').textContent()).trim(),'返回信息流');
    const geometry=await page.locator('.page-article').evaluate(el=>({width:el.getBoundingClientRect().width,font:parseFloat(getComputedStyle(el).fontSize),ancestors:[el,...(function*(n){while(n.parentElement){n=n.parentElement;yield n;}})(el)].map(n=>({tag:n.tagName,id:n.id,display:getComputedStyle(n).display,visibility:getComputedStyle(n).visibility}))}));
    assert.ok(geometry.width<=geometry.font*40+1,JSON.stringify({geometry,debug:await page.evaluate(()=>({view:document.body.dataset.view,hash:location.hash,boot:uiProbe.state.bootstrapped,text:document.querySelector('#page-root').textContent.slice(0,100)})),errors}));
    await page.evaluate(()=>uiProbe.leaveArticle());
    await page.waitForFunction(()=>document.body.dataset.view==='feed');
    await page.waitForTimeout(100);
    const y=await page.evaluate(()=>window.scrollY);assert.ok(Math.abs(y-600)<12,`return ${i}: ${y}`);
    assert.equal(await page.evaluate(()=>uiProbe.state.feedPlatform),'media');
  }
  await page.goForward();await page.waitForFunction(()=>document.body.dataset.reader==='1');
  await page.screenshot({path:new URL('article-1188.png',output).pathname.replace(/^\/(\w:)/,'$1')});
  for(const width of [390,430,768,1188,1440]) {
    await page.setViewportSize({width,height:848});await page.waitForTimeout(60);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`article overflow ${width}`);
    if(width<700) {
      assert.equal(await page.locator('#bottom-tab').isVisible(),false);
      assert.equal(await page.locator('.reader-mobile-bar').isVisible(),true);
      const heights=await page.locator('.reader-mobile-bar button').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height));assert.ok(heights.every(h=>h>=48));
      const back=await page.locator('.reader-mobile-bar button').last().textContent();assert.match(back,/返回/);
      await page.evaluate(()=>{const trigger=[...document.querySelectorAll('.reader-mobile-bar button')].find(button=>button.textContent.includes('更多'));trigger.focus();trigger.click();});
      assert.equal(await page.locator('#reader-menu').evaluate(n=>n.open),true);
      await page.evaluate(()=>document.querySelector('#reader-menu .dialog-close').click());
      await page.waitForFunction(()=>document.activeElement.closest('.reader-mobile-bar'));
      if(width===390) await page.screenshot({path:new URL('article-390.png',output).pathname.replace(/^\/(\w:)/,'$1')});
    }
  }
  await page.evaluate(()=>{const trigger=document.querySelector('.reading-toolbar button:last-child');trigger.focus();trigger.click();});
  // Open via DOM event, inspect focus and close without desktop input simulation.
  assert.equal(await page.locator('#reader-menu').evaluate(n=>n.open),true);
  await page.evaluate(()=>{const buttons=[...document.querySelectorAll('#reader-menu button')];buttons.find(n=>n.textContent.trim()==='放大字号').click();});
  assert.equal(await page.evaluate(()=>uiProbe.state.readerFont),18);
  await page.evaluate(()=>document.querySelector('#reader-menu .dialog-close').click());
  assert.equal(await page.locator('#reader-menu').evaluate(n=>n.open),false);
  assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'更多');
  await page.evaluate(()=>{
    const s=uiProbe.state;s.feedPlatform=s.platform='social';s.channel='social';s.feedQuery='合成社媒';s.feedSort='published';s.feedRange='today';s.feedShown=30;
    s.xItems=Array.from({length:30},(_,i)=>({id:`social-fixture-${i}`,title:`合成社媒 ${i}`,body:'合成社媒正文。'.repeat(80),tags:['测试'],authorName:'合成作者',publishedAt:Date.now()-i*1000}));
    uiProbe.setView('feed');uiProbe.renderPosts();
  });
  await page.waitForTimeout(150);await page.evaluate(()=>window.scrollTo(0,600));
  for(let i=0;i<5;i++) {
    await page.evaluate(i=>uiProbe.openArticle({id:`social-fixture-${i}`,platform:'x',kind:'social',title:`合成社媒 ${i}`,body:'合成正文',tags:['测试']}),i);
    await page.waitForTimeout(100);await page.evaluate(()=>uiProbe.leaveArticle());
    await page.waitForFunction(()=>document.body.dataset.view==='feed');await page.waitForTimeout(100);
    assert.ok(Math.abs(await page.evaluate(()=>scrollY)-600)<12);
    assert.deepEqual(await page.evaluate(()=>({platform:uiProbe.state.feedPlatform,channel:uiProbe.state.channel,query:uiProbe.state.feedQuery,sort:uiProbe.state.feedSort,range:uiProbe.state.feedRange})),{platform:'social',channel:'social',query:'合成社媒',sort:'published',range:'today'});
  }
  await page.evaluate(()=>uiProbe.openArticle({id:'social-fixture-0',platform:'x',kind:'social',title:'合成社媒 0',body:'合成正文',tags:['测试']}));
  await page.waitForTimeout(100);
  const direct=await context.newPage();direct.on('pageerror',e=>errors.push(e.message));
  await direct.goto(base+'/#/article/social-fixture-0');
  await direct.waitForFunction(()=>window.uiProbe?.state.bootstrapped);
  await direct.waitForFunction(()=>document.querySelector('.reading-back'));
  assert.equal((await direct.locator('.reading-back').textContent()).trim(),'返回信息流');
  await direct.reload();await direct.waitForFunction(()=>window.uiProbe?.state.bootstrapped);
  assert.equal((await direct.locator('.reading-back').textContent()).trim(),'返回信息流');
  await direct.close();
  await page.evaluate(()=>uiProbe.setView('tools'));
  const before=await page.locator('#tool-grid').boundingBox();
  await page.evaluate(()=>uiProbe.renderDividendInspection({asOf:Date.now(),status:'ready',factors:{value:{},pain:{},dataQuality:{}}}));
  const after=await page.locator('#tool-grid').boundingBox();assert.equal(before.y,after.y);assert.equal(before.height,after.height);
  assert.equal(await page.locator('#tool-grid .tool-icon svg').count(),7);
  await page.evaluate(()=>uiProbe.setView('ask'));
  assert.match(await page.locator('#ask-session-list').textContent(),/正在读取/);
  await page.waitForFunction(()=>document.querySelector('#ask-session-list').textContent.includes('已有历史记录'));
  sessionsMode='error';await page.evaluate(()=>uiProbe.loadAskSessions().catch(()=>{}));
  assert.match(await page.locator('#ask-session-list').textContent(),/读取失败/);
  sessionsMode='empty';await page.evaluate(()=>document.querySelector('#ask-session-list button').click());
  await page.waitForFunction(()=>document.querySelector('#ask-session-list').textContent.includes('还没有问答记录'));
  await page.evaluate(()=>{uiProbe.setView('ask/slow');uiProbe.setView('ask/fast');});
  await page.waitForTimeout(600);assert.equal(await page.locator('#page-title').textContent(),'会话fast');
  assert.match(await page.locator('#ask-thread').textContent(),/回答fast/);
  await page.evaluate(()=>uiProbe.setView('ask/new'));assert.equal(await page.locator('#ask-prompts').isVisible(),true);
  await page.evaluate(()=>uiProbe.setView('quant'));
  assert.match(await page.locator('#quant-lab').textContent(),/正在读取/);
  await page.waitForFunction(()=>document.querySelector('#quant-lab').textContent.includes('暂不可用'));
  quantMode='ready';await page.evaluate(()=>document.querySelector('#quant-lab button').click());
  await page.waitForFunction(()=>document.querySelector('#quant-lab .quant-form'));
  assert.match(await page.locator('#quant-lab').textContent(),/还没有实验/);
  await page.evaluate(()=>{uiProbe.state.staticBoard={upcoming:[],sourceHealth:[],generatedAt:Date.now()};uiProbe.state.staticBoardError='';uiProbe.setView('sources/schedule');});
  assert.match(await page.locator('#static-schedule-list').textContent(),/暂无日程/);
  await page.evaluate(()=>{uiProbe.state.staticBoardError='合成离线故障';uiProbe.renderStaticSignalBoard();});
  assert.match(await page.locator('#static-schedule-list').textContent(),/暂未完整读取/);
  await page.evaluate(()=>document.querySelector('#static-schedule-list button').click());
  await page.waitForFunction(()=>document.querySelector('#static-schedule-list').textContent.includes('暂无日程'));
  await page.evaluate(()=>{
    uiProbe.setView('assets');const s=uiProbe.state;s.tradePane='analysis';document.querySelectorAll('[data-trade-pane]').forEach(n=>n.classList.toggle('is-active',n.dataset.tradePane==='analysis'));
    s.assetDashboard={latest:{total:'60000',equity:'30000',housingFund:'10000'},points:[{label:'2026-01',total:'30000',equity:'15000',housingFund:'5000'},{label:'2026-02',total:'60000',equity:'30000',housingFund:'10000'}],accounts:[],types:[],allocation:[]};uiProbe.renderPersonalAssetDashboard();
  });
  for(const width of [360,390,430,768,1188,1440]) {
    await page.setViewportSize({width,height:848});await page.waitForTimeout(100);
    const chart=await page.locator('#analysis-trend svg').evaluate(n=>({view:n.viewBox.baseVal.width,actual:n.getBoundingClientRect().width,font:n.querySelector('text').getAttribute('font-size')}));
    assert.ok(Math.abs(chart.view-chart.actual)<2,JSON.stringify(chart));assert.equal(chart.font,'12');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`asset overflow ${width}`);
  }
  await page.evaluate(()=>document.querySelector('#analysis-privacy').click());assert.match(await page.locator('#analysis-kpis').textContent(),/••••/);assert.equal(await page.locator('#analysis-trend svg').count(),0);
  await page.evaluate(()=>{uiProbe.setView('market/global');const metric={label:'最长稳定币名称测试 Long label',supplyUsd:'10000000',change1dUsd:'1000',change7dUsd:'2000',change30dUsd:'3000'};uiProbe.state.marketNativeBoard={stablecoinLiquidity:{total:metric,assets:[{...metric,label:'USD'}],chains:[]}};uiProbe.renderMarketNativeBoard();});
  await page.setViewportSize({width:390,height:848});
  const edges=await page.locator('.market-native-supply').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().right));assert.ok(edges.every(x=>Math.abs(x-edges[0])<1),JSON.stringify(edges));
  await page.evaluate(()=>{uiProbe.setReport({schemaVersion:1,reportDate:'2026-10-05',overview:'合成日报摘要',items:[]});uiProbe.setView('report',{reportLoaded:true});});
  const order=await page.locator('#report-list').evaluate(n=>[...n.children].map(el=>({text:el.textContent.slice(0,20),order:getComputedStyle(el).order})));
  assert.ok(order.filter(n=>n.text.includes('配置')||n.text.includes('生成')).every(n=>n.order==='10'));
  for(const width of [390,430,768,1188,1440]) {
    await page.setViewportSize({width,height:848});
    for(const route of ['sources','feed','tools','ask','market','market/global','report','inspire','knowledge']) {
      await page.evaluate(route=>uiProbe.setView(route,{reportLoaded:true}),route);await page.waitForTimeout(40);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${route} overflow ${width}`);
    }
  }
  await page.setViewportSize({width:390,height:848});
  await page.evaluate(()=>{
    uiProbe.setView('inspire');const input=document.querySelector('#note-body');
    Object.defineProperty(window.visualViewport,'height',{configurable:true,value:innerHeight-300});
    input.focus();window.visualViewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(await page.locator('#bottom-tab').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.body.classList.contains('is-inspire-keyboard')),true);
  assert.equal(await page.locator('#note-form').evaluate(n=>getComputedStyle(n).bottom),'300px');
  await page.evaluate(()=>{delete window.visualViewport.height;document.querySelector('#note-body').blur();window.visualViewport.dispatchEvent(new Event('resize'));});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,widths:[360,390,430,768,1188,1440],checks:['catalog slash route and refresh','direct article and refresh fallback','overview primary navigation cycle','asset primary navigation cycle and history','five media and social returns with filters and scroll','browser forward','reading width and mobile dock','reader settings and focus return on desktop and mobile','stable tool positions','ask loading/error/empty/retry','late session protection','quant retry','calendar empty/error/retry','responsive chart','asset privacy','stablecoin columns','daily content priority','nine page layouts at five widths','synthetic inspiration keyboard viewport'],screenshots:['article-1188.png','article-390.png']},null,2));
} finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
