import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createStore} from '../packages/database/src/index.js';
import {MediaConfigSchema} from '../packages/contracts/src/media.js';
import {parseFlashFeedQuery} from '../packages/contracts/src/index.js';
import {ValidationError} from '../packages/contracts/src/errors.js';
import {isTerminalPendingReason} from '../packages/domain/src/information-tree-policy.js';
import {
  isFlashSource,
  loadResolvedFlashSources,
  resolveFlashSources,
} from '../packages/domain/src/flash-sources.js';
import {createFeedService} from '../packages/domain/src/feed-service.js';
import {createInformationTreeService} from '../packages/domain/src/information-tree-service.js';
import {createTreeMaterialPort} from '../packages/domain/src/information-tree-materials.js';
import {createReadingHourService} from '../packages/domain/src/reading-hour-service.js';
import {loadInformationTreeSkills} from '../packages/runtime/src/information-tree/skills.js';
import {createMediaEnrichJobHandlers} from '../packages/runtime/src/media-enrich-module.js';

const flash = resolveFlashSources({
  env: {},
  configured: [
    {id: 'xueqiu:home:livenews', label: '雪球7x24'},
    {id: 'chinaiol:flash', label: '产业在线快讯'},
  ],
});

test('flash source set comes from the file, a media flag, or a full env replacement', () => {
  const fromFile = loadResolvedFlashSources({configDirectory: 'config', env: {}, mediaSources: []});
  assert.equal(fromFile.ids.has('xueqiu:home:livenews'), true);
  assert.equal(fromFile.ids.has('chinaiol:flash'), true);
  assert.equal(fromFile.labels.has('雪球7x24'), true);
  assert.equal(isFlashSource({feed: 'livenews'}, fromFile), true);
  assert.equal(isFlashSource({publisher: '雪球关注'}, fromFile), false);

  const flagged = resolveFlashSources({
    env: {},
    configured: [{id: 'xueqiu:home:livenews', label: '雪球7x24'}],
    mediaSources: [{flash: true, sourceKey: 'bbc', publisher: 'BBC'}],
  });
  assert.equal(flagged.ids.has('bbc'), true);
  assert.equal(flagged.ids.has('media:bbc'), true);
  assert.equal(isFlashSource({sourceKey: 'bbc', publisher: 'BBC'}, flagged), true);

  const replaced = resolveFlashSources({
    env: {AI_CENTER_FLASH_SOURCES: 'only-this，另一条'},
    configured: [{id: 'xueqiu:home:livenews', label: '雪球7x24'}],
    mediaSources: [{flash: true, sourceKey: 'bbc', publisher: 'BBC'}],
  });
  assert.deepEqual([...replaced.ids], ['only-this', '另一条']);
  assert.equal(isFlashSource({publisher: '雪球7x24', feed: 'livenews'}, replaced), false);
  assert.equal(isFlashSource({id: '另一条'}, replaced), true);
  assert.equal(isFlashSource({feed: '7x24'}, replaced), false);
});

test('media config still parses without a flash flag and stays at 41 sources', () => {
  const config = JSON.parse(fs.readFileSync('config/media.json', 'utf8'));
  const parsed = MediaConfigSchema.parse(config);
  assert.equal(parsed.sources.length, 41);
  assert.equal(parsed.sources.every((source) => source.flash === false), true);
  assert.equal(MediaConfigSchema.parse({
    version: 1,
    sources: [{...parsed.sources[0], flash: true}],
  }).sources[0].flash, true);
});

test('flash feed query accepts 1 to 100 and defaults to 50', () => {
  assert.deepEqual(parseFlashFeedQuery({}), {limit: 50});
  assert.deepEqual(parseFlashFeedQuery({limit: '80'}), {limit: 80});
  assert.throws(() => parseFlashFeedQuery({limit: '0'}), ValidationError);
  assert.throws(() => parseFlashFeedQuery({limit: '101'}), ValidationError);
});

