import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import Database from 'better-sqlite3';
import {createStore} from '../packages/database/src/index.js';
import {runMigrations} from '../packages/database/src/migrations.js';
import {createInformationTreeRepository} from '../packages/database/src/repositories/information-tree-repository.js';
import {createInformationTreeReader, createInformationTreeService} from '../packages/domain/src/information-tree-service.js';
import {TreeIndexManifestSchema, TreeManifestQuerySchema} from '../packages/contracts/src/information-tree.js';
import {loadInformationTreeSkills} from '../packages/runtime/src/information-tree/skills.js';

const HOUR = 3600000;
const DAY = 86400000;
const START = 10 * HOUR;
const forbidden = ['inputIds', 'pendingIds', 'roots', 'pending', 'groupFailures', 'policyHash', 'text', 'title', 'body', 'padding'];

test('index contract keeps edition internals and article prose out of the manifest', () => {
  const edition = {id:'edition:abc', layer:'hourly', window:{startAt:1, endAt:2}, status:'ready', generatedAt:3, rootCount:1, hasEditorial:false};
  const manifest = {timezone:'Asia/Shanghai', pipeline:'tree-v3', directions:{ai:'tech'}, information:[], hours:[{edition, attempt:{...edition, id:'edition:attempt'}}], days:[]};
  assert.equal(TreeIndexManifestSchema.safeParse(manifest).success, true);
  assert.equal(TreeIndexManifestSchema.safeParse({...manifest, information:[{id:'n', eventAt:1, window:{startAt:1, endAt:2}, validatorVersion:'tree-response-v3.1.0'}]}).success, true);
  for (const extra of [{inputIds:['a']}, {roots:['a']}, {pendingIds:[]}, {pending:[]}, {body:'正文'}, {text:'提炼'}]) {
    assert.equal(TreeIndexManifestSchema.safeParse({...manifest, hours:[{edition:{...edition, ...extra}, attempt:null}]}).success, false);
  }
  assert.equal(TreeIndexManifestSchema.safeParse({...manifest, information:[{id:'n', eventAt:1, window:{startAt:1, endAt:2}, body:'正文'}]}).success, false);
  assert.equal(TreeManifestQuerySchema.safeParse({startAt:1, endAt:2, view:'index'}).success, true);
  assert.equal(TreeManifestQuerySchema.safeParse({startAt:1, endAt:2, view:'reading'}).success, true);
  assert.equal(TreeManifestQuerySchema.safeParse({startAt:1, endAt:2, view:'index', information:'1'}).success, true);
  assert.equal(TreeManifestQuerySchema.safeParse({startAt:1, endAt:2, view:'full'}).success, false);
  assert.equal(TreeManifestQuerySchema.safeParse({startAt:1, endAt:2, view:'index', information:'0'}).success, false);
});

