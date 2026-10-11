import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/database/src/index.js';
import { legacyHoldingsBookToPortfolioImport } from '../packages/connectors/src/manual-holdings-book.js';
import { createTradingService } from '../packages/domain/src/trading-service.js';
import { yahooToXueqiuSymbol } from '../packages/connectors/src/xueqiu-quotes.js';
import {
  XueqiuLoginRequiredError,
  collectDiscussionTargets,
  createXueqiuStockDiscussionClient,
  stockDiscussionUrl,
} from '../packages/connectors/src/xueqiu/stock-discussion.js';
import { createGeminiInvestorSummarizer } from '../packages/connectors/src/investor-discussion-model.js';
import {
  INVESTOR_DISCUSSION_SYSTEM,
  buildDiscussionTargets,
  createInvestorDiscussionService,
  discussionSymbolFromHolding,
  markUnverified,
  presentInvestorDigest,
  stripTradingAdvice,
} from '../packages/domain/src/investor-discussion.js';
import {
  createInvestorDiscussionJobHandlers,
  ensureInvestorDiscussionSchedule,
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
      if (url.includes('/statuses/comments.json')) {
        return { comments: [
          { id: 3, text: '同一条评论', created_at: 1500, user: { screen_name: '乙' } },
          { id: 3, text: '同一条评论', created_at: 1500, user: { screen_name: '乙' } },
          { id: 4, text: '昨天的评论', created_at: 100, user: { screen_name: '丙' } },
        ] };
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
  assert.ok(urls.some((url) => url.includes('q=%E5%9B%9E%E8%B4%AD') || url.includes('q=回购')));
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
              posts: [{ id: '9', text: '回购传闻', title: '回购', author: '甲', url: 'https://xueqiu.com/7/9', replyCount: 1, createdAt: 1 }],
              comments: [{ id: '3', postId: '9', text: '看着办', author: '乙', createdAt: 1, url: 'https://xueqiu.com/7/9' }],
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
    });
    assert.equal(summarized, 1);
    assert.equal(saved.status, 'partial');
    const view = presentInvestorDigest(saved);
    assert.equal(view.model, undefined);
    assert.equal(saved.model, 'gemini-3.1-flash-lite');
    const main = view.sections.find((item) => item.key === 'SH600000');
    assert.match(main.summary, /回购/);
    assert.doesNotMatch(main.summary, /建议买入/);
    assert.match(main.summary, /未证实/);
    assert.match(main.repeatedTopics[0], /未证实/);
    assert.deepEqual(main.links, [{ title: '回购', url: 'https://xueqiu.com/7/9' }]);
    assert.equal(main.heat.posts, 1);
    assert.equal(main.heat.comments, 1);
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
    assert.equal(blocked.sections.length, 0);
    assert.equal(blocked.coverage.loginRequired, true);
    assert.match(blocked.error, /尚未登录雪球/);
    const shown = service.latest('local', '2026-10-11');
    assert.equal(shown.digest.status, 'login_required');
    assert.equal(shown.digest.model, undefined);
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
    const scheduledFor = zonedLocalToUtc(2026, 10, 11, 21, 30, 'Asia/Shanghai');
    const scheduled = await handlers['investor.discussion.digest']({ scheduledFor, scheduleKey: 'investor.discussion.daily' });
    assert.equal(scheduled.digestDate, '2026-10-11');
  } finally {
    store.close();
  }
});