test('ingesting a flash source saves items, skips JEV, and lists them by time', async () => {
  const store = createStore(':memory:');
  const evaluated = [];
  const ready = [];
  const service = createFeedService({
    legacyRepository: {},
    feedRepository: store.repositories.feed,
    sourcePort: {
      persistence(_sourceId, sourceInput) {
        const feed = sourceInput.feed;
        return {
          providerId: 'xueqiu',
          sourceAccount: {
            externalId: `xueqiu:home:${feed}`,
            displayName: feed === 'livenews' ? '雪球7x24' : '雪球关注',
            profileUrl: 'https://xueqiu.com/',
            authMode: 'browser-session',
            metadata: {sourceInput},
          },
        };
      },
      async read(_sourceId, sourceInput) {
        const feed = sourceInput.feed;
        return {data: {mode: 'live', items: feed === 'livenews' ? [
          {externalId: 'live-old', sourceUrl: 'https://xueqiu.com/live/old', title: '较早快讯', body: '较早的一条快讯', summary: '较早的一条快讯', publishedAt: 1000},
          {externalId: 'live-new', sourceUrl: 'https://xueqiu.com/live/new', title: '较新快讯', body: '较新的一条快讯', summary: '较新的一条快讯', publishedAt: 3000},
        ] : [
          {externalId: 'post-1', sourceUrl: 'https://xueqiu.com/post/1', title: '完整讨论', body: '这是一篇更完整的讨论。', summary: '完整讨论', publishedAt: 2000},
        ]}};
      },
    },
    feedFilter: {async evaluate(input) { evaluated.push(input.item.externalId); return {action: 'keep', createContentItem: true, status: 'ready', metadata: {}}; }},
    flashSources: flash,
    onContentReady: async (input) => { ready.push(input.sourceIds); },
  });
  const flashStats = await service.refreshPersistedSource({sourceId: 'content.xueqiu.home', sourceInput: {feed: 'livenews'}});
  assert.equal(flashStats.added, 2);
  assert.deepEqual(flashStats.addedItemIds, []);
  assert.equal(flashStats.flash, true);
  assert.deepEqual(evaluated, []);
  assert.deepEqual(ready, []);
  const articleStats = await service.refreshPersistedSource({sourceId: 'content.xueqiu.home', sourceInput: {feed: 'following'}});
  assert.equal(articleStats.added, 1);
  assert.equal(articleStats.addedItemIds.length, 1);
  assert.deepEqual(evaluated, ['post-1']);
  assert.equal(ready.length, 1);

  const listed = service.listFlash('local', {limit: 50});
  assert.deepEqual(listed.map((row) => row.title), ['较新快讯', '较早快讯']);
  assert.equal(listed.every((row) => !('provider' in row) && !('model' in row)), true);
  assert.equal(listed[0].source, '雪球7x24');
  assert.equal(listed[0].sourceUrl, 'https://xueqiu.com/live/new');
  store.repositories.feed.upsertUserItemState({workspaceId: 'local', contentItemId: listed[0].id, isHidden: true});
  assert.deepEqual(service.listFlash('local').map((row) => row.title), ['较早快讯']);
});

