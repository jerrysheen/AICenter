import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { FEED_QUALITY_VERSION, FEED_QUALITY_PROFILES } from '../packages/domain/src/feed-quality.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const instance=resolveInstanceConfig({repositoryRoot:root});
const day=process.argv.find(arg=>arg.startsWith('--day='))?.slice(6) || '2026-10-04';
if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid day');
const dir=path.join(instance.runtimeDirectory,'feed-quality-audit',`${day}-${FEED_QUALITY_VERSION}`);
const read=name=>JSON.parse(readFileSync(path.join(dir,name),'utf8'));
const result=read('results.json'),reference=read('review-set.json');
const items=new Map(result.items.map(item=>[item.id,item]));
const divide=(numerator,denominator)=>({numerator,denominator,percent:denominator?Math.round(numerator/denominator*1000)/10:null});
const evaluate=(rows,profile)=>{
  const accepted=rows.filter(row=>items.get(row.id).decisions[profile].decision==='KEEP');
  const good=rows.filter(row=>row.referenceLabel==='GOOD');
  const high=good.filter(row=>row.highValue),junk=rows.filter(row=>row.referenceLabel==='JUNK');
  const count=(rows,decision)=>rows.filter(row=>items.get(row.id).decisions[profile].decision===decision).length;
  return {sampleCount:rows.length,acceptedUseful:divide(accepted.filter(row=>row.referenceLabel==='GOOD').length,accepted.length),
    usefulRetained:divide(count(good,'KEEP'),good.length),highValueRetained:divide(count(high,'KEEP'),high.length),
    clearJunkDropped:divide(count(junk,'DROP'),junk.length),reviewRate:divide(count(rows,'REVIEW'),rows.length),
    usefulDropped:count(good,'DROP'),usefulReview:count(good,'REVIEW'),junkReview:count(junk,'REVIEW'),
    incompleteDropped:count(rows.filter(row=>row.referenceLabel==='INCOMPLETE'),'DROP')};
};
const audit={sampleHash:reference.sampleHash,referenceHash:reference.referenceHash,
  annotationSource:'Codex AI辅助逐条原文复核，不是人工真值；仅作错误发现，不代表全量准确率。',
  sampleSelection:'固定200条，按来源分层、补充AI应用/模型与算法、长文和缺正文；不按JEV预测挑样。',
  split:'calibration/validation 各100条；本轮只比较预设三组阈值，没有用样本调参。',
  groundTruthAvailable:false,productionQualified:false,
  metrics:Object.fromEntries(['conservative','balanced','strict'].map(profile=>[profile,{
    overall:evaluate(reference.rows,profile),calibration:evaluate(reference.rows.filter(row=>row.split==='calibration'),profile),
    validation:evaluate(reference.rows.filter(row=>row.split==='validation'),profile)}]))};
const cases=reference.rows.flatMap(row=>{
  const item=items.get(row.id),decision=item.decisions.balanced;
  let category='';
  if(row.referenceLabel==='GOOD' && decision.decision==='DROP') category='疑似误淘汰';
  else if(row.referenceLabel==='GOOD' && decision.decision==='REVIEW') category='有用内容被挂起';
  else if(row.referenceLabel==='JUNK' && decision.decision!=='DROP') category='垃圾没有明确淘汰';
  else if(row.referenceLabel==='INCOMPLETE' && decision.decision==='DROP') category='缺上下文却被淘汰';
  else if(row.referenceLabel!=='GOOD' && decision.decision==='KEEP') category='疑似误放行';
  return category?[{id:row.id,category,reference:row,decision,scores:item.scores}]:[];
});
// Post-scoring error discovery is separate from the frozen reference metrics.
for (const [id,note] of [
  ['feed:6ee33e2d-028a-42d2-828b-390cff32e940','文字要求复制 this prompt，但真正提示词可能在未抓图片中。缺上下文概率仅0.30，错误进入低实质淘汰分支。'],
  ['feed:16326bb2-30b9-490d-af16-e6d4d68633c7','15个提示词不在主帖中，附带评论有作者续写的具体提示词且评论被截短。应待定，不应称为垃圾。'],
]) if(items.has(id)) {
  const item=items.get(id);cases.push({id,category:'补充缺上下文误淘汰疑点',postScoreReview:true,
    note,decision:item.decisions.balanced,scores:item.scores});
}
writeFileSync(path.join(dir,'review-metrics.json'),JSON.stringify(audit,null,2));
writeFileSync(path.join(dir,'error-cases.json'),JSON.stringify(cases,null,2));
result.summary.review={...result.summary.review,referenceCount:200,annotationSource:audit.annotationSource,
  metrics:audit.metrics,qualityTargetsVerified:false};
