import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../packages/database/src/index.js';
import {createInformationTreeService} from '../packages/domain/src/information-tree-service.js';
import {ArticleResponseSchema,TreeNodeSchema,projectTreeInput} from '../packages/contracts/src/information-tree.js';
import {loadArticleNormalizeSkills,loadInformationTreeSkills} from '../packages/runtime/src/information-tree/skills.js';
import {createMediaEnrichJobHandlers} from '../packages/runtime/src/media-enrich-module.js';
import {createFeedAutomationJobHandlers} from '../packages/runtime/src/feed-automation-module.js';
import {resolveHarnessLlm} from '../packages/harness/src/llm-route.js';
const source=(text='原始正文',extra={})=>({id:'feed:a',title:'标题',publishedAt:3600001,version:'1',contentLevel:'full',paragraphs:[{role:'body',text}],sourceRefs:[],...extra});
const output={title:'中文标题',tagId:null,summary:'简要摘要',body:'第一段完整信息。\n\n第二段必要条件。'};
function fixture(run=()=>output,extra={}){const store=createStore(':memory:'),calls=[];const service=createInformationTreeService({repository:store.repositories.informationTree,reportRepository:store.repositories.report,skills:loadArticleNormalizeSkills(),articleStrategy:true,agentRuntime:{async run(input){calls.push(input);const result=await run(input,calls.length);return {answer:typeof result==='string' ? result : JSON.stringify(result)};}},...extra});return {store,calls,service};}
test('article contract, paragraphs, persisted read and summary-only list/projection',async()=>{const f=fixture();try{const r=await f.service.prepareInformation({materials:[source()]});assert.equal(r.nodes.length,1);const n=f.store.repositories.informationTree.getNode('local',r.nodes[0].id);assert.equal(n.body,output.body);assert.equal(n.text,output.summary);assert.equal(n.summary,undefined);assert.equal(n.formatVersion,'article-normalize-v1');assert.equal(f.service.node('local',n.id).body,output.body);assert.equal(f.service.list('local',{startAt:0,endAt:7200000}).information[0].body,undefined);assert.deepEqual(Object.keys(projectTreeInput(n)),['id','title','text','tagId']);assert.equal(f.calls[0].closedTask,'article-normalize');assert.equal(ArticleResponseSchema.safeParse({...output,body:''}).success,false);assert.equal(TreeNodeSchema.safeParse({...n,body:undefined}).success,false);}finally{f.store.close();}});
test('unchanged/read timestamp changes hit cache; local revision alone calls once',async()=>{const f=fixture();try{await f.service.prepareInformation({materials:[source()]});await f.service.prepareInformation({materials:[source('原始正文',{updatedAt:99,version:'2',readAt:100})]});assert.equal(f.calls.length,1);await f.service.prepareInformation({materials:[source('新增必要条件',{version:'3'})]});assert.equal(f.calls.length,2);}finally{f.store.close();}});
test('needs content negative cache, null and unknown tag are independent',async()=>{const f=fixture(()=>({status:'needs_content'}));try{await f.service.prepareInformation({materials:[source()]});await f.service.prepareInformation({materials:[source()]});assert.equal(f.calls.length,1);}finally{f.store.close();}const good=fixture(()=>({...output,tagId:'missing'}));try{const r=await good.service.prepareInformation({materials:[source()]});assert.equal(r.nodes[0].tagId,null);assert.equal(good.calls.length,1);}finally{good.store.close();}});
test('missing body repairs only absent field, keeps valid summary/title; interrupted JSON never retries',async()=>{const f=fixture((input,n)=>{if(n===1)return {title:'已成功标题',tagId:null,summary:'已成功摘要'};const p=JSON.parse(input.message);assert.deepEqual(p.missing,['body']);assert.equal(p.completed.summary,'已成功摘要');return {body:'恢复正文。\n\n保留段落。'};});try{const r=await f.service.prepareInformation({materials:[source()]});assert.equal(r.nodes[0].title,'已成功标题');assert.equal(r.nodes[0].text,'已成功摘要');assert.equal(f.calls.length,2);}finally{f.store.close();}const cut=fixture(()=>'{"title":"截断');try{const r=await cut.service.prepareInformation({materials:[source()]});assert.equal(r.nodes.length,0);assert.equal(cut.calls.length,1);assert.equal(r.pending[0].reason,'invalid-output');}finally{cut.store.close();}});
test('transport failure is not format repair, overbudget source is not truncated',async()=>{const f=fixture(()=>{throw new Error('transport');});try{await f.service.prepareInformation({materials:[source()]});assert.equal(f.calls.length,1);}finally{f.store.close();}const big=fixture(()=>output,{budget:{articleRequestBytes:2000}});try{const r=await big.service.prepareInformation({materials:[source('正文'.repeat(2000))]});assert.equal(big.calls.length,0);assert.equal(r.pending[0].reason,'budget-deferred');}finally{big.store.close();}});
test('concurrent duplicate admits one request and legacy text is not complete article cache',async()=>{let release;const gate=new Promise(r=>release=r),f=fixture(async()=>{await gate;return output;});try{const a=f.service.prepareInformation({materials:[source()]});await new Promise(r=>setTimeout(r,5));const b=await f.service.prepareInformation({materials:[source()]});assert.equal(b.pending[0].reason,'lease-conflict');release();await a;assert.equal(f.calls.length,1);}finally{f.store.close();}const old=fixture(()=>({title:'旧短稿',text:'旧摘要',tagId:null}));try{const legacy=createInformationTreeService({repository:old.store.repositories.informationTree,reportRepository:old.store.repositories.report,skills:loadInformationTreeSkills(),agentRuntime:{run:async()=>({answer:'{"title":"旧短稿","text":"旧摘要","tagId":null}'})}});const before=await legacy.prepareInformation({materials:[source()]});assert.equal(before.nodes[0].body,undefined);const newService=createInformationTreeService({repository:old.store.repositories.informationTree,reportRepository:old.store.repositories.report,skills:loadArticleNormalizeSkills(),articleStrategy:true,agentRuntime:{run:async()=>({answer:JSON.stringify(output)})}});const after=await newService.prepareInformation({materials:[source()]});assert.equal(after.nodes[0].body,output.body);assert.notEqual(before.nodes[0].id,after.nodes[0].id);}finally{old.store.close();}});
test('normalize branch queues title and summary for link items', async () => {
  const queued = [];
  const port = { prepareInformation: async () => ({ nodes: [], pending: [], calls: 0 }) };
  const store = { createJob(input) { queued.push(input); return { id: `job-${queued.length}` }; }, listOpenJobs() { return []; } };
  const linkText = 'Guardian headline\n\nA short English summary of the discovered link.';
  const media = {
    fetchBodies: async () => ({ fetched: [], stats: {} }),
    listBodyCandidates: () => [],
    listEnrichmentItems: () => [
      { externalId: 'bbc:full', resourceId: 'media:bbc:full', contentLevel: 'full', text: 'Full English body that must stay on the article units.' },
      { externalId: 'guardian:link', resourceId: 'media:guardian:link', contentLevel: 'discovery', text: linkText },
    ],
    listArticleTranslationUnits: () => [
      { id: 'block-title', localizationId: 'block-title', paragraphId: 'title', kind: 'heading', text: 'BBC English headline about energy prices today' },
      { id: 'block-body', localizationId: 'block-body', paragraphId: 'p1', kind: 'paragraph', text: 'A longer English paragraph about energy prices that should wait behind the title.' },
    ],
  };
  const feedService = { async localizeTexts(units) { return { pendingIds: units.map((unit) => unit.id), localizations: {} }; } };
  const handlers = createMediaEnrichJobHandlers({ mediaService: media, feedService, articleNormalizePort: port, treeEnabled: true });
  await handlers['media.index.enrich']({}, { store });
  const byPriority = new Map(queued.map((job) => [job.priority, job.input.items.map((item) => item.text)]));
  assert.deepEqual(byPriority.get(10).sort(), ['BBC English headline about energy prices today', linkText].sort());
  assert.deepEqual(byPriority.get(-10), ['A longer English paragraph about energy prices that should wait behind the title.']);
});
test('media/feed injected strategy avoids translation, tag, brief, enqueue and old dependencies',async()=>{const calls=[],fail=()=>{throw new Error('old path invoked');},port={prepareInformation:async p=>{calls.push(p);return {nodes:[],pending:[],calls:1};}},store={createJob:fail};const media={fetchBodies:async()=>({fetched:[],stats:{}}),listBodyCandidates:()=>['a'],listEnrichmentItems:()=>[{externalId:'a',resourceId:'media:a'}],generateBodyBriefs:fail,listArticleTranslationUnits:fail};const mh=createMediaEnrichJobHandlers({mediaService:media,treeEnabled:true,articleNormalizePort:port});await mh['media.index.enrich']({externalIds:['a']},{store});const fh=createFeedAutomationJobHandlers({feedService:{refreshPersistedSource:fail},feedRepository:{claimDueSubscriptions:fail},treeEnabled:true,articleNormalizePort:port});await fh['feed.items.enrich']({resourceIds:['a']},{store});assert.deepEqual(calls.map(p=>p.sourceIds),[['media:a'],['feed:a']]);});
test('article route uses independent real settings, low supported effort and no supplier retries',()=>{const env={AI_CENTER_HARNESS_PROVIDER:'deepseek-official',AI_CENTER_HARNESS_MODEL:'deepseek-v4-flash'};const article=resolveHarnessLlm(env,{closedTask:'article-normalize'}),hour=resolveHarnessLlm(env,{closedTask:'hourly-brief'});assert.notEqual(article.model,'deepseek-v4-flash');assert.equal(article.execution.maxTokens,6144);assert.match(article.settingsYaml,/maxTokens: 6144/);assert.match(article.settingsYaml,/maxRetries: 0/);assert.match(article.settingsYaml,/low: low/);assert.match(hour.settingsYaml,/maxTokens: 8192/);assert.notEqual(loadArticleNormalizeSkills().information.version,loadInformationTreeSkills().information.version);});
test('hourly model receives only summary projection and returns original module shape',async()=>{const f=fixture(input=>{if(input.usageStage==='tree-information')return {...output,summary:'摘要信息。'.repeat(25),body:'BODY_SHOULD_NEVER_REACH_HOUR'};const p=JSON.parse(input.message);assert.equal(input.message.includes('BODY_SHOULD_NEVER_REACH_HOUR'),false);assert.equal(input.message.includes('ENGLISH_ORIGINAL_MARKER'),false);assert.deepEqual(Object.keys(p.inputs[0]),['id','title','text','tagId']);return {modules:[{title:'小时标题',text:'小时短文',tagId:null,inputIds:p.inputs.map(n=>n.id)}]};});try{const m=source('ENGLISH_ORIGINAL_MARKER');await f.service.prepareInformation({materials:[m]});const r=await f.service.generateHour({hourStart:3600000,materials:undefined});const n=f.store.repositories.informationTree.getNode('local',r.roots[0]);assert.equal(n.body,undefined);assert.equal(n.children.length,1);assert.equal(f.calls.filter(c=>c.usageStage==='tree-hourly').length,1);}finally{f.store.close();}});
test('headline rule is loaded and the previous article prompt stays reusable',async()=>{
  const skills=loadArticleNormalizeSkills();
  assert.match(skills.information.instruction,/单独读完就能知道具体对象/);
  assert.match(skills.information.instruction,/不能把验证通过写成已量产/);
  assert.equal(skills.information.compatiblePromptHashes.includes('3829fba8ad65961b3f30050ea24a3c27f4db2bfd81fb70894e0840ffadd740c2'),true);
  assert.match(loadInformationTreeSkills().hourly.instruction,/小时 Skill/);
  const f=fixture();
  try{
    const first=await f.service.prepareInformation({materials:[source()]});
    const nextSkills={...skills,information:{...skills.information,version:'headline-fidelity-next',compatiblePromptHashes:[skills.information.version]}};
    const service=createInformationTreeService({repository:f.store.repositories.informationTree,reportRepository:f.store.repositories.report,skills:nextSkills,articleStrategy:true,agentRuntime:{run(){throw new Error('must not rewrite');}}});
    const again=await service.prepareInformation({materials:[source()]});
    assert.equal(again.cacheHits,1);
    assert.equal(again.nodes[0].title,first.nodes[0].title);
    assert.equal(again.nodes[0].body,first.nodes[0].body);
  }finally{f.store.close();}
});
test('article display catalog revision does not reclassify or rewrite original body',async()=>{const f=fixture(()=>({...output,tagId:'ai'}),{catalog:{tags:[{id:'ai',name:'AI'}]}});try{const first=await f.service.prepareInformation({materials:[source()]});const service=createInformationTreeService({repository:f.store.repositories.informationTree,reportRepository:f.store.repositories.report,skills:loadArticleNormalizeSkills(),articleStrategy:true,catalog:{tags:[{id:'ai',name:'人工智能',description:'新显示说明'}]},agentRuntime:{run(){throw new Error('must not request classification');}}});const r=await service.prepareInformation({materials:[source()]});assert.equal(r.nodes[0].body,first.nodes[0].body);assert.equal(r.calls,0);}finally{f.store.close();}});


