import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/database/src/index.js';
import { legacyHoldingsBookToPortfolioImport } from '../packages/connectors/src/manual-holdings-book.js';
import { createTradingService } from '../packages/domain/src/trading-service.js';
import { yahooToXueqiuSymbol } from '../packages/connectors/src/xueqiu-quotes.js';
import {
  XueqiuLoginRequiredError,
  XueqiuVerificationError,
  classifyDiscussionBody,
  collectDiscussionTargets,
  createRequestPacer,
  createXueqiuStockDiscussionClient,
  discussionBodyPreview,
  discussionCommentsV3Url,
  discussionTimestamp,
  stockDiscussionUrl,
} from '../packages/connectors/src/xueqiu/stock-discussion.js';
import { createGeminiInvestorSummarizer } from '../packages/connectors/src/investor-discussion-model.js';
import {
  INVESTOR_DISCUSSION_SYSTEM,
  buildDiscussionTargets,
  createInvestorDiscussionService,
  discussionDayWindow,
  discussionSymbolFromHolding,
  markUnverified,
  presentInvestorDigest,
  stripTradingAdvice,
} from '../packages/domain/src/investor-discussion.js';
import {
  createInvestorDiscussionJobHandlers,
  ensureInvestorDiscussionSchedule,
  investorDigestRuntimeConfig,
  parseInvestorDigestClock,
} from '../packages/runtime/src/investor-discussion-job.js';
import { zonedLocalToUtc } from '../packages/domain/src/zoned-time.js';

const DAY = { since: 1_000, until: 5_000 };

function post(id, createdAt, extra = {}) {
  return {
    id,
    text: extra.text || `帖子${id}`,
    created_at: createdAt,
    reply_count: extra.replyCount || 0,
    user: { id: 7, screen_name: '甲' },
    target: `/7/${id}`,
    ...extra.raw,
  };
}

test('stock discussion url uses type 11, time sort and 20 per page', () => {
  const url = new URL(stockDiscussionUrl('SZ300346', 2));
  assert.equal(url.pathname, '/query/v1/symbol/search/status.json');
  assert.equal(url.searchParams.get('symbol'), 'SZ300346');
  assert.equal(url.searchParams.get('type'), '11');
  assert.equal(url.searchParams.get('count'), '20');
  assert.equal(url.searchParams.get('sort'), 'time');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('comment'), null);
  assert.equal(url.searchParams.get('source'), null);
  assert.equal(url.searchParams.get('hl'), null);
  assert.equal(url.searchParams.get('q'), null);
  assert.equal(new URL(stockDiscussionUrl('SH688268')).searchParams.get('symbol'), 'SH688268');
  assert.equal(new URL(stockDiscussionUrl('00981')).searchParams.get('symbol'), '00981');
});

test('discussion symbols cover A-share ETF, HK connect and B shares', () => {
  assert.equal(discussionSymbolFromHolding({ yahoo: '510300.SS' }), 'SH510300');
  assert.equal(discussionSymbolFromHolding({ yahoo: '600000.SS' }), 'SH600000');
  assert.equal(discussionSymbolFromHolding({ yahoo: '0001.HK' }), '00001');
  assert.equal(discussionSymbolFromHolding({ yahoo: '200001.SZ' }), 'SZ200001');
  assert.equal(discussionSymbolFromHolding({ yahoo: '900901.SS' }), 'SH900901');
  assert.equal(discussionSymbolFromHolding({ yahoo: '510300.SS' }), yahooToXueqiuSymbol('510300.SS'));
  assert.equal(discussionSymbolFromHolding({ yahoo: '0001.HK' }), yahooToXueqiuSymbol('0001.HK'));
  const built = buildDiscussionTargets({
    holdings: [
      { yahoo: '600000.SS', name: '浦发银行', symbol: '600000', exchangeCode: 'XSHG' },
      { yahoo: '600000.SS', name: '浦发银行', symbol: '600000', exchangeCode: 'XSHG' },
      { yahoo: '510300.SS', name: '沪深300ETF', symbol: '510300', exchangeCode: 'XSHG' },
      { yahoo: '0001.HK', name: '长和', symbol: '00001', exchangeCode: 'XHKG' },
      { yahoo: '200001.SZ', name: '合成B股', symbol: '200001', exchangeCode: 'XSHE' },
      { symbol: 'ABC', name: '无法识别' },
    ],
    themes: [],
  });
  assert.deepEqual(built.targets.map((item) => item.key), ['SH600000', 'SH510300', '00001', 'SZ200001']);
  assert.equal(built.unmapped[0].reason, '无法换成雪球代码');
});

