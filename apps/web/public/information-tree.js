const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
const button=(text,action)=>{const n=el('button',text);n.type='button';n.addEventListener('click',action);return n;};
const directions={finance:'金融与市场',policy:'时事与政策',tech:'科技与产业',other:'其他'};
// Compatibility display mapping for pre-direction readers. New servers return the
// Instance mapping, including an explicit 'other', which takes precedence.
const previousDirections={macro:'finance',macro_commodity:'finance',crypto:'finance',market_us:'finance',market_cn:'finance',market_hk:'finance',geopolitics:'policy',
  ai:'tech',ai_compute:'tech',ai_model:'tech',ai_application:'tech',semiconductor:'tech',semiconductor_memory:'tech',semiconductor_optical:'tech',semiconductor_equipment:'tech',semiconductor_packaging:'tech',internet:'tech',software:'tech',gaming:'tech',graphics:'tech',auto:'tech',energy:'tech',communications:'tech',datacenter:'tech'};
export function createInformationTreePage(host) {
  let root,list,meta,period,tag,notice,directionNav,mode='hourly',direction=null,manifest,selected=null,epoch=0,timer=0,dateFilter='',checking=null;
  const names=new Map(),cache=new Map(),expanded=new Set(),positions=new Map();let viewKey='',nextManifest=null;
  const active=()=>root?.isConnected && root.classList.contains('tree-page') && (host.active?.() ?? true) && (host.session?.() ?? true);
  const stamp=at=>new Intl.DateTimeFormat('zh-CN',{timeZone:manifest?.timezone || 'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(at);
  const day=at=>{const parts=new Intl.DateTimeFormat('en-US',{timeZone:manifest?.timezone || 'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at);return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');};
  const group=n=>manifest?.directions?.[n.tagId] || previousDirections[n.tagId] || 'other';
  const expansionKey=n=>`${n.layer}:${[...n.articleIds].sort().join('|')}`;
  const fetchManifest=()=>{const endAt=Date.now()+1;return host.api(`/api/v1/reports/tree?startAt=${endAt-7*86400000}&endAt=${endAt}`);};
  const node=async id=>{if(!cache.has(id)){const token=epoch,data=await host.api(`/api/v1/reports/tree/node?id=${encodeURIComponent(id)}`);if(token!==epoch)throw new Error('过期读取');cache.set(id,data.node);}return cache.get(id);};
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
        try{const data=await host.api(`/api/v1/reports/tree/children?id=${encodeURIComponent(n.id)}`);if(token!==epoch)return;children.replaceChildren();for(const child of data.children)children.append(await card(child,token));loaded=true;}
        catch{if(token===epoch)children.replaceChildren(button('读取失败，重试',()=>{details.open=false;details.open=true;}));}
      });
      if(expanded.has(key))details.open=true;
    }
    return article;
  }
  const choice=r=>mode==='information' ? r?.attempt : r?.edition || r?.attempt;
  function editionRows(data=manifest) {
    if(!data)return [];let rows=mode==='daily' ? data.days : data.hours;
    if(mode==='information' && data.information?.length){
      const groups=new Map();for(const n of data.information){const at=Math.floor((n.eventAt ?? n.window.startAt)/3600000)*3600000;groups.set(at,[...(groups.get(at) || []),n.id]);}
      rows=[...groups].sort(([a],[b])=>b-a).map(([at,inputIds])=>{const previous=data.hours.find(r=>r.attempt?.window.startAt===at)?.attempt;return {attempt:{...previous,id:`prepared:${at}:${inputIds.join(',')}`,inputIds,window:{startAt:at,endAt:at+3600000},status:previous?.status || 'ready',pendingIds:previous?.pendingIds || [],missingHours:[]}};});
    }
    return (rows || []).filter(r=>!dateFilter || day(mode==='daily' ? choice(r).window.endAt : choice(r).window.startAt)===dateFilter);
  }
  function periods(){const rows=editionRows().map(choice).filter(Boolean),at=selected?.window.startAt;period.replaceChildren(...rows.map(r=>new Option(stamp(r.window.startAt),String(r.window.startAt))));if(rows.some(r=>r.window.startAt===at))period.value=String(at);else{const usable=rows.find(r=>(mode==='information' ? r.inputIds : r.roots)?.length);if(usable)period.value=String(usable.window.startAt);}}
  async function render() {
    if(viewKey)positions.set(viewKey,window.scrollY);const token=++epoch;list.textContent='读取中…';
    try {
      const rows=editionRows(),row=rows.find(r=>choice(r)?.window.startAt===Number(period.value)) || rows[0];selected=choice(row);
      root.dataset.editionId=selected?.id || '';root.dataset.windowStart=String(selected?.window.startAt ?? '');
      if(!selected){list.textContent='该时段尚无浓缩树结果。旧稿可在历史简报阅读。';meta.textContent='';return;}
      const missingSources=selected.pendingIds.filter(id=>id.startsWith('source:')).length;
      const replay=mode==='daily' && selected.window.endAt-selected.window.startAt<20*3600000 ? ' · 链路回放（非全天）' : '';
      meta.textContent=`所选 ${stamp(selected.window.startAt)} — ${stamp(selected.window.endAt)}${replay} · 所读版本 ${selected.id.slice(-12)} · 生成于 ${stamp(selected.generatedAt)}${selected.status!=='ready' ? ` · 部分结果，待补 ${selected.pendingIds.length-missingSources} 篇／${selected.missingHours.length} 小时` : ''}${row.attempt?.id!==selected.id ? ' · 最近尝试未替换已发布版本' : ''}`;
      const reasons={'needs-content':'正文待补','information-not-ready':'信息加工待完成','retryable-model-error':'模型暂时故障','queue-timeout':'排队超时','execution-timeout':'执行超时','budget-deferred':'预算延期','lease-conflict':'同版本加工中','invalid-output':'输出不合法','stale-policy':'规则已更新'};
      const pending=[...(row.attempt?.pending || []),...(row.attempt?.groupFailures || [])];if(pending.length)meta.textContent+=' · '+[...new Set(pending.map(p=>reasons[p.reason] || p.reason))].join('、');
      const nodes=await Promise.all((mode==='information' ? selected.inputIds : selected.roots).map(node));if(token!==epoch)return;
      if(direction===null)direction=nodes.length ? group(nodes[0]) : 'finance';for(const tab of directionNav.children)tab.setAttribute('aria-selected',String(tab.dataset.direction===direction));
      const inDirection=nodes.filter(n=>group(n)===direction),tags=[...new Set(inDirection.map(n=>n.tagId))],chosen=tag.value;
      tag.replaceChildren(new Option('全部Tag','*'),...tags.map(t=>new Option(names.get(t) || t || '未分类',t || '')));tag.value=tags.some(t=>(t || '')===chosen) ? chosen : '*';
      list.replaceChildren();for(const n of inDirection.filter(n=>tag.value==='*' || (n.tagId || '')===tag.value))list.append(await card(n,token));
      if(!nodes.length)list.textContent='本期没有可用内容；待补状态见上方。';else if(!inDirection.length)list.textContent='本期此方向没有模块。';
      viewKey=`${mode}:${selected.window.startAt}:${direction}:${tag.value}`;if(positions.has(viewKey))window.scrollTo({top:positions.get(viewKey),behavior:'instant'});
    }catch{if(token===epoch)list.textContent='读取失败，请刷新重试。';}
  }
  async function check(){
    if(!active() || document.hidden)return;if(checking)return checking;const token=epoch;
    checking=(async()=>{const latest=await fetchManifest();if(token!==epoch || !active())return;const next=choice(editionRows(latest).find(r=>choice(r)?.window.startAt===selected?.window.startAt));
      if(JSON.stringify(editionRows(latest).map(choice))!==JSON.stringify(editionRows().map(choice))){nextManifest=latest;notice.replaceChildren(el('span',next && next.id!==selected?.id ? '所选时段有新版本。' : '刊期或处理进度已更新。'),button('接受更新',acceptUpdate));notice.hidden=false;}
    })().catch(()=>{}).finally(()=>{checking=null;});return checking;
  }
  async function acceptUpdate(){if(!nextManifest)return;manifest=nextManifest;nextManifest=null;notice.hidden=true;periods();await render();}
  function stop(){clearInterval(timer);timer=0;epoch++;checking=null;}
  function resume(){clearInterval(timer);if(active() && !document.hidden)timer=setInterval(check,30000);return check();}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(active())resume();});
  return {async mount(target,options={}){
    stop();root=target;mode=options.mode || mode;dateFilter=options.date || '';root.replaceChildren();root.classList.add('tree-page','brief-page');
    const header=el('div','','tree-controls');if(host.back)header.append(button('历史简报',host.back));
    for(const [value,label] of [['information','信息'],['hourly','小时'],['daily','日报']]){const tab=button(label,()=>{mode=value;for(const b of header.querySelectorAll('[data-mode]'))b.setAttribute('aria-pressed',String(b.dataset.mode===mode));periods();render();});tab.dataset.mode=value;tab.setAttribute('aria-pressed',String(value===mode));header.append(tab);}
    period=el('select');period.setAttribute('aria-label','选择树刊期');period.addEventListener('change',render);tag=el('select');tag.setAttribute('aria-label','主Tag筛选');tag.add(new Option('全部Tag','*'));tag.addEventListener('change',render);header.append(period,tag,button('检查更新',check));
    directionNav=el('div','','brief-direction-tabs');directionNav.setAttribute('role','tablist');directionNav.setAttribute('aria-label','阅读方向');
    for(const [value,label] of Object.entries(directions)){const tab=button(label,()=>{direction=value;render();});tab.className='brief-direction-tab';tab.dataset.direction=value;tab.setAttribute('role','tab');directionNav.append(tab);}
    notice=el('div','','tree-update');notice.hidden=true;notice.setAttribute('role','status');meta=el('p','','tree-status');list=el('div','','tree-list');root.append(directionNav,header,notice,meta,list);
    const token=epoch;try{manifest=options.manifest || await fetchManifest();try{const {catalog}=await host.api('/api/v1/tags');for(const t of catalog?.tags || [])names.set(t.id,t.name);}catch{}if(token!==epoch)return;periods();await render();resume();}catch{if(token===epoch)list.textContent='暂时无法读取浓缩树。';}
  },check,acceptUpdate,resume,stop,selectDirection(value){if(directions[value]){direction=value;return render();}},reset(){stop();cache.clear();expanded.clear();positions.clear();viewKey='';selected=null;direction=null;manifest=null;nextManifest=null;root=null;}};
}
