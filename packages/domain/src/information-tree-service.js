import {randomUUID} from 'node:crypto';
import {validateTreeModules,normalizeInformationResponse,treeResponseProtocol,TREE_VALIDATOR_VERSION,TreeNodeSchema,normalizeArticleResponse,ArticleOutputSchema,ARTICLE_VALIDATOR_VERSION,projectTreeInput} from '../../contracts/src/information-tree.js';
import {materialHash,prepareDailyMaterials} from './daily-materials.js';
import {runBounded} from './daily-analysis.js';
import {treeCatalog,treeSource,treeFailure} from './information-tree-policy.js';

const HOUR=3600000;
const stable=rows=>[...rows].sort((a,b)=>a.id.localeCompare(b.id));
const parse=text=>JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
function boundedParagraphs(paragraphs,maxBytes) {
  return paragraphs.flatMap(p=>{
    if(Buffer.byteLength(JSON.stringify(p))+3<=maxBytes)return [p];
    const characters=Array.from(p.text),parts=[];let at=0;
    while(at<characters.length) {
      let lo=1,hi=characters.length-at,fit=0;
      while(lo<=hi) {
        const count=Math.floor((lo+hi)/2),candidate={...p,text:characters.slice(at,at+count).join('')};
        if(Buffer.byteLength(JSON.stringify(candidate))+3<=maxBytes){fit=count;lo=count+1;}else hi=count-1;
      }
      if(!fit)throw new Error('内容块元数据超过预算');
      parts.push({...p,text:characters.slice(at,at+fit).join('')});at+=fit;
    }
    return parts;
  });
}
export function packTreeInputs(rows,maxBytes) {
  const batches=[];let batch=[],bytes=2;
  for(const row of rows) {
    const size=Buffer.byteLength(JSON.stringify(row))+1;
    if(size+2>maxBytes) throw new Error('单条输入超过预算，须在信息阶段处理完整内容块');
    if(bytes+size>maxBytes && batch.length) {batches.push(batch);batch=[];bytes=2;}
    batch.push(row);bytes+=size;
  }
  if(batch.length) batches.push(batch);return batches;
}

export function createInformationTreeReader({repository,timezone='Asia/Shanghai',pipeline='legacy',catalog={}}) {
  return {
    list(workspace,window) {return {timezone,pipeline,directions:catalog.reading?.directionByTag || {},information:repository.listInformation(workspace,window).map(({body,...summary})=>summary),hours:repository.list(workspace,window.startAt,window.endAt,'hourly'),days:repository.list(workspace,window.startAt,window.endAt,'daily')};},
    node(workspace,id) {
      const node=repository.getNode(workspace,id);
      if(!node) return null;
      return {...node,articleCount:node.articleIds.length,ref:node.children.length ? node.id : null};
    },
    children(workspace,id) {
      const node=repository.getNode(workspace,id);
      return node ? node.children.map(id=>this.node(workspace,id)) : null;
    },
  };
}

