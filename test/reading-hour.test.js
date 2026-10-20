import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createStore} from '../packages/database/src/index.js';
import {runMigrations} from '../packages/database/src/migrations.js';
import {createInformationTreeRepository} from '../packages/database/src/repositories/information-tree-repository.js';
import {createReadingHourService, readingHourSourceAccess} from '../packages/domain/src/reading-hour-service.js';
import {actionablePendingCount, classificationDeferredCount, createReportJobHandlers, enqueueHourlyExtractFollowUp, enqueueHourlyPendingPreparation, formatHourlyPendingBreakdown, hourlyFollowUpPlan, hourlyPendingSweepPlan, hourlyRefreshAvailableAt, hourlyRunningSameVersion, hourlySweepHours} from '../packages/runtime/src/report-module.js';
import {normalizeReadingSemantics, readingPlacement, routeReadingFocus} from '../packages/domain/src/reading-focus-route.js';
import {emptyReadingHourPayload, ReadingHourEmptySchema, ReadingHourIndexQuerySchema, ReadingHourIndexSchema, readingHourIndexDefaultWindow} from '../packages/contracts/src/information-tree.js';
import {ValidationError} from '../packages/contracts/src/errors.js';
import {createReportRoutes} from '../apps/web/src/routes/report-routes.js';

const catalogIds = new Set(['ai','market_cn','market_us','corporate_results','communications','software','ai_model']);
const window = {startAt: 10, endAt: 20};

test('an hour without a snapshot is an empty reading payload', () => {
  const payload = emptyReadingHourPayload();
  assert.equal(ReadingHourEmptySchema.safeParse(payload).success, true);
  assert.equal(payload.ok, true);
  assert.equal(payload.empty, true);
  assert.equal(payload.snapshot, null);
  assert.equal(payload.message, '这一小时没有内容');
  assert.equal(ReadingHourEmptySchema.safeParse({...payload, snapshot: {id: 'rh'}}).success, false);
});

test('reading hour batch facts keep the first content author', () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    function save(externalId, nativeId, name) {
      const capture = feed.saveCapture({
        workspaceId: 'local', provider: 'xueqiu', externalId,
        sourceUrl: `https://xueqiu.com/${nativeId}/${externalId}`,
        title: name, contentHash: `hash-${externalId}`, publishedAt: 40,
        authorNativeId: nativeId,
        metadata: { authorHandle: name, authorProfile: { nativeId, name, handle: name } },
      });
      return feed.saveContentItem({
        workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
        title: `${name}的标题`, body: name, sourceUrl: capture.sourceUrl, authorName: name, publishedAt: 40,
      });
    }
    const first = save('post-1', '100', '甲');
    const second = save('post-2', '200', '乙');
    let briefCalls = 0;
    let singleReads = 0;
    const wrapped = {
      listContentItemBriefs(...args) { briefCalls += 1; return feed.listContentItemBriefs(...args); },
      listContentSourceNames(...args) { return feed.listContentSourceNames(...args); },
      getContentItem(...args) { singleReads += 1; return feed.getContentItem(...args); },
    };
    const access = readingHourSourceAccess({ feed: wrapped });
    const refs = [{ type: 'content-item', id: first.id }, { type: 'content-item', id: second.id }];
    const context = access.sourceContextFor('local', refs);
    const facts = context.factsFor(refs);
    assert.equal(briefCalls, 1);
    assert.equal(singleReads, 0);
    assert.equal(facts.author, '甲');
    assert.equal(facts.authorId, 'xueqiu:100');
    assert.equal(facts.titles[0], '甲的标题');
    assert.equal(context.factsFor([refs[1]]).authorId, 'xueqiu:200');
    assert.equal(briefCalls, 1);
  } finally {
    store.close();
  }
});

