import { icon } from './icons.js';
const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
const button=(text,action)=>{const n=el('button',text);n.type='button';n.addEventListener('click',action);return n;};
const directions={finance:'金融与市场',policy:'时事与政策',tech:'科技与产业',other:'其他'};
const directionOrder=['finance','policy','tech','other'];
// Compatibility display mapping for pre-direction readers. New servers return the
// Instance mapping, including an explicit 'other', which takes precedence.
const previousDirections={macro:'finance',macro_commodity:'finance',crypto:'finance',market_us:'finance',market_cn:'finance',market_hk:'finance',geopolitics:'policy',
  ai:'tech',ai_compute:'tech',ai_model:'tech',ai_application:'tech',semiconductor:'tech',semiconductor_memory:'tech',semiconductor_optical:'tech',semiconductor_equipment:'tech',semiconductor_packaging:'tech',internet:'tech',software:'tech',gaming:'tech',graphics:'tech',auto:'tech',energy:'tech',communications:'tech',datacenter:'tech'};
const reasons={'needs-content':'正文待补','information-not-ready':'信息加工待完成','retryable-model-error':'模型暂时故障','queue-timeout':'排队超时','execution-timeout':'执行超时','budget-deferred':'预算延期','lease-conflict':'同版本加工中','invalid-output':'输出不合法','stale-policy':'规则已更新'};
export function createInformationTreePage(host) {
  let root,list,titleEl,coverageEl,statusRow,statusToggle,statusDetail,pastBtn,directionNav,hourChips,dayChips,tools,materialsBtn,tagPanel,tag,period,backIssues,notice,mode='daily',direction=null,directionExplicit=false,showMaterials=false,selectedHourStart=0,dailyStart=0,openedId='',openedDirection='',manifest,selected=null,epoch=0,timer=0,dateFilter='',checking=null,pinnedReadingId='';
  const readingOpen=new Set();
  const names=new Map(),cache=new Map(),nodeRequests=new Map(),editionCache=new Map(),editorialCache=new Map(),fullEditions=new Map(),editionLoads=new Map(),expanded=new Set(),positions=new Map(),memory={hourly:{},daily:{}};let viewKey='',nextManifest=null,informationRows=null,informationRequest=null,informationEpoch=0,session=0;
  const relationLabels={'same-event':'同一事件的后续进展','shared-theme':'共同主题','complementary':'相互补充','contradictory':'不同说法','supported-impact':'有依据的影响','unverified-link':'尚待验证的潜在联系'};
  const remember=n=>{if(!n)return;cache.delete(n.id);cache.set(n.id,n);while(cache.size>400)cache.delete(cache.keys().next().value);};
  const active=()=>root?.isConnected && root.classList.contains('tree-page') && (host.active?.() ?? true) && (host.session?.() ?? true);
  const timeZone=()=>manifest?.timezone || 'Asia/Shanghai';
  const parts=at=>{const list=new Intl.DateTimeFormat('en-US',{timeZone:timeZone(),month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at);const get=type=>list.find(item=>item.type===type).value;return {month:get('month'),day:get('day'),hour:get('hour'),minute:get('minute')};};
  const stamp=at=>{const p=parts(at);return `${p.month}月${p.day}日 ${p.hour}:${p.minute}`;};
  const clock=at=>{const p=parts(at);return `${p.hour}:${p.minute}`;};
  const monthDay=at=>{const p=parts(at);return `${p.month}月${p.day}日`;};
  const day=at=>{const parts=new Intl.DateTimeFormat('en-US',{timeZone:timeZone(),year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at);return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');};
  const group=n=>manifest?.directions?.[n.tagId] || previousDirections[n.tagId] || 'other';
  const expansionKey=n=>`${n.layer}:${[...n.articleIds].sort().join('|')}`;
  const fetchManifest=(force=false)=>{if(host.loadTreeManifest)return host.loadTreeManifest({force});const endAt=Date.now()+1;return host.api(`/api/v1/reports/tree?view=index&startAt=${endAt-7*86400000}&endAt=${endAt}`);};
  function invalidateInformationIndex(){informationEpoch++;informationRows=null;informationRequest=null;}
  async function loadInformationIndex(){
    if(informationRows)return informationRows;
    if(!informationRequest){
      const endAt=Date.now()+1,cacheToken=informationEpoch;
      const pending=host.api(`/api/v1/reports/tree?view=index&information=1&startAt=${endAt-7*86400000}&endAt=${endAt}`).then(data=>{
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
      const pending=host.api(`/api/v1/reports/tree/edition?id=${encodeURIComponent(id)}`).then(data=>{
        if(seen!==session || !data?.edition?.id)return null;
        fullEditions.set(data.edition.id,data.edition);
        return data.edition;
      }).catch(()=>null).finally(()=>{if(editionLoads.get(id)===pending)editionLoads.delete(id);});
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
    if(!nodeRequests.has(id)){const token=epoch;nodeRequests.set(id,host.api(`/api/v1/reports/tree/node?id=${encodeURIComponent(id)}`).then(data=>{if(token===epoch)remember(data.node);return data.node;}).finally(()=>nodeRequests.delete(id)));}
    return nodeRequests.get(id);
  };
  const copyCount=edition=>Array.isArray(edition?.roots) ? edition.roots.length : Number(edition?.rootCount)||0;
  async function editionNodes(edition) {
    if(!edition?.id || !copyCount(edition))return [];
    if(Array.isArray(edition.roots) && edition.roots.every(id=>cache.has(id)))return edition.roots.map(id=>cache.get(id));
    if(!editionCache.has(edition.id)) {
      const token=epoch,seen=session,expected=copyCount(edition);
      const pending=host.api(`/api/v1/reports/tree/edition?id=${encodeURIComponent(edition.id)}`).catch(()=>Array.isArray(edition.roots) ? Promise.all(edition.roots.map(node)).then(nodes=>({edition,nodes})) : Promise.reject(new Error('刊期版本未能读取'))).then(data=>{
        if(data.edition?.id!==edition.id || data.nodes?.length!==expected)throw new Error('刊期版本未能读取');
        if(seen===session && data.edition)fullEditions.set(data.edition.id,data.edition);
        if(token===epoch)data.nodes.forEach(remember);
        return data.nodes;
      }).catch(error=>{editionCache.delete(edition.id);throw error;});
      editionCache.set(edition.id,pending);while(editionCache.size>200)editionCache.delete(editionCache.keys().next().value);
    }
    return editionCache.get(edition.id);
  }
  function detailAction(iconName, label, onClick) {
    const n=document.createElement('button');n.type='button';n.setAttribute('aria-label',label);
    const glyph=document.createElement('span');glyph.innerHTML=icon(iconName);glyph.setAttribute('aria-hidden','true');
    n.append(glyph,el('span',label));n.addEventListener('click',onClick);return n;
  }
  function canReadSource(n) {return Boolean(n?.layer==='information' && n.sourceRefs?.length && host.readSavedSource);}
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
    article.append(el('h3',n.title),el('p',n.text,'tree-text'));
    if(n.layer==='information' && n.body && n.body!==n.text) {const body=el('details','','tree-ref');body.append(el('summary','中文正文'),el('p',n.body,'tree-text'));article.append(body);}
    if(n.layer==='information') {if(options.actions!==false && n.sourceRefs?.length && host.readSavedSource)article.append(button('原文',()=>host.readSavedSource(n)));}
    else {
      const details=el('details','','tree-ref'),children=el('div','','tree-children'),key=expansionKey(n);
      details.append(el('summary',`${n.articleCount} 篇 · ref`),children);article.append(details);let loaded=false;
      details.addEventListener('toggle',async()=>{
        if(!details.open){expanded.delete(key);return;}expanded.add(key);if(loaded)return;children.textContent='读取中…';
        try{const data=n.children.every(id=>cache.has(id)) ? {children:n.children.map(id=>cache.get(id))} : await host.api(`/api/v1/reports/tree/children?id=${encodeURIComponent(n.id)}`);if(token!==epoch)return;children.replaceChildren();for(const child of data.children){remember(child);children.append(await card(child,token));}loaded=true;}
        catch{if(token===epoch)children.replaceChildren(button('读取失败，重试',()=>{details.open=false;details.open=true;}));}
      });
      if(expanded.has(key))details.open=true;
    }
    return article;
  }
  const choice=r=>r?.edition || r?.attempt;
  function editionRows(data=manifest) {
    if(!data)return [];
    const rows=mode==='daily' ? data.days : data.hours;
    return (rows || []).filter(r=>{const chosen=choice(r);return chosen && (!dateFilter || day(mode==='daily' ? chosen.window.endAt : chosen.window.startAt)===dateFilter);});
  }
  function issueTitle(edition) {
    if(mode==='daily') return `${monthDay(edition.window.endAt)}日报`;
    const range=`${clock(edition.window.startAt)}—${clock(edition.window.endAt)}小时报`;
    return day(edition.window.startAt)===day(Date.now()) ? range : `${monthDay(edition.window.startAt)} ${range}`;
  }
  function issueCoverage(edition) {
    if(mode==='hourly') return '本小时新增变化';
    if(day(edition.window.endAt)===day(Date.now()) && day(edition.window.startAt)!==day(edition.window.endAt)) return `覆盖昨日${clock(edition.window.startAt)}至今日${clock(edition.window.endAt)}`;
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
    for(const tab of root.querySelectorAll('[data-mode]')){const on=tab.dataset.mode===mode;tab.setAttribute('aria-pressed',String(on));tab.setAttribute('aria-selected',String(on));}
    materialsBtn.setAttribute('aria-pressed',String(showMaterials));
  }
  function switchMode(next) {
    if(next===mode && !showMaterials) return;
    if(next!==mode) rememberIssue();
    mode=next;showMaterials=false;openedId='';
    const saved=memory[mode] || {};
    direction=saved.direction ?? null;directionExplicit=Boolean(saved.directionExplicit);
    if(tag) tag.value=saved.tag || '*';
    selected=null;periods();setPrimary();return render();
  }
  function hourRows() {
    return (manifest?.hours || []).map(choice).filter(Boolean).sort((a,b)=>b.window.startAt-a.window.startAt);
  }
  function hourLabel(edition, index) {
    if(index===0) return '这个小时';
    if(index===1) return '上个小时';
    if(index===2) return '上上个小时';
    const newest=hourRows()[0];
    return newest && day(edition.window.startAt)===day(newest.window.startAt) ? clock(edition.window.startAt) : `${monthDay(edition.window.startAt)} ${clock(edition.window.startAt)}`;
  }
  let hourStripKey='',seenIds=[],seen=new Set(),opening={id:'',ticket:0},openTicket=0;
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
      if(on)chip.setAttribute('aria-label',`${chip.textContent}，未读`);else chip.removeAttribute('aria-label');
    }
    const tab=root?.querySelector?.('[data-mode="hourly"]');
    if(!tab)return;
    tab.classList.toggle('is-unread',unread.size>0);
    if(unread.size)tab.setAttribute('aria-label','小时报，未读');else tab.removeAttribute('aria-label');
  }
  function paintHourStrip(rows) {
    const key=rows.map(item=>item.window.startAt).join(',');
    if(key!==hourStripKey){
      hourStripKey=key;hourChips.replaceChildren();
      rows.forEach((edition,index)=>{
        const chip=button(hourLabel(edition,index),()=>{selectedHourStart=edition.window.startAt;openedId='';pinnedReadingId='';readingOpen.clear();return render();});
        chip.className='chip-tab';chip.dataset.start=String(edition.window.startAt);hourChips.append(chip);
      });
    }
    ensureSelectedHour(rows);
    for(const chip of hourChips.children){
      const on=chip.dataset.start===String(selectedHourStart);
      chip.classList.toggle('is-active',on);
      if(on) chip.scrollIntoView({inline:'center',block:'nearest'});
    }
    paintHourUnread(rows);
  }
  function syncHourChrome() {
    const hourly=mode==='hourly' && !showMaterials;
    const daily=mode==='daily' && !showMaterials;
    if(hourChips) hourChips.hidden=!hourly || Boolean(openedId);
    if(dayChips) dayChips.hidden=!daily;
    if(directionNav) directionNav.hidden=hourly || daily;
    if(coverageEl) coverageEl.hidden=hourly || daily;
    if(statusRow) statusRow.hidden=hourly || daily;
    if(pastBtn) pastBtn.hidden=hourly || daily;
    if(tools) tools.hidden=hourly || daily;
    if(titleEl) titleEl.hidden=hourly || (daily && !openedId);
    if(statusDetail && (hourly || daily)) statusDetail.hidden=true;
    for(const chip of hourChips?.children || []) chip.classList.toggle('is-active',chip.dataset.start===String(selectedHourStart));
    paintHourUnread();
  }
  function dailyLabel(edition) {
    const end=edition.window.endAt;
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
      list.append(await card(opened.n,token,{actions:false}));
      titleEl.hidden=false;titleEl.textContent=opened.n.title;
    } else {syncReadingChrome(null);if(!items.length) list.textContent='这一天还没有日报。';else for(const item of items) list.append(compactCard(item));}
    viewKey=`daily-feed:${dailyStart}:${openedId}`;
    restoreScroll(Boolean(opened));
  }
  function loadEditorial(edition) {
    if(edition?.hasEditorial===false)return Promise.resolve(null);
    const key=`${edition.window.startAt}:${edition.window.endAt}`;
    if(!editorialCache.has(key)) editorialCache.set(key, host.api(`/api/v1/reports/tree/editorial?startAt=${edition.window.startAt}&endAt=${edition.window.endAt}`).then(data=>data.editorial || null).catch(()=>null));
    return editorialCache.get(key);
  }
  function researchEvent(editorial, eventId) {return editorial.events.find(event=>event.eventId===eventId);}
  function evidenceList(editorial, eventIds, token) {
    const box=el('div','','daily-evidence');
    for(const eventId of eventIds) {
      const event=researchEvent(editorial, eventId);
      if(!event) continue;
      const item=el('details','','daily-event');
      item.append(el('summary',event.title));
      for(const fact of event.facts) item.append(el('p',fact));
      const links=el('div','','daily-node-links');
      for(const nodeId of event.sourceNodeIds) {
        links.append(button('查看信息',async()=>{
          links.append(el('p','读取中…','daily-note'));
          try{const data=await host.api(`/api/v1/reports/tree/node?id=${encodeURIComponent(nodeId)}`);if(token!==epoch)return;remember(data.node);links.append(await card(data.node,token));}
          catch{if(token===epoch) links.append(el('p','信息节点暂时读不到。','daily-note'));}
        }));
      }
      item.append(links);box.append(item);
    }
    return box;
  }
  function renderResearchDaily(editorial, edition, token) {
    root.dataset.editorialId=editorial.id;root.dataset.editorialStatus=editorial.status;
    titleEl.hidden=false;titleEl.textContent=`${monthDay(edition.window.endAt)}研究日报`;
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
        const open=document.createElement('button');
        open.type='button';open.className='daily-direction-card';
        open.append(el('span',directions[article.direction] || '其他','daily-kicker'),el('h3',article.title),el('p',article.lead));
        open.addEventListener('click',()=>{openedDirection=article.direction;render();});
        page.append(open);
      }
    } else {
      const article=editorial.articles.find(item=>item.direction===openedDirection);
      if(!article) page.append(el('p','这个方向没有成稿。'));
      else {
        page.append(el('h3',article.title),el('p',article.lead,'daily-overview'));
        const themes=article.sections.filter(section=>section.kind!=='other');
        const extras=article.sections.filter(section=>section.kind==='other');
        for(const section of themes) {
          const block=el('section','','daily-section');
          block.append(el('h4',section.heading));
          for(const text of section.paragraphs) block.append(el('p',text));
          const related=editorial.relations.filter(relation=>section.eventIds.includes(relation.eventIds[0]));
          for(const relation of related) block.append(el('p',`${relationLabels[relation.type] || relation.type}：${relation.reason}`,'daily-note'));
          const proof=el('details','','daily-proof');
          proof.append(el('summary','相关事件与信息节点'));
          proof.append(evidenceList(editorial, section.eventIds, token));
          block.append(proof);page.append(block);
        }
        if(extras.length) {
          const extra=el('details','','daily-extra');
          const count=extras.reduce((sum,section)=>sum+section.eventIds.length,0);
          extra.append(el('summary',`其他动态（${count}）`));
          for(const section of extras) {
            section.paragraphs.forEach((text,index)=>extra.append(el('p',text,'daily-note')));
            extra.append(evidenceList(editorial, section.eventIds, token));
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
    const card=el('article','','post-card is-compact');card.dataset.nodeId=item.n.id;
    const open=document.createElement('button');open.type='button';open.className='feed-content';
    open.addEventListener('click',()=>{openedId=item.n.id;return render();});
    const meta=el('div','','post-meta');
    const when=item.edition.layer==='hourly' ? `${clock(item.edition.window.startAt)}–${clock(item.edition.window.endAt)}` : '';
    meta.append(el('span',directions[group(item.n)] || '其他','kind-tag'));
    if(when) meta.append(el('span',when,'post-time'));
    const excerpt=String(item.n.text || '').replace(/\s+/g,' ').trim();
    open.append(meta,el('h3',item.n.title));
    if(excerpt) open.append(el('p',excerpt.length>72 ? `${excerpt.slice(0,72).trim()}…` : excerpt,'post-excerpt'));
    card.append(open);return card;
  }
  async function readingSnapshot(edition) {
    if(!edition?.window) return null;
    const path=pinnedReadingId && openedId ? `/api/v1/reports/reading-hour/snapshot?id=${encodeURIComponent(pinnedReadingId)}` : `/api/v1/reports/reading-hour?startAt=${edition.window.startAt}&endAt=${edition.window.endAt}&scope=hour`;
    try{const data=await host.api(path);return data?.snapshot || null;}catch{return null;}
  }
  function readingFold(id, title, {note, seed, stale} = {}) {
    const details=document.createElement('details');details.className='reading-fold';details.open=readingOpen.has(id);
    const summary=document.createElement('summary');summary.className='feed-content';
    const heading=el('h3',title);
    if(stale) heading.append(el('span','时效不足','reading-stale'));
    summary.append(heading);
    if(note)summary.append(el('p',note,'post-excerpt'));
    const panel=el('div','','reading-fold-body');details.append(summary,panel);
    let loaded=false;
    async function load() {
      if(!details.open){readingOpen.delete(id);return;}
      readingOpen.add(id);if(loaded)return;loaded=true;panel.textContent='读取中…';
      const saved=await node(id).catch(()=>null);
      const view=(saved?.body || saved?.text) ? saved : (seed || saved);
      panel.replaceChildren(el('p',view?.body || view?.text || '这篇的正文暂时读不到。','tree-text'));
      if(canReadSource(view))panel.append(button('原文',()=>host.readSavedSource(view)));
    }
    details.addEventListener('toggle',load);
    if(details.open)void load();
    const card=el('article','','post-card is-compact reading-item');card.append(details);return card;
  }
  function appendTitleGroup(name, rows) {
    const section=el('section');section.append(el('h2',name,'reading-group'));
    for (const row of rows) section.append(readingFold(row.id,row.title,{seed:row}));
    list.append(section);
  }
  const readingDirectionOrder=['金融','产业个股','科技与AI','地缘政治','待分类'];
  const readingSliceOrder=['中国','美国','欧洲','日本','韩国','中国台湾','多地','其他','模型与技术','应用与工作流','安全与外交','贸易与限制'];
  function renderReadingDirections(rows, className = '') {
    if(!rows.length) return;
    const rank=(order,value)=> {const index=order.indexOf(value);return index<0 ? order.length : index;};
    const directions=[...new Set(rows.map(item=>item.readingDirectionName).filter(Boolean))].sort((a,b)=>rank(readingDirectionOrder,a)-rank(readingDirectionOrder,b));
    for(const directionName of directions){
      const matched=rows.filter(item=>item.readingDirectionName===directionName);
      const block=el('section','',className ? `reading-block ${className}` : 'reading-block');
      block.append(el('h2',directionName,'reading-direction'));
      const themes=[...new Set(matched.map(item=>item.readingThemeName).filter(Boolean))].sort((a,b)=>rank(readingSliceOrder,a)-rank(readingSliceOrder,b));
      for(const themeName of themes){
        const themeRows=matched.filter(item=>item.readingThemeName===themeName);
        const themeBlock=el('div','','reading-slice');
        themeBlock.append(el('div',themeName,'reading-group'));
        for(const item of themeRows) themeBlock.append(readingFold(item.nodeId,item.title,{stale:item.timely===false}));
        block.append(themeBlock);
      }
      for(const item of matched.filter(item=>!item.readingThemeName)) block.append(readingFold(item.nodeId,item.title,{stale:item.timely===false}));
      list.append(block);
    }
  }
  async function renderReadingHour(token,claim,edition,snapshot) {
    if(openedId) pinnedReadingId=snapshot.id; else pinnedReadingId='';
    finishOpening(claim,true);paintHourUnread();
    list.replaceChildren();
    list.append(el('p',`已处理 ${snapshot.scored}/${snapshot.candidates}，命中 ${snapshot.selected}。`,'tree-coverage'));
    syncReadingChrome(null);
    const shown=snapshot.items.filter(item=>item.readingDirectionName && item.readingDirectionName!=='待分类' && item.disposition!=='out-of-scope');
    renderReadingDirections(shown.filter(item=>item.disposition==='hit'));
    const rest=shown.filter(item=>item.disposition!=='hit');
    if(rest.length){list.append(el('h2','其他','reading-rest'));renderReadingDirections(rest,'is-rest');}
    root.dataset.readingSnapshot=snapshot.id;
    viewKey=`hourly-reading:${edition.window.startAt}:${snapshot.id}`;
    restoreScroll(false);
  }
  async function renderHourFeed(token,claim) {
    syncHourChrome();
    const rows=hourRows();
    paintHourStrip(rows);
    const edition=rows.find(item=>item.window.startAt===selectedHourStart) || null;
    selected=edition;root.dataset.editionId=edition?.id || '';root.dataset.windowStart=String(edition?.window.startAt ?? '');root.dataset.briefMode='hourly';
    const snapshot=await readingSnapshot(edition);
    if(token!==epoch){const current=claim?.ticket===opening.ticket;finishOpening(claim,false);if(current && root?.isConnected)paintHourUnread();return;}
    if(snapshot) return renderReadingHour(token,claim,edition,snapshot);
    const nodes=edition ? await editionNodes(edition) : [];
    if(token!==epoch){const current=claim?.ticket===opening.ticket;finishOpening(claim,false);if(current && root?.isConnected)paintHourUnread();return;}
    const articles=[];
    for(const module of (nodes || []).filter(Boolean)) {
      if(module.layer==='information' || !module.children?.length) {articles.push(module);continue;}
      try {
        const data=await host.api(`/api/v1/reports/tree/children?id=${encodeURIComponent(module.id)}`);
        const children=(data.children || []).filter(Boolean);
        if(token!==epoch)return;
        if(children.length){children.forEach(remember);articles.push(...children);} else articles.push(module);
      } catch {articles.push(module);}
    }
    if(token!==epoch){const current=claim?.ticket===opening.ticket;finishOpening(claim,false);if(current && root?.isConnected)paintHourUnread();return;}
    finishOpening(claim,true);paintHourUnread(rows);
    list.replaceChildren();
    syncReadingChrome(null);
    if(!articles.length) list.textContent='这个小时还没有小时报。';
    else for(const name of directionOrder) {
      const grouped=articles.filter(item=>group(item)===name);
      if(grouped.length) appendTitleGroup(directions[name],grouped);
    }
    viewKey=`hourly-feed:${selectedHourStart}`;
    restoreScroll(false);
  }
  async function render() {
    if(viewKey)positions.set(viewKey,window.scrollY);const token=++epoch;
    const hourlyFeed=mode==='hourly' && !showMaterials;
    const dailyFeed=mode==='daily' && !showMaterials;
    const openingClaim=hourlyFeed?beginOpening(ensureSelectedHour(hourRows())):null;
    list.textContent='读取中…';setPrimary();syncHourChrome();
    if(hourlyFeed && openedId) syncReadingChrome({node:null,label:'返回小时报',onBack:closeHour});
    else if(dailyFeed && (openedId || openedDirection)) syncReadingChrome({node:null,label:'返回日报',onBack:closeDaily});
    try {
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
      const attemptId=row?.attempt?.id && row.attempt.id!==selected.id && !row.attempt.pending ? row.attempt.id : '';
      const attemptTask=attemptId ? loadEditionDocument(attemptId) : null;
      const publishedTask=!selected.pendingIds && selected.id && !copyCount(selected) && !fullEditions.has(selected.id) ? loadEditionDocument(selected.id) : null;
      const nodes=await editionNodes(selected);if(token!==epoch)return;
      if(publishedTask){await publishedTask;if(token!==epoch)return;}
      const published=fullEditions.get(selected.id) || selected;
      let attempt=row?.attempt;
      if(attempt?.id===published.id)attempt=published;
      else if(attemptTask){const loaded=await attemptTask;if(token!==epoch)return;if(loaded)attempt=loaded;}
      const missingSources=(published.pendingIds || []).filter(id=>id.startsWith('source:')).length;
      const partial=published.status!=='ready';
      statusToggle.hidden=false;statusToggle.textContent=`${partial ? '部分结果 · ' : ''}更新于 ${stamp(published.generatedAt)}`;
      const pending=[...(attempt?.pending || []),...(attempt?.groupFailures || [])];
      const replay=mode==='daily' && published.window.endAt-published.window.startAt<20*3600000 ? '链路回放（非全天）。' : '';
      statusDetail.textContent=[replay,`版本 ${published.id.slice(-12)}`,partial ? `待补 ${(published.pendingIds || []).length-missingSources} 篇／${(published.missingHours || []).length} 小时` : '',attempt?.id && attempt.id!==published.id ? '最近尝试未替换已发布版本' : '',...new Set(pending.map(p=>reasons[p.reason] || p.reason))].filter(Boolean).join(' · ');
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
    }catch{if(token===epoch){finishOpening(openingClaim,false);paintHourUnread();list.replaceChildren(el('p','读取失败，请重试。'),button('重试读取',render));
      if((hourlyFeed || dailyFeed) && (openedId || openedDirection)) syncReadingChrome({node:null,label:hourlyFeed?'返回小时报':'返回日报',onBack:hourlyFeed?closeHour:closeDaily});
      else syncReadingChrome(null);}}
  }
  async function check(force=false){
    if(!active() || document.hidden)return;if(checking)return checking;const token=epoch;
    checking=(async()=>{const latest=await fetchManifest(force);if(token!==epoch || !active())return;const next=choice(editionRows(latest).find(r=>choice(r)?.window.startAt===selected?.window.startAt));
      if(JSON.stringify(editionRows(latest).map(choice))!==JSON.stringify(editionRows().map(choice))){nextManifest=latest;notice.replaceChildren(el('span',next && next.id!==selected?.id ? '所选时段有新版本。' : '刊期或处理进度已更新。'),button('接受更新',acceptUpdate));notice.hidden=false;}
    })().catch(()=>{}).finally(()=>{checking=null;});return checking;
  }
  async function acceptUpdate(){if(!nextManifest)return;editorialCache.clear();invalidateInformationIndex();manifest=nextManifest;nextManifest=null;notice.hidden=true;periods();await render();}
  // Pausing a retained page must not invalidate the ref handlers still mounted in it.
  function stop(){clearInterval(timer);timer=0;checking=null;}
  function resume(checkNow=true){clearInterval(timer);if(active() && !document.hidden)timer=setInterval(check,30000);if(checkNow)return check();}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(active())resume();});
  return {async mount(target,options={}){
    stop();epoch++;loadSeen();root=target;mode=options.mode==='hourly' ? 'hourly' : 'daily';dateFilter=options.date || '';showMaterials=false;root.replaceChildren();root.classList.add('tree-page','brief-page');
    if(options.resetSelection){selected=null;viewKey='';}
    const primary=el('div','','tree-primary');primary.setAttribute('role','tablist');primary.setAttribute('aria-label','简报');
    for(const [value,label] of [['daily','日报'],['hourly','小时报']]){const tab=button(label,()=>switchMode(value));tab.dataset.mode=value;tab.setAttribute('role','tab');primary.append(tab);}
    const issue=el('header','','tree-issue');
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
    hourChips=el('div','','chip-tabs tree-hour-chips tree-hour-wheel');hourChips.setAttribute('aria-label','选择小时');
    hourChips.addEventListener('wheel',event=>{if(Math.abs(event.deltaY)<=Math.abs(event.deltaX))return;hourChips.scrollLeft+=event.deltaY;event.preventDefault();},{passive:false});
    dayChips=el('div','','chip-tabs tree-hour-chips');dayChips.setAttribute('aria-label','日报日期');
    tools=el('div','','tree-tools');
    materialsBtn=button('本期材料',()=>{showMaterials=!showMaterials;render();});
    tools.append(materialsBtn);
    tagPanel=el('div','','tree-tag-panel');tagPanel.hidden=true;
    tag=el('select');tag.setAttribute('aria-label','主Tag筛选');tag.add(new Option('全部Tag','*'));tag.addEventListener('change',()=>{memory[mode]={...(memory[mode]||{}),tag:tag.value};render();});tagPanel.append(tag);
    notice=el('div','','tree-update');notice.hidden=true;notice.setAttribute('role','status');list=el('div','','tree-list');
    root.append(primary,issue,dayChips,hourChips,backIssues,directionNav,tools,tagPanel,notice,list);
    const token=epoch;
    if(!names.size)host.api('/api/v1/tags').then(({catalog})=>{if(token!==epoch)return;for(const t of catalog?.tags || [])names.set(t.id,t.name);for(const option of tag.options)if(names.has(option.value))option.textContent=names.get(option.value);}).catch(()=>{});
    try{
      manifest=options.manifest || await fetchManifest();if(token!==epoch)return;
      if(mode==='daily' && !editionRows().length) mode='hourly';
      const saved=memory[mode] || {};direction=saved.direction ?? null;directionExplicit=Boolean(saved.directionExplicit);if(saved.tag)tag.value=saved.tag;
      periods();await render();resume(false);
    }catch{if(token===epoch)list.replaceChildren(el('p','暂时无法读取简报。'),button('重试读取',()=>this.mount(target,options)));}
  },check,acceptUpdate,resume,stop,selectDirection(value){if(directions[value]){direction=value;directionExplicit=true;return render();}},reset(){root?.querySelectorAll('.tree-reading-chrome').forEach(node=>node.remove());root?.classList.remove('is-reading');stop();epoch++;session++;cache.clear();nodeRequests.clear();editionCache.clear();editorialCache.clear();fullEditions.clear();editionLoads.clear();invalidateInformationIndex();expanded.clear();positions.clear();viewKey='';selected=null;direction=null;directionExplicit=false;showMaterials=false;selectedHourStart=0;dailyStart=0;openedId='';openedDirection='';hourStripKey='';seen=new Set();seenIds=[];opening={id:'',ticket:0};manifest=null;nextManifest=null;memory.hourly={};memory.daily={};root=null;}};
}