export function createInformationTreeService({repository,reportRepository,feedService,mediaPort,agentRuntime,skills,
  cacheNamespace='',articleStrategy=false,catalog={tags:[]},primaryTag=null,tagHints=null,classificationOverrideForReplay=null,candidatePort=null,materialPort=null,generationConfig={},timezone='Asia/Shanghai',now=()=>Date.now(),budget={}}) {
  const validatorVersion=articleStrategy ? ARTICLE_VALIDATOR_VERSION : TREE_VALIDATOR_VERSION;
  const config={articleRequestBytes:100000,batchBytes:12000,maxCalls:80,totalMs:20*60000,timeoutMs:180000,queueTimeoutMs:120000,...budget};
  const tagNames=new Map(catalog.tags.map(t=>[t.id,t.name]));
  const classification=treeCatalog(catalog),modelTags=classification.ids;
  const route=stage=>generationConfig[stage] || generationConfig[stage==='daily' ? 'daily-analysis' : 'hourly-brief'] || {};
  const generationVersion=stage=>materialHash(cacheNamespace ? {...route(stage),cacheNamespace} : route(stage));
  const policyHash=materialHash({skills:Object.fromEntries(Object.entries(skills).map(([key,value])=>[key,{version:value.version,compatiblePromptHashes:value.compatiblePromptHashes || []}])),
    validator:validatorVersion,passthrough:'validated-short-independent-v2',generationConfig,groups:classification.groupVersion,catalog:classification.classificationVersion,reclassification:catalog.reading?.reclassification});
  const activated=new Set();
  const ensurePolicy=workspace=>{if(!activated.has(workspace)){repository.activatePolicy(workspace,policyHash);activated.add(workspace);}};
  ensurePolicy('local');
  const reader=createInformationTreeReader({repository,timezone,pipeline:'tree-v3',catalog});
  const reusableInformation=node=>(!articleStrategy || node?.formatVersion===ARTICLE_VALIDATOR_VERSION && Boolean(node.body)) && node?.validatorVersion===validatorVersion && [skills.information.version,...(skills.information.compatiblePromptHashes || [])].includes(node.effectivePromptHash);
  async function classified(node,m,s) {
    let assigned;
    try {assigned=primaryTag?.(s.workspaceId,m);} catch {}
    let tagId=node.tagId,source=node.classification?.source==='reclassified' ? 'reclassified' : 'model';
    if(!assigned?.locked && !classificationOverrideForReplay && ['manual-lock','legacy-control'].includes(node.classification?.source)) {
      const base=repository.getNode(s.workspaceId,`i:${node.draftKey}`);
      if(base)tagId=base.tagId;
    }
    if(assigned?.locked===true){tagId=modelTags.has(assigned.tagId) ? assigned.tagId : null;source='manual-lock';}
    else if(classificationOverrideForReplay){tagId=classificationOverrideForReplay(m);source='legacy-control';}
    else if(!articleStrategy && node.catalogVersion!==classification.classificationVersion && classification.needsReclassification(node)) {
      const output=await model('classification',{title:node.title,text:node.text,tags:classification.tags},raw=>({tagId:modelTags.has(raw?.tagId) ? raw.tagId : null}),s);
      tagId=output.tagId;source='reclassified';
    }
    if(!modelTags.has(tagId))tagId=null;
    if(tagId===node.tagId && node.catalogVersion===classification.classificationVersion && node.classification?.source===source)return node;
    const version=materialHash({draftKey:node.draftKey || node.version,sourceVersion:node.sourceVersion,tagId,catalog:classification.classificationVersion,source});
    return repository.saveNode(s.workspaceId,{...node,id:`i:${version}`,version,tagId,catalogVersion:classification.classificationVersion,classification:{source,ruleVersion:classification.classificationVersion}});
  }
  function session(priority=0,totalMs=config.totalMs) {return {started:Date.now(),totalMs,calls:0,priority};}
  async function model(stage,payload,check,s,renew=()=>{}) {
    const skill=skills[stage] || skills.information;
    const instruction=stage==='classification' ? treeResponseProtocol(stage) : skill.injected || skill.instruction+'\n'+treeResponseProtocol(stage==='information' && articleStrategy ? 'article' : stage);
    const effectivePromptHash=stage==='classification' ? materialHash({instruction,validator:TREE_VALIDATOR_VERSION,skill:skill.version}) : skill.version;
    const key=materialHash({stage,payload,effectivePromptHash,generationVersion:generationVersion(stage)});
    const period='tree-cache',cached=reportRepository.getAnalysisStage(s.workspaceId,period,key,key);
    if(cached?.status==='completed') {try{s.cacheHits=(s.cacheHits || 0)+1;return articleStrategy && stage==='information' ? check(cached.output.status ? cached.output : {title:cached.output.title,tagId:cached.output.tagId,summary:cached.output.text,body:cached.output.body}) : check(cached.output);}catch{reportRepository.saveAnalysisStage(s.workspaceId,period,key,key,{stage,effectivePromptHash},null,'failed','invalid-output: cached response no longer valid');}}
    const owner=randomUUID();
    if(!repository.acquire(s.workspaceId,key,owner,Date.now())) throw Object.assign(new Error('同版本加工中'),{code:'lease-conflict'});
    const heartbeat=()=>{repository.renew(s.workspaceId,key,owner,Date.now());renew();};
    const shape=treeResponseProtocol(stage==='information' && articleStrategy ? 'article' : stage);
    let correction='',lastAnswer='',checkpoint=articleStrategy ? cached?.input?.checkpoint || null : null;
    const articleMessage=()=>{
      if(checkpoint){const missing=['title','tagId','summary','body'].filter(k=>checkpoint[k]===undefined);return {completed:checkpoint,missing,...(!checkpoint.body ? {source:payload.source} : {}),tags:payload.tags,correction:'只补missing中的字段，返回JSON；保留completed，不重写成功项。'};}
      if(lastAnswer)return {response:lastAnswer,correction:'只修复JSON语法，保留原有内容。'+shape};
      return payload;
    };
    let timing;const stageInput=()=>({stage,effectivePromptHash,validatorVersion,executionTiming:timing,...(checkpoint ? {checkpoint} : {}),...(lastAnswer ? {lastAnswer} : {})});
    try {
      for(let attempt=0;attempt<2;attempt++) {
        const remaining=s.totalMs-(Date.now()-s.started);
        if(remaining<=0 || s.calls>=config.maxCalls) throw Object.assign(new Error('浓缩树预算耗尽'),{code:'budget-deferred'});
        s.calls++;
        reportRepository.saveAnalysisStage(s.workspaceId,period,key,key,stageInput(),null,'running');
        const result=await runBounded(agentRuntime,{workspaceId:s.workspaceId,usageStage:`tree-${stage}`,closedContext:true,
          closedTask:stage==='information' && articleStrategy ? 'article-normalize' : stage==='daily' ? 'daily-analysis' : 'hourly-brief',allowedToolIds:[],webMode:'off',enableAuxiliarySearch:false,executionPriority:s.priority,
          taskInstruction:instruction,
          message:JSON.stringify(articleStrategy && stage==='information' ? articleMessage() : {...payload,...(attempt ? {correction:`上一响应未通过校验：${correction}。${shape}不增加事实。`} : {})})},
          Math.min(config.timeoutMs,remaining),heartbeat,30000,{queueTimeoutMs:config.queueTimeoutMs,totalTimeoutMs:remaining,onTiming:value=>{timing=value;reportRepository.saveAnalysisStage(s.workspaceId,period,key,key,stageInput(),null,'running');}});
        // Transport errors and aborted turns propagate; only completed malformed output gets one format repair.
        try {
          lastAnswer=result.answer;
          const parsed=parse(result.answer);
          const output=checkpoint ? {...parsed,...checkpoint} : parsed;
          if(articleStrategy && stage==='information' && output.status===undefined){
            const partial={};
            for(const [k,v] of Object.entries(output))if(ArticleOutputSchema.shape[k]?.safeParse(v).success)partial[k]=v;
            checkpoint=Object.keys(partial).length ? partial : checkpoint;
          }
          const value=check(output);
          const allowed=stage==='information' ? (articleStrategy ? ['title','summary','body','tagId','status'] : ['title','text','tagId','status']) : stage==='classification' ? ['tagId'] : ['modules'];
          const discardedFields=Object.keys(output).filter(k=>!allowed.includes(k));
          reportRepository.saveAnalysisStage(s.workspaceId,period,key,key,{...stageInput(),discardedFields,...(articleStrategy ? {rawAnswer:result.answer,...(output.tagId!==null && !modelTags.has(output.tagId) ? {tagDiagnostic:'unknown-tag-downgraded-to-null'} : {})} : {})},value,'completed');return value;
        } catch(error) {if(articleStrategy && !/[}\]]\s*$/.test(String(result.answer).trim().replace(/```$/, '').trim()))throw Object.assign(new Error('响应中止或截断；不当作完整JSON修复'),{code:'invalid-output'});if(attempt)throw Object.assign(error,{code:'invalid-output'});correction=String(error.message).slice(0,1200);}
      }
    } catch(error) {
      error.timing=timing;reportRepository.saveAnalysisStage(s.workspaceId,period,key,key,{...stageInput(),failure:treeFailure(error,key,'',now())},null,'failed',error.message);throw error;
    } finally {repository.release(s.workspaceId,key,owner);}
  }
  async function information(m,window,s) {
    const source=treeSource(m),sourceHash=materialHash(source),sourceVersion=String(m.version || m.updatedAt || sourceHash);
    // This prompt revision only clarifies titles; completed, validated text remains reusable.
    const head=repository.informationHead(s.workspaceId,m.id)?.node;
    if(head?.sourceVersion===sourceVersion && reusableInformation(head) && head.draftKey===materialHash({source,skill:head.effectivePromptHash,generationVersion:generationVersion('information')})) {s.cacheHits=(s.cacheHits || 0)+1;return classified(head,m,s);}
    const version=materialHash({source,skill:skills.information.version,generationVersion:generationVersion('information')}),id=`i:${version}`;
    const stateKey=`${articleStrategy ? 'article' : 'information'}:${m.id}`,previous=reportRepository.getAnalysisStage(s.workspaceId,'tree-preparation',stateKey,sourceHash);
    const saved=repository.getNode(s.workspaceId,id);
    if(previous?.output?.pending && (!articleStrategy || previous.input?.generationVersion===generationVersion('information')) && previous.output.pending.sourceVersion===sourceVersion && (!previous.output.pending.retryable || previous.output.pending.retryAt>now()) && !s.force && !(saved?.catalogVersion===classification.classificationVersion && saved?.validatorVersion===TREE_VALIDATOR_VERSION))throw Object.assign(new Error(previous.output.pending.reason),{code:previous.output.pending.reason,cachedPending:previous.output.pending});
    if(saved) {
      s.cacheHits=(s.cacheHits || 0)+1;
      const revisionVersion=materialHash({draftKey:version,sourceVersion});
      const revision=saved.sourceVersion===sourceVersion ? saved : repository.saveNode(s.workspaceId,{...saved,id:`i:${revisionVersion}`,version:revisionVersion,sourceVersion,sourceUpdatedAt:m.updatedAt ?? m.obtainedAt ?? m.publishedAt ?? window.startAt});
      return classified(revision,m,s);
    }
    if(!source.paragraphs.length || !source.paragraphs.some(p=>/[\p{L}\p{N}]/u.test(p.text)) || (m.missing?.includes('title_only') && !source.paragraphs.some(p=>p.role==='body')))throw Object.assign(new Error('保存材料无独立内容'),{code:'needs-content'});
    const check=raw=>{
      return articleStrategy ? normalizeArticleResponse(raw,modelTags) : normalizeInformationResponse(raw,modelTags);
    };
    const tags=classification.tags;
    const modelSource={...Object.fromEntries(Object.entries(source).filter(([key])=>key!=='id')),sourceVersion};
    let output;
    if(articleStrategy) {
      const payload={tags:tags.map(({id,name})=>({id,name})),source:modelSource};
      const request=(skills.information.requestPrefix || skills.information.injected)+'\n\n'+JSON.stringify(payload);
      if(Buffer.byteLength(request)>config.articleRequestBytes)throw Object.assign(new Error('完整请求超过文章整理预算；保留原文待处理'),{code:'budget-deferred'});
      output=await model('information',payload,check,s);
    }
    else if(Buffer.byteLength(JSON.stringify(modelSource))<config.batchBytes) output=await model('information',{source:modelSource,tags,tagHints:tagHints?.(s.workspaceId,m) || []},check,s);
    else {
      // Internal consecutive blocks are checkpoints, never additional information nodes.
      const blockBytes=Math.max(3000,config.batchBytes-2500);
      const blocks=packTreeInputs(boundedParagraphs(source.paragraphs,blockBytes),blockBytes);
      let condensed=[];
      for(const [n,paragraphs] of blocks.entries()) {
        const part=await model('information',{source:{...modelSource,paragraphs},block:{index:n,total:blocks.length},tags},check,s);
        if(part.status==='needs_content')throw Object.assign(new Error('长文块缺独立内容'),{code:'needs-content'});
        condensed.push({role:'summary',text:part.text});
      }
      while(Buffer.byteLength(JSON.stringify(condensed))>config.batchBytes-2500) {
        const batches=packTreeInputs(condensed,config.batchBytes-2500),next=[];
        for(const paragraphs of batches) {
          const part=await model('information',{source:{...modelSource,paragraphs},tags},check,s);
          if(part.status==='needs_content')throw Object.assign(new Error('长文块缺独立内容'),{code:'needs-content'});
          next.push({role:'summary',text:part.text});
        }
        if(next.length>=condensed.length) throw new Error('长文内部合并未收敛');condensed=next;
      }
      output=await model('information',{source:{...modelSource,paragraphs:condensed},tags},check,s);
    }
    if(output.status==='needs_content')throw Object.assign(new Error('保存材料不足以提炼'),{code:'needs-content'});
    const node=repository.saveNode(s.workspaceId,{...output,id,version,layer:'information',children:[],articleIds:[m.id],sourceId:m.id,
      sourceRefs:m.sourceRefs || [],window,eventAt:m.eventAt ?? m.publishedAt ?? window.startAt,sourceUpdatedAt:m.updatedAt ?? m.obtainedAt ?? m.publishedAt ?? window.startAt,generatedAt:now(),
      draftKey:version,sourceVersion,effectivePromptHash:skills.information.version,validatorVersion,catalogVersion:classification.classificationVersion,...(articleStrategy ? {formatVersion:ARTICLE_VALIDATOR_VERSION} : {}),inputScope:source.inputScope,
      classification:{source:'model',ruleVersion:classification.classificationVersion},safePassthrough:Array.from(output.text).length<=80 && !/你身边|附近的停车场|敬请|点击|不容错过/u.test(output.text)});
    return classified(node,m,s);
  }
  async function condense(layer,inputs,window,s) {
    const groups=new Map();
    for(const input of stable(inputs)) {
      const tag=classification.group(input.tagId);
      const rows=groups.get(tag) || [];rows.push(input);groups.set(tag,rows);
    }
    const result=[];result.failures=[];
    for(const [tagId,rows] of groups) {
      const version=materialHash({layer,inputs:rows.map(i=>({id:i.id,version:i.version})),tagId,window,skill:skills[layer].version,generationVersion:generationVersion(layer),groups:classification.groupVersion});
      const stageKey=`tree-${layer}:${version}`,cached=reportRepository.getAnalysisStage(s.workspaceId,'tree-cache',stageKey,version);
      try {
      if(cached?.status==='failed' && cached.input?.failure?.retryAt>now())throw Object.assign(new Error(cached.input.failure.reason),{code:cached.input.failure.reason,cachedPending:cached.input.failure});
      if(cached?.status==='completed') {
        try {const nodes=cached.output.ids.map(id=>TreeNodeSchema.parse(repository.getNode(s.workspaceId,id)));validateTreeModules({modules:nodes.map(n=>({...n,inputIds:n.children}))},rows,modelTags);s.cacheHits=(s.cacheHits || 0)+1;result.push(...nodes);continue;}catch{/* Locally rebuild the invalid group; other completed caches remain. */}
      }
      const project=(rows)=>rows.map((i,n)=>({...projectTreeInput(i,`n${n+1}`),tagId,...(layer==='daily' ? {window:i.window} : {})}));
      async function merge(rows,depth=0) {
        if(depth>12) throw new Error('分批合并未收敛');
        const projection=project(rows),batches=packTreeInputs(projection,config.batchBytes);
        if(batches.length===1) {
          const value=await model(layer,{inputs:projection,tagId,tagName:tagNames.get(tagId) || '未分类'},raw=>{
            const output=validateTreeModules(raw,projection,modelTags);
            if(output.modules.some(m=>m.tagId!==tagId)) throw new Error('模块主Tag与固定分组不符');return output;
          },s);
          return value.modules.map(m=>({...m,inputIds:m.inputIds.flatMap(alias=>rows[Number(alias.slice(1))-1].directIds)}));
        }
        const intermediate=[];
        let offset=0;
        for(const batch of batches) {
          const subset=rows.slice(offset,offset+batch.length);offset+=batch.length;
          intermediate.push(...(await merge(subset,depth+1)).map((m,n)=>({...m,id:`batch${offset}-${n}`,directIds:m.inputIds})));
        }
        if(Buffer.byteLength(JSON.stringify(project(intermediate)))>=Buffer.byteLength(JSON.stringify(projection))) throw new Error('同层批次合并未压缩，等待修复');
        return merge(intermediate,depth+1);
      }
      // A single already-short input may be reused verbatim; this does not invent a model output or delete facts.
      const output=rows.length===1 && rows[0].safePassthrough===true && rows[0].validatorVersion===TREE_VALIDATOR_VERSION
        && (rows[0].layer==='information' ? reusableInformation(rows[0]) : rows[0].effectivePromptHash===skills.hourly.version) && Array.from(rows[0].text).length<=80
        ? [{title:rows[0].title,text:rows[0].text,tagId,inputIds:[rows[0].id]}]
        : await merge(rows.map(i=>({...i,directIds:[i.id]})));
      // Flattened internal batches still belong to the original immediate previous layer.
      validateTreeModules({modules:output},rows,modelTags);
      const nodes=output.map(m=>{
        const children=stable(m.inputIds.map(id=>rows.find(i=>i.id===id)));
        const nodeVersion=materialHash({version,title:m.title,text:m.text,children:children.map(i=>i.id)});
        return repository.saveNode(s.workspaceId,{title:m.title,text:m.text,tagId:m.tagId,id:`${layer[0]}:${nodeVersion}`,version:nodeVersion,layer,
          children:children.map(i=>i.id),articleIds:[...new Set(children.flatMap(i=>i.articleIds))].sort(),window,generatedAt:now(),effectivePromptHash:skills[layer].version,validatorVersion:TREE_VALIDATOR_VERSION,safePassthrough:Array.from(m.text).length<=80});
      });
      reportRepository.saveAnalysisStage(s.workspaceId,'tree-cache',stageKey,version,{stage:layer},{ids:nodes.map(n=>n.id)},'completed');result.push(...nodes);
      } catch(error) {
        const failure={...(error.cachedPending || treeFailure(error,stageKey,'',now())),tagId};result.failures.push(failure);
        reportRepository.saveAnalysisStage(s.workspaceId,'tree-cache',stageKey,version,{stage:layer,failure,inputs:rows.map(n=>n.id)},null,'failed',String(error.message).slice(0,1200));
      }
    }
    return result;
  }
  async function edition(layer,inputs,window,s,{pendingIds=[],pending=[],missingHours=[]}={}) {
    const expectedHead=repository.head(s.workspaceId,layer,window);
    const modules=await condense(layer,inputs,window,s),failed=modules.failures.length>0;
    const status=failed ? 'failed' : pendingIds.length || missingHours.length ? 'partial' : 'ready';
    const value={layer,window,timezone,status,roots:modules.map(n=>n.id),inputIds:inputs.map(n=>n.id).sort(),pendingIds,pending,groupFailures:modules.failures,policyHash,missingHours,generatedAt:now()};
    return repository.publish(s.workspaceId,{...value,id:`edition:${materialHash({...value,generatedAt:undefined})}`},{expectedHead});
  }
  async function prepareInformation({workspaceId='local',materials,sourceIds,force=false,priority=0,totalMs}={}) {
    ensurePolicy(workspaceId);
    materials ||= await materialPort?.(workspaceId,sourceIds || []) || [];
    const s={...session(priority,totalMs),workspaceId,force},nodes=[],pending=[];
    for(const id of sourceIds || [])if(!materials.some(m=>m.id===id)) {
      const failure={id,reason:'needs-content',retryable:false,retryAt:null,sourceVersion:'unavailable'};pending.push(failure);
      reportRepository.saveAnalysisStage(workspaceId,'tree-preparation',`information:${id}`,materialHash({id,unavailable:true}),{sourceId:id,sourceVersion:'unavailable'},{pending:failure},'failed','来源未就绪或不在允许处理范围');
    }
    for(const m of stable(materials)) {
      const at=m.eventAt ?? m.publishedAt ?? now(),window={startAt:Math.floor(at/HOUR)*HOUR,endAt:(Math.floor(at/HOUR)+1)*HOUR},sourceHash=materialHash(treeSource(m)),sourceVersion=String(m.version || m.updatedAt || sourceHash);
      const stageKey=`${articleStrategy ? 'article' : 'information'}:${m.id}`;
      try {
        const node=await information(m,window,s);
        if(!repository.setInformationHead(workspaceId,node,policyHash))throw Object.assign(new Error('已过期生成策略'),{code:'stale-policy'});
        nodes.push(node);reportRepository.saveAnalysisStage(workspaceId,'tree-preparation',stageKey,sourceHash,{sourceId:m.id,sourceVersion,effectivePromptHash:skills.information.version,...(articleStrategy ? {generationVersion:generationVersion('information')} : {})},{nodeId:node.id},'completed');
      } catch(error) {
        const failure=error.cachedPending || treeFailure(error,m.id,sourceVersion,now());pending.push(failure);
        reportRepository.saveAnalysisStage(workspaceId,'tree-preparation',stageKey,sourceHash,{sourceId:m.id,sourceVersion,effectivePromptHash:skills.information.version,...(articleStrategy ? {generationVersion:generationVersion('information')} : {})},{pending:failure},'failed',failure.reason);
      }
    }
    return {nodes,pending,calls:s.calls,cacheHits:s.cacheHits || 0};
  }
  async function generateHour({workspaceId='local',hourStart,materials,coverage=[],priority=10,totalMs,prepare=false}={}) {
    if(hourStart>now())throw new Error('目标小时尚未开始；拒绝把未来零材料窗口发布成ready');
    if(hourStart+HOUR>now())throw new Error('目标小时尚未结束；请在整小时结束后生成正式刊期');
    ensurePolicy(workspaceId);
    const window={startAt:hourStart,endAt:hourStart+HOUR},s={...session(priority,totalMs),workspaceId};
    // Explicit migration/replay input may prepare; the normal Worker path never reads full materials.
    let prepared;
    if(materials)prepared=await prepareInformation({workspaceId,materials,priority,totalMs:config.informationMs ?? s.totalMs*0.6});
    else if(prepare){const frozen=await prepareDailyMaterials({feedService,mediaPort,workspaceId,time:{contentWindow:window},frozenAt:now()});coverage=frozen.coverage;prepared=await prepareInformation({workspaceId,materials:frozen.materials,priority,totalMs:s.totalMs*0.6});}
    const candidates=materials || await candidatePort?.(workspaceId,window) || [];
    const ready=repository.listInformation(workspaceId,window),nodes=[],pending=[...(prepared?.pending || [])];
    const wanted=new Map(candidates.map(m=>[m.id,String(m.version || m.updatedAt || '')]));
    for(const n of ready) {
      if((materials!==undefined || candidatePort) && !wanted.has(n.sourceId))continue;
      if(wanted.get(n.sourceId) && wanted.get(n.sourceId)!==n.sourceVersion)continue;
      if(!reusableInformation(n))continue;
      try {
        const current=await classified(n,{id:n.sourceId},s);
        if(!repository.setInformationHead(workspaceId,current,policyHash))throw Object.assign(new Error('已过期生成策略'),{code:'stale-policy'});
        nodes.push(current);
      }catch(error){pending.push(treeFailure(error,n.sourceId,n.sourceVersion,now()));}
    }
    const states=reportRepository.listTreePreparationStates?.(workspaceId,[...wanted.keys()]) || [];
    for(const [id,sourceVersion] of wanted)if(!nodes.some(n=>n.sourceId===id) && !pending.some(p=>p.id===id)) {
      const state=states.find(row=>row.input?.sourceId===id && row.input.sourceVersion===sourceVersion);
      pending.push(state?.output?.pending || {id,reason:'information-not-ready',retryable:false,retryAt:null,sourceVersion});
    }
    for(const c of coverage)if(c.omitted || c.failed)pending.push({id:`source:${c.sourceId}:incomplete`,reason:'budget-deferred',retryable:true,retryAt:now()+30*60000});
    return edition('hourly',nodes,window,s,{pendingIds:pending.map(p=>p.id),pending});
  }
  async function generateDaily({workspaceId='local',window,hours}={}) {
    ensurePolicy(workspaceId);
    hours ||= repository.list(workspaceId,Math.floor(window.startAt/HOUR)*HOUR,window.endAt,'hourly').map(r=>r.edition).filter(Boolean);
    const s={...session(),workspaceId};
    // Non-integral cutoffs reuse saved information through an explicit boundary hourly module.
    // The daily model itself continues to see hourly modules only.
    for(const at of [...new Set([Math.floor(window.startAt/HOUR)*HOUR,Math.floor((window.endAt-1)/HOUR)*HOUR])]) {
      const boundary={startAt:Math.max(at,window.startAt),endAt:Math.min(at+HOUR,window.endAt)};
      if(boundary.startAt===at && boundary.endAt===at+HOUR)continue;
      const full=hours.find(h=>h.window.startAt===at && h.window.endAt===at+HOUR && h.status==='ready');
      if(!full)continue;
      const nodes=full.roots.flatMap(id=>repository.getNode(workspaceId,id).children).map(id=>repository.getNode(workspaceId,id));
      if(nodes.some(n=>!Number.isFinite(n.eventAt)))continue;
      const subset=nodes.filter(n=>n.eventAt>=boundary.startAt && n.eventAt<boundary.endAt);
      const boundaryHour=await edition('hourly',subset,boundary,s);
      hours=[...hours.filter(h=>h.id!==full.id),boundaryHour];
    }
    const missingHours=[];
    for(let at=Math.floor(window.startAt/HOUR)*HOUR;at<window.endAt;at+=HOUR) {
      const hour=hours.find(h=>h.window.startAt===Math.max(at,window.startAt) && h.window.endAt===Math.min(at+HOUR,window.endAt));
      if(!hour || hour.status!=='ready') missingHours.push(at);
    }
    const inputs=hours.filter(h=>h.status!=='failed' && h.window.startAt>=window.startAt && h.window.endAt<=window.endAt)
      .flatMap(h=>h.roots.map(id=>repository.getNode(workspaceId,id)));
    return edition('daily',inputs,window,s,{missingHours});
  }
  return {...reader,prepareInformation,generateHour,generateDaily,policyHash,effectivePromptHashes:Object.fromEntries(Object.entries(skills).map(([stage,value])=>[stage,value.version])),async generateHourlyDigests({workspaceId='local',hourStart,mode,snapshotId}={}) {
    if(mode==='rewrite' || snapshotId)throw new Error('历史稿重编请使用legacy；浓缩树不把旧事实底稿当作单篇信息');
    const latest=Math.floor(now()/HOUR)*HOUR-HOUR;
    if(hourStart!==undefined) return [await generateHour({workspaceId,hourStart,priority:hourStart===latest ? 10 : -10,
      ...(hourStart!==latest ? {totalMs:8*60000} : {})})];
    const result=[await generateHour({workspaceId,hourStart:latest})];
    // Reuse original latest-first scheduling; one older window per run, no replacement scheduler.
    const prior=repository.list(workspaceId,latest-23*HOUR,latest,'hourly');
    const target=Array.from({length:23},(_,i)=>latest-(i+1)*HOUR).find(at=>{
      const row=prior.find(r=>r.attempt?.window.startAt===at),attempt=row?.attempt;
      if(!attempt)return true;
      if((attempt.groupFailures || []).some(p=>p.retryable && p.retryAt<=now()))return true;
      if((attempt.pending || []).some(p=>p.retryable && p.retryAt<=now() && repository.informationHead(workspaceId,p.id)))return true;
      return repository.listInformation(workspaceId,{startAt:at,endAt:at+HOUR}).some(n=>!attempt.inputIds.includes(n.id));
    });
    if(target!==undefined) result.push(await generateHour({workspaceId,hourStart:target,priority:-10,totalMs:8*60000}));
    else if(prior.every(r=>r.edition?.status==='ready')) {
      const at=latest-(Math.floor(now()/HOUR)%23+1)*HOUR;
      result.push(await generateHour({workspaceId,hourStart:at,priority:-10,totalMs:8*60000}));
    }
    return result;
  }};
}
