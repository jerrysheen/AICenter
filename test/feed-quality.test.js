import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStore } from '../packages/database/src/index.js';
import { readFeedQualityWindow } from '../packages/database/src/repositories/feed-quality-audit-repository.js';
import { buildFeedQualityQuestions, createFeedQualityEvaluator, decideFeedQuality,
  normalizeFeedQualityText, parseFeedQualityAnswers } from '../packages/domain/src/feed-quality.js';

const input = { body:'三星 NAND 报价上调 10%' };
const good = { reading_value:.9, advertising:.1, specific_content:.95,
  sufficient_information:.9, topic_relevance:.95, missing_context:.05 };
const answers = scores => Object.fromEntries(Object.entries(scores).map(([key,noul])=>[key,{type:'noul',noul}]));

test('V2 preserves complete long originals and separates comments from main-body quality', async()=>{
  const raw = '方法步骤：'.repeat(2000)+'\n评论\n· 作者：购买课程\n\n[未抓取] 图片 ×3';
  const normalized=normalizeFeedQualityText(raw);
  assert.equal(normalized.body,'方法步骤：'.repeat(2000));
  assert.equal(normalized.comments,'· 作者：购买课程');
  assert.equal(normalized.unavailableMedia.length,1);
  const commentOnly=normalizeFeedQualityText('评论\n· 用户：不错\n[未抓取] 图片');
  assert.equal(commentOnly.body,'');
  assert.equal(commentOnly.bodyMissing,true);
  const calls=[];
  const evaluator=createFeedQualityEvaluator({readingScope:[{name:'软件'}],model:'fixed',client:{
    async evaluate(payload){calls.push(payload);return {model:'fixed',answers:answers(good)};} }});
  const result=await evaluator.evaluate(normalized);
  assert.equal(calls.length,1);
  assert.equal(Object.keys(calls[0].questions).length,6);
  assert.equal(calls[0].state.body,normalized.body);
  assert.equal(Object.hasOwn(calls[0].state,'comments'),false);
  assert.equal(result.decisions.balanced.decision,'KEEP');
});

test('V2 decision boundaries protect useful short news, tutorials and informative launches',()=>{
  assert.equal(decideFeedQuality(good,{input}).decision,'KEEP');
  assert.equal(decideFeedQuality({...good,advertising:.99},{input}).decision,'KEEP');
  assert.equal(decideFeedQuality({...good,topic_relevance:.15},{input}).reason,'outside-scope');
  assert.equal(decideFeedQuality({...good,reading_value:.25,specific_content:.35},{input}).reason,'no-substance');
  assert.equal(decideFeedQuality({...good,reading_value:.40,advertising:.80,specific_content:.50},{input}).reason,'empty-promotion');
  assert.equal(decideFeedQuality({...good,reading_value:.64},{input}).decision,'REVIEW');
  const boundary={reading_value:.65,advertising:.9,specific_content:.6,sufficient_information:.6,topic_relevance:.6,missing_context:.3};
  assert.equal(decideFeedQuality(boundary,{input}).decision,'KEEP');
  assert.equal(decideFeedQuality(boundary,{input,profile:'strict'}).decision,'REVIEW');
  assert.equal(decideFeedQuality(boundary,{input,profile:'conservative'}).decision,'KEEP');
});

test('missing body, truncation and missing context take precedence over all DROP rules',()=>{
  const junk={...good,topic_relevance:0,reading_value:0,specific_content:0,missing_context:.6};
  assert.equal(decideFeedQuality(junk,{input}).decision,'REVIEW');
  assert.equal(decideFeedQuality(good,{input:{...input,bodyMissing:true}}).reason,'body-missing');
  assert.equal(decideFeedQuality(good,{input:{...input,truncated:true}}).reason,'input-truncated');
  assert.equal(decideFeedQuality(good,{input:{...input,keyContextMissing:true}}).reason,'context-missing');
  assert.equal(decideFeedQuality(good,{input:{title:'AI 发布会',body:''}}).decision,'REVIEW');
});

