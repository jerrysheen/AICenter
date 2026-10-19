import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectDecisionQuestions } from '../packages/connectors/src/bamboo-startlux.js';
import { createStore } from '../packages/database/src/index.js';
import {
  RESEARCH_RELEVANCE_NOUL_VERSION,
  RESEARCH_TAG_NOUL_VERSION,
  estimateResearchBambooCalls,
  researchRelevanceQuestions,
  researchTagQuestion,
  researchVerdictFromScores,
  selectResearchTags,
} from '../packages/domain/src/research-noul.js';
import { createResearchRecallService } from '../packages/domain/src/research-recall-service.js';
import { createResearchRelevanceJudge, createResearchTagJudge } from '../packages/runtime/src/research-judges.js';

const START = 1_700_000_000_000;
const DAY = 86_400_000;

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function noul(value) {
  return { type: 'noul', noul: value };
}

function tag(id, extra = {}) {
  return {
    id,
    name: extra.name || id,
    definition: '材料写明一项可核对的事实。',
    include: '出现明确事实时计入。',
    exclude: '只有名字时不要计入。',
    keywords: extra.keywords || [],
    aliases: extra.aliases || [],
    enabled: true,
  };
}

function saveNode(store, sourceId, title, text) {
  const eventAt = START + 1;
  const version = sha(JSON.stringify({ sourceId, eventAt, title, text }));
  const node = {
    title, text, tagId: null,
    id: `i:${version}`, layer: 'information', version,
    children: [], articleIds: [sourceId], sourceId,
    window: { startAt: eventAt, endAt: eventAt + 1 },
    generatedAt: eventAt, eventAt,
    sourceVersion: version,
    sourceUpdatedAt: eventAt,
  };
  store.repositories.informationTree.saveNode('local', node);
  store.repositories.informationTree.setInformationHead('local', node, 'policy');
  return node;
}

function serviceWith(store, judges, modelId = 'research-mock') {
  return createResearchRecallService({
    repository: store.repositories.research,
    feedRepository: store.repositories.feed,
    mediaRepository: store.repositories.media,
    informationRepository: store.repositories.informationTree,
    modelId,
    now: () => START,
    ...judges,
  });
}

test('noul questions stay inside the Bamboo contract and map scores to stored fields', () => {
  const projected = projectDecisionQuestions({
    order_adoption: researchTagQuestion(tag('order_adoption', { name: '订单与采用' })),
    ...researchRelevanceQuestions(),
  });
  for (const question of Object.values(projected)) {
    assert.equal(question.type, 'noul');
    assert.equal(typeof question.instructions, 'string');
    assert.equal(typeof question.criteria.true, 'string');
    assert.equal(typeof question.criteria.false, 'string');
  }
  assert.throws(() => projectDecisionQuestions({ research_tags: '只返回 JSON' }), /必须是对象/);
  assert.equal(researchVerdictFromScores({ direct_answer: 0.6, related_context: 0, verifiable_fact: 0.5 }, { text: 'x' }), 'direct');
  assert.equal(researchVerdictFromScores({ direct_answer: 0.6, related_context: 0.6, verifiable_fact: 0.49 }, { text: 'x' }), 'background');
  assert.equal(researchVerdictFromScores({ direct_answer: 0.4, related_context: 0.2, verifiable_fact: 0.1 }, { text: 'x' }), 'background');
  assert.equal(researchVerdictFromScores({ direct_answer: 0.39, related_context: 0.59, verifiable_fact: 0.9 }, { title: '短' }), 'insufficient');
  assert.equal(researchVerdictFromScores({
    direct_answer: 0.39, related_context: 0.59, verifiable_fact: 0.9,
  }, { text: '补充事实'.repeat(9) }), 'insufficient');
  assert.equal(researchVerdictFromScores({
    direct_answer: 0.39, related_context: 0.59, verifiable_fact: 0.9,
  }, { text: '补充事实'.repeat(10) }), 'irrelevant');
  assert.equal(researchVerdictFromScores({ direct_answer: 0.8, related_context: 0.8 }, { text: 'x' }), '');
  const capped = selectResearchTags(
    Array.from({ length: 13 }, (_, index) => tag(`tag_${String(index).padStart(2, '0')}`, { keywords: ['共同'] })),
    { text: '共同' },
  );
  assert.equal(capped.asked.length, 12);
  assert.deepEqual(capped.skipped.map((item) => item.id), ['tag_12']);
  assert.equal(selectResearchTags([tag('only')], { text: '没有关键词' }).asked.length, 1);
  const estimate = estimateResearchBambooCalls({ members: 200, tagCount: 8, insufficientRate: 0 });
  assert.deepEqual(estimate, { perSummary: 2, summary: 400, body: 0, total: 400 });
  assert.equal(estimateResearchBambooCalls({ members: 200, tagCount: 8, insufficientRate: 0.1 }).total, 440);
});