test('one nonconforming stored row is dropped from the index and does not fail the manifest', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const insertEdition = db.prepare('INSERT INTO information_tree_editions (workspace_id,id,value_json) VALUES (?,?,?)');
    const insertPeriod = db.prepare('INSERT INTO information_tree_heads (workspace_id,period_key,layer,start_at,published_id,attempt_id) VALUES (?,?,?,?,?,?)');
    const insertNode = db.prepare('INSERT INTO information_tree_nodes (workspace_id,id,value_json) VALUES (?,?,?)');
    const insertInfo = db.prepare('INSERT INTO information_tree_information_heads (workspace_id,source_id,node_id,source_version,event_at,source_at) VALUES (?,?,?,?,?,?)');
    const edition = (id, status, window) => ({id, layer:'hourly', window, timezone:'Asia/Shanghai', status, roots:['module:1'], inputIds:['i:good'], pendingIds:[], missingHours:[], generatedAt:window.endAt});
    insertEdition.run('local', 'edition:good', JSON.stringify(edition('edition:good', 'ready', {startAt:START, endAt:START + HOUR})));
    insertEdition.run('local', 'edition:stale-attempt', JSON.stringify(edition('edition:stale-attempt', 'archived', {startAt:START, endAt:START + HOUR})));
    insertPeriod.run('local', `hourly:${START}:${START + HOUR}`, 'hourly', START, 'edition:good', 'edition:stale-attempt');
    insertEdition.run('local', 'edition:bad', JSON.stringify(edition('edition:bad', 'archived', {startAt:START + HOUR, endAt:START + 2 * HOUR})));
    insertPeriod.run('local', `hourly:${START + HOUR}:${START + 2 * HOUR}`, 'hourly', START + HOUR, 'edition:bad', 'edition:bad');
    const goodNode = {id:'i:good', layer:'information', version:'a'.repeat(64), title:'标题', text:'摘要', tagId:null, children:[], articleIds:['source:good'], sourceId:'source:good', window:{startAt:START, endAt:START + HOUR}, generatedAt:START, eventAt:START + 1, validatorVersion:'tree-response-v3.1.0'};
    const badNode = {...goodNode, id:'i:bad', sourceId:'source:bad', articleIds:['source:bad'], eventAt:START + 2, window:{startAt:'unknown', endAt:START + HOUR}};
    insertNode.run('local', 'i:good', JSON.stringify(goodNode));
    insertNode.run('local', 'i:bad', JSON.stringify(badNode));
    insertInfo.run('local', 'source:good', 'i:good', '1', START + 1, START);
    insertInfo.run('local', 'source:bad', 'i:bad', '1', START + 2, START);
    const reader = createInformationTreeReader({repository:createInformationTreeRepository(db, () => {}), timezone:'Asia/Shanghai', pipeline:'tree-v3'});
    const window = {startAt:START, endAt:START + 3 * HOUR};
    const index = reader.list('local', {...window, view:'index', information:'1'});
    assert.equal(TreeIndexManifestSchema.safeParse(index).success, true);
    assert.deepEqual(index.hours.map(row => [row.edition?.id || null, row.attempt?.id || null]), [['edition:good', null]]);
    assert.deepEqual(index.information.map(row => row.id), ['i:good']);
    assert.ok(warnings.some(line => line.includes('edition:stale-attempt')));
    assert.ok(warnings.some(line => line.includes('edition:bad')));
    assert.ok(warnings.some(line => line.includes('i:bad')));
    const reading = reader.list('local', {...window, view:'reading'});
    assert.equal(reading.hours.find(row => row.edition?.id === 'edition:bad').edition.status, 'archived');
    assert.ok(reading.information.some(row => row.id === 'i:bad'));
  } finally {
    console.warn = original;
    db.close();
  }
});

