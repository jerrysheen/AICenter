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
  homeRequestPlan,
  shanghaiMidnight,
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

test('missing hours collapse and the latest hour reports its delay', () => {
  const midnight = shanghaiMidnight(saturdayMorning);
  const at = (hour) => midnight + hour * 3_600_000;
  const now = at(14) + 30 * 60 * 1000;
  const editions = [8, 9, 11].map((hour) => ({ window: { startAt: at(hour), endAt: at(hour + 1) } }));
  const coverage = hourCoverage({ editions, nowMs: now });
  assert.equal(coverage.delay.text, '最新一期 11:00 · 已延迟 2 小时');
  assert.equal(coverage.gaps.some((gap) => gap.count === 2 && gap.text === '12:00–14:00 · 2 期未生成'), true);
  assert.equal(coverage.gaps.filter((gap) => gap.count === 2).length, 1);
});

test('home requests are the overview set and not the old feed fan-out', () => {
  const plan = homeRequestPlan(saturdayMorning);
  assert.equal(plan.parallel.length, 4);
  assert.match(plan.tree, /^\/api\/v1\/reports\/tree\?view=index&startAt=\d+&endAt=\d+$/);
  const todayStart = shanghaiMidnight(saturdayMorning);
  assert.equal(plan.readingIndex, `/api/v1/reports/reading-hour/index?startAt=${todayStart}&endAt=${todayStart + 86_400_000}&scope=hour`);
  assert.equal(plan.market, '/api/v1/markets?board=overview');
  assert.equal(plan.daily, '/api/v1/reports/daily/latest/brief');
  assert.match(plan.board, /^\/api\/v1\/static-signals\/board\?from=\d+&to=\d+&focus=1&limit=40&releaseLimit=60$/);
  assert.equal(plan.parallel.join('\n').includes(plan.tree), true);
  const forbidden = /\/feed\/x|xueqiu|trendforce|translate\/batch|agent\/runs|view=reading|tree\/edition|\/api\/v1\/posts/;
  assert.doesNotMatch([...plan.parallel, plan.board, plan.readingHour(1, 2)].join('\n'), forbidden);
  const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const sourcesPage = app.match(/async function loadSourcesPage\([^]*?\n\}/)[0];
  assert.match(sourcesPage, /homeRequestPlan\(/);
  assert.match(sourcesPage, /plan\.tree/);
  assert.match(sourcesPage, /plan\.readingIndex/);
  assert.match(sourcesPage, /plan\.board/);
  assert.match(sourcesPage, /loadDailyBrief\(/);
  assert.doesNotMatch(sourcesPage, /loadGlobalAssets|loadMarketNativeBoard|scheduleOverviewManualPosts|loadXFeed|loadXueqiuFeed|loadPosts\(/);
  const html = readFileSync(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="home-timeline"/);
  assert.match(html, /id="global-events"/);
  assert.doesNotMatch(html, /id="overview-brief"|今日关注|近期日程|查看信源|仅陈列公开事实/);
});