test('expanded pool admission can retry stale local budget pending without invalidating successful article cache',async()=>{
 let ready=false;
 const f=fixture((input,n)=>{if(n===1)throw Object.assign(new Error('old budget'),{code:'budget-deferred',retryAt:Date.now()+3600000});return output;},{budgetReady:()=>ready});
 try {
  const first=await f.service.prepareInformation({materials:[source()]});assert.equal(first.pending[0].reason,'budget-deferred');
  const waiting=await f.service.prepareInformation({materials:[source()]});assert.equal(waiting.calls,0);
  ready=true;const resumed=await f.service.prepareInformation({materials:[source()]});assert.equal(resumed.nodes.length,1);
  const cached=await f.service.prepareInformation({materials:[source()]});assert.equal(cached.calls,0);assert.equal(f.calls.length,2);
 }finally{f.store.close();}
});

test('article normalize still tags short posts before queueing preparation', async () => {
  const order = [];
  const port = { prepareInformation: async (payload) => { order.push('prepare'); return { queued: payload.sourceIds.length }; } };
  const handlers = createFeedAutomationJobHandlers({
    feedService: {
      refreshPersistedSource: async () => { throw new Error('not used'); },
      listTaggableItems: () => [{ id: 'a', title: '短帖', summary: '', body: '正文' }],
    },
    feedRepository: { claimDueSubscriptions() { return []; } },
    taggingService: {
      async analyzeItems(input) {
        order.push('tag');
        assert.equal(input.resourceType, 'content-item');
        assert.deepEqual(input.items.map((item) => item.id), ['a']);
        return { saved: [{ resourceId: 'a', tags: ['ai'] }], skipped: 0, missingItemIds: [] };
      },
    },
    articleNormalizePort: port,
    treeEnabled: true,
  });
  const result = await handlers['feed.items.enrich']({ workspaceId: 'local', resourceIds: ['a'] }, { store: {} });
  assert.deepEqual(order, ['tag', 'prepare']);
  assert.equal(result.tagged, 1);
  assert.equal(result.queued, 1);
});

