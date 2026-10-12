import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createStore} from '../packages/database/src/index.js';
import {runMigrations} from '../packages/database/src/migrations.js';
import {createInformationTreeRepository} from '../packages/database/src/repositories/information-tree-repository.js';
import {createReadingHourService} from '../packages/domain/src/reading-hour-service.js';
import {createReportJobHandlers} from '../packages/runtime/src/report-module.js';
import {normalizeReadingSemantics, readingPlacement, routeReadingFocus} from '../packages/domain/src/reading-focus-route.js';
import {ReadingHourIndexQuerySchema, ReadingHourIndexSchema, readingHourIndexDefaultWindow} from '../packages/contracts/src/information-tree.js';
import {ValidationError} from '../packages/contracts/src/errors.js';
import {createReportRoutes} from '../apps/web/src/routes/report-routes.js';

const catalogIds = new Set(['ai','market_cn','market_us','corporate_results','communications','software','ai_model']);
const window = {startAt: 10, endAt: 20};

test('domain ids are not information types, methods and margin balances stay on their questions', () => {
  const revenue = normalizeReadingSemantics({domainTagIds: ['ai','market_us','corporate_results'], informationTypes: ['corporate_results','market_us'], facts: [{text:'OpenAI营收未达预期'}], catalogIds});
  assert.equal(revenue.invalidTypes.includes('market_us'), true);
  assert.equal(revenue.partial, true);
  const unlabeled = routeReadingFocus({title:'特朗普与普京通话达成共识：俄罗斯将向美国供应柴油', facts:['两国领导人通话并同意供应柴油'], informationTypes:[]});
  assert.equal(unlabeled.status, 'missing');
  assert.deepEqual(unlabeled.questions, []);
  assert.deepEqual(routeReadingFocus({primaryDirection:'industry', subjectKind:'company_event', classificationStatus:'classified'}).groupIds, ['CO_EVENT']);
  assert.deepEqual(routeReadingFocus({primaryDirection:'finance', subjectKind:'unknown', classificationStatus:'classified'}).groupIds, ['FIN_POLICY','FIN_MARKET']);
  assert.deepEqual(routeReadingFocus({primaryDirection:'geopolitics', subjectKind:'geopolitics_event', classificationStatus:'classified'}).groupIds, ['GEO_SECURITY']);
  assert.equal(routeReadingFocus({primaryDirection:'other', subjectKind:'other', classificationStatus:'out-of-scope'}).routed, false);
  assert.equal(readingPlacement({primaryDirection:'finance', subjectKind:'market_asset', classificationStatus:'classified', title:'两市融资余额增加40.47亿元'}).readingThemeName, '中国');
  assert.equal(readingPlacement({primaryDirection:'ai', subjectKind:'ai_model_method', classificationStatus:'classified', title:'用低精度暂存加快输入处理'}).readingThemeName, '模型与技术');
});

test('scheduled hourly job scores the windows it generated', async () => {
  const calls = [];
  const handlers = createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {async generateHourlyDigests() { return [{id: 'edition:1', status: 'ready', published: true, window: {startAt: 10, endAt: 20}, pendingIds: [], groupFailures: []}]; }},
    treeService: {generateDaily() {}},
    readingHour: {enabled: true, async scoreWindow(input) { calls.push(input); return {readingErrors: []}; }},
  });
  const result = await handlers['report.hourly.extract']({});
  assert.deepEqual(calls, [{workspace: 'local', window: {startAt: 10, endAt: 20}, flushRemainder: true}]);
  assert.equal(result.readingFailed, false);
});

test('hourly classification waits while sources are still arriving and flushes after terminal content failures', async () => {
  const calls = [];
  const handlersFor = (pending) => createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {async generateHourlyDigests() {
      return [{id: 'edition:1', status: 'partial', published: true, window: {startAt: 10, endAt: 20}, pendingIds: pending.map((item) => item.id), pending, groupFailures: []}];
    }},
    treeService: {},
    readingHour: {enabled: true, async scoreWindow(input) { calls.push(input); return {readingErrors: []}; }},
  });
  await handlersFor([{id: 'later', reason: 'information-not-ready', retryable: false}])['report.hourly.extract']({});
  assert.equal(calls.at(-1).flushRemainder, false);
  await handlersFor([{id: 'gone', reason: 'needs-content', retryable: false}])['report.hourly.extract']({});
  assert.equal(calls.at(-1).flushRemainder, true);
});

