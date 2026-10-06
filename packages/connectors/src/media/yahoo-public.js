import { extractArticleText } from './article-html.js';
import { hostAllowed, isPublicHttpsUrl, stableArticleId } from './article-url.js';

// Fixed public DOM readers. Neither HTTP inputs nor page content supply executable code.
const PAGE = String.raw`(() => {
 const visible=e=>getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'&&e.getClientRects().length>0;
 const text=document.body?.innerText || '';
 const challenge=/access denied|just a moment|verify you are|security check|too many requests/i.test(document.title)||text.length<1500&&/captcha|verify you are human/i.test(text);
 return {url:location.href,title:document.title,challenge};
})()`;
export const YAHOO_MAIN_LIST_SELECTOR = 'main .stream section.story-item';
export const YAHOO_LIST_READER = String.raw`(() => {
 const visible=e=>getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'&&e.getClientRects().length>0;
 return Array.from(document.querySelectorAll('main .stream section.story-item')).filter(visible).filter(card=>!card.closest('aside,nav,[data-ad],[class*="sponsored"]')).slice(0,100).map((card,listPosition)=>{
  const a=card.querySelector('.title-row a[href][data-ylk*="sec:ai-topic-stream;"]');
  return {url:a?.href || '',title:a?.innerText.trim() || '',publisherName:card.querySelector('.publisher')?.innerText.trim() || '',authorName:card.querySelector('.author')?.innerText.trim() || '',listPosition,date:card.querySelector('time')?.getAttribute('datetime') || card.querySelector('.published-date')?.innerText.trim() || ''};
 });
})()`;
const ARTICLE = String.raw`(() => {
 const visible=e=>getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'&&e.getClientRects().length>0;
 const article=document.querySelector('article');
 const body=article?.querySelector('div.body');
 const text=article?.innerText || '';
 const paragraphs=body?Array.from(body.querySelectorAll('p,h2,h3,blockquote')).filter(visible).filter(e=>!e.closest('ul,ol,aside,nav,footer,form,[class*="related"],[class*="newsletter"]')).map(e=>({kind:e.tagName.toLowerCase(),text:e.innerText.trim()})).filter(p=>p.text):[];
 const first=body?.querySelector('p')?.innerText || '';
 const provider=article?.querySelector('a[data-ylk*="source:logo-provider"]');
 let providerName='';if(provider&&visible(provider)){try{providerName=JSON.parse(provider.getAttribute('data-yga') || '{}').yLinkText || '';}catch{}providerName=providerName||provider.querySelector('img')?.alt||provider.innerText;}
 const header=providerName+'\n'+(first&&text.includes(first)?text.slice(0,text.indexOf(first)):text.slice(0,800));
 const controls=Array.from(document.querySelectorAll('button.readmore-button')).filter(visible);
 const freeFlags=[];for(const node of document.querySelectorAll('script[type="application/ld+json"]')){try{const walk=v=>{if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object'){if(/Article/i.test(String(v['@type']||''))&&v.isAccessibleForFree!==undefined)freeFlags.push(v.isAccessibleForFree);if(v['@graph'])walk(v['@graph']);}};walk(JSON.parse(node.textContent));}catch{}}
 const wall=freeFlags.some(v=>v===false||v==='false')||/subscribe to read|sign in to continue|for subscribers only|this article is available to/i.test(text)||Array.from(document.querySelectorAll('[class*="paywall"],[class*="premium-content"]')).some(visible);
 const origin=Array.from(article?.querySelectorAll('a[href]') || []).find(a=>visible(a)&&/view (?:the )?original|original (?:article|story)/i.test(a.innerText));
 return {url:location.href,title:article?.querySelector('h1')?.innerText || document.title,publisherName:providerName.trim(),author:article?.querySelector('[class*="byline"]')?.innerText.trim() || '',header,wall,paragraphs,continues:controls.length>0,canExpand:controls.some(b=>b.innerText.trim()==='Story Continues'),date:article?.querySelector('time')?.getAttribute('datetime') || '',originUrl:origin?.href || '',tail:text.slice(-1800),visualEvidenceRequired:body?Array.from(body.querySelectorAll('img')).filter(visible).some(e=>/chart|graph|figure/i.test(e.alt || ''))||/\bcharts?\b/i.test(body.innerText):false};
})()`;
const EXPAND = `(() => {const b=Array.from(document.querySelectorAll('button.readmore-button')).find(e=>e.getClientRects().length>0&&e.innerText.trim()==='Story Continues');if(!b)return false;b.click();return true;})()`;
const escape = value => String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export function yahooPublisher(name) {
 const label=String(name || '').trim().slice(0,512);
 const key=label.toLowerCase().replace(/[^a-z0-9]/g,'');
 return {publisherName:label,publisherKey:key || 'unknown'};
}
const allowed = (url, hosts, kind='article') => {
 if(!isPublicHttpsUrl(url))return false;
 const parsed=new URL(url);
 return hostAllowed(parsed.hostname,hosts)&&parsed.hostname==='finance.yahoo.com'&&(kind==='list'?parsed.pathname==='/topic/economy/':/^(?:\/[a-z0-9-]+)*\/(?:articles|news)\/[a-z0-9-]+\.html$/i.test(parsed.pathname));
};
const failure = health => ({ok:false,health,status:null,bytes:0,body:'',redirectChain:[],note:health});

