const types={spot:'现货',contract:'合约',retail:'零售价',unknown:'类型待核验'};
const categories={dram:'DRAM',nand:'NAND',ssd:'SSD','other-storage':'其他存储参考'};
const node=(tag,text='',className='')=>Object.assign(document.createElement(tag),{textContent:text,className});
const time=at=>at==null?'来源未提供':new Date(at).toLocaleString('zh-CN');
const number=value=>value==null?'—':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:5,useGrouping:false});
const specification=row=>row.specification.replace(/^(?:項目|项目|Item)\s*:\s*/i,'').replace(/\s*·\s*(?:(?:日|盤|盘)?(?:高|低)(?:點|点)|High|Low)\s*:[\s\S]*$/i,'').trim();
const STALE_MS=7*86400000;
export function contractPeriodLabel(row) {
  if(row?.quoteType!=='contract' || !row.period) return '';
  const half=String(row.period).match(/^(\d{4})-(\d{2}) (1H|2H)$/);
  if(!half) return '';
  return `${Number(half[2])} 月${half[3]==='1H'?'上':'下'}半月`;
}
export function quoteAsOfLabel(sourceUpdatedAt) {
  if(sourceUpdatedAt==null) return '';
  const date=new Date(sourceUpdatedAt+8*3600000);
  return `${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
}
export function quoteIsStale(sourceUpdatedAt, now=Date.now()) {
  return sourceUpdatedAt!=null && now-sourceUpdatedAt>STALE_MS;
}
export function hardwareQuoteCaption(row, now=Date.now()) {
  const parts=[categories[row.category] || row.category, types[row.quoteType] || row.quoteType];
  if(row.currency && row.unit) parts.push(`${row.currency}/${row.unit}`);
  const half=contractPeriodLabel(row);
  if(half) parts.push(half);
  else if(row.quoteType==='contract' && row.period) parts.push(row.period);
  const asOf=quoteAsOfLabel(row.sourceUpdatedAt);
  if(asOf) parts.push(asOf);
  else if(!half && row.period) parts.push(row.period);
  else if(!row.period) parts.push('报价期待核验');
  if(row.verification==='pending') parts.push('待核验');
  const stale=quoteIsStale(row.sourceUpdatedAt, now);
  if(stale) parts.push('已过期');
  return {text:parts.filter(Boolean).join(' · '), stale};
}
export function fillHardwareCaption(element, item) {
  const stale=Boolean(item?.stale && String(item.group || '').endsWith('已过期'));
  element.textContent=stale?item.group.replace(/ · 已过期$/,''):(item?.group || '');
  if(!stale) return;
  element.append(document.createTextNode(' · '));
  const mark=document.createElement('span');
  mark.className='price-stale';
  mark.textContent='已过期';
  element.append(mark);
}
export function hardwareMarketItem(row, now=Date.now()) {
  const caption=hardwareQuoteCaption(row, now);
  return {assetClass:'hardware',hardware:row,name:specification(row),symbol:row.seriesKey,
    group:caption.text,stale:caption.stale,
    summary:specification(row),lastPrice:row.average,changePct:row.changePct,
    sparkline:(row.history || []).map(p=>Number(p.average))};
}
const dated=rows=>rows.filter(r=>r.isCurrent && r.period && r.periodStart!=null && r.periodEnd!=null && r.average!=null).sort((a,b)=>a.periodStart-b.periodStart);
function originalTables(raw) {
  const fragment=node('div','','hardware-tables');
  const saved=new DOMParser().parseFromString(raw,'text/html');
  for(const source of saved.querySelectorAll('table.price-table')) {
    const wrap=node('div','','hardware-table-scroll'),table=node('table','','data-table');
    for(const sourceRow of source.rows) {
      const row=node('tr');
      for(const sourceCell of sourceRow.cells) {
        const cell=node(sourceCell.tagName.toLowerCase(),sourceCell.textContent.trim());
        cell.colSpan=Math.min(80,sourceCell.colSpan);cell.rowSpan=Math.min(100,sourceCell.rowSpan);row.append(cell);
      }
      table.append(row);
    }
    wrap.append(table);fragment.append(wrap);
  }
  return fragment;
}
function chart(root,rows) {
  const points=dated(rows);
  if(points.length<2){root.append(node('p','暂无历史','hardware-history-empty'));return;}
  const namespace='http://www.w3.org/2000/svg';
  const width=Math.min(640,Math.max(280,document.documentElement.clientWidth-40)),right=width-18;
  const svg=document.createElementNS(namespace,'svg');svg.setAttribute('viewBox',`0 0 ${width} 300`);svg.classList.add('hardware-price-chart');svg.setAttribute('role','img');svg.setAttribute('aria-label','报价均价走势，左右方向键读取历史报价');svg.setAttribute('tabindex','0');
  const make=(tag,attributes,text)=>{const el=document.createElementNS(namespace,tag);for(const [key,value] of Object.entries(attributes))el.setAttribute(key,String(value));if(text!=null)el.textContent=text;svg.append(el);return el;};
  const values=points.map(p=>Number(p.average)),lo=Math.min(...values),hi=Math.max(...values),pad=Math.max((hi-lo)*0.12,Math.abs(hi)*0.02,0.01),min=lo-pad,max=hi+pad;
  const first=points[0].periodStart,last=points.at(-1).periodStart,span=Math.max(1,last-first);
  const x=p=>60+(p.periodStart-first)/span*(right-60),y=p=>252-(Number(p.average)-min)/(max-min)*220;
  for(let tick=0;tick<=4;tick++){const py=32+tick*55;make('line',{x1:60,x2:right,y1:py,y2:py,class:'chart-grid'});make('text',{x:52,y:py+4,'text-anchor':'end',class:'chart-label'},number(max-(max-min)*tick/4));}
  make('text',{x:60,y:280,class:'chart-label'},points[0].period);make('text',{x:right,y:280,'text-anchor':'end',class:'chart-label'},points.at(-1).period);
  make('path',{d:points.map((p,i)=>`${i?'L':'M'} ${x(p)} ${y(p)}`).join(' '),class:'hardware-price-line',fill:'none'});
  for(const p of points){const circle=make('circle',{cx:x(p),cy:y(p),r:3,class:'hardware-price-dot'});const title=document.createElementNS(namespace,'title');title.textContent=`${p.period} · 均价 ${number(p.average)}`;circle.append(title);}
  const cross=make('line',{x1:0,x2:0,y1:30,y2:252,class:'hardware-crosshair'}),active=make('circle',{cx:0,cy:0,r:5,class:'hardware-price-dot'});
  const readout=node('p','','hardware-chart-readout');readout.setAttribute('aria-live','polite');let selected=points.length-1;
  const select=index=>{selected=Math.max(0,Math.min(points.length-1,index));const p=points[selected];cross.setAttribute('x1',x(p));cross.setAttribute('x2',x(p));active.setAttribute('cx',x(p));active.setAttribute('cy',y(p));readout.textContent=`${p.period} · 均价 ${number(p.average)}${p.currency?' '+p.currency:''}${p.unit?' / '+p.unit:''}`;};
  svg.addEventListener('pointermove',event=>{const rect=svg.getBoundingClientRect(),px=(event.clientX-rect.left)/rect.width*width;select(points.reduce((best,p,i)=>Math.abs(x(p)-px)<Math.abs(x(points[best])-px)?i:best,0));});
  svg.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();select(selected+(event.key==='ArrowLeft'?-1:1));}});
  select(selected);root.append(readout,svg);
}
export function createHardwarePricesPage({api,openPage,setView,renderRows,isCurrent}) {
  let request=0;
  function button(text,click) {const b=node('button',text,'text-button');b.type='button';b.addEventListener('click',click);return b;}
  function metrics(row) {
    const grid=node('dl','','hardware-quote-metrics');
    for(const [label,value] of [[row.highBasis || '高价',number(row.high)],[row.lowBasis || '低价',number(row.low)],['币种',row.currency || '待核验'],['计价单位',row.unit || '待核验'],['报价期',contractPeriodLabel(row) || row.period || '待核验'],['涨跌口径',row.computedChangeBasis || '暂无可比报价']]){const box=node('div');box.append(node('dt',label),node('dd',value));grid.append(box);}return grid;
  }
  async function render(root,id='') {
    if(!id){setView('market/global/hardware');return;}
    const token=++request;root.replaceChildren(node('p','正在读取报价…','empty-state'));
    const [kind,key]=id.split('/');
    try {
      const data=await api(kind==='series'?`/api/v1/hardware-prices/series/${encodeURIComponent(key)}`:`/api/v1/hardware-prices/snapshots/${encodeURIComponent(key)}`);
      if(token!==request || !isCurrent(id))return;
      const shell=node('article','','detail-shell quote-detail hardware-detail');
      if(kind==='series') {
        const d=data.detail,row=d.current,head=node('header','','detail-head');
        const caption=hardwareQuoteCaption(row);
        const meta=node('div','','detail-meta');
        fillHardwareCaption(meta,{group:caption.text,stale:caption.stale});
        head.append(node('h2',specification(row),'detail-title'),meta);shell.append(head);
        const price=node('div','','quote-last-row');const change=row.changePct==null?'—':`${row.changePct>0?'+':''}${row.changePct.toFixed(2)}%`;
        const quoteLabel=[number(row.average),row.currency,row.unit?`/ ${row.unit}`:''].filter(Boolean).join(' ');
        price.append(node('strong',quoteLabel,'last num'),node('b',change,row.changePct==null?'':row.changePct<0?'down':'up'));shell.append(price);
        if(row.verification==='pending')shell.append(node('p',`待核验：${(row.missing || ['币种、单位或报价期']).join('、')}`,'hardware-verification'));
        const host=node('section','','quote-chart-host hardware-chart-host');
        const periods=node('div','','chip-tabs quote-period-tabs');let selected='all';
        const ranges=[['1m','1月',31],['3m','3月',93],['1y','1年',366],['all','全部',Infinity]];
        const draw=()=>{for(const b of periods.children){b.classList.toggle('is-active',b.dataset.range===selected);b.setAttribute('aria-selected',String(b.dataset.range===selected));}host.replaceChildren();const points=dated(d.observations),end=points.at(-1)?.periodStart ?? 0,days=ranges.find(r=>r[0]===selected)[2];chart(host,points.filter(p=>p.periodStart>=end-days*86400000));};
        periods.setAttribute('role','tablist');periods.setAttribute('aria-label','报价走势范围');
        for(const [key,label] of ranges){const b=button(label,()=>{selected=key;draw();});b.className='chip-tab';b.dataset.range=key;b.setAttribute('role','tab');periods.append(b);}draw();        shell.append(periods,host,metrics(row));
        const history=node('details');history.append(node('summary',`历史报价 (${d.observations.length})`));const table=node('table','','hardware-history-table');
        const header=node('tr');for(const label of ['报价期','均价','高价','低价'])header.append(node('th',label));table.append(header);
        for(const r of d.observations){const tr=node('tr');for(const text of [r.period || '待核验',number(r.average),number(r.high),number(r.low)])tr.append(node('td',text));table.append(tr);}history.append(table);shell.append(history);
        const sources=node('details');sources.append(node('summary','原始价表与修订'));
        for(const s of d.snapshots)sources.append(button(`${s.title} · ${time(s.capturedAt)}`,()=>openPage('hardware',`snapshot/${s.id}`)));
        for(const r of d.revisions.filter(r=>r.revision>1))sources.append(node('p',`${r.period || '待核验'} · 均价 ${number(r.average)} · 修订 ${r.revision}`));shell.append(sources);
      } else {
        const s=data.snapshot;shell.append(node('h2',s.title,'detail-title'),node('p',`${s.format==='legacy-text'?'旧价表快照':'原始价表快照'} · ${time(s.capturedAt)}`,'detail-meta'));
        shell.append(button('查看AI硬件价格',()=>setView('market/global/hardware')));
        const a=node('a','查看原站');a.href=s.sourceUrl;a.target='_blank';a.rel='noopener noreferrer';shell.append(a);
        const raw=node('details');raw.append(node('summary','保存的原始价表'),s.format==='html'?originalTables(s.raw):node('pre',s.raw,'hardware-raw'));shell.append(raw);
        const rows=node('div','','quote-list');renderRows(rows,s.items);shell.append(rows);
      }
      root.replaceChildren(shell);
    } catch(error) {if(token!==request || !isCurrent(id))return;root.replaceChildren(node('p',error.message,'empty-state'),button('重试',()=>render(root,id)));}
  }
  return {render};
}
