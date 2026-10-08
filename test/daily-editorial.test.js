import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../packages/database/src/index.js';
import {buildDailyEditorial, clusterInformationNodes, collectDailyEditorialMaterials} from '../packages/domain/src/daily-editorial.js';

const map = {macro: 'finance', energy: 'finance', ai: 'tech', geopolitics: 'policy'};
const meta = {reportDate: '2026-10-08', timezone: 'Asia/Shanghai', generatedAt: 10, model: 'cursor-session', calls: 1, inputTokens: null, outputTokens: null, cost: null};
const node = (id, title, text, tagId = 'macro', eventAt = 1) => ({id, title, text, tagId, eventAt, version: 'v', layer: 'information'});
const materials = (nodes, extra = {}) => ({
  window: {startAt: 0, endAt: 3_600_000},
  hours: [{id: 'h1'}],
  modules: [{id: 'm1'}],
  nodes,
  incompleteHours: extra.incompleteHours || [],
  pendingIds: extra.pendingIds || [],
  unprocessedIds: extra.unprocessedIds || [],
});

test('same-event titles merge and unrelated items stay apart', () => {
  const nodes = [
    node('a', '沙特上调明年原油价格预测', '沙特将明年布伦特预测均价上调至每桶90美元。'),
    node('b', '沙特将明年原油价格预测上调', '沙特能源部称明年布伦特预测均价为每桶90美元，此前为85美元。', 'energy', 2),
    node('c', '软件外包公司签订年度维护合同', '该公司签订维护合同，金额未披露。', 'ai', 3),
    node('d', '跨洋海底电缆完成登陆许可', '电缆项目获得登陆许可，尚未开工。', 'geopolitics', 4),
    node('e', '知名编辑去世', '讣告称其于周二去世，享年78岁。', 'geopolitics', 5),
  ];
  const clusters = clusterInformationNodes(nodes, map);
  assert.equal(clusters.length, 4);
  const oil = clusters.find(item => item.sourceNodeIds.includes('a'));
  assert.ok(oil.sourceNodeIds.includes('b'));
  assert.equal(oil.facts.length, 2);
  assert.equal(clusters.filter(item => item.direction === 'tech').length, 1);
  const yields = clusterInformationNodes([
    node('us', '美国30年期国债收益率升至5.70%', '美国30年期国债收益率升至5.70%。'),
    node('uk', '英国30年期国债收益率升至6.03%', '英国30年期国债收益率升至6.03%。'),
  ], map);
  assert.equal(yields.length, 2);
});

test('partial window stays partial and qualifier changes are rejected', () => {
  const nodes = [
    node('a', '某公司融资', '该公司计划融资至多40亿美元，尚未完成。', 'ai'),
    node('b', '美联储讨论能源价格', '一位美联储官员讨论能源价格对通胀的影响，没有给出新的利率决定。'),
  ];
  const source = materials(nodes, {incompleteHours: [0], pendingIds: ['late']});
  const clustered = clusterInformationNodes(nodes, map);
  const tech = clustered.find(item => item.sourceNodeIds.includes('a'));
  const finance = clustered.find(item => item.sourceNodeIds.includes('b'));
  const overlay = {
    overview: '能源价格讨论和一笔尚未完成的融资计划被放在相邻位置，只因分别涉及价格环境与产业资本。材料没有证明二者有因果关系。',
    events: {
      [tech.eventId]: {importanceLevel: 'core', importanceReason: '融资仍是计划，上限会改变这句话的含义。', direction: 'tech', status: 'planned'},
      [finance.eventId]: {importanceLevel: 'related', importanceReason: '它补充价格环境，但没有新的利率决定。', direction: 'finance', status: 'opinion'},
    },
    relations: [{eventIds: [tech.eventId, finance.eventId], type: 'unverified-link', certainty: 'unverified', reason: '同一天出现，材料没有证明融资和这次讨论有关。'}],
    articles: [
      {
        direction: 'tech',
        title: '一笔还没完成的融资',
        lead: '公司仍是计划融资至多40亿美元，尚未完成。',
        leadEventIds: [tech.eventId],
        sections: [{heading: '融资还在计划里', kind: 'theme', eventIds: [tech.eventId], paragraphs: ['材料写的是计划融资至多40亿美元，尚未完成。不能把它写成已经拿到这笔钱。']}],
      },
      {
        direction: 'finance',
        title: '价格讨论还没有变成利率决定',
        lead: '官员讨论了能源价格和通胀，材料里没有新的利率决定。',
        leadEventIds: [finance.eventId],
        sections: [{heading: '讨论本身', kind: 'theme', eventIds: [finance.eventId], paragraphs: ['这是一位官员的讨论，不是已经宣布的利率决定。']}],
      },
    ],
  };
  const editorial = buildDailyEditorial({materials: source, directionByTag: map, overlay, meta});
  assert.equal(editorial.status, 'partial');
  assert.equal(editorial.coverage.informationNodeCount, 2);
  assert.equal(editorial.coverage.eventCount, 2);
  assert.equal(editorial.coverage.inBodyEventCount, 2);
  assert.equal(editorial.coverage.complete, false);
  assert.match(editorial.statusNote, /部分覆盖/);
  assert.equal(editorial.events.find(event => event.eventId === tech.eventId).status, 'planned');
  const broken = structuredClone(overlay);
  broken.articles[0].sections[0].paragraphs = ['公司完成40亿美元融资。'];
  assert.throws(() => buildDailyEditorial({materials: source, directionByTag: map, overlay: broken, meta}), /限定被改写/);
  const causal = structuredClone(overlay);
  causal.relations[0] = {...causal.relations[0], type: 'supported-impact', certainty: 'unverified'};
  assert.throws(() => buildDailyEditorial({materials: source, directionByTag: map, overlay: causal, meta}), /有依据的影响/);
});

