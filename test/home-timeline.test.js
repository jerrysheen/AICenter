import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HOME_QUOTE_PRIORITY,
  preferredOverviewFocus,
  pickHomeQuoteCards,
  foldOfficialByHour,
  nextEvents,
  hourCoverage,
  visibleHourGaps,
  homeRequestPlan,
  homeEditionNote,
  HOME_RECENT_EDITION_HOURS,
  shanghaiMidnight,
  shanghaiHourStart,
  readingTitles,
  buildHomeTimelineModel,
  mergeReadingHours,
  homeHourSections,
  hourlyEditions,
  selectHomeHourHits,
  homeHourItemTime,
  homeHourPublishedNote,
  unavailableOfficialCount,
  CHRONIC_UNAVAILABLE_MS,
  acceptMarketPayload,
  marketPayloadHasQuotes,
} from '../apps/web/public/home-timeline.js';

const saturdayMorning = Date.parse('2026-10-10T02:00:00Z');
const fridayMorning = Date.parse('2026-10-09T02:00:00Z');
const fridayEvening = Date.parse('2026-10-09T10:00:00Z');

test('home quote cards follow the Shanghai session, including Saturday', () => {
  assert.equal(preferredOverviewFocus(saturdayMorning), 'us');
  assert.equal(preferredOverviewFocus(fridayMorning), 'cn');
  assert.equal(preferredOverviewFocus(fridayEvening), 'us');
  const us = [
    { symbol: '^GSPC', name: '标普 500', lastPrice: 1, changePct: 0.1 },
    { symbol: '^DJI', name: '道琼斯', lastPrice: 2, changePct: -0.2 },
    { symbol: '^IXIC', name: '纳斯达克', lastPrice: 3, changePct: 0.3 },
    { symbol: '^SOX', name: '费城半导体', lastPrice: 4, changePct: 0.4 },
    { symbol: '^VIX', name: 'VIX 恐慌', lastPrice: 5, changePct: -0.5 },
  ];
  assert.deepEqual(
    pickHomeQuoteCards({ focus: preferredOverviewFocus(saturdayMorning), indices: us, sectionIndices: us }).map((item) => item.symbol),
    ['^GSPC', '^IXIC', '^DJI', '^VIX'],
  );
  const cn = [
    ...HOME_QUOTE_PRIORITY.cn.map((symbol) => ({ symbol, name: symbol, lastPrice: 1, changePct: 0 })),
    { symbol: '^HSTECH', name: '恒生科技', lastPrice: 1, changePct: 0 },
  ];
  assert.deepEqual(
    pickHomeQuoteCards({ focus: preferredOverviewFocus(fridayMorning), indices: cn, sectionIndices: cn }).map((item) => item.symbol),
    ['000016.SS', '399673.SZ', '000688.SS', '^HSI'],
  );
  const missingVix = us.filter((item) => item.symbol !== '^VIX');
  assert.deepEqual(
    pickHomeQuoteCards({ focus: 'us', indices: missingVix, sectionIndices: missingVix }).map((item) => item.symbol),
    ['^GSPC', '^IXIC', '^DJI', '^SOX'],
  );
  const loading = pickHomeQuoteCards({ focus: 'us', indices: [] });
  assert.deepEqual(loading.map((item) => item.symbol), HOME_QUOTE_PRIORITY.us);
  assert.equal(loading.every((item) => item.lastPrice == null && item.changePct == null), true);
});

test('official releases in the same hour fold into one line', () => {
  const midnight = shanghaiMidnight(saturdayMorning);
  const hour = midnight + 10 * 3_600_000;
  const groups = foldOfficialByHour([
    { title: '甲', publishedAt: hour + 1_000, authority: '美联储' },
    { title: '乙', publishedAt: hour + 2_000, authority: '美联储' },
    { title: '丙', publishedAt: hour + 3_000, authority: '白宫' },
    { title: '丁', publishedAt: hour + 3_600_000 + 1_000, authority: '央行' },
  ]);
  assert.equal(groups.length, 2);
  const sameHour = groups.find((group) => group.startAt === hour);
  assert.equal(sameHour.text, '官方 · 美联储 2 条 · 白宫 1 条');
  assert.equal(sameHour.items.length, 3);
  assert.equal(groups.find((group) => group.startAt !== hour).text, '官方 · 央行 1 条');
});

