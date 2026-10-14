import test from 'node:test';
import assert from 'node:assert/strict';
import { isAwesomeListUpdateNoise } from '../packages/domain/src/awesome-list-noise.js';
import { createTreeMaterialPort } from '../packages/domain/src/information-tree-materials.js';
import { createReadingHourService } from '../packages/domain/src/reading-hour-service.js';

test('awesome-list noise matches the repo-update title and github.com awesome-* urls only', () => {
  assert.equal(isAwesomeListUpdateNoise({ title: 'awesome-autoresearch 项目更新：新增 5 条资源' }), true);
  assert.equal(isAwesomeListUpdateNoise({ title: '「awesome-ml 项目更新」' }), true);
  assert.equal(isAwesomeListUpdateNoise({
    title: '仓库有新提交',
    urls: ['https://github.com/org/awesome-autoresearch/commits/main'],
  }), true);
  assert.equal(isAwesomeListUpdateNoise({
    title: 'www 主机同样算',
    sourceUrl: 'https://www.github.com/org/awesome-list',
  }), true);
  assert.equal(isAwesomeListUpdateNoise({ title: '美联储维持利率', sourceUrl: 'https://www.reuters.com/markets' }), false);
  assert.equal(isAwesomeListUpdateNoise({
    title: 'OpenAI 发布新模型',
    sourceUrl: 'https://github.com/openai/whisper/releases/tag/v1',
  }), false);
  assert.equal(isAwesomeListUpdateNoise({ title: 'awesome 资源整理', sourceUrl: 'https://github.com/sindresorhus/awesome' }), false);
  assert.equal(isAwesomeListUpdateNoise({ title: '讨论一份 awesome 清单', sourceUrl: 'https://example.com/lists' }), false);
});

test('hourly candidates drop awesome-list repo updates before preparation', async () => {
  const port = createTreeMaterialPort({
    feedService: {
      listContentItemsInWindow() {
        return [
          { id: 'feed:noise', title: 'awesome-autoresearch 项目更新：新增 5 条', sourceUrl: 'https://news.example/mirror', eventAt: 1, sourceName: '镜像' },
          { id: 'feed:url', title: '列表有新增', sourceUrl: 'https://github.com/org/awesome-autoresearch', eventAt: 2, sourceName: 'GitHub' },
          { id: 'feed:keep', title: '美联储维持利率', sourceUrl: 'https://github.com/openai/whisper', eventAt: 3, sourceName: 'GitHub' },
        ];
      },
    },
    mediaService: {
      informationCandidates: () => [
        { id: 'media:noise', title: '另一份清单', sourceUrl: 'https://github.com/org/awesome-llm/pulse', eventAt: 4 },
        { id: 'media:keep', title: '芯片出货', sourceUrl: 'https://example.com/chips', eventAt: 5 },
      ],
    },
  });
  const rows = await port.candidates('local', { startAt: 0, endAt: 10 });
  assert.deepEqual(rows.map((row) => row.id), ['feed:keep', 'media:keep']);
});

test('reading hour presentation hides stored awesome-list updates and fills publishedAt', () => {
  const endAt = 2_000;
  const snapshot = {
    id: 'rh:noise', status: 'ready', scope: 'hour', routeVersion: 'reading-route-2026-10-10.4',
    window: { startAt: 1000, endAt }, timezone: 'Asia/Shanghai', generatedAt: endAt,
    scored: 3, candidates: 3, selected: 3, groups: [], sections: [],
    items: [
      { sourceId: 's1', sourceVersion: '1', nodeId: 'noise', title: 'awesome-autoresearch 项目更新：新增 5 条', disposition: 'hit', hits: [], readingDirectionName: '科技与AI', readingThemeName: '模型与技术' },
      { sourceId: 's2', sourceVersion: '1', nodeId: 'url', title: '仓库有新提交', disposition: 'hit', hits: [], readingDirectionName: '科技与AI', readingThemeName: '模型与技术' },
      { sourceId: 's3', sourceVersion: '1', nodeId: 'keep', title: '美联储维持利率', disposition: 'hit', hits: [], publisher: '', readingDirectionName: '金融', readingThemeName: '美国' },
    ],
  };
  const nodes = {
    noise: { title: 'awesome-autoresearch 项目更新：新增 5 条', sourceRefs: [] },
    url: { title: '仓库有新提交', sourceRefs: [{ type: 'content-item', id: 'c-url' }] },
    keep: { title: '美联储维持利率', publisher: '', sourceRefs: [{ type: 'content-item', id: 'c-keep' }], eventAt: 1500 },
  };
  const service = createReadingHourService({
    repository: { getReadingHour: () => snapshot, getNode: (_workspace, id) => nodes[id] },
    enabled: true,
    sourceFactsFor(_workspace, refs) {
      const id = refs?.[0]?.id;
      if (id === 'c-url') return { titles: ['commit'], urls: ['https://github.com/org/awesome-autoresearch/commits/main'], publishedAt: 1400 };
      if (id === 'c-keep') return { titles: ['Fed holds rates'], urls: ['https://www.reuters.com/markets'], publishedAt: 1600 };
      return { titles: [], urls: [], publishedAt: null };
    },
  });
  const shown = service.get('local', 'rh:noise');
  assert.deepEqual(shown.items.map((item) => item.nodeId), ['keep']);
  assert.equal(shown.items[0].publishedAt, 1600);
  assert.equal(shown.items[0].firstIngestedAt, 1500);
});

test('scoring skips awesome-list nodes and stores the source publish time', async () => {
  const calls = [];
  const service = createReadingHourService({
    enabled: true,
    env: { AI_CENTER_READING_CLASS_BATCH: '1' },
    agentRuntime: { async run() {
      calls.push('run');
      return { answer: '{"primaryDirection":"finance","subjectKind":"market_asset","domainTagIds":[],"classificationStatus":"classified","evidenceQuote":"利率"}' };
    } },
    repository: {
      listInformationInWindow() {
        return [
          { id: 'noise', title: '普通标题', text: '列表更新', sourceRefs: [{ type: 'content-item', id: 'c1' }], eventAt: 10 },
          { id: 'keep', title: '美联储维持利率', text: '利率不变。', sourceRefs: [{ type: 'content-item', id: 'c2' }], eventAt: 20 },
        ];
      },
      publishReadingHour(_workspace, snapshot) { return snapshot; },
    },
    feedRepository: { listItemSources() { return []; } },
    sourceFactsFor(_workspace, refs) {
      if (refs?.[0]?.id === 'c1') return { titles: ['awesome-autoresearch 项目更新：新增 5 条'], urls: ['https://github.com/org/awesome-autoresearch'], publishedAt: 11 };
      return { titles: ['Fed holds'], urls: ['https://example.com/fed'], publishedAt: 22 };
    },
  });
  const scored = await service.scoreWindow({ window: { startAt: 1, endAt: 100 } });
  assert.equal(calls.length, 1);
  assert.deepEqual(scored.items.map((item) => item.nodeId), ['keep']);
  assert.equal(scored.items[0].publishedAt, 22);
});