test('published tree index matches edition metadata and leaves the full list untouched', async () => {
  const store = createStore(':memory:');
  const calls = [];
  const service = createInformationTreeService({
    repository: store.repositories.informationTree,
    reportRepository: store.repositories.report,
    agentRuntime: {async run(input) {
      calls.push(input);
      const payload = JSON.parse(input.message);
      if (input.usageStage === 'tree-information') return {answer: JSON.stringify({title: payload.source.title, text: payload.source.paragraphs.map(item => item.text).join('').slice(0, 160), tagId: null})};
      return {answer: JSON.stringify({modules:[{title:'未分类进展', text:'厂商计划交付，目前仍在测试。', tagId:null, inputIds:payload.inputs.map(node => node.id)}]})};
    }},
    skills: loadInformationTreeSkills(),
  });
  try {
    const material = (id) => ({id, title:`标题 ${id}`, author:'作者', publisher:'来源', publishedAt:START + 1, contentLevel:'full', paragraphs:[{role:'body', text:`原文内容 ${id}`}], sourceRefs:[]});
    const hour = await service.generateHour({hourStart:START, materials:[material('a'), material('b')]});
    const daily = await service.generateDaily({window:{startAt:START, endAt:START + 2 * HOUR}, hours:[hour]});
    const window = {startAt:START, endAt:START + 2 * HOUR};
    const full = service.list('local', window);
    const reading = service.list('local', {...window, view:'reading'});
    const repository = store.repositories.informationTree;
    let fullReads = 0;
    const listInformation = repository.listInformation.bind(repository);
    const listEditions = repository.list.bind(repository);
    repository.listInformation = (...args) => {fullReads += 1; return listInformation(...args);};
    repository.list = (...args) => {fullReads += 1; return listEditions(...args);};
    const index = service.list('local', {...window, view:'index'});
    const withInformation = service.list('local', {...window, view:'index', information:'1'});
    assert.equal(fullReads, 0);
    assert.equal(index.information.length, 0);
    assert.deepEqual(reading.hours, full.hours);
    assert.ok(full.information[0].text);
    assert.equal(reading.information[0].text, undefined);
    assert.ok(full.hours[0].edition.inputIds.length);
    assert.deepEqual(withInformation.information, reading.information);
    for (const row of [...index.hours, ...index.days]) {
      for (const edition of [row.edition, row.attempt]) {
        if (!edition) continue;
        assert.deepEqual(Object.keys(edition).sort(), ['generatedAt', 'hasEditorial', 'id', 'layer', 'rootCount', 'status', 'window']);
        assert.equal(edition.hasEditorial, false);
      }
    }
    const published = full.hours[0].edition;
    const indexed = index.hours.find(row => row.edition?.id === published.id).edition;
    assert.equal(indexed.rootCount, published.roots.length);
    assert.equal(indexed.status, published.status);
    assert.equal(indexed.generatedAt, published.generatedAt);
    assert.deepEqual(indexed.window, published.window);
    assert.equal(indexed.layer, 'hourly');
    const indexedDay = index.days.find(row => row.edition?.id === daily.id).edition;
    assert.equal(indexedDay.hasEditorial, false);
    assert.equal(indexedDay.rootCount, daily.roots.length);
    store.repositories.informationTree.saveEditorial('local', editorial(daily.window));
    const again = service.list('local', {...window, view:'index'});
    assert.equal(again.days.find(row => row.edition?.id === daily.id).edition.hasEditorial, true);
    assert.equal(again.hours.find(row => row.edition?.id === published.id).edition.hasEditorial, false);
    assert.equal(service.list('other', {...window, view:'index'}).hours.length, 0);
    assert.equal(JSON.stringify(index).includes('"inputIds"'), false);
    assert.equal(service.list('local', window).hours[0].edition.inputIds.length, published.inputIds.length);
  } finally {
    store.close();
  }
});

