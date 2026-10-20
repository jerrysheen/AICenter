import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { zonedCalendarParts, zonedClockParts } from '../apps/web/public/shanghai-time.js';

const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
const newsList = readFileSync(new URL('../apps/web/public/news-list.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '');

function functionSource(name) {
  const match = app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

test('feed rows sort by publish time and fall back to capture time', () => {
  const now = Date.parse('2026-10-10T17:13:00Z');
  const context = vm.createContext({});
  vm.runInContext(functionSource('feedSortAt'), context);
  const official = {
    kind: 'official',
    platform: 'official',
    publishedAt: Date.parse('2026-10-13T04:00:00Z'),
    effectiveAt: Date.parse('2026-10-13T04:00:00Z'),
    createdAt: now,
  };
  const yesterday = { platform: 'x', publishedAt: Date.parse('2026-10-10T14:00:00Z'), createdAt: now + 60_000 };
  assert.equal(context.feedSortAt(official, now), now);
  assert.equal(context.feedSortAt(yesterday, now), yesterday.publishedAt);
  assert.ok(context.feedSortAt(official, now) > context.feedSortAt(yesterday, now));
  const dated = { kind: 'official', platform: 'official', publishedAt: yesterday.publishedAt, createdAt: now };
  assert.equal(context.feedSortAt(dated, now), yesterday.publishedAt);
});

test('social rows group by the Shanghai publish clock', () => {
  const now = Date.parse('2026-10-14T08:00:00Z');
  const context = vm.createContext({ zonedCalendarParts, zonedClockParts });
  vm.runInContext(`${newsList}\n${functionSource('feedSortAt')}`, context);
  const post = {
    platform: 'x',
    publishedAt: Date.parse('2026-10-13T21:29:00Z'),
    createdAt: Date.parse('2026-10-12T02:00:00Z'),
  };
  const soon = {
    platform: 'x',
    publishedAt: now + 30 * 60 * 1000,
    createdAt: Date.parse('2026-10-12T02:00:00Z'),
  };
  assert.equal(context.feedSortAt(post, now), post.publishedAt);
  assert.equal(context.feedSortAt(soon, now), soon.publishedAt);
  const label = context.newsDayLabel(context.feedSortAt(post, now));
  assert.match(label, /10月14日/);
  assert.doesNotMatch(label, /10月12日/);
  assert.match(functionSource('formatTime'), /Asia\/Shanghai/);
  assert.match(functionSource('feedToNewsRow'), /day: newsDayLabel\(moment\.at\)/);
  assert.match(functionSource('articleContentId'), /x\|xueqiu\|bilibili\|trendforce\|youtube/);
  assert.doesNotMatch(app, /const paged = state\.xItems\.length > incoming\.length/);
  assert.doesNotMatch(app, /const paged = state\.xueqiuItems\.length > incoming\.length/);
});

test('day groups follow newest publish time even when the input is reversed', () => {
  const context = vm.createContext({ zonedCalendarParts, zonedClockParts });
  vm.runInContext(newsList, context);
  const oct11 = Date.parse('2026-10-10T17:13:00Z');
  const oct10 = Date.parse('2026-10-10T14:00:00Z');
  const groups = context.newsDayGroups([
    { title: '十月十日', at: oct10 },
    { title: '十月十一日', at: oct11 },
  ]);
  assert.equal(groups.map((group) => group.rows[0].title).join('|'), '十月十一日|十月十日');
  assert.notEqual(groups[0].key, groups[1].key);
});

test('same-source bulk notices are grayed and sink to the end of that day', () => {
  const context = vm.createContext({ URL, zonedCalendarParts, zonedClockParts });
  vm.runInContext(newsList, context);
  const captured = Date.parse('2026-10-10T17:53:00Z');
  const notices = Array.from({ length: 10 }, (_, index) => ({
    id: `fr-${index}`,
    kind: 'official',
    platform: 'official',
    author: index % 2 ? 'Agency A' : 'Agency B',
    sourceUrl: `https://www.federalregister.gov/documents/2026/10/10/${index}`,
    createdAt: captured + index * 1_000,
    publishedAt: Date.parse('2026-10-13T04:00:00Z'),
    title: `公告 ${index}`,
  }));
  const tweet = {
    id: 'tweet',
    kind: 'post',
    platform: 'x',
    author: 'someone',
    sourceUrl: 'https://x.com/someone/status/1',
    createdAt: captured - 3_600_000,
    publishedAt: captured - 3_600_000,
    title: '真实消息',
  };
  const marked = context.markBulkOfficialNotices([...notices, tweet]);
  assert.equal(marked.filter((item) => item.bulkNotice).length, 10);
  assert.equal(marked.find((item) => item.id === 'tweet').bulkNotice, undefined);
  const sameDay = marked.map((item) => ({
    title: item.title,
    at: item.bulkNotice ? captured : item.publishedAt,
    muted: Boolean(item.bulkNotice || item.lowValue),
    stayInDay: Boolean(item.bulkNotice),
  }));
  const grouped = context.newsDayGroups(sameDay);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].rows[0].title, '真实消息');
  assert.equal(grouped[0].rows.at(-1).muted, true);
  const yesterday = Date.parse('2026-10-10T14:00:00Z');
  const onlyBatch = context.newsDayGroups([
    { title: '公告', at: captured, muted: true, stayInDay: true },
    { title: '昨夜', at: yesterday },
  ]);
  assert.equal(onlyBatch.map((group) => group.rows[0].title).join('|'), '公告|昨夜');
  const split = context.splitSinkMuted([
    { title: '正文', muted: false },
    { title: '公告', muted: true, stayInDay: true },
    { title: '低价值', muted: true },
  ], true);
  assert.equal(split.main.map((row) => row.title).join('|'), '正文|公告');
  assert.equal(split.tail.map((row) => row.title).join('|'), '低价值');
});

test('hour list rows no longer carry an ingest-time publish hint', () => {
  assert.doesNotMatch(newsList, /function newsPublishedHint/);
  assert.doesNotMatch(newsList, /function newsIngestAt/);
  assert.doesNotMatch(readFileSync(new URL('../apps/web/public/information-tree.js', import.meta.url), 'utf8'), /newsPublishedHint|onShare:\(\)=>shareReadingItem/);
  assert.doesNotMatch(readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8'), /newsPublishedHint/);
});

test('a page slice keeps normal rows ahead of bulk notices from the same day', () => {
  const context = vm.createContext({ URL, zonedCalendarParts, zonedClockParts });
  vm.runInContext(newsList, context);
  const captured = Date.parse('2026-10-10T17:53:00Z');
  const notices = Array.from({ length: 12 }, (_, index) => ({
    id: `fr-${index}`,
    title: `公告 ${index}`,
    at: captured - index * 1_000,
    muted: true,
    stayInDay: true,
  }));
  const normal = { id: 'real', title: '正常消息', at: captured - 30 * 60_000, muted: false };
  const ordered = context.prioritizeReadableFeedRows([...notices, normal]);
  const page = ordered.slice(0, 4);
  assert.equal(page[0].title, '正常消息');
  assert.equal(page.slice(1).every((row) => row.muted), true);
  assert.equal(ordered.at(-1).muted, true);
});

test('official groups follow capture time when the effective date is in the future', () => {
  const context = vm.createContext({ zonedCalendarParts, zonedClockParts });
  vm.runInContext(`${newsList}\n${functionSource('feedSortAt')}`, context);
  const now = Date.parse('2026-10-11T02:00:00Z');
  const futureOfficial = {
    kind: 'official',
    platform: 'official',
    publishedAt: Date.parse('2026-10-10T14:00:00Z'),
    effectiveAt: Date.parse('2026-10-13T04:00:00Z'),
    createdAt: Date.parse('2026-10-11T01:30:00Z'),
    title: '未来生效',
  };
  const today = {
    platform: 'x',
    publishedAt: Date.parse('2026-10-11T01:00:00Z'),
    createdAt: now,
    title: '今天',
  };
  const yesterday = {
    platform: 'x',
    publishedAt: Date.parse('2026-10-10T12:00:00Z'),
    createdAt: now,
    title: '昨天',
  };
  assert.equal(context.feedSortAt(futureOfficial, now), futureOfficial.createdAt);
  const rows = [futureOfficial, today, yesterday].map((item) => ({
    title: item.title,
    at: context.feedSortAt(item, now),
  }));
  const groups = context.newsDayGroups(rows);
  assert.equal(groups.map((group) => group.rows.map((row) => row.title).join(',')).join('|'), '未来生效,今天|昨天');
  assert.match(functionSource('officialDayKey'), /feedSortAt\(item\)/);
  assert.doesNotMatch(functionSource('officialDayKey'), /publishedAt/);
});

test('overview and the source catalog count unavailable sources with one function', () => {
  const catalog = app.slice(app.indexOf('function renderStaticSourceCatalog()'), app.indexOf('const staticScheduleWindows'));
  const home = app.slice(app.indexOf('function renderHomeSourceLine()'), app.indexOf('async function loadHomeTree'));
  assert.match(catalog, /unavailableOfficialCount\(health\)/);
  assert.match(home, /unavailableOfficialCount\(officialSourceHealth\(\)\)/);
  assert.match(app, /prioritizeReadableFeedRows\(items\.map\(feedToNewsRow\)\)/);
  const renderStart = app.indexOf('function renderPosts()');
  const prioritizeAt = app.indexOf('prioritizeReadableFeedRows', renderStart);
  const sliceAt = app.indexOf('.slice(0, state.feedShown)', renderStart);
  assert.ok(prioritizeAt > renderStart && prioritizeAt < sliceAt);
});