test('TypeSafe research judges still send one JSON string', async () => {
  let seen = null;
  const judge = createResearchTagJudge({
    async evaluate(payload) {
      seen = payload;
      return { answers: { research_tags: { assignments: [{ resourceId: 'a', tagIds: [] }] } }, model: 'jev-test', usage: {} };
    },
  });
  const parsed = await judge.judge({ tags: [tag('order_adoption')], items: [{ resourceId: 'a', title: '甲', text: '乙' }] });
  assert.equal(typeof seen.questions.research_tags, 'string');
  assert.equal(judge.promptVersion, undefined);
  assert.equal(judge.batchCharge, 'once');
  assert.deepEqual(parsed.assignments, [{ resourceId: 'a', tagIds: [] }]);
});

test('Bamboo research judges score each tag and derive the verdict', async () => {
  const calls = [];
  const client = {
    providerId: 'bamboo',
    modelId: 'startlux-test',
    async evaluate(payload) {
      calls.push(payload);
      const ids = Object.keys(payload.questions);
      if (ids.includes('direct_answer')) {
        const direct = payload.state.text.includes('上调') ? 0.7 : 0.1;
        return { model: 'startlux-test', usage: { input_tokens: 3, output_tokens: 1 }, answers: {
          direct_answer: noul(direct), related_context: noul(0.2), verifiable_fact: noul(0.6),
        } };
      }
      return {
        model: 'startlux-test',
        usage: { input_tokens: 4, output_tokens: 2 },
        answers: Object.fromEntries(ids.map((id) => [id, noul(id === 'order_adoption' ? 0.6 : 0.599)])),
      };
    },
  };
  const tags = [tag('order_adoption', { name: '订单与采用' }), tag('other_fact', { name: '其他事实' })];
  const tagJudge = createResearchTagJudge(client);
  const relevanceJudge = createResearchRelevanceJudge(client);
  assert.equal(tagJudge.promptVersion, RESEARCH_TAG_NOUL_VERSION);
  assert.equal(relevanceJudge.promptVersion, RESEARCH_RELEVANCE_NOUL_VERSION);
  assert.equal(tagJudge.batchCharge, 'item');
  const tagged = await tagJudge.judge({
    tags,
    items: [{ resourceId: 'a', title: '云厂商', text: '客户把本季订单上调两成。' }],
  });
  assert.deepEqual(tagged.assignments[0].tagIds, ['order_adoption']);
  assert.equal(calls[0].questions.order_adoption.type, 'noul');
  assert.equal(typeof calls[0].questions.order_adoption.instructions, 'string');
  const judged = await relevanceJudge.judge({
    question: { objective: '订单发生了什么变化？', subquestions: [{ text: '订单是否上调？' }], evidence: '要有数字。' },
    items: [{ resourceId: 'a', title: '云厂商', text: '客户把本季订单上调两成。' }],
  });
  assert.equal(judged.results[0].verdict, 'direct');
  assert.equal(tagged.usage.requests, 1);
  assert.equal(judged.usage.requests, 1);

  const many = Array.from({ length: 13 }, (_, index) => tag(`tag_${String(index).padStart(2, '0')}`, {
    keywords: index === 3 ? ['订单'] : [`词项${index}`],
  }));
  const filtered = await tagJudge.judge({
    tags: many,
    items: [{ resourceId: 'b', title: '订单', text: '只有订单两个字，没有其他候选词。' }],
  });
  assert.deepEqual(Object.keys(calls.at(-1).questions), ['tag_03']);
  assert.deepEqual(filtered.assignments[0].tagIds, []);
  const none = await tagJudge.judge({
    tags: many,
    items: [{ resourceId: 'c', title: '简讯', text: '这段文字没有任何候选关键词，所以不该调用。' }],
  });
  assert.deepEqual(none.assignments, [{ resourceId: 'c', tagIds: [] }]);
  assert.equal(none.usage.requests, 0);
  assert.equal(calls.length, 3);
});