test('flash ingest takes a leading bracket as the title and drops a body prefix', async () => {
  const store = createStore(':memory:');
  const bracketBody = '【央行】宣布降准五十个基点，并说明后续安排。';
  const plainBody = '这是一条没有括号的快讯正文，用来验证四十八字标题不会再写进标题栏。后面还有更多内容。';
  const service = createFeedService({
    legacyRepository: {},
    feedRepository: store.repositories.feed,
    sourcePort: {
      persistence() {
        return {
          providerId: 'xueqiu',
          sourceAccount: {
            externalId: 'xueqiu:home:livenews',
            displayName: '雪球7x24',
            profileUrl: 'https://xueqiu.com/',
            authMode: 'browser-session',
            metadata: { sourceInput: { feed: 'livenews' } },
          },
        };
      },
      async read() {
        return { data: { mode: 'live', items: [
          { externalId: 'live-bracket', sourceUrl: 'https://xueqiu.com/live/bracket', title: bracketBody.slice(0, 48), body: bracketBody, summary: bracketBody, publishedAt: 2000 },
          { externalId: 'live-plain', sourceUrl: 'https://xueqiu.com/live/plain', title: plainBody.slice(0, 48), body: plainBody, summary: plainBody.slice(0, 48), publishedAt: 1000 },
        ] } };
      },
    },
    flashSources: flash,
  });
  const stats = await service.refreshPersistedSource({ sourceId: 'content.xueqiu.home', sourceInput: { feed: 'livenews' } });
  assert.equal(stats.added, 2);
  const listed = service.listFlash('local', { limit: 10 });
  const bracket = listed.find((row) => row.sourceUrl.endsWith('/bracket'));
  const plain = listed.find((row) => row.sourceUrl.endsWith('/plain'));
  assert.equal(bracket.title, '央行');
  assert.equal(bracket.summary.includes('【央行】'), false);
  assert.equal(plain.title, '');
  assert.equal(plain.summary.startsWith('【'), false);
  store.close();
});

test('hourly candidates, preparation and reading classification skip flash sources', async () => {
  const calls = [];
  const store = createStore(':memory:');
  const tree = createInformationTreeService({
    repository: store.repositories.informationTree,
    reportRepository: store.repositories.report,
    agentRuntime: {async run(input) { calls.push(input.usageStage); return {answer: '{}'}; }},
    skills: loadInformationTreeSkills(),
    flashSources: flash,
    catalog: {tags: []},
  });
  const prepared = await tree.prepareInformation({materials: [
    {id: 'feed:flash', publisher: '雪球7x24', sourceId: 'xueqiu:home:livenews', publishedAt: 1000, version: '1', paragraphs: [{role: 'body', text: '快讯'}], sourceRefs: []},
  ]});
  assert.equal(calls.length, 0);
  assert.equal(prepared.calls, 0);
  assert.equal(prepared.nodes.length, 0);
  assert.equal(prepared.pending[0].reason, 'flash-source');
  assert.equal(prepared.pending[0].retryable, false);
  assert.equal(isTerminalPendingReason('flash-source'), true);

  const port = createTreeMaterialPort({
    flashSources: flash,
    feedService: {
      listContentItemsInWindow() {
        return [
          {id: 'feed:flash', sourceExternalId: 'xueqiu:home:livenews', sourceName: '雪球7x24', eventAt: 1},
          {id: 'feed:article', sourceExternalId: 'xueqiu:home:following', sourceName: '雪球关注', eventAt: 2},
        ];
      },
    },
    mediaService: {informationCandidates: () => [{id: 'media:short', sourceKey: 'chinaiol', publisher: '产业在线快讯'}]},
  });
  const candidates = await port.candidates('local', {startAt: 0, endAt: 10});
  assert.deepEqual(candidates.map((row) => row.id), ['feed:article']);

  const readingCalls = [];
  const reading = createReadingHourService({
    enabled: true,
    flashSources: flash,
    env: {AI_CENTER_READING_CLASS_BATCH: '1'},
    agentRuntime: {async run() { readingCalls.push('run'); return {answer: '{"primaryDirection":"finance","subjectKind":"company_event","domainTagIds":[],"classificationStatus":"classified","evidenceQuote":"订单"}'}; }},
    repository: {
      listInformationInWindow() {
        return [
          {id: 'n-flash', publisher: '产业在线快讯', sourceId: 'chinaiol:flash', title: '快讯', text: '短讯', sourceRefs: [{type: 'content-item', id: 'item-flash'}]},
          {id: 'n-article', publisher: '雪球关注', sourceId: 'feed:article', title: '公司拿到新订单', text: '订单金额已经公布。', sourceRefs: [{type: 'content-item', id: 'item-article'}]},
        ];
      },
      publishReadingHour(_workspace, snapshot) { return snapshot; },
    },
    feedRepository: {
      listItemSources() {
        return [
          {id: 'item-flash', externalId: 'chinaiol:flash', displayName: '产业在线快讯'},
          {id: 'item-article', externalId: 'xueqiu:home:following', displayName: '雪球关注'},
        ];
      },
    },
  });
  const scored = await reading.scoreWindow({window: {startAt: 10, endAt: 20}});
  assert.equal(readingCalls.length, 1);
  assert.deepEqual(scored.items.map((item) => item.sourceId), ['feed:article']);

  const onlyFlash = createReadingHourService({
    enabled: true,
    flashSources: flash,
    agentRuntime: {async run() { throw new Error('model should not run'); }},
    repository: {listInformationInWindow: () => [{id: 'n', publisher: '雪球7x24', sourceId: 'xueqiu:home:livenews', title: '快讯', sourceRefs: []}]},
  });
  assert.deepEqual(await onlyFlash.scoreWindow({window: {startAt: 10, endAt: 20}}), {published: false, reason: 'empty'});
});

