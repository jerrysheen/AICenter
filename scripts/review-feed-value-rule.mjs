import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {createStore} from '../packages/database/src/index.js';
import {createFeedValueReviewService} from '../packages/domain/src/feed-value-review-service.js';
import {decideFeedValue,FEED_VALUE_RULE,feedValueRuleHash,feedValuePolicyHash,FEED_VALUE_POSITIVE_KEYS} from '../packages/domain/src/feed-value.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const instance=resolveInstanceConfig({repositoryRoot:root});
const rule=process.argv.find(a=>a.startsWith('--rule='))?.slice(7) || FEED_VALUE_RULE;
const all=rule==='all-three-0.60',heading=all?'三项均至少 0.60':'两项严格大于 0.60';
const base=path.join(instance.runtimeDirectory,'feed-quality-audit','2026-10-04-feed-value-v3.0');
const dir=path.join(instance.runtimeDirectory,'feed-quality-audit',`2026-10-05-${rule}`);
mkdirSync(dir,{recursive:true});
const old=JSON.parse(readFileSync(path.join(base,'results.json'),'utf8'));
if(old.summary.calibration?.policyHash!==feedValuePolicyHash() || old.summary.calibration?.model!=='jev-1.13.0') throw new Error('Scoring questions/model changed; old scores cannot be replayed');
const refs=JSON.parse(readFileSync(path.join(base,'review-set.json'),'utf8')).rows;
const refMap=new Map(refs.map(r=>[r.id,r]));
const items=old.items.map(r=>({...r,priorDecision:r.decision,quality:refMap.get(r.id)?.quality || 'NOT_ANNOTATED',
  passed:FEED_VALUE_POSITIVE_KEYS.filter(k=>all?r.scores?.[k]>=.60:r.scores?.[k]>.60),
  decision:decideFeedValue(r.scores,{input:r.input,model:r.model,errorReason:r.errorReason,rule})}));
const count=rows=>rows.reduce((a,r)=>{a[r.decision.decision]++;return a;},{KEEP:0,DROP:0,REVIEW:0});
const transition={};for(const r of items){const k=`${r.priorDecision.decision}→${r.decision.decision}`;transition[k]=(transition[k]||0)+1;}
const summary={generatedAt:new Date().toISOString(),rule,ruleHash:feedValueRuleHash(rule),comparison:all?'all three positive scores >= 0.60; only KEEP admitted':'strict > 0.60, at least two positive scores',
  scoreOrigin:'existing V3 five-question scores; no new JEV requests',model:'jev-1.13.0',count:items.length,counts:count(items),prior:old.summary.counts,transition,
  bySource:Object.fromEntries([...new Set(items.map(r=>r.source))].map(s=>[s,count(items.filter(r=>r.source===s))])),
  substantive:count(items.filter(r=>r.quality==='SUBSTANTIVE')),annotationSource:'AI-assisted reference, not human truth; all samples now diagnostic',
  santa:items.find(r=>r.id==='feed:a795f606-497b-48db-9f4d-779c833930a0')};