test('domain ids are not information types, methods and margin balances stay on their questions', () => {
  const revenue = normalizeReadingSemantics({domainTagIds: ['ai','market_us','corporate_results'], informationTypes: ['corporate_results','market_us'], facts: [{text:'OpenAI营收未达预期'}], catalogIds});
  assert.equal(revenue.invalidTypes.includes('market_us'), true);
  assert.equal(revenue.partial, true);
  const unlabeled = routeReadingFocus({title:'特朗普与普京通话达成共识：俄罗斯将向美国供应柴油', facts:['两国领导人通话并同意供应柴油'], informationTypes:[]});
  assert.equal(unlabeled.status, 'missing');
  assert.deepEqual(unlabeled.questions, []);
  assert.deepEqual(routeReadingFocus({primaryDirection:'industry', subjectKind:'company_event', classificationStatus:'classified'}).groupIds, ['CO_EVENT','FIN_MARKET']);
  assert.deepEqual(routeReadingFocus({primaryDirection:'finance', subjectKind:'market_asset', classificationStatus:'classified'}).groupIds, ['FIN_MARKET','CO_EVENT']);
  assert.deepEqual(routeReadingFocus({primaryDirection:'finance', subjectKind:'unknown', classificationStatus:'classified'}).groupIds, ['FIN_POLICY','FIN_MARKET']);
  assert.deepEqual(routeReadingFocus({primaryDirection:'geopolitics', subjectKind:'geopolitics_event', classificationStatus:'classified'}).groupIds, ['GEO_SECURITY']);
  assert.equal(routeReadingFocus({primaryDirection:'other', subjectKind:'other', classificationStatus:'out-of-scope'}).routed, false);
  assert.equal(readingPlacement({primaryDirection:'finance', subjectKind:'market_asset', classificationStatus:'classified', title:'两市融资余额增加40.47亿元'}).readingThemeName, '中国');
  assert.equal(readingPlacement({primaryDirection:'ai', subjectKind:'ai_model_method', classificationStatus:'classified', title:'用低精度暂存加快输入处理'}).readingThemeName, '模型与技术');
});

test('a second hourly extract for the same version waits instead of overlapping', async () => {
  assert.equal(hourlyRunningSameVersion([
    { id: 'job-a', status: 'running', workspaceId: 'local', input: { hourStart: 10 } },
  ], { id: 'job-b', workspaceId: 'local', hourStart: 10 }), true);
  assert.equal(hourlyRunningSameVersion([
    { id: 'job-a', status: 'running', workspaceId: 'local', input: {} },
  ], { id: 'job-b', workspaceId: 'local' }), true);
  assert.equal(hourlyRunningSameVersion([
    { id: 'job-a', status: 'running', workspaceId: 'local', input: { hourStart: 10 } },
  ], { id: 'job-a', workspaceId: 'local', hourStart: 10 }), false);
  const calls = [];
  const handlers = createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {async generateHourlyDigests() { calls.push('run'); return [{id: 'edition:1', status: 'ready', published: true, window: {startAt: 10, endAt: 20}, pendingIds: [], groupFailures: []}]; }},
    treeService: {},
  });
  const hourStart = 1_728_000_000_000;
  const skipped = await handlers['report.hourly.extract']({hourStart, workspaceId: 'local'}, {
    job: {id: 'job-b'},
    store: {listOpenJobs: () => [{id: 'job-a', type: 'report.hourly.extract', status: 'running', workspaceId: 'local', input: {hourStart}}]},
  });
  assert.equal(skipped.reason, 'already-running');
  assert.equal(calls.length, 0);
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