test('upcoming home rows keep at most two events inside the next 24 hours', () => {
  const now = 1_700_000_000_000;
  const events = [
    { title: 'past', scheduledAt: now - 1 },
    { title: 'soon', scheduledAt: now + 1_000 },
    { title: 'later', scheduledAt: now + 2_000 },
    { title: 'third', scheduledAt: now + 3_000 },
    { title: 'far', scheduledAt: now + 25 * 3_600_000 },
  ];
  assert.deepEqual(nextEvents(events, now).map((event) => event.title), ['soon', 'later']);
});

test('missing hours collapse to a time range without a delay status line', () => {
  const midnight = shanghaiMidnight(saturdayMorning);
  const at = (hour) => midnight + hour * 3_600_000;
  const now = at(14) + 30 * 60 * 1000;
  const editions = [8, 9, 11].map((hour) => ({ window: { startAt: at(hour), endAt: at(hour + 1) } }));
  const coverage = hourCoverage({ editions, nowMs: now });
  assert.equal(coverage.delay.hours, 2);
  assert.equal(Object.hasOwn(coverage.delay, 'text'), false);
  assert.equal(coverage.gaps.some((gap) => gap.count === 2 && gap.text === '12:00–14:00'), true);
  assert.equal(coverage.gaps.filter((gap) => gap.count === 2).length, 1);
  assert.equal(coverage.gaps.every((gap) => !gap.text.includes('未生成')), true);
  const visible = visibleHourGaps(coverage, editions.filter((edition) => edition.window.startAt >= at(11)));
  assert.equal(visible.some((gap) => gap.count === 2 && gap.text === '12:00–14:00'), true);
  assert.equal(visible.every((gap) => !gap.text.includes('未生成')), true);
});

test('index headlines stay hidden until reading snapshots arrive', () => {
  const midnight = shanghaiMidnight(saturdayMorning);
  const at = (hour) => midnight + hour * 3_600_000;
  const edition = (hour) => ({ window: { startAt: at(hour), endAt: at(hour + 1) } });
  const pending = buildHomeTimelineModel({
    nowMs: at(16),
    editions: [14, 13, 12].map(edition),
    readings: {
      [at(14)]: { selected: 1, headline: { title: '索引甲' } },
      [at(13)]: { selected: 1, headline: { title: '索引乙' } },
      [at(12)]: { selected: 1, headline: { title: '索引丙' } },
    },
    earlier: true,
    treeStatus: 'ready',
    boardStatus: 'ready',
  });
  assert.equal(pending.readingsPending, true);
  assert.deepEqual(pending.hours, []);
  const ready = buildHomeTimelineModel({
    nowMs: at(16),
    editions: [14, 13, 12].map(edition),
    readings: {
      [at(14)]: { items: ['甲', '乙', '丙', '丁', '戊', '己'].map((title) => ({ title, disposition: 'hit' })) },
      [at(13)]: { items: ['一', '二', '三'].map((title) => ({ title, disposition: 'hit' })) },
      [at(12)]: { items: ['子', '丑'].map((title) => ({ title, disposition: 'hit' })) },
    },
    earlier: true,
    treeStatus: 'ready',
    boardStatus: 'ready',
  });
  assert.equal(ready.readingsPending, false);
  assert.deepEqual(ready.hours.map((hour) => hour.titles), [
    ['甲', '乙', '丙', '丁', '戊'],
    ['一', '二'],
    ['子', '丑'],
  ]);
});

