import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mapDiscussionComment, mapDiscussionStatus } from '../packages/connectors/src/xueqiu/stock-discussion.js';
import { createInvestorJevCompleter } from '../packages/connectors/src/investor-jev-model.js';
import { previousDailyInstant, nextDailyInstant } from '../packages/domain/src/zoned-time.js';
import {
  aggregateJev,
  attachParentPosts,
  buildJevUserPrompt,
  getDefaultJevQuestionSet,
  jevItemWeight,
  loadJevQuestionSet,
  parseJevBatch,
  resolveJevQuestionPath,
  runJevLabeling,
  stanceFromJev,
  validateJevQuestionSet,
} from '../packages/domain/src/investor-jev.js';
import {
  formatInvestorCrowd,
  formatInvestorCrowdCounts,
  formatInvestorQuestionSet,
  renderInvestorDigest,
} from '../apps/web/public/investor-digest.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function flags(id, extra = {}) {
  return {
    id,
    aboutTarget: extra.aboutTarget ?? true,
    bullish: extra.bullish ?? true,
    bearish: extra.bearish ?? false,
    explicit: extra.explicit ?? true,
    questionOnly: false,
    reportOnly: false,
    hasEvidence: extra.hasEvidence ?? false,
    rumor: extra.rumor ?? false,
    traded: false,
  };
}

test('v2 question set keeps the tuned prompt, rules and batch size', () => {
  const set = getDefaultJevQuestionSet();
  assert.equal(set.version, 'v2');
  assert.equal(set.questions.length, 9);
  assert.equal(set.user.intro, '材料：每条一段，含 id、本组标的、类型、原文；评论另附原帖。');
  assert.equal(set.user.bodyClip, 280);
  assert.equal(set.user.parentClip, 160);
  assert.equal(set.batch.size, 12);
  assert.equal(set.batch.singleAttempts, 3);
  assert.equal(set.batch.backoffMs, 2000);
  assert.equal(set.aggregation.minDirectional, 5);
  assert.equal(set.weight.factors.find((item) => item.question === 'explicit').whenFalse, 0.6);
  assert.equal(set.weight.factors.find((item) => item.question === 'hasEvidence').whenTrue, 1.2);
  assert.equal(set.weight.factors.find((item) => item.question === 'rumor').whenTrue, 0.7);
  assert.match(set.system, /路边一条/);
  assert.match(set.system, /id 必须与材料里的 id 完全一致。/);
  for (const question of set.questions) assert.ok(set.system.includes(`${question.id}：${question.text}`));
  assert.equal(resolveJevQuestionPath(''), path.join(root, 'config', 'jev-questions.v2.json'));
  assert.equal(resolveJevQuestionPath('v2', root), path.join(root, 'config', 'jev-questions.v2.json'));
  assert.throws(() => resolveJevQuestionPath('../outside.json', root), /仓库外/);
  assert.throws(() => loadJevQuestionSet({
    env: { AI_CENTER_DIGEST_JEV_QUESTIONS: 'config/no-such-jev.json' },
    repositoryRoot: root,
  }), /找不到题集/);
  assert.throws(() => validateJevQuestionSet({ ...JSON.parse(JSON.stringify(set)), system: '缺题' }), /系统提示词缺少/);
});

