import { icon } from './icons.js?v=dev';
import { decodeHtmlEntities } from './html-text.js?v=dev';
import { newsDayLabel, newsIngestAt, newsPublishedHint, newsRow, reportItemTime } from './news-list.js?v=dev';
import { mountInvestorDigest } from './investor-digest.js?v=dev';
import { shareTextBlocks, stripSharePlaceholders } from './share-card.js?v=dev';
import { inclusiveWindowInstant, zonedCalendarParts, zonedClockParts } from './shanghai-time.js?v=dev';
const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
function cleanSourceName(value) {
  const text=String(value ?? '').replace(/\s+/g,' ').trim();
  if(!text || text==='未知' || text==='来源' || text==='未提供') return '';
  return text;
}
function atHandle(value) {
  const name=cleanSourceName(value).replace(/^@+/,'');
  return name ? `@${name}` : '';
}
function httpUrl(item) {
  return [item?.sourceUrl, item?.originUrl, item?.url].map(cleanSourceName).find(value=>/^https?:\/\//i.test(value)) || '';
}
function accountFromUrl(url) {
  try {
    const parsed=new URL(url);
    const host=parsed.hostname.replace(/^www\./i,'').toLowerCase();
    if(host!=='x.com' && host!=='twitter.com') return '';
    const segment=decodeURIComponent(parsed.pathname.split('/').filter(Boolean)[0] || '');
    if(!segment || ['i','intent','share','home','search'].includes(segment.toLowerCase())) return '';
    return atHandle(segment);
  } catch {return '';}
}
export function sourceName(item) {
  const publisher=cleanSourceName(item?.publisher) || cleanSourceName(item?.publisherName);
  const publisherKey=cleanSourceName(item?.publisherKey);
  if(publisher) return publisher;
  if(publisherKey && publisherKey.toLowerCase()!=='x' && publisherKey.toLowerCase()!=='twitter') return publisherKey;
  const provider=String(item?.provider || item?.platform || '').toLowerCase();
  const handle=cleanSourceName(item?.authorHandle) || cleanSourceName(item?.handle) || cleanSourceName(item?.account) || cleanSourceName(item?.captureMetadata?.authorHandle);
  const url=httpUrl(item);
  if(provider==='x' || provider==='twitter') {
    if(handle) return atHandle(handle);
    const account=accountFromUrl(url);
    if(account) return account;
  }
  const author=cleanSourceName(item?.author) || cleanSourceName(item?.authorName) || cleanSourceName(item?.displayName);
  if(author) return author;
  if(handle) return atHandle(handle);
  const account=accountFromUrl(url);
  if(account) return account;
  if(!url) return '';
  try {return new URL(url).hostname.replace(/^www\./i,'');} catch {return '';}
}
export function sourceCaption(item) {
  const title=String(item?.title || '').trim() || '未命名';
  const name=sourceName(item);
  return name ? `${name} · ${title}` : title;
}
const button=(text,action)=>{const n=el('button',text);n.type='button';n.addEventListener('click',action);return n;};
const directions={finance:'金融与市场',policy:'时事与政策',tech:'科技与产业',other:'其他'};
const directionOrder=['finance','policy','tech','other'];
// Compatibility display mapping for pre-direction readers. New servers return the
// Instance mapping, including an explicit 'other', which takes precedence.
const previousDirections={macro:'finance',macro_commodity:'finance',crypto:'finance',market_us:'finance',market_cn:'finance',market_hk:'finance',geopolitics:'policy',
  ai:'tech',ai_compute:'tech',ai_model:'tech',ai_application:'tech',semiconductor:'tech',semiconductor_memory:'tech',semiconductor_optical:'tech',semiconductor_equipment:'tech',semiconductor_packaging:'tech',internet:'tech',software:'tech',gaming:'tech',graphics:'tech',auto:'tech',energy:'tech',communications:'tech',datacenter:'tech'};
const reasons={'needs-content':'正文待补','information-not-ready':'信息加工待完成','retryable-model-error':'模型暂时故障','queue-timeout':'排队超时','execution-timeout':'执行超时','budget-deferred':'预算延期','lease-conflict':'同版本加工中','invalid-output':'输出不合法','stale-policy':'规则已更新','prep-exhausted':'信息准备已停止'};
const HOUR_MS=3600000;
export function mergeHourGaps(startAts, step=HOUR_MS) {
  const starts=[...new Set((startAts||[]).filter(value=>Number.isFinite(value)))].sort((a,b)=>a-b);
  if(!starts.length) return [];
  const present=new Set(starts);
  const items=[];
  let gap=[];
  const flush=()=>{if(!gap.length)return;items.push({kind:'gap',startAt:gap[0],endAt:gap[gap.length-1],count:gap.length});gap=[];};
  for(let at=starts[0]; at<=starts[starts.length-1]; at+=step){
    if(present.has(at)){flush();items.push({kind:'hour',startAt:at});}
    else gap.push(at);
  }
  flush();
  return items.reverse();
}
export function formatHourGap(startHour, endHour, count) {
  const pad=value=>String(value).padStart(2,'0');
  const label=startHour===endHour ? `${startHour}点` : `${startHour}\u2013${endHour}点`;
  const detail=startHour===endHour
    ? `${pad(startHour)}:00`
    : `${pad(startHour)}:00\u2013${pad(endHour)}:00`;
  return {label, detail};
}
export function hourlyDelayHours(latestEndAt, now, step=HOUR_MS) {
  if(!Number.isFinite(latestEndAt) || !Number.isFinite(now)) return 0;
  const lag=now-latestEndAt;
  if(!(lag>2*step)) return 0;
  return Math.floor(lag/step);
}
export function resolveHourChoice(rows, requestedHour) {
  const list=Array.isArray(rows) ? rows.filter(row=>row && Number.isFinite(row.startAt)) : [];
  if(!list.length) return {startAt:null, shownHour:null, fallback:false, requestedHour:requestedHour??null};
  if(requestedHour==null) return {startAt:list[0].startAt, shownHour:list[0].hour??null, fallback:false, requestedHour:null};
  const match=list.find(row=>row.hour===requestedHour);
  if(match) return {startAt:match.startAt, shownHour:match.hour, fallback:false, requestedHour};
  let best=list[0], bestDist=Math.abs((best.hour??0)-requestedHour);
  for(const row of list){
    const dist=Math.abs((row.hour??0)-requestedHour);
    if(dist<bestDist || (dist===bestDist && row.startAt<best.startAt)){best=row;bestDist=dist;}
  }
  return {startAt:best.startAt, shownHour:best.hour??null, fallback:true, requestedHour};
}
export function hourStepSense(input, mobile) {
  const phone={'swipe-left':'earlier','swipe-right':'later',ArrowLeft:'later',ArrowRight:'earlier','wheel-left':'later','wheel-right':'earlier'};
  const desk={'swipe-left':'earlier','swipe-right':'later',ArrowLeft:'earlier',ArrowRight:'later','wheel-left':'earlier','wheel-right':'later'};
  return (mobile ? phone : desk)[input] || null;
}
export function createInformationTreePage(host) {
  let root,list,titleEl,coverageEl,statusRow,statusToggle,statusDetail,pastBtn,directionNav,hourChips,dayChips,tools,materialsBtn,tagPanel,tag,period,backIssues,notice,delayEl,hourRail,hourDay,hourNow,hourEarlier,hourYesterday,hourMore,issueEl,periodBar,periodMeta,periodLabel,periodPop,periodPrev,periodNext,mode='daily',direction=null,directionExplicit=false,showMaterials=false,selectedHourStart=0,dailyStart=0,openedId='',openedDirection='',manifest,selected=null,epoch=0,flight=0,settled=false,timer=0,dateFilter='',checking=null,pinnedReadingId='';
  let requests=new AbortController();
  let digestStop=()=>{};
  let periodDocBound=false;
  let rendering=0;
  function api(path, options){
    const ticket=flight;
    const signal=requests.signal;
    return host.api(path,{...(options||{}),signal}).then(data=>{
      if(ticket!==flight || signal.aborted) throw new DOMException('The operation was aborted.','AbortError');
      return data;
    });
  }
  const aborted=error=>error?.name==='AbortError';
  const readingOpen=new Set();
  const names=new Map(),cache=new Map(),nodeRequests=new Map(),editionCache=new Map(),editorialCache=new Map(),fullEditions=new Map(),editionLoads=new Map(),expanded=new Set(),positions=new Map(),memory={hourly:{},daily:{}};let viewKey='',nextManifest=null,informationRows=null,informationRequest=null,informationEpoch=0,session=0;
  const relationLabels={'same-event':'同一事件的后续进展','shared-theme':'共同主题','complementary':'相互补充','contradictory':'不同说法','supported-impact':'有依据的影响','unverified-link':'尚待验证的潜在联系'};
  const remember=n=>{if(!n)return;cache.delete(n.id);cache.set(n.id,n);while(cache.size>400)cache.delete(cache.keys().next().value);};
  const active=()=>root?.isConnected && root.classList.contains('tree-page') && (host.active?.() ?? true) && (host.session?.() ?? true);
  const timeZone=()=>manifest?.timezone || 'Asia/Shanghai';
  const parts=at=>{const date=zonedCalendarParts(at,timeZone()),clock=zonedClockParts(at,timeZone());return {month:String(date.month),day:String(date.day),hour:String(clock.hour).padStart(2,'0'),minute:String(clock.minute).padStart(2,'0')};};
  const stamp=at=>{const p=parts(at);return `${p.month}月${p.day}日 ${p.hour}:${p.minute}`;};
  const clock=at=>{const p=parts(at);return `${p.hour}:${p.minute}`;};
  const monthDay=at=>{const p=parts(at);return `${p.month}月${p.day}日`;};
  const day=at=>{const date=zonedCalendarParts(at,timeZone());const pad=n=>String(n).padStart(2,'0');return `${date.year}-${pad(date.month)}-${pad(date.day)}`;};
  const labeledDailyAt=at=>inclusiveWindowInstant(at,timeZone());
  const group=n=>manifest?.directions?.[n.tagId] || previousDirections[n.tagId] || 'other';
  const fetchManifest=(force=false)=>{if(host.loadTreeManifest)return host.loadTreeManifest({force});const endAt=Date.now()+1;return api(`/api/v1/reports/tree?view=index&startAt=${endAt-7*86400000}&endAt=${endAt}`);};
  function invalidateInformationIndex(){informationEpoch++;informationRows=null;informationRequest=null;}
  async function loadInformationIndex(){
    if(informationRows)return informationRows;
    if(!informationRequest){
      const endAt=Date.now()+1,cacheToken=informationEpoch;
      const pending=api(`/api/v1/reports/tree?view=index&information=1&startAt=${endAt-7*86400000}&endAt=${endAt}`).then(data=>{
        if(cacheToken===informationEpoch)informationRows=data.information || [];
        return cacheToken===informationEpoch ? (informationRows || []) : (data.information || []);
      }).finally(()=>{if(cacheToken===informationEpoch && informationRequest===pending)informationRequest=null;});
      informationRequest=pending;
    }
    return informationRequest;
  }
  function loadEditionDocument(id){
    if(fullEditions.has(id))return Promise.resolve(fullEditions.get(id));
    if(!editionLoads.has(id)){
      const seen=session;
      const pending=api(`/api/v1/reports/tree/edition?id=${encodeURIComponent(id)}`).then(data=>{
        if(seen!==session || !data?.edition?.id)return null;
        fullEditions.set(data.edition.id,data.edition);
        return data.edition;
      }).catch(error=>{if(aborted(error))return;return null;}).finally(()=>{if(editionLoads.get(id)===pending)editionLoads.delete(id);});
      editionLoads.set(id,pending);
    }
    return editionLoads.get(id);
  }
  async function materialIndex(selected){
    const rows=manifest?.information?.length ? manifest.information : await loadInformationIndex();
    return rows.filter(n=>{const at=n.eventAt ?? n.window?.startAt;return at>=selected.window.startAt && at<selected.window.endAt;});
  }
  const node=async id=>{
    if(cache.has(id))return cache.get(id);
    if(!nodeRequests.has(id)){const token=epoch;nodeRequests.set(id,api(`/api/v1/reports/tree/node?id=${encodeURIComponent(id)}`).then(data=>{if(token===epoch)remember(data.node);return data.node;}).finally(()=>nodeRequests.delete(id)));}
    return nodeRequests.get(id);
  };
  const copyCount=edition=>Array.isArray(edition?.roots) ? edition.roots.length : Number(edition?.rootCount)||0;
  async function editionNodes(edition) {
    if(!edition?.id || !copyCount(edition))return [];
    if(Array.isArray(edition.roots) && edition.roots.every(id=>cache.has(id)))return edition.roots.map(id=>cache.get(id));
    if(!editionCache.has(edition.id)) {
      const token=epoch,expected=copyCount(edition);
      const pending=api(`/api/v1/reports/tree/edition?id=${encodeURIComponent(edition.id)}`).catch(error=>{
        if(aborted(error))throw error;
        return Array.isArray(edition.roots) ? Promise.all(edition.roots.map(node)).then(nodes=>({edition,nodes})) : Promise.reject(new Error('刊期版本未能读取'));
      }).then(data=>{
        if(data.edition?.id!==edition.id || data.nodes?.length!==expected)throw new Error('刊期版本未能读取');
        if(token===epoch){data.nodes.forEach(remember);if(data.edition)fullEditions.set(data.edition.id,data.edition);}
        return data.nodes;
      }).catch(error=>{editionCache.delete(edition.id);throw error;});
      editionCache.set(edition.id,pending);while(editionCache.size>200)editionCache.delete(editionCache.keys().next().value);
    }
    return editionCache.get(edition.id);
  }
  function detailAction(iconName, label, onClick) {
    const n=document.createElement('button');n.type='button';n.setAttribute('aria-label',label);
    const glyph=document.createElement('span');glyph.innerHTML=icon(iconName);glyph.setAttribute('aria-hidden','true');
    n.append(glyph,el('span',label));
    if(label==='原文' || label==='打开原文' || label==='打开原站') n.dataset.behavior='source.original';
    n.addEventListener('click',onClick);return n;
  }
  function canReadSource(n) {return Boolean(n?.layer==='information' && n.sourceRefs?.length && host.readSavedSource);}
  const sourceFactCache=new Map();
  function sourceFields(item, type) {
    if(type==='media-body') return {publisher:item?.publisherName || item?.publisher || '', publisherName:item?.publisherName || '', publisherKey:item?.publisherKey || '', sourceUrl:item?.originUrl || item?.sourceUrl || ''};
    return {provider:item?.provider || '', author:item?.authorName || item?.author || '', authorName:item?.authorName || '', authorHandle:item?.authorHandle || item?.captureMetadata?.authorHandle || item?.handle || '', sourceUrl:item?.sourceUrl || '', displayName:item?.displayName || ''};
  }
  function sourceFacts(view) {
    if(!view || sourceName(view)) return Promise.resolve(view);
    const ref=(view.sourceRefs || []).find(item=>item?.type==='media-body' && item.id) || (view.sourceRefs || []).find(item=>item?.type==='content-item' && item.id);
    if(!ref) return Promise.resolve(view);
    const key=`${ref.type}:${ref.id}`;
    if(!sourceFactCache.has(key)) {
      const pending=(ref.type==='media-body'
        ? api(`/api/v1/feed/media/article?externalId=${encodeURIComponent(ref.id)}`).then(data=>data?.item)
        : api(`/api/v1/content-items/${encodeURIComponent(ref.id)}`).then(data=>data?.item)
      ).then(item=>item ? sourceFields(item, ref.type) : {}).catch(()=>({}));
      sourceFactCache.set(key, pending);
    }
    return sourceFactCache.get(key).then(extra=>{
      const next={...view, title:view?.title || extra?.title};
      for(const [key,value] of Object.entries(extra || {})) if(key!=='title' && cleanSourceName(value)) next[key]=value;
      if(extra?.provider) next.provider=extra.provider;
      return next;
    });
  }
  function showSourceCaption(row, view) {
    if(!row) return;
    row.textContent=sourceCaption(view || {});
    if(sourceName(view)) return;
    sourceFacts(view).then(next=>{if(row.parentNode) row.textContent=sourceCaption(next);}).catch(()=>{});
  }
  function sourceJump(count, list) {
    const mark=button(`${count} 个来源 ↓`, event=>{event?.stopPropagation?.();highlightSource(list);});
    mark.className='reading-ref reading-source-jump';guardTap(mark);return mark;
  }
  function guardTap(node) {
    const stop=event=>event?.stopPropagation?.();
    node.addEventListener('touchstart', stop);
    node.addEventListener('pointerdown', stop);
  }
  function placeAfter(anchor, mark) {
    const parent=anchor?.parentNode;
    if(parent && anchor.nextSibling) parent.insertBefore(mark, anchor.nextSibling);
    else if(parent?.append) parent.append(mark);
    else anchor?.append?.(mark);
  }
  function highlightSource(row) {
    if(!row) return;
    row.classList.add('is-source-hit');
    if(typeof row.scrollIntoView==='function') row.scrollIntoView({block:'nearest'});
    setTimeout(()=>row.classList.remove('is-source-hit'),1600);
  }
  function findSourceRow(list, id) {
    return [...(list?.children || [])].find(row=>row?.dataset?.sourceId===id) || null;
  }
  function openExternal(url) {
    const anchor=document.createElement('a');
    anchor.href=url;anchor.target='_blank';anchor.rel='noopener';
    if(typeof anchor.click==='function') anchor.click();
  }
  async function openTreeSource(view) {
    try {
      if(canReadSource(view)) return await host.readSavedSource(view);
      const url=String(view?.sourceUrl || '').trim();
      if(/^https?:\/\//.test(url)) return openExternal(url);
      host.toast?.('这份材料暂无站内文章');
    } catch(error) {if(!aborted(error)) host.toast?.(error?.message || '站内原文未能读取');}
  }
  async function openNodeSource(id) {
    try {const saved=await node(id);if(saved) return openTreeSource(saved);}
    catch(error) {if(aborted(error)) return;}
    host.toast?.('来源暂时读不到');
  }
  async function openReadingSource(item) {
    let view=item;
    if(item?.nodeId) {try {view=await node(item.nodeId) || item;} catch(error) {if(aborted(error)) return;}}
    return openTreeSource(view);
  }
  function shareLines(value) {
    return shareTextBlocks(stripSharePlaceholders(value));
  }
  function shareReadingItem(item, edition) {
    if(typeof host.shareCard!=='function') return;
    const run=async()=>{
      let saved=null;
      if(item?.nodeId) {try {saved=await node(item.nodeId);} catch(error) {if(aborted(error)) return;}}
      const view=saved || item;
      const summary=String(view.text || view.summary || item.text || item.summary || '').trim();
      const body=summary ? '' : String(view.body || item.body || '').trim();
      const start=edition?.window?.startAt;
      const end=edition?.window?.endAt;
      const time=start ? `${monthDay(start)} ${clock(start)}${end ? `–${clock(end)}` : ''}` : '';
      return host.shareCard({
        title:stripSharePlaceholders(view.title || item.title || ''),
        source:'小时报',
        time,
        paragraphs:shareLines(summary || body),
      });
    };
    return run();
  }
  function shareTreeNode(n, edition, sourceLabel) {
    if(typeof host.shareCard!=='function' || !n) return;
    const summary=String(n.text || n.summary || '').trim();
    const body=String(n.body || '').trim();
    const paragraphs=shareLines(summary);
    if(body && stripSharePlaceholders(body)!==stripSharePlaceholders(summary)) paragraphs.push(...shareLines(body));
    const at=reportItemTime(n, edition);
    return host.shareCard({
      title:stripSharePlaceholders(n.title || ''),
      source:sourceLabel,
      time:at ? stamp(at) : '',
      paragraphs,
    });
  }
  function shareDailyArticle(article, edition) {
    if(typeof host.shareCard!=='function' || !article) return;
    const paragraphs=[];
    if(article.lead) paragraphs.push(...shareLines(article.lead));
    for(const section of article.sections || []) {
      if(section.heading && section.kind!=='other') paragraphs.push(stripSharePlaceholders(section.heading));
      for(const text of section.paragraphs || []) paragraphs.push(...shareLines(text));
    }
    const at=edition?.window?.endAt ? labeledDailyAt(edition.window.endAt) : edition?.window?.startAt;
    return host.shareCard({
      title:stripSharePlaceholders(article.title || ''),
      source:'日报',
      time:at ? `${monthDay(at)}日报` : '',
      paragraphs:paragraphs.filter(Boolean),
    });
  }
  function shareAction(onClick) {
    const share=button('分享', event=>{event?.stopPropagation?.();return onClick();});
    share.className='text-button news-share';
    return share;
  }
  function toggleReadingFold(fold) {
    if(!fold) return;
    fold.open=!fold.open;
    if(typeof fold.dispatchEvent==='function') return;
    return fold.listeners?.toggle?.[0]?.();
  }
  function bindDirectSource(article, leaf) {
    article.classList.add('is-direct');
    const open=event=>{event?.stopPropagation?.();return openTreeSource(leaf);};
    const title=article.querySelector('h3');
    const text=article.querySelector('.tree-text');
    for(const part of [title, text]) {
      if(!part) continue;
      part.classList.add('is-direct-source');
      guardTap(part);
      part.addEventListener('click', open);
    }
    const mark=button('〔1〕', open);mark.className='reading-ref';guardTap(mark);
    (text || title || article).append(mark);
  }
  function bindSourceList(article, leaves) {
    const list=el('div','','reading-source-list');
    leaves.forEach(leaf=>{
      const row=button(sourceCaption(leaf), ()=>openTreeSource(leaf));
      row.className='reading-source-row';row.dataset.sourceId=leaf.id;guardTap(row);list.append(row);
      showSourceCaption(row, leaf);
    });
    article.append(list);
    const host=article.querySelector('.tree-text') || article.querySelector('h3') || article;
    host.append(sourceJump(leaves.length, list));
  }
  async function loadLeaves(n, token, depth=0) {
    if(!n || token!==epoch || depth>4) return [];
    if(n.layer==='information') return [n];
    let children=null;
    try {
      if(Array.isArray(n.children) && n.children.length && n.children.every(id=>cache.has(id))) children=n.children.map(id=>cache.get(id));
      else {
        const data=await api(`/api/v1/reports/tree/children?id=${encodeURIComponent(n.id)}`);
        if(token!==epoch) return [];
        children=Array.isArray(data?.children) ? data.children : [];
        children.forEach(remember);
      }
    } catch(error) {if(aborted(error)) return [];return null;}
    const leaves=[];
    for(const child of children) {
      const nested=await loadLeaves(child, token, depth+1);
      if(nested===null) return null;
      leaves.push(...nested);
    }
    return leaves;
  }
  function syncReadingChrome(spec) {
    root?.querySelectorAll('.tree-reading-chrome').forEach(node=>node.remove());
    if(!root)return;
    if(!spec){root.classList.remove('is-reading');return;}
    root.classList.add('is-reading');
    const toolbar=el('div','','reading-toolbar tree-reading-chrome');
    const back=detailAction('chevron-left',spec.label,spec.onBack);back.classList.add('reading-back');toolbar.append(back);
    const mobile=el('div','','reader-mobile-bar tree-reading-chrome');mobile.setAttribute('aria-label','阅读操作');
    if(canReadSource(spec.node)){
      const openSource=()=>host.readSavedSource(spec.node);
      toolbar.append(detailAction('newspaper','原文',openSource));
      mobile.append(detailAction('newspaper','原文',openSource));
    }
    const mobileBack=detailAction('chevron-left',spec.label,spec.onBack);mobileBack.classList.add('is-back');mobile.append(mobileBack);
    if(list && list.parentNode===root) root.insertBefore(toolbar,list);
    else root.append(toolbar);
    root.append(mobile);
  }
  function closeHour(){openedId='';pinnedReadingId='';return render();}
  function closeDaily(){openedId='';openedDirection='';return render();}
  function restoreScroll(opened) {
    if(!active())return;
    if(positions.has(viewKey))window.scrollTo({top:positions.get(viewKey),behavior:'instant'});
    else if(opened)window.scrollTo({top:0,behavior:'instant'});
  }
  async function card(n,token,options={}) {
    const article=el('article','','tree-card');article.dataset.nodeId=n.id;article.dataset.layer=n.layer;
    article.append(el('h3',decodeHtmlEntities(n.title)),el('p',decodeHtmlEntities(n.text),'tree-text'));
    if(n.layer==='information' && n.body && n.body!==n.text) {const body=el('details','','tree-body');body.append(el('summary','中文正文'),el('p',decodeHtmlEntities(n.body),'tree-text'));article.append(body);}
    if(n.layer==='information') {if(canReadSource(n)) bindDirectSource(article, n);else if(options.actions!==false && /^https?:\/\//.test(n.sourceUrl || '')) bindDirectSource(article, n);}
    else {
      const paint=leaves=>{
        if(leaves===null) {
          const retry=button('来源读取失败，重试', async()=>{retry.disabled=true;const again=await loadLeaves(n, token);if(token!==epoch)return;retry.remove();paint(again);});
          article.append(retry);return;
        }
        if(leaves.length===1) bindDirectSource(article, leaves[0]);
        else if(leaves.length>1) bindSourceList(article, leaves);
      };
      paint(await loadLeaves(n, token));
    }
    return article;
  }
  const choice=r=>r?.edition || r?.attempt;
  function editionRows(data=manifest) {
    if(!data)return [];
    const rows=mode==='daily' ? data.days : data.hours;
    return (rows || []).filter(r=>{const chosen=choice(r);return chosen && (!dateFilter || day(mode==='daily' ? labeledDailyAt(chosen.window.endAt) : chosen.window.startAt)===dateFilter);});
  }
  function issueTitle(edition) {
    if(mode==='daily') return `${monthDay(labeledDailyAt(edition.window.endAt))}日报`;
    const range=`${clock(edition.window.startAt)}—${clock(edition.window.endAt)}小时报`;
    return day(edition.window.startAt)===day(Date.now()) ? range : `${monthDay(edition.window.startAt)} ${range}`;
  }
  function issueCoverage(edition) {
    if(mode==='hourly') return '本小时新增变化';
    if(day(labeledDailyAt(edition.window.endAt))===day(Date.now()) && day(edition.window.startAt)!==day(labeledDailyAt(edition.window.endAt))) return `覆盖昨日${clock(edition.window.startAt)}至今日${clock(edition.window.endAt)}`;
    return `覆盖${stamp(edition.window.startAt)}至${stamp(edition.window.endAt)}`;
  }
  function rememberIssue() {
    if(!selected || (mode!=='hourly' && mode!=='daily')) return;
    memory[mode]={startAt:selected.window.startAt,direction,directionExplicit,tag:tag?.value || '*'};
  }
  function periods() {
    const rows=editionRows().map(choice).filter(Boolean);
    period.replaceChildren(...rows.map(r=>new Option(stamp(r.window.startAt),String(r.window.startAt))));
    const wanted=memory[mode]?.startAt;
    if(wanted && rows.some(r=>r.window.startAt===wanted)) period.value=String(wanted);
    else if(rows.some(r=>r.window.startAt===selected?.window.startAt)) period.value=String(selected.window.startAt);
    else {const usable=rows.find(r=>copyCount(r));if(usable)period.value=String(usable.window.startAt);}
  }
  function setPrimary() {
    for(const tab of root.querySelectorAll('[data-mode]')){const on=tab.dataset.mode===mode;tab.setAttribute('aria-pressed',String(on));tab.setAttribute('aria-selected',String(on));tab.classList.toggle('is-active',on);}
    materialsBtn.setAttribute('aria-pressed',String(showMaterials));
  }
  function switchMode(next) {
    closePeriodPop();
    if(next===mode && !showMaterials) return;
    if(next!==mode) rememberIssue();
    mode=next;showMaterials=false;openedId='';
    if(mode==='daily') clearHourQuery();
    const saved=memory[mode] || {};
    direction=saved.direction ?? null;directionExplicit=Boolean(saved.directionExplicit);
    if(tag) tag.value=saved.tag || '*';
    selected=null;periods();setPrimary();return render();
  }
  function hourRows() {
    return (manifest?.hours || []).map(choice).filter(Boolean).sort((a,b)=>b.window.startAt-a.window.startAt);
  }
  let hourStripKey='',seenIds=[],seen=new Set(),opening={id:'',ticket:0},openTicket=0;
  const readingCache=new Map(), readingLoads=new Map(), openGaps=new Set();
  let readingIndex, pendingClockHour=null, pendingNodeId='', hourFallbackText='', hourRevealEarlier=false, slowTimer=0;
  const storage=()=>{try{return localStorage;}catch{return null;}};
  const seenKey=()=>{const session=host.session?.();const identity=session?`${session.role||'user'}:${session.device?.id||'desktop'}`:'local';return `ai-center.hourly-seen.${encodeURIComponent(identity)}`;};
  const editionIdOk=id=>typeof id==='string' && /^edition:[A-Za-z0-9:_-]{8,180}$/.test(id);
  const hourHasCopy=edition=>copyCount(edition)>0;
  function loadSeen(){
    seen=new Set();seenIds=[];
    try{const raw=JSON.parse(storage()?.getItem(seenKey())||'[]');if(Array.isArray(raw))for(const id of raw)if(editionIdOk(id)&&!seen.has(id)){seen.add(id);seenIds.push(id);}}catch{}
    if(seenIds.length>400)for(const old of seenIds.splice(0,seenIds.length-400))seen.delete(old);
  }
  function persistSeen(){try{storage()?.setItem(seenKey(),JSON.stringify(seenIds.slice(-400)));}catch{}}
  function hourUnread(edition){return hourHasCopy(edition)&&editionIdOk(edition.id)&&edition.id!==opening.id&&!seen.has(edition.id);}
  function ensureSelectedHour(rows){
    if(!selectedHourStart || !rows.some(item=>item.window.startAt===selectedHourStart)) selectedHourStart=rows[0]?.window.startAt || 0;
    return rows.find(item=>item.window.startAt===selectedHourStart) || null;
  }
  function beginOpening(edition){
    opening={id:hourHasCopy(edition)&&editionIdOk(edition.id)&&!seen.has(edition.id)?edition.id:'',ticket:++openTicket};
    return opening;
  }
  function finishOpening(claim,ok){
    if(!claim || claim.ticket!==opening.ticket)return;
    if(ok && claim.id && editionIdOk(claim.id) && !seen.has(claim.id)){seen.add(claim.id);seenIds.push(claim.id);if(seenIds.length>400)for(const old of seenIds.splice(0,seenIds.length-400))seen.delete(old);persistSeen();}
    opening={id:'',ticket:claim.ticket};
  }
  function paintHourUnread(rows=hourRows()){
    const unread=new Set(rows.filter(hourUnread).map(item=>String(item.window.startAt)));
    for(const chip of hourChips?.children || []){
      const on=unread.has(chip.dataset.start);
      chip.classList.toggle('is-unread',on);
      if(on)chip.setAttribute('aria-label',`${chip.dataset.label || chip.textContent}，未读`);else if(chip.dataset.start) chip.removeAttribute('aria-label');
    }
    const tab=root?.querySelector?.('[data-mode="hourly"]');
    if(!tab)return;
    tab.classList.toggle('is-unread',unread.size>0);
    if(unread.size)tab.setAttribute('aria-label','小时报，未读');else tab.removeAttribute('aria-label');
  }
  function hourClock(at){return Number(parts(at).hour);}
  function hourStripMobile(){
    try{const media=globalThis.window?.matchMedia;if(typeof media!=='function')return false;return media('(max-width: 700px)').matches===true;}catch{return false;}
  }
  function replaceLocationHash(hash){
    const hist=globalThis.history, loc=globalThis.location;
    if(!hist || typeof hist.replaceState!=='function' || !loc || loc.hash===hash)return;
    try{hist.replaceState({aiCenter:true,hash},'',`${loc.pathname||''}${loc.search||''}${hash}`);}catch{}
  }
  function writeHourHash(startAt){
    if(!startAt || mode!=='hourly')return;
    const hh=String(hourClock(startAt)).padStart(2,'0');
    const date=day(startAt), today=day(Date.now());
    const node=pendingNodeId ? `&node=${encodeURIComponent(pendingNodeId)}` : '';
    const hash=date===today ? `#report?hour=${hh}${node}` : `#report/${date}?hour=${hh}${node}`;
    replaceLocationHash(hash);
    host.syncHour?.(hourClock(startAt), {node: pendingNodeId || ''});
  }
  function focusNode(id){pendingNodeId=String(id || '');}
  function consumePendingNode(){
    const id=pendingNodeId;
    if(!id || !list?.querySelectorAll) return;
    const row=[...list.querySelectorAll('[data-node-id]')].find(node=>node.dataset.nodeId===id);
    if(!row) return;
    pendingNodeId='';
    host.syncHour?.(hourClock(selectedHourStart), {node:''});
    row.scrollIntoView?.({block:'center'});
  }
  function clearHourQuery(){
    host.syncHour?.(null);
    const loc=globalThis.location;
    if(!loc?.hash || !/[?&]hour=/.test(loc.hash))return;
    const [path, query='']=loc.hash.slice(1).split('?');
    const params=new URLSearchParams(query);
    params.delete('hour');
    const rest=params.toString();
    replaceLocationHash(`#${path}${rest ? `?${rest}` : ''}`);
  }
  function closePeriodPop(){
    if(!periodPop) return;
    periodPop.hidden=true;
    periodLabel?.setAttribute('aria-expanded','false');
  }
  function setPeriodMeta(text){
    if(!periodMeta) return;
    const value=text || '';
    periodMeta.textContent=value;
    periodMeta.hidden=!value;
  }
  function periodCaption(){
    if(mode==='hourly'){
      const edition=hourRows().find(item=>item.window.startAt===selectedHourStart);
      if(!edition) return '选择小时';
      return `${clock(edition.window.startAt)}\u2013${clock(edition.window.endAt)}`;
    }
    const editions=recentDailies();
    const edition=editions.find(item=>item.window.startAt===dailyStart) || editions[0];
    if(!edition) return '选择日期';
    return monthDay(labeledDailyAt(edition.window.endAt));
  }
  function periodEnds(){
    if(mode==='hourly' && !showMaterials && !openedId){
      const rows=focusedHourRows(hourRows());
      const index=rows.findIndex(item=>item.window.startAt===selectedHourStart);
      return {earlier:index>=0 && index<rows.length-1, later:index>0};
    }
    if(mode==='daily' && !showMaterials && !openedId){
      const editions=recentDailies();
      const index=editions.findIndex(item=>item.window.startAt===dailyStart);
      return {earlier:index>=0 && index<editions.length-1, later:index>0};
    }
    return {earlier:false, later:false};
  }
  function syncPeriodChrome(){
    if(!periodBar) return;
    const feed=(mode==='hourly' || mode==='daily') && !showMaterials && !openedId;
    periodBar.hidden=!feed;
    if(periodLabel) periodLabel.textContent=periodCaption();
    const ends=periodEnds();
    if(periodPrev) periodPrev.disabled=!ends.earlier;
    if(periodNext) periodNext.disabled=!ends.later;
  }
  function stepDaily(which){
    if(mode!=='daily' || showMaterials || openedId || (which!=='earlier' && which!=='later')) return;
    const editions=recentDailies();
    const index=editions.findIndex(item=>item.window.startAt===dailyStart);
    if(index<0) return;
    const next=which==='earlier' ? editions[index+1] : editions[index-1];
    if(!next) return;
    dailyStart=next.window.startAt;openedId='';openedDirection='';
    return render();
  }
  function stepPeriod(which){
    closePeriodPop();
    if(mode==='hourly') return stepHour(which);
    return stepDaily(which);
  }
  function selectHour(startOrHour, source){
    closePeriodPop();
    const clockPick=Number.isInteger(startOrHour) && startOrHour>=0 && startOrHour<=23;
    if (source === 'user') host.track?.('report.hour', { hour: clockPick ? startOrHour : hourClock(startOrHour) });
    if(mode!=='hourly'){mode='hourly';showMaterials=false;}
    openedId='';pinnedReadingId='';readingOpen.clear();
    if(!clockPick) pendingNodeId='';
    if(clockPick) pendingClockHour=startOrHour;
    else {pendingClockHour=null;hourFallbackText='';selectedHourStart=startOrHour;writeHourHash(startOrHour);}
    return render();
  }
  function hourNavOpen(){return active() && mode==='hourly' && !showMaterials && !openedId;}
  function focusedHourRows(rows){
    if(dateFilter) return rows.filter(item=>day(item.window.startAt)===dateFilter);
    if(!rows.length) return [];
    const selectedRow=rows.find(item=>item.window.startAt===selectedHourStart) || rows[0];
    const focusDay=day(selectedRow.window.startAt);
    return rows.filter(item=>day(item.window.startAt)===focusDay);
  }
  function applyClockRequest(rows){
    if(pendingClockHour==null) return;
    const requested=pendingClockHour;
    pendingClockHour=null;
    const choice=resolveHourChoice(rows.map(item=>({startAt:item.window.startAt,hour:hourClock(item.window.startAt)})), requested);
    if(choice.startAt) selectedHourStart=choice.startAt;
    hourFallbackText=choice.fallback ? `${String(requested).padStart(2,'0')}:00 那期还没生成，已显示 ${String(choice.shownHour).padStart(2,'0')}:00` : '';
  }
  // earlier/later are time order. Rows are newest first, so earlier is the next index.
  function stepHour(which){
    if(!hourNavOpen() || (which!=='earlier' && which!=='later'))return;
    const rows=focusedHourRows(hourRows());
    const index=rows.findIndex(item=>item.window.startAt===selectedHourStart);
    if(index<0)return;
    const next=which==='earlier' ? rows[index+1] : rows[index-1];
    if(!next)return;
    return selectHour(next.window.startAt, 'user');
  }
  function stepFromInput(input){
    const sense=hourStepSense(input, hourStripMobile());
    if(sense) return stepHour(sense);
  }
  const hourSwipeMin=48,hourSwipeRatio=1.5;
  const hourSwipeIntent=(dx,dy)=>Math.abs(dx)>=hourSwipeMin && Math.abs(dx)>Math.abs(dy)*hourSwipeRatio;
  function typingTarget(event){const node=event.target;if(!node?.tagName)return false;return node.tagName==='INPUT' || node.tagName==='TEXTAREA' || node.tagName==='SELECT' || node.isContentEditable;}
  function onHourKey(event){
    if(event.key==='Escape'){closePeriodPop();return;}
    if(event.key!=='ArrowLeft' && event.key!=='ArrowRight')return;
    if(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)return;
    if(!hourNavOpen() || typingTarget(event))return;
    if(event.cancelable!==false)event.preventDefault();
    return stepFromInput(event.key);
  }
  function bindHourSwipe(surface){
    if(surface.style)surface.style.touchAction='pan-y';
    let gesture=null,wheelAcc=0,wheelMoved=0,wheelLock=0;
    surface.addEventListener('touchstart',event=>{
      if(!hourNavOpen() || event.touches?.length!==1){gesture=null;return;}
      const touch=event.touches[0];gesture={x:touch.clientX,y:touch.clientY,locked:false};
    },{passive:true});
    surface.addEventListener('touchmove',event=>{
      if(!gesture || event.touches?.length!==1)return;
      const dx=event.touches[0].clientX-gesture.x,dy=event.touches[0].clientY-gesture.y;
      if(gesture.locked){if(event.cancelable!==false)event.preventDefault();return;}
      if(Math.abs(dx)<12 && Math.abs(dy)<12)return;
      if(Math.abs(dx)>Math.abs(dy)*hourSwipeRatio){gesture.locked=true;if(event.cancelable!==false)event.preventDefault();}
      else if(Math.abs(dy)>=Math.abs(dx))gesture=null;
    },{passive:false});
    surface.addEventListener('touchend',event=>{
      const current=gesture;gesture=null;const touch=event.changedTouches?.[0];if(!current || !touch)return;
      const dx=touch.clientX-current.x,dy=touch.clientY-current.y;if(!hourSwipeIntent(dx,dy))return;
      return stepFromInput(dx<0?'swipe-left':'swipe-right');
    },{passive:true});
    surface.addEventListener('touchcancel',()=>{gesture=null;},{passive:true});
    surface.addEventListener('wheel',event=>{
      if(!hourNavOpen())return;
      const dx=event.deltaX||0,dy=event.deltaY||0;
      if(!(Math.abs(dx)>Math.abs(dy)*hourSwipeRatio)){wheelAcc=0;return;}
      if(event.cancelable!==false)event.preventDefault();
      const now=Date.now();if(now<wheelLock)return;
      if(now-wheelMoved>450)wheelAcc=0;
      wheelMoved=now;wheelAcc+=dx;if(Math.abs(wheelAcc)<hourSwipeMin)return;
      const sense=hourStepSense(wheelAcc>0?'wheel-right':'wheel-left', hourStripMobile());
      wheelAcc=0;wheelLock=now+450;return sense ? stepHour(sense) : undefined;
    },{passive:false});
  }
  function clearHourSlow(){if(slowTimer){clearTimeout(slowTimer);slowTimer=0;}}
  function armHourSlow(token){
    clearHourSlow();
    slowTimer=setTimeout(()=>{
      if(token!==epoch || !list?.querySelector?.('.tree-hour-skeleton'))return;
      list.replaceChildren(button('读取较慢 · 重试',()=>render()));
    },10000);
  }
  function hourSkeleton(){
    const box=el('div','','tree-hour-skeleton');box.setAttribute('aria-busy','true');
    box.append(el('span','','tree-hour-skeleton-line'),el('span','','tree-hour-skeleton-line'),el('span','','tree-hour-skeleton-line'));
    return box;
  }
  function chipText(edition){
    return clock(edition.window.startAt);
  }
  function paintRail(rows){
    const focus=rows[0];
    if(!hourDay || !focus) return;
    const focusDay=day(focus.window.startAt), today=day(Date.now()), yesterday=day(Date.now()-86400000);
    hourDay.textContent=focusDay===today ? '今天' : focusDay===yesterday ? '昨天' : monthDay(focus.window.startAt);
    if(hourNow) hourNow.hidden=focusDay!==today;
    if(hourYesterday){
      const prev=day(focus.window.startAt-86400000);
      hourYesterday.textContent=prev===yesterday ? '昨天 ›' : `${monthDay(focus.window.startAt-86400000)} ›`;
    }
  }
  function paintDelay(){
    if(!delayEl) return;
    delayEl.hidden=true;
    delayEl.replaceChildren();
  }
  function paintHourStrip(rows, index=readingIndex instanceof Map ? readingIndex : null) {
    const focused=focusedHourRows(rows);
    ensureSelectedHour(focused.length ? focused : rows);
    const chosen=focused.length ? focused : rows;
    const merged=mergeHourGaps(chosen.map(item=>item.window.startAt));
    const byStart=new Map(chosen.map(item=>[item.window.startAt,item]));
    const display=merged.map(item=>item.kind==='hour' ? {kind:'hour',edition:byStart.get(item.startAt)} : item).filter(item=>item.kind!=='hour' || item.edition);
    const selectedIndex=display.findIndex(item=>item.kind==='hour' && item.edition.window.startAt===selectedHourStart);
    if(selectedIndex>=8) hourRevealEarlier=true;
    const visible=hourRevealEarlier || display.length<=8 ? display : display.slice(0,8);
    const indexKey=index instanceof Map ? [...index.keys()].sort((a,b)=>a-b).join(',') : '';
    const key=`${visible.map(item=>item.kind==='hour'?item.edition.window.startAt:`g${item.startAt}`).join(',')}|${[...openGaps].join(',')}|${indexKey}|${hourRevealEarlier}`;
    if(key!==hourStripKey && hourChips){
      hourStripKey=key;hourChips.replaceChildren();
      for(const item of visible){
        if(item.kind==='gap'){
          const view=formatHourGap(hourClock(item.startAt), hourClock(item.endAt), item.count);
          const gapKey=`${item.startAt}:${item.endAt}`;
          const open=openGaps.has(gapKey);
          const control=button(open?view.detail:view.label,()=>{if(openGaps.has(gapKey))openGaps.delete(gapKey);else openGaps.add(gapKey);hourStripKey='';paintHourStrip(hourRows(), readingIndex instanceof Map ? readingIndex : null);});
          control.className='tree-hour-gap';control.dataset.gap=gapKey;hourChips.append(control);continue;
        }
        const edition=item.edition;
        const chip=button(chipText(edition, index),()=>selectHour(edition.window.startAt, 'user'));
        chip.className='chip-tab';chip.dataset.start=String(edition.window.startAt);chip.dataset.label=clock(edition.window.startAt);hourChips.append(chip);
      }
    }
    for(const chip of hourChips?.children || []){
      if(!chip.dataset.start) continue;
      const on=chip.dataset.start===String(selectedHourStart);
      chip.classList.toggle('is-active',on);
      if(on && typeof chip.scrollIntoView==='function') chip.scrollIntoView({block:'nearest',inline:'nearest'});
    }
    if(hourEarlier) hourEarlier.hidden=display.length<=8;
    paintRail(chosen);
    paintHourUnread(rows);
    syncPeriodChrome();
  }
  function syncHourChrome() {
    const hourly=mode==='hourly' && !showMaterials;
    const daily=mode==='daily' && !showMaterials;
    const discussion=mode==='discussion';
    root?.classList.toggle('is-hourly', hourly);
    root?.classList.toggle('is-discussion', discussion);
    if(hourChips) hourChips.hidden=!hourly || Boolean(openedId);
    if(hourRail) hourRail.hidden=!hourly || Boolean(openedId);
    if(delayEl && !hourly) delayEl.hidden=true;
    if(dayChips) dayChips.hidden=!daily;
    if(issueEl) issueEl.hidden=hourly || discussion || (daily && !openedId);
    if(!hourly) setPeriodMeta('');
    syncPeriodChrome();
    if(directionNav) directionNav.hidden=hourly || daily || discussion;
    if(coverageEl) coverageEl.hidden=hourly || daily || discussion;
    if(statusRow) statusRow.hidden=hourly || daily || discussion;
    if(pastBtn) pastBtn.hidden=hourly || daily || discussion;
    if(tools) tools.hidden=hourly || daily || discussion;
    if(backIssues && discussion) backIssues.hidden=true;
    if(titleEl) titleEl.hidden=hourly || discussion || (daily && !openedId);
    if(statusDetail && (hourly || daily)) statusDetail.hidden=true;
    for(const chip of hourChips?.children || []) chip.classList.toggle('is-active',chip.dataset.start===String(selectedHourStart));
    paintHourUnread();
  }
  function dailyLabel(edition) {
    const end=labeledDailyAt(edition.window.endAt);
    if(day(end)===day(Date.now())) return '今天日报';
    if(day(end)===day(Date.now()-86400000)) return '昨天';
    return monthDay(end);
  }
  function recentDailies() {
    return (manifest?.days || []).map(choice).filter(Boolean).slice(0,4);
  }
  async function renderDailyFeed(token) {
    syncHourChrome();
    const editions=recentDailies();
    if(!dailyStart || !editions.some(item=>item.window.startAt===dailyStart)) dailyStart=editions[0]?.window.startAt || 0;
    dayChips.replaceChildren();
    for(const edition of editions){
      const chip=button(dailyLabel(edition),()=>{dailyStart=edition.window.startAt;openedId='';openedDirection='';render();});
      chip.className='chip-tab';chip.dataset.start=String(edition.window.startAt);
      if(edition.window.startAt===dailyStart) chip.classList.add('is-active');
      dayChips.append(chip);
    }
    setPeriodMeta('');
    syncPeriodChrome();
    const edition=editions.find(item=>item.window.startAt===dailyStart) || null;
    selected=edition;root.dataset.editionId=edition?.id || '';root.dataset.windowStart=String(edition?.window.startAt ?? '');root.dataset.briefMode='daily';
    const editorial=edition ? await loadEditorial(edition) : null;
    if(token!==epoch) return;
    if(editorial) return renderResearchDaily(editorial, edition, token);
    const nodes=edition ? await editionNodes(edition) : [];
    if(token!==epoch) return;
    const items=(nodes || []).filter(Boolean).map(n=>({n,edition}));
    const opened=openedId ? items.find(item=>item.n.id===openedId) : null;
    list.replaceChildren();
    if(opened){
      syncReadingChrome({node:opened.n,label:'返回日报',onBack:closeDaily});
      const article=await card(opened.n,token,{actions:false});
      const share=shareAction(()=>shareTreeNode(opened.n, edition, '日报'));
      const first=article.children?.[0];
      if(first) article.insertBefore(share, first);
      else article.append(share);
      list.append(article);
      titleEl.hidden=false;titleEl.textContent=opened.n.title;
    } else {
      syncReadingChrome(null);
      if(!items.length) list.textContent='这一天还没有日报。';
      else {
        const rows=el('ol','','news-rows');
        for(const item of items) rows.append(compactCard(item));
        list.append(rows);
      }
    }
    viewKey=`daily-feed:${dailyStart}:${openedId}`;
    restoreScroll(Boolean(opened));
  }
  function loadEditorial(edition) {
    if(edition?.hasEditorial===false)return Promise.resolve(null);
    const key=`${edition.window.startAt}:${edition.window.endAt}`;
    if(!editorialCache.has(key)) editorialCache.set(key, api(`/api/v1/reports/tree/editorial?startAt=${edition.window.startAt}&endAt=${edition.window.endAt}`).then(data=>data.editorial || null).catch(error=>{if(aborted(error)){editorialCache.delete(key);throw error;}return null;}));
    return editorialCache.get(key);
  }
  function researchEvent(editorial, eventId) {return editorial.events.find(event=>event.eventId===eventId);}
  function sectionSourceIds(editorial, eventIds) {
    const ids=[], seen=new Set();
    for(const eventId of eventIds || []) {
      const event=researchEvent(editorial, eventId);
      for(const nodeId of event?.sourceNodeIds || []) {if(seen.has(nodeId)) continue;seen.add(nodeId);ids.push(nodeId);}
    }
    return ids;
  }
  function attachSectionSources(block, editorial, eventIds, paragraphs) {
    const ids=sectionSourceIds(editorial, eventIds);
    if(!ids.length || !paragraphs?.length) return;
    if(ids.length===1) {
      const open=()=>openNodeSource(ids[0]);
      for(const p of paragraphs) {
        p.classList.add('is-direct-source');guardTap(p);p.addEventListener('click', open);
        p.append(el('span','〔1〕','reading-ref'));
      }
      return;
    }
    const list=el('div','','reading-source-list');
    const rows=ids.map(nodeId=>{
      const row=button('…', ()=>openNodeSource(nodeId));
      row.className='reading-source-row';row.dataset.sourceId=nodeId;guardTap(row);list.append(row);return row;
    });
    block.append(list);
    paragraphs[paragraphs.length-1].append(sourceJump(ids.length, list));
    ids.forEach((nodeId, index)=>{
      node(nodeId).then(saved=>showSourceCaption(rows[index], saved || {})).catch(error=>{if(!aborted(error) && rows[index].parentNode) rows[index].textContent='来源暂时读不到';});
    });
  }
  function renderResearchDaily(editorial, edition, token) {
    root.dataset.editorialId=editorial.id;root.dataset.editorialStatus=editorial.status;
    if(issueEl) issueEl.hidden=false;
    titleEl.hidden=false;titleEl.textContent=`${monthDay(labeledDailyAt(edition.window.endAt))}研究日报`;
    coverageEl.hidden=false;
    const coverage=editorial.coverage;
    coverageEl.textContent=`${coverage.hourlyModuleCount} 个小时模块 · ${coverage.informationNodeCount} 条信息 · ${coverage.eventCount} 个事件 · 正文 ${coverage.inBodyEventCount} · 其他 ${coverage.indexOnlyEventCount}`;
    statusToggle.hidden=false;statusToggle.textContent=editorial.status==='partial' ? '部分覆盖' : '当前材料已覆盖';
    statusDetail.hidden=false;statusDetail.textContent=editorial.statusNote;
    const page=el('div','','daily-research');
    syncReadingChrome(openedDirection ? {node:null,label:'返回日报',onBack:closeDaily} : null);
    if(!openedDirection) {
      page.append(el('p',editorial.overview,'daily-overview'));
      for(const article of editorial.articles) {
        const row=el('div','','daily-direction-row');
        const open=document.createElement('button');
        open.type='button';open.className='daily-direction-card';
        open.append(el('span',directions[article.direction] || '其他','daily-kicker'),el('h3',article.title),el('p',article.lead));
        open.addEventListener('click',()=>{openedDirection=article.direction;return render();});
        row.append(open, shareAction(()=>shareDailyArticle(article, edition)));
        page.append(row);
      }
    } else {
      const article=editorial.articles.find(item=>item.direction===openedDirection);
      if(!article) page.append(el('p','这个方向没有成稿。'));
      else {
        const head=el('div','','daily-detail-head');
        head.append(el('h3',article.title), shareAction(()=>shareDailyArticle(article, edition)));
        const lead=el('p',article.lead,'daily-overview');
        page.append(head,lead);
        attachSectionSources(page, editorial, article.leadEventIds, [lead]);
        const themes=article.sections.filter(section=>section.kind!=='other');
        const extras=article.sections.filter(section=>section.kind==='other');
        for(const section of themes) {
          const block=el('section','','daily-section');
          block.append(el('h4',section.heading));
          const paragraphs=section.paragraphs.map(text=>{const p=el('p',text);block.append(p);return p;});
          attachSectionSources(block, editorial, section.eventIds, paragraphs);
          const related=editorial.relations.filter(relation=>section.eventIds.includes(relation.eventIds[0]));
          for(const relation of related) block.append(el('p',`${relationLabels[relation.type] || relation.type}：${relation.reason}`,'daily-note'));
          page.append(block);
        }
        if(extras.length) {
          const extra=el('details','','daily-extra');
          const count=extras.reduce((sum,section)=>sum+section.eventIds.length,0);
          extra.append(el('summary',`其他动态（${count}）`));
          for(const section of extras) {
            const paragraphs=section.paragraphs.map(text=>{const p=el('p',text,'daily-note');extra.append(p);return p;});
            attachSectionSources(extra, editorial, section.eventIds, paragraphs);
          }
          page.append(extra);
        }
      }
    }
    list.replaceChildren(page);
    viewKey=`daily-research:${dailyStart}:${openedDirection}`;
    restoreScroll(Boolean(openedDirection));
  }
  function compactCard(item) {
    const at=reportItemTime(item.n, item.edition);
    const source=[item.n.publisher, directions[group(item.n)] || ''].map(part=>String(part || '').trim()).filter(part=>part && part!=='未知').join(' · ');
    const excerpt=String(item.n.text || '').replace(/\s+/g,' ').trim();
    return newsRow({
      id:item.n.id,
      title:item.n.title || '',
      at,
      source,
      summary:excerpt,
      onOpen:()=>{openedId=item.n.id;return render();},
      onShare:()=>shareTreeNode(item.n, item.edition, '日报'),
    });
  }
  async function readingSnapshot(edition) {
    if(!edition?.window) return null;
    const path=pinnedReadingId && openedId ? `/api/v1/reports/reading-hour/snapshot?id=${encodeURIComponent(pinnedReadingId)}` : `/api/v1/reports/reading-hour?startAt=${edition.window.startAt}&endAt=${edition.window.endAt}&scope=hour`;
    try{const data=await api(path);return data?.snapshot || null;}catch(error){if(aborted(error))throw error;return null;}
  }
  function readingFold(id, title, {seed} = {}) {
    const details=document.createElement('details');details.className='reading-fold';details.dataset.behavior='item.expand';
    if(readingOpen.has(id)){details.dataset.expandQuiet='1';details.open=true;setTimeout(()=>{delete details.dataset.expandQuiet;},0);}
    const summary=document.createElement('summary');summary.className='news-fold-toggle';summary.textContent='展开';
    const panel=el('div','','reading-fold-body');details.append(summary,panel);
    let loaded=false,slow=0;
    async function load() {
      if(!details.open){readingOpen.delete(id);clearTimeout(slow);return;}
      readingOpen.add(id);if(loaded)return;loaded=true;panel.replaceChildren(hourSkeleton());
      slow=setTimeout(()=>{
        if(!panel.querySelector('.tree-hour-skeleton'))return;
        loaded=false;panel.replaceChildren(button('读取较慢 · 重试',()=>{panel.replaceChildren();loaded=false;void load();}));
      },10000);
      let saved;
      try{saved=await node(id);}catch(error){clearTimeout(slow);if(aborted(error)){loaded=false;panel.textContent='';return;}saved=null;}
      clearTimeout(slow);if(!details.open)return;
      const view=(saved?.body || saved?.text) ? saved : (seed || saved);
      const bodyText=stripSharePlaceholders(decodeHtmlEntities(view?.body || view?.text || '')) || '这篇的正文暂时读不到。';
      panel.replaceChildren(el('p',bodyText,'tree-text'));
      const sourceUrl=httpUrl(view);
      if(sourceUrl){
        const link=document.createElement('a');
        link.className='reading-source-link';
        link.href=sourceUrl;
        link.setAttribute('href', sourceUrl);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        link.textContent='原文';
        link.dataset.behavior='source.original';
        panel.append(link);
      }
      if(canReadSource(view)){const sourceButton=button('原文',()=>host.readSavedSource(view));sourceButton.dataset.behavior='source.original';panel.append(sourceButton);}
    }
    details.addEventListener('toggle',load);
    if(details.open)void load();
    return details;
  }
  function themeLabel(name){return name==='其他' ? '综合' : (name || '');}
  function readingSourceLine(item, {keepDirection=false}={}){
    const publisher=String(item.publisher || '').trim();
    const direction=keepDirection ? String(item.readingDirectionName || '').trim() : '';
    const theme=themeLabel(item.readingThemeName);
    const hint=newsPublishedHint(item.publishedAt, item.firstIngestedAt);
    return [publisher, direction, theme, hint].filter(part=>part && part!=='未知').join(' · ');
  }
  function readingWhen(item, edition){
    return {at:reportItemTime(item, edition), ingested:false};
  }
  function byIngest(rows, edition){
    const at=item=>reportItemTime(item, edition) || newsIngestAt(item);
    return [...rows].sort((a,b)=>at(b)-at(a) || String(a.nodeId||a.title||'').localeCompare(String(b.nodeId||b.title||'')));
  }
  function hourItemHref(edition, nodeId){
    const start=edition?.window?.startAt;
    if(!start) return 'report';
    const hh=String(hourClock(start)).padStart(2,'0');
    const date=day(start), today=day(Date.now());
    const base=date===today ? `report?hour=${hh}` : `report/${date}?hour=${hh}`;
    return nodeId ? `${base}&node=${encodeURIComponent(nodeId)}` : base;
  }
  function readingFocusSnapshot(item, edition){
    return {
      id:item.nodeId, resourceId:item.nodeId, resourceType:'reading-node', kind:'reading',
      title:item.title || '', author:readingSourceLine(item, {keepDirection:true}),
      publishedAt:reportItemTime(item, edition) || Number(item.publishedAt) || 0,
      createdAt:Number(item.firstIngestedAt) || reportItemTime(item, edition) || 0,
      hourStart:edition?.window?.startAt || 0, reportHref:hourItemHref(edition, item.nodeId), focusedAt:Date.now(),
    };
  }
  function readingMarks(sources) {
    if(!sources?.length) return null;
    const mark=document.createElement('span');mark.className='reading-ref reading-source-jump';guardTap(mark);
    mark.textContent=`${sources.length} 个来源 ↓`;
    return mark;
  }
  function renderReadingSources(sources) {
    const list=el('div','','reading-source-list');
    sources.forEach((source, index)=>{
      const id=String(source.nodeId || source.id || index);
      const row=button(sourceCaption(source), ()=>openTreeSource({...source, layer:'information'}));
      row.className='reading-source-row';row.dataset.sourceId=id;guardTap(row);list.append(row);
      showSourceCaption(row, {...source, layer:'information'});
    });
    return list;
  }
  function readingNewsItem(item, edition, {muted=false, keepDirection=false}={}){
    const when=readingWhen(item, edition);
    const tags=item.timely===false ? ['时效不足'] : [];
    const sources=Array.isArray(item.sources) && item.sources.length>1 ? item.sources : null;
    const list=sources ? renderReadingSources(sources) : null;
    const fold=sources ? null : readingFold(item.nodeId, item.title, {seed:item});
    const row=newsRow({
      id:item.nodeId, title:item.title || '', at:when.at, ingested:when.ingested,
      source:readingSourceLine(item, {keepDirection}), tags, muted,
      focused:Boolean(host.readingFocused?.(item.nodeId)),
      onStar:()=>host.focusReading?.(readingFocusSnapshot(item, edition)),
      onShare:()=>shareReadingItem(item, edition),
      attachOpen(open){
        open.addEventListener('click', event=>{
          const mark=event?.target?.classList?.contains('reading-ref') ? event.target : null;
          if(mark && list) return highlightSource((mark.dataset.sourceId && findSourceRow(list, mark.dataset.sourceId)) || list);
          if(list) return highlightSource(list);
          if(fold) return toggleReadingFold(fold);
        });
      },
    });
    const title=row.querySelector('h3');
    const marks=readingMarks(sources);
    if(title && marks) placeAfter(title, marks);
    if(list) row.append(list);
    if(fold) row.append(fold);
    return row;
  }
  function appendTitleGroup(name, rows) {
    const section=el('section');section.append(el('h2',name,'reading-group'));
    for (const row of rows) section.append(readingFold(row.id,row.title,{seed:row}));
    list.append(section);
  }
  const readingDirectionOrder=['金融','产业个股','科技与AI','地缘政治','待分类'];
  function renderReadingDirections(rows, parent, edition) {
    if(!rows.length) return;
    const rank=(order,value)=> {const index=order.indexOf(value);return index<0 ? order.length : index;};
    const directionNames=[...new Set(rows.map(item=>item.readingDirectionName).filter(Boolean))].sort((a,b)=>rank(readingDirectionOrder,a)-rank(readingDirectionOrder,b));
    for(const directionName of directionNames){
      const matched=byIngest(rows.filter(item=>item.readingDirectionName===directionName), edition);
      const block=el('section','','reading-block');
      const heading=el('h2',directionName,'reading-direction news-section-title');
      heading.append(el('span',`${matched.length} 条`,'news-section-count'));
      const list=el('ol','','news-rows');
      for(const item of matched) list.append(readingNewsItem(item, edition));
      block.append(heading, list);
      parent.append(block);
    }
  }
  function syncHourMeta() {
    setPeriodMeta('');
  }
  function showEmptyHour() {
    const line=el('p','这一小时没有条目','tree-hour-empty');
    return line;
  }
  async function loadReadingIndex() {
    if(readingIndex!==undefined) return readingIndex;
    try{
      const endAt=Date.now()+1;
      const data=await api(`/api/v1/reports/reading-hour/index?startAt=${endAt-7*86400000}&endAt=${endAt}&scope=hour`);
      const map=new Map();
      for(const row of data?.hours || []) if(row && Number.isFinite(Number(row.startAt))) map.set(Number(row.startAt), row);
      readingIndex=map;
    }catch(error){if(aborted(error))throw error;readingIndex=null;}
    return readingIndex;
  }
  async function fetchReadingSnapshot(edition, {refresh=false}={}) {
    const path=pinnedReadingId && openedId ? `/api/v1/reports/reading-hour/snapshot?id=${encodeURIComponent(pinnedReadingId)}` : `/api/v1/reports/reading-hour?startAt=${edition.window.startAt}&endAt=${edition.window.endAt}&scope=hour`;
    try{
      const data=await api(path, refresh ? { cache: 'no-store', priority: 1 } : { priority: 2 });const snapshot=data?.snapshot || null;
      readingCache.set(edition.window.startAt, snapshot);return snapshot;
    }catch(error){
      if(aborted(error)) throw error;
      if(error?.status===404){readingCache.set(edition.window.startAt, null);return null;}
      throw error;
    }
  }
  function readingHourPromise(edition, {refresh=false}={}) {
    const key=edition.window.startAt;
    if(!refresh && readingCache.has(key)) return Promise.resolve(readingCache.get(key));
    if(!refresh && readingLoads.has(key)) return readingLoads.get(key);
    const pending=fetchReadingSnapshot(edition, {refresh}).finally(()=>{if(readingLoads.get(key)===pending) readingLoads.delete(key);});
    if(!refresh) readingLoads.set(key, pending);
    return pending;
  }
  function prefetchAround(edition) {
    if(!edition) return;
    const rows=focusedHourRows(hourRows());
    const index=rows.findIndex(item=>item.window.startAt===edition.window.startAt);
    const neighbors=[rows[index-1],rows[index+1]].filter(Boolean);
    const run=()=>{
      if(!active()) return;
      for(const next of neighbors){
        if(readingCache.has(next.window.startAt) || readingLoads.has(next.window.startAt)) continue;
        void readingHourPromise(next).catch(()=>{});
      }
    };
    const idle=globalThis.requestIdleCallback;
    if(typeof idle==='function') idle(()=>run(),{timeout:1500});
    else setTimeout(run,0);
  }
  function refreshPartial(edition, token, claim) {
    void readingHourPromise(edition,{refresh:true}).then(snapshot=>{
      if(token!==epoch || selectedHourStart!==edition.window.startAt || !snapshot) return;
      return renderReadingHour(token, claim, edition, snapshot);
    }).catch(()=>{});
  }
  async function renderReadingHour(token,claim,edition,snapshot) {
    if(token!==epoch || !snapshot) return;
    if(openedId) pinnedReadingId=snapshot.id; else pinnedReadingId='';
    finishOpening(claim,true);paintHourUnread();
    const page=el('div','','reading-hour');
    if(hourFallbackText) page.append(el('p',hourFallbackText,'tree-hour-fallback'));
    syncHourMeta(snapshot);
    syncReadingChrome(null);
    page.append(el('p',`${newsDayLabel(edition.window.startAt)} · ${clock(edition.window.startAt)}\u2013${clock(edition.window.endAt)}`,'news-day-label'));
    const shown=(snapshot.items||[]).filter(item=>item.readingDirectionName && item.readingDirectionName!=='待分类' && item.disposition!=='out-of-scope');
    const hits=shown.filter(item=>item.disposition==='hit' && item.timely!==false);
    const tail=byIngest(shown.filter(item=>item.disposition!=='hit' || item.timely===false), edition);
    if(!hits.length && !tail.length) page.append(showEmptyHour());
    else {
      renderReadingDirections(hits, page, edition);
      if(tail.length){
        const end=el('section','','reading-tail');
        const rows=el('ol','','news-rows');
        for(const item of tail) rows.append(readingNewsItem(item, edition, {muted:true, keepDirection:true}));
        end.append(rows);
        page.append(end);
      }
    }
    list.replaceChildren(page);
    root.dataset.readingSnapshot=snapshot.id||'';
    viewKey=`hourly-reading:${edition.window.startAt}:${snapshot.id||''}`;
    restoreScroll(false);
    consumePendingNode();
    prefetchAround(edition);
  }
  function paintEmptyHour(edition, claim) {
    clearHourSlow();finishOpening(claim,true);paintHourUnread();
    const page=el('div','','reading-hour');
    if(hourFallbackText) page.append(el('p',hourFallbackText,'tree-hour-fallback'));
    syncHourMeta(null);
    page.append(showEmptyHour());
    list.replaceChildren(page);
    prefetchAround(edition);
  }
  async function renderHourFeed(token,claim) {
    const rows=hourRows();
    const focused=focusedHourRows(rows);
    const pool=focused.length ? focused : rows;
    if(pendingClockHour!=null) applyClockRequest(pool);
    else ensureSelectedHour(pool);
    writeHourHash(selectedHourStart);
    syncHourChrome();
    paintDelay(rows);
    void loadReadingIndex().then(index=>{if(token===epoch) paintHourStrip(hourRows(), index instanceof Map ? index : null);}).catch(()=>{});
    paintHourStrip(rows, readingIndex instanceof Map ? readingIndex : null);
    const edition=pool.find(item=>item.window.startAt===selectedHourStart) || rows.find(item=>item.window.startAt===selectedHourStart) || null;
    selected=edition;root.dataset.editionId=edition?.id || '';root.dataset.windowStart=String(edition?.window.startAt ?? '');root.dataset.briefMode='hourly';
    if(!edition){clearHourSlow();finishOpening(claim,false);list.replaceChildren(el('p','这个小时还没有小时报。','tree-hour-empty'));return;}
    const key=edition.window.startAt;
    if(readingCache.has(key)){
      const snapshot=readingCache.get(key);
      if(!snapshot) return paintEmptyHour(edition, claim);
      await renderReadingHour(token,claim,edition,snapshot);
      if(snapshot.status==='partial') refreshPartial(edition, token, claim);
      return;
    }
    setPeriodMeta('');
    if(!list.querySelector('.tree-hour-skeleton')){list.replaceChildren(hourSkeleton());armHourSlow(token);}
    const snapshot=await readingHourPromise(edition);
    if(token!==epoch){const current=claim?.ticket===opening.ticket;finishOpening(claim,false);if(current && root?.isConnected)paintHourUnread();return;}
    clearHourSlow();
    if(!snapshot) return paintEmptyHour(edition, claim);
    await renderReadingHour(token,claim,edition,snapshot);
    if(snapshot.status==='partial') refreshPartial(edition, token, claim);
  }
  async function render() {
    haltDigest();
    if(viewKey)positions.set(viewKey,window.scrollY);const token=++epoch;const flightToken=flight;
    rendering++;
    const hourlyFeed=mode==='hourly' && !showMaterials;
    const dailyFeed=mode==='daily' && !showMaterials;
    if(hourlyFeed){
      const pool=focusedHourRows(hourRows());
      const rows=pool.length ? pool : hourRows();
      if(pendingClockHour!=null) applyClockRequest(rows);
      else ensureSelectedHour(rows);
    }
    const openingClaim=hourlyFeed?beginOpening(hourRows().find(item=>item.window.startAt===selectedHourStart)||null):null;
    const cachedHour=hourlyFeed && readingCache.has(selectedHourStart);
    if(hourlyFeed && !cachedHour){list.replaceChildren(hourSkeleton());armHourSlow(token);}
    else if(!hourlyFeed){clearHourSlow();list.textContent='读取中…';}
    setPrimary();syncHourChrome();
    if(hourlyFeed && openedId) syncReadingChrome({node:null,label:'返回小时报',onBack:closeHour});
    else if(dailyFeed && (openedId || openedDirection)) syncReadingChrome({node:null,label:'返回日报',onBack:closeDaily});
    try {
      if(mode==='discussion'){
        syncReadingChrome(null);
        root.dataset.briefMode='discussion';root.dataset.editionId='';
        list.replaceChildren();
        digestStop=mountInvestorDigest(list,{api,active:()=>mode==='discussion' && token===epoch && list.isConnected}) || (()=>{});
        viewKey='discussion';
        return;
      }
      if(hourlyFeed) return await renderHourFeed(token,openingClaim);
      if(dailyFeed) return await renderDailyFeed(token);
      syncReadingChrome(null);
      const rows=editionRows(),row=rows.find(r=>choice(r)?.window.startAt===Number(period.value)) || rows[0];selected=choice(row);
      root.dataset.editionId=selected?.id || '';root.dataset.windowStart=String(selected?.window.startAt ?? '');root.dataset.briefMode=mode;
      if(!selected){
        titleEl.textContent=mode==='daily' ? '还没有日报' : '还没有小时报';coverageEl.textContent='';statusToggle.hidden=true;statusDetail.hidden=true;
        list.textContent='这一栏还没有已发布简报。可以打开往期，或查看旧版存档。';return;
      }
      titleEl.textContent=issueTitle(selected);coverageEl.textContent=issueCoverage(selected);
      const publishedTask=!selected.pendingIds && selected.id && !copyCount(selected) && !fullEditions.has(selected.id) ? loadEditionDocument(selected.id) : null;
      const nodes=await editionNodes(selected);if(token!==epoch)return;
      if(publishedTask){await publishedTask;if(token!==epoch)return;}
      statusToggle.hidden=true;statusDetail.hidden=true;
      if(!directionExplicit){const available=directionOrder.find(value=>nodes.some(n=>group(n)===value));direction=available || 'finance';}
      for(const tab of directionNav.children) tab.setAttribute('aria-selected',String(tab.dataset.direction===direction));
      const source=showMaterials ? await Promise.all((await materialIndex(selected)).map(n=>node(n.id))) : nodes;
      if(token!==epoch)return;
      const inDirection=source.filter(n=>n && group(n)===direction),tags=[...new Set(inDirection.map(n=>n.tagId))],chosen=tag.value;
      tag.replaceChildren(new Option('全部Tag','*'),...tags.map(t=>new Option(names.get(t) || t || '未分类',t || '')));tag.value=tags.some(t=>(t || '')===chosen) ? chosen : '*';
      list.replaceChildren();
      for(const n of inDirection.filter(n=>tag.value==='*' || n.tagId===tag.value)) list.append(await card(n,token));
      if(!source.length) list.textContent=showMaterials ? '本期没有可展开的原始信息。' : '本期没有可用内容。';
      else if(!inDirection.length) list.textContent=showMaterials ? '本期材料里这个方向没有条目。' : '本期这个方向没有模块。';
      rememberIssue();
      viewKey=`${mode}:${selected.window.startAt}:${direction}:${tag.value}:${showMaterials?'materials':'brief'}`;
      restoreScroll(false);
    }catch(error){if(aborted(error) || token!==epoch || flightToken!==flight)return;clearHourSlow();finishOpening(openingClaim,false);paintHourUnread();
      if(hourlyFeed) list.replaceChildren(button('这一期读取失败 · 重试',()=>render()));
      else list.replaceChildren(el('p','读取失败，请重试。'),button('重试读取',render));
      if((hourlyFeed || dailyFeed) && (openedId || openedDirection)) syncReadingChrome({node:null,label:hourlyFeed?'返回小时报':'返回日报',onBack:hourlyFeed?closeHour:closeDaily});
      else syncReadingChrome(null);}
    finally{rendering=Math.max(0,rendering-1);}
  }
  async function check(force=false){
    if(!active() || document.hidden)return;if(checking)return checking;const token=epoch;
    checking=(async()=>{const latest=await fetchManifest(force);if(token!==epoch || !active())return;const next=choice(editionRows(latest).find(r=>choice(r)?.window.startAt===selected?.window.startAt));
      if(JSON.stringify(editionRows(latest).map(choice))!==JSON.stringify(editionRows().map(choice))){nextManifest=latest;notice.replaceChildren(el('span',next && next.id!==selected?.id ? '所选时段有新版本。' : '刊期或处理进度已更新。'),button('接受更新',acceptUpdate));notice.hidden=false;}
    })().catch(()=>{}).finally(()=>{checking=null;});return checking;
  }
  async function acceptUpdate(){if(!nextManifest)return;editorialCache.clear();invalidateInformationIndex();manifest=nextManifest;nextManifest=null;notice.hidden=true;periods();await render();}
  // Pausing a retained page must not invalidate the ref handlers still mounted in it.
  function haltDigest(){digestStop();digestStop=()=>{};}
  function stop(){clearInterval(timer);timer=0;checking=null;clearHourSlow();}
  function suspend(){
    haltDigest();
    stop();
    flight++;
    requests.abort();
    requests=new AbortController();
    if(!settled || rendering){epoch++;settled=false;}
    return settled;
  }
  function resume(checkNow=true){clearInterval(timer);if(active() && !document.hidden)timer=setInterval(check,30000);if(checkNow)return check();}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(active())resume();});
  document.addEventListener('keydown',onHourKey);
  return {async mount(target,options={}){
    stop();flight++;requests.abort();requests=new AbortController();epoch++;settled=false;loadSeen();const flightToken=flight;root=target;mode=options.mode==='hourly' ? 'hourly' : 'daily';dateFilter=options.date || '';pendingClockHour=Number.isInteger(options.hour) && options.hour>=0 && options.hour<=23 ? options.hour : null;pendingNodeId=options.node ? String(options.node) : '';hourFallbackText='';hourRevealEarlier=false;showMaterials=false;root.replaceChildren();root.classList.add('tree-page','brief-page');
    if(options.resetSelection){selected=null;viewKey='';}
    const primary=el('div','','tree-primary source-control');primary.setAttribute('aria-label','简报');
    const modeTabs=el('div','','tree-mode-tabs channel-tabs');modeTabs.setAttribute('role','tablist');modeTabs.setAttribute('aria-label','简报');
    for(const [value,label] of [['daily','日报'],['hourly','小时报'],['discussion','股民讨论']]){const tab=button(label,()=>switchMode(value));tab.className='channel-tab';tab.dataset.mode=value;tab.setAttribute('role','tab');modeTabs.append(tab);}
    periodBar=el('div','','tree-period-bar');
    periodMeta=el('p','','tree-period-meta');periodMeta.hidden=true;
    const periodSwitch=el('div','','tree-period-switch');
    periodPrev=button('‹',()=>stepPeriod('earlier'));periodPrev.className='tree-period-step';periodPrev.setAttribute('aria-label','上一期');
    periodNext=button('›',()=>stepPeriod('later'));periodNext.className='tree-period-step';periodNext.setAttribute('aria-label','下一期');
    const picker=el('div','','tree-period-picker');
    periodPop=el('div','','tree-period-pop');periodPop.hidden=true;periodPop.setAttribute('role','listbox');
    periodLabel=button('选择期数',()=>{const open=periodPop.hidden;periodPop.hidden=!open;periodLabel.setAttribute('aria-expanded',String(open));});
    periodLabel.className='tree-period-label';periodLabel.setAttribute('aria-haspopup','listbox');periodLabel.setAttribute('aria-expanded','false');periodLabel.setAttribute('aria-label','选择期数');
    picker.append(periodLabel,periodPop);periodSwitch.append(periodPrev,picker,periodNext);periodBar.append(periodMeta,periodSwitch);primary.append(modeTabs,periodBar);
    if(!periodDocBound){periodDocBound=true;document.addEventListener('click',event=>{if(!periodPop || periodPop.hidden || periodPop.parentElement?.contains(event.target))return;closePeriodPop();});}
    const issue=el('header','','tree-issue');
    issueEl=issue;
    const heading=el('div','','tree-issue-heading');
    titleEl=el('h2','','tree-issue-title');
    pastBtn=button('往期',()=>{backIssues.hidden=!backIssues.hidden;pastBtn.setAttribute('aria-expanded',String(!backIssues.hidden));});
    pastBtn.setAttribute('aria-expanded','false');heading.append(titleEl,pastBtn);issue.append(heading);
    coverageEl=el('p','','tree-coverage');
    statusRow=el('div','','tree-status-row');
    statusToggle=button('',()=>{const open=statusDetail.hidden;statusDetail.hidden=!open;statusToggle.setAttribute('aria-expanded',String(open));});
    statusToggle.className='tree-status-toggle';statusToggle.setAttribute('aria-expanded','false');
    const refresh=button('检查更新',()=>check(true));refresh.className='tree-refresh';
    statusRow.append(statusToggle,refresh);statusDetail=el('p','','tree-status-detail');statusDetail.hidden=true;
    issue.append(coverageEl,statusRow,statusDetail);
    backIssues=el('div','','tree-back-issues');backIssues.hidden=!options.history;
    if(options.history || options.date){if(host.latest)backIssues.append(button('返回最新简报',host.latest));pastBtn.setAttribute('aria-expanded','true');}
    const date=el('input');date.type='date';date.value=dateFilter;date.setAttribute('aria-label','简报日期');date.addEventListener('change',()=>{dateFilter=date.value;selected=null;periods();render();});
    period=el('select');period.setAttribute('aria-label','选择往期');period.addEventListener('change',()=>{memory[mode]={...(memory[mode]||{}),startAt:Number(period.value)};render();});
    backIssues.append(date,period);if(host.archive)backIssues.append(button('旧版存档',host.archive));
    directionNav=el('div','','brief-direction-tabs');directionNav.setAttribute('role','tablist');directionNav.setAttribute('aria-label','阅读方向');
    for(const [value,label] of Object.entries(directions)){const tab=button(label,()=>{direction=value;directionExplicit=true;render();});tab.className='brief-direction-tab';tab.dataset.direction=value;tab.setAttribute('role','tab');directionNav.append(tab);}
    delayEl=el('div','','tree-hour-delay');delayEl.hidden=true;
    hourRail=el('div','','tree-hour-rail');
    hourDay=el('div','今天','tree-hour-day');
    hourNow=el('div','现在','tree-hour-now');
    hourChips=el('div','','chip-tabs tree-hour-chips tree-hour-wheel');hourChips.setAttribute('aria-label','选择小时');
    hourChips.addEventListener('wheel',event=>{if(!hourStripMobile() || Math.abs(event.deltaY)<=Math.abs(event.deltaX))return;hourChips.scrollLeft+=event.deltaY;event.preventDefault();},{passive:false});
    hourEarlier=button('更早 ›',()=>{hourRevealEarlier=true;hourStripKey='';paintHourStrip(hourRows(), readingIndex instanceof Map ? readingIndex : null);});
    hourEarlier.className='tree-hour-earlier';
    hourYesterday=button('昨天 ›',()=>{
      const focus=selectedHourStart || Date.now();
      const prev=day(focus-86400000);
      const hour=selectedHourStart ? hourClock(selectedHourStart) : null;
      host.navigate?.(hour==null ? `report/${prev}` : `report/${prev}?hour=${String(hour).padStart(2,'0')}`);
    });
    hourYesterday.className='tree-hour-yesterday';
    hourMore=button('›',()=>{if(typeof hourChips.scrollBy==='function')hourChips.scrollBy({left:160});else hourChips.scrollLeft=(hourChips.scrollLeft||0)+160;});
    hourMore.className='tree-hour-more';hourMore.setAttribute('aria-label','更早的小时');
    hourRail.append(hourDay,hourNow,hourChips,hourEarlier,hourYesterday);
    dayChips=el('div','','chip-tabs tree-hour-chips');dayChips.setAttribute('aria-label','日报日期');
    periodPop.append(hourRail,dayChips);
    tools=el('div','','tree-tools');
    materialsBtn=button('本期材料',()=>{showMaterials=!showMaterials;return render();});
    tools.append(materialsBtn);
    tagPanel=el('div','','tree-tag-panel');tagPanel.hidden=true;
    tag=el('select');tag.setAttribute('aria-label','主Tag筛选');tag.add(new Option('全部Tag','*'));tag.addEventListener('change',()=>{memory[mode]={...(memory[mode]||{}),tag:tag.value};render();});tagPanel.append(tag);
    notice=el('div','','tree-update');notice.hidden=true;notice.setAttribute('role','status');list=el('div','','tree-list');bindHourSwipe(list);
    const hourLayout=el('div','','tree-hour-layout');hourLayout.append(list);
    root.append(primary,issue,delayEl,backIssues,directionNav,tools,tagPanel,notice,hourLayout);
    const token=epoch;
    if(!names.size)api('/api/v1/tags').then(({catalog})=>{if(token!==epoch)return;for(const t of catalog?.tags || [])names.set(t.id,t.name);for(const option of tag.options)if(names.has(option.value))option.textContent=names.get(option.value);}).catch(()=>{});
    try{
      manifest=options.manifest || await fetchManifest();if(token!==epoch || flightToken!==flight)return;
      if(mode==='daily' && !editionRows().length) mode='hourly';
      const saved=memory[mode] || {};direction=saved.direction ?? null;directionExplicit=Boolean(saved.directionExplicit);if(saved.tag)tag.value=saved.tag;
      periods();await render();if(flightToken!==flight)return;settled=true;resume(false);
    }catch(error){if(aborted(error) || token!==epoch || flightToken!==flight)return;list.replaceChildren(el('p','暂时无法读取简报。'),button('重试读取',()=>this.mount(target,options)));}
  },check,acceptUpdate,resume,stop,suspend,isSettled(){return settled;},selectHour,focusNode,selectDirection(value){if(directions[value]){direction=value;directionExplicit=true;return render();}},reset(){haltDigest();root?.querySelectorAll('.tree-reading-chrome').forEach(node=>node.remove());root?.classList.remove('is-reading','is-hourly','is-discussion');clearHourSlow();readingCache.clear();readingLoads.clear();readingIndex=undefined;pendingClockHour=null;hourFallbackText='';hourRevealEarlier=false;openGaps.clear();stop();flight++;requests.abort();requests=new AbortController();epoch++;session++;settled=false;rendering=0;cache.clear();nodeRequests.clear();editionCache.clear();editorialCache.clear();fullEditions.clear();editionLoads.clear();invalidateInformationIndex();expanded.clear();positions.clear();viewKey='';selected=null;direction=null;directionExplicit=false;showMaterials=false;selectedHourStart=0;dailyStart=0;openedId='';openedDirection='';hourStripKey='';seen=new Set();seenIds=[];opening={id:'',ticket:0};manifest=null;nextManifest=null;memory.hourly={};memory.daily={};root=null;}};
}
