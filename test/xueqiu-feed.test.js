import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXueqiuFeedQuery, ValidationError } from '../packages/contracts/src/index.js';
import {
  createXueqiuHomeBrowserClient,
  createXueqiuService,
  explainXueqiuConnectorError,
  livenewsUrl,
  mapLivenewsItem,
  mapTimelineStatus,
  normalizeXueqiuFeed,
  stripXueqiuHtml,
  timelineUrl,
  userGroupIdForFeed,
  xueqiuConnectorManifest,
  xueqiuToFeedItem,
} from '../packages/connectors/src/xueqiu/index.js';
import { createConnectorRegistry } from '../packages/connectors/src/index.js';

test('xueqiu feed query maps 关注 / 精选 / 7x24', () => {
  assert.deepEqual(parseXueqiuFeedQuery({}), {
    platform: 'xueqiu', feed: 'following', limit: 50, refresh: false,
  });
  assert.equal(parseXueqiuFeedQuery({ feed: '精选'.replace('精选', 'featured'), refresh: '1' }).refresh, true);
  assert.equal(parseXueqiuFeedQuery({ feed: 'featured' }).feed, 'featured');
  assert.equal(parseXueqiuFeedQuery({ feed: '7x24' }).feed, 'livenews');
  assert.throws(() => parseXueqiuFeedQuery({ platform: 'x' }), ValidationError);
  assert.throws(() => parseXueqiuFeedQuery({ limit: '80' }), ValidationError);
});

test('timeline urls use usergroup -1 / -2 and strip html', () => {
  assert.equal(normalizeXueqiuFeed('jingxuan'), 'featured');
  assert.equal(userGroupIdForFeed('following'), -1);
  assert.equal(userGroupIdForFeed('featured'), -2);
  assert.match(timelineUrl(-2), /usergroup_id=-2/);
  assert.match(livenewsUrl(-1), /livenews\/list\.json/);
  assert.equal(stripXueqiuHtml('一线<br/>二线&amp;备注'), '一线\n二线&备注');
});

test('status and livenews map to feed items without raw fields', () => {
  const status = mapTimelineStatus({
    id: 88,
    text: '<p>先看仓位</p>',
    created_at: 1_700_000_000_000,
    target: '/123/88',
    user: { screen_name: '球友甲', id: 123 },
    retweeted_status: { user: { screen_name: '原作者' }, description: '原帖' },
  }, 'following');
  const item = xueqiuToFeedItem(status);
  assert.equal(item.platform, 'xueqiu');
  assert.equal(item.externalId, '88');
  assert.equal(item.sourceUrl, 'https://xueqiu.com/123/88');
  assert.match(item.body, /先看仓位/);
  assert.match(item.body, /原作者/);
  assert.equal('retweeted_status' in item, false);

  const news = xueqiuToFeedItem(mapLivenewsItem({
    id: 9,
    text: '央行公告',
    created_at: 1_700_000_100_000,
    target: '/S/SH000001',
  }));
  assert.equal(news.externalId, 'livenews:9');
  assert.equal(news.authorName, '雪球7x24');
});

test('xueqiu service caches and reports login required', async () => {
  let calls = 0;
  const xueqiu = {
    async fetchHomeTimeline({ feed, limit }) {
      calls += 1;
      assert.equal(feed, 'following');
      assert.equal(limit, 50);
      return {
        source: 'browser_runtime_home',
        feed,
        logged_in: true,
        items: [{
          status_id: '1',
          text: '关注动态',
          author_name: '甲',
          source_url: 'https://xueqiu.com/1/1',
          published_at: 1_700_000_000_000,
        }],
      };
    },
  };
  const service = createXueqiuService({ xueqiu, ttlMs: 60_000, now: () => 1_000 });
  const first = await service.getFeed({ limit: 50 });
  const second = await service.getFeed({ feed: 'following', limit: 50 });
  assert.equal(first.mode, 'live');
  assert.equal(first.items[0].id, 'xueqiu:1');
  assert.equal(second.items.length, 1);
  assert.equal(calls, 1);

  const locked = createXueqiuService({
    xueqiu: {
      async fetchHomeTimeline() {
        return { source: 'browser_runtime_home', feed: 'featured', logged_in: false, error: 'login_required', items: [] };
      },
    },
    ttlMs: 60_000,
    now: () => 2_000,
  });
  const feed = await locked.getFeed({ feed: 'featured', bypassCache: true });
  assert.equal(feed.mode, 'error');
  assert.match(feed.note, /尚未登录/);
});

test('browser client uses fetchJson APIs and stops the session', async () => {
  const calls = [];
  const runtime = {
    async withSession(options, callback) {
      calls.push(['start', options.purpose]);
      try {
        return await callback({
          async navigate(url) { calls.push(['navigate', url]); },
          // keep session API compatible with /hq landing
          async evaluate(expression) {
            if (String(expression).includes('document.cookie')) {
              return { url: 'https://xueqiu.com/', title: '雪球', logged_in: true, login_wall: false };
            }
            return { status: 200, url: 'https://xueqiu.com/', text: '{}' };
          },
          async fetchJson(url) {
            calls.push(['fetch', url]);
            if (String(url).includes('home_timeline')) {
              return {
                status: 200,
                url,
                text: JSON.stringify({
                  home_timeline: [{
                    id: 7,
                    text: '精选一条',
                    created_at: 1_700_000_000_000,
                    target: '/2/7',
                    user: { screen_name: '乙', id: 2 },
                  }],
                  next_max_id: -1,
                }),
              };
            }
            return { status: 200, url, text: JSON.stringify({ items: [] }) };
          },
        });
      } finally {
        calls.push(['stop']);
      }
    },
  };
  const client = createXueqiuHomeBrowserClient({ browserRuntime: runtime, delay: async () => {} });
  const result = await client.fetchHomeTimeline({ feed: 'featured', limit: 10 });
  assert.equal(result.logged_in, true);
  assert.equal(result.items[0].status_id, '7');
  assert.equal(calls[0][0], 'start');
  assert.equal(calls.at(-1)[0], 'stop');
  assert.equal(calls.some((item) => item[0] === 'navigate' && String(item[1]).includes('/hq')), true);
  assert.equal(calls.some((item) => item[0] === 'fetch' && String(item[1]).includes('usergroup_id=-2')), true);
});

test('xueqiu connector registers feed.xueqiu.sync', () => {
  const types = Object.keys(createConnectorRegistry({
    twitterService: { async getFeed() { return { mode: 'live', items: [], tweetCount: 0, note: '' }; } },
    xueqiuService: { async getFeed() { return { mode: 'live', items: [], tweetCount: 0, note: '' }; } },
    trendforceService: { async getFeed() { return { mode: 'live', items: [], note: '' }; } },
    bilibiliService: { async getFeed() { return { mode: 'empty', items: [], note: '' }; } },
  }).createJobHandlers());
  assert.ok(types.includes('feed.xueqiu.sync'));
  assert.equal(xueqiuConnectorManifest.sourceIds[0], 'content.xueqiu.home');
  assert.match(explainXueqiuConnectorError('login_required'), /xueqiu.com/);
});
