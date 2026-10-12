import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createInvestorAbModel } from '../packages/connectors/src/investor-digest-ab-model.js';
import {
  aggregateLabels,
  compareStances,
  DEFAULT_BATCH_SIZE_B,
  DEFAULT_MAX_CALLS_B,
  engagementWeight,
  estimateAbCalls,
  extractStoredMaterials,
  loadDigestMaterials,
  MIN_DIRECTIONAL_LABELS,
  parseJevBatch,
  parseStructuredBatch,
  renderAbReport,
  resolveSchemeSelection,
  runInvestorDigestAb,
  runLabelScheme,
  samplePosts,
  sentimentFromShares,
  stanceFromJev,
} from '../packages/domain/src/investor-digest-ab.js';

const STRUCTURED = (id, stance = '看多', extra = {}) => ({
  id,
  stance,
  strength: extra.strength || 2,
  reasonType: extra.reasonType || '基本面',
  hasEvidence: extra.hasEvidence ?? true,
  unverifiedRumor: extra.unverifiedRumor ?? false,
  claim: extra.claim || '业绩增长',
});

const JEV = (id, { bullish = true, bearish = false, hasEvidence = true, rumor = false, venting = false, traded = false } = {}) => ({
  id, bullish, bearish, hasEvidence, rumor, venting, traded,
});

test('structured batch keeps valid rows when JSON is broken, an id is missing, or a row is illegal', () => {
  assert.throws(() => parseStructuredBatch('不是 JSON', ['a']), /JSON/);
  assert.throws(() => parseStructuredBatch('{"items":[', ['a']), /JSON/);
  const parsed = parseStructuredBatch(JSON.stringify({
    items: [
      STRUCTURED('a'),
      { id: 'c', stance: '飞', strength: 9, reasonType: '其他', hasEvidence: 'yes', unverifiedRumor: false },
      '坏行',
    ],
  }), ['a', 'b']);
  assert.equal(parsed.find((row) => row.id === 'a').labeled, true);
  assert.equal(parsed.find((row) => row.id === 'a').stance, '看多');
  assert.equal(parsed.find((row) => row.id === 'b').labeled, false);
  assert.equal(parsed.find((row) => row.id === 'b').reason, '缺失');
  assert.equal(parsed.some((row) => row.id === 'c'), false);
  const aligned = parseStructuredBatch(JSON.stringify({ items: [STRUCTURED('9')] }), ['post:SH600000:9', 'post:SH600000:8']);
  assert.equal(aligned[0].labeled, true);
  assert.equal(aligned[0].id, 'post:SH600000:9');
  const ambiguous = parseStructuredBatch(JSON.stringify({ items: [STRUCTURED('9')] }), ['post:A:9', 'comment:A:9']);
  assert.equal(ambiguous.every((row) => row.labeled), false);
});

test('yes-no batch treats a non-boolean answer as unlabeled and maps the rest locally', () => {
  const parsed = parseJevBatch(JSON.stringify({
    items: [
      JEV('a', { bullish: true, bearish: false }),
      JEV('b', { bullish: false, bearish: true, hasEvidence: false, rumor: true }),
      { id: 'c', bullish: '是', bearish: false, hasEvidence: false, rumor: false, venting: false, traded: false },
    ],
  }), ['a', 'b', 'c', 'd']);
  assert.equal(parsed[0].stance, '看多');
  assert.equal(parsed[1].stance, '看空');
  assert.equal(parsed[1].unverifiedRumor, true);
  assert.equal(parsed[2].labeled, false);
  assert.equal(parsed[2].reason, '非法');
  assert.equal(parsed[3].reason, '缺失');
  assert.equal(stanceFromJev({ bullish: true, bearish: true, hasEvidence: false, venting: false }), '中性');
  assert.equal(stanceFromJev({ bullish: false, bearish: false, hasEvidence: false, venting: true }), '无关');
});

test('log1p weight keeps one busy post from outweighing the rest', () => {
  assert.equal(engagementWeight({ likeCount: 0, replyCount: 0 }), 1);
  assert.ok(engagementWeight({ replyCount: 1000 }) / engagementWeight({ replyCount: 0 }) < 10);
  const items = [
    ...Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, replyCount: 0, likeCount: 0 })),
    { id: 'hot', replyCount: 100, likeCount: 0 },
  ];
  const labels = new Map(items.map((item) => [item.id, {
    labeled: true,
    stance: item.id === 'hot' ? '看空' : '看多',
    strength: 1,
  }]));
  const aggregate = aggregateLabels(items, labels);
  assert.equal(aggregate.sentiment, '偏多');
  assert.ok(aggregate.shares.bull > 0.5);
  assert.ok(aggregate.shares.bear < 0.5);
});

