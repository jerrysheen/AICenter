// Read-only verification against current Instance snapshots, translation chunks and HTTP projections.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {MediaArticleTranslationSchema} from '../packages/contracts/src/media.js';
import {mediaTranslationUnits} from '../packages/domain/src/media-translation.js';
import {mediaResourceId} from '../packages/domain/src/media-ingestion-service.js';
import {needsZhLocalization} from '../packages/domain/src/localize-texts.js';
import {loadTagCatalog} from '../packages/domain/src/tag-catalog.js';
import {TAG_PROMPT_VERSION} from '../packages/domain/src/tag-prompt.js';

const instance=resolveInstanceConfig({repositoryRoot:process.cwd()});
const db=new Database(instance.databasePath,{readonly:true});
const sha=text=>createHash('sha256').update(text).digest('hex');
const catalog=loadTagCatalog(fs.readFileSync(instance.tagCatalogPath,'utf8'));
try {
  const feeds=await Promise.all(['tech','macro'].map(async channel=>{
    const response=await fetch(`http://127.0.0.1:${instance.port}/api/v1/feed?platform=media&channel=${channel}&limit=100`);
    assert.equal(response.status,200);return {channel,...await response.json()};
  }));
  const rows=[];
  for(const item of feeds.flatMap(f=>f.feed.items).filter(i=>i.contentLevel==='full')) {
    const snapshot=db.prepare('SELECT * FROM media_body_snapshots WHERE external_id=? AND body_hash=? ORDER BY revision DESC LIMIT 1').get(item.externalId,item.bodyHash);
    assert.ok(snapshot);assert.equal(sha(snapshot.body_text),item.bodyHash);
    const article=JSON.parse(snapshot.article_json);
    assert.deepEqual(item.paragraphs,article.paragraphs);
    const translation=MediaArticleTranslationSchema.parse(item.articleTranslation);
    assert.equal(translation.bodyHash,item.bodyHash);assert.equal(translation.snapshotRevision,snapshot.revision);
    const units=mediaTranslationUnits({...item,snapshotRevision:snapshot.revision});
    const chunks=units.map(unit=>({unit,saved:db.prepare('SELECT * FROM feed_item_translations WHERE workspace_id=? AND item_id=? AND target_lang=?').get('local',unit.id,'zh')}));
    const complete=chunks.filter(({unit,saved})=>!needsZhLocalization(unit.text) || saved?.source_hash===sha(unit.text) && saved.translated_text).length;
    assert.equal(translation.completedChunks,complete);assert.equal(translation.totalChunks,units.length);
    if(translation.status==='ready') {
      assert.deepEqual(translation.paragraphs.map(p=>[p.id,p.kind]),item.paragraphs.map(p=>[p.id,p.kind]));
      assert.ok(translation.title);assert.equal(complete,units.length);
      // Every original paragraph is covered through its last chunk, including long articles.
      for(const p of item.paragraphs) assert.equal(units.filter(u=>u.paragraphId===p.id).map(u=>u.text).join(' ').replace(/\s+/g,' ').trim(),p.text.replace(/\s+/g,' ').trim());
    }
    const tagging=db.prepare('SELECT * FROM resource_taggings WHERE workspace_id=? AND resource_type=? AND resource_id=?').get('local','media-index',mediaResourceId(item.externalId));
    if(tagging) {
      assert.equal(tagging.tag_catalog_version,catalog.version);assert.equal(tagging.prompt_version,TAG_PROMPT_VERSION);
      assert.ok(tagging.analyzed_at>=snapshot.observed_at,'tagging predates current body');
      assert.ok(JSON.parse(tagging.tags_json).every(id=>catalog.ids.has(id)));
    }
    rows.push({externalId:item.externalId,channel:item.channel,bodyChars:snapshot.body_text.length,bodyHash:item.bodyHash,
      snapshotRevision:snapshot.revision,paragraphCount:item.paragraphs.length,translationStatus:translation.status,
      completedChunks:complete,totalChunks:units.length,translatedParagraphs:translation.paragraphs.length,
      tagged:Boolean(tagging),tags:tagging?JSON.parse(tagging.tags_json):[],tagCatalogVersion:tagging?.tag_catalog_version,
      tagPromptVersion:tagging?.prompt_version,taggedAt:tagging?.analyzed_at});
  }
  const jobs=db.prepare("SELECT id,status,type,output_json,error_json FROM jobs WHERE type='media.index.enrich' ORDER BY created_at DESC LIMIT 5").all().map(j=>{
    let output={};try{output=JSON.parse(j.output_json || '{}');}catch{}
    return {id:j.id,status:j.status,health:output.health,translationStats:output.translationStats,bodyStats:output.bodyStats,
      tagged:output.tagged,briefs:output.briefs?.map(b=>({externalId:b.externalId,status:b.status})),error:j.error_json};
  });
  const result={observedAt:new Date().toISOString(),verifiedFull:rows.length,translatedFull:rows.filter(r=>r.translationStatus==='ready').length,
    taggedFull:rows.filter(r=>r.tagged).length,channels:feeds.map(f=>({channel:f.channel,counts:f.feed.counts})),rows,jobs,
    schedules:db.prepare("SELECT * FROM job_schedules WHERE schedule_key='media-index-sync'").all(),
    budget:db.prepare('SELECT * FROM media_budget_days ORDER BY day_key DESC LIMIT 1').get(),
    unresolved:db.prepare('SELECT external_id,source_key,content_level,fetch_state_json FROM media_index_entries').all().filter(r=>{
      const state=JSON.parse(r.fetch_state_json || '{}');return ['failed','partial','deferred'].includes(state.fetchStatus);
    }).map(r=>({externalId:r.external_id,sourceKey:r.source_key,contentLevel:r.content_level,fetchState:JSON.parse(r.fetch_state_json)})),
    discoveredOriginals:db.prepare("SELECT external_id,discovered_via_json FROM media_index_entries WHERE discovered_via_json IS NOT NULL AND discovered_via_json!='null'").all().map(r=>({externalId:r.external_id,discoveredVia:JSON.parse(r.discovered_via_json)}))};
  fs.writeFileSync(path.join(instance.runtimeDirectory,'media-audit','reading-validation.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({observedAt:result.observedAt,verifiedFull:result.verifiedFull,translatedFull:result.translatedFull,taggedFull:result.taggedFull,
    channels:result.channels,jobs:jobs.map(({briefs,...j})=>({...j,briefCounts:briefs?.reduce((v,b)=>(v[b.status]=(v[b.status] || 0)+1,v),{})})),schedules:result.schedules},null,2));
  if(process.argv.includes('--require-complete')) {
    assert.equal(result.translatedFull,result.verifiedFull,'full translation still pending');
    assert.equal(result.taggedFull,result.verifiedFull,'article tagging still pending');
    assert.ok(result.schedules.some(s=>s.enabled),'automatic media schedule not enabled');
  }
}finally{db.close();}