test('reading snapshot survives reopen and a failed attempt cannot replace it', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'reading-hour-'));
  const file = path.join(directory, 'test.db');
  const first = createStore(file);
  const service = createReadingHourService({repository: first.repositories.informationTree, enabled: true, now: () => 5});
  const item = (title, scores, reviewed = true) => ({sourceId: title, sourceVersion: '1', nodeId: `n:${title}`, title, publisher: '来源', reviewed, semantic: {primaryDirection:'industry', subjectKind:'company_event', classificationStatus:'classified', domainTagIds: ['corporate_results'], informationTypes: [], facts: []}, scores});
  const published = service.publish('local', {window, timezone: 'Asia/Shanghai', scope: 'hour', questionVersion: '2026-10-10.4', catalogIds, items: [item('招联营收', {CO_EVENT: {status: 'scored', score: 0.8}}), {...item('未处理', {}, false), semantic: {}}]});
  assert.equal(published.published, true);
  assert.equal(published.snapshot.status, 'partial');
  assert.equal(published.snapshot.selected, 1);
  const failed = service.publish('local', {window, timezone: 'Asia/Shanghai', scope: 'hour', questionVersion: '2026-10-09.2', catalogIds, items: [item('空', {}, false)]});
  assert.equal(failed.published, false);
  assert.equal(failed.snapshot.id, published.snapshot.id);
  first.close();
  const second = createStore(file);
  const again = createReadingHourService({repository: second.repositories.informationTree, enabled: true});
  const read = again.forWindow('local', window, 'hour');
  assert.equal(read.id, published.snapshot.id);
  assert.equal(read.items[0].title, '招联营收');
  assert.equal(read.items[1].disposition, 'classification-missing');
  assert.equal(JSON.stringify(read).includes('semanticHints'), false);
  const replaced = again.publish('local', {window, timezone: 'Asia/Shanghai', scope: 'hour', questionVersion: '2026-10-10.4', catalogIds, items: [item('招联营收', {CO_EVENT: {status: 'scored', score: 0.91}})]});
  assert.equal(replaced.published, true);
  assert.notEqual(replaced.snapshot.id, published.snapshot.id);
  assert.equal(again.forWindow('local', window, 'hour').id, replaced.snapshot.id);
  assert.equal(again.get('local', published.snapshot.id).items[0].title, '招联营收');
  second.close();
});