test('sentiment rules use the share thresholds', () => {
  assert.equal(sentimentFromShares({ bull: 0.8, bear: 0.1, neutral: 0.1 }), '偏多');
  assert.equal(sentimentFromShares({ bull: 0.1, bear: 0.8, neutral: 0.1 }), '偏空');
  assert.equal(sentimentFromShares({ bull: 0.4, bear: 0.4, neutral: 0.2 }), '分歧');
  assert.equal(sentimentFromShares({ bull: 0.1, bear: 0.1, neutral: 0.8 }), '平淡');
  assert.equal(sentimentFromShares({ bull: 0.5, bear: 0.5, neutral: 0 }), '分歧');
});

test('bad JSON is split in half down to one item, and those calls count toward the cap', async () => {
  const result = await runLabelScheme({
    items: ['a', 'b', 'c', 'd'].map((id) => ({ id, kind: 'post', text: id })),
    scheme: 'structured',
    batchSize: 4,
    maxCalls: 20,
    retries: 2,
    sleep: async () => { throw new Error('JSON 失败不应按原批退避'); },
    now: (() => { let at = 0; return () => { at += 25; return at; }; })(),
    complete: async ({ batch }) => {
      if (batch.length > 1) return { text: '{"items":', usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 } };
      return {
        text: JSON.stringify({ items: [STRUCTURED(batch[0].id)] }),
        usage: { inputTokens: 8, outputTokens: 1, totalTokens: 9 },
      };
    },
  });
  assert.equal(result.usage.calls, 7);
  assert.equal(result.usage.splitRetries, 6);
  assert.equal(result.usage.inputTokens, 38);
  assert.equal(result.labelsById.get('a').labeled, true);
  assert.equal(result.labelsById.get('d').labeled, true);
  assert.equal(result.durationMs, 25);
});

test('a short batch retries only the missing ids', async () => {
  const result = await runLabelScheme({
    items: [{ id: 'a', kind: 'post', text: '甲' }, { id: 'b', kind: 'post', text: '乙' }],
    scheme: 'structured',
    batchSize: 2,
    maxCalls: 5,
    retries: 0,
    complete: async ({ batch }) => {
      if (batch.length > 1) {
        return { text: JSON.stringify({ items: [STRUCTURED('a')] }), usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } };
      }
      return { text: JSON.stringify({ items: [STRUCTURED(batch[0].id)] }), usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } };
    },
  });
  assert.equal(result.usage.calls, 2);
  assert.equal(result.usage.splitRetries, 1);
  assert.equal(result.labelsById.get('a').labeled, true);
  assert.equal(result.labelsById.get('b').labeled, true);
  assert.equal(result.usage.inputTokens, 9);
});

test('transport errors retry the same batch before splitting', async () => {
  const sleeps = [];
  let calls = 0;
  const result = await runLabelScheme({
    items: [{ id: 'a', kind: 'post', text: '甲' }, { id: 'b', kind: 'post', text: '乙' }],
    scheme: 'structured',
    batchSize: 2,
    maxCalls: 5,
    retries: 2,
    sleep: async (ms) => { sleeps.push(ms); },
    complete: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('Gemini 请求失败（503）'), { code: 'transport' });
      return {
        text: JSON.stringify({ items: [STRUCTURED('a'), STRUCTURED('b')] }),
        usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
      };
    },
  });
  assert.deepEqual(sleeps, [1000]);
  assert.equal(calls, 2);
  assert.equal(result.usage.splitRetries, 0);
  assert.equal(result.labelsById.get('b').labeled, true);
  assert.equal(result.usage.inputTokens, 11);
});

