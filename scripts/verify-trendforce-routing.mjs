import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {createStaticFileHandler} from '../apps/web/src/http/static-files.js';
if(!process.env.UIUX_RUNTIME_PACKAGE || !process.env.UIUX_BROWSER)throw new Error('Set UIUX_RUNTIME_PACKAGE and UIUX_BROWSER to Host runtime locations.');
const {chromium}=createRequire(process.env.UIUX_RUNTIME_PACKAGE)('playwright');
const output=new URL('../.ai-data/trendforce-ui/',import.meta.url);await mkdir(output,{recursive:true});
const serve=createStaticFileHandler(new URL('../apps/web/public',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/app.js') {
    const source=await readFile(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
    res.writeHead(200,{'Content-Type':'text/javascript'});res.end(source+'\nwindow.routingProbe={state,setView,openPage,applyFeedPlatform,loadMediaFeed};');return;
  }
  if(url.pathname==='/api/v1/ui/revision'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({revision:await serve.getUiRevision()}));return;}
  if(url.pathname==='/api/v1/events/stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': fixture\n\n');return;}
  if(!await serve(url.pathname,req,res)){res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.UIUX_BROWSER});
const at=Date.now(),snapshotId='11111111-1111-4111-8111-111111111111',seriesKey='a'.repeat(64);
const row={category:'dram',specification:'DDR5 16Gb (2Gx8) 4800/5600',quoteType:'spot',average:'10.00',high:'12.00',low:'8.00',currency:null,unit:null,period:null,history:[],
  verification:'pending',changePct:null,reportedChange:'+2%',changeBasis:null,seriesKey,snapshotId,capturedAt:at,sourceUpdatedAt:at,revision:1,isCurrent:true};
const card={...row,category:'other-storage',specification:'MicroSD 128GB',seriesKey:'b'.repeat(64)};
const historyRow={...row,specification:'DDR5 32Gb (4Gx8) 5600',seriesKey:'c'.repeat(64),verification:'verified',currency:'USD',unit:'chip',missing:[],changePct:20,period:'2026-10-05',periodStart:at,periodEnd:at+86400000,
  history:[{at:at-86400000,average:'8.00',period:'2026-10-04'},{at,average:'10.00',period:'2026-10-05'}]};
const observations=[{...historyRow,average:'8.00',period:'2026-10-04',periodStart:at-86400000},historyRow,{...historyRow,average:'999',isCurrent:false}];
const snapshot={id:snapshotId,title:'整张合成价表',format:'html',sourceUrl:'https://www.trendforce.com.tw/price/dram/dram_spot',capturedAt:at,warnings:[],items:[row,card],
  raw:'<script>window.sourceScriptExecuted=true</script><table class="price-table"><tr><th>规格</th><th>均价</th></tr><tr><td>DDR5 16Gb</td><td>10</td></tr><tr><td>MicroSD 128GB</td><td>2</td></tr></table>'};
const intro={id:'report-fixture',resourceId:'report-fixture',externalId:'trendforce:research:fixture',sourceKey:'trendforce',publisherKey:'trendforce',publisherName:'TrendForce',
  articleKind:'report-intro',contentLevel:'summary_only',title:'合成会员报告目录',summary:'报告简介，仅包含公开介绍。',body:'报告简介，仅包含公开介绍。',tags:['memory'],isSaved:true,contentItemId:snapshotId,paragraphs:[],fetchState:{},createdAt:at};
const errors=[];
try {
  for(const viewport of [1188,320,375,390,430,502].map(width=>({width,height:844}))) {
    const context=await browser.newContext({viewport});
    await context.route('**/api/v1/**',async route=>{
      const url=new URL(route.request().url()),p=url.pathname;if(p==='/api/v1/ui/revision'||p==='/api/v1/events/stream')return route.continue();
      let payload={ok:true},status=200;
      if(p==='/api/v1/session')payload={ok:true,role:'device',serverName:'Synthetic fixture',device:{id:'fixture',name:'test'}};
      else if(p==='/api/v1/hardware-prices')payload={items:[row,historyRow,card]};
      else if(p.includes('/hardware-prices/series/'))payload={detail:p.endsWith(historyRow.seriesKey)?{current:historyRow,observations,revisions:observations,hasHistory:true,snapshots:[snapshot]}:{current:row,observations:[row],revisions:[row],hasHistory:false,snapshots:[snapshot]}};
      else if(p.includes('/hardware-prices/snapshots/'))payload={snapshot};
      else if(p.includes('/feed/items/') && p.endsWith('/original'))payload={original:{id:snapshotId,provider:'trendforce',externalId:'price:dram',title:'旧价表原始快照',body:'旧价表，保留多个规格。',contentLevel:'summary_only',hardwareSnapshot:snapshot}};
      else if(p==='/api/v1/feed/media') {
        const bbc=url.searchParams.get('sourceKey')==='bbc';if(bbc)await new Promise(resolve=>setTimeout(resolve,120));
        const items=bbc?[]:[intro];payload={feed:{items,counts:{all:items.length,index:items.length,full:0},nextOffset:null,sources:[{sourceKey:'trendforce',publisher:'TrendForce'},{sourceKey:'bbc',publisher:'BBC — Long international technology and industry publisher name'}],mode:'cached'}};
      }
      else if(p==='/api/v1/sources')payload={sources:[{id:'content.trendforce.public',title:'TrendForce',category:'content',viewKind:'content-feed'}]};
      else if(p.startsWith('/api/v1/feed/'))payload={feed:{items:[],mode:'ready'}};
      else if(p==='/api/v1/knowledge')payload={items:[]};else if(p==='/api/v1/notes')payload={notes:[]};else if(p==='/api/v1/posts')payload={posts:[]};
      else if(p==='/api/v1/work-packages')payload={workPackages:[]};else if(p.startsWith('/api/v1/agent/'))payload={runs:[],sessions:[]};
      else if(p.endsWith('/tagging/catalog'))payload={catalog:{tags:[]}};else if(p.endsWith('/tagging/resources'))payload={taggings:[]};
      else if(p.startsWith('/api/v1/reports/'))payload={brief:null,briefs:[],analysis:null};
      else if(p.startsWith('/api/v1/market')||p.startsWith('/api/v1/assets')||p.startsWith('/api/v1/holdings')){status=503;payload={error:'fixture unavailable'};}
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(payload)});
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/#hardware');await page.waitForFunction(()=>window.routingProbe?.state.bootstrapped && routingProbe.state.hardwareLoaded);
    assert.equal(await page.locator('#hardware-prices-entry').count(),0);
    assert.equal(await page.evaluate(()=>document.body.dataset.view),'market');
    await page.evaluate(()=>routingProbe.setView('market/global'));
    await page.locator('#asset-filters').getByRole('button',{name:'全部',exact:true}).click();
    assert.equal(await page.locator('#asset-list [data-hardware-series]').count(),1);
    await page.locator('#asset-filters').getByRole('button',{name:'AI硬件',exact:true}).click();
    await page.locator('#hardware-market-filters').getByRole('button',{name:/查看待核验/}).click();
    assert.equal(await page.locator('#asset-list [data-hardware-series]').count(),2);
    assert.equal(await page.locator('#asset-list').getByText('MicroSD 128GB',{exact:true}).count(),0);
    assert.equal(await page.locator('#asset-list [data-hardware-series="'+historyRow.seriesKey+'"] svg.spark').count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:new URL(`market-${viewport.width}.png`,output).pathname.replace(/^\/(\w:)/,'$1')});
    await page.locator('#asset-list [data-hardware-series="'+row.seriesKey+'"]').click();
    await page.waitForFunction(()=>document.querySelector('#page-root').textContent.includes('暂无历史'));
    assert.equal(await page.locator('#page-root canvas').count(),0);
    assert.equal(await page.locator('.hardware-price-chart').count(),0);
    await page.evaluate(key=>routingProbe.openPage('hardware','series/'+key),historyRow.seriesKey);
    await page.locator('.hardware-price-chart').waitFor();
    assert.equal(await page.locator('.hardware-price-chart circle title').count(),2);
    assert.match(await page.locator('.hardware-chart-readout').textContent(),/10/);
    await page.locator('.hardware-price-chart').focus();await page.keyboard.press('ArrowLeft');
    assert.match(await page.locator('.hardware-chart-readout').textContent(),/8/);
    assert.equal(await page.locator('[aria-label="K线周期"]').count(),0);
    await page.screenshot({path:new URL(`history-${viewport.width}.png`,output).pathname.replace(/^\/(\w:)/,'$1')});
    await page.locator('#nav-back').click();
    await page.locator('#hardware-market-filters').getByRole('button',{name:'其他存储参考',exact:true}).click();
    assert.equal(await page.locator('#asset-list [data-hardware-series]').count(),1);
    await page.locator('#hardware-market-filters').getByRole('button',{name:'全部报价',exact:true}).click();
    await page.evaluate(()=>routingProbe.openPage('hardware','snapshot/11111111-1111-4111-8111-111111111111'));
    await page.waitForFunction(()=>document.querySelector('#page-root').textContent.includes('整张合成价表'));
    await page.getByText('保存的原始价表',{exact:true}).click();assert.equal(await page.locator('#page-root table tr').count(),3);
    assert.equal(await page.evaluate(()=>window.sourceScriptExecuted),undefined);
    await page.screenshot({path:new URL(`prices-${viewport.width}.png`,output).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
    await page.evaluate(()=>routingProbe.openPage('article','trendforce:price:dram'));
    await page.waitForFunction(()=>document.querySelector('#page-root').textContent.includes('旧价表原始快照'));
    await page.getByRole('button',{name:'查看AI硬件价格',exact:true}).click();
    await page.waitForFunction(()=>location.hash.includes('hardware/snapshot/'));
    await page.evaluate(()=>{routingProbe.setView('feed');routingProbe.applyFeedPlatform('media');});
    await page.waitForFunction(()=>document.querySelector('[aria-label="媒体来源"]')?.options.length===3);
    const source=page.locator('[aria-label="媒体来源"]');
    await source.focus();
    const geometry=await source.evaluate(el=>({width:el.getBoundingClientRect().width,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,font:parseFloat(getComputedStyle(el).fontSize),viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,scale:visualViewport.scale}));
    assert.ok(geometry.width>0 && geometry.left>=0 && geometry.right<=geometry.viewport+1,JSON.stringify(geometry));
    assert.ok(geometry.font>=16,JSON.stringify(geometry));assert.equal(geometry.overflow,false);assert.equal(geometry.scale,1);
    const channels=await page.locator('#media-channel-tabs').evaluate(el=>({width:el.clientWidth,content:el.scrollWidth,bottom:el.getBoundingClientRect().bottom}));
    assert.ok(channels.content<=channels.width+1,`clipped media channels ${viewport.width}`);
    assert.ok(channels.bottom<=await source.evaluate(el=>el.getBoundingClientRect().top),`source overlaps channel row ${viewport.width}`);
    await page.screenshot({path:new URL(`sources-${viewport.width}.png`,output).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
    await page.locator('[aria-label="媒体来源"]').selectOption('trendforce');
    await page.waitForFunction(()=>routingProbe.state.mediaSourceKey==='trendforce' && !routingProbe.state.mediaLoading);
    assert.equal(await page.locator('#platform-filters').getByText('TrendForce',{exact:true}).count(),0);
    await page.locator('[aria-label="媒体来源"]').selectOption('bbc');await page.locator('[aria-label="媒体来源"]').selectOption('trendforce');
    await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>routingProbe.state.mediaItems[0].articleKind),'report-intro');
    await page.evaluate(()=>routingProbe.openPage('article','report-fixture'));
    await page.waitForFunction(()=>document.querySelector('#page-root').textContent.includes('合成会员报告目录'));
    assert.match(await page.locator('#page-root').textContent(),/仅包含公开介绍/);assert.doesNotMatch(await page.locator('#page-root').textContent(),/正文完整/);
    if(viewport.width<700) {
      const buttons=page.locator('.reader-mobile-bar button');
      assert.match(await buttons.last().textContent(),/返回/);
      const boxes=await buttons.evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().x));
      assert.ok(boxes.at(-1)>boxes[0] && boxes.at(-1)>boxes[1]);
    }
    await page.screenshot({path:new URL(`media-${viewport.width}.png`,output).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
    await context.close();
  }
  assert.deepEqual(errors,[]);console.log('TrendForce routing UI verified at 1188/320/375/390/430/502px: integrated market rows, real line history, pending isolation, storage reference, snapshots and mobile reading.');
}finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