test('reading hour index returns published hours, headline order, and rejects a bad window', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const repository = createInformationTreeRepository(db, () => {});
  repository.getNode = () => { throw new Error('index must not load nodes'); };
  repository.readingHourHead = () => { throw new Error('index must not load one head'); };
  const service = createReadingHourService({repository, enabled: true});
  const hour = 3600000;
  const start = 1_700_000_000_000;
  const insertSnapshot = (workspace, id, startAt, items, status = 'ready') => {
    const value = {
      id, status, scope: 'hour', routeVersion: 'reading-route-test', window: {startAt, endAt: startAt + hour},
      timezone: 'Asia/Shanghai', generatedAt: startAt + 90, scored: items.length, candidates: items.length + 1,
      selected: items.filter((item) => item.disposition === 'hit').length, groups: [], sections: [], items,
    };
    db.prepare('INSERT INTO reading_hour_snapshots (workspace_id,id,start_at,value_json) VALUES (?,?,?,?)').run(workspace, id, startAt, JSON.stringify(value));
    return value;
  };
  const items = [
    {nodeId: 'geo', title: '地缘在后', disposition: 'hit', readingDirectionName: '地缘政治', readingThemeName: '贸易与限制'},
    {nodeId: 'us', title: '美国金融', disposition: 'hit', readingDirectionName: '金融', readingThemeName: '美国'},
    {nodeId: 'pending', title: '待分类不算', disposition: 'hit', readingDirectionName: '待分类', readingThemeName: '其他'},
    {nodeId: 'oos', title: '越界不算', disposition: 'out-of-scope', readingDirectionName: '金融', readingThemeName: '中国'},
    {nodeId: 'cn-later', title: '中国金融后写', disposition: 'hit', readingDirectionName: '金融', readingThemeName: '中国'},
    {nodeId: 'cn-earlier', title: '中国金融先写', disposition: 'hit', readingDirectionName: '金融', readingThemeName: '中国'},
    {nodeId: 'industry', title: '产业', disposition: 'hit', readingDirectionName: '产业个股', readingThemeName: '韩国'},
    {nodeId: 'miss', title: '未命中', disposition: 'miss', readingDirectionName: '金融', readingThemeName: '中国'},
    {nodeId: 'plain', title: '金融无子类', disposition: 'hit', readingDirectionName: '金融', readingThemeName: ''},
    {nodeId: 'ai', title: '模型', disposition: 'hit', readingDirectionName: '科技与AI', readingThemeName: '模型与技术'},
  ];
  insertSnapshot('local', 'rh:published', start + hour, items, 'partial');
  insertSnapshot('local', 'rh:attempt-body', start + hour, [{nodeId: 'attempt', title: '失败尝试', disposition: 'hit', readingDirectionName: '金融', readingThemeName: '中国'}]);
  db.prepare('INSERT INTO reading_hour_heads (workspace_id,period_key,published_id,attempt_id) VALUES (?,?,?,?)').run('local', `${start + hour}:${start + 2 * hour}:hour`, 'rh:published', 'rh:attempt-body');
  insertSnapshot('local', 'rh:only-attempt', start + 2 * hour, [{nodeId: 'only', title: '只有尝试', disposition: 'hit', readingDirectionName: '金融', readingThemeName: '中国'}]);
  db.prepare('INSERT INTO reading_hour_heads (workspace_id,period_key,published_id,attempt_id) VALUES (?,?,?,?)').run('local', `${start + 2 * hour}:${start + 3 * hour}:hour`, null, 'rh:only-attempt');
  insertSnapshot('local', 'rh:empty-hits', start, [{nodeId: 'miss-only', title: '没有标题', disposition: 'miss', readingDirectionName: '金融', readingThemeName: '中国'}]);
  db.prepare('INSERT INTO reading_hour_heads (workspace_id,period_key,published_id,attempt_id) VALUES (?,?,?,?)').run('local', `${start}:${start + hour}:hour`, 'rh:empty-hits', 'rh:empty-hits');
  insertSnapshot('other', 'rh:other', start + hour, [{nodeId: 'other', title: '别的工作区', disposition: 'hit', readingDirectionName: '金融', readingThemeName: '中国'}]);
  db.prepare('INSERT INTO reading_hour_heads (workspace_id,period_key,published_id,attempt_id) VALUES (?,?,?,?)').run('other', `${start + hour}:${start + 2 * hour}:hour`, 'rh:other', 'rh:other');
  insertSnapshot('local', 'rh:day', start + hour, [{nodeId: 'day', title: '日范围', disposition: 'hit', readingDirectionName: '金融', readingThemeName: '中国'}]);
  db.prepare('INSERT INTO reading_hour_heads (workspace_id,period_key,published_id,attempt_id) VALUES (?,?,?,?)').run('local', `${start + hour}:${start + 2 * hour}:day`, 'rh:day', 'rh:day');

  const window = {startAt: start, endAt: start + 4 * hour};
  const index = service.indexForRange('local', window, 'hour');
  assert.equal(ReadingHourIndexSchema.safeParse(index).success, true);
  assert.deepEqual(index.hours.map((row) => row.id), ['rh:published', 'rh:empty-hits']);
  assert.deepEqual(index.hours[0], {
    startAt: start + hour, endAt: start + 2 * hour, id: 'rh:published', status: 'partial',
    scored: items.length, candidates: items.length + 1, selected: 8, headline: {nodeId: 'cn-later', title: '中国金融后写'}, generatedAt: start + hour + 90,
  });
  assert.equal(index.hours[1].headline, null);
  db.prepare('UPDATE reading_hour_snapshots SET value_json=? WHERE workspace_id=? AND id=?').run(JSON.stringify({id:'rh:published',status:'ready',window:{startAt:start+hour,endAt:start+2*hour},generatedAt:1,scored:1,candidates:1,selected:1,items:[{nodeId:'replaced',title:'不该出现',disposition:'hit',readingDirectionName:'金融',readingThemeName:'中国'}]}), 'local', 'rh:published');
  assert.equal(service.indexForRange('local', window, 'hour').hours[0].headline.nodeId, 'cn-later');
  assert.deepEqual(service.indexForRange('local', {startAt: start + 5 * hour, endAt: start + 6 * hour}, 'hour'), {hours: []});
  assert.equal(JSON.stringify(index).includes('失败尝试') || JSON.stringify(index).includes('只有尝试') || JSON.stringify(index).includes('别的工作区'), false);

  const route = createReportRoutes().find((item) => item.path === '/api/v1/reports/reading-hour/index');
  const seen = [];
  let status, body;
  const response = {writeHead(code) { status = code; }, end(value) { body = value; }};
  const services = {readingHour: {indexForRange(workspace, value, scope) { seen.push({workspace, value, scope}); return index; }}};
  route.handler({response, services, identity: {device: {workspaceId: 'phone'}}, url: new URL(`http://localhost/api/v1/reports/reading-hour/index?startAt=${start}&endAt=${start + 7 * 86400000}&scope=hour`)});
  assert.equal(status, 200);
  assert.deepEqual(seen[0], {workspace: 'phone', value: {startAt: start, endAt: start + 7 * 86400000}, scope: 'hour'});
  assert.equal(JSON.parse(body).ok, true);
  assert.equal(JSON.parse(body).hours[0].headline.nodeId, 'cn-later');
  route.handler({response, services, identity: {}, url: new URL(`http://localhost/api/v1/reports/reading-hour/index?startAt=${start}&endAt=${start + hour}`)});
  assert.equal(seen[1].workspace, 'local');
  assert.equal(seen[1].scope, 'hour');
  const fallback = readingHourIndexDefaultWindow();
  assert.deepEqual(ReadingHourIndexQuerySchema.parse({}), {...fallback, scope: 'hour'});
  route.handler({response, services, identity: {}, url: new URL('http://localhost/api/v1/reports/reading-hour/index')});
  assert.equal(status, 200);
  assert.deepEqual(seen[2], {workspace: 'local', value: fallback, scope: 'hour'});
  const reject = (query) => assert.throws(() => route.handler({response, services, identity: {}, url: new URL(`http://localhost/api/v1/reports/reading-hour/index?${query}`)}), ValidationError);
  reject('startAt=no&endAt=10');
  reject(`startAt=${start}&endAt=${start}`);
  reject(`startAt=${start}`);
  reject(`startAt=${start}&endAt=${start + 7 * 86400000 + 1}`);
  reject(`startAt=-1&endAt=${start}`);
  db.close();
});

