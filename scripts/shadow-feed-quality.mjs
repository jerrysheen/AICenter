import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { createTypeSafeSystemOneClient } from '../packages/connectors/src/typesafe-system-one.js';
import { openJevClient } from '../packages/domain/src/jev-enabled.js';
import { readFeedQualityWindow } from '../packages/database/src/repositories/feed-quality-audit-repository.js';
import { mediaResourceId } from '../packages/domain/src/media-ingestion-service.js';
import { normalizeFeedQualityText, createFeedQualityEvaluator, decideFeedQuality, FEED_QUALITY_VERSION } from '../packages/domain/src/feed-quality.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot: root });
const args = process.argv.slice(2);
const option = (name, fallback) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length+3) || fallback;
const day = option('day', '2026-10-04');
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Use --day=YYYY-MM-DD');
const startAt = Date.parse(`${day}T00:00:00+08:00`), endAt = startAt+86_400_000;
const out = path.join(instance.runtimeDirectory, 'feed-quality-audit', `${day}-${FEED_QUALITY_VERSION}`);
mkdirSync(out, { recursive: true });
const jsonPath = name => path.join(out, name);
const jsonRead = name => JSON.parse(readFileSync(jsonPath(name),'utf8'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceNames = { 'x:home:for-you':'X 推荐', 'x:home:following':'X 关注',
  'xueqiu:home:following':'雪球关注', 'xueqiu:home:livenews':'雪球 7x24', 'xueqiu:home:recommend':'雪球精选' };

if (!existsSync(jsonPath('corpus.json'))) {
  const db = new Database(instance.databasePath, { readonly: true });
  let snapshot;
  try { snapshot = readFeedQualityWindow(db, { workspaceId: option('workspace','local'), startAt, endAt }); }
  finally { db.close(); }
  const tags = new Map(snapshot.taggings.map(row => [`${row.resource_type}:${row.resource_id}`, row]));
  const tagFields = (type,id) => {
    const row = tags.get(`${type}:${id}`);
    const values = row ? JSON.parse(row.tags_json || '[]') : [];
    return { tags: values.map(value => typeof value==='string' ? value : value.id),
      tagStatus: row ? (values.length ? 'tagged' : 'empty') : 'pending', tagAnalyzedAt: row?.analyzed_at || null };
  };
  const items = snapshot.feed.map(row => {
    const metadata = JSON.parse(row.metadata_json || '{}');
    const rawText = metadata.originalText || row.body || '';
    return { id:`feed:${row.id}`, provider:row.provider, sourceKey:row.source_key,
      source:sourceNames[row.source_key] || row.source_name || row.provider,
      author:row.author_name, title:row.title, url:row.source_url, rawText,
      firstSavedAt:row.created_at, publishedAt:row.published_at, updatedAt:row.updated_at,
      inputVersion:row.updated_at===row.created_at ? 'saved-original-no-later-update' : 'current-original-first-version-unavailable',
      originalVersionExact:false, ...tagFields('content-item',row.id),
      old:{ version:metadata.filterVersion || '', reason:metadata.filterReason || 'not-filtered',
        wouldDecision:metadata.wouldIgnore===true ? 'DROP' : 'KEEP', actualDecision:'KEEP', model:metadata.evaluatorModel || '' },
      input:normalizeFeedQualityText(rawText,{title:row.title}) };
  });
  for (const row of snapshot.media) {
    const body = row.snapshots.at(-1);
    const rawText = body?.body_text || '';
    items.push({ id:`media:${row.external_id}`, provider:'media', sourceKey:row.source_key,
      source:`网页 · ${row.source_key}`, author:row.author_name || row.publisher_name,
      title:row.title, url:row.canonical_url, rawText, indexSummary:row.summary,
      firstSavedAt:row.created_at, publishedAt:row.published_at, updatedAt:row.updated_at,
      inputVersion:body ? (body.observed_at>row.created_at ? 'later-body-quality-audit' : 'saved-body') : 'title-or-index-summary-only',
      originalVersionExact:false, snapshotRevision:body?.revision || null, bodyObservedAt:body?.observed_at || null,
      firstBodyObservedAt:row.snapshots[0]?.observed_at || null, contentLevel:body?.content_level || row.content_level,
      ...tagFields('media-index',mediaResourceId(row.external_id)),
      old:{version:'no-media-quality-filter',reason:'not-filtered',wouldDecision:'KEEP',actualDecision:'KEEP'},
      input:normalizeFeedQualityText(rawText,{title:row.title,
        bodyMissing:!body || body.content_level!=='full', truncated:Boolean(body?.truncated || row.truncated)}) });
  }
  const scope = JSON.parse(readFileSync(instance.tagCatalogPath,'utf8')).tags.map(tag=>({name:tag.name,
    context:(tag.keywords || []).join('、')}));
  const manifest = {day,timezone:'Asia/Shanghai',startAt,endAt,exportedAt:snapshot.exportedAt,
    selection:'first-created-at, left-closed/right-open; X/Xueqiu original text and canonical media indexes; no Tag eligibility filter',
    mediaIndexRowsInWindow:snapshot.mediaIndexRowsInWindow,excludedMediaFeedMirrors:snapshot.excludedMediaFeedMirrors,
    firstAdmissionReplayExact:false, readingScope:scope, count:items.length, corpusHash:hash(items)};
  writeFileSync(jsonPath('corpus.json'),JSON.stringify({manifest,items},null,2));
  // Freeze a stratified review set before seeing JEV probabilities. No predicted label sampling.
  const groups = new Map();
  for (const item of items) {
    const key = item.source;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(item);
  }
  for (const group of groups.values()) group.sort((a,b)=>hash(a.id).localeCompare(hash(b.id)));
  const sample = [],selected = new Set();
  const pick = item => { if(item && !selected.has(item.id) && sample.length<200){sample.push(item);selected.add(item.id);} };
  for (const group of groups.values()) for(const item of group.slice(0,Math.min(8,group.length))) pick(item);
  for(const tag of ['ai_application','ai_model']) for(const item of items.filter(row=>row.tags.includes(tag)).sort((a,b)=>hash(a.id).localeCompare(hash(b.id))).slice(0,35)) pick(item);
  for(const item of items.filter(row=>row.input.bodyMissing || row.input.unavailableMedia.length || row.rawText.length>2500).sort((a,b)=>hash(a.id).localeCompare(hash(b.id))).slice(0,30)) pick(item);
  for(const item of [...items].sort((a,b)=>hash(a.id).localeCompare(hash(b.id)))) pick(item);
  const review = sample.sort((a,b)=>hash(a.id).localeCompare(hash(b.id))).map((item,index)=>({
    id:item.id,split:index%2 ? 'validation':'calibration',source:item.source,title:item.title,
    url:item.url,rawText:item.rawText,inputVersion:item.inputVersion,tags:item.tags,
    input:item.input,referenceLabel:null,highValue:null,annotationSource:'unreviewed',note:'' }));
  writeFileSync(jsonPath('review-set.json'),JSON.stringify({sampleHash:hash(review.map(row=>row.id)),
    createdBeforeScoring:true,truthStatus:'not-human-ground-truth',rows:review},null,2));
}
const corpus = jsonRead('corpus.json');
// The corpus freezes originals. Normalization is reproducible from those originals,
// and each request's fingerprint checks the exact derived input, questions, scope and model.
for (const item of corpus.items) item.input = normalizeFeedQualityText(item.rawText, {
  title:item.title,bodyMissing:item.input.bodyMissing,truncated:item.input.truncated,
  keyContextMissing:item.input.keyContextMissing });
if (args.includes('--export-only')) { console.log(JSON.stringify({out,...corpus.manifest})); process.exit(0); }
const model = option('model','jev-1.13.0');
const client = openJevClient(process.env, undefined, (options) => createTypeSafeSystemOneClient({...options,model,timeoutMs:30_000}));
if (!client) throw new Error('AI_CENTER_JEV_ENABLED=false，不调用 TypeSafe');
const evaluator = createFeedQualityEvaluator({client,readingScope:corpus.manifest.readingScope,model});
const prior = existsSync(jsonPath('scores.jsonl')) ? readFileSync(jsonPath('scores.jsonl'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
const byId = new Map(prior.filter(row=>row.version===FEED_QUALITY_VERSION && row.requestedModel===model
  && row.corpusHash===corpus.manifest.corpusHash
  && (!args.includes('--retry-errors') || !['jev-failed','jev-unavailable'].includes(row.errorReason))).map(row=>[row.id,row]));
for (const item of corpus.items) if (byId.get(item.id)?.cacheKey !== evaluator.cacheKey(item.input)) byId.delete(item.id);
const pending = corpus.items.filter(row=>!byId.has(row.id));
const concurrency = Number(option('concurrency','4'));
if (!Number.isInteger(concurrency) || concurrency<1 || concurrency>8) throw new Error('Concurrency must be 1..8');
console.log(JSON.stringify({stage:'start',count:corpus.items.length,pending:pending.length,available:client.available(),out,model}));
let cursor=0,done=0,failed=0;
const started=Date.now();
await Promise.all(Array.from({length:concurrency},async()=>{
  while(cursor<pending.length) {
    const item=pending[cursor++],at=Date.now();
    const result=await evaluator.evaluate(item.input);
    const row={id:item.id,...result,requestedModel:model,corpusHash:corpus.manifest.corpusHash,scoredAt:Date.now(),ms:Date.now()-at};
    appendFileSync(jsonPath('scores.jsonl'),`${JSON.stringify(row)}\n`);
    byId.set(row.id,row); done++;
    if(row.errorReason==='jev-failed') failed++;
    if(done%100===0 || done===pending.length) console.log(JSON.stringify({stage:'progress',done,total:pending.length,failed,elapsedMs:Date.now()-started}));
    // Stop dispatching after repeated provider failure, retain a resumable partial run.
    if(failed>=12 && failed/done>.5) throw new Error('JEV unavailable repeatedly; resume later with the same frozen corpus');
  }
}));
const results=corpus.items.map(item=>{
  const score=byId.get(item.id);
  return {...item,...score,decisions:Object.fromEntries(['conservative','balanced','strict'].map(profile=>
    [profile,decideFeedQuality(score.scores,{input:item.input,profile,errorReason:score.errorReason})]))};
});
const count = rows => {
  const counts={total:rows.length,oldShadowDrop:rows.filter(row=>row.old.wouldDecision==='DROP').length,actualBeforeKept:rows.length};
  for(const profile of ['conservative','balanced','strict']) {
    counts[profile]={KEEP:0,DROP:0,REVIEW:0,reasons:{}};
    for(const row of rows) {const d=row.decisions[profile];counts[profile][d.decision]++;counts[profile].reasons[d.reason]=(counts[profile].reasons[d.reason] || 0)+1;}
  }
  return counts;
};
const summary={manifest:corpus.manifest,model,version:FEED_QUALITY_VERSION,totals:count(results),
  bySource:Object.fromEntries([...new Set(results.map(row=>row.source))].map(source=>[source,count(results.filter(row=>row.source===source))])),
  byTag:Object.fromEntries(['ai_application','ai_model'].map(tag=>[tag,count(results.filter(row=>row.tags.includes(tag)))])),
  byTagStatus:Object.fromEntries(['tagged','empty','pending'].map(tag=>[tag,count(results.filter(row=>row.tagStatus===tag))])),
  byInputVersion:Object.fromEntries([...new Set(results.map(row=>row.inputVersion))].map(version=>[version,count(results.filter(row=>row.inputVersion===version))])),
  calls:results.filter(row=>row.rawAnswers).length,errors:results.filter(row=>row.errorReason==='jev-failed').length,
  review:{sampleCount:jsonRead('review-set.json').rows.length,humanTruthAvailable:false,qualityTargetsVerified:false},
  productionEnforceEnabled:false};
writeFileSync(jsonPath('results.json'),JSON.stringify({summary,items:results},null,2));
writeFileSync(jsonPath('summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({stage:'complete',summary}));