test('a partial hour refreshes inside the hour after its slot, and deferred classification gets one later pass', async () => {
  const hour = 22 * 3600000;
  const pastSlot = hour + 30 * 60000 + 5000;
  assert.equal(hourlyRefreshAvailableAt(pastSlot, 30), pastSlot + 60000);
  assert.equal(hourlyRefreshAvailableAt(hour + 10 * 60000, 30), hour + 30 * 60000);
  assert.equal(hourlyRefreshAvailableAt(pastSlot, null), pastSlot + 60000);
  assert.equal(classificationDeferredCount({snapshot: {items: [{disposition: 'classification-failed'}, {disposition: 'classification-missing'}, {disposition: 'budget-deferred'}]}}), 2);
  assert.equal(classificationDeferredCount({snapshot: {items: [{disposition: 'hit'}]}}), 0);

  const jobs = [];
  const store = {
    listOpenJobs() { return jobs.filter((job) => job.status === 'queued'); },
    createJob(input) {
      const job = {id: `job-${jobs.length}`, status: 'queued', workspaceId: input.workspaceId, type: input.type, availableAt: input.availableAt, input: input.input};
      jobs.push(job);
      return job;
    },
  };
  const handlers = createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {async generateHourlyDigests() {
      return [{id: 'edition:1', status: 'partial', published: true, window: {startAt: hour, endAt: hour + 3600000}, pendingIds: [], groupFailures: []}];
    }},
    treeService: {},
    readingHour: {enabled: true, async scoreWindow() {
      return {readingErrors: [], snapshot: {items: [{disposition: 'classification-failed'}, {disposition: 'classification-missing'}, {disposition: 'hit'}]}};
    }},
  });
  const before = Date.now();
  const result = await handlers['report.hourly.extract']({hourStart: hour}, {store});
  assert.equal(result.classificationDeferred, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].input.hourStart, hour);
  assert.equal(jobs[0].input.followUp, 'classification-deferred');
  assert.ok(jobs[0].availableAt >= before + 60000 && jobs[0].availableAt <= Date.now() + 60000);
  const again = await handlers['report.hourly.extract']({hourStart: hour, followUp: 'classification-deferred'}, {store});
  assert.equal(again.classificationDeferred, 1);
  assert.equal(jobs.length, 1);
  assert.equal(enqueueHourlyExtractFollowUp(store, {workspaceId: 'local', hourStart: hour, availableAt: before + 60000}), null);
});

test('a scheduled follow-up stays on the primary hour when a backfill hour still has classification failures', async () => {
  const primary = 1791817200000;
  const backfill = 1791806400000;
  const hourMs = 3600000;
  const jobs = [];
  const store = {
    listOpenJobs() { return jobs.filter((job) => job.status === 'queued'); },
    createJob(input) {
      const job = {id: `job-${jobs.length}`, status: 'queued', workspaceId: input.workspaceId, priority: input.priority, type: input.type, input: input.input, availableAt: input.availableAt};
      jobs.push(job);
      return job;
    },
  };
  const edition = (startAt, pendingIds) => ({
    id: `edition:${startAt}`, status: pendingIds.length ? 'partial' : 'ready', published: true,
    window: {startAt, endAt: startAt + hourMs}, pendingIds, pending: pendingIds.map((id) => ({id, reason: 'information-not-ready', retryable: false})), groupFailures: [],
  });
  const handlers = createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {async generateHourlyDigests() {
      return [edition(primary, Array.from({length: 10}, (_, index) => `pending-${index}`)), edition(backfill, [])];
    }},
    treeService: {},
    readingHour: {enabled: true, async scoreWindow(input) {
      if (input.window.startAt === backfill) return {readingErrors: [], snapshot: {items: [{disposition: 'classification-failed'}]}};
      return {readingErrors: [], snapshot: {items: [{disposition: 'hit'}]}};
    }},
  });
  assert.deepEqual(hourlyFollowUpPlan({
    digests: [edition(primary, ['a']), edition(backfill, [])],
    deferredByStart: new Map([[backfill, 4]]),
  }), {hourStart: primary, reason: 'edition-pending', pendingCount: 1, deferred: 0});
  const result = await handlers['report.hourly.extract']({}, {store});
  assert.equal(result.pendingCount, 10);
  assert.equal(result.window.startAt, primary);
  const hourlyJobs = jobs.filter((job) => job.input.followUp);
  const prepJobs = jobs.filter((job) => Array.isArray(job.input.sourceIds));
  assert.equal(hourlyJobs.length, 1);
  assert.equal(hourlyJobs[0].input.hourStart, primary);
  assert.equal(hourlyJobs[0].input.followUp, 'edition-pending');
  assert.equal(hourlyJobs[0].input.hourStart === backfill, false);
  assert.equal(prepJobs.length, 10);
  assert.equal(prepJobs.every((job) => job.priority === 30), true);
  await handlers['report.hourly.extract']({hourStart: primary, followUp: 'edition-pending'}, {store});
  assert.equal(jobs.filter((job) => job.input.followUp).length, 1);
  assert.equal(jobs.filter((job) => Array.isArray(job.input.sourceIds)).length, 10);
});