test('xueqiu discussion fetch dedups posts and comments and stops before the day', async () => {
  const urls = [];
  let postPage = 0;
  const results = await collectDiscussionTargets([{
    kind: 'holding', key: 'SH600000', name: '浦发银行', symbols: ['SH600000'], keywords: ['回购'],
  }], {
    ...DAY,
    maxPages: 3,
    maxCommentPages: 2,
    intervalMs: 0,
    retries: 0,
    wait: async () => {},
    fetchJson: async (url) => {
      urls.push(url);
      if (url.includes('/statuses/v3/comments.json')) {
        return {
          next_max_id: -1,
          comments: [
            { id: 3, text: '同一条评论', created_at: 1500, user: { screen_name: '乙' } },
            { id: 3, text: '同一条评论', created_at: 1500, user: { screen_name: '乙' } },
            { id: 4, text: '昨天的评论', created_at: 100, user: { screen_name: '丙' } },
          ],
        };
      }
      if (url.includes('/query/v1/search/status.json')) return { list: [] };
      postPage += 1;
      if (postPage === 1) return { list: [post(9, 2000, { replyCount: 1, text: '回购传闻' }), post(9, 2000)] };
      return { list: [post(8, 100)] };
    },
  });
  assert.equal(results[0].posts.length, 1);
  assert.equal(results[0].posts[0].id, '9');
  assert.equal(results[0].comments.length, 1);
  assert.equal(results[0].comments[0].id, '3');
  assert.ok(urls.some((url) => url === stockDiscussionUrl('SH600000', 1)));
  assert.equal(urls.filter((url) => url.includes('/statuses/v3/comments.json')).length, 1);
  assert.equal(urls.some((url) => url.includes('/statuses/comments.json')), false);
  assert.ok(urls.some((url) => url.includes('q=%E5%9B%9E%E8%B4%AD') || url.includes('q=回购')));
  assert.equal(results[0].commentClaimed, 1);
  assert.equal(results[0].commentsPartial, true);
});

test('comments page by max_id, stop at -1, and only cover the hottest posts per symbol', async () => {
  const urls = [];
  const results = await collectDiscussionTargets([{
    kind: 'holding', key: 'SH600519', name: '五粮液', symbols: ['SH600519', 'SZ000858'], keywords: [],
  }], {
    ...DAY,
    maxPages: 1,
    maxCommentPages: 5,
    commentPosts: 1,
    intervalMs: 0,
    retries: 0,
    wait: async () => {},
    fetchJson: async (url) => {
      urls.push(url);
      if (url.includes('/statuses/v3/comments.json')) {
        const parsed = new URL(url);
        const maxId = parsed.searchParams.get('max_id');
        if (parsed.searchParams.get('id') === '23') {
          if (maxId === '-1') {
            return {
              next_max_id: 88,
              comments: Array.from({ length: 13 }, (_, index) => ({
                id: 100 + index, text: `一级${index}`, created_at: 2000, user: { screen_name: '乙' },
              })),
            };
          }
          return { next_max_id: -1, comments: [] };
        }
        return { next_max_id: -1, comments: [{ id: 7, text: '另一只', created_at: 2000, user: { screen_name: '丙' } }] };
      }
      if (url.includes('symbol=SH600519')) {
        return { list: [
          post(1, 2000, { replyCount: 2, text: '普通帖' }),
          post(23, 2100, { replyCount: 23, text: '热帖' }),
          post(5, 2200, { replyCount: 5, text: '次热' }),
        ] };
      }
      return { list: [
        post(9, 2000, { replyCount: 1, text: '另一只冷帖' }),
        post(8, 2100, { replyCount: 9, text: '另一只热帖' }),
      ] };
    },
  });
  const commentUrls = urls.filter((url) => url.includes('/statuses/v3/comments.json'));
  assert.deepEqual(commentUrls.map((url) => new URL(url).searchParams.get('id')), ['23', '23', '8']);
  assert.equal(commentUrls.some((url) => url.includes('page=')), false);
  assert.equal(new URL(commentUrls[0]).searchParams.get('max_id'), '-1');
  assert.equal(new URL(commentUrls[1]).searchParams.get('max_id'), '88');
  assert.equal(results[0].comments.length, 14);
  assert.equal(results[0].commentClaimed, 32);
  assert.equal(results[0].commentsPartial, true);
  assert.equal(urls.filter((url) => url === discussionCommentsV3Url('23', -1)).length, 1);
});