writeFileSync(path.join(dir,'summary.json'),JSON.stringify(result.summary,null,2));
const payload=JSON.stringify({summary:result.summary,items:result.items,
  audit,reference:reference.rows,cases,thresholds:FEED_QUALITY_PROFILES}).replaceAll('<','\\u003c');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JEV 筛选前后对比 · ${day}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#1e293b;font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1240px;margin:auto;padding:32px 24px}h1{font-size:28px;margin:0 0 8px}h2{margin:30px 0 12px;font-size:20px}p{margin:8px 0}.muted{color:#64748b}.panel{background:#fff;border:1px solid #dbe1e9;border-radius:12px;padding:20px;margin:16px 0}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{background:white;border:1px solid #dbe1e9;border-radius:10px;padding:16px}.card b{display:block;font-size:30px}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #e8edf3}th{background:#f8fafc}select,input,button{font:inherit;padding:8px 10px;border:1px solid #cad4df;border-radius:7px;background:white;color:inherit}button{cursor:pointer}.controls{display:flex;gap:9px;flex-wrap:wrap}.scroll{overflow:auto}.KEEP{color:#167341}.DROP{color:#bc3434}.REVIEW{color:#9b6500}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;background:#f8fafc;border-radius:8px;padding:16px}details{padding:8px 0}summary{cursor:pointer}a{color:#245ab5}#detail:empty{display:none}.rowtitle{max-width:600px;overflow-wrap:anywhere}#detail{scroll-margin-top:12px}.warning{border-left:4px solid #dd962a}small{color:#64748b}@media(max-width:650px){main{padding:20px 12px}.cards{grid-template-columns:repeat(2,1fr)}th,td{padding:8px}h1{font-size:24px}}
