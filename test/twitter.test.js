import test from 'node:test';
import assert from 'node:assert/strict';
import { tweetToFeedItem, createTwitterService, normalizeXHomeFeed, explainXConnectorError, normalizeTweetBody } from '../packages/connectors/src/twitter.js';
import { createXHomeBrowserClient, looksTruncatedTweet, mergeTweets } from '../packages/connectors/src/x/home-browser.js';
import { createConnectorRegistry } from '../packages/connectors/src/index.js';

test('home tweet maps to a feed item without chrome fields', () => {
  const item = tweetToFeedItem({
    tweet_id: '123',
    tweet_url: 'https://x.com/openai/status/123',
    text: 'hello from home timeline',
    author_handle: 'OpenAI',
    author_name: 'OpenAI',
    published_timestamp: 1_000,
    text_source: 'graphql',
  });
  assert.equal(item.platform, 'x');
  assert.equal(item.externalId, '123');
  assert.equal(item.body, 'hello from home timeline');
  assert.equal(item.sourceUrl, 'https://x.com/openai/status/123');
  assert.equal('text_source' in item, false);
});

test('tweet body keeps line breaks and splits glued urls', () => {
  const item = tweetToFeedItem({
    tweet_id: '9',
    tweet_url: 'https://x.com/user/status/9',
    text: 'first line\n\nsecond line https://t.co/abc',
    author_handle: 'user',
  });
  assert.match(item.body, /first line\n\nsecond line\nhttps:\/\/t\.co\/abc/);
  assert.equal(normalizeTweetBody('ahttps://x.com/a'), 'a\nhttps://x.com/a');
});

test('twitter service pulls 50 home tweets from injected home client', async () => {
  let calls = 0;
  const twitter = {
    async fetchHomeTimeline({ feed, limit }) {
      calls += 1;
      assert.equal(feed, 'for-you');
      assert.equal(limit, 50);
      return {
        source: 'browser_runtime_home',
        feed,
        logged_in: true,
        tweet_count: 50,
        tweets: Array.from({ length: 50 }, (_, index) => ({
          tweet_id: String(index + 1),
          tweet_url: `https://x.com/user/status/${index + 1}`,
          text: `tweet ${index + 1}`,
          author_handle: 'user',
          published_timestamp: 1_700_000_000 + index,
        })),
      };
    },
  };
  const service = createTwitterService({ twitter, ttlMs: 60_000, now: () => 1_000 });
  const first = await service.getFeed({ limit: 50 });
  const second = await service.getFeed({ feed: 'for-you', limit: 50 });
  assert.equal(first.items.length, 50);
  assert.equal(first.source, 'browser_runtime_home');
  assert.equal(first.mode, 'live');
  assert.equal(second.items[0].id, 'x:1');
  assert.equal(calls, 1);
  assert.equal(normalizeXHomeFeed('latest'), 'following');
});

test('451 errors are explained without raw provider wording', () => {
  assert.match(explainXConnectorError(new Error('HTTPS 451')), /https:\/\/x\.com\/home/);
});

test('twitter service maps 451 page titles to a Chinese recovery note', async () => {
  const twitter = {
    async fetchHomeTimeline() {
      return {
        source: 'browser_runtime_home',
        feed: 'for-you',
        logged_in: false,
        page_title: '451 Unavailable For Legal Reasons',
        page_url: 'https://twitter.com/home',
        tweets: [],
      };
    },
  };
  const service = createTwitterService({ twitter, ttlMs: 60_000, now: () => 1_000 });
  const feed = await service.getFeed({ feed: 'for-you', limit: 50 });
  assert.equal(feed.mode, 'error');
  assert.equal(feed.items.length, 0);
  assert.match(feed.note, /x\.com\/home/);
});

test('x connector registers feed.x.sync', () => {
  const registry = createConnectorRegistry({
    twitterService: { async getFeed() { return { mode: 'live', items: [], tweetCount: 0, note: '' }; } },
  });
  const types = registry.listModules().flatMap((module) => module.jobTypes);
  assert.ok(types.includes('feed.x.sync'));
});