test('stance follows the first matching rule and weights stack the config factors', () => {
  const set = getDefaultJevQuestionSet();
  assert.equal(stanceFromJev({ aboutTarget: false, explicit: false, bullish: true, bearish: false }, '跌'), '无关');
  assert.equal(stanceFromJev({ aboutTarget: true, explicit: false, bullish: true, bearish: false }, '会涨'), '中性');
  assert.equal(stanceFromJev({ aboutTarget: true, explicit: false, bullish: true, bearish: false }, '这是一句超过八个字的看多'), '看多');
  assert.equal(stanceFromJev({ aboutTarget: true, explicit: true, bullish: false, bearish: true }, '该走了'), '看空');
  const quiet = { likeCount: 0, replyCount: 0 };
  assert.equal(jevItemWeight(quiet, { explicit: true, hasEvidence: true, rumor: false }, set), 1.2);
  assert.equal(jevItemWeight(quiet, { explicit: false, hasEvidence: false, rumor: true }, set), 0.42);
  const items = [
    { id: 'hot', likeCount: 100, replyCount: 1, text: '看空' },
    ...Array.from({ length: 12 }, (_, index) => ({ id: `p${index}`, likeCount: 0, replyCount: 0, text: '看多一句' })),
  ];
  const labels = new Map(items.map((item) => [item.id, {
    labeled: true,
    stance: item.id === 'hot' ? '看空' : '看多',
    explicit: true,
    hasEvidence: false,
    rumor: false,
  }]));
  const aggregate = aggregateJev(items, labels, set);
  assert.equal(aggregate.sentiment, '偏多');
  assert.equal(aggregate.sampleSize, 13);
  assert.ok(aggregate.shares.bull > aggregate.shares.bear);
  const aside = aggregateJev(
    [{ id: 'x', text: '别的股票', likeCount: 9, replyCount: 0 }],
    new Map([['x', { labeled: true, stance: '无关' }]]),
    set,
  );
  assert.equal(aside.sampleSize, 0);
  assert.equal(aside.counts.irrelevant, 1);
  assert.equal(aside.sentiment, '数据不足');
});

test('comments take the parent post from the url tail, and a bad batch splits before a single retry', async () => {
  const post = { id: 'post:SH:9', sourceId: '9', targetKey: 'SH', targetName: '浦发银行', kind: 'post', text: `原帖${'长'.repeat(200)}`, url: 'https://xueqiu.com/7/9' };
  const comment = { id: 'comment:SH:3', sourceId: '3', targetKey: 'SH', targetName: '浦发银行', kind: 'comment', text: '同意', url: 'https://xueqiu.com/7/9', postId: '999' };
  const other = { id: 'comment:SZ:3', sourceId: '3', targetKey: 'SZ', targetName: '别的', kind: 'comment', text: '无关', url: 'https://xueqiu.com/8/3' };
  const attached = attachParentPosts([post, comment, other]);
  assert.match(attached[1].parentText, /^原帖长+/);
  assert.equal(attached[2].parentText, '');
  const prompt = buildJevUserPrompt(attached);
  assert.match(prompt, /材料：每条一段，含 id、本组标的、类型、原文；评论另附原帖。/);
  assert.match(prompt, /类型: 评论/);
  assert.match(prompt, /原帖: 原帖长+/);
  assert.equal([...prompt.matchAll(/原帖: /g)].length, 1);
  assert.ok(prompt.split('原帖: ')[1].split('\n')[0].endsWith('…'));
  const sleeps = [];
  const result = await runJevLabeling({
    items: ['a', 'b', 'c', 'd'].map((id) => ({ id, kind: 'post', text: id })),
    batchSize: 4,
    maxCalls: 20,
    sleep: async (ms) => { sleeps.push(ms); },
    complete: async ({ batch }) => {
      if (batch.length > 1) throw Object.assign(new Error('模型没有返回 JSON'), { code: 'bad_json' });
      return { text: JSON.stringify({ items: [flags(batch[0].id)] }) };
    },
  });
  assert.equal(result.usage.calls, 7);
  assert.equal(result.usage.splitRetries, 3);
  assert.deepEqual(sleeps, []);
  assert.equal(result.labelsById.get('d').stance, '看多');
  const waits = [];
  let attempts = 0;
  const singleton = await runJevLabeling({
    items: [{ id: 'only', kind: 'post', text: '只此一条看多' }],
    batchSize: 12,
    maxCalls: 5,
    sleep: async (ms) => { waits.push(ms); },
    complete: async () => {
      attempts += 1;
      if (attempts < 3) return { text: '{"items":' };
      return { text: JSON.stringify({ items: [flags('only', { bullish: false, bearish: true })] }) };
    },
  });
  assert.deepEqual(waits, [2000, 4000]);
  assert.equal(attempts, 3);
  assert.equal(singleton.labelsById.get('only').stance, '看空');
  await assert.rejects(
    () => runJevLabeling({
      items: [{ id: 'a', text: '甲' }],
      complete: async () => { throw Object.assign(new Error('未配置 GEMINI_API_KEY'), { code: 'config' }); },
    }),
    (error) => error.code === 'config',
  );
  const parsed = parseJevBatch(JSON.stringify({ items: [{ id: '9', ...flags('9') }] }), [{ id: 'post:SH:9', text: '看多' }]);
  assert.equal(parsed[0].id, 'post:SH:9');
  assert.equal(parsed[0].labeled, true);
});