test('seeded index stays small, skips full JSON parses, and keeps a constant query count', () => {
  let queries = 0;
  const db = new Database(':memory:', {verbose() {queries += 1;}});
  runMigrations(db);
  const seeded = seed(db);
  const repository = createInformationTreeRepository(db, () => {});
  const reader = createInformationTreeReader({repository, timezone:'Asia/Shanghai', pipeline:'tree-v3'});
  const window = {startAt:START, endAt:START + 7 * DAY};
  const fullNode = repository.listInformation('local', {startAt:START, endAt:START + HOUR})[0];
  const fullEdition = repository.list('local', START, START + HOUR, 'hourly')[0].edition;
  assert.match(fullNode.body, /正文/);
  assert.match(fullNode.text, /MARKER_PROSE/);
  assert.ok(fullEdition.inputIds.length > 1);
  assert.match(fullEdition.padding, /PAD_EDITION/);
  queries = 0;
  const reading = reader.list('local', {...window, view:'reading'});
  const readingQueries = queries;
  queries = 0;
  const index = reader.list('local', {...window, view:'index'});
  const indexQueries = queries;
  queries = 0;
  const withInformation = reader.list('local', {...window, view:'index', information:'1'});
  const informationQueries = queries;
  const readingBytes = Buffer.byteLength(JSON.stringify(reading));
  const indexBytes = Buffer.byteLength(JSON.stringify(index));
  const informationBytes = Buffer.byteLength(JSON.stringify(withInformation));
  const readingGzip = gzipSync(JSON.stringify(reading)).length;
  const indexGzip = gzipSync(JSON.stringify(index)).length;
  const sample = (view) => {
    const started = performance.now();
    reader.list('local', {...window, ...view});
    return performance.now() - started;
  };
  sample({view:'reading'});
  sample({view:'index'});
  const readingMs = median([sample({view:'reading'}), sample({view:'reading'}), sample({view:'reading'})]);
  const indexMs = median([sample({view:'index'}), sample({view:'index'}), sample({view:'index'})]);
  const partial = index.hours.find(row => row.edition.status === 'partial').edition;
  const firstDay = index.days.find(row => row.edition.window.startAt === START).edition;
  const laterDay = index.days.find(row => row.edition.window.startAt === START + DAY).edition;
  assert.equal(partial.rootCount, 1);
  assert.equal(partial.hasEditorial, false);
  assert.equal(firstDay.hasEditorial, true);
  assert.equal(laterDay.hasEditorial, false);
  assert.equal(withInformation.information.length, seeded.nodes);
  assert.deepEqual(Object.keys(withInformation.information[0]).sort(), ['eventAt', 'id', 'validatorVersion', 'window']);
  for (const key of forbidden) assert.equal(JSON.stringify(index).includes(`"${key}"`), false, key);
  assert.ok(indexBytes * 10 <= readingBytes, `index ${indexBytes} is not 90% smaller than reading ${readingBytes}`);
  assert.ok(informationBytes * 10 <= readingBytes);
  assert.equal(indexQueries, 2);
  assert.equal(informationQueries, 3);
  assert.ok(readingQueries >= seeded.nodes + seeded.hours * 2, `reading queries ${readingQueries}`);
  assert.ok(indexMs < readingMs, `index ${indexMs}ms vs reading ${readingMs}ms`);
  console.log(JSON.stringify({
    nodes: seeded.nodes, hours: seeded.hours, days: seeded.days,
    readingBytes, indexBytes, informationBytes, readingGzip, indexGzip,
    readingQueries, indexQueries, informationQueries,
    readingMs: Number(readingMs.toFixed(2)), indexMs: Number(indexMs.toFixed(2)),
    uncompressedRatio: Number((indexBytes / readingBytes).toFixed(4)),
    gzipRatio: Number((indexGzip / readingGzip).toFixed(4)),
  }));
  db.close();
});