test('twitter service reports login required without items', async () => {
  const twitter = {
    async fetchHomeTimeline() {
      return {
        source: 'browser_runtime_home',
        feed: 'for-you',
        logged_in: false,
        login_wall: true,
        error: 'login_required',
        tweet_count: 0,
        tweets: [],
      };
    },
  };
  const service = createTwitterService({ twitter, ttlMs: 60_000, now: () => 1_000 });
  const feed = await service.getFeed({ feed: 'for-you', limit: 50 });
  assert.equal(feed.mode, 'error');
  assert.equal(feed.items.length, 0);
  assert.match(feed.note, /尚未登录/);
});

test('X home browser client uses BrowserRuntime and stops the session', async () => {
  const calls = [];
  const runtime = {
    async withSession(options, callback) {
      calls.push(['start', options.purpose]);
      try {
        return await callback({
          async navigate(url) { calls.push(['navigate', url]); },
          async evaluate(expression) {
            if (String(expression).includes('tweetText')) {
              return { items: [{ tweet_id: '1', tweet_url: 'https://x.com/u/status/1', text: 'hello', author_handle: 'u' }] };
            }
            return { url: 'https://x.com/home', title: 'Home', logged_in: true, login_wall: false };
          },
        });
      } finally {
        calls.push(['stop']);
      }
    },
  };
  const client = createXHomeBrowserClient({ browserRuntime: runtime, delay: async () => {} });
  const result = await client.fetchHomeTimeline({ feed: 'for-you', limit: 5 });
  assert.equal(result.source, 'browser_runtime_home');
  assert.equal(result.logged_in, true);
  assert.equal(result.tweets[0].tweet_id, '1');
  assert.equal(calls[0][0], 'start');
  assert.equal(calls.at(-1)[0], 'stop');
  assert.equal(calls.some((item) => item[0] === 'navigate' && String(item[1] || '').includes('/status/')), false);
});

test('truncated home tweets are completed from the status page', async () => {
  const calls = [];
  const runtime = {
    async withSession(_options, callback) {
      return callback({
        async navigate(url) { calls.push(['navigate', url]); },
        async evaluate(expression) {
          const source = String(expression);
          if (source.includes('tweet-text-show-more-link') && source.includes('clicked')) {
            return { clicked: true };
          }
          if (source.includes('tweetText')) {
            if (calls.some((item) => item[0] === 'navigate' && String(item[1]).includes('/status/2100340374804070659'))) {
              return {
                items: [{
                  tweet_id: '2100340374804070659',
                  tweet_url: 'https://x.com/damnang2/status/2100340374804070659',
                  text: 'This might sound a little arrogant, but I’ll say it anyway.\n\nLately, I’ve been looking at the quality of some institutional research reports and expert calls, and then hearing what people actually pay for them.\n\nHonestly, some of it feels absurdly expensive.',
                  author_handle: 'damnang2',
                }],
              };
            }
            return {
              items: [{
                tweet_id: '2100340374804070659',
                tweet_url: 'https://x.com/damnang2/status/2100340374804070659',
                text: 'This might sound a little arrogant, but I’ll say it anyway.\n\nLately, I’ve been looking at the quality of some institutional research reports…',
                truncated: true,
                author_handle: 'damnang2',
              }],
            };
          }
          return { url: 'https://x.com/home', title: 'Home', logged_in: true, login_wall: false };
        },
      });
    },
  };
  const client = createXHomeBrowserClient({ browserRuntime: runtime, delay: async () => {} });
  const result = await client.fetchHomeTimeline({ feed: 'for-you', limit: 1 });
  assert.match(result.tweets[0].text, /absurdly expensive/);
  assert.ok(calls.some((item) => item[0] === 'navigate' && String(item[1]).includes('/status/2100340374804070659')));
});

test('mergeTweets replaces a truncated tweet with a longer body', () => {
  assert.equal(looksTruncatedTweet({ text: 'the story continues...' }), false);
  assert.equal(looksTruncatedTweet({ text: 'half…', truncated: true }), true);
  const merged = mergeTweets(
    [{ tweet_id: '1', text: 'half…', truncated: true }],
    [{ tweet_id: '1', text: 'half plus the rest of the tweet' }],
    10,
  );
  assert.equal(merged[0].text, 'half plus the rest of the tweet');
  assert.equal(merged[0].truncated, true);
  const filled = mergeTweets(
    [{ tweet_id: '1', text: 'x'.repeat(131), truncated: true }],
    [{ tweet_id: '1', text: 'y'.repeat(900), truncated: false }],
    10,
  );
  assert.equal(filled[0].text.length, 900);
  assert.equal(filled[0].truncated, false);
});