test('a source older than one day is marked untimely', () => {
  const endAt = 1000 + 24 * 60 * 60 * 1000;
  const snapshot = {id: 'rh:time', status: 'partial', scope: 'hour', routeVersion: 'reading-route-2026-10-10.4', window: {startAt: 1000, endAt}, timezone: 'Asia/Shanghai', generatedAt: endAt, scored: 1, candidates: 1, selected: 1, groups: [], sections: [], items: [{sourceId: 's', sourceVersion: '1', nodeId: 'n1', title: '旧闻', disposition: 'hit', hits: [], readingDirectionName: '金融', readingThemeName: '其他'}]};
  const repository = {getReadingHour: () => snapshot, getNode: () => ({sourceRefs: [{type: 'content-item', id: 'c1'}]})};
  const stale = createReadingHourService({repository, enabled: true, publishedAtFor: () => endAt - 24 * 60 * 60 * 1000 - 1});
  const fresh = createReadingHourService({repository, enabled: true, publishedAtFor: () => endAt - 60 * 60 * 1000});
  const unknown = createReadingHourService({repository, enabled: true, publishedAtFor: () => null});
  assert.equal(stale.get('local', 'rh:time').items[0].timely, false);
  assert.equal(fresh.get('local', 'rh:time').items[0].timely, true);
  assert.equal(fresh.get('local', 'rh:time').items[0].publishedAt, endAt - 60 * 60 * 1000);
  assert.equal(unknown.get('local', 'rh:time').items[0].timely, true);
  assert.equal(unknown.get('local', 'rh:time').items[0].publishedAt, null);
  assert.equal(unknown.get('local', 'rh:time').items[0].firstIngestedAt, null);
});

test('present fills an empty publisher from the source ref', () => {
  const endAt = 1000 + 60 * 60 * 1000;
  const snapshot = {id: 'rh:pub', status: 'partial', scope: 'hour', routeVersion: 'reading-route-2026-10-10.4', window: {startAt: 1000, endAt}, timezone: 'Asia/Shanghai', generatedAt: endAt, scored: 1, candidates: 1, selected: 1, groups: [], sections: [], items: [{sourceId: 's', sourceVersion: '1', nodeId: 'n1', title: '来源待补', disposition: 'hit', hits: [], publisher: '', readingDirectionName: '金融', readingThemeName: '美国'}]};
  const repository = {getReadingHour: () => snapshot, getNode: () => ({publisher: '', sourceRefs: [{type: 'content-item', id: 'c1'}]})};
  const service = createReadingHourService({repository, enabled: true, publisherFor: (_workspace, refs) => refs?.[0]?.id === 'c1' ? 'The Decoder' : ''});
  assert.equal(service.view(snapshot).items[0].publisher, '');
  assert.equal(service.get('local', 'rh:pub').items[0].publisher, 'The Decoder');
  const stored = {...snapshot, items: [{...snapshot.items[0], publisher: '已保存来源'}]};
  const kept = createReadingHourService({repository: {getReadingHour: () => stored, getNode: () => ({publisher: '', sourceRefs: [{type: 'content-item', id: 'c1'}]})}, enabled: true, publisherFor: () => 'The Decoder'});
  assert.equal(kept.view(stored).items[0].publisher, '已保存来源');
  assert.equal(kept.get('local', 'rh:pub').items[0].publisher, '已保存来源');
});