</style><main><h1>JEV 筛选前后对比</h1><p class="muted">${day} 00:00 至次日 00:00 · 上海时间 · 按首次新增保存时间 · 离线 shadow</p>
<div class="panel warning"><b>结论：能挡住一部分无价值内容，但好内容损失明显，目前不能启用生产拦截。</b>
<p>旧版只做信息完整性过滤，生产为 shadow，全部内容仍被保存。新版用六项概率逐条判断；网页新闻只参加本次离线审核，尚未接入生产过滤。</p>
<p>200 条复核标签来自 Codex 对原文的 AI 辅助判断，不是人工真值。阅读范围来自现有 Instance Tag 目录的主题定义，条目自身的 Tag 不参与评分。范围外不等于垃圾，待定不等于已淘汰。</p>
<p>均衡规则在固定样本中让5条有用内容淘汰、32条有用内容待定，另外15条缺上下文材料被淘汰。复制提示词但图片缺失、方法在作者续帖中，仍可能误判。低价值段子和VPN广告有些留在待定，不能算已经清除。</p>
<p>媒体正文部分是后来补齐的；没有精确首次原文版本的记录均已标明。日报、Tag 分类、10／10／20 预算及用户阅读状态没有因本次回放改变。</p></div>
<div class="cards" id="cards"></div><h2>三组初始阈值</h2><div class="panel scroll" id="profiles"></div>
<h2>按来源看去留</h2><div class="panel scroll" id="sources"></div><h2>关注的两个 Tag</h2><div class="panel scroll" id="tags"></div>
<h2>200 条固定样本复核</h2><p class="muted">同时统计有效内容被挂起的损失。以下比例只针对这个分层样本和 AI 辅助参考标签，不外推为全量准确率。</p><div class="panel scroll" id="metrics"></div>
<h2>展开原文与筛选前后</h2><div class="panel"><div class="controls">
<select id="profile"><option value="balanced">均衡阈值</option><option value="conservative">保守阈值</option><option value="strict">严格阈值</option></select>
<select id="source"><option value="">全部来源</option></select><select id="tag"><option value="">全部 Tag</option><option value="ai_application">AI 应用</option><option value="ai_model">模型与算法</option></select>
<select id="decision"><option value="">全部结果</option><option value="KEEP">通过</option><option value="DROP">淘汰</option><option value="REVIEW">待定</option></select>
<select id="case"><option value="">全部材料</option><option value="review">200 条复核集</option><option value="errors">错误疑点</option><option value="goodloss">有用内容被淘汰／挂起</option><option value="junkdrop">复核垃圾已淘汰</option></select>
<input id="search" placeholder="搜索标题、作者或原文" aria-label="搜索标题、作者或原文"></div><p id="count" class="muted"></p><div class="scroll"><table><thead><tr><th>来源</th><th>标题／正文开头（点击展开）</th><th>旧版判断</th><th>新版结果</th><th>原因</th></tr></thead><tbody id="rows"></tbody></table></div>
<p><button id="prev">上一页</button> <span id="page"></span> <button id="next">下一页</button></p></div><div id="detail" class="panel"></div>
<details class="panel"><summary>输入版本、缓存与统计口径</summary><div id="versions"></div><p>冻结原文 corpus.json；逐条原始概率 scores.jsonl；results.json 包含原文和三组去留。缓存以输入、问题定义、版本、范围和固定模型做哈希；改阈值可本地重算；--retry-errors 才重新调用失败条目。</p><p>排除 254 条媒体 Feed 镜像；108 条媒体索引按 canonical URL 合并为107篇。Tag 为冻结导出时状态，允许多标签重叠。实际没有删除906条；它们只是模拟淘汰集。</p></details></main>
<script type="application/json" id="data">${payload}</script><script>
const data=JSON.parse(document.getElementById('data').textContent),ref=new Map(data.reference.map(r=>[r.id,r])),errors=new Set(data.cases.map(r=>r.id)),caseMap=new Map(data.cases.map(r=>[r.id,r]));
const names={conservative:'保守',balanced:'均衡',strict:'严格'},decisionNames={KEEP:'通过',DROP:'淘汰',REVIEW:'待定'},reasonNames={'qualified':'相关且有具体阅读收获','outside-scope':'主要内容在阅读范围外','no-substance':'价值低且具体性／完整性低','empty-promotion':'广告高且实质信息不足','body-missing':'正文未取得／只抓到评论','context-missing':'必要上下文不足','input-truncated':'输入被截断','input-too-large':'全文超过请求安全上限','invalid-scores':'概率无效','jev-failed':'接口失败','borderline':'未同时达到明确通过或淘汰条件'};
const labelNames={GOOD:'有用内容',JUNK:'明确垃圾',OUT_OF_SCOPE:'有内容但范围外',INCOMPLETE:'缺必要上下文',UNCERTAIN:'参考标签待定'};
const el=id=>document.getElementById(id),make=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
function table(target,heads,rows){const t=make('table'),h=make('tr');heads.forEach(x=>h.append(make('th',x)));const head=make('thead');head.append(h);t.append(head);const body=make('tbody');rows.forEach(values=>{const row=make('tr');values.forEach(value=>row.append(make('td',value)));body.append(row);});t.append(body);el(target).replaceChildren(t);}
const totals=data.summary.totals;[['原始材料',totals.total],['通过',totals.balanced.KEEP],['模拟淘汰',totals.balanced.DROP],['待定',totals.balanced.REVIEW]].forEach(([title,n])=>{const card=make('div',undefined,'card');card.append(make('span',title),make('b',n));el('cards').append(card);});
table('profiles',['预设','通过','模拟淘汰','待定','待定比例'],Object.keys(names).map(p=>[names[p],totals[p].KEEP,totals[p].DROP,totals[p].REVIEW,(totals[p].REVIEW/totals.total*100).toFixed(1)+'%']));
table('sources',['来源','原始','旧版会淘汰*','新版通过','新版淘汰','新版待定'],Object.entries(data.summary.bySource).map(([name,s])=>[name,s.total,s.oldShadowDrop,s.balanced.KEEP,s.balanced.DROP,s.balanced.REVIEW]));el('sources').append(make('small','* 社交来源使用历史Capture上的V1判断，没有重新评分；网页旧版未接入。旧生产shadow实际全部保存。'));
table('tags',['Tag','原始','通过','淘汰','待定'],Object.entries(data.summary.byTag).map(([name,s])=>[name==='ai_application'?'AI 应用':'模型与算法',s.total,s.balanced.KEEP,s.balanced.DROP,s.balanced.REVIEW]));
function fraction(v){return v.percent===null?'不可计算':v.numerator+'/'+v.denominator+'（'+v.percent+'%）';}
table('metrics',['预设／样本','通过集有用比例','有用内容进入通过集','高价值保留率','明确垃圾淘汰率','待定比例'],Object.keys(names).flatMap(p=>[['overall','全部200条'],['validation','冻结验证100条']].map(([split,title])=>{const m=data.audit.metrics[p][split];return [names[p]+' · '+title,fraction(m.acceptedUseful),fraction(m.usefulRetained),fraction(m.highValueRetained),fraction(m.clearJunkDropped),fraction(m.reviewRate)];})));
table('versions',['输入版本','数量'],Object.entries(data.summary.byInputVersion).map(([name,s])=>[name,s.total]));
for(const name of Object.keys(data.summary.bySource)){const option=make('option',name);option.value=name;el('source').append(option);}
let page=0;const pageSize=40;
function render(){const profile=el('profile').value,q=el('search').value.toLowerCase(),mode=el('case').value;
const rows=data.items.filter(item=>{const d=item.decisions[profile],r=ref.get(item.id);return (!el('source').value||item.source===el('source').value)&&(!el('tag').value||item.tags.includes(el('tag').value))&&(!el('decision').value||d.decision===el('decision').value)&&(!q||(item.title+' '+item.author+' '+item.rawText).toLowerCase().includes(q))&&(!mode||(mode==='review'&&r)||(mode==='errors'&&errors.has(item.id))||(mode==='goodloss'&&r?.referenceLabel==='GOOD'&&d.decision!=='KEEP')||(mode==='junkdrop'&&r?.referenceLabel==='JUNK'&&d.decision==='DROP'));});
const pages=Math.max(1,Math.ceil(rows.length/pageSize));page=Math.min(page,pages-1);el('count').textContent='匹配 '+rows.length+' 条；逐条点击展开原文。';el('page').textContent=(page+1)+' / '+pages;el('prev').disabled=page===0;el('next').disabled=page===pages-1;el('rows').replaceChildren();
rows.slice(page*pageSize,(page+1)*pageSize).forEach(item=>{const d=item.decisions[profile],row=make('tr'),title=make('button',(item.title||item.rawText||'无正文').replace(/\\s+/g,' ').slice(0,110));title.onclick=()=>detail(item);const td=make('td',undefined,'rowtitle');td.append(title);row.append(make('td',item.source),td,make('td',decisionNames[item.old.wouldDecision]),make('td',decisionNames[d.decision],d.decision),make('td',reasonNames[d.reason]||d.reason));el('rows').append(row);});}
function detail(item){const box=el('detail'),d=item.decisions[el('profile').value],r=ref.get(item.id);box.replaceChildren(make('h2',item.title||'无标题'),make('p',item.source+' · '+item.author+' · '+item.tags.join('、')),make('p','旧版：'+decisionNames[item.old.wouldDecision]+'（'+item.old.reason+'）；新版：'+decisionNames[d.decision]+' · '+(reasonNames[d.reason]||d.reason),d.decision));
if(item.url&&/^https?:\\/\\//.test(item.url)){const link=make('a','打开来源');link.href=item.url;link.target='_blank';link.rel='noreferrer noopener';box.append(link);}
const t=make('table'),tr=make('tr');[['阅读价值','reading_value'],['广告','advertising'],['具体内容','specific_content'],['信息足够','sufficient_information'],['主题相关','topic_relevance'],['缺上下文','missing_context']].forEach(([name,key])=>{const td=make('td',name+'：'+(item.scores?item.scores[key]:'未评分'));tr.append(td);});t.append(tr);box.append(t);
box.append(make('p','输入版本：'+item.inputVersion+'；'+(item.originalVersionExact?'精确首次入库原文':'未声称精确首次入库回放'), 'muted'));
if(r){box.append(make('p','AI 辅助参考：'+labelNames[r.referenceLabel]+(r.highValue?' · 高价值':'')+' · '+r.split),make('p',r.note));}
const extra=caseMap.get(item.id);if(extra?.postScoreReview)box.append(make('p','补充错误疑点（评分后发现，不计入固定样本指标）：'+extra.note));
box.append(make('h3','抓取原文（未经摘要）'),make('pre',item.rawText||'尚未取得正文。'));
if(!item.rawText&&item.indexSummary)box.append(make('h3','索引摘要（未用作全文评分）'),make('pre',item.indexSummary));
const normalized=make('details'),caption=make('summary','查看真正提交给 JEV 的正文');normalized.append(caption,make('pre',item.input.body||'正文缺失：未调用 JEV，进入待定'));box.append(normalized);
if(item.input.comments){const comments=make('details');comments.append(make('summary','附带评论留底（没有提交给 JEV）'),make('pre',item.input.comments));box.append(comments);}
box.scrollIntoView({behavior:'smooth',block:'start'});}
['profile','source','tag','decision','case','search'].forEach(id=>el(id).addEventListener(id==='search'?'input':'change',()=>{page=0;render();}));el('prev').onclick=()=>{page--;render();};el('next').onclick=()=>{page++;render();};render();
</script></html>`;
writeFileSync(path.join(dir,'report.html'),html);
console.log(JSON.stringify({dir,metrics:audit.metrics,caseCounts:cases.reduce((counts,row)=>({...counts,[row.category]:(counts[row.category]||0)+1}),{})},null,2));