test('v3 comment failure falls back to the legacy endpoint once', async () => {
  const urls = [];
  const results = await collectDiscussionTargets([{ symbols: ['SH600000'], keywords: [] }], {
    ...DAY, intervalMs: 0, retries: 0, maxPages: 1, commentPosts: 15, wait: async () => {},
    fetchJson: async (url) => {
      urls.push(url);
      if (url.includes('/statuses/v3/comments.json')) throw new Error('雪球 HTTP 502');
      if (url.includes('/statuses/comments.json')) {
        return { comments: [{ id: 3, text: '兜底评论', created_at: 1500, user: { screen_name: '乙' } }] };
      }
      return { list: [post(9, 2000, { replyCount: 4, text: '正文' })] };
    },
  });
  assert.equal(urls.filter((url) => url.includes('/statuses/v3/comments.json')).length, 1);
  assert.equal(urls.filter((url) => url.includes('/statuses/comments.json')).length, 1);
  assert.equal(results[0].comments.length, 1);
  assert.equal(results[0].comments[0].text, '兜底评论');
});

test('retweets and reply chains stay out of heat and comment fetches', async () => {
  const urls = [];
  const results = await collectDiscussionTargets([{ symbols: ['SZ300346'], keywords: [] }], {
    ...DAY, intervalMs: 0, retries: 0, maxPages: 1, commentPosts: 15, wait: async () => {},
    fetchJson: async (url) => {
      urls.push(url);
      if (url.includes('/comments')) return { next_max_id: -1, comments: [] };
      return { list: [
        post(1, 2000, { replyCount: 30, text: '转发长文', raw: { retweeted_status: { id: 99, text: '很长的原文' } } }),
        post(2, 2000, { replyCount: 12, text: '回复@乙：跟着说' }),
        post(3, 2000, { replyCount: 8, text: '//@乙：原帖' }),
        post(4, 2000, { replyCount: 3, raw: { text: '   ' } }),
        post(5, 2000, { replyCount: 0, text: '自己的看法 //@乙：引用' }),
      ] };
    },
  });
  assert.deepEqual(results[0].posts.map((item) => item.id), ['5']);
  assert.equal(urls.some((url) => url.includes('/comments')), false);
});

test('hitting the post page cap marks the discussion as incomplete', async () => {
  const results = await collectDiscussionTargets([{ symbols: ['SH600519'], keywords: [] }], {
    ...DAY, intervalMs: 0, retries: 0, maxPages: 1, commentPosts: 0, wait: async () => {},
    fetchJson: async () => ({ list: [post(1, 2000, { text: '当天帖' }), post(2, 2200, { text: '还是当天' })] }),
  });
  assert.equal(results[0].truncated, true);
  assert.equal(results[0].posts.length, 2);
  assert.equal(results[0].comments.length, 0);
});

test('millisecond created_at stays inside the Shanghai day when the window is startAt/endAt', async () => {
  const window = discussionDayWindow('2026-10-11', 'Asia/Shanghai');
  assert.equal(window.startAt, zonedLocalToUtc(2026, 10, 11, 0, 0, 'Asia/Shanghai'));
  assert.equal(window.endAt, zonedLocalToUtc(2026, 10, 12, 0, 0, 'Asia/Shanghai'));
  const todayMs = window.startAt + 15 * 3600 * 1000;
  const sample = {
    id: 300346001,
    user_id: 1001,
    created_at: todayMs,
    text: '南大光电今天的讨论',
    reply_count: 2,
    user: { id: 1001, screen_name: '股民甲' },
    target: '/1001/300346001',
  };
  const urls = [];
  const results = await collectDiscussionTargets([{
    kind: 'holding', key: 'SZ300346', name: '南大光电', symbols: ['SZ300346'], keywords: [],
  }], {
    ...window,
    maxPages: 3,
    commentPosts: 0,
    intervalMs: 0,
    retries: 0,
    wait: async () => {},
    fetchJson: async (url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) {
        return { list: [
          sample,
          { ...sample, id: 300346000, created_at: window.startAt - 60_000, text: '昨天的帖' },
          { ...sample, id: 300346002, created_at: Math.floor((todayMs + 1000) / 1000), text: '秒级时间戳' },
        ] };
      }
      if (page === 2) {
        return { list: [{ ...sample, id: 300346008, created_at: window.startAt - 120_000, text: '整页都是昨天' }] };
      }
      return { list: [{ ...sample, id: 300346009, created_at: todayMs, text: '不该再请求' }] };
    },
  });
  assert.equal(discussionTimestamp(sample.created_at), todayMs);
  assert.equal(discussionTimestamp(Math.floor(todayMs / 1000)), todayMs);
  assert.deepEqual(results[0].posts.map((item) => item.id).sort(), ['300346001', '300346002']);
  assert.equal(urls.length, 2);
  assert.ok(results[0].posts.every((item) => item.createdAt >= window.startAt && item.createdAt < window.endAt));
});

