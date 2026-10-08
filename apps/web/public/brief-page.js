import {createInformationTreePage} from './information-tree.js?v=9';
const HOUR = 3600000;
const ARTICLE_VERSION='brief-editorial-v3';
const DIRECTION_LABELS={finance:'金融与市场',policy:'时事与政策',tech:'科技与产业',other:'其他'};
export function briefReadingItems(editorial) {
  if(editorial?.status!=='ready') return [];
  if(editorial.version!==ARTICLE_VERSION) return editorial.directions.flatMap(d=>d.topics);
  return editorial.directions.map(d=>{
    const paragraphs=[d.lead,...d.sections.flatMap(s=>s.paragraphs)];
    return {id:d.id,title:d.articleTitle,body:[d.lead.text,...d.sections.flatMap(s=>[s.heading,...s.paragraphs.map(p=>p.text)].filter(Boolean))].join('\n\n'),
      evidence:[...new Map(paragraphs.flatMap(p=>p.evidence).map(e=>[JSON.stringify(e),e])).values()]};
  });
}


export function briefDate(at, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(at);
  return ['year','month','day'].map(key => parts.find(p => p.type === key).value).join('-');
}

// Resolve calendar boundaries in the Instance timezone, including DST days.
export function briefDayWindow(date, timezone) {
  const midnight = value => {
    const target = Date.parse(`${value}T00:00:00Z`);
    let at = target;
    for (let i=0; i<4; i++) {
      const p = new Intl.DateTimeFormat('en-US', {timeZone:timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'}).formatToParts(at);
      const get = key => Number(p.find(v => v.type === key).value);
      const represented = Date.UTC(get('year'), get('month')-1, get('day'), get('hour'), get('minute'), get('second'));
      at += target-represented;
    }
    return at;
  };
  const next = new Date(Date.parse(`${date}T00:00:00Z`)+24*HOUR).toISOString().slice(0,10);
  return {startAt:midnight(date), endAt:midnight(next)};
}

export function informationSignature(item) {
  // IDs change when immutable snapshots change. Unchanged sentence + source versions stays read.
  const text = JSON.stringify([item.sentence, (item.evidence || []).map(e =>
    [e.materialId,e.paragraphId,e.materialHash || '',e.materialVersion || '']).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
  let hash = 14695981039346656037n;
  for (const char of text) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 1099511628211n);
  return hash.toString(16);
}

export function distinctMaterialCount(evidence = []) {
  return new Set(evidence.map(e => e.materialId)).size;
}

function node(tag, className='', text='') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function button(text, action, className='brief-button') {
  const el = node('button',className,text); el.type='button';
  el.addEventListener('click',action); return el;
}

export function createBriefPage(host) {
  let treeActive=false;
  let treeManifest=null,treeManifestAt=0,treeManifestRequest=null,treeCacheEpoch=0;
  const loadTreeManifest=({force=false}={})=>{
    if(!force && treeManifest && Date.now()-treeManifestAt<30000)return Promise.resolve(treeManifest);
    if(treeManifestRequest)return treeManifestRequest;
    const identity=s.identity,cacheEpoch=treeCacheEpoch,endAt=Date.now()+1;
    treeManifestRequest=host.api(`/api/v1/reports/tree?view=reading&startAt=${endAt-7*86400000}&endAt=${endAt}`).then(data=>{
      if(identity===s.identity && cacheEpoch===treeCacheEpoch){treeManifest=data;treeManifestAt=Date.now();}return data;
    }).finally(()=>{if(cacheEpoch===treeCacheEpoch)treeManifestRequest=null;});return treeManifestRequest;
  };
  const navigate=(page)=>host.navigate ? host.navigate(`report${page ? '/'+page : ''}`) : mount(root,{history:page==='history',archive:page==='archive'});
  const tree=createInformationTreePage({...host,loadTreeManifest,history:()=>navigate('history'),latest:()=>navigate(''),archive:()=>navigate('archive')});
  const s = {identity:'', mode:'hourly', date:'', timezone:'', hours:[], manifest:[], brief:null, window:null,
    direction:'finance', directionInitialized:false, hourStart:null, positions:new Map(), history:[], pending:null, read:new Set(), saved:new Set(), expanded:new Set(), query:'', unread:false,
    savedOnly:false, loading:false, error:'', checkedAt:0, viewingHistory:false};
  let root, content, rail, nav, banner, status, publication, dateInput, dateLabel, datePicker, tools, tabs, directionTabs, periodSelect, generation=0, request=0, timer=0;
  let busy=null, dialog=null, evidenceRequest=0, focusReturn=null, routeKey='';
  const storage = () => {try {return localStorage;} catch {return null;}};
  const active = () => Boolean(root?.isConnected && host.active() && host.session() && s.identity);
  const key = () => `ai-center.brief.${encodeURIComponent(s.identity)}`;
  const time = (at, options={hour:'2-digit',minute:'2-digit'}) => new Intl.DateTimeFormat('zh-CN', {timeZone:s.timezone || 'Asia/Shanghai',hourCycle:'h23',...options}).format(at);
  const stamp = at => time(at,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const visibleItems = items => items.filter(i => (!s.unread || !s.read.has(informationSignature(i)))
    && (!s.savedOnly || s.saved.has(informationSignature(i))) && (!s.query || i.sentence.toLocaleLowerCase().includes(s.query.toLocaleLowerCase())));

  function persist() {
    try {storage()?.setItem(key(),JSON.stringify({mode:s.mode,direction:s.direction, read:[...s.read].slice(-3000), saved:[...s.saved].slice(-3000)}));} catch {}
  }

  function setIdentity() {
    const session=host.session();
    const identity=session ? `${session.role}:${session.device?.id || 'desktop'}` : '';
    if (identity===s.identity) return;
    reset(true); s.identity=identity;
    if (!identity) return;
    try {
      const stored=JSON.parse(storage()?.getItem(key()) || '{}');
      s.mode=stored.mode==='daily' ? 'daily' : 'hourly';
      if(DIRECTION_LABELS[stored.direction]) {s.direction=stored.direction;s.directionInitialized=true;}
      s.read=new Set(Array.isArray(stored.read) ? stored.read.filter(k=>/^[a-f0-9]{1,16}$/.test(k)).slice(-3000) : []);
      s.saved=new Set(Array.isArray(stored.saved) ? stored.saved.filter(k=>/^[a-f0-9]{1,16}$/.test(k)).slice(-3000) : []);
    } catch {}
  }

  function reset(clearStorage=false) {
    tree.reset();treeActive=false;
    treeCacheEpoch++;treeManifest=null;treeManifestAt=0;treeManifestRequest=null;
    stop(); generation++; request++; evidenceRequest++;
    if (clearStorage && s.identity) {try {storage()?.removeItem(key());} catch {}}
    dialog?.close(); dialog?.remove(); dialog=null;
    Object.assign(s,{identity:'',mode:'hourly',date:'',timezone:'',hours:[],manifest:[],brief:null,window:null,
      direction:'finance',directionInitialized:false,hourStart:null,history:[],pending:null,query:'',unread:false,savedOnly:false,loading:false,error:'',checkedAt:0,viewingHistory:false});
    s.read.clear(); s.saved.clear(); s.expanded.clear();s.positions.clear();
    root?.replaceChildren(); root=null; busy=null; routeKey='';
  }

  function stop() {clearInterval(timer); timer=0;tree.stop();}

  function start() {
    stop();
    if (active() && !document.hidden) timer=setInterval(()=>check().catch(()=>{}),60000);
  }

  async function mount(target, {date='',history=false,archive=false}={}) {
    setIdentity();
    const nextRoute=archive ? 'archive' : date || (history ? 'history' : 'current');
    if (root===target && routeKey===nextRoute && root.childElementCount && (treeActive || dateInput?.isConnected)) {if(treeActive)return tree.resume();start();return check();}
    routeKey=nextRoute; root=target; generation++; request++; busy=null;
    if(!archive) {
      const token=generation;
      if(!treeManifest)root.replaceChildren(node('p','brief-empty','正在读取简报…'));
      const manifest=await loadTreeManifest().catch(()=>null);
      if(token!==generation)return;
      if(!manifest){root.replaceChildren(node('p','brief-empty','暂时无法读取简报刊期。'),button('重试读取',()=>{routeKey='';return mount(target,{date,history,archive});}));return;}
      // During a rolling upgrade the older reader lacks pipeline; independently prepared
      // v3.1 heads prove the tree preparation path is active. Explicit legacy always wins.
      const treeEnabled=manifest.pipeline==='tree-v3' || (manifest.pipeline===undefined && manifest.information?.some(n=>n.validatorVersion==='tree-response-v3.1.0'));
      if(treeEnabled) {stop();treeActive=true;return tree.mount(root,{manifest,date,history,mode:'daily',resetSelection:true});}
    }
    treeActive=false;tree.stop();root.classList.remove('tree-page');
    if (date) {s.date=date; s.mode='daily'; s.brief=null; s.window=null; s.pending=null;}
    if(archive){s.timezone=treeManifest?.timezone || s.timezone || 'Asia/Shanghai';s.date ||= briefDate(Date.now(),s.timezone);s.loading=false;build();return showHistoryPanel();}
    s.loading=true; build(history); start();
    return loadInitial(history || archive);
  }

  function build() {
    root.classList.add('brief-page'); root.replaceChildren();
    directionTabs=node('div','brief-direction-tabs');directionTabs.setAttribute('role','tablist');directionTabs.setAttribute('aria-label','阅读方向');
    const top=node('div','brief-top');
    tabs=node('div','brief-tabs'); tabs.setAttribute('role','tablist'); tabs.setAttribute('aria-label','简报视图');
    for (const [mode,label] of [['hourly','小时更新'],['daily','日报精选']]) {
      const tab=button(label,()=>switchMode(mode),'brief-tab'); tab.dataset.mode=mode;
      tab.setAttribute('role','tab'); tab.id=`brief-tab-${mode}`; tab.setAttribute('aria-controls','brief-content');
      tab.addEventListener('keydown',e=>{if (['ArrowLeft','ArrowRight'].includes(e.key)) {e.preventDefault(); switchMode(mode==='hourly'?'daily':'hourly'); tabs.querySelector(`[data-mode="${s.mode}"]`).focus();}});
      tabs.append(tab);
    }
    const controls=node('div','brief-controls');
    if(routeKey==='archive')controls.append(button('返回历史简报',()=>navigate('history')),node('span','brief-muted','旧版存档（停止更新）'));
    if(routeKey!=='archive')controls.append(button('三层浓缩树',()=>{stop();treeActive=true;tree.mount(root);}));
    datePicker=node('details','brief-date-picker'); dateLabel=node('summary','brief-date-label','日期');
    const dates=node('div','brief-date-options');
    dateInput=node('input','brief-date'); dateInput.type='date'; dateInput.setAttribute('aria-label','选择简报日期');
    dateInput.addEventListener('change',()=>{if (dateInput.value) {datePicker.open=false;selectDate(dateInput.value);}});
    const past=node('div','brief-date-history');
    dates.append(dateInput,past);datePicker.append(dateLabel,dates);
    datePicker.addEventListener('toggle',async()=>{
      if (!datePicker.open || past.childElementCount) return;
      const epoch=generation;
      try {const {briefs=[]}=await host.api('/api/v1/reports/daily/briefs?limit=60');
        if (epoch!==generation) return;
        for (const b of briefs) past.append(button(`${b.reportDate} · 日报`,()=>{datePicker.open=false;s.mode='daily';persist();selectDate(b.reportDate) || loadInitial();},'brief-date-entry'));
      } catch {past.append(node('p','brief-muted','往期日期暂时未能读取，可直接选择日期。'));}
    });
    tools=node('details','brief-tools'); tools.append(node('summary','','更多'));
    const toolBody=node('div','brief-tools-body'); tools.append(toolBody);
    periodSelect=node('select','brief-period');periodSelect.setAttribute('aria-label','选择小时时段');
    periodSelect.addEventListener('change',async()=>{
      rememberPosition();s.hourStart=Number(periodSelect.value);
      const selected=s.manifest.find(h=>h.hourStart===s.hourStart);
      if(s.pending?.kind==='hourly' && selected?.id && !s.hours.some(h=>h.id===selected.id)) await acceptUpdate(false);
      else renderContent();
      restorePosition();
    });
    controls.append(datePicker,periodSelect,tools); top.append(tabs,controls);
    status=node('p','brief-status'); status.setAttribute('role','status');
    publication=node('p','brief-muted brief-publication');
    banner=node('div','brief-update'); banner.hidden=true; banner.setAttribute('role','status');
    const layout=node('div','brief-layout'), reading=node('div','brief-reading');
    const filters=node('div','brief-filters');
    const search=node('input','brief-search'); search.type='search'; search.placeholder='搜索当前文章'; search.maxLength=300; search.value=s.query;
    search.setAttribute('aria-label','搜索当前简报信息');
    search.addEventListener('input',()=>{s.query=search.value; renderContent();});
    const unread=node('label','brief-toggle'), checkbox=node('input'); checkbox.type='checkbox'; checkbox.checked=s.unread;
    checkbox.addEventListener('change',()=>{s.unread=checkbox.checked; renderContent();}); unread.append(checkbox,document.createTextNode('只看未读'));
    const saved=node('label','brief-toggle'), savebox=node('input'); savebox.type='checkbox'; savebox.checked=s.savedOnly;
    savebox.addEventListener('change',()=>{s.savedOnly=savebox.checked; renderContent();}); saved.append(savebox,document.createTextNode('收藏'));
    filters.append(search,unread,saved);
    nav=node('nav','brief-time-nav'); nav.setAttribute('aria-label','时段导航');
    content=node('div','brief-content'); content.id='brief-content'; content.setAttribute('role','tabpanel');
    rail=node('aside','brief-rail'); rail.setAttribute('aria-label','阅读导航');
    toolBody.append(filters);
    reading.append(content); layout.append(reading,rail); root.append(directionTabs,top,publication,status,banner,layout);
    tools.addEventListener('toggle',()=>{if(tools.open) datePicker.open=false;});
    sync(); renderContent();
  }

  function sync() {
    const anchor=[...root.querySelectorAll('.brief-item,.brief-prose')].find(el=>{const box=el.getBoundingClientRect();return box.bottom>100 && box.top<innerHeight;});
    const before=anchor?.getBoundingClientRect().top;
    dateInput.value=s.date;
    dateLabel.textContent=s.date ? `${Number(s.date.slice(5,7))}月${Number(s.date.slice(8))}日` : '日期';
    for (const tab of tabs.children) {
      const selected=tab.dataset.mode===s.mode;
      tab.classList.toggle('is-active',selected); tab.setAttribute('aria-selected',String(selected)); tab.tabIndex=selected ? 0 : -1;
    }
    content?.setAttribute('aria-labelledby',directionTabs.hidden ? `brief-tab-${s.mode}` : `brief-direction-${s.direction}`);
    const failed=s.mode==='hourly' ? s.manifest.filter(h=>h.status==='failed' || h.failed).length : 0;
    status.textContent=s.error ? '简报暂时未能更新，已载入内容仍可阅读。' : failed ? `${failed} 个时段处理失败，已完成内容仍可阅读。` : '';
    status.hidden=!status.textContent;status.classList.toggle('is-error',Boolean(status.textContent));
    content?.setAttribute('aria-busy',String(s.loading));
    renderPeriodOptions();
    const latest=hourSlots().find(h=>h.readable);
    publication.hidden=s.mode!=='hourly' || s.loading;
    publication.textContent=latest ? `最新发布到 ${time(latest.hourStart+HOUR)}` : '暂无已发布的小时文章';
    const details=tools.querySelector('.brief-processing-summary');
    if(details) details.textContent=processingSummary();
    banner.replaceChildren(); banner.hidden=!s.pending;
    if (s.pending) banner.append(node('span','',s.pending.label),button('查看更新',()=>acceptUpdate()));
    if (anchor && (window.scrollY>100 || dialog?.open)) host.adjustScroll?.(anchor.getBoundingClientRect().top-before);
  }

  async function indexForDate(date=s.date) {
    const window=briefDayWindow(date,s.timezone);
    return host.api(`/api/v1/reports/hourly/index?${new URLSearchParams({startAt:window.startAt,endAt:window.endAt})}`);
  }

  async function loadInitial(history=false) {
    if (!s.identity) return;
    const chooseAvailable=!s.date && !history && routeKey==='current';
    const token=++request, epoch=generation; s.loading=true; s.error=''; sync();
    try {
      if (!s.timezone) {
        const endAt=Math.floor(Date.now()/HOUR)*HOUR;
        const index=await host.api(`/api/v1/reports/hourly/index?startAt=${endAt-24*HOUR}&endAt=${endAt}`);
        if (token!==request || epoch!==generation) return;
        s.timezone=index.timezone;
        if (!s.date && s.mode==='hourly') {
          const latest=index.hours.find(h=>h.readable ?? (h.id && h.itemCount>0));
          if (latest) s.date=briefDate(latest.hourStart,s.timezone);
        }
      }
      if (!s.date) s.date=briefDate(Date.now(),s.timezone);
      const index=await indexForDate();
      if (token!==request || epoch!==generation) return;
      if (s.mode==='hourly') {
        const hours=await readHours(index.hours,token,epoch);
        if (!hours || token!==request || epoch!==generation) return;
        s.manifest=index.hours; s.hours=hours;
        if (chooseAvailable && !hours.some(h=>h.editorial?.status==='ready' && h.editorial.directions.length)) {
          const {brief}=await host.api('/api/v1/reports/daily/latest/brief');
          if (token!==request || epoch!==generation) return;
          if (brief) {
            const selected=await readDaily(brief.reportDate);
            if (token!==request || epoch!==generation) return;
            s.mode='daily'; s.date=brief.reportDate; s.brief=selected.brief; s.window=selected.window;
            const dailyIndex=await indexForDate();
            if (token!==request || epoch!==generation) return;
            s.manifest=dailyIndex.hours;
          }
        }
      } else {
        const selected=await readDaily(s.date);
        if (token!==request || epoch!==generation) return;
        s.brief=selected.brief; s.window=selected.window; s.manifest=index.hours;
      }
      s.checkedAt=Date.now(); s.pending=null;s.loading=false;
      if (!history) renderContent();
      else {s.loading=false; await showHistoryPanel();}
    } catch (error) {if (token===request && epoch===generation) s.error=error.message || '读取失败';}
    finally {if (token===request && epoch===generation) {s.loading=false; sync(); if (!s.hours.length && !s.brief && !history) renderContent();}}
  }

  async function readHours(manifest,token,epoch) {
    const existing=new Map(s.hours.map(d=>[d.id,d])), result=[];
    // Three simultaneous immutable snapshot GETs; each contains all items, with no pagination truncation.
    const queue=manifest.filter(h=>h.id || h.draftId).map(h=>({...h,id:h.id || h.draftId}));
    await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{
      while (queue.length && token===request && epoch===generation) {
        const h=queue.shift(); let digest=existing.get(h.id);
        if (!digest) ({digest}=await host.api(`/api/v1/reports/hourly/snapshot?snapshotId=${encodeURIComponent(h.id)}`));
        if (!digest || digest.id!==h.id) throw new Error('小时版本未能读取，请重试');
        result.push(digest);
      }
    }));
    return token===request && epoch===generation ? result.sort((a,b)=>b.window.startAt-a.window.startAt) : null;
  }

  async function readDaily(date) {
    const {brief}=await host.api(`/api/v1/reports/daily/brief?date=${encodeURIComponent(date)}`);
    let window=null;
    if (brief) window=await host.api(`/api/v1/reports/daily/brief/window?date=${encodeURIComponent(date)}&revision=${brief.generatedAt}`);
    return {brief:brief || null,window};
  }

  async function switchMode(mode) {
    if (s.mode===mode) return;
    rememberPosition();s.mode=mode; s.query=''; s.pending=null; s.loading=true; persist();
    build(); await loadInitial();restorePosition();
  }

  function selectDate(date) {
    if (date===s.date) return;
    rememberPosition();request++;s.hourStart=null; s.date=date; s.hours=[]; s.brief=null; s.window=null; s.manifest=[]; s.pending=null; s.expanded.clear(); s.loading=true;
    build(); return loadInitial().then(restorePosition);
  }

  function canInsert() {
    return !s.viewingHistory && window.scrollY<100 && !dialog?.open && !document.querySelector('dialog[open]') && !window.getSelection()?.toString() && !root.querySelector('details[open]');
  }

  async function check(manual=false) {
    if(treeActive)return tree.check();
    if (!active() || document.hidden) return;
    if (!dateInput?.isConnected) return;
    if (!s.timezone || !s.date) return loadInitial();
    if (s.loading) return;
    if (busy) return busy;
    const epoch=generation,token=request,date=s.date;
    busy=(async()=>{
      try {
        const index=await indexForDate(date);
        if (epoch!==generation || token!==request || !active()) return;
        s.checkedAt=Date.now(); s.error='';
        const previous=new Map(s.manifest.map(h=>[h.hourStart,h.id]));
        const changed=index.hours.filter(h=>h.id && previous.get(h.hourStart)!==h.id);
        if (s.mode==='hourly') {
          s.manifest=index.hours;
          if (changed.length) {
            s.pending={kind:'hourly',manifest:index.hours,label:`${changed.length} 个时段有新稿或补充`};
            if (canInsert() && !s.hours.length) await acceptUpdate(false);
          } else {renderHourlyStatus();}
        } else {
          const {briefs=[]}=await host.api('/api/v1/reports/daily/briefs?limit=60');
          if (epoch!==generation || token!==request || !active()) return;
          s.history=briefs;
          const revision=briefs.find(b=>b.reportDate===date);
          if (revision && revision.generatedAt!==s.brief?.generatedAt) s.pending={kind:'daily',label:s.brief ? '本期有修订，阅读中的版本保持不变' : '本期日报已发布'};
          else if (changed.length) s.pending={kind:'hours',label:'小时更新有新结果，当前日报保持不变'};
          s.manifest=index.hours;
        }
        if(s.mode==='hourly' && !s.viewingHistory && content.querySelector('.brief-empty')) renderContent();
        sync();
        if (manual && !s.pending) host.toast('检查完成，已是当前可用版本');
      } catch (error) {if (epoch===generation && token===request && active()) {s.error=error.message || '检查更新失败'; sync();}}
      finally {if (epoch===generation) busy=null;}
    })();
    return busy;
  }

  async function acceptUpdate(jump=true) {
    const update=s.pending;
    if (!update) return;
    if (update.kind==='hours') return switchMode('hourly');
    const token=++request,epoch=generation; s.loading=true; sync();
    try {
      if (update.kind==='hourly') {
        const hours=await readHours(update.manifest,token,epoch);
        if (!hours || epoch!==generation || token!==request) return;
        const known=new Set(s.hours.flatMap(h=>h.items.map(informationSignature)));
        for (const h of hours) h.displayChanges=h.items.filter(i=>!known.has(informationSignature(i))).length;
        s.hours=hours; s.manifest=update.manifest;
      } else {
        const selected=await readDaily(s.date);
        if (epoch!==generation || token!==request) return;
        s.brief=selected.brief; s.window=selected.window;
      }
      s.pending=null; s.error='';s.loading=false; renderContent();
      if (jump) content.querySelector('.brief-article,.brief-hour,.brief-masthead')?.scrollIntoView({behavior:'smooth',block:'start'});
    } catch (error) {if (token===request && epoch===generation) s.error=error.message || '更新未能读取';}
    finally {if (token===request && epoch===generation) {s.loading=false; sync();}}
  }

  function empty(title,detail) {
    const box=node('div','brief-empty'); box.append(node('h3','',title),node('p','',detail));
    if (s.error) box.append(button('重试读取',()=>loadInitial()));
    content.append(box);
  }

  function renderContent() {
    if (!content) return;
    s.viewingHistory=false;
    renderDirectionNavigation();
    content.replaceChildren(); nav.replaceChildren(); rail.replaceChildren();
    if (s.mode==='hourly') renderHourly(); else renderDaily();
    renderManagement();
    sync();
  }

  function renderHourlyStatus() {
    const detail=tools.querySelector('.brief-processing-summary');
    if (detail) detail.textContent=processingSummary();
  }

  function processingSummary() {
    const selected=hourSlots().find(h=>h.hourStart===s.hourStart);
    const timing=selected && (selected.queueMs!==undefined || selected.executionMs!==undefined) ?
      `\n所选时段：${hourPhaseLabel(selected)} · 排队 ${Math.round((selected.queueMs || 0)/1000)} 秒 · 执行 ${Math.round((selected.executionMs || 0)/1000)} 秒` : '';
    return `${hourlyStatusText()}${timing}\n${s.timezone || ''}${s.checkedAt ? ` · 页面检查 ${stamp(s.checkedAt)}` : ''}${s.error ? `\n${s.error}` : ''}`;
  }

  function hourlyStatusText() {
    const done=hourSlots().filter(h=>h.readable), running=s.manifest.filter(h=>h.status==='running').length;
    const failed=s.manifest.filter(h=>h.status==='failed').length;
    const incomplete=done.filter(h=>h.unread || h.failed).length;
    const window=s.date && s.timezone ? briefDayWindow(s.date,s.timezone) : null;
    const ended=window ? Math.max(0,Math.floor((Math.min(window.endAt,Date.now())-window.startAt)/HOUR)) : 0;
    const missing=Math.max(0,ended-done.length);
    return `${done.length} 个可读时段${done.length ? ` · 最新发布到 ${time(done[0].hourStart+HOUR)}` : ''}`+
      `${missing ? ` · ${missing} 个已结束时段尚无完成结果` : ''}${running ? ` · ${running} 个正在处理` : ''}${failed ? ` · ${failed} 个处理失败` : ''}${incomplete ? ` · ${incomplete} 个材料未完整读取` : ''}。`;
  }

  function selectedHour() {
    const ready=s.hours.filter(d=>d.editorial?.status==='ready' && d.editorial.directions.length);
    return s.hourStart!==null ? ready.find(d=>d.window.startAt===s.hourStart) || null : ready[0] || null;
  }
  function hourSlots() {
    const slots=new Map(s.manifest.map(h=>[h.hourStart,{...h}]));
    for(const d of s.hours) {
      const h=slots.get(d.window.startAt) || {hourStart:d.window.startAt,status:'completed',itemCount:d.items.length};
      if(h.readable===undefined) h.readable=d.editorial?.status==='ready' && d.editorial.directions.length>0;
      if(!h.phase) h.phase=h.status==='running' ? 'extracting' : h.status==='failed' || d.editorial?.status==='failed' ? 'failed' : h.readable ? 'ready' : d.items.length ? 'draft' : 'empty';
      slots.set(h.hourStart,h);
    }
    return [...slots.values()].sort((a,b)=>b.hourStart-a.hourStart);
  }
  function hourPhaseLabel(h) {
    if(h.phase==='failed' || h.status==='failed') {
      const reason=h.failureReason==='queue-timeout' ? '等待执行超时' : h.failureReason==='execution-timeout' ? '模型执行超时' : h.failureReason==='model-error' ? '模型调用失败' : h.failureStage==='editing' ? '成稿失败' : '处理失败';
      return `${reason}${h.readable ? ' · 旧稿可读' : ''}`;
    }
    const labels={'not-started':'尚未开始','queued-extraction':'等待提炼','extracting':'正在提炼','queued-editing':'等待成稿','editing':'正在成稿','draft':'主题整理未完成','empty':'无可发布内容','ready':'已发布'};
    const label=labels[h.phase] || (h.status==='running' ? '正在整理' : h.readable ? '已发布' : '主题整理未完成');
    return `${label}${h.readable && h.status==='running' ? ' · 旧稿可读' : ''}`;
  }
  function renderPeriodOptions() {
    periodSelect.replaceChildren();periodSelect.hidden=s.mode!=='hourly';
    for(const h of hourSlots()) {
      const option=node('option','',`${time(h.hourStart)}—${time(h.hourStart+HOUR)} · ${hourPhaseLabel(h)}`);
      option.value=h.hourStart;periodSelect.append(option);
    }
    if(!periodSelect.children.length) {periodSelect.append(node('option','','暂无时段'));periodSelect.disabled=true;}
    else {periodSelect.disabled=false;periodSelect.value=s.hourStart ?? hourSlots()[0].hourStart;}
  }
  function positionKey() {return `${s.mode}:${s.date}:${s.mode==='hourly' ? s.hourStart : s.brief?.generatedAt || ''}:${s.direction}`;}
  function rememberPosition() {if(active()) s.positions.set(positionKey(),window.scrollY);}
  function restorePosition() {
    if(active()) window.scrollTo({top:s.positions.get(positionKey()) || 0,behavior:'instant'});
  }
  function selectDirection(key,focus=false) {
    if(treeActive)return tree.selectDirection(key);
    if(!DIRECTION_LABELS[key]) return;
    rememberPosition();s.direction=key;s.directionInitialized=true;persist();renderContent();
    if(focus) directionTabs.querySelector(`[data-direction="${key}"]`)?.focus({preventScroll:true});
    restorePosition();
  }
  function renderDirectionNavigation() {
    const digest=s.mode==='hourly' ? selectedHour() : null;
    if(s.mode==='hourly' && s.hourStart===null) s.hourStart=digest?.window.startAt ?? hourSlots()[0]?.hourStart ?? null;
    const editorial=digest?.editorial || (s.mode==='daily' ? s.brief?.editorial : null);
    const directions=editorial?.status==='ready' ? editorial.directions : [];
    const directionKey=d=>d.key || Object.keys(DIRECTION_LABELS).find(key=>DIRECTION_LABELS[key]===d.title);
    if(!s.directionInitialized && directions.length) {s.direction=directionKey(directions[0]);s.directionInitialized=true;}
    directionTabs.replaceChildren();directionTabs.hidden=s.mode==='daily' && Boolean(s.brief) && !directions.length;
    const keys=['finance','policy','tech',...(directions.some(d=>directionKey(d)==='other') || s.direction==='other' ? ['other'] : [])];
    for(const key of keys) {
      const tab=button(DIRECTION_LABELS[key],()=>selectDirection(key,true),'brief-direction-tab');tab.dataset.direction=key;
      tab.id=`brief-direction-${key}`;tab.setAttribute('role','tab');tab.setAttribute('aria-controls','brief-content');
      tab.setAttribute('aria-selected',String(s.direction===key));tab.tabIndex=s.direction===key ? 0 : -1;
      tab.addEventListener('keydown',event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();const i=keys.indexOf(key),next=event.key==='Home'?0:event.key==='End'?keys.length-1:(i+(event.key==='ArrowRight'?1:-1)+keys.length)%keys.length;
        selectDirection(keys[next],true);
      });directionTabs.append(tab);
    }
    renderPeriodOptions();
  }
  function renderHourly() {
    const digest=selectedHour(),drafts=s.hours.filter(d=>d.items.length && d.editorial?.status!=='ready').length;
    if(digest) {
      const section=node('section','brief-hour');section.id=`brief-hour-${digest.window.startAt}`;
      renderSelectedDirection(section,digest.editorial,{digest});
      if(digest.coverage.some(c=>c.unread || c.failed)) section.append(node('p','brief-muted','本期仅覆盖已读材料，部分材料尚未完整读取。'));
      content.append(section);
    } else {
      const selected=hourSlots().find(h=>h.hourStart===s.hourStart);
      empty(s.loading ? '正在读取小时更新' : s.error ? '小时更新暂时未能读取' : selected ? `${time(selected.hourStart)}—${time(selected.hourStart+HOUR)} · ${hourPhaseLabel(selected)}` : '暂无已完成的小时更新','');
      if(!s.loading) {
        const draftItems=selected?.draftItemCount ?? s.hours.find(h=>h.window.startAt===s.hourStart)?.items.length ?? 0;
        if(draftItems) content.querySelector('.brief-empty').append(node('p','brief-muted',`主题整理未完成；本时段 ${draftItems} 条提炼底稿已保留。`));
        else if(!selected && drafts) content.querySelector('.brief-empty').append(node('p','brief-muted',`主题整理未完成；${drafts} 个时段的提炼底稿已保留。`));
        if(selected?.readable && s.pending) content.querySelector('.brief-empty').append(button('阅读已发布版本',()=>acceptUpdate(false)));
        const saved=s.brief || host.latestBrief?.();
        if(saved) content.querySelector('.brief-empty').append(button(saved.reportDate===briefDate(Date.now(),s.timezone) ? '阅读今日日报' : '阅读最近日报',()=>{s.mode='daily';persist();selectDate(saved.reportDate) || loadInitial();}));
      }
    }
  }

  function renderDaily() {
    rail.append(node('strong','','本期阅读'),node('p','brief-muted',s.date),button('查看小时更新',()=>switchMode('hourly')),button('往期日报',()=>showHistoryPanel()));
    if (!s.brief) {empty(s.loading ? '正在读取日报精选' : s.error ? '日报暂时未能读取' : '本期日报尚未发布','可先阅读小时更新；正式日报沿用后台的统计窗口和发布版本。'); return;}
    const brief=s.brief, mast=node('header','brief-masthead');
    mast.append(node('h2','',`${Number(brief.reportDate.slice(5,7))} 月 ${Number(brief.reportDate.slice(8))} 日 · 日报`));
    if(brief.overview && brief.editorial?.version!==ARTICLE_VERSION) mast.append(node('p','brief-overview',brief.overview));
    content.append(mast);
    if(brief.editorial?.status==='ready') {
      mast.remove();renderSelectedDirection(content,brief.editorial,{brief});
      renderDailyFollow(brief);
      content.append(node('p','brief-end','本期完 · 日内新增请看小时更新'));return;
    }
    const legacy=!Array.isArray(brief.informationItems);
    if (legacy && !brief.items?.every(i=>i.evidence?.length)) {
      const legacy=node('div','brief-legacy'); host.renderLegacy(legacy,brief); content.append(legacy); return;
    }
    const allItems=legacy ? brief.items.map(i=>({id:i.candidateId,headline:i.headline,sentence:i.body || i.whyItMatters || i.headline,evidence:i.evidence.map(e=>({...e,materialVersion:e.materialVersion || String(brief.generatedAt)})),supersedes:[]})) : brief.informationItems;
    const items=visibleItems(allItems);
    if (items.length>=5 && !s.query && !s.unread && !s.savedOnly) {
      const outline=node('nav','brief-outline'); outline.setAttribute('aria-label','本期阅读起点');
      outline.append(node('strong','','从这几条开始'),node('small','','按正文顺序 · 点击定位'));
      items.slice(0,3).forEach((i,n)=>outline.append(button(`${String(n+1).padStart(2,'0')}  ${i.sentence}`,()=>document.getElementById(`brief-item-${i.id}`)?.scrollIntoView({behavior:'smooth',block:'start'}),'brief-keyline')));
      content.append(outline);
    }
    const expanded=s.expanded.has('daily');
    (expanded ? items : items.slice(0,20)).forEach((item,index)=>content.append(itemRow(item,{brief,index:index+1})));
    if (items.length>20) content.append(button(expanded ? '收起本期更多信息' : `展开本期其余 ${items.length-20} 条`,()=>{
      expanded ? s.expanded.delete('daily') : s.expanded.add('daily');renderContent();
    },'brief-button brief-more'));
    if (!items.length) empty(allItems.length ? s.query ? '没有符合搜索的信息' : s.savedOnly ? '本期尚无收藏信息' : '本期信息已全部读过' : '本期没有信息事项','可调整搜索、未读或收藏筛选。');
    renderDailyFollow(brief);
    content.append(node('p','brief-end','本期完 · 日内新增请看小时更新'));
  }

  function renderSelectedDirection(target,editorial,context) {
    const direction=editorial.directions.find(d=>(d.key || Object.keys(DIRECTION_LABELS).find(k=>DIRECTION_LABELS[k]===d.title))===s.direction);
    if(!direction) {target.append(node('p','brief-direction-empty','本期没有该方向的可读内容。'));return;}
    if(editorial.version===ARTICLE_VERSION) {renderDirectionArticle(target,direction,editorial,context);return;}
    const section=node('section','brief-direction');section.append(node('h2','brief-direction-title',direction.title),node('p','brief-muted','此前主题稿，保留原正文与原引用。'));
    const items=visibleItems(direction.topics.map(t=>({...t,headline:t.title,sentence:t.body,supersedes:[]})));
    items.forEach((item,index)=>section.append(itemRow(item,{...context,index:index+1})));target.append(section);
    if(!items.length) section.append(node('p','brief-muted',s.query ? '没有符合搜索的主题' : s.savedOnly ? '尚无收藏主题' : '主题已全部读过'));
  }
  function renderDirectionArticle(target,direction,editorial,context) {
    const unit=briefReadingItems(editorial).find(i=>i.id===direction.id),item={...unit,headline:unit.title,sentence:unit.body,supersedes:[]};
    if(!visibleItems([item]).length) {target.append(node('p','brief-muted',s.query ? '本文没有符合搜索的内容' : s.savedOnly ? '本文尚未收藏' : '本文已读'));return;}
    const article=node('article','brief-article');article.id=`brief-item-${item.id}`;article.dataset.itemId=item.id;
    if(context.brief) article.dataset.reportReferenceId=`${context.brief.reportDate}/${item.id}`;
    const edition=node('p','brief-edition',context.digest ? `小时简报 · ${time(context.digest.window.startAt)}—${time(context.digest.window.endAt)}` : `日报精选 · ${s.date}`);
    article.append(edition,node('h2','brief-article-title',direction.articleTitle));
    const registry=new Map();let sourceNumber=0;
    const prose=(p,lead=false)=>{
      const paragraph=node('div',lead ? 'brief-article-lead' : 'brief-prose');paragraph.dataset.paragraphId=p.id;
      const text=node('p','',p.text),sources=[...new Map(p.evidence.map(e=>[JSON.stringify([e.materialId,e.materialHash,e.materialVersion]),e])).values()];
      const links=node('span','brief-paragraph-sources');
      for(const e of sources) {
        const identity=JSON.stringify([e.materialId,e.materialHash,e.materialVersion]);if(!registry.has(identity))registry.set(identity,++sourceNumber);
        const control=button(`〔${registry.get(identity)}〕`,event=>{rememberPosition();return openSource(item,context,e,event.currentTarget);},'brief-source brief-paragraph-source');
        control.setAttribute('aria-label',`阅读本段来源 ${registry.get(identity)}`);control.title='阅读站内原文';links.append(control);
      }
      text.append(links);paragraph.append(text);
      const details=node('details','brief-paragraph-tools');const label=node('summary','','···');label.setAttribute('aria-label','本段提炼依据');
      details.append(label,button('查看本段提炼依据',()=>{details.open=false;return openEvidence({id:item.id,sentence:p.text,evidence:p.evidence,signatureItem:item},context);},'brief-evidence-link'));
      paragraph.append(details);return paragraph;
    };
    article.append(prose(direction.lead,true));
    direction.sections.forEach((section,index)=>{
      const block=node('section','brief-article-section');block.id=`brief-section-${direction.key}-${index}`;
      if(section.heading) {
        block.append(node('h3','',section.heading));
        const link=node('a','brief-rail-link',section.heading);link.href=`#${block.id}`;
        link.addEventListener('click',event=>{event.preventDefault();block.scrollIntoView({behavior:'smooth',block:'start'});});rail.append(link);
      }
      section.paragraphs.forEach(p=>block.append(prose(p)));article.append(block);
    });
    // Reuse the existing read/save/reference behavior once per article, without its paragraph-row layout.
    const controls=itemRow(item,{...context,articleId:item.id}).querySelector('.brief-item-actions');controls.querySelector('.brief-source-links')?.remove();
    controls.querySelector('.brief-item-tools > summary')?.setAttribute('aria-label','这篇文章的更多操作');
    const operations=node('div','brief-article-operations');operations.append(node('span','brief-muted','文章操作'),controls);article.append(operations);
    rail.prepend(node('strong','','本文脉络'));target.append(article);
  }

  function renderDailyFollow(brief) {
    if (brief.trackingUpdates?.length) {
      const follow=node('details','brief-coverage'); follow.append(node('summary','','持续关注问题'));
      for (const u of brief.trackingUpdates) {follow.append(node('strong','',u.question || '持续关注'),node('p','',u.judgment),node('p','',`下一验证条件：${u.nextCheck}`));
        if (u.evidence.length) follow.append(button('查看依据',()=>openEvidence({id:u.questionId,sentence:u.judgment,evidence:u.evidence},{brief})));}
      content.append(follow);
    }
  }

  function itemRow(item,context) {
    const row=node('article','brief-item'); row.id=`brief-item-${item.id}`; row.dataset.itemId=item.id;
    if (context.brief) row.dataset.reportReferenceId=`${context.brief.reportDate}/${item.id}`;
    const signature=informationSignature(item); row.classList.toggle('is-read',s.read.has(signature));
    const sentence=node('p','brief-sentence',item.sentence); const mark=node('span','brief-item-mark',context.index ? String(context.index).padStart(2,'0') : '');
    const copy=node('div','brief-item-copy'); if(item.headline)copy.append(node('h3','brief-headline',item.headline));copy.append(sentence);
    const ops=node('div','brief-item-actions');
    const sources=[...new Map((item.evidence || []).map(e=>[JSON.stringify([e.materialId,e.materialHash,e.materialVersion]),e])).values()];
    const sourceList=node('div','brief-source-links');
    sources.slice(0,3).forEach((e,n)=>sourceList.append(button(`来源 ${n+1} ↗`,event=>openSource(item,context,e,event.currentTarget),'brief-source')));
    if(sources.length>3) {
      const more=node('details','brief-source-directory');more.append(node('summary','',`其余 ${sources.length-3} 份来源`));
      sources.slice(3).forEach((e,n)=>more.append(button(`来源 ${n+4} ↗`,event=>openSource(item,context,e,event.currentTarget),'brief-source')));sourceList.append(more);
    }
    ops.append(sourceList);
    if (item.supersedes?.length) ops.append(node('span','brief-badge','补充 / 更正'));
    const read=button(s.read.has(signature) ? '已读' : '标为已读',()=>{
      s.read.has(signature) ? s.read.delete(signature) : s.read.add(signature); persist();
      row.classList.toggle('is-read',s.read.has(signature)); read.textContent=s.read.has(signature) ? '已读' : '标为已读'; read.setAttribute('aria-pressed',String(s.read.has(signature)));
      if (s.unread) renderContent();
    },'brief-read'); read.setAttribute('aria-pressed',String(s.read.has(signature)));
    const save=button(s.saved.has(signature) ? '已收藏' : '收藏',()=>{
      s.saved.has(signature) ? s.saved.delete(signature) : s.saved.add(signature); persist();
      save.textContent=s.saved.has(signature) ? '已收藏' : '收藏'; save.setAttribute('aria-pressed',String(s.saved.has(signature)));
      if (s.savedOnly) renderContent();
    },'brief-save'); save.setAttribute('aria-pressed',String(s.saved.has(signature)));
    const reference=context.brief ? host.dailyReference(context.brief,{candidateId:item.id,headline:item.sentence.slice(0,120),body:item.sentence,whyItMatters:item.sentence,watchNext:''}) :
      {resourceType:'hourly-digest',resourceId:context.articleId ? `${context.digest.id}/${context.articleId}` : context.digest.id,
        label:`${time(context.digest.window.startAt)} · ${context.articleId ? item.headline : '小时简报'}`,preview:item.sentence.slice(0,300)};
    const cite=button(host.isReferenced(reference) ? '取消引用' : '引用',()=>{host.toggleReference(reference); cite.textContent=host.isReferenced(reference) ? '取消引用' : '引用'; cite.setAttribute('aria-pressed',String(host.isReferenced(reference)));},'brief-cite');
    cite.setAttribute('aria-pressed',String(host.isReferenced(reference)));
    if (context.digest) cite.title=context.articleId ? '引用这篇冻结方向文章；完整底稿可按需查询' : '引用这份冻结小时简报；完整底稿可按需查询';
    const actions=node('details','brief-item-tools');const actionMenu=node('div','brief-item-menu');
    const actionLabel=node('summary','','···');actionLabel.setAttribute('aria-label','这条信息的更多操作');
    actionMenu.append(read,save,cite,button('查看提炼依据',()=>openEvidence(item,context),'brief-evidence-link'));actions.append(actionLabel,actionMenu);
    actionMenu.addEventListener('click',event=>{if(event.target.closest('button')) actions.open=false;});
    ops.append(actions); copy.append(ops); row.append(mark,copy); return row;
  }

  function evidenceUrl(e,context) {
    const params=new URLSearchParams(e.snapshotId ? e : {date:context.brief.reportDate,revision:context.brief.generatedAt,materialId:e.materialId,paragraphId:e.paragraphId});
    return `/api/v1/reports/${e.snapshotId ? 'hourly' : 'daily'}/evidence?${params}`;
  }

  async function openSource(item,context,e,control) {
    const epoch=generation,token=++evidenceRequest;
    control.disabled=true;
    try {
      const {evidence}=await host.api(evidenceUrl(e,context));
      if(epoch!==generation || token!==evidenceRequest || !active()) return;
      if(!host.canReadSavedSource?.(evidence.material)) throw new Error('这份材料暂无站内文章，可在“查看提炼依据”中查看来源。');
      s.read.add(informationSignature(item));persist();
      const row=document.getElementById(`brief-item-${item.id}`);row?.classList.add('is-read');
      const read=row?.querySelector('.brief-read');if(read){read.textContent='已读';read.setAttribute('aria-pressed','true');}
      await host.readSavedSource(evidence.material);
    } catch(error) {if(epoch===generation && token===evidenceRequest) host.toast(error.message || '站内原文未能读取');}
    finally {control.disabled=false;}
  }

  async function openEvidence(item,context) {
    const epoch=generation, token=++evidenceRequest;
    focusReturn=document.activeElement;
    if (!dialog) {
      dialog=node('dialog','brief-evidence'); dialog.id='brief-evidence'; dialog.setAttribute('aria-labelledby','brief-evidence-title');
      document.body.append(dialog);
      dialog.addEventListener('close',()=>{evidenceRequest++; host.releaseDialogScroll();
        if (s.unread) renderContent();
        if (focusReturn?.isConnected) focusReturn.focus({preventScroll:true}); else tabs?.querySelector('[aria-selected="true"]')?.focus({preventScroll:true});
      });
      dialog.addEventListener('click',event=>{if (event.target===dialog) dialog.close();});
    }
    dialog.replaceChildren();
    const top=node('header','brief-evidence-head'), title=node('h2','','信息来源'); title.id='brief-evidence-title';
    const close=button('关闭',()=>dialog.close(),'brief-close'); top.append(title,close);
    dialog.append(top,node('p','brief-evidence-claim',item.sentence));
    const materials=node('div','brief-evidence-materials'); dialog.append(materials);
    if (!dialog.open) host.openDialog(dialog); close.focus();
    s.read.add(informationSignature(item.signatureItem || item)); persist();
    const row=document.getElementById(`brief-item-${item.id}`); row?.classList.add('is-read');
    const read=row?.querySelector('.brief-read'); if (read) {read.textContent='已读'; read.setAttribute('aria-pressed','true');}
    const groups=new Map();
    for (const e of item.evidence) {const key=JSON.stringify([e.snapshotId,e.materialId,e.materialHash,e.materialVersion]); if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(e);}
    for (const refs of groups.values()) {
      const card=node('section','brief-source-card'); materials.append(card);
      const load=async()=>{
        card.replaceChildren(node('p','brief-muted','正在读取支持段落…'));
        try {
          const results=await Promise.all(refs.map(e=>host.api(evidenceUrl(e,context))));
          if (token!==evidenceRequest || epoch!==generation || !dialog?.open) return;
          card.replaceChildren(); const m=results[0].evidence.material;
          card.append(node('h3','',m.publisher || m.author || '来源未提供'),node('p','brief-muted',m.title));
          for (const {evidence} of results) {
            if (evidence.paragraph.role==='comment' || evidence.paragraph.role==='summary') card.append(node('p','brief-muted',evidence.paragraph.role==='comment' ? '评论段落，署名以原文为准' : '来源摘要片段'));
            card.append(node('blockquote','brief-quote',evidence.paragraph.text));
          }
          const contexts=[...new Map(results.flatMap(r=>r.evidence.context || []).map(p=>[p.id,p])).values()].filter(p=>!refs.some(e=>e.paragraphId===p.id));
          if (contexts.length) {const detail=node('details','brief-context'); detail.append(node('summary','','展开相邻上下文')); contexts.forEach(p=>detail.append(node('p','',p.text))); card.append(detail);}
          if (/^https?:\/\//.test(m.sourceUrl)) {
            const original=node('a','brief-original','前往原站 ↗'); original.href=m.sourceUrl; original.target='_blank'; original.rel='noopener noreferrer'; card.append(original);
          }
          if (host.canReadSavedSource?.(m)) card.append(button('阅读站内原文',async()=>{
            dialog.close();host.releaseDialogScroll();
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            try {await host.readSavedSource(m);} catch(error) {host.toast(error.message || '资料库文章未能读取');}
          }));
          const technical=node('details','brief-technical'); technical.append(node('summary','','查看时间与溯源信息'));
          technical.append(node('p','',`发布：${m.publishedAt ? stamp(m.publishedAt) : '未知'}\n获得：${stamp(m.obtainedAt)}\n正文等级：${m.contentLevel}${m.late ? ' · 截止后补充材料' : ''}\n材料：${m.id}\n版本：${m.version}\n哈希：${m.hash}\n快照：${refs[0].snapshotId || context.brief.generatedAt}\n段落：${refs.map(e=>e.paragraphId).join('、')}`)); card.append(technical);
        } catch (error) {if (token===evidenceRequest && epoch===generation && dialog?.open) card.replaceChildren(node('p','',error.message || '来源读取失败'),button('重试来源',load));}
      };
      await load();
    }
  }

  function renderManagement() {
    tools.querySelector('.brief-management')?.remove();
    const panel=node('details','brief-management'); panel.append(node('summary','','处理情况 / 简报说明'));
    panel.append(node('p','brief-processing-summary',processingSummary()));
    panel.append(node('p','brief-muted','已读与收藏仅保存在这台设备。小时归属按来源发布 / 入库时间，不代表事件发生时间。'));
    if(s.brief) {
      if(s.brief.informationItems) panel.append(node('p','brief-muted',`日报保存 ${s.brief.informationItems.length} 条提炼底稿${s.brief.editorial?.status==='ready' ? `，正文 ${briefReadingItems(s.brief.editorial).length} 篇文章 / 主题` : ''}。`));
      panel.append(node('p','brief-muted',`日报成稿：${stamp(s.brief.generatedAt)}${s.brief.frozenAt ? `\n材料冻结：${stamp(s.brief.frozenAt)}` : ''}`));
      if(s.window?.window) panel.append(node('p','brief-muted',`统计窗口：${stamp(s.window.window.startAt)} — ${stamp(s.window.window.endAt)}（左闭右开）`));
      if(s.brief.limitations) panel.append(node('p','brief-muted',s.brief.limitations));
    }
    for(const digest of s.hours) {
      const coverage=node('details','brief-coverage');coverage.append(node('summary','',`${time(digest.window.startAt)} · 读取范围`));
      coverage.append(node('p','',`保存 ${digest.items.length} 条提炼底稿${digest.editorial?.status==='ready' ? `，正文 ${briefReadingItems(digest.editorial).length} 篇文章 / 主题` : '，主题整理未完成'}。`));
      for(const c of digest.coverage) coverage.append(node('p','',`${c.sourceName || c.sourceId}：完整读取 ${c.read || 0}，未完整读取 ${c.unread || 0}，失败 ${c.failed}`));
      digest.warnings.forEach(w=>coverage.append(node('p','',w)));panel.append(coverage);
    }
    tools.querySelector('.brief-tools-body').append(panel);
    panel.addEventListener('toggle',async()=>{
      if (!panel.open || panel.dataset.loaded) return; panel.dataset.loaded='true';
      const details=node('div','brief-management-body'); panel.append(details);
      host.renderManagement(details,s.date,s.brief,s.mode,s.hours);
    });
  }

  async function showHistoryPanel() {
    s.viewingHistory=true;
    const epoch=generation,token=++request; s.loading=true; sync();
    try {
      const {briefs=[]}=await host.api('/api/v1/reports/daily/briefs?limit=60');
      if (token!==request || epoch!==generation) return;
      s.history=briefs; content.replaceChildren(); nav.replaceChildren();
      content.append(node('h2','brief-history-title',routeKey==='archive' ? '旧版日报存档' : '往期日报'));
      if(routeKey!=='archive')content.append(button('返回当前简报',()=>renderContent()));
      if (!briefs.length) empty('还没有已发布日报','小时更新可独立阅读。');
      for (const b of briefs) content.append(button(`${b.reportDate} · ${b.itemCount} 条 · ${stamp(b.generatedAt)} 发布`,()=>{s.mode='daily';persist();selectDate(b.reportDate) || loadInitial();},'brief-history-row'));
    } catch (error) {if (token===request && epoch===generation) {s.error=error.message; empty('往期日报未能读取','请重试。');}}
    finally {if (token===request && epoch===generation) {s.loading=false;sync();}}
  }

  document.addEventListener('visibilitychange',()=>{
    if (document.hidden) stop(); else if (active()) {if(treeActive)tree.resume();else {start();check().catch(()=>{});}}
  });
  window.addEventListener('online',()=>{if (active()) check().catch(()=>{});});
  document.addEventListener('click',event=>{
    for(const panel of root?.querySelectorAll('.brief-tools[open],.brief-date-picker[open],.brief-item-tools[open],.brief-paragraph-tools[open]') || []) if(!panel.contains(event.target)) panel.open=false;
  });
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape') for(const panel of root?.querySelectorAll('.brief-tools[open],.brief-date-picker[open],.brief-item-tools[open],.brief-paragraph-tools[open]') || []) panel.open=false;
  });
  return {mount,stop,reset,check,selectDirection,state:s};
}
