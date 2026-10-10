import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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

test('day groups follow newest publish time even when the input is reversed', () => {
  const context = vm.createContext({});
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
  const context = vm.createContext({ URL });
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
  assert.equal(onlyBatch.map((group) => group.rows[0].title).join('|'), '昨夜|公告');
  const split = context.splitSinkMuted([
    { title: '正文', muted: false },
    { title: '公告', muted: true, stayInDay: true },
    { title: '低价值', muted: true },
  ], true);
  assert.deepEqual(split.main.map((row) => row.title), ['正文', '公告']);
  assert.deepEqual(split.tail.map((row) => row.title), ['低价值']);
});