test('pinned or leading old posts do not drop later posts from the same day', async () => {
  const window = discussionDayWindow('2026-10-11', 'Asia/Shanghai');
  const today = window.startAt + 15 * 3600 * 1000;
  const old = window.startAt - 86_400_000;
  const urls = [];
  const results = await collectDiscussionTargets([{
    kind: 'holding', key: 'SZ300346', name: '南大光电', symbols: ['SZ300346'], keywords: [],
  }], {
    ...window,
    maxPages: 4,
    commentPosts: 0,
    intervalMs: 0,
    retries: 0,
    wait: async () => {},
    fetchJson: async (url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      const row = (id, createdAt, text, extra = {}) => ({
        id, text, created_at: createdAt, reply_count: 0,
        user: { id: 7, screen_name: '甲' }, target: `/7/${id}`, ...extra,
      });
      if (page === 1) return { list: [row(1, old, '置顶公告', { mark: 1 })] };
      if (page === 2) return { list: [row(2, old, '昨天的普通帖'), row(3, today, '今天的讨论'), row(4, today + 1000, '今天的另一条')] };
      if (page === 3) return { list: [row(5, old, '更早的一页'), row(6, old - 1000, '再早')] };
      return { list: [row(99, today, '不该请求')] };
    },
  });
  assert.deepEqual(results[0].posts.map((item) => item.id), ['3', '4']);
  assert.equal(urls.length, 3);
});

test('request interval is 2.5s with half-second jitter', async () => {
  const waits = [];
  const pacer = createRequestPacer({
    wait: async (ms) => { waits.push(Math.round(ms)); },
    intervalMs: 2500,
    jitterMs: 500,
    random: () => 0,
  });
  await pacer(async () => {});
  await pacer(async () => {});
  assert.equal(waits.length, 1);
  assert.ok(Math.abs(waits[0] - 2000) < 30);
});

test('waf challenge reopens the quote page twice, then stops the run', async () => {
  const waf = '<html><script>var arg1=\'ABC\';document.cookie="acw_sc__v2="+arg1</script></html>';
  const waits = [];
  const urls = [];
  const navigated = [];
  let sessions = 0;
  const client = createXueqiuStockDiscussionClient({
    delay: async (ms) => { waits.push(ms); },
    intervalMs: 0,
    intervalJitterMs: 0,
    retries: 2,
    maxPages: 1,
    random: () => 0.5,
    logger: { warn() {} },
    browserRuntime: {
      async withSession(_options, fn) {
        sessions += 1;
        return fn({
          navigate: async (url) => { navigated.push(url); },
          evaluate: async () => ({ logged_in: true }),
          fetchJson: async (url) => {
            urls.push(url);
            return { status: 200, url, text: waf };
          },
        });
      },
    },
  });
  await assert.rejects(
    () => client.collectAll([
      { symbols: ['SH900923'], keywords: [] },
      { symbols: ['SZ300346'], keywords: [] },
    ], discussionDayWindow('2026-10-11', 'Asia/Shanghai')),
    (error) => error instanceof XueqiuVerificationError && /WAF 挑战/.test(error.message),
  );
  assert.equal(sessions, 1);
  assert.equal(urls.length, 3);
  assert.equal(waits.filter((ms) => ms === 30_000).length, 2);
  assert.equal(navigated.filter((url) => url === 'https://www.xueqiu.com/hq').length, 3);
});

test('non-json xueqiu bodies are classified and a verification page stops the run', async () => {
  assert.equal(classifyDiscussionBody(''), 'empty');
  assert.equal(classifyDiscussionBody('<html><body>讨论</body></html>'), 'html');
  assert.equal(classifyDiscussionBody('<html>请完成滑动验证</html>'), 'verify');
  assert.equal(classifyDiscussionBody('{"list":['), 'truncated');
  assert.equal(classifyDiscussionBody('<html><script>var arg1=\'ABC\';document.cookie="acw_sc__v2="+arg1</script></html>'), 'waf');
  assert.equal(discussionBodyPreview('第一行\n第二行 cookie=secret'), '第一行 第二行 cookie=secret'.slice(0, 120));
  const logs = [];
  const urls = [];
  const client = createXueqiuStockDiscussionClient({
    delay: async () => {},
    intervalMs: 0,
    retries: 2,
    maxPages: 1,
    logger: { warn(line) { logs.push(line); } },
    browserRuntime: {
      async withSession(_options, fn) {
        return fn({
          navigate: async () => {},
          evaluate: async () => ({ logged_in: true }),
          fetchJson: async (url) => {
            urls.push(url);
            return {
              status: 200,
              url,
              text: '<html>\n请完成滑动验证\n</html>',
            };
          },
        });
      },
    },
  });
  await assert.rejects(
    () => client.collectAll([
      { symbols: ['SZ300346'], keywords: [] },
      { symbols: ['SH600519'], keywords: [] },
    ], discussionDayWindow('2026-10-11', 'Asia/Shanghai')),
    (error) => error instanceof XueqiuVerificationError && error.code === 'verification_required',
  );
  assert.equal(urls.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /status=200/);
  assert.match(logs[0], /length=/);
  assert.match(logs[0], /kind=verify/);
  assert.match(logs[0], /head=请完成滑动验证|<html> 请完成滑动验证/);
  assert.doesNotMatch(logs[0], /Cookie:|xq_a_token/);
  const html = createXueqiuStockDiscussionClient({
    delay: async () => {},
    intervalMs: 0,
    retries: 2,
    maxPages: 1,
    logger: { warn() {} },
    browserRuntime: {
      async withSession(_options, fn) {
        return fn({
          navigate: async () => {},
          evaluate: async () => ({ logged_in: true }),
          fetchJson: async (url) => ({ status: 200, url, text: '<html>oops</html>' }),
        });
      },
    },
  });
  const htmlResults = await html.collectAll(
    [{ symbols: ['SZ000858'], keywords: [] }],
    discussionDayWindow('2026-10-11', 'Asia/Shanghai'),
  );
  assert.match(htmlResults[0].reason, /HTML/);
});

