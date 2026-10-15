import { parseDocument, DomUtils } from 'htmlparser2';
import { HardwarePriceSnapshotInputSchema, canonicalHardwareSpecification, isHardwarePriceLabel } from '../../contracts/src/hardware-prices.js';
export const PRICE_PARSER_VERSION = 'trendforce-tables-5';
function headerIndex(headers, patterns) {
  for (const pattern of patterns) {
    const index = headers.findIndex(header => pattern.test(header));
    if (index >= 0) return index;
  }
  return -1;
}
function memoryChipLabel(heading) {
  return /(?:DRAM|NAND Flash)\s+(?:Spot|Contract)\s+Price/i.test(heading) && !/Wafer|Module|eMMC|Card|SSD|Street/i.test(heading);
}
// Public titles now only say 未稅. The unit follows the table the row belongs to.
function boardUnit(heading) {
  const title = heading || '';
  if (/\bModule\b/i.test(title)) return 'module';
  if (/\bGDDR\b/i.test(title)) return 'chip';
  if (/\bWafer\b/i.test(title)) return 'wafer';
  if (/\bSSD\b/i.test(title)) return 'unit';
  if (/NAND Flash\s+Contract/i.test(title)) return 'chip';
  if (/Memory Card|存储卡|存儲卡/i.test(title)) return 'card';
  if (memoryChipLabel(title)) return 'chip';
  return null;
}
const clean = n => DomUtils.textContent(n).replace(/\s+/g,' ').trim();
const hasClass = (n,c) => (n.attribs?.class || '').split(/\s+/).includes(c);
const number = v => /^[-+]?\d[\d,]*(?:\.\d+)?$/.test(v.trim()) ? v.trim().replace(/,/g,'').replace(/^\+/,'') : null;
function updated(raw) {
  const m=raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?.*?(?:GMT|UTC)\s*([+-]\d{1,2})/i);
  if (!m) return null;
  const value=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4]-Number(m[7]),+m[5],+(m[6] || 0));
  return Number.isFinite(value) ? value : null;
}
function matrix(table) {
  const result=[];
  for (const [i,tr] of DomUtils.findAll(n=>n.name==='tr',table.children || []).entries()) {
    result[i] ||= []; let col=0;
    for (const cell of (tr.children || []).filter(n=>['td','th'].includes(n.name))) {
      while (result[i][col] !== undefined) col++;
      const rowSpan=Math.min(100,Math.max(1,Number(cell.attribs?.rowspan) || 1));
      const colSpan=Math.min(80,Math.max(1,Number(cell.attribs?.colspan) || 1));
      for(let r=i;r<i+rowSpan;r++) { result[r] ||= [];for(let c=col;c<col+colSpan;c++) result[r][c]=clean(cell); }
      col+=colSpan;
    }
  }
  return result;
}
function periodFor(context,type,sourceUpdatedAt) {
  const explicit=context.match(/(?:報價日期|报价日期|\bDate\b|\bPeriod\b|報價期間|报价期间)\s*[:：]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i);
  const contract=context.match(/(\d{4})\s*[-/]\s*(\d{1,2})\s*(?:(1H|2H)|月份|月|Contract)/i);
  const quarter=context.match(/([1-4])Q['’]?(\d{2}|\d{4})(?!\d)/i);
  const half=context.match(/(1H|2H)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i);
  const updatedDate=sourceUpdatedAt===null?null:new Date(sourceUpdatedAt+8*3600000);
  let start=null,end=null,label=null;
  if(explicit) { const [y,m,d]=explicit[1].split(/[-/]/).map(Number);start=Date.UTC(y,m-1,d)-8*3600000;end=start+86400000;label=explicit[1].replace(/\//g,'-'); }
  else if(['spot','retail'].includes(type) && sourceUpdatedAt!==null) { const date=new Date(sourceUpdatedAt+8*3600000); label=date.toISOString().slice(0,10);start=Date.parse(`${label}T00:00:00+08:00`);end=start+86400000; }
  else if(type==='contract' && contract) { const y=+contract[1],m=+contract[2],half=contract[3] || '';start=Date.UTC(y,m-1,half==='2H'?16:1)-8*3600000;end=half==='1H'?Date.UTC(y,m-1,16)-8*3600000:Date.UTC(y,m,1)-8*3600000;label=`${y}-${String(m).padStart(2,'0')}${half?' '+half:''}`; }
  else if(type==='contract' && quarter) {const y=quarter[2].length===2?2000+Number(quarter[2]):Number(quarter[2]),q=Number(quarter[1]);start=Date.UTC(y,(q-1)*3,1)-8*3600000;end=Date.UTC(y,q*3,1)-8*3600000;label=`${y} Q${q}`;}
  else if(type==='contract' && half && updatedDate) {const m=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(half[2].toLowerCase());
    // A month-only heading is usable only when the source update confirms that month.
    if(m===updatedDate.getUTCMonth()) {const y=updatedDate.getUTCFullYear();start=Date.UTC(y,m,half[1]==='2H'?16:1)-8*3600000;end=half[1]==='1H'?Date.UTC(y,m,16)-8*3600000:Date.UTC(y,m+1,1)-8*3600000;label=`${y}-${String(m+1).padStart(2,'0')} ${half[1]}`;}}
  return {period:label,periodStart:start,periodEnd:end};
}
export function parseStructuredPricePage(raw,{pageKey='dram',sourceUrl,title='',capturedAt=Date.now()}={}) {
  const dom=parseDocument(raw); const panels=[];let heading='',updateRaw='',context='';
  function walk(node) {
    if (['script','style','nav'].includes(node.name)) return;
    if(hasClass(node,'price-title')) { heading=clean(node);updateRaw='';context=heading;return; }
    if(hasClass(node,'price-last-update')) { updateRaw=clean(node);context+=' '+updateRaw;return; }
    if(node.name==='table' && hasClass(node,'price-table')) {
      const siblings=node.parent?.children || [];const index=siblings.indexOf(node);let start=index,end=index+1;
      while(start>0 && !hasClass(siblings[start-1],'price-title') && siblings[start-1]?.name!=='table')start--;
      if(start>0 && hasClass(siblings[start-1],'price-title'))start--;
      while(end<siblings.length && !hasClass(siblings[end],'price-title') && siblings[end]?.name!=='table')end++;
      const parentContext=siblings.slice(start,end).filter(n=>n.name && n.name!=='table' && !['script','style'].includes(n.name)).map(clean).join(' ');
      panels.push({table:node,heading,updateRaw,context:context+' '+clean(node)+' '+parentContext});return;
    }
    for(const child of node.children || []) walk(child);
  }
  walk(dom);const rows=[],warnings=[];
  for (const [tableIndex,p] of panels.entries()) {
    const cells=matrix(p.table); const firstData=cells.findIndex(r=>r.slice(1).some(v=>number(v)!==null));
    if(firstData<0) { warnings.push(`表${tableIndex+1}没有可识别报价行`);continue; }
    const headers=Array.from({length:Math.max(...cells.map(r=>r.length))},(_,c)=>cells.slice(0,firstData).map(r=>r[c] || '').join(' '));
    const avg=headerIndex(headers,[/盤平均|盘平均|Session Average/i,/Average|Avg|均價|均价|平均/i]);
    const high=headerIndex(headers,[/盤高|盘高|Session High/i,/(?:週|周|日|盤|盘)?高[點点]|\bHigh\b|最高|高價|高价/i]);
    const low=headerIndex(headers,[/盤低|盘低|Session Low/i,/(?:週|周|日|盤|盘)?低[點点]|\bLow\b|最低|低價|低价/i]);
    const change=headerIndex(headers,[/Change|漲跌|涨跌/i]);
    const sourceUpdatedAt=updated(p.updateRaw);
    const quoteType=/spot|現貨|现货/i.test(p.heading)?'spot':/contract|合約|合约/i.test(p.heading)?'contract':/retail|street price|零售/i.test(p.heading)?'retail':'unknown';
    let currency=/(?:US\s*\$|USD|美元)/i.test(p.context)?'USD':/(?:NT\s*\$|TWD|新台幣|新台币)/i.test(p.context)?'TWD':/(?:RMB|CNY|人民幣|人民币)/i.test(p.context)?'CNY':null;
    const unitMatch=p.context.match(/(?:USD|US\s*\$|NT\s*\$|TWD|RMB|CNY|美元)\s*(?:\/|per\s+)\s*(piece|pcs?|unit|chip|GB|Gb|TB|顆|颗|個|个|片)/i);
    let unit=unitMatch?unitMatch[1]:null;
    const taxBasis=/未稅|未税|excluding tax/i.test(p.context)?'excluding-tax':/含稅|含税|including tax/i.test(p.context)?'including-tax':null;
    // Titles used to spell US$/chip and now only say 未稅. Fill USD and the table's unit, without copying a number from anywhere else.
    const inferred=boardUnit(p.heading);
    if(taxBasis==='excluding-tax' && inferred) {
      if(!currency) currency='USD';
      if(!unit) unit=inferred;
    }
    const memberNotice=p.context.match(/updated on\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if(memberNotice) {
      const stamp=`${memberNotice[3]}-${memberNotice[1].padStart(2,'0')}-${memberNotice[2].padStart(2,'0')}`;
      const tableDay=sourceUpdatedAt==null?'':new Date(sourceUpdatedAt+8*3600000).toISOString().slice(0,10);
      if(!tableDay || stamp>tableDay) warnings.push(`${p.heading || '价表'} 公开数字停在 ${tableDay || '未知日期'}，页面通知 ${stamp} 的更新没有公开报价`);
    }
    for(let rowIndex=firstData;rowIndex<cells.length;rowIndex++) {
      const r=cells[rowIndex];if(!r[0])continue;
      const average=avg>=0?number(r[avg] || ''):null,hi=high>=0?number(r[high] || ''):null,lo=low>=0?number(r[low] || ''):null;
      if([average,hi,lo].every(v=>v===null))continue;
      const identity=[];
      for(let i=0;i<headers.length;i++){
        const label=(headers[i] || '').trim(),value=(r[i] || '').trim();
        if(!value || isHardwarePriceLabel(label) || number(value)!==null) continue;
        identity.push(/^(?:項目|项目|Item)$/i.test(label) || !label ? value : `${label}: ${value}`);
      }
      const singleSpec=canonicalHardwareSpecification(identity.join(' · '));
      if(!singleSpec) continue;
      let rowCurrency=currency,rowUnit=unit;
      // SO-DIMM rows share the DRAM contract table with chips. They are modules (条), not chips.
      if(/contract/i.test(p.heading) && /\bDRAM\b/i.test(p.heading) && /SO-?DIMM/i.test(singleSpec) && (rowUnit==='chip' || (!rowUnit && taxBasis==='excluding-tax'))) {
        rowUnit='module';
        if(!rowCurrency) rowCurrency='USD';
      }
      const category=/micro\s*sd|sd\s*card|memory card|存儲卡|存储卡/i.test(singleSpec) || /^(?:Memory Card|存储卡|存儲卡) /i.test(p.heading)?'other-storage':/SSD/i.test(p.heading+' '+singleSpec)?'ssd':pageKey==='dram'?'dram':'nand';
      rows.push({specification:singleSpec,category,quoteType,average,high:hi,low:lo,averageBasis:avg>=0?headers[avg]:null,highBasis:high>=0?headers[high]:null,lowBasis:low>=0?headers[low]:null,currency:rowCurrency,unit:rowUnit,taxBasis,...periodFor(p.heading+' '+p.context,quoteType,sourceUpdatedAt),
        sourceUpdatedAt,sourceUpdatedRaw:p.updateRaw,reportedChange:change>=0?r[change] || null:null,changeBasis:null,tableIndex,rowIndex,rawCells:r.map(v=>v || '')});
    }
  }
  if(!panels.length)warnings.push('未找到原始价表；不从页面文章推断报价');
  return HardwarePriceSnapshotInputSchema.parse({sourceKey:'trendforce',pageKey,sourceUrl,title,capturedAt,parserVersion:PRICE_PARSER_VERSION,format:'html',raw,rows,warnings});
}
export function legacyPriceSnapshot(item,capturedAt=Date.now()) {
  const rows=[];let heading='',updateRaw='',headers=[],tableIndex=-1,rowIndex=0;
  for(const line of (item.body || '').split(/\r?\n/)) {
    if(!line.trim().startsWith('|')) {if(/Last Update/i.test(line))updateRaw=line.trim();else if(line.trim()){heading=line.trim();updateRaw='';}continue;}
    const cells=line.trim().replace(/^\||\|$/g,'').split('|').map(s=>s.trim());
    if(cells.every(s=>/^[- :]+$/.test(s)))continue;
    if(!cells.slice(1).some(s=>number(s)!==null)) {headers=cells;tableIndex++;rowIndex=0;continue;}
    const find=re=>headers.findIndex(h=>re.test(h)),avg=find(/Average|Avg|均價|均价|平均/i),high=find(/(?:日|盤|盘)?高[點点]|\bHigh\b|最高/i),low=find(/(?:日|盤|盘)?低[點点]|\bLow\b|最低/i),change=find(/Change|漲跌|涨跌/i);
    const average=avg>=0?number(cells[avg] || ''):null,hi=high>=0?number(cells[high] || ''):null,lo=low>=0?number(cells[low] || ''):null;
    if([average,hi,lo].every(v=>v===null))continue;
    const specEnd=Math.min(...[avg,high,low,change].filter(i=>i>=0)),specification=specEnd===1?cells[0]:cells.slice(0,specEnd).map((v,i)=>`${headers[i]}: ${v}`).join(' · ');
    rows.push({specification,category:/micro\s*sd|sd\s*card|memory card|存储卡|存儲卡/i.test(specification) || /^(?:Memory Card|存储卡|存儲卡) /i.test(heading)?'other-storage':/SSD/i.test(heading+' '+specification)?'ssd':item.externalId==='price:dram'?'dram':'nand',
      quoteType:/spot|現貨|现货/i.test(heading)?'spot':/contract|合約|合约/i.test(heading)?'contract':/street|retail|零售/i.test(heading)?'retail':'unknown',average,high:hi,low:lo,averageBasis:avg>=0?headers[avg]:null,highBasis:high>=0?headers[high]:null,lowBasis:low>=0?headers[low]:null,currency:null,unit:null,taxBasis:null,period:null,periodStart:null,periodEnd:null,
      sourceUpdatedAt:null,sourceUpdatedRaw:updateRaw,reportedChange:change>=0?cells[change] || null:null,changeBasis:null,tableIndex:Math.max(0,tableIndex),rowIndex:++rowIndex,rawCells:cells});
  }
  return HardwarePriceSnapshotInputSchema.parse({sourceKey:'trendforce',pageKey:item.externalId.replace('price:',''),title:item.title,sourceUrl:item.sourceUrl,capturedAt,
    parserVersion:'legacy-text-1',format:'legacy-text',raw:item.body || item.title,rows,warnings:['旧文本快照；币种、单位与报价期未经核验，不能恢复被覆盖的历史']});
}