test('home hours list reading titles and omit nodes without one', () => {
  const midnight = shanghaiMidnight(saturdayMorning);
  const at = (hour) => midnight + hour * 3_600_000;
  const edition = (hour) => ({ window: { startAt: at(hour), endAt: at(hour + 1) } });
  const hit = (title) => ({ title, disposition: 'hit' });
  const readings = {
    [at(14)]: { selected: 6, items: ['甲', '乙', '丙', '丁', '戊', '己'].map(hit) },
    [at(13)]: { selected: 3, items: ['一', '二', '三'].map(hit) },
    [at(12)]: { selected: 1, headline: { title: '只有一条' }, items: [{ title: '只有一条', disposition: 'hit' }] },
    [at(11)]: { selected: 0 },
  };
  assert.deepEqual(readingTitles(readings[at(14)], 5), ['甲', '乙', '丙', '丁', '戊']);
  const model = buildHomeTimelineModel({
    nowMs: at(16),
    editions: [14, 13, 12, 11].map(edition),
    readings,
    earlier: true,
    treeStatus: 'ready',
    boardStatus: 'ready',
  });
  assert.equal(model.header, '今天');
  assert.deepEqual(model.hours.map((hour) => hour.label), ['14:00', '13:00', '12:00']);
  assert.deepEqual(model.hours[0].titles, ['甲', '乙', '丙', '丁', '戊']);
  assert.deepEqual(model.hours[1].titles, ['一', '二']);
  assert.deepEqual(model.hours[2].titles, ['只有一条']);
  assert.equal(model.hours.every((hour) => hour.href === `#report?hour=${hour.label.slice(0, 2)}`), true);
  const sixteen = buildHomeTimelineModel({
    nowMs: at(18),
    editions: [edition(16)],
    readings: { [at(16)]: { selected: 1, items: [{ title: '十六点标题', disposition: 'hit' }] } },
    earlier: true,
    treeStatus: 'ready',
    boardStatus: 'ready',
  });
  assert.equal(sixteen.hours[0].label, '16:00');
  assert.equal(sixteen.hours[0].href, '#report?hour=16');
  assert.equal(sixteen.hours[0].endAt, at(17));
  assert.equal(model.statusText, '');
  assert.equal(sixteen.statusText, '');
});

test('loading timeline does not claim missing hours before the index arrives', () => {
  const midnight = shanghaiMidnight(saturdayMorning);
  const at = (hour) => midnight + hour * 3_600_000;
  const loading = buildHomeTimelineModel({ nowMs: at(18), editions: [], treeStatus: 'loading', boardStatus: 'loading' });
  assert.equal(loading.statusText, '');
  assert.deepEqual(loading.gaps, []);
  assert.equal(loading.hours.length, 0);
});

test('reading-hour snapshots stay ahead of a later index refresh', () => {
  const midnight = shanghaiMidnight(saturdayMorning);
  const at = (hour) => midnight + hour * 3_600_000;
  const edition = (hour) => ({ window: { startAt: at(hour), endAt: at(hour + 1) } });
  const hit = (title) => ({ title, disposition: 'hit' });
  const full = {
    [at(16)]: { selected: 6, items: ['甲', '乙', '丙', '丁', '戊', '己'].map(hit) },
    [at(15)]: { selected: 3, items: ['一', '二', '三'].map(hit) },
    [at(14)]: { selected: 2, items: ['子', '丑'].map(hit) },
    [at(13)]: { selected: 1, headline: { title: '寅' }, items: [{ title: '寅', disposition: 'hit' }] },
  };
  const index = {
    hours: [16, 15, 14, 13].map((hour) => ({
      startAt: at(hour),
      endAt: at(hour + 1),
      headline: { title: '只剩索引' },
      selected: 1,
    })),
  };
  const merged = mergeReadingHours(full, index.hours.reduce((map, row) => {
    map[row.startAt] = row;
    return map;
  }, {}));
  const input = {
    nowMs: at(18),
    editions: [16, 15, 14, 13, 12].map(edition),
    readings: merged,
    treeStatus: 'ready',
    boardStatus: 'ready',
  };
  const first = buildHomeTimelineModel(input);
  const second = buildHomeTimelineModel({ ...input, readings: mergeReadingHours(merged, { [at(16)]: { headline: { title: '只剩索引' }, selected: 1 } }) });
  assert.deepEqual(first.hours[0].titles, ['甲', '乙', '丙', '丁', '戊']);
  assert.deepEqual(first.hours[1].titles, ['一', '二']);
  assert.equal(first.hours.length, 4);
  assert.equal(first.earlierCount, 1);
  assert.deepEqual(second.hours.map((hour) => hour.titles), first.hours.map((hour) => hour.titles));
  assert.equal(second.hours.length, first.hours.length);
  assert.equal(second.earlierCount, first.earlierCount);
});