test('a node with no text cannot disappear from coverage', () => {
  const nodes = [node('a', '有正文', '已经公布一项合作。', 'ai'), node('b', '空正文', '', 'ai', 2)];
  assert.throws(() => buildDailyEditorial({materials: materials(nodes), directionByTag: map, overlay: {}, meta}), /归属不完整/);
});

test('failed editorial leaves the previous draft readable', () => {
  const store = createStore(':memory:');
  try {
    const nodes = [node('a', '合作', '两家公司已经签署合作备忘录。', 'ai')];
    const clusters = clusterInformationNodes(nodes, map);
    const overlay = {
      overview: '今天只有一项已经签署的合作备忘录，没有更多材料能支持扩展判断。',
      events: {[clusters[0].eventId]: {importanceLevel: 'core', importanceReason: '这是已经发生的签署。', status: 'occurred', direction: 'tech'}},
      articles: [{direction: 'tech', title: '一项已签署的合作', lead: '备忘录已经签署。', leadEventIds: [clusters[0].eventId], sections: [{heading: '签署', kind: 'theme', eventIds: [clusters[0].eventId], paragraphs: ['两家公司已经签署合作备忘录。']}]}],
    };
    const ready = buildDailyEditorial({materials: materials(nodes), directionByTag: map, overlay, meta});
    store.repositories.informationTree.saveEditorial('local', ready);
    const failed = {...ready, id: 'editorial:failedcase', status: 'failed', statusNote: '成稿失败，旧稿继续可读。'};
    store.repositories.informationTree.saveEditorial('local', failed);
    assert.equal(store.repositories.informationTree.editorialForWindow('local', ready.window).id, ready.id);
    assert.equal(store.repositories.informationTree.getEditorial('local', failed.id).status, 'failed');
    const edited = buildDailyEditorial({
      materials: materials(nodes),
      directionByTag: map,
      overlay: {...overlay, overview: '今天仍然只有一项已经签署的合作备忘录。'},
      meta: {...meta, calls: 2},
    });
    assert.notEqual(edited.id, ready.id);
    assert.equal(edited.inputSnapshotHash, ready.inputSnapshotHash);
    store.repositories.informationTree.saveEditorial('local', edited);
    assert.equal(store.repositories.informationTree.editorialForWindow('local', ready.window).id, edited.id);
    assert.equal(store.repositories.informationTree.getEditorial('local', ready.id).overview, ready.overview);
  } finally {
    store.close();
  }
});

test('collection expands information nodes and records unfinished hours', () => {
  const info = {id: 'i1', layer: 'information', title: '标题', text: '正文', tagId: 'ai', eventAt: 5, version: '1'};
  const module = {id: 'm1', layer: 'hourly', children: ['i1']};
  const edition = {id: 'e1', status: 'partial', window: {startAt: 0, endAt: 3_600_000}, roots: ['m1'], pendingIds: ['late'], inputIds: ['i1']};
  const repository = {
    list() { return [{edition}]; },
    getNode(_workspace, id) { return id === 'm1' ? module : id === 'i1' ? info : null; },
  };
  const collected = collectDailyEditorialMaterials(repository, 'local', {startAt: 0, endAt: 7_200_000});
  assert.deepEqual(collected.incompleteHours, [0, 3_600_000]);
  assert.equal(collected.nodes.length, 1);
  assert.equal(collected.modules.length, 1);
  assert.deepEqual(collected.pendingIds, ['late']);
});
