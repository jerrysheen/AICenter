import test from 'node:test';
import assert from 'node:assert/strict';
import {preparationState,collectTreeReadiness,readinessMarkdown} from '../scripts/lib/tree-readiness-diagnostics.mjs';
import {TREE_VALIDATOR_VERSION} from '../packages/contracts/src/information-tree.js';
import Database from 'better-sqlite3';
import {runMigrations} from '../packages/database/src/migrations.js';

const state=extra=>preparationState({id:'feed:a',version:'v1',at:100,promptHashes:['prompt'],...extra});
const head={sourceVersion:'v1',generatedAt:50,validatorVersion:TREE_VALIDATOR_VERSION,effectivePromptHash:'prompt'};
const job=extra=>({id:'j',createdAt:10,updatedAt:150,status:'completed',sourceIds:['feed:a'],attempts:[{startedAt:120,completedAt:140}],...extra});
test('readiness reconstructs queued at edition time, not current completed job',()=>{
  assert.equal(state({jobs:[job()]}).reason,'queued-not-started');
  assert.equal(state({jobs:[job()],head:{...head,generatedAt:130}}).reason,'queued-not-started');
  assert.equal(state({at:160,jobs:[job()],head:{...head,generatedAt:130}}).reason,'ready');
});
test('running batch membership never claims single-material execution',()=>{
  const active=job({attempts:[{startedAt:90,completedAt:140}]});
  assert.equal(state({jobs:[active]}).reason,'running');
  assert.equal(state({jobs:[{...active,sourceIds:['feed:a','feed:b']}]}).reason,'running-batch-member');
});
test('matching failure preserves cooldown and ignores overwritten future or other-version errors',()=>{
  const stage={updatedAt:90,input:{sourceVersion:'v1'},output:{pending:{reason:'execution-timeout',retryAt:130}}};
  assert.equal(state({stages:[stage]}).reason,'retry-cooldown');
  assert.equal(state({at:150,stages:[stage]}).reason,'preparation-failed');
  assert.equal(state({stages:[{...stage,updatedAt:120}]}).reason,'no-matching-evidence');
  assert.equal(state({stages:[{...stage,input:{sourceVersion:'v0'}}]}).reason,'no-matching-evidence');
});
test('source version, prompt and validator mismatches are explicit',()=>{
  assert.equal(state({head:{...head,sourceVersion:'v0'}}).reason,'source-version-mismatch');
  assert.equal(state({head:{...head,effectivePromptHash:'old'}}).reason,'prompt-or-validator-mismatch');
  assert.equal(state({head:{...head,validatorVersion:'old'}}).reason,'prompt-or-validator-mismatch');
});
test('superseded original is queued before cancellation, excluded afterwards',()=>{
  const cancelled=job({status:'cancelled',attempts:[]});
  assert.equal(state({jobs:[cancelled]}).reason,'queued-not-started');
  assert.equal(state({at:160,jobs:[cancelled]}).reason,'no-matching-evidence');
});
test('empty database diagnostics do not require an edition or write business data',()=>{
  const db=new Database(':memory:');runMigrations(db);
  try {
    // Only this isolated test database is migrated; diagnostics uses read statements.
    const before=db.prepare('SELECT count(*) n FROM outbox_events').get().n;
    const report=collectTreeReadiness(db,{edition:null,inspectedAt:10*3600000,window:{startAt:0,endAt:3600000}});
    assert.equal(report.summary.editionSources,0);
    assert.equal(report.items.length,0);
    assert.equal(db.prepare('SELECT count(*) n FROM outbox_events').get().n,before);
    assert.match(readinessMarkdown(report),/刊期：无/);
  } finally {db.close();}
});
test('pending-only source keeps failed stage and split queue ancestry without counting children as inflow',()=>{
  const db=new Database(':memory:');runMigrations(db);
  try {
    const insert=db.prepare('INSERT INTO jobs(id,workspace_id,type,status,input_json,output_json,available_at,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('original','local','report.information.prepare','cancelled',JSON.stringify({sourceIds:['feed:a','feed:b']}),JSON.stringify({status:'superseded'}),10,10,30);
    insert.run('child','local','report.information.prepare','queued',JSON.stringify({sourceIds:['feed:a']}),null,30,30,30);
    db.prepare('INSERT INTO daily_analysis_stages VALUES (?,?,?,?,?,?,?,?,?)').run('local','tree-preparation','information:feed:a','hash',JSON.stringify({sourceId:'feed:a',sourceVersion:'v1'}),JSON.stringify({pending:{reason:'execution-timeout',retryAt:120}}),'failed','execution-timeout',50);
    const edition={id:'edition:test',generatedAt:20,inputIds:[],pending:[{id:'feed:a',sourceVersion:'v1',reason:'information-not-ready'}]};
    const report=collectTreeReadiness(db,{edition,inspectedAt:100,window:{startAt:0,endAt:3600000}});
    assert.deepEqual(report.summary.pendingAtGeneration,{'queued-not-started':1});
    assert.deepEqual(report.summary.pendingNow,{'retry-cooldown':1});
    assert.equal(report.items[0].stages.length,1);
    assert.equal(report.items[0].jobs.length,2);
    assert.equal(report.capacity.bins.at(-1).newUniqueQueued,2); // a and b, not original+child.
    assert.equal(report.items[0].current.failure.reason,'execution-timeout');
  } finally {db.close();}
});