function filler(seed, chars) {
  let out = '';
  let value = seed + 1;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  while (out.length < chars) {
    value = (value * 1664525 + 1013904223) % 4294967296;
    out += alphabet[value % alphabet.length];
  }
  return out;
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function editorial(window) {
  return {
    id: 'editorial:ready',
    version: 'daily-editorial-v1',
    reportDate: '1970-01-01',
    window,
    timezone: 'Asia/Shanghai',
    status: 'ready',
    statusNote: '当前材料已覆盖',
    overview: '今天只有一项已经发生的合作备忘录。',
    events: [{
      eventId: 'event:1',
      title: '合作备忘录',
      facts: ['两家公司已经签署合作备忘录。'],
      sourceNodeIds: ['node:1'],
      status: 'occurred',
      direction: 'tech',
      relatedEventIds: [],
      importanceLevel: 'core',
      importanceReason: '这是已经签署的合作。',
    }],
    relations: [],
    articles: [{
      direction: 'tech',
      title: '一项已经签署的合作',
      lead: '两家公司已经签署合作备忘录。',
      leadEventIds: ['event:1'],
      sections: [{heading: '备忘录', kind: 'theme', eventIds: ['event:1'], paragraphs: ['材料写的是已经签署，不是还在计划。']}],
    }],
    coverage: {
      hourlyModuleCount: 1, informationNodeCount: 1, eventCount: 1, inBodyEventCount: 1, indexOnlyEventCount: 0,
      unprocessedCount: 0, incompleteHours: [], pendingMaterialCount: 0, complete: true,
    },
    usage: {calls: 0, inputTokens: null, outputTokens: null, cost: null, model: 'test'},
    inputSnapshotHash: 'a'.repeat(64),
    strategyVersion: 'daily-editorial-v1',
    generatedAt: window.endAt,
  };
}

function seed(db) {
  const insertNode = db.prepare('INSERT INTO information_tree_nodes (workspace_id,id,value_json) VALUES (?,?,?)');
  const insertInfo = db.prepare('INSERT INTO information_tree_information_heads (workspace_id,source_id,node_id,source_version,event_at,source_at) VALUES (?,?,?,?,?,?)');
  const insertEdition = db.prepare('INSERT INTO information_tree_editions (workspace_id,id,value_json) VALUES (?,?,?)');
  const insertPeriod = db.prepare('INSERT INTO information_tree_heads (workspace_id,period_key,layer,start_at,published_id,attempt_id) VALUES (?,?,?,?,?,?)');
  const hourCount = 24;
  const perHour = 8;
  for (let hourIndex = 0; hourIndex < hourCount; hourIndex++) {
    const hour = START + hourIndex * HOUR;
    const ids = [];
    for (let item = 0; item < perHour; item++) {
      const sourceId = `source:${hourIndex}:${item}`;
      const version = createHash('sha256').update(sourceId).digest('hex');
      const id = `i:${version}`;
      const eventAt = hour + item + 1;
      insertNode.run('local', id, JSON.stringify({
        id, version, layer:'information', title:`标题${hourIndex}-${item}`, text:`MARKER_PROSE ${hourIndex}-${item}`, tagId:null,
        body:'正文'.repeat(1500), formatVersion:'article-normalize-v1', children:[], articleIds:[sourceId], sourceId,
        window:{startAt:hour, endAt:hour + HOUR}, generatedAt:hour, eventAt, sourceUpdatedAt:hour, sourceVersion:'1',
        validatorVersion:'tree-response-v3.1.0',
      }));
      insertInfo.run('local', sourceId, id, '1', eventAt, hour);
      ids.push(id);
    }
    const editionId = `edition:hour-${hourIndex}`;
    insertEdition.run('local', editionId, JSON.stringify({
      id: editionId, layer:'hourly', window:{startAt:hour, endAt:hour + HOUR}, timezone:'Asia/Shanghai',
      status: hourIndex === 3 ? 'partial' : 'ready', roots:[`module:${hourIndex}`], inputIds:ids,
      pendingIds: hourIndex === 3 ? ['source:late'] : [],
      pending: hourIndex === 3 ? [{id:'source:late', reason:'needs-content', retryable:false, retryAt:null}] : [],
      missingHours:[], generatedAt:hour + HOUR, padding:`PAD_EDITION${filler(hourIndex + 1, 40000)}`,
    }));
    insertPeriod.run('local', `hourly:${hour}:${hour + HOUR}`, 'hourly', hour, editionId, editionId);
  }
  for (let day = 0; day < 7; day++) {
    const start = START + day * DAY;
    const editionId = `edition:day-${day}`;
    insertEdition.run('local', editionId, JSON.stringify({
      id: editionId, layer:'daily', window:{startAt:start, endAt:start + DAY}, timezone:'Asia/Shanghai', status:'ready',
      roots:[`day-module:${day}`], inputIds:[`module:${day}`], pendingIds:[], missingHours:[], generatedAt:start + DAY,
      padding:`PAD_EDITION${filler(10_000 + day, 20000)}`,
    }));
    insertPeriod.run('local', `daily:${start}:${start + DAY}`, 'daily', start, editionId, editionId);
  }
  db.prepare('INSERT INTO information_tree_editorial_heads (workspace_id,period_key,published_id) VALUES (?,?,?)').run('local', `${START}:${START + DAY}`, 'editorial:ready');
  return {nodes: hourCount * perHour, hours: hourCount, days: 7};
}