test('a scheduled run rotates leftover hours inside the window and does not chain', async () => {
  const hourMs = 3600000;
  const primary = 1791820800000;
  const recent = primary - hourMs;
  const deferredHour = primary - 2 * hourMs;
  const older = primary - 4 * hourMs;
  const tooOld = primary - 6 * hourMs;
  assert.equal(hourlySweepHours({}), 6);
  assert.equal(hourlySweepHours({AI_CENTER_HOURLY_SWEEP_HOURS: ''}), 6);
  assert.equal(hourlySweepHours({AI_CENTER_HOURLY_SWEEP_HOURS: '0'}), 0);
  assert.equal(hourlySweepHours({AI_CENTER_HOURLY_SWEEP_HOURS: '99'}), 6);
  const rows = [
    {hourStart: primary, pendingCount: 3, deferred: 0},
    {hourStart: recent, pendingCount: 10, deferred: 0},
    {hourStart: deferredHour, pendingCount: 0, deferred: 1},
    {hourStart: older, pendingCount: 1, deferred: 0},
    {hourStart: tooOld, pendingCount: 4, deferred: 0},
  ];
  const firstSweep = [deferredHour, older];
  const nextSweep = [recent, deferredHour];
  assert.deepEqual(hourlyPendingSweepPlan({
    scheduled: true, primaryHour: primary, rows, windowHours: 6, limit: 2,
  }).map((item) => item.hourStart), firstSweep);
  assert.deepEqual(hourlyPendingSweepPlan({
    scheduled: true, primaryHour: primary + hourMs, rows, windowHours: 6, limit: 2,
  }).map((item) => item.hourStart), nextSweep);
  assert.equal(firstSweep.includes(older) || nextSweep.includes(older), true);
  assert.equal(firstSweep.every((hour) => hour === recent || hour === deferredHour) && nextSweep.every((hour) => hour === recent || hour === deferredHour), false);
  assert.deepEqual(hourlyPendingSweepPlan({
    scheduled: true, primaryHour: primary, rows, windowHours: 6, limit: 2, openHourStarts: new Set([recent]),
  }).map((item) => item.hourStart), [deferredHour, older]);
  assert.deepEqual(hourlyPendingSweepPlan({
    scheduled: true, primaryHour: primary, rows, windowHours: 6, limit: 4,
  }).map((item) => item.hourStart), [deferredHour, older, recent]);
  assert.deepEqual(hourlyPendingSweepPlan({scheduled: false, primaryHour: primary, rows}), []);
  assert.deepEqual(hourlyPendingSweepPlan({scheduled: true, followUp: 'edition-pending-sweep', primaryHour: primary, rows}), []);
  assert.equal(hourlyFollowUpPlan({
    requestedHour: primary,
    digests: [{window: {startAt: primary}, pendingIds: ['dead'], pending: [{id: 'dead', reason: 'needs-content', retryable: false}]}],
  }), null);
  assert.equal(actionablePendingCount({pendingIds: ['dead', 'wait'], pending: [{id: 'dead', reason: 'prep-exhausted'}, {id: 'wait', reason: 'information-not-ready'}]}), 1);

  const jobs = [];
  const store = {
    listOpenJobs() { return jobs.filter((job) => job.status === 'queued' || job.status === 'running'); },
    createJob(input) {
      const job = {id: `job-${jobs.length}`, status: 'queued', workspaceId: input.workspaceId, priority: input.priority, input: input.input, availableAt: input.availableAt};
      jobs.push(job);
      return job;
    },
  };
  const pending = (startAt, count) => ({
    edition: {window: {startAt, endAt: startAt + hourMs}, pendingIds: Array.from({length: count}, (_, index) => `p-${startAt}-${index}`)},
  });
  const handlers = createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {
      async generateHourlyDigests() {
        return [{id: 'edition:primary', status: 'partial', published: true, window: {startAt: primary, endAt: primary + hourMs}, pendingIds: ['now-1', 'now-2'], groupFailures: []}];
      },
      list(_workspace, window) {
        return {hours: [pending(primary, 2), pending(recent, 10), pending(older, 1), pending(tooOld, 4)].filter((slot) => slot.edition.window.startAt >= window.startAt && slot.edition.window.startAt < window.endAt)};
      },
    },
    treeService: {},
    readingHour: {
      enabled: true,
      async scoreWindow() { return {readingErrors: [], snapshot: {items: [{disposition: 'hit'}]}}; },
      forWindow(_workspace, window) {
        if (window.startAt === deferredHour) return {snapshot: {items: [{disposition: 'classification-failed'}]}};
        return {snapshot: {items: [{disposition: 'hit'}]}};
      },
    },
    env: {AI_CENTER_HOURLY_SWEEP_HOURS: '6', AI_CENTER_HOURLY_SWEEP_LIMIT: '2'},
  });
  const result = await handlers['report.hourly.extract']({}, {store});
  assert.equal(result.pendingCount, 2);
  assert.equal(result.window.startAt, primary);
  assert.deepEqual(jobs.filter((job) => job.input.followUp).map((job) => [job.input.hourStart, job.input.followUp, job.priority]), [
    [primary, 'edition-pending', 10],
    [deferredHour, 'edition-pending-sweep', -5],
    [older, 'edition-pending-sweep', -5],
  ]);
  assert.deepEqual(jobs.filter((job) => job.input.sourceIds).map((job) => [job.input.sourceIds[0], job.priority]), [
    ['now-1', 30],
    ['now-2', 30],
  ]);
  assert.equal(jobs.some((job) => job.input.hourStart === tooOld || job.input.hourStart === recent), false);
  const hourlyJobs = jobs.filter((job) => job.input.followUp);
  assert.ok(hourlyJobs[1].availableAt >= hourlyJobs[0].availableAt);
  assert.ok(jobs.filter((job) => job.input.sourceIds).every((job) => job.availableAt <= hourlyJobs[0].availableAt));
  const before = jobs.length;
  await handlers['report.hourly.extract']({hourStart: recent, followUp: 'edition-pending-sweep'}, {store});
  assert.equal(jobs.length, before);
});