test('Gemma tagging failure still queues information preparation', async () => {
  const order = [];
  const logs = [];
  const rows = [
    { id: 'a', title: '短帖', summary: '', body: '正文' },
    { id: 'b', title: '另一条', summary: '', body: '更多' },
  ];
  const handlers = createFeedAutomationJobHandlers({
    log: (line) => logs.push(line),
    feedService: {
      refreshPersistedSource: async () => { throw new Error('not used'); },
      listTaggableItems: () => rows,
    },
    feedRepository: { claimDueSubscriptions() { return []; } },
    taggingService: {
      async analyzeItems() {
        order.push('tag');
        throw Object.assign(new Error('Gemma 翻译等待配额窗口'), { code: 'budget-deferred' });
      },
    },
    articleNormalizePort: {
      prepareInformation: async (payload) => {
        order.push('prepare');
        return { queued: payload.sourceIds.length };
      },
    },
    treeEnabled: true,
  });
  const result = await handlers['feed.items.enrich']({ workspaceId: 'local', resourceIds: ['a', 'b'] }, { store: {} });
  assert.deepEqual(order, ['tag', 'prepare']);
  assert.equal(result.tagged, 0);
  assert.equal(result.taggingFailed, 2);
  assert.equal(result.taggingError, 'budget-deferred');
  assert.equal(result.queued, 2);
  assert.match(logs.join('\n'), /count=2 category=budget-deferred/);
  assert.doesNotMatch(logs.join('\n'), /配额窗口|正文/);
});