if(process.argv.includes('--apply')) {
  if(rule!==FEED_VALUE_RULE) throw new Error('Only the current production rule can be applied');
  const store=createStore(instance.databasePath);
  try {summary.productionReplay=createFeedValueReviewService({feedRepository:store.repositories.feed,mediaRepository:store.repositories.media}).apply(old.items);}
  finally{store.close();}
  writeFileSync(path.join(dir,'production-replay.json'),JSON.stringify({ruleHash:summary.ruleHash,scorePolicyHash:feedValuePolicyHash(),result:summary.productionReplay},null,2));
} else if(existsSync(path.join(dir,'production-replay.json'))) {
  const receipt=JSON.parse(readFileSync(path.join(dir,'production-replay.json'),'utf8'));
  if(receipt.ruleHash===summary.ruleHash && receipt.scorePolicyHash===feedValuePolicyHash()) summary.productionReplay=receipt.result;
}
const save=(name,data)=>writeFileSync(path.join(dir,name),JSON.stringify(data,null,2));
save('summary.json',summary);save('results.json',{summary,items});
save('index.json',items.map(({id,title,url,source,tags,tagStatus,scores,passed,quality,decision,priorDecision})=>({id,title,url,source,tags,tagStatus,scores,passed,quality,decision,priorDecision})));
const retained=items.filter(r=>r.decision.decision==='KEEP');
const rank=r=>r.scores.reading_value+r.scores.specific_content+r.scores.sufficient_information;
const groups=Object.fromEntries([...new Set(retained.map(r=>r.source))].map(s=>[s,retained.filter(r=>r.source===s).sort((a,b)=>rank(b)-rank(a))]));
save('retained-news.json',{rule,scoreOrigin:summary.scoreOrigin,groups});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const table=rows=>`<table><tr><th>来源</th><th>保留</th><th>淘汰</th><th>待定</th></tr>${rows.map(([s,c])=>`<tr><td>${esc(s)}</td><td>${c.KEEP}</td><td>${c.DROP}</td><td>${c.REVIEW}</td></tr>`).join('\n')}</table>`;
const examples=items.filter(r=>r.quality==='SUBSTANTIVE'&&r.priorDecision.decision==='KEEP'&&r.decision.decision!=='KEEP');
const render=r=>`<details><summary>${esc(r.title || r.input.body.slice(0,85))} — ${r.decision.decision}</summary><p><a href="${esc(/^https?:\/\//.test(r.url)?r.url:'#')}">来源原文</a> · ${esc(r.id)}</p><p>保存价值 ${r.scores?.reading_value} / 具体程度 ${r.scores?.specific_content} / 信息充分 ${r.scores?.sufficient_information}；缺上下文 ${r.scores?.missing_context}。理由 ${esc(r.decision.reason)}</p><pre>${esc(r.input.body.slice(0,1800))}</pre></details>`;
const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><title>两项严格大于 0.60：新筛选报告</title><style>body{font:16px/1.7 system-ui;max-width:1050px;margin:40px auto;padding:0 22px;color:#18232c}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd6de;padding:7px}details{border:1px solid #dde3e8;padding:12px;margin:10px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}h1{font-size:27px}</style><h1>两项严格大于 0.60：新筛选报告</h1><p>三项正向分数至少两项 > 0.60。关键缺失／技术异常待定；广告不否决。用户选定策略，非独立概率校准。</p><p>同一批 ${items.length} 条，复用 V3 五问、同模型、同输入评分，未重新请求 JEV。生成 ${esc(summary.generatedAt)}。</p>${table([['全部',summary.counts],...Object.entries(summary.bySource)])}<p>生产历史回放：${esc(JSON.stringify(summary.productionReplay || '未执行'))}。输入改变时不复用旧分数。原文和用户阅读／隐藏状态保留。</p><h2>圣诞行情</h2>${render(summary.santa)}<h2>有实质信息但新规则未保留的参考样本（${examples.length}）</h2><p>参考标签来自 AI 辅助复核，不等于人工标准答案。</p>${examples.map(render).join('\n')}<h2>整理后的保留新闻</h2><p>每个来源展示分数之和最高的 12 条，附原文摘录；完整清单见 retained-news.json。来源主张未做事实核实。正文不嵌入全量数据。</p>${Object.entries(groups).map(([source,rows])=>`<h3>${esc(source)}（${rows.length} 条保留）</h3>${rows.slice(0,12).map(render).join('\n')}`).join('\n')}<h2>低保存价值、另两项通过</h2><p>二选三规则允许这种情况，共 ${retained.filter(r=>r.scores.reading_value<=.60).length} 条。</p>${retained.filter(r=>r.scores.reading_value<=.60).slice(0,5).map(render).join('\n')}</html>`;
const renderedHtml=all ? html.replaceAll('两项严格大于 0.60',heading)
  .replace('三项正向分数至少两项 > 0.60。关键缺失／技术异常待定；广告不否决。','三项正向分数全部 ≥ 0.60 才入内容库。关键缺失／技术异常原始采集待补，不进入新闻可读池；广告不否决。')
  .replace(/<h2>低保存价值、另两项通过<\/h2>[\s\S]*?<\/html>/,'</html>') : html;
writeFileSync(path.join(dir,'report.html'),renderedHtml);
console.log(JSON.stringify({dir,counts:summary.counts,substantive:summary.substantive,transition,productionReplay:summary.productionReplay,htmlBytes:Buffer.byteLength(renderedHtml)}));