test('home hourly window keeps the latest editions across midnight', () => {
  const now = Date.parse('2026-10-10T17:13:00Z');
  const plan = homeRequestPlan(now);
  const end = shanghaiHourStart(now) + 3_600_000;
  const from = end - HOME_RECENT_EDITION_HOURS * 3_600_000;
  const yesterdayEvening = Date.parse('2026-10-10T15:00:00Z');
  assert.equal(plan.tree, `/api/v1/reports/tree?view=index&startAt=${from}&endAt=${end}`);
  assert.equal(plan.readingIndex, `/api/v1/reports/reading-hour/index?startAt=${from}&endAt=${end}&scope=hour`);
  assert.ok(from <= yesterdayEvening && yesterdayEvening < end);
  assert.equal(homeEditionNote(yesterdayEvening, yesterdayEvening + 3_600_000, now), '10月10日 · 23:00–00:00');
  assert.equal(homeEditionNote(shanghaiHourStart(now), end, now), '01:00–02:00');
});

test('home hour sections keep several periods and sort each one newest first', () => {
  const now = Date.parse('2026-10-10T17:13:00Z');
  const hour = 3_600_000;
  const end = shanghaiHourStart(now);
  const starts = [0, 1, 2, 3, 4].map((index) => end - (index + 1) * hour);
  const edition = (startAt) => ({ window: { startAt, endAt: startAt + hour } });
  const item = (title, publishedAt, extra = {}) => ({
    title,
    nodeId: title,
    readingDirectionName: '金融',
    disposition: 'hit',
    publishedAt,
    ...extra,
  });
  const readings = {
    [starts[0]]: {
      items: [
        item('早', starts[0] + 30 * 60_000),
        item('晚', starts[0] + 50 * 60_000),
        item('中', starts[0] + 40 * 60_000),
        item('四', starts[0] + 10 * 60_000),
        item('五', starts[0] + 20 * 60_000),
        item('六', starts[0] + 5 * 60_000),
        item('未分类', starts[0] + 55 * 60_000, { readingDirectionName: '待分类' }),
      ],
    },
    [starts[1]]: {
      items: [
        item('甲', starts[1] + 10 * 60_000),
        item('乙', starts[1] + 20 * 60_000),
        item('丙', starts[1] + 30 * 60_000),
      ],
    },
    [starts[2]]: { items: [] },
    [starts[3]]: { items: [item('子', starts[3] + 1_000)] },
    [starts[4]]: { items: [item('丑', starts[4] + 1_000)] },
  };
  const sections = homeHourSections({
    editions: starts.map(edition),
    readings,
    sectionLimit: 4,
    nowMs: now,
  });
  assert.equal(sections.length, 4);
  assert.deepEqual(sections[0].items.map((row) => row.title), ['晚', '中', '早', '五', '四']);
  assert.equal(sections[1].items.length, 2);
  assert.deepEqual(sections[1].items.map((row) => row.title), ['丙', '乙']);
  assert.equal(sections[0].label, '00:00–01:00');
  assert.equal(sections[1].label, '10月10日 · 23:00–00:00');
  assert.equal(homeHourSections({ editions: starts.map(edition), readings, sectionLimit: 3, nowMs: now }).length, 3);
});