export function yahooListItems(cards, entry) {
 const seen=new Set();
 return cards.filter(c=>!c.sponsored&&allowed(c.url,entry.articleHosts)&&c.title&&c.title.length<=1000&&!seen.has(c.url)&&seen.add(c.url)).map((c,position)=>({
  externalId:stableArticleId(entry.sourceKey,{link:c.url}),sourceUrl:c.url,title:c.title,summary:'',
  ...yahooPublisher(c.publisherName),authorName:String(c.authorName || '').slice(0,512),listPosition:c.listPosition ?? position,
  publishedAt:Number.isFinite(Date.parse(c.date))?Date.parse(c.date):null,publishedAtRaw:c.date || '',
  discoveredVia:{sourceKey:'yahoo',url:c.url},
 }));
}

export function yahooVisibleArticle(snapshot, entry, options={}) {
 if(snapshot.wall)return {ok:false,reason:'paywall',text:''};
 const actual=yahooPublisher(snapshot.publisherName || String(snapshot.header || '').split('\n')[0].split(' · ')[0]);
 const expected=entry.expectedPublisherName ? yahooPublisher(entry.expectedPublisherName).publisherKey : entry.expectedPublisherKey;
 if(expected&&expected!=='unknown'&&actual.publisherKey!==expected)return {ok:false,reason:'publisher_mismatch',text:'',publisherName:actual.publisherName};
 if(!['reuters','bloomberg'].includes(actual.publisherKey))return {ok:false,reason:actual.publisherKey==='unknown'?'publisher_unknown':'publisher_adapter_pending',text:'',publisherName:actual.publisherName};
 const parts=(snapshot.paragraphs || []).filter(p=>!/^Most Read from|^©|^Copyright|^Read the original article|^View (?:the )?original/i.test(p.text));
 const html='<article itemprop="articleBody">'+parts.map(p=>`<${['p','h2','h3','blockquote'].includes(p.kind)?p.kind:'p'}>${escape(p.text)}</${['p','h2','h3','blockquote'].includes(p.kind)?p.kind:'p'}>`).join('')+'</article>';
 const article=extractArticleText(html,{sourceKey:entry.sourceKey,title:snapshot.title,maxBytes:options.maxBytes || 100_000});
 const end=actual.publisherKey==='bloomberg'?/©\s*\d{4}\s+Bloomberg/i.test(snapshot.tail || ''):/\((?:Reporting|Writing|Editing)[\s\S]{0,1000}\)|©\s*\d{4}\s+Reuters/i.test(snapshot.tail || '');
 if(article.contentLevel==='full'&&(snapshot.continues||!end))Object.assign(article,{contentLevel:'partial',reason:snapshot.continues?'continuation_unresolved':'coverage_unverified'});
 Object.assign(article,{canonical:snapshot.url,author:String(snapshot.author || '').slice(0,512),...actual,publishedAtRaw:snapshot.date || '',extractionMethod:'browser:public-reprint',visualEvidenceRequired:Boolean(snapshot.visualEvidenceRequired)});
 return article;
}