test('xueqiu login failure is explicit and does not look like an empty day', async () => {
  await assert.rejects(
    () => collectDiscussionTargets([{ symbols: ['SH600000'], keywords: [] }], {
      ...DAY, intervalMs: 0, retries: 2, wait: async () => {}, maxPages: 1,
      fetchJson: async () => ({ error_code: '400016', error_description: '请重新登录' }),
    }),
    (error) => error instanceof XueqiuLoginRequiredError && /尚未登录雪球/.test(error.message),
  );
  let fetched = false;
  const client = createXueqiuStockDiscussionClient({
    delay: async () => {},
    intervalMs: 1,
    browserRuntime: {
      async withSession(_options, fn) {
        return fn({
          navigate: async () => {},
          evaluate: async () => ({ logged_in: false }),
          fetchJson: async () => { fetched = true; return { status: 200, text: '{"list":[]}' }; },
        });
      },
    },
  });
  await assert.rejects(
    () => client.collectAll([{ symbols: ['SH600000'], keywords: [] }], DAY),
    /尚未登录雪球/,
  );
  assert.equal(fetched, false);
});

test('discussion fetch retries rate limits then records the symbol failure', async () => {
  let attempts = 0;
  const waited = [];
  const results = await collectDiscussionTargets([{ symbols: ['SH600000'], keywords: [] }], {
    ...DAY, intervalMs: 10, retries: 2, maxPages: 1, wait: async (ms) => { waited.push(ms); },
    fetchJson: async () => {
      attempts += 1;
      const error = new Error('雪球 HTTP 429');
      error.status = 429;
      throw error;
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waited, [10, 20]);
  assert.equal(results[0].failed, true);
  assert.match(results[0].reason, /429/);
  assert.equal(results[0].posts.length, 0);
});

test('summary prompt forbids advice and marks rumors, and usage is recorded', async () => {
  assert.match(INVESTOR_DISCUSSION_SYSTEM, /只做总结，不写交易建议/);
  assert.match(INVESTOR_DISCUSSION_SYSTEM, /传闻必须标「未证实」/);
  assert.doesNotMatch(INVESTOR_DISCUSSION_SYSTEM, /sentiment/);
  assert.equal(stripTradingAdvice('多头仍在。建议买入。'), '多头仍在。');
  assert.match(markUnverified('据说要回购。'), /未证实/);
  const seen = [];
  const summarize = createGeminiInvestorSummarizer({
    apiKey: 'test-key',
    model: 'gemini-3.1-flash-lite',
    usageObserver: async (row) => { seen.push(row); },
    fetch: async (url, init) => {
      assert.match(String(url), /models\/gemini-3\.1-flash-lite:generateContent$/);
      assert.equal(init.usageModel, 'gemini-3.1-flash-lite');
      const body = JSON.parse(init.body);
      assert.match(body.systemInstruction.parts[0].text, /只做总结，不写交易建议/);
      assert.match(body.systemInstruction.parts[0].text, /传闻必须标「未证实」/);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"summary":"平淡。","sentiment":"平淡","repeatedTopics":[],"links":[]}' }] } }],
        usageMetadata: { promptTokenCount: 11, cachedContentTokenCount: 0, candidatesTokenCount: 4, totalTokenCount: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await summarize({ system: INVESTOR_DISCUSSION_SYSTEM, prompt: '材料' });
  assert.match(result.text, /平淡/);
  assert.equal(result.model, 'gemini-3.1-flash-lite');
  const done = seen.find((row) => row.status === 'succeeded');
  assert.equal(done.stage, 'investor-discussion');
  assert.equal(done.provider, 'gemini');
  assert.equal(done.usage.totalTokens, 15);
  assert.equal(done.usage.inputTokens, 11);
});

test('digest stores coverage, drops invented links, and keeps login failures visible', async () => {
  const store = createStore(':memory:');
  try {
    const trading = createTradingService({
      tradingRepository: store.repositories.trading,
      sourcePort: { async read() { return { data: [] }; } },
      workspaceId: 'local',
    });
    trading.importPortfolio(legacyHoldingsBookToPortfolioImport({
      accounts: [{ id: 'broker-cn', name: '合成账户', marketScope: 'mixed', baseCurrency: 'CNY', cash: [] }],
      lots: [
        { id: 'lot-a', portfolioId: 'broker-cn', board: 'a_share', symbol: '600000', name: '浦发银行', quantity: '1', costPrice: '1', listingCurrency: 'CNY', exchangeCode: 'XSHG', market: 'cn', yahoo: '600000.SS' },
        { id: 'lot-etf', portfolioId: 'broker-cn', board: 'a_share', symbol: '510300', name: '沪深300ETF', quantity: '1', costPrice: '1', listingCurrency: 'CNY', exchangeCode: 'XSHG', market: 'cn', yahoo: '510300.SS' },
        { id: 'lot-hk', portfolioId: 'broker-cn', board: 'hk_connect', symbol: '00001', name: '长和', quantity: '1', costPrice: '1', listingCurrency: 'HKD', exchangeCode: 'XHKG', market: 'hk', yahoo: '0001.HK' },
        { id: 'lot-b', portfolioId: 'broker-cn', board: 'b_sz', symbol: '200001', name: '合成B股', quantity: '1', costPrice: '1', listingCurrency: 'HKD', exchangeCode: 'XSHE', market: 'cn', yahoo: '200001.SZ' },
      ],
    }));
    const holdings = store.repositories.investorDiscussion.listHoldings('local');
    assert.deepEqual(buildDiscussionTargets({ holdings, themes: [] }).targets.map((item) => item.key).sort(), ['00001', 'SH510300', 'SH600000', 'SZ200001']);

    const service = createInvestorDiscussionService({
      repository: store.repositories.investorDiscussion,
      now: () => Date.parse('2026-10-11T13:30:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });
    let summarized = 0;
    const saved = await service.generate({
      digestDate: '2026-10-11',
      holdings: [
        { yahoo: '600000.SS', name: '浦发银行', symbol: '600000', exchangeCode: 'XSHG' },
        { yahoo: '600000.SS', name: '浦发银行', symbol: '600000', exchangeCode: 'XSHG' },
        { yahoo: '0001.HK', name: '长和', symbol: '00001', exchangeCode: 'XHKG' },
        { symbol: 'ABC', name: '无法识别' },
      ],
      themes: [{ id: 'memory', name: '存储', keywords: ['存储'], symbols: ['SH603986'] }],
      model: 'gemini-3.1-flash-lite',
      client: {
        async collectAll(targets) {
          assert.equal(targets.filter((item) => item.key === 'SH600000').length, 1);
          return targets.map((target) => {
            if (target.key === '00001') return { failed: true, failures: [{ label: '00001', reason: 'HTTP 429' }], reason: '00001: HTTP 429', posts: [], comments: [] };
            if (target.key !== 'SH600000') return { ok: true, posts: [], comments: [], failures: [] };
            return {
              ok: true,
              posts: [{ id: '9', text: '回购传闻', title: '回购', author: '甲', url: 'https://xueqiu.com/7/9', replyCount: 23, createdAt: 1 }],
              comments: [{ id: '3', postId: '9', text: '看着办', author: '乙', createdAt: 1, url: 'https://xueqiu.com/7/9' }],
              commentClaimed: 23,
              commentsPartial: true,
              truncated: true,
              failures: [],
            };
          });
        },
      },
      summarize: async ({ system, prompt }) => {
        summarized += 1;
        assert.match(system, /只做总结，不写交易建议/);
        assert.match(system, /传闻必须标「未证实」/);
        assert.match(prompt, /热度必须使用这两个数字/);
        assert.match(prompt, /帖子 1，评论 1/);
        return { text: JSON.stringify({
          summary: '多头认为回购。传闻已落地。建议买入。',
          sentiment: '偏多',
          repeatedTopics: ['据说要回购'],
          links: [{ title: '回购', url: 'https://xueqiu.com/7/9' }, { title: '假链接', url: 'https://evil.example/x' }],
        }) };
      },
      label: async ({ prompt, batch }) => {
        assert.match(prompt, /本组标的: 浦发银行/);
        assert.match(prompt, /原帖:/);
        return {
          text: JSON.stringify({
            items: batch.map((item) => ({
              id: item.id,
              aboutTarget: true,
              bullish: true,
              bearish: false,
              explicit: true,
              questionOnly: false,
              reportOnly: false,
              hasEvidence: false,
              rumor: false,
              traded: false,
            })),
          }),
        };
      },
    });
    assert.equal(summarized, 1);
    assert.equal(saved.status, 'partial');
    assert.equal(saved.questionSet, 'v2');
    const view = presentInvestorDigest(saved);
    assert.equal(view.model, undefined);
    assert.equal(view.questionSet, 'v2');
    assert.equal(saved.model, 'gemini-3.1-flash-lite');
    const main = view.sections.find((item) => item.key === 'SH600000');
    assert.match(main.summary, /回购/);
    assert.doesNotMatch(main.summary, /建议买入/);
    assert.match(main.summary, /未证实/);
    assert.match(main.repeatedTopics[0], /未证实/);
    assert.deepEqual(main.links, [{ title: '回购', url: 'https://xueqiu.com/7/9' }]);
    assert.equal(main.sentiment, '');
    assert.equal(main.crowd.label, '数据不足');
    assert.equal(main.crowd.sampleSize, 2);
    assert.equal(main.crowd.counts.bull, 2);
    assert.equal(main.crowd.questionSet, 'v2');
    assert.equal(main.heat.posts, 1);
    assert.equal(main.heat.comments, 1);
    assert.equal(main.heat.replyCount, 23);
    assert.equal(main.commentNote, '评论只含一级、不全');
    assert.equal(view.sections[0].key, 'SH600000');
    const quiet = view.sections.filter((item) => item.fetchStatus === 'empty');
    assert.ok(quiet.length >= 1);
    assert.ok(quiet.every((item) => item.summary === '今天没人讨论'));
    assert.ok(quiet.every((item) => item.sentiment === '平淡' && !item.crowd));
    assert.ok(view.sections.findIndex((item) => item.key === 'SH600000') < view.sections.findIndex((item) => item.fetchStatus === 'empty'));
    assert.equal(view.sections.at(-1).fetchStatus, 'empty');
    assert.equal(view.coverage.commentFetched, 1);
    assert.equal(view.coverage.commentClaimed, 23);
    assert.equal(view.coverage.commentNote, '评论只含一级、不全');
    assert.equal(view.coverage.postsTruncatedNote, '帖子可能未抓全（到达页数上限）');
    assert.ok(view.coverage.missing.some((item) => item.name === '长和' && /429/.test(item.reason)));
    assert.ok(view.coverage.missing.some((item) => item.name === '无法识别'));
    assert.equal(store.listEvents(0, 20).some((event) => event.name === 'investor.discussion.digest.saved.v1'), true);

    const blocked = await service.generate({
      digestDate: '2026-10-11',
      holdings: [{ yahoo: '600000.SS', name: '浦发银行', symbol: '600000', exchangeCode: 'XSHG' }],
      themes: [],
      client: { async collectAll() { const error = new Error('采集浏览器尚未登录雪球。请先在 https://xueqiu.com/ 登录后再生成股民讨论日摘。'); error.code = 'login_required'; throw error; } },
      summarize: async () => { throw new Error('不应调用模型'); },
    });
    assert.equal(blocked.status, 'login_required');
    assert.equal(blocked.questionSet, 'v2');
    assert.equal(blocked.sections.length, 0);
    assert.equal(blocked.coverage.loginRequired, true);
    assert.match(blocked.error, /尚未登录雪球/);
    const shown = service.latest('local', '2026-10-11');
    assert.equal(shown.digest.status, 'login_required');
    assert.equal(shown.digest.model, undefined);

    let summarizedAfterVerify = 0;
    const verified = await service.generate({
      digestDate: '2026-10-12',
      holdings: [{ yahoo: '600000.SS', name: '浦发银行', symbol: '600000', exchangeCode: 'XSHG' }],
      themes: [],
      client: {
        async collectAll() {
          const error = new Error('雪球返回验证页。请在采集浏览器里完成验证后再生成，本次已停止，不会继续重试。');
          error.code = 'verification_required';
          throw error;
        },
      },
      summarize: async () => { summarizedAfterVerify += 1; return { text: '{}' }; },
    });
    assert.equal(summarizedAfterVerify, 0);
    assert.equal(verified.status, 'verification_required');
    assert.equal(verified.coverage.verificationRequired, true);
    assert.match(verified.error, /验证页/);
  } finally {
    store.close();
  }
});

test('daily schedule defaults to 21:30 Asia/Shanghai and can be turned off', () => {
  assert.deepEqual(parseInvestorDigestClock('21:30'), { hour: 21, minute: 30 });
  assert.throws(() => parseInvestorDigestClock('25:00'), /HH:MM/);
  const store = createStore(':memory:');
  try {
    const at = zonedLocalToUtc(2026, 10, 11, 21, 30, 'Asia/Shanghai');
    const schedule = ensureInvestorDiscussionSchedule(store, {
      AI_CENTER_INVESTOR_DIGEST_AT: '21:30',
      AI_CENTER_INVESTOR_DIGEST_TIMEZONE: 'Asia/Shanghai',
    }, at - 1000);
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.jobType, 'investor.discussion.digest');
    assert.equal(schedule.nextRunAt, at);
    assert.deepEqual(schedule.schedule, { kind: 'daily', timezone: 'Asia/Shanghai', hour: 21, minute: 30 });
    assert.equal(investorDigestRuntimeConfig({}).commentPosts, 15);
    assert.equal(investorDigestRuntimeConfig({}).intervalMs, 2500);
    assert.equal(investorDigestRuntimeConfig({}).intervalJitterMs, 500);
    assert.equal(investorDigestRuntimeConfig({ AI_CENTER_INVESTOR_DIGEST_MAX_PAGES: '50' }).maxPages, 50);
    assert.equal(investorDigestRuntimeConfig({ AI_CENTER_INVESTOR_DIGEST_COMMENT_POSTS: '3' }).commentPosts, 3);
    const disabled = ensureInvestorDiscussionSchedule(store, { AI_CENTER_INVESTOR_DIGEST: '0' }, at);
    assert.equal(disabled.enabled, false);
  } finally {
    store.close();
  }
});

test('manual job uses the requested date and a scheduled run uses Shanghai date', async () => {
  const store = createStore(':memory:');
  try {
    const handlers = createInvestorDiscussionJobHandlers({
      repository: store.repositories.investorDiscussion,
      env: { AI_CENTER_INVESTOR_DIGEST_THEMES: '[]' },
      now: () => Date.parse('2026-10-11T14:00:00.000Z'),
      client: { async collectAll() { return []; } },
      summarize: async () => ({ text: '{}' }),
    });
    const manual = await handlers['investor.discussion.digest']({ digestDate: '2026-10-10' });
    assert.equal(manual.digestDate, '2026-10-10');
    assert.equal(store.repositories.investorDiscussion.get('local', '2026-10-10').status, 'ready');
    assert.equal(store.repositories.investorDiscussion.get('local', '2026-10-10').questionSet, 'v2');
    const scheduledFor = zonedLocalToUtc(2026, 10, 11, 21, 30, 'Asia/Shanghai');
    const scheduled = await handlers['investor.discussion.digest']({ scheduledFor, scheduleKey: 'investor.discussion.daily' });
    assert.equal(scheduled.digestDate, '2026-10-11');
  } finally {
    store.close();
  }
});

test('missing Gemini key fails labeling instead of storing unlabeled shares', async () => {
  const store = createStore(':memory:');
  try {
    const trading = createTradingService({
      tradingRepository: store.repositories.trading,
      sourcePort: { async read() { return { data: [] }; } },
      workspaceId: 'local',
    });
    trading.importPortfolio(legacyHoldingsBookToPortfolioImport({
      accounts: [{ id: 'broker-cn', name: '合成账户', marketScope: 'mixed', baseCurrency: 'CNY', cash: [] }],
      lots: [
        { id: 'lot-a', portfolioId: 'broker-cn', board: 'a_share', symbol: '600000', name: '浦发银行', quantity: '1', costPrice: '1', listingCurrency: 'CNY', exchangeCode: 'XSHG', market: 'cn', yahoo: '600000.SS' },
      ],
    }));
    const handlers = createInvestorDiscussionJobHandlers({
      repository: store.repositories.investorDiscussion,
      env: { AI_CENTER_INVESTOR_DIGEST_THEMES: '[]' },
      now: () => Date.parse('2026-10-11T14:00:00.000Z'),
      client: {
        async collectAll(targets) {
          assert.equal(targets.length, 1);
          return [{
            ok: true,
            posts: [{ id: '1', text: '继续看多', url: 'https://xueqiu.com/1/1', replyCount: 1 }],
            comments: [],
          }];
        },
      },
      summarize: async () => { throw new Error('不应在打标签失败后继续总结'); },
    });
    await assert.rejects(
      () => handlers['investor.discussion.digest']({ digestDate: '2026-10-11' }),
      (error) => error?.code === 'config' && /GEMINI_API_KEY/.test(String(error.message)),
    );
  } finally {
    store.close();
  }
});