test('incomplete tags and upstream failures do not block preparation; the legacy path still requires every tag', async () => {
  const order = [];
  async function articleHandlers(analyzeItems) {
    return createFeedAutomationJobHandlers({
      log() {},
      feedService: {
        refreshPersistedSource: async () => { throw new Error('not used'); },
        listTaggableItems: () => [{ id: 'a', title: '短帖', summary: '', body: '正文' }],
      },
      feedRepository: { claimDueSubscriptions() { return []; } },
      taggingService: { analyzeItems },
      articleNormalizePort: {
        prepareInformation: async (payload) => {
          order.push('prepare');
          return { queued: payload.sourceIds.length };
        },
      },
    });
  }
  const missing = await articleHandlers(async () => {
    order.push('tag');
    return { saved: [], skipped: 0, missingItemIds: ['a'] };
  });
  const incomplete = await missing['feed.items.enrich']({ workspaceId: 'local', resourceIds: ['a'] }, { store: {} });
  assert.equal(incomplete.tagged, 0);
  assert.equal(incomplete.taggingFailed, 1);
  assert.equal(incomplete.taggingError, 'incomplete');
  assert.equal(incomplete.queued, 1);
  const upstream = await articleHandlers(async () => {
    order.push('tag');
    throw Object.assign(new Error('Gemma 翻译失败（500）'), { upstreamStatus: 500 });
  });
  const failed = await upstream['feed.items.enrich']({ workspaceId: 'local', resourceIds: ['a'] }, { store: {} });
  assert.equal(failed.tagged, 0);
  assert.equal(failed.taggingError, 'upstream');
  assert.equal(failed.queued, 1);
  assert.deepEqual(order, ['tag', 'prepare', 'tag', 'prepare']);
  const legacy = createFeedAutomationJobHandlers({
    feedService: {
      refreshPersistedSource: async () => {},
      localizeContentItems: async () => ({ pendingIds: [], translated: 0 }),
      listTaggableItems: () => [{ id: 'a', body: '正文' }],
    },
    feedRepository: { claimDueSubscriptions() { return []; } },
    taggingService: {
      async analyzeItems() {
        return { saved: [], skipped: 0, missingItemIds: ['a'] };
      },
    },
  });
  await assert.rejects(
    legacy['feed.items.enrich']({ workspaceId: 'local', resourceIds: ['a'] }, { store: {} }),
    /没有完成打标/,
  );
});

