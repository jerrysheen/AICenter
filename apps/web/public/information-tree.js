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
  let root,list,titleEl,coverageEl,statusToggle,statusDetail,directionNav,materialsBtn,tagPanel,tag,period,backIssues,notice,mode='daily',direction=null,directionExplicit=false,showMaterials=false,manifest,selected=null,epoch=0,timer=0,dateFilter='',checking=null;
  const names=new Map(),cache=new Map(),nodeRequests=new Map(),editionCache=new Map(),expanded=new Set(),positions=new Map(),memory={hourly:{},daily:{}};let viewKey='',nextManifest=null;
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
  const fetchManifest=(force=false)=>{if(host.loadTreeManifest)return host.loadTreeManifest({force});const endAt=Date.now()+1;return host.api(`/api/v1/reports/tree?view=reading&startAt=${endAt-7*86400000}&endAt=${endAt}`);};
  const node=async id=>{
    if(cache.has(id))return cache.get(id);
    if(!nodeRequests.has(id)){const token=epoch;nodeRequests.set(id,host.api(`/api/v1/reports/tree/node?id=${encodeURIComponent(id)}`).then(data=>{if(token===epoch)remember(data.node);return data.node;}).finally(()=>nodeRequests.delete(id)));}
    return nodeRequests.get(id);
  };
  async function editionNodes(edition) {
    if(edition.roots.every(id=>cache.has(id)))return edition.roots.map(id=>cache.get(id));
    if(!editionCache.has(edition.id)) {
      const token=epoch;
      const pending=host.api(`/api/v1/reports/tree/edition?id=${encodeURIComponent(edition.id)}`).catch(()=>Promise.all(edition.roots.map(node)).then(nodes=>({edition,nodes}))).then(data=>{
        if(data.edition?.id!==edition.id || data.nodes?.length!==edition.roots.length)throw new Error('刊期版本未能读取');
        if(token===epoch)data.nodes.forEach(remember);return data.nodes;
      }).catch(error=>{editionCache.delete(edition.id);throw error;});
      editionCache.set(edition.id,pending);while(editionCache.size>8)editionCache.delete(editionCache.keys().next().value);
    }
    return editionCache.get(edition.id);
  }
  async function card(n,token) {
    const article=el('article','','tree-card');article.dataset.nodeId=n.id;article.dataset.layer=n.layer;
    article.append(el('h3',n.title),el('p',n.text,'tree-text'));
    if(n.layer==='information' && n.body && n.body!==n.text) {const body=el('details','','tree-ref');body.append(el('summary','中文正文'),el('p',n.body,'tree-text'));article.append(body);}
    if(n.layer==='information') {if(n.sourceRefs?.length && host.readSavedSource)article.append(button('原文',()=>host.readSavedSource(n)));}
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
    else {const usable=rows.find(r=>r.roots?.length);if(usable)period.value=String(usable.window.startAt);}
  }
  function setPrimary() {
    for(const tab of root.querySelectorAll('[data-mode]')){const on=tab.dataset.mode===mode;tab.setAttribute('aria-pressed',String(on));tab.setAttribute('aria-selected',String(on));}
    materialsBtn.setAttribute('aria-pressed',String(showMaterials));
  }
  function switchMode(next) {
    if(next===mode && !showMaterials) return;
    if(next!==mode) rememberIssue();
    mode=next;showMaterials=false;
    const saved=memory[mode] || {};
    direction=saved.direction ?? null;directionExplicit=Boolean(saved.directionExplicit);
    if(tag) tag.value=saved.tag || '*';
    selected=null;periods();setPrimary();return render();
  }
  async function render() {
    if(viewKey)positions.set(viewKey,window.scrollY);const token=++epoch;list.textContent='读取中…';setPrimary();
    try {
      const rows=editionRows(),row=rows.find(r=>choice(r)?.window.startAt===Number(period.value)) || rows[0];selected=choice(row);
      root.dataset.editionId=selected?.id || '';root.dataset.windowStart=String(selected?.window.startAt ?? '');root.dataset.briefMode=mode;
      if(!selected){
        titleEl.textContent=mode==='daily' ? '还没有日报' : '还没有小时报';coverageEl.textContent='';statusToggle.hidden=true;statusDetail.hidden=true;
        list.textContent='这一栏还没有已发布简报。可以打开往期，或查看旧版存档。';return;
      }
      titleEl.textContent=issueTitle(selected);coverageEl.textContent=issueCoverage(selected);
      const missingSources=(selected.pendingIds || []).filter(id=>id.startsWith('source:')).length;
      const partial=selected.status!=='ready';
      statusToggle.hidden=false;statusToggle.textContent=`${partial ? '部分结果 · ' : ''}更新于 ${stamp(selected.generatedAt)}`;
      const pending=[...(row?.attempt?.pending || []),...(row?.attempt?.groupFailures || [])];
      const replay=mode==='daily' && selected.window.endAt-selected.window.startAt<20*3600000 ? '链路回放（非全天）。' : '';
      statusDetail.textContent=[replay,`版本 ${selected.id.slice(-12)}`,partial ? `待补 ${selected.pendingIds.length-missingSources} 篇／${selected.missingHours.length} 小时` : '',row?.attempt?.id && row.attempt.id!==selected.id ? '最近尝试未替换已发布版本' : '',...new Set(pending.map(p=>reasons[p.reason] || p.reason))].filter(Boolean).join(' · ');
      const nodes=await editionNodes(selected);if(token!==epoch)return;
      if(!directionExplicit){const available=directionOrder.find(value=>nodes.some(n=>group(n)===value));direction=available || 'finance';}
      for(const tab of directionNav.children) tab.setAttribute('aria-selected',String(tab.dataset.direction===direction));
      const source=showMaterials ? await Promise.all((manifest.information || []).filter(n=>{const at=n.eventAt ?? n.window?.startAt;return at>=selected.window.startAt && at<selected.window.endAt;}).map(n=>node(n.id))) : nodes;
      if(token!==epoch)return;
      const inDirection=source.filter(n=>n && group(n)===direction),tags=[...new Set(inDirection.map(n=>n.tagId))],chosen=tag.value;
      tag.replaceChildren(new Option('全部Tag','*'),...tags.map(t=>new Option(names.get(t) || t || '未分类',t || '')));tag.value=tags.some(t=>(t || '')===chosen) ? chosen : '*';
      list.replaceChildren();
      for(const n of inDirection.filter(n=>tag.value==='*' || n.tagId===tag.value)) list.append(await card(n,token));
      if(!source.length) list.textContent=showMaterials ? '本期没有可展开的原始信息。' : '本期没有可用内容。';
      else if(!inDirection.length) list.textContent=showMaterials ? '本期材料里这个方向没有条目。' : '本期这个方向没有模块。';
      rememberIssue();
      viewKey=`${mode}:${selected.window.startAt}:${direction}:${tag.value}:${showMaterials?'materials':'brief'}`;
      if(active() && positions.has(viewKey)) window.scrollTo({top:positions.get(viewKey),behavior:'instant'});
    }catch{if(token===epoch)list.replaceChildren(el('p','读取失败，请重试。'),button('重试读取',render));}
  }
  async function check(force=false){
    if(!active() || document.hidden)return;if(checking)return checking;const token=epoch;
    checking=(async()=>{const latest=await fetchManifest(force);if(token!==epoch || !active())return;const next=choice(editionRows(latest).find(r=>choice(r)?.window.startAt===selected?.window.startAt));
      if(JSON.stringify(editionRows(latest).map(choice))!==JSON.stringify(editionRows().map(choice))){nextManifest=latest;notice.replaceChildren(el('span',next && next.id!==selected?.id ? '所选时段有新版本。' : '刊期或处理进度已更新。'),button('接受更新',acceptUpdate));notice.hidden=false;}
    })().catch(()=>{}).finally(()=>{checking=null;});return checking;
  }
  async function acceptUpdate(){if(!nextManifest)return;manifest=nextManifest;nextManifest=null;notice.hidden=true;periods();await render();}
  // Pausing a retained page must not invalidate the ref handlers still mounted in it.
  function stop(){clearInterval(timer);timer=0;checking=null;}
  function resume(checkNow=true){clearInterval(timer);if(active() && !document.hidden)timer=setInterval(check,30000);if(checkNow)return check();}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(active())resume();});
  return {async mount(target,options={}){
    stop();epoch++;root=target;mode=options.mode==='hourly' ? 'hourly' : 'daily';dateFilter=options.date || '';showMaterials=false;root.replaceChildren();root.classList.add('tree-page','brief-page');
    if(options.resetSelection){selected=null;viewKey='';}
    const primary=el('div','','tree-primary');primary.setAttribute('role','tablist');primary.setAttribute('aria-label','简报');
    for(const [value,label] of [['daily','日报'],['hourly','小时报']]){const tab=button(label,()=>switchMode(value));tab.dataset.mode=value;tab.setAttribute('role','tab');primary.append(tab);}
    const issue=el('header','','tree-issue');
    const heading=el('div','','tree-issue-heading');
    titleEl=el('h2','','tree-issue-title');
    const past=button('往期',()=>{backIssues.hidden=!backIssues.hidden;past.setAttribute('aria-expanded',String(!backIssues.hidden));});
    past.setAttribute('aria-expanded','false');heading.append(titleEl,past);issue.append(heading);
    coverageEl=el('p','','tree-coverage');
    const statusRow=el('div','','tree-status-row');
    statusToggle=button('',()=>{const open=statusDetail.hidden;statusDetail.hidden=!open;statusToggle.setAttribute('aria-expanded',String(open));});
    statusToggle.className='tree-status-toggle';statusToggle.setAttribute('aria-expanded','false');
    const refresh=button('检查更新',()=>check(true));refresh.className='tree-refresh';
    statusRow.append(statusToggle,refresh);statusDetail=el('p','','tree-status-detail');statusDetail.hidden=true;
    issue.append(coverageEl,statusRow,statusDetail);
    backIssues=el('div','','tree-back-issues');backIssues.hidden=!options.history;
    if(options.history || options.date){if(host.latest)backIssues.append(button('返回最新简报',host.latest));past.setAttribute('aria-expanded','true');}
    const date=el('input');date.type='date';date.value=dateFilter;date.setAttribute('aria-label','简报日期');date.addEventListener('change',()=>{dateFilter=date.value;selected=null;periods();render();});
    period=el('select');period.setAttribute('aria-label','选择往期');period.addEventListener('change',()=>{memory[mode]={...(memory[mode]||{}),startAt:Number(period.value)};render();});
    backIssues.append(date,period);if(host.archive)backIssues.append(button('旧版存档',host.archive));
    directionNav=el('div','','brief-direction-tabs');directionNav.setAttribute('role','tablist');directionNav.setAttribute('aria-label','阅读方向');
    for(const [value,label] of Object.entries(directions)){const tab=button(label,()=>{direction=value;directionExplicit=true;render();});tab.className='brief-direction-tab';tab.dataset.direction=value;tab.setAttribute('role','tab');directionNav.append(tab);}
    const tools=el('div','','tree-tools');
    materialsBtn=button('本期材料',()=>{showMaterials=!showMaterials;render();});
    const tagBtn=button('Tag',()=>{tagPanel.hidden=!tagPanel.hidden;tagBtn.setAttribute('aria-expanded',String(!tagPanel.hidden));});
    tagBtn.setAttribute('aria-expanded','false');tools.append(materialsBtn,tagBtn);
    tagPanel=el('div','','tree-tag-panel');tagPanel.hidden=true;
    tag=el('select');tag.setAttribute('aria-label','主Tag筛选');tag.add(new Option('全部Tag','*'));tag.addEventListener('change',()=>{memory[mode]={...(memory[mode]||{}),tag:tag.value};render();});tagPanel.append(tag);
    notice=el('div','','tree-update');notice.hidden=true;notice.setAttribute('role','status');list=el('div','','tree-list');
    root.append(primary,issue,backIssues,directionNav,tools,tagPanel,notice,list);
    const token=epoch;
    if(!names.size)host.api('/api/v1/tags').then(({catalog})=>{if(token!==epoch)return;for(const t of catalog?.tags || [])names.set(t.id,t.name);for(const option of tag.options)if(names.has(option.value))option.textContent=names.get(option.value);}).catch(()=>{});
    try{
      manifest=options.manifest || await fetchManifest();if(token!==epoch)return;
      if(mode==='daily' && !editionRows().length) mode='hourly';
      const saved=memory[mode] || {};direction=saved.direction ?? null;directionExplicit=Boolean(saved.directionExplicit);if(saved.tag)tag.value=saved.tag;
      periods();await render();resume(false);
    }catch{if(token===epoch)list.replaceChildren(el('p','暂时无法读取简报。'),button('重试读取',()=>this.mount(target,options)));}
  },check,acceptUpdate,resume,stop,selectDirection(value){if(directions[value]){direction=value;directionExplicit=true;return render();}},reset(){stop();epoch++;cache.clear();nodeRequests.clear();editionCache.clear();expanded.clear();positions.clear();viewKey='';selected=null;direction=null;directionExplicit=false;showMaterials=false;manifest=null;nextManifest=null;memory.hourly={};memory.daily={};root=null;}};
}