test('home hour hits follow firstIngestedAt and note a publish time before the window', () => {
  const start = Date.parse('2026-10-16T12:00:00Z');
  const now = Date.parse('2026-10-16T13:51:00Z');
  const item = (title, publishedAt, firstIngestedAt) => ({
    title,
    nodeId: title,
    readingDirectionName: '金融',
    disposition: 'hit',
    publishedAt,
    firstIngestedAt,
  });
  const hits = selectHomeHourHits({
    items: [
      item('发布更晚', start + 2 * 3_600_000, start + 10 * 60_000),
      item('收录更晚', start - 3_600_000, start + 40 * 60_000),
    ],
  });
  assert.deepEqual(hits.map((row) => row.title), ['收录更晚', '发布更晚']);
  assert.equal(homeHourItemTime(item('缺发布时间', null, start + 49 * 60_000), now), start + 49 * 60_000);
  assert.equal(homeHourItemTime(item('未来发布时间', now + 24 * 3_600_000, start + 20 * 60_000), now), start + 20 * 60_000);
  assert.equal(homeHourItemTime(item('时钟偏差', now + 30_000, start + 20 * 60_000), now), start + 20 * 60_000);
  assert.equal(homeHourItemTime({ publishedAt: now + 30_000 }, now), now);
  assert.equal(homeHourItemTime({ publishedAt: start + 30 * 60_000, firstIngestedAt: start + 49 * 60_000 }, now), start + 49 * 60_000);
  assert.equal(homeHourItemTime({ firstIngestedAt: now + 24 * 3_600_000, publishedAt: start + 20 * 60_000 }, now), start + 20 * 60_000);
  const window = { startAt: start, endAt: start + 3_600_000 };
  assert.equal(homeHourPublishedNote({ publishedAt: Date.parse('2026-10-15T18:21:00Z'), firstIngestedAt: start + 21 * 60_000 }, window), '发布于 02:21');
  assert.equal(homeHourPublishedNote({ publishedAt: Date.parse('2026-10-14T18:21:00Z'), firstIngestedAt: start + 21 * 60_000 }, window), '发布于 10月15日 02:21');
  assert.equal(homeHourPublishedNote({ publishedAt: start + 10 * 60_000, firstIngestedAt: start + 21 * 60_000 }, window), '');
});

test('unavailable official count skips failures older than 24h', () => {
  const now = Date.parse('2026-10-11T19:40:00Z');
  const chronic = now - CHRONIC_UNAVAILABLE_MS - 1;
  const recent = now - 60_000;
  assert.equal(unavailableOfficialCount([
    { sourceId: 'calendar.cn.customs', status: 'unavailable', failingSince: chronic },
    { sourceId: 'calendar.us.bls', status: 'unavailable', failingSince: chronic },
    { sourceId: 'calendar.us.census', status: 'unavailable', failingSince: chronic },
    { sourceId: 'calendar.us.bea', status: 'unavailable', failingSince: chronic },
    { sourceId: 'calendar.cn.customs', status: 'unavailable', failingSince: recent },
    { sourceId: 'calendar.us.fed', status: 'unavailable', failingSince: now - CHRONIC_UNAVAILABLE_MS },
    { sourceId: 'calendar.us.bls', status: 'unavailable' },
    { sourceId: 'calendar.us.bea', status: 'unavailable' },
    { sourceId: 'calendar.us.ism', status: 'partial', failingSince: recent },
  ], now), 3);
});

