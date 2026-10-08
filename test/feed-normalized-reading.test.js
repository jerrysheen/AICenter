import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createStore} from '../packages/database/src/index.js';
import {createFeedService} from '../packages/domain/src/feed-service.js';
import {createInformationTreeReader} from '../packages/domain/src/information-tree-service.js';

const node={id:'i:normalized',layer:'information',sourceId:'feed:a',sourceVersion:'100',formatVersion:'article-normalize-v1',title:'学生五折优惠',text:'学生认证后可享优惠，限部分市场。',body:'学生认证后可享五折优惠。\n\n仅限部分市场，详情见应用。',generatedAt:120};
const reader=(value=node)=>createInformationTreeReader({pipeline:'tree-v3',repository:{informationHead(workspace,id){return workspace==='local' && id==='feed:a' ? {node:value,sourceVersion:'100'} : null;}}});

test('normalized reading requires matching workspace, source revision and validated article body',()=>{
  const port=reader();assert.equal(port.normalizedArticle('local','feed:a',100).body,node.body);
  assert.equal(port.normalizedArticle('other','feed:a',100),null);
  assert.equal(port.normalizedArticle('local','feed:a',101),null);
  assert.equal(port.normalizedArticle('local','feed:b',100),null);
  assert.equal(reader({...node,body:''}).normalizedArticle('local','feed:a',100),null);
  assert.equal(reader({...node,sourceVersion:'99'}).normalizedArticle('local','feed:a',100),null);
  assert.equal(reader({...node,formatVersion:undefined}).normalizedArticle('local','feed:a',100),null);
});

test('home feed and contextual reading reuse one normalized article without AI or translation writes',async()=>{
  let revision=100;const item={id:'a',workspaceId:'local',provider:'x',externalId:'1',title:'CapCut for students is here',body:'Verified students get 50% off. Select markets only.',summary:'English summary',updatedAt:100};
  const fail=()=>{throw new Error('read must not call AI, provider or persist a translation');};
  const repo={listContentItemsByProvider:()=>[item],getContentItem:(workspace,id)=>workspace==='local'&&id==='a'?{...item,updatedAt:revision}:null,listTranslations:()=>[],saveTranslations:fail};
  const service=createFeedService({legacyRepository:{},feedRepository:repo,sourcePort:{findByProvider:()=>({id:'content.x.home'}),persistence:()=>({providerId:'x',sourceAccount:{externalId:'home'}}),read:fail},translationPort:{translate:fail,translateMany:fail},normalizedArticlePort:reader()});
  const feed=await service.getExternalFeed('x',{feed:'for-you'});const post=feed.items[0];
  assert.equal(post.normalizedArticle.body,node.body);assert.equal(post.body,item.body);assert.equal(post.translation,null);
  assert.equal(service.getLocalizedContentItem('local','a').normalizedArticle.title,node.title);
  assert.equal(service.getLocalizedContentItem('other','a'),null);
  service.persistItemTranslations([{id:'a',sourceText:item.body,translatedText:node.body,engine:''}]);
  revision=101;const pending=(await service.getExternalFeed('x',{feed:'for-you'})).items[0];assert.equal(pending.normalizedArticle,null);assert.equal(pending.processing,'ai');
});

test('home card and reader preserve normalized content without uploading it as a full translation',async()=>{
  const js=readFileSync('apps/web/public/app.js','utf8');
  const functions=['feedAsItem','translationFor','postDisplayTitle','postListExcerpt','postViewBody'].map(name=>{const result=js.match(new RegExp('function '+name+'\\([^]*?\\n\\}'));assert.ok(result,name);return result[0];}).join('\n');
  const context=vm.createContext({Date,state:{translations:{'x:1':{text:'stale cached text'}}},formatTime:()=>'',postTagNames:()=>[],clipFeedText:value=>value,FEED_EXCERPT_MAX:200});
  vm.runInContext(functions+'\nthis.mapPost=feedAsItem;this.title=postDisplayTitle;this.excerpt=postListExcerpt;this.body=postViewBody;this.translation=translationFor;',context);
  const post=context.mapPost({id:'x:1',resourceId:'a',title:'English',body:'Original English',normalizedArticle:reader().normalizedArticle('local','feed:a',100)},'x');
  assert.equal(context.title(post),node.title);assert.equal(context.excerpt(post),node.text);assert.equal(context.body(post),node.body);assert.equal(context.translation(post).kind,'normalized');assert.equal(post.body,'Original English');
  const sync=js.match(/async function syncLocalTranslationsToServer\(items\) \{[\s\S]*?\n\}/)[0];
  let writes=0;context.state.session={};context.xAsItem=item=>context.mapPost(item,'x');context.api=async()=>{writes++;};vm.runInContext(sync+'\nthis.sync=syncLocalTranslationsToServer;',context);
  await context.sync([post]);assert.equal(writes,0);
});


test('repair removes only the exact translation revision and retains other workspaces',()=>{
  const store=createStore(':memory:');try{
    const repo=store.repositories.feed,input={workspaceId:'local',itemId:'x:test',targetLang:'zh',sourceHash:'source-hash',translatedText:'中文整理',engine:''};
    repo.saveTranslations([input]);const row=repo.listTranslations('local',['x:test'])[0];
    assert.equal(repo.removeTranslationIfUnchanged(input,row.updatedAt+1),false);
    assert.equal(repo.removeTranslationIfUnchanged({...input,translatedText:'其他内容'},row.updatedAt),false);
    assert.equal(repo.removeTranslationIfUnchanged({...input,workspaceId:'other'},row.updatedAt),false);
    assert.equal(repo.listTranslations('local',['x:test']).length,1);
    assert.equal(repo.removeTranslationIfUnchanged(input,row.updatedAt),true);
    assert.equal(repo.listTranslations('local',['x:test']).length,0);
    assert.equal(repo.removeTranslationIfUnchanged(input,row.updatedAt),false);
  }finally{store.close();}
});