test('media enrich still fetches flash bodies and does not queue a model', async () => {
  const fetched = [];
  const tagged = [];
  const jobs = [];
  const handlers = createMediaEnrichJobHandlers({
    treeEnabled: true,
    mediaService: {
      discoverOriginals: () => ({added: 0}),
      selectBodyCandidates: () => [],
      listBodyCandidates: () => ['flash-1', 'full-1'],
      flashExternalIds: (_workspace, ids) => ids.filter((id) => id === 'flash-1'),
      async fetchBodies({externalIds}) {
        fetched.push(...externalIds);
        return {fetched: externalIds.map((id) => ({externalId: id, contentLevel: 'full', skipped: true, health: 'ready'})), stats: {}, health: 'ready'};
      },
      listEnrichmentItems: (_workspace, _limit, ids) => ids.map((id) => ({
        externalId: id, resourceId: `media:${id}`, contentLevel: 'full', text: '', bodyObservedAt: 1, source: '', author: '', title: id, summary: '', body: '',
      })),
      listArticleTranslationUnits: () => [],
    },
    feedService: {async localizeTexts() { throw new Error('translation should not run'); }},
    taggingService: {
      listTaggings: () => [],
      async analyzeItems({items}) {
        tagged.push(...items.map((item) => item.id));
        return {saved: [], skipped: items.length, missingItemIds: []};
      },
    },
  });
  await handlers['media.index.enrich']({}, {store: {createJob(input) { jobs.push(input); return {id: 'job'}; }}});
  assert.deepEqual(fetched, ['flash-1', 'full-1']);
  assert.equal(jobs.some((job) => String(job.input.sourceIds).includes('flash')), false);
  assert.equal(jobs.some((job) => job.input.sourceIds.includes('media:full-1')), true);
  assert.deepEqual([...new Set(tagged)], ['media:full-1']);
});

test('the feed tab reuses the shared news list for flash items', () => {
  const app = fs.readFileSync('apps/web/public/app.js', 'utf8');
  const mock = fs.readFileSync('apps/web/public/mock.js', 'utf8');
  const html = fs.readFileSync('apps/web/public/index.html', 'utf8');
  const whitelist = fs.readFileSync('apps/web/src/http/static-files.js', 'utf8');
  assert.match(mock, /id: 'flash', label: '快讯'/);
  assert.match(app, /from '\.\/news-list\.js\?v=dev'/);
  assert.match(app, /\/api\/v1\/feed\/flash\?limit=80/);
  assert.match(app, /renderNewsList\(host, items\.map/);
  assert.match(app, /state\.channel === 'flash'/);
  assert.match(html, /app\.js\?v=dev/);
  assert.match(html, /mock\.js\?v=dev/);
  assert.match(html, /news-list\.js\?v=dev/);
  assert.match(whitelist, /'\/app\.js'/);
  assert.match(whitelist, /'\/mock\.js'/);
  assert.match(whitelist, /'\/news-list\.js'/);
});
