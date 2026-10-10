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
