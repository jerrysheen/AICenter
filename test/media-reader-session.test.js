import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createMediaReaderSession,mediaIndexBody,mediaReaderParagraphs} from '../apps/web/public/media-feed.js';

const scope={scope:'desktop:local',id:'one'};
function article(hash='a',status='ready') {
  return {id:'one',bodyHash:hash,snapshotRevision:1,title:'English title',paragraphs:[{id:'p0001',kind:'paragraph',text:`English ${hash}`}],
    articleTranslation:{bodyHash:hash,status,paragraphs:[{id:'p0001',kind:'paragraph',text:`中文 ${hash}`} ]}};
}
test('reading Chinese survives ready → partial → missing translation and removal from the feed',()=>{
  const reader=createMediaReaderSession(),initial=article();reader.resolve(initial,scope);
  for(const changed of [{...initial,articleTranslation:{...initial.articleTranslation,status:'partial'}},{...initial,articleTranslation:null},null]) {
    const result=reader.resolve(changed,scope);
    assert.equal(mediaReaderParagraphs(result.post,'translation')[0].text,'中文 a');
    assert.equal(result.post.paragraphs[0].text,'English a');
  }
});
test('new body cannot replace a reading version until its translation is ready and the reader accepts it',()=>{
  const reader=createMediaReaderSession();reader.resolve(article(),scope);
  let result=reader.resolve(article('b','partial'),scope);
  assert.equal(result.post.bodyHash,'a');assert.equal(result.canUpdate,false);
  reader.acceptUpdate();assert.equal(reader.resolve(null,scope).post.bodyHash,'a');
  result=reader.resolve(article('b'),scope);assert.equal(result.canUpdate,true);assert.equal(result.post.bodyHash,'a');
  reader.acceptUpdate();assert.equal(reader.resolve(null,scope).post.bodyHash,'b');
});
test('incomplete or mismatched Chinese shows progress; original requires an explicit language selection',()=>{
  const post=article('b','partial');post.paragraphs.push({id:'p0002',kind:'quote',text:'English tail'});
  assert.deepEqual(mediaReaderParagraphs(post,'translation').map(p=>p.text),['中文 b','此段正在翻译…']);
  post.articleTranslation.bodyHash='old';assert.equal(mediaReaderParagraphs(post,'compare')[0].text,'此段正在翻译…');
  assert.equal(mediaReaderParagraphs(post,'original')[0].text,'English b');
  assert.deepEqual(mediaReaderParagraphs({paragraphs:[]},'translation'),[]);
});
test('article switch, logout and a different device discard the previous reading snapshot',()=>{
  for(const next of [{...scope,id:'two'},{...scope,scope:''},{...scope,scope:'device:other'}]) {
    const reader=createMediaReaderSession();reader.resolve(article(),scope);
    assert.equal(reader.resolve(null,next).post,null);
  }
});
test('a saved article without paragraphs shows its text instead of a translation notice',()=>{
  const post={platform:'media',complete:true,body:'Samsung expects a nine-fold surge in quarterly profit.',paragraphs:[]};
  assert.equal(mediaIndexBody(post,'translation',''),post.body);
  assert.equal(mediaIndexBody(post,'original',''),post.body);
  assert.equal(mediaIndexBody(post,'translation','三星预计利润大增。'),'三星预计利润大增。');
  assert.equal(mediaIndexBody({...post,body:''},'compare',''),'');
  const code=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  assert.equal(code.includes('中文翻译尚未就绪'),false);
  assert.match(code,/post\?\.platform === 'media' && !post\.paragraphs\?\.length && itemId\.startsWith\('media:'\)/);
});
test('the real media projection preserves the version used to validate Chinese',()=>{
  const code=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  const context={formatTime:()=>'',Boolean,Array};vm.createContext(context);
  vm.runInContext(code.slice(code.indexOf('function mediaAsItem('),code.indexOf('\nfunction renderMediaToolbar(')),context);
  const raw=article(),post=context.mediaAsItem({...raw,externalId:'one',contentLevel:'full'});
  assert.equal(post.bodyHash,'a');assert.equal(post.snapshotRevision,1);
  assert.equal(mediaReaderParagraphs(post,'translation')[0].text,'中文 a');
  assert.equal(post.complete,true);
});
