import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createStore} from '../packages/database/src/index.js';
import {createReadingHourService} from '../packages/domain/src/reading-hour-service.js';
import {createReportJobHandlers} from '../packages/runtime/src/report-module.js';
import {normalizeReadingSemantics, readingPlacement, routeReadingFocus} from '../packages/domain/src/reading-focus-route.js';

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
  assert.deepEqual(calls, [{workspace: 'local', window: {startAt: 10, endAt: 20}}]);
  assert.equal(result.readingFailed, false);
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

test('a source older than one day is marked untimely', () => {
  const endAt = 1000 + 24 * 60 * 60 * 1000;
  const snapshot = {id: 'rh:time', status: 'partial', scope: 'hour', routeVersion: 'reading-route-2026-10-10.4', window: {startAt: 1000, endAt}, timezone: 'Asia/Shanghai', generatedAt: endAt, scored: 1, candidates: 1, selected: 1, groups: [], sections: [], items: [{sourceId: 's', sourceVersion: '1', nodeId: 'n1', title: '旧闻', disposition: 'hit', hits: [], readingDirectionName: '金融', readingThemeName: '其他'}]};
  const repository = {getReadingHour: () => snapshot, getNode: () => ({sourceRefs: [{type: 'content-item', id: 'c1'}]})};
  const stale = createReadingHourService({repository, enabled: true, publishedAtFor: () => endAt - 24 * 60 * 60 * 1000 - 1});
  const fresh = createReadingHourService({repository, enabled: true, publishedAtFor: () => endAt - 60 * 60 * 1000});
  const unknown = createReadingHourService({repository, enabled: true, publishedAtFor: () => null});
  assert.equal(stale.get('local', 'rh:time').items[0].timely, false);
  assert.equal(fresh.get('local', 'rh:time').items[0].timely, true);
  assert.equal(unknown.get('local', 'rh:time').items[0].timely, true);
});
