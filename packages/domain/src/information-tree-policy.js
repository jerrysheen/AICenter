import {materialHash} from './daily-materials.js';

export function treeCatalog(catalog) {
  const tags=catalog.tags.map(t=>({id:t.id,name:t.name,parent_id:t.parent_id || null,description:t.description || `${t.name}：${(t.keywords || []).join('、')}`}));
  const ids=new Set(tags.map(t=>t.id)),mapping=catalog.reading?.groupByTag || {};
  for(const [key,value] of Object.entries(mapping))if(!ids.has(key) || !ids.has(value))throw new Error('阅读分类映射包含未知Tag');
  for(const value of Object.values(mapping))if(mapping[value] && mapping[value]!==value)throw new Error('阅读分类映射须在小时与日报保持同一层级');
  const migration=catalog.reading?.reclassification;
  return {tags,ids,classificationVersion:materialHash(tags),groupVersion:materialHash({version:catalog.reading?.version || 'unmapped',mapping}),group:id=>ids.has(id) ? mapping[id] || id : null,
    needsReclassification:node=>!migration || node.catalogVersion!==migration.fromVersion || migration.keywords.some(word=>`${node.title}\n${node.text}`.toLowerCase().includes(word.toLowerCase()))};
}

export function treeFailure(error,id,sourceVersion='',at=Date.now()) {
  let reason=error.code;
  if(!reason)reason=error.name==='ModelQueueTimeout' ? 'queue-timeout' : error.name==='ModelExecutionTimeout' ? 'execution-timeout' : error.name==='StageBudgetTimeout' ? 'budget-deferred' : error.name==='ZodError' || error instanceof SyntaxError ? 'invalid-output' : 'retryable-model-error';
  if(!['needs-content','retryable-model-error','queue-timeout','execution-timeout','budget-deferred','lease-conflict','invalid-output','information-not-ready','stale-policy'].includes(reason))reason='retryable-model-error';
  const retryable=!['needs-content','information-not-ready','stale-policy'].includes(reason);
  return {id,reason,retryable,retryAt:retryable ? Number.isFinite(error.retryAt) ? Math.max(at+1000,error.retryAt) : at+30*60000 : null,sourceVersion,...(error.timing ? {queueMs:error.timing.queueMs,executionMs:error.timing.executionMs} : {})};
}

export function treeSource(m) {
  const paragraphs=(m.paragraphs || []).filter(p=>p.text?.trim() && !['metadata','comment'].includes(p.role));
  return {id:m.id,title:m.title,author:m.author || '',publisher:m.publisher || '',publishedAt:m.publishedAt ?? null,
    inputScope:m.contentLevel==='full' && paragraphs.some(p=>p.role==='body') ? 'full' : 'excerpt',
    sourceRoles:{author:m.author || '',excludedThirdPartyComments:(m.paragraphs || []).filter(p=>p.role==='comment').length},paragraphs:paragraphs.map(p=>({role:p.role,text:p.text}))};
}