test('a follow-up logs the pending breakdown and admits preparation without passing the current hour', async () => {
  const hour = 1791817200000;
  const logs = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  const jobs = [];
  const prioritized = [];
  const openPrep = [
    {id: 'running', status: 'running', workspaceId: 'local', priority: 0, input: {sourceIds: ['run']}},
    {id: 'queued-low', status: 'queued', workspaceId: 'local', priority: 0, input: {sourceIds: ['low']}},
    {id: 'queued-current', status: 'queued', workspaceId: 'local', priority: 30, input: {sourceIds: ['current']}},
  ];
  const store = {
    listOpenJobs(type) {
      if (type === 'report.information.prepare') return [...openPrep, ...jobs.filter((job) => job.type === type)];
      return jobs.filter((job) => job.status === 'queued' || job.status === 'running');
    },
    prioritizeQueuedJobs(_workspace, ids, priority) {
      prioritized.push([ids, priority]);
      return ids.filter((id) => id === 'queued-low');
    },
    createJob(input) {
      const job = {id: `job-${jobs.length}`, status: 'queued', workspaceId: input.workspaceId, priority: input.priority, type: input.type, input: input.input, availableAt: input.availableAt};
      jobs.push(job);
      return job;
    },
  };
  const pending = [
    {id: 'miss', reason: 'information-not-ready', retryable: false, retryAt: null},
    {id: 'run', reason: 'information-not-ready', retryable: false, retryAt: null},
    {id: 'low', reason: 'information-not-ready', retryable: false, retryAt: null},
    {id: 'current', reason: 'information-not-ready', retryable: false, retryAt: null},
    {id: 'dead', reason: 'needs-content', retryable: false, retryAt: null},
    {id: 'stopped', reason: 'prep-exhausted', retryable: false, retryAt: null},
  ];
  const handlers = createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {async generateHourlyDigests() {
      return [{id: 'edition:1', status: 'partial', published: true, window: {startAt: hour, endAt: hour + 3600000}, pendingIds: ['miss', 'run', 'low', 'current'], pending, groupFailures: []}];
    }},
    treeService: {},
  });
  try {
    const direct = enqueueHourlyPendingPreparation(store, {digests: [{pending}], followUp: 'edition-pending'});
    assert.equal(direct.enqueued, 1);
    assert.equal(direct.missing, 1);
    assert.equal(direct.running, 1);
    assert.equal(direct.queued, 2);
    assert.deepEqual(jobs.map((job) => [job.input.sourceIds[0], job.priority]), [['miss', 10]]);
    assert.deepEqual(prioritized, [[['queued-low'], 10]]);
    jobs.length = 0;
    prioritized.length = 0;
    const result = await handlers['report.hourly.extract']({hourStart: hour, followUp: 'edition-pending'}, {store});
    assert.equal(result.pendingCount, 4);
    assert.equal(jobs.some((job) => job.input.followUp), false);
    assert.deepEqual(jobs.map((job) => [job.type, job.input.sourceIds?.[0], job.priority]), [['report.information.prepare', 'miss', 10]]);
    assert.equal(prioritized.some((entry) => entry[0].includes('queued-current')), false);
    const line = logs.find((entry) => entry.startsWith('[worker] hourly-pending'));
    assert.equal(line, formatHourlyPendingBreakdown({
      hourStart: hour,
      followUp: 'edition-pending',
      pending,
      prep: {queued: 2, running: 1, missing: 1, enqueued: 1, prioritized: 1},
    }));
    assert.match(line, /information-not-ready=4/);
    assert.match(line, /needs-content=1/);
    assert.match(line, /prep-exhausted=1/);
  } finally {
    console.log = original;
  }
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