test('xueqiu likes prefer like_count and otherwise use fav_count', () => {
  const post = mapDiscussionStatus({
    id: '9',
    text: '原文',
    user: { id: 7, screen_name: '甲' },
    like_count: 0,
    fav_count: 4,
    reply_count: 2,
    created_at: 1,
  });
  assert.equal(post.likeCount, 4);
  assert.equal(post.replyCount, 2);
  const liked = mapDiscussionComment({
    id: '3', text: '评论', like_count: 5, fav_count: 9, user: { screen_name: '乙' },
  }, post);
  assert.equal(liked.likeCount, 5);
  assert.equal(liked.url, post.url);
});

test('jev completer rotates a cooled Gemini key and does not call Grok', async () => {
  const seen = [];
  const quota = [];
  const at = Date.parse('2026-10-12T18:00:00.000Z');
  const completer = createInvestorJevCompleter({
    env: {
      AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY,GEMINI_API_KEY2',
      GEMINI_API_KEY: 'key-a',
      GEMINI_API_KEY2: 'key-b',
    },
    model: 'gemini-3.1-flash-lite',
    now: () => at,
    dayWindow: (instant) => ({
      dayStart: previousDailyInstant(instant, { timeZone: 'America/Los_Angeles', hour: 0, minute: 0 }),
      dayEnd: nextDailyInstant(instant, { timeZone: 'America/Los_Angeles', hour: 0, minute: 0 }),
    }),
    usageObserver: async (row) => { seen.push(row); },
    quotaRepository: {
      reserve(input) {
        quota.push(input);
        const slot = input.slots[0];
        return { admitted: true, id: slot.keyEnv, ...slot };
      },
      release() {},
      setCooldown(project, model, until) { quota.push(['daily', project, model, until]); },
      cooldown(project, model, until) { quota.push(['rate', project, model, until]); },
    },
    fetch: async (url, init) => {
      assert.doesNotMatch(String(url), /grok|elucid/i);
      assert.match(String(url), /models\/gemini-3\.1-flash-lite:generateContent$/);
      const key = init.headers['x-goog-api-key'];
      if (key === 'key-a') {
        return new Response(JSON.stringify({
          error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'generate_content_free_tier_requests per day' },
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"items":[]}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await completer.complete({ system: '系统', prompt: '材料' });
  assert.equal(result.text, '{"items":[]}');
  assert.equal(quota.filter((item) => item?.slots).length, 2);
  assert.equal(quota[1][0], 'daily');
  assert.equal(quota[0].dayStart, previousDailyInstant(at, { timeZone: 'America/Los_Angeles', hour: 0, minute: 0 }));
  assert.equal(quota[0].dayEnd, nextDailyInstant(at, { timeZone: 'America/Los_Angeles', hour: 0, minute: 0 }));
  assert.equal(seen.find((row) => row.status === 'succeeded')?.stage, 'investor-discussion-jev');
  assert.throws(() => createInvestorJevCompleter({ env: { GEMINI_API_KEY: '' } }), (error) => error.code === 'config');
});

function element(tag) {
  return {
    tag,
    textContent: '',
    className: '',
    children: [],
    type: '',
    value: '',
    disabled: false,
    href: '',
    target: '',
    rel: '',
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute() {},
    addEventListener() {},
  };
}

function texts(node) {
  const found = [];
  const walk = (item) => {
    if (item.textContent) found.push(item.textContent);
    for (const child of item.children || []) walk(child);
  };
  walk(node);
  return found;
}

test('digest page shows the share line, keeps an old sentiment, and names the question set', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: element };
  try {
    const thin = element('div');
    renderInvestorDigest(thin, {
      digest: {
        status: 'ready',
        questionSet: 'v2',
        coverage: { targets: 1, succeeded: 1, postCount: 2, commentCount: 0, labelNote: '发言未标注 1 条' },
        sections: [{
          name: '南大光电',
          summary: '多头还在。',
          sentiment: '偏多',
          fetchStatus: 'summary_failed',
          heat: { posts: 2, comments: 0 },
          crowd: {
            label: '偏多',
            directionalCount: 2,
            sampleSize: 2,
            shares: { bull: 1, bear: 0, neutral: 0 },
            counts: { bull: 2, bear: 0, neutral: 0 },
            labels: { bull: '看多', bear: '看空', neutral: '中性' },
          },
        }],
      },
    }, { date: '2026-10-12', busy: false, onDate() {}, onGenerate() {} });
    const thinText = texts(thin).join('\n');
    assert.match(thinText, /数据不足（2 条）/);
    assert.match(thinText, /重试失败的标的/);
    assert.match(thinText, /题集 v2/);
    assert.match(thinText, /发言未标注 1 条/);
    assert.doesNotMatch(thinText, /多空占比/);
    assert.doesNotMatch(thinText, /100%/);
    assert.doesNotMatch(thinText, /偏多/);
    assert.doesNotMatch(thinText, /样本 2/);
    assert.equal(formatInvestorCrowdCounts({
      crowd: {
        label: '偏多',
        directionalCount: 2,
        shares: { bull: 1, bear: 0, neutral: 0 },
        counts: { bull: 2, bear: 0, neutral: 0 },
      },
    }), '');

    const full = element('div');
    renderInvestorDigest(full, {
      digest: {
        status: 'ready',
        questionSet: 'v2',
        sections: [{
          name: '存储',
          summary: '两边都有人。',
          sentiment: '',
          heat: { posts: 8, comments: 0 },
          crowd: {
            label: '偏多',
            sampleSize: 8,
            shares: { bull: 0.6, bear: 0.2, neutral: 0.2 },
            counts: { bull: 5, bear: 2, neutral: 1 },
            labels: { bull: '看多', bear: '看空', neutral: '中性' },
          },
        }],
      },
    }, { date: '2026-10-12', busy: false, onDate() {}, onGenerate() {} });
    const fullText = texts(full).join('\n');
    assert.match(fullText, /多空占比 看多 60% · 中性 20% · 看空 20%/);
    assert.doesNotMatch(fullText, /偏多/);

    const legacy = element('div');
    renderInvestorDigest(legacy, {
      digest: {
        status: 'ready',
        sections: [{ name: '长和', summary: '旧日摘。', sentiment: '分歧', heat: { posts: 1, comments: 0 } }],
      },
    }, { date: '2026-10-01', busy: false, onDate() {}, onGenerate() {} });
    const legacyText = texts(legacy).join('\n');
    assert.match(legacyText, /分歧/);
    assert.equal(formatInvestorCrowd({ sentiment: '分歧' }), '');
    assert.equal(formatInvestorCrowdCounts({ sentiment: '分歧' }), '');
    assert.equal(formatInvestorQuestionSet({}), '');
    assert.doesNotMatch(legacyText, /题集/);
  } finally {
    globalThis.document = previous;
  }
});