test('saved Gemma tags replace the article model tag on the information node', async () => {
  const f = fixture(() => ({ ...output, tagId: 'macro' }), {
    catalog: { tags: [{ id: 'ai', name: '人工智能' }, { id: 'macro', name: '宏观' }] },
    tagHints: () => ['ai', 'macro'],
  });
  try {
    const result = await f.service.prepareInformation({ materials: [source()] });
    assert.equal(result.nodes[0].tagId, 'ai');
    assert.equal(f.calls[0].closedTask, 'article-normalize');
  } finally {
    f.store.close();
  }
});

test('prepare writes Gemma tag hints onto a null tagId and does not invent one', async () => {
  const catalog = { tags: [{ id: 'ai', name: '人工智能' }, { id: 'macro', name: '宏观' }] };
  let hints = ['not-a-tag', 'ai', 'macro'];
  const f = fixture(() => ({ ...output, tagId: 'macro' }), { catalog, tagHints: () => hints });
  try {
    const created = await f.service.prepareInformation({ materials: [source()] });
    assert.equal(created.nodes[0].tagId, 'ai');
    assert.ok(['ai', 'macro'].includes(created.nodes[0].tagId));
    hints = ['macro', 'ai'];
    const kept = await f.service.prepareInformation({ materials: [source()] });
    assert.equal(f.calls.length, 1);
    assert.equal(kept.nodes[0].tagId, 'ai');
    assert.equal(kept.nodes[0].body, created.nodes[0].body);
    hints = [];
    const empty = await f.service.prepareInformation({ materials: [source()] });
    assert.equal(empty.nodes[0].tagId, 'ai');
    assert.equal(f.calls.length, 1);
  } finally {
    f.store.close();
  }

  let missing;
  const backfill = fixture(() => ({ ...output, tagId: null }), { catalog, tagHints: () => missing });
  try {
    const bare = await backfill.service.prepareInformation({ materials: [source()] });
    assert.equal(bare.nodes[0].tagId, null);
    missing = ['nope'];
    const unknown = await backfill.service.prepareInformation({ materials: [source()] });
    assert.equal(unknown.nodes[0].tagId, null);
    assert.equal(backfill.calls.length, 1);
    missing = ['macro', 'ai'];
    const filled = await backfill.service.prepareInformation({ materials: [source()] });
    assert.equal(filled.nodes[0].tagId, 'macro');
    assert.equal(backfill.calls.length, 1);
    assert.equal(filled.nodes[0].body, bare.nodes[0].body);
  } finally {
    backfill.store.close();
  }

  const locked = fixture(() => ({ ...output, tagId: null }), {
    catalog,
    tagHints: () => ['ai'],
    primaryTag: () => ({ locked: true, tagId: 'macro' }),
  });
  try {
    const row = await locked.service.prepareInformation({ materials: [source()] });
    assert.equal(row.nodes[0].tagId, 'macro');
    assert.equal(row.nodes[0].classification.source, 'manual-lock');
  } finally {
    locked.store.close();
  }

  const invalidLock = fixture(() => ({ ...output, tagId: null }), {
    catalog,
    tagHints: () => ['ai'],
    primaryTag: () => ({ locked: true, tagId: 'missing' }),
  });
  try {
    const row = await invalidLock.service.prepareInformation({ materials: [source()] });
    assert.equal(row.nodes[0].tagId, null);
  } finally {
    invalidLock.store.close();
  }
});
