// Read-only check of the actual Instance and its running HTTP projection.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { MediaBriefSchema } from '../packages/contracts/src/media.js';
import { buildDailyBriefCandidates } from '../packages/domain/src/daily-brief-candidates.js';
const instance=resolveInstanceConfig({repositoryRoot:process.cwd()});
const db=new Database(instance.databasePath,{readonly:true});
const sha=value=>createHash('sha256').update(value).digest('hex');
const feeds=await Promise.all(['tech','macro'].map(channel=>fetch(`http://127.0.0.1:${instance.port}/api/v1/feed?platform=media&channel=${channel}&limit=100`).then(r=>r.json())));
const items=feeds.flatMap(f=>f.feed.items);
const rows=[];
try {
  for(const item of items.filter(i=>i.bodyHash)) {
    const snapshot=db.prepare('SELECT * FROM media_body_snapshots WHERE external_id=? AND body_hash=? ORDER BY revision DESC LIMIT 1').get(item.externalId,item.bodyHash);
    const content=db.prepare(`SELECT c.id,c.body,c.author_name FROM content_items c JOIN captures cap ON cap.id=c.capture_id WHERE cap.provider='media' AND cap.external_id=?`).get(item.externalId);
    assert.equal(sha(snapshot.body_text),item.bodyHash);assert.equal(content.body,snapshot.body_text);assert.ok(item.body.endsWith(snapshot.body_text));
    const article=JSON.parse(snapshot.article_json);
    assert.deepEqual(item.paragraphs,article.paragraphs || []);
    if (item.contentLevel==='full') {
      assert.equal(item.authorName,article.author || item.fetchState.author || item.publisherKey);
      assert.equal(content.author_name,article.author || item.publisherKey);
      assert.equal(item.fetchState.finalUrl,article.finalUrl);
      assert.equal(item.fetchState.publishedAtRaw,article.publishedAtRaw);
      assert.equal(item.fetchState.updatedAtRaw,article.updatedAtRaw);
    }
    let dailyBriefConsistent=false;
    if(item.generatedBrief) {
      const brief=MediaBriefSchema.parse(item.generatedBrief);
      assert.equal(brief.bodyHash,item.bodyHash);assert.equal(brief.snapshotRevision,snapshot.revision);
      for(const e of brief.evidence) assert.ok(item.paragraphs.find(p=>p.id===e.paragraphId)?.text.includes(e.quote));
      const candidate=buildDailyBriefCandidates({reportDate:'2026-10-02',content:{news:[{id:content.id,title:item.title,summary:item.summary,eventAt:item.publishedAt,generatedBrief:brief}]}}).candidates[0];
      assert.equal(candidate.summary,brief.text);assert.equal(candidate.data.bodyHash,item.bodyHash);
      assert.ok(candidate.sourceRefs.some(ref=>ref.type==='media-body'));
      dailyBriefConsistent=true;
    }
    rows.push({externalId:item.externalId,sourceKey:item.publisherKey,title:item.title,contentLevel:item.contentLevel,fetchStatus:item.fetchState.fetchStatus,
      reason:item.fetchState.extractionReason,bodyHash:item.bodyHash,snapshotRevision:snapshot.revision,bodyChars:snapshot.body_text.length,
      paragraphCount:item.paragraphs.length,projectionConsistent:true,briefChars:item.generatedBrief?.text.length || 0,
      briefEvidence:item.generatedBrief?.evidence.length || 0,briefText:item.generatedBrief?.text || '',
      evidenceParagraphs:item.generatedBrief?.evidence.map(e=>e.paragraphId) || [],
      metadata:{author:article.author || '',publishedAtRaw:article.publishedAtRaw || '',updatedAtRaw:article.updatedAtRaw || '',canonicalUrl:article.canonicalUrl || '',finalUrl:article.finalUrl || ''},dailyBriefConsistent});
  }
  const result={observedAt:new Date().toISOString(),schemaVersion:db.pragma('user_version',{simple:true}),rows,
    channels:feeds.map(f=>({channel:f.feed.feed,counts:f.feed.counts,total:f.feed.total})),
    verifiedFull:rows.filter(r=>r.contentLevel==='full').length,validBriefs:rows.filter(r=>r.dailyBriefConsistent).length,
    budgets:db.prepare('SELECT * FROM media_budget_days ORDER BY day_key DESC LIMIT 1').all(),
    repair:JSON.parse(fs.readFileSync(path.join(instance.runtimeDirectory,'media-audit','repair-job.json'),'utf8')).externalIds.map(id=>({externalId:id,
      ...db.prepare('SELECT content_level,fetch_state_json FROM media_index_entries WHERE external_id=?').get(id),
      revisions:db.prepare('SELECT revision,body_hash FROM media_body_snapshots WHERE external_id=? ORDER BY revision').all(id)}))};
  fs.writeFileSync(path.join(instance.runtimeDirectory,'media-audit','projection-validation.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({verifiedFull:result.verifiedFull,validBriefs:result.validBriefs,projectionConsistent:rows.length,channels:result.channels},null,2));
}finally{db.close();}