async function withPage(runtime, entry, url, callback, kind='article') {
 if(!runtime?.withSession)return failure('browser_unavailable');
 if(!allowed(url,[...entry.allowedHosts,...entry.articleHosts],kind))return failure('blocked_url');
 const deadline=Date.now()+40_000;
 const bounded=operation=>{
  if(Date.now()>=deadline)return Promise.reject(new Error('timeout'));
  let timer;
  return Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),deadline-Date.now());})]).finally(()=>clearTimeout(timer));
 };
 try {
  return await bounded(()=>runtime.withSession({purpose:'media-public-'+entry.sourceKey,focused:false},async session=>{
   if(Date.now()>=deadline)return failure('timeout');
   const limited={navigate:(...args)=>bounded(()=>session.navigate(...args)),evaluate:(...args)=>bounded(()=>session.evaluate(...args))};
   await limited.navigate(url,{timeoutMs:12000,waitUntil:'domcontentloaded'});
   const page=await limited.evaluate(PAGE,{timeoutMs:8000});
   if(!allowed(page.url,[...entry.allowedHosts,...entry.articleHosts],kind))return failure('blocked_redirect');
   if(page.challenge)return failure('blocked');
   await new Promise(resolve=>setTimeout(resolve,1000));
   return callback(limited,page);
  }));
 }catch(error){return failure(error.message==='timeout'?'timeout':'network');}
}

async function stableRead(session, script, stop=()=>false) {
 let previous='',snapshot;
 for(let i=0;i<4;i++) {
  snapshot=await session.evaluate(script,{timeoutMs:8000});
  const hash=JSON.stringify(snapshot);
  if(stop(snapshot)||i>0&&hash===previous)return {snapshot,stable:true};
  previous=hash;
  await new Promise(resolve=>setTimeout(resolve,400));
 }
 return {snapshot,stable:false};
}

export function readYahooList(runtime,entry) {
 return withPage(runtime,entry,entry.probeUrl,async(session,page)=>{
  if(entry.listSelector&&entry.listSelector!==YAHOO_MAIN_LIST_SELECTOR)return failure('needs_parser');
  const {snapshot:cards,stable}=await stableRead(session,YAHOO_LIST_READER);
  if(!stable)return failure('list_unstable');
  const items=yahooListItems(cards,entry);
  const observations=cards.slice(0,10).map((card,position)=>({...card,sourceUrl:card.url,listPosition:card.listPosition ?? position,
    excludedReason:card.sponsored?'sponsored':!allowed(card.url,entry.articleHosts)?'non_article_or_unregistered_path':!card.title?'missing_title':''}));
  return {ok:true,health:items.length?'ready':'empty',items,observations,status:null,bytes:Buffer.byteLength(JSON.stringify(cards)),redirectChain:[],finalUrl:page.url,note:''};
 },'list');
}

export function readYahooArticle(runtime,entry,input,options={}) {
 if(options.onRequest&&!options.onRequest())return Promise.resolve(failure('budget_deferred'));
 return withPage(runtime,entry,input.url,async(session,page)=>{
  let {snapshot,stable}=await stableRead(session,ARTICLE,s=>s.wall);
  if(!snapshot.wall&&snapshot.canExpand){await session.evaluate(EXPAND,{timeoutMs:8000});({snapshot,stable}=await stableRead(session,ARTICLE,s=>s.wall));}
  if(!allowed(snapshot.url,entry.articleHosts))return failure('blocked_redirect');
  const article=yahooVisibleArticle(snapshot,entry,{maxBytes:options.maxBodyBytes});
  if(article.ok&&!stable)Object.assign(article,{contentLevel:'partial',reason:'render_unstable'});
  return {ok:true,health:'ready',status:null,bytes:Buffer.byteLength(JSON.stringify(snapshot)),redirectChain:[],finalUrl:page.url,body:'',article,originUrl:allowed(snapshot.originUrl,['finance.yahoo.com'])?'':isPublicHttpsUrl(snapshot.originUrl)&&hostAllowed(new URL(snapshot.originUrl).hostname,['www.reuters.com','www.bloomberg.com'])?snapshot.originUrl:''};
 });
}