test('invalid probabilities never clamp, coerce or fail open to qualified content',async()=>{
  for(const invalid of [null,undefined,NaN,Infinity,-.1,1.1,'0.8']) {
    assert.equal(parseFeedQualityAnswers(answers({...good,reading_value:invalid})),null);
    assert.equal(decideFeedQuality({...good,reading_value:invalid},{input}).reason,'invalid-scores');
  }
  assert.equal(parseFeedQualityAnswers({}),null);
  const evaluator=createFeedQualityEvaluator({readingScope:['AI'],client:{async evaluate(){throw new Error('timeout');}}});
  const failed=await evaluator.evaluate(input);
  assert.equal(failed.decisions.balanced.decision,'REVIEW');
  assert.equal(failed.errorReason,'jev-failed');
  assert.equal((await createFeedQualityEvaluator({readingScope:['AI']}).evaluate(input)).decisions.balanced.reason,'jev-unavailable');
});

test('oversized input is REVIEW without silent slicing or extra requests; cache identity includes scope and model',async()=>{
  let calls=0;
  const client={async evaluate(){calls++;return {answers:answers(good)};}};
  const a=createFeedQualityEvaluator({client,readingScope:['AI'],model:'a',maxStateBytes:50});
  const oversized=await a.evaluate({body:'全文'.repeat(100)});
  assert.equal(oversized.decisions.balanced.reason,'input-too-large');
  assert.equal(calls,0);
  const b=await createFeedQualityEvaluator({client,readingScope:['AI'],model:'a'}).evaluate(input);
  const c=await createFeedQualityEvaluator({client,readingScope:['能源'],model:'a'}).evaluate(input);
  const d=await createFeedQualityEvaluator({client,readingScope:['AI'],model:'b'}).evaluate(input);
  assert.notEqual(b.cacheKey,c.cacheKey);
  assert.notEqual(b.cacheKey,d.cacheKey);
  assert.deepEqual(Object.values(buildFeedQualityQuestions()).map(q=>q.type),Array(6).fill('noul'));
});

test('offline export uses first-created natural-day window, removes media mirrors and canonical duplicates, without writes',()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'ai-center-quality-'));
  const file=path.join(directory,'test.db');
  const store=createStore(file);store.close();
  const writable=new Database(file);
  assert.throws(()=>readFeedQualityWindow(writable,{startAt:10,endAt:20}),/read-only/);
  const capture=writable.prepare(`INSERT INTO captures(id,workspace_id,provider,external_id,content_hash,captured_at) VALUES (?,'local',?,?,?,?)`);
  const content=writable.prepare(`INSERT INTO content_items(id,workspace_id,capture_id,origin_type,content_type,body,published_at,created_at,updated_at)
    VALUES (?,'local',?,'subscription','post','original',?,?,?)`);
  for (const [id,provider,created,published] of [['early','x',9,15],['left','x',10,1],['late','x',20,15],['mirror','media',15,15]]) {
    capture.run(id,provider,id,id,created);content.run(id,id,published,created,created+100);
  }
  const media=writable.prepare(`INSERT INTO media_index_entries(workspace_id,external_id,source_key,publisher_key,channel,canonical_url,
    content_level,content_hash,status,observed_at,created_at,updated_at) VALUES ('local',?,'news','news','macro',?,'discovery',?,'ready',?,?,?)`);
  media.run('article','https://example.org/one','one',10,10,15);
  media.run('same-url','https://example.org/one','two',11,11,15);
  media.run('preexisting','https://example.org/old','three',9,9,15);
  media.run('new-alias-of-old','https://example.org/old','four',15,15,15);
  media.run('right-boundary','https://example.org/right','five',20,20,20);
  // No production capture, job, state or report mutations are permitted by the audit port.
  const before=writable.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  writable.close();
  const db=new Database(file,{readonly:true});
  const result=readFeedQualityWindow(db,{startAt:10,endAt:20});
  assert.deepEqual(result.feed.map(row=>row.id),['left']);
  assert.deepEqual(result.media.map(row=>row.external_id),['article']);
  assert.equal(result.mediaIndexRowsInWindow,3);
  assert.equal(result.excludedMediaFeedMirrors,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n,before);
  assert.throws(()=>readFeedQualityWindow(db,{startAt:20,endAt:10}),/Invalid/);
  db.close();rmSync(directory,{recursive:true,force:true});
});