test('Bamboo research recall persists the tag and verdict without sharing the TypeSafe cache', async () => {
  const store = createStore(':memory:');
  store.repositories.informationTree.activatePolicy('local', 'policy');
  saveNode(store, 'info:order', '云厂商上调订单', '客户把本季 HBM 订单上调 20%，并写明了交付季度。');
  const calls = [];
  const client = {
    providerId: 'bamboo',
    modelId: 'startlux-test',
    async evaluate(payload) {
      calls.push(Object.keys(payload.questions));
      if (payload.questions.direct_answer) {
        return { model: 'startlux-test', usage: { input_tokens: 3, output_tokens: 1 }, answers: {
          direct_answer: noul(0.7), related_context: noul(0.2), verifiable_fact: noul(0.6),
        } };
      }
      return { model: 'startlux-test', usage: { input_tokens: 4, output_tokens: 2 }, answers: { order_adoption: noul(0.6) } };
    },
  };
  const service = serviceWith(store, {
    tagJudge: createResearchTagJudge(client),
    relevanceJudge: createResearchRelevanceJudge(client),
  }, 'startlux-test');
  service.activate({
    catalog: {
      id: 'sample_direction',
      version: '1',
      tags: [tag('order_adoption', { name: '订单与采用', keywords: ['订单'] })],
      questions: [{
        id: 'sample_question', version: '1', objective: '组织订单变化，材料不足时结论为尚不能判断。',
        subquestions: [{ id: 'demand', text: '订单发生了什么变化？', tagIds: ['order_adoption'], queries: [] }],
        queries: [], historyLookbackMs: 0, evidence: '材料不足时结论为尚不能判断。',
      }],
    },
  });
  const window = { startAt: START, endAt: START + DAY };
  const report = await service.buildReport({ questionId: 'sample_question', window, budget: { maxRequests: 10, maxMilliseconds: 60_000 } });
  assert.equal(report.usage.requests, 2);
  assert.ok(report.judgmentSnapshot.some((row) => row.kind === 'tag' && row.key === 'order_adoption' && row.matched === true));
  assert.ok(report.judgmentSnapshot.some((row) => row.kind === 'relevance' && row.verdict === 'direct'));
  assert.ok(report.pack.events.some((event) => event.hits.tag.includes('order_adoption') && event.hits.relevance.includes('direct')));
  const again = await service.buildReport({ questionId: 'sample_question', window, budget: { maxRequests: 10, maxMilliseconds: 60_000 } });
  assert.equal(again.id, report.id);
  assert.equal(calls.length, 2);

  let plain = 0;
  const typesafe = serviceWith(store, {
    tagJudge: async () => { plain += 1; return { assignments: [] }; },
    relevanceJudge: async (payload) => {
      plain += 1;
      return { results: payload.items.map((item) => ({ resourceId: item.resourceId, verdict: 'irrelevant' })) };
    },
  }, 'startlux-test');
  await typesafe.buildReport({ questionId: 'sample_question', window, budget: { maxRequests: 10, maxMilliseconds: 60_000 } });
  assert.equal(plain, 2);
});

test('tags beyond the cap with no keyword hit do not spend a research request', async () => {
  const store = createStore(':memory:');
  store.repositories.informationTree.activatePolicy('local', 'policy');
  saveNode(store, 'info:plain', '简讯', '这段材料足够长，用来确认它不会因为太短被当成材料不足，但里面没有候选标签的关键词。');
  const tags = Array.from({ length: 13 }, (_, index) => tag(`tag_${String(index).padStart(2, '0')}`, {
    name: `标签${index}`,
    keywords: [`词项${index}`],
  }));
  let tagCalls = 0;
  const service = serviceWith(store, {
    tagJudge: createResearchTagJudge({
      providerId: 'bamboo',
      modelId: 'startlux-test',
      async evaluate(payload) {
        if (!payload.questions.direct_answer) tagCalls += 1;
        return { model: 'startlux-test', usage: {}, answers: {
          direct_answer: noul(0.1), related_context: noul(0.1), verifiable_fact: noul(0.1),
        } };
      },
    }),
    relevanceJudge: createResearchRelevanceJudge({
      providerId: 'bamboo',
      modelId: 'startlux-test',
      async evaluate() {
        return { model: 'startlux-test', usage: { requests: 1 }, answers: {
          direct_answer: noul(0.1), related_context: noul(0.1), verifiable_fact: noul(0.1),
        } };
      },
    }),
  }, 'startlux-test');
  service.activate({
    catalog: {
      id: 'wide_sample',
      version: '1',
      tags,
      questions: [{
        id: 'wide_question', version: '1', objective: '整理这些标签对应的事实。',
        subquestions: [{ id: 'all_tags', text: '材料里有哪些事实？', tagIds: tags.map((item) => item.id), queries: [] }],
        queries: [], historyLookbackMs: 0, evidence: '材料不足时结论为尚不能判断。',
      }],
    },
  });
  const report = await service.buildReport({
    questionId: 'wide_question',
    window: { startAt: START, endAt: START + DAY },
    budget: { maxRequests: 10, maxMilliseconds: 60_000 },
  });
  assert.equal(tagCalls, 0);
  assert.equal(report.usage.requests, 1);
  assert.ok(report.judgmentSnapshot.filter((row) => row.kind === 'tag').every((row) => row.matched === false && row.status === 'succeeded'));
  assert.ok(report.judgmentSnapshot.some((row) => row.kind === 'relevance' && row.verdict === 'irrelevant'));
});

test('worker uses the classification client for research recall only when the provider is bamboo', () => {
  const worker = readFileSync(new URL('../apps/worker/src/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /const recallClient = resolveClassificationProvider\(env\) === 'bamboo' \? classificationClient : typesafeClient/);
  assert.match(worker, /modelId: recallClient\?\.modelId \|\| ''/);
});