test('call cap stops later batches and records the coverage gap', async () => {
  const result = await runLabelScheme({
    items: ['a', 'b', 'c', 'd'].map((id) => ({ id, kind: 'post', text: id })),
    scheme: 'jev',
    batchSize: 2,
    maxCalls: 1,
    retries: 2,
    sleep: async () => { throw new Error('不应在上限之后继续等待'); },
    complete: async ({ batch }) => ({
      text: JSON.stringify({ items: batch.map((item) => JEV(item.id)) }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  });
  assert.equal(result.usage.calls, 1);
  assert.equal(result.stopped, true);
  assert.equal(result.labelsById.get('a').labeled, true);
  assert.equal(result.labelsById.get('c').reason, '调用次数达到上限');
  assert.equal(result.labelsById.get('d').labeled, false);
});

test('synthetic sample runs both schemes and writes the comparison without a conclusion', async () => {
  const materials = {
    date: '2026-10-12',
    source: 'synthetic',
    targets: [
      {
        kind: 'holding',
        key: 'SH600000',
        name: '浦发银行',
        posts: [
          { id: '1', text: '业绩预增，继续看多', url: 'https://xueqiu.com/7/1', replyCount: 3 },
          { id: '2', text: '估值太高了', url: 'https://xueqiu.com/7/2', replyCount: 8 },
          { id: '3', text: '订单传闻还没证实', url: 'https://xueqiu.com/7/3', replyCount: 1 },
          { id: '4', text: '继续看多', url: 'https://xueqiu.com/7/4', replyCount: 0 },
        ],
        comments: [{ id: '9', postId: '1', text: '我也觉得业绩好', url: 'https://xueqiu.com/7/1' }],
      },
      { kind: 'theme', key: 'theme:memory', name: '存储', posts: [], comments: [] },
      { kind: 'holding', key: '00001', name: '长和', posts: [], comments: [], failed: true, reason: 'HTTP 429' },
    ],
  };
  let calls = 0;
  const { report, result } = await runInvestorDigestAb({
    materials,
    model: 'gemini-3.1-flash-lite',
    batchSize: 2,
    maxCallsA: 10,
    maxCallsB: 10,
    retries: 0,
    sampleSeed: 20261012,
    complete: async ({ scheme, batch }) => {
      calls += 1;
      const items = batch.map((item) => {
        const bear = item.id.endsWith(':2');
        if (scheme === 'jev') {
          return JEV(item.id, { bullish: !bear, bearish: bear, hasEvidence: !item.id.endsWith(':3'), rumor: item.id.endsWith(':3') });
        }
        const flipped = item.id.endsWith(':2') ? '看多' : (bear ? '看空' : '看多');
        return STRUCTURED(item.id, item.id.endsWith(':2') ? '看多' : (bear ? '看空' : flipped), {
          reasonType: item.id.endsWith(':3') ? '传闻' : '基本面',
          unverifiedRumor: item.id.endsWith(':3'),
          claim: item.text,
        });
      });
      return { text: JSON.stringify({ items }), usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } };
    },
  });
  assert.equal(calls, 6);
  assert.equal(result.schemeA.usage.calls, 3);
  assert.equal(result.schemeB.usage.calls, 3);
  assert.equal(result.schemeA.usage.totalTokens, 84);
  assert.equal(result.postCount, 4);
  assert.equal(result.commentCount, 1);
  const bank = result.targets.find((target) => target.key === 'SH600000');
  assert.equal(bank.a.sentiment, '偏多');
  assert.ok(bank.b.shares.bull > bank.b.shares.bear);
  const quiet = result.targets.find((target) => target.name === '存储');
  assert.equal(quiet.a.empty, true);
  assert.match(report, /今天没人讨论/);
  assert.match(report, /HTTP 429/);
  assert.match(report, /https:\/\/xueqiu\.com\/7\/2/);
  assert.match(report, /不一致/);
  assert.match(report, /## 调用/);
  assert.match(report, /## 一致率/);
  assert.match(report, /按方向/);
  assert.match(report, /覆盖率/);
  assert.match(report, /拆批重试：A 0 次，B 0 次/);
  assert.equal(result.agreement.different >= 1, true);
  assert.doesNotMatch(report, /^## 结论/m);
  assert.doesNotMatch(report, /交易建议/);
  const posts = [
    { id: '1', kind: 'post' },
    { id: '2', kind: 'post' },
    { id: '3', kind: 'post' },
  ];
  assert.deepEqual(
    samplePosts(posts, { seed: 20261012 }).map((item) => item.id),
    samplePosts(posts, { seed: 20261012 }).map((item) => item.id),
  );
  assert.match(renderAbReport(result), /方案 A/);
});

test('stance agreement ignores unlabeled rows', () => {
  const left = new Map([
    ['a', { labeled: true, stance: '看多' }],
    ['b', { labeled: true, stance: '看空' }],
    ['c', { labeled: false, stance: '' }],
  ]);
  const right = new Map([
    ['a', { labeled: true, stance: '看多' }],
    ['b', { labeled: true, stance: '看多' }],
    ['c', { labeled: true, stance: '看空' }],
  ]);
  const compared = compareStances(left, right, ['a', 'b', 'c']);
  assert.equal(compared.both, 2);
  assert.equal(compared.same, 1);
  assert.equal(compared.different, 1);
  assert.equal(compared.missing, 1);
  assert.equal(compared.rate, 0.5);
  const neutral = new Map([['a', { labeled: true, stance: '中性' }]]);
  const aside = new Map([['a', { labeled: true, stance: '无关' }]]);
  assert.equal(compareStances(neutral, aside, ['a']).same, 0);
  assert.equal(compareStances(neutral, aside, ['a'], { direction: true }).same, 1);
  assert.equal(compareStances(neutral, aside, ['a'], { direction: true }).rate, 1);
});

test('stored summaries are not raw posts, and a materials payload can be read back', () => {
  const missing = extractStoredMaterials({
    sections_json: JSON.stringify([{ key: 'SH600000', name: '浦发银行', summary: '今天有人讨论', posts: undefined }]),
  }, '2026-10-12');
  assert.equal(missing.stored, false);
  assert.match(missing.reason, /必须重新抓取/);
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE investor_discussion_digests (
    workspace_id TEXT, digest_date TEXT, sections_json TEXT
  )`);
  database.prepare(`INSERT INTO investor_discussion_digests VALUES (?, ?, ?)`).run(
    'local', '2026-10-12', JSON.stringify([{ key: 'SH600000', name: '浦发银行', summary: '总结' }]),
  );
  const fromTable = loadDigestMaterials(database, 'local', '2026-10-12');
  assert.equal(fromTable.stored, false);
  database.exec(`ALTER TABLE investor_discussion_digests ADD COLUMN materials_json TEXT`);
  database.prepare(`UPDATE investor_discussion_digests SET materials_json = ? WHERE digest_date = ?`).run(JSON.stringify({
    date: '2026-10-12',
    targets: [{ key: 'SH600000', name: '浦发银行', posts: [{ id: '1', text: '原文', url: 'https://xueqiu.com/7/1' }], comments: [] }],
  }), '2026-10-12');
  const stored = loadDigestMaterials(database, 'local', '2026-10-12');
  assert.equal(stored.stored, true);
  assert.equal(stored.materials.targets[0].posts[0].text, '原文');
  database.close();
});

test('fewer than five directional labels is 数据不足, not a flat or full reading', async () => {
  assert.equal(MIN_DIRECTIONAL_LABELS, 5);
  const materials = {
    date: '2026-10-12',
    targets: [{
      key: 'SH1', name: '小标的',
      posts: [
        { id: '1', text: '看多', url: 'https://xueqiu.com/1/1' },
        { id: '2', text: '看多', url: 'https://xueqiu.com/1/2' },
      ],
      comments: [],
    }],
  };
  const { report, result } = await runInvestorDigestAb({
    materials, batchSize: 12, batchSizeB: 12, maxCallsA: 5, maxCallsB: 5, retries: 0,
    complete: async ({ scheme, batch }) => ({
      text: JSON.stringify({
        items: batch.map((item) => (scheme === 'jev' ? JEV(item.id) : STRUCTURED(item.id, '看多'))),
      }),
      usage: { inputTokens: 9, outputTokens: 1, totalTokens: 10 },
    }),
  });
  assert.equal(result.targets[0].a.directionalCount, 2);
  assert.equal(result.targets[0].a.sentiment, '数据不足');
  assert.equal(result.targets[0].b.sentiment, '数据不足');
  const targetRow = report.split('\n').find((line) => line.startsWith('| 小标的 |'));
  assert.match(targetRow, /数据不足/);
  assert.doesNotMatch(targetRow, /100%/);
  assert.doesNotMatch(targetRow, /平淡/);
  assert.doesNotMatch(report, /平淡/);
});

test('only B does not call scheme A', async () => {
  const schemes = [];
  const materials = {
    date: '2026-10-12',
    targets: [{ key: 'SH1', name: '甲', posts: [{ id: '1', text: '看多', url: 'https://xueqiu.com/1' }], comments: [] }],
  };
  const { report, result } = await runInvestorDigestAb({
    materials, only: 'B', batchSize: 25, batchSizeB: 12, retries: 0,
    complete: async ({ scheme, batch }) => {
      schemes.push(scheme);
      return {
        text: JSON.stringify({ items: batch.map((item) => STRUCTURED(item.id)) }),
        usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
      };
    },
  });
  assert.deepEqual(schemes, ['structured']);
  assert.equal(result.schemeA.skipped, true);
  assert.equal(result.schemeB.usage.calls, 1);
  assert.match(report, /只跑了方案 B/);
  assert.match(report, /A 覆盖率：未运行/);
  assert.deepEqual(resolveSchemeSelection('b'), { a: false, b: true });
  assert.throws(() => resolveSchemeSelection('C'), /--only 只能是 A 或 B/);
});

test('522 items at batch 12 stay inside the scheme B call cap', () => {
  assert.equal(DEFAULT_BATCH_SIZE_B, 12);
  const estimate = estimateAbCalls(295 + 227, 25, 12);
  assert.equal(estimate.perA, 21);
  assert.equal(estimate.perB, 44);
  assert.equal(estimate.total, 65);
  assert.ok(estimate.perB <= DEFAULT_MAX_CALLS_B);
  assert.ok(estimate.total < 500);
});

test('model env selects Gemini JSON or Gemma streaming without a quota ledger', async () => {
  const geminiCalls = [];
  const gemini = createInvestorAbModel({
    env: { AI_CENTER_INVESTOR_DIGEST_AB_MODEL: 'gemini-3.1-flash-lite', GEMINI_API_KEY: 'test-key' },
    fetch: async (url, init) => {
      geminiCalls.push({ url: String(url), body: JSON.parse(init.body), key: init.headers['x-goog-api-key'] });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"items":[]}' }] } }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const geminiResult = await gemini.complete({ system: '系统', prompt: '材料' });
  assert.match(geminiCalls[0].url, /models\/gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(geminiCalls[0].body.systemInstruction.parts[0].text, '系统');
  assert.equal(geminiCalls[0].key, 'test-key');
  assert.equal(geminiCalls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(geminiCalls[0].body.generationConfig.maxOutputTokens, 16384);
  assert.equal(geminiResult.usage.inputTokens, 11);
  assert.equal(geminiResult.usage.totalTokens, 15);

  const gemmaCalls = [];
  const gemma = createInvestorAbModel({
    env: {
      AI_CENTER_INVESTOR_DIGEST_AB_MODEL: 'gemma-4-26b-a4b-it',
      AI_CENTER_GEMMA_TRANSLATION_KEY_ENV: 'GEMINI_API_KEY5',
      GEMINI_API_KEY5: 'gemma-key',
      GEMINI_API_KEY: 'other-key',
    },
    fetch: async (url, init) => {
      gemmaCalls.push({ url: String(url), body: JSON.parse(init.body), key: init.headers['x-goog-api-key'] });
      const payload = {
        candidates: [{ content: { parts: [{ text: '{"items":[]}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, totalTokenCount: 8 },
      };
      return new Response(`data: ${JSON.stringify(payload)}\n\n`, { status: 200 });
    },
  });
  const gemmaResult = await gemma.complete({ system: '系统', prompt: '材料' });
  assert.match(gemmaCalls[0].url, /gemma-4-26b-a4b-it:streamGenerateContent\?alt=sse$/);
  assert.equal(gemmaCalls[0].body.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
  assert.equal(gemmaCalls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(gemmaCalls[0].body.generationConfig.maxOutputTokens, 16384);
  assert.match(gemmaCalls[0].body.contents[0].parts[0].text, /系统/);
  assert.equal(gemmaCalls[0].key, 'gemma-key');
  assert.equal(gemmaResult.usage.inputTokens, 6);
  assert.equal(gemmaResult.usage.totalTokens, 8);
});

test('experiment scripts stay read-only and off the production digest path', () => {
  const exporter = readFileSync('scripts/experiments/export-investor-discussion.mjs', 'utf8');
  const runner = readFileSync('scripts/experiments/investor-digest-ab.mjs', 'utf8');
  assert.match(exporter, /readonly:\s*true/);
  assert.match(runner, /readonly:\s*true/);
  assert.doesNotMatch(exporter, /\b(INSERT|UPDATE|DELETE|REPLACE)\b/);
  assert.doesNotMatch(runner, /\b(INSERT|UPDATE|DELETE|REPLACE)\b/);
  for (const file of [
    'packages/runtime/src/investor-discussion-job.js',
    'packages/domain/src/investor-discussion.js',
    'apps/web/public/investor-digest.js',
    'apps/web/src/routes/investor-discussion-routes.js',
  ]) {
    assert.equal(readFileSync(file, 'utf8').includes('investor-digest-ab'), false, file);
  }
});