test('hourly editions use the same edition-or-attempt choice as the brief', () => {
  const hour = 3_600_000;
  const published = { id: 'published', window: { startAt: hour, endAt: hour * 2 } };
  const attempt = { id: 'attempt', window: { startAt: hour * 2, endAt: hour * 3 } };
  const editions = hourlyEditions({
    hours: [
      { edition: published, attempt: { id: 'older-attempt', window: { startAt: hour, endAt: hour * 2 } } },
      { edition: null, attempt },
    ],
  });
  assert.deepEqual(editions.map((item) => item.id), ['attempt', 'published']);
});

test('the newest loaded hour stays visible even when it has no hits', () => {
  const now = Date.parse('2026-10-11T19:40:00Z');
  const hour = 3_600_000;
  const start = shanghaiHourStart(now) - hour;
  const older = start - hour;
  const edition = (startAt) => ({ window: { startAt, endAt: startAt + hour } });
  const hit = {
    title: '旧', nodeId: '旧', readingDirectionName: '金融', disposition: 'hit', publishedAt: older + 1000,
  };
  const sections = homeHourSections({
    editions: [edition(start), edition(older)],
    readings: { [start]: { items: [] }, [older]: { items: [hit] } },
    nowMs: now,
  });
  assert.equal(sections[0].label, '02:00–03:00');
  assert.equal(sections[0].items.length, 0);
  assert.equal(sections[1].items[0].title, '旧');
  const fallback = homeHourSections({
    editions: [edition(start), edition(older)],
    readings: { [start]: { missing: true }, [older]: { items: [hit] } },
    nowMs: now,
  });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].items[0].title, '旧');
  assert.equal(homeHourSections({
    editions: [edition(start), edition(older)],
    readings: { [older]: { items: [hit] } },
    nowMs: now,
  })[0].items[0].title, '旧');
});

test('a quoted overview board is kept when the next payload has no prices', () => {
  const previous = { sections: [{ indices: [{ symbol: '^GSPC', lastPrice: 5800 }] }] };
  const empty = { sections: [{ indices: [{ symbol: '^GSPC', lastPrice: null }] }] };
  assert.equal(marketPayloadHasQuotes(previous), true);
  assert.equal(marketPayloadHasQuotes(empty), false);
  assert.equal(acceptMarketPayload(previous, empty), previous);
  assert.equal(acceptMarketPayload(null, empty), empty);
});