test('reading hour index returns published hours, headline order, and rejects a bad window', async () => {
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

  const offthread = {async build(task) {
    const payload = task.kind === 'reading-hour'
      ? {ok: true, snapshot: {id: 'rh:published', items: [{title: '中国金融后写'}]}}
      : {ok: true, hours: index.hours};
    const raw = Buffer.from(JSON.stringify(payload));
    return {status: 200, prepared: {json: raw, gzipped: null, etag: 'W/"hour"', bytes: raw.length}};
  }};
  const route = createReportRoutes({offthread}).find((item) => item.path === '/api/v1/reports/reading-hour/index');
  const seen = [];
  let status, body;
  const response = {writeHead(code) { status = code; }, end(value) { body = value; }};
  const services = {readingHour: {indexForRange(workspace, value, scope) { seen.push({workspace, value, scope}); return index; }}};
  await route.handler({request: {headers: {}}, response, services, identity: {device: {workspaceId: 'phone'}}, url: new URL(`http://localhost/api/v1/reports/reading-hour/index?startAt=${start}&endAt=${start + 7 * 86400000}&scope=hour`)});
  assert.equal(status, 200);
  assert.equal(seen.length, 0);
  assert.equal(JSON.parse(Buffer.from(body).toString('utf8')).hours[0].id, 'rh:published');
  await route.handler({request: {headers: {}}, response, services, identity: {}, url: new URL(`http://localhost/api/v1/reports/reading-hour/index?startAt=${start}&endAt=${start + hour}`)});
  assert.equal(seen.length, 0);
  const fallback = readingHourIndexDefaultWindow();
  assert.deepEqual(ReadingHourIndexQuerySchema.parse({}), {...fallback, scope: 'hour'});
  await route.handler({request: {headers: {}}, response, services, identity: {}, url: new URL('http://localhost/api/v1/reports/reading-hour/index')});
  assert.equal(status, 200);
  assert.equal(seen.length, 0);
  assert.equal(JSON.parse(Buffer.from(body).toString('utf8')).hours[0].id, 'rh:published');
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
