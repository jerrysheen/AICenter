import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildXLikeExpression, createXLikeBrowserPort } from '../packages/connectors/src/x/like-browser.js';

if (!process.env.UIUX_RUNTIME_PACKAGE || !process.env.UIUX_BROWSER) throw Error('Set UIUX_RUNTIME_PACKAGE and UIUX_BROWSER to the Host runtime and Chromium.');
const { chromium } = createRequire(process.env.UIUX_RUNTIME_PACKAGE)('playwright');
const browser = await chromium.launch({headless:true,executablePath:process.env.UIUX_BROWSER});
const context = await browser.newContext();
const page = await context.newPage();
const fixture = liked => `<a data-testid="AppTabBar_Profile_Link" href="/fixture">Profile</a><button data-testid="SideNav_AccountSwitcher_Button">Account</button>
<article data-testid="tweet"><a href="/reply/status/456"><time>reply</time></a><button data-testid="like" onclick="window.replyClicks++">reply like</button></article>
<article data-testid="tweet"><a href="/author/status/123"><time>original</time></a><button data-testid="${liked?'unlike':'like'}" onclick="window.rootClicks++;this.dataset.testid='unlike'">root like</button></article>
<script>window.rootClicks=0;window.replyClicks=0;</script>`;
let remoteLiked = false;
await page.route('https://x.com/**',route=>route.fulfill({contentType:'text/html',body:fixture(remoteLiked)}));
const checks = [];
let server;
try {
  await page.goto('https://x.com/i/web/status/123');
  assert.equal((await page.evaluate(buildXLikeExpression('123'))).status,'unconfirmed');
  assert.equal((await page.evaluate(buildXLikeExpression('123',{click:true,expectedAccount:'other'}))).status,'blocked');
  await page.evaluate(buildXLikeExpression('123',{click:true,expectedAccount:'fixture'}));
  assert.deepEqual(await page.evaluate(()=>({root:rootClicks,reply:replyClicks})),{root:1,reply:0});
  await page.evaluate(buildXLikeExpression('123',{click:true}));
  assert.equal(await page.evaluate(()=>rootClicks),1);
  checks.push('exact original Post; account guard; already-liked preserves heart');
  await page.goto('https://x.com/i/web/status/123');
  await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<div role="dialog">Verify</div>'));
  assert.equal((await page.evaluate(buildXLikeExpression('123',{click:true}))).status,'blocked');
  assert.equal(await page.evaluate(()=>rootClicks),0);
  checks.push('visible dialog prevents click');
  const port=createXLikeBrowserPort({browserRuntime:{withSession:async(_,fn)=>fn({navigate:url=>page.goto(url),evaluate:expression=>page.evaluate(expression)})},delay:async()=>{}});
  remoteLiked=false;
  assert.equal((await port.like('123')).status,'unconfirmed');
  remoteLiked=true;
  assert.equal((await port.like('123')).status,'already-liked');
  checks.push('optimistic rollback never reports success; remote existing like preserved');

  server=createServer((req,res)=>{
    if(req.url==='/feed-interaction.js'){res.setHeader('Content-Type','text/javascript');return res.end(readFileSync('apps/web/public/feed-interaction.js'));}
    res.setHeader('Content-Type','text/html');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><main id="root"></main><p id="message" role="status"></p><script type="module">
      import {createFeedLikeAction} from '/feed-interaction.js';
      window.calls=[];window.fixtureStatus='liked';
      const api=async(path,options)=>{calls.push({path,method:options?.method || 'GET'});return options ? {jobId:'job'} : {job:{status:'completed',result:{status:fixtureStatus,accountHandle:'fixture'}}};};
      window.mount=()=>{const button=createFeedLikeAction({api,showToast:text=>document.getElementById('message').textContent=text,session:()=>({role:'desktop'}),createAction:({label,onClick})=>{const b=document.createElement('button');b.textContent=label;b.addEventListener('click',onClick);return b;}})({platform:'x',resourceId:'00000000-0000-4000-8000-000000000000'});document.getElementById('root').replaceChildren(button);};mount();
    </script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  for(const width of [390,1440]) {
    await page.setViewportSize({width,height:800});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole('button',{name:'在 X 点赞',exact:true}).click();
    await page.getByRole('button',{name:'已在 X 点赞',exact:true}).waitFor();
    assert.match(await page.locator('#message').textContent(),/重新打开原帖核验/);
    assert.equal(await page.getByRole('button').isDisabled(),true);
    assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='POST').length),1);
    await page.evaluate(()=>{fixtureStatus='unconfirmed';mount();});
    await page.getByRole('button',{name:'在 X 点赞',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('message').textContent.includes('尚未确认'));
    assert.equal(await page.getByRole('button').textContent(),'在 X 点赞');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    mkdirSync('.ai-data/feed-interaction-2026-10-07',{recursive:true});
    await page.screenshot({path:`.ai-data/feed-interaction-2026-10-07/${width}.png`});
  }
  checks.push('390/1440px user click; verified success; unknown result stays retryable');
  console.log(JSON.stringify({kind:'controlled-browser-fixture',checks}));
} finally { await context.close();await browser.close();if(server)await new Promise(resolve=>server.close(resolve)); }