test('home requests are the overview set and not the old feed fan-out', () => {
  const plan = homeRequestPlan(saturdayMorning);
  assert.equal(plan.parallel.length, 4);
  assert.match(plan.tree, /^\/api\/v1\/reports\/tree\?view=index&startAt=\d+&endAt=\d+$/);
  assert.equal(plan.market, '/api/v1/markets?board=overview');
  assert.equal(plan.daily, '/api/v1/reports/tree/latest-daily');
  assert.match(plan.board, /^\/api\/v1\/static-signals\/board\?from=\d+&to=\d+&focus=1&limit=40&releaseLimit=60$/);
  assert.equal(plan.parallel.join('\n').includes(plan.tree), true);
  const forbidden = /\/feed\/x|xueqiu|trendforce|translate\/batch|agent\/runs|view=reading|tree\/edition|\/api\/v1\/posts/;
  assert.doesNotMatch([...plan.parallel, plan.board, plan.readingHour(1, 2)].join('\n'), forbidden);
  const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const sourcesPage = app.match(/async function loadSourcesPageLegacy\([^]*?\n\}/)[0];
  assert.match(sourcesPage, /homeRequestPlan\(/);
  assert.match(sourcesPage, /plan\.tree/);
  assert.match(sourcesPage, /plan\.readingIndex/);
  assert.match(sourcesPage, /plan\.board/);
  assert.match(sourcesPage, /loadDailyBrief\(/);
  assert.match(app.slice(app.indexOf('function scheduleHomeTail'), app.indexOf('async function loadSourcesPageNow')), /ensureHomeMessages\(/);
  const homeNow = app.match(/async function loadSourcesPageNow\([^]*?\n\}/)[0];
  assert.match(homeNow, /fetchHomeBootstrap\(/);
  assert.match(homeNow, /loadSourcesPageLegacy\(/);
  assert.doesNotMatch(homeNow, /loadGlobalAssets|loadMarketNativeBoard|scheduleOverviewManualPosts|loadXFeed|loadXueqiuFeed|loadPosts\(/);
  assert.match(sourcesPage, /await Promise\.all\(\[[\s\S]*loadHomeBoard\(/);
  assert.match(app, /homeOfficialSettled/);
  assert.match(app, /HOME_OFFICIAL_SETTLE_MS = 8_000/);
  assert.match(app, /GET \/api\/v1\/static-signals\/board/);
  const messages = app.match(/function homeMessageItems\(\) \{[^]*?\n\}/)[0];
  assert.doesNotMatch(messages, /officialFeedItems/);
  assert.match(messages, /feedSortAt/);
  assert.doesNotMatch(sourcesPage, /loadGlobalAssets|loadMarketNativeBoard|scheduleOverviewManualPosts|loadXFeed|loadXueqiuFeed|loadPosts\(/);
  assert.match(app, /mergeReadingHours\(state\.homeReadingHours, absorbReadingIndex\(payload\)\)/);
  const snapshots = app.slice(app.indexOf('async function ensureHomeReadingSnapshots'), app.indexOf('async function loadHomeReadingIndex'));
  assert.match(snapshots, /if \(!refresh && loaded && startAt !== latestStart\) return/);
  assert.match(snapshots, /missing: true/);
  assert.match(app, /pageCacheFresh\(record\)/);
  assert.match(app, /chooseHomeBootstrap\(/);
  assert.match(app, /cache: 'no-store'/);
  assert.match(homeNow, /home-fallback/);
  assert.match(homeNow, /revealHomeLoadError/);
  assert.match(app, /postClientError/);
  const catalog = app.slice(app.indexOf('function renderStaticSourceCatalog()'), app.indexOf('const staticScheduleWindows'));
  assert.match(catalog, /unavailableOfficialCount\(health\)/);
  assert.match(app.slice(app.indexOf('function renderHomeSourceLine()'), app.indexOf('async function loadHomeTree')), /unavailableOfficialCount\(officialSourceHealth\(\)\)/);
  assert.match(app, /view === 'report' \? '搜索简报'/);
  assert.match(app, /navId === 'sources'\) return view === 'sources' \|\| view === 'feed' \|\| view === 'market' \|\| view === 'report'/);
  const tree = readFileSync(new URL('../apps/web/public/information-tree.js', import.meta.url), 'utf8');
  assert.match(tree, /function clearHourQuery\(/);
  assert.match(tree, /if\(mode==='daily'\) clearHourQuery\(\)/);
  assert.match(tree, /const choice=r=>r\?\.edition \|\| r\?\.attempt/);
  const css = readFileSync(new URL('../apps/web/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.home-title \{[^}]*white-space: normal/s);
  assert.match(css, /\.tree-primary \{[^}]*position:sticky/s);
  assert.doesNotMatch(css, /\.tree-list \.reading-item h3 \{[^}]*ellipsis/s);
  assert.match(css, /\.tree-page \.post-card\.is-compact h3,[\s\S]*-webkit-line-clamp: unset/);
  assert.match(css, /\.home-brief-list li \{[\s\S]*?-webkit-line-clamp: unset/);
  const html = readFileSync(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="home-timeline"/);
  assert.match(html, /id="global-events"/);
  assert.match(html, /class="market-native-section hidden" id="global-events"/);
  assert.match(app, /setView\('market\/global\?tab=events'\)/);
  assert.match(app, /\{id:'events',label:'事件概率'\}/);
  assert.doesNotMatch(html, /id="overview-brief"|今日关注|近期日程|查看信源|仅陈列公开事实/);
});
