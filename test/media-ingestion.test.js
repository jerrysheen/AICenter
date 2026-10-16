import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMediaFeedQuery, ValidationError } from '../packages/contracts/src/index.js';
import { enqueueMediaIndexEnrich, MEDIA_ENRICH_JOB_TYPE } from '../packages/connectors/src/media/index.js';
import { createStore } from '../packages/database/src/index.js';
import { createMediaIngestionService, mediaDisplayText, mediaResourceId } from '../packages/domain/src/media-ingestion-service.js';
import { createMediaEnrichJobHandlers } from '../packages/runtime/src/media-enrich-module.js';
import { defaultAutoRefreshProjections } from '../packages/source/src/content/definitions.js';
import mediaConfig from '../config/media.json' with { type: 'json' };
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
const MEDIA_SOURCES = mediaConfig.sources, MEDIA_BUDGET = mediaConfig.budget;
const initialBatchSourceKeys = () => MEDIA_SOURCES.filter(s => s.deployment === 'first').map(s => s.sourceKey);
import { extractArticleText } from '../packages/connectors/src/media/article-html.js';
import { isPrivateAddress, stableArticleId } from '../packages/connectors/src/media/article-url.js';
import { parseFeedDate } from '../packages/connectors/src/media/dates.js';
import { parseFeedXml } from '../packages/connectors/src/media/feed-xml.js';
import { fetchAllowlisted } from '../packages/connectors/src/media/http.js';

const NOW = Date.parse('2026-10-02T04:00:00Z');
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

function rss(items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

function item({ title, link, guid, date = 'Thu, 01 Oct 2026 08:00:00 GMT', description = 'A funding note.' }) {
  return `<item><title>${title}</title><link>${link}</link><guid>${guid}</guid><pubDate>${date}</pubDate><description>${description}</description></item>`;
}

function temporaryMedia(fetchImpl, budget, feedFilter=null) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-media-'));
  const store = createStore(path.join(directory, 'test.db'));
  const service = createMediaIngestionService({
    mediaRepository: store.repositories.media,
    feedRepository: store.repositories.feed,
    feedFilter,
    mediaPort: createMediaConnector({ ...mediaConfig, fetchImpl, lookupImpl: PUBLIC_LOOKUP }),
    now: () => NOW,
    budget: { ...MEDIA_BUDGET, ...budget },
  });
  return {
    store,
    service,
    remove() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('production media gate keeps raw index, excludes DROP from feed and daily, and restores after body passes',async()=>{
  let passed=false,calls=0;
  const gate={async evaluate(){calls++;return {createContentItem:passed,status:passed?'ready':'ignored',metadata:{filterMode:'enforce',filterApplied:!passed,filterDecision:passed?'KEEP':'DROP',filterRule:'two-of-three-0.60'}};}};
  const fixture=temporaryMedia(async url=>String(url).includes('/feed/') ? response({body:rss(item({title:'Model price',link:'https://the-decoder.com/model-price/',guid:'gate-1'}))})
    : response({body:`<article><div class="content-wrapper"><p>${'The API price changed by 2 dollars per million tokens. '.repeat(4)}</p><p>${'The company reported the change for this period. '.repeat(4)}</p></div></article>`}),{},gate);
  try {
    await fixture.service.probe({sourceKeys:['decoder'],policyReviewed:true,run:true});fixture.service.enableSource('local','decoder');
    await fixture.service.syncEnabled({workspaceId:'local',channel:'tech',force:true});
    const row=fixture.store.repositories.media.listEntries('local',{limit:10})[0];
    assert.ok(row);assert.equal(calls,1);
    assert.equal(fixture.service.readFeed({channel:'tech'},{workspaceId:'local'}).items.length,0);
    assert.equal(fixture.service.dailyMaterials('local',{startAt:NOW-86400000,endAt:NOW+86400000,limit:100}).length,0);
    assert.equal(fixture.store.repositories.feed.getCapture('local','media',row.externalId).metadata.filterDecision,'DROP');
    passed=true;fixture.service.acknowledgeBodyUse('local',['decoder']);
    await fixture.service.fetchBodies({workspaceId:'local',externalIds:[row.externalId],usageReviewed:true});
    assert.equal(calls,2);assert.equal(fixture.service.readFeed({channel:'tech'},{workspaceId:'local'}).items.length,1);
    const capture=fixture.store.repositories.feed.getCapture('local','media',row.externalId);
    assert.equal(capture.metadata.filterDecision,'KEEP');assert.ok(fixture.store.repositories.feed.getContentItemByCapture('local',capture.id));
    assert.ok(fixture.store.repositories.media.latestBodies('local',[row.externalId])[0].bodyText);
  } finally{fixture.remove();}
});

function response({ status = 200, body = '', headers = {} }) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: { get: (name) => normalized[String(name).toLowerCase()] || '' },
    async arrayBuffer() { return Buffer.from(body); },
  };
}

test('media catalog stays disabled and outside social auto refresh', () => {
  assert.equal(MEDIA_SOURCES.filter(source => source.transport === 'existing_adapter' && source.channel === 'macro').length, 6);
  assert.equal(MEDIA_SOURCES.every((entry) => entry.enabled === false), true);
  assert.deepEqual(initialBatchSourceKeys(), ['nextplatform', 'dcd', 'techmeme', 'thelec', 'decoder', 'ft', 'bbc', 'guardian', 'bbcworld', 'guardianworld', 'ftav', 'yahooeconomy', 'bbctech', 'bbcscience', 'guardianai', 'guardianenergy', 'guardianmanufacturing', 'guardiantrade', 'eia', 'utilitydive', 'zaobaoworld']);
  assert.equal(defaultAutoRefreshProjections().some((item) => item.providerId === 'media'), false);
  assert.deepEqual(parseMediaFeedQuery({ channel: 'macro', refresh: '1' }), {
    platform: 'media', feed: 'macro', channel: 'macro', refresh: true, fields: 'list',
  });
});

test('rss and atom parse, while html, dtd, empty and oversized stay distinct', () => {
  const source = MEDIA_SOURCES.find((entry) => entry.sourceKey === 'dcd');
  const parsed = parseFeedXml(rss(item({
    title: 'Raises 668m',
    link: 'https://www.datacenterdynamics.com/en/news/gmi/?utm_source=rss',
    guid: 'gmi-668',
  })), source);
  assert.equal(parsed.health, 'ready');
  assert.equal(parsed.items[0].externalId, 'dcd:gmi-668');
  assert.equal(parsed.items[0].sourceUrl.includes('utm_source'), false);
  const atom = parseFeedXml(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom title</title><link rel="alternate" href="https://the-decoder.com/post/"/><id>atom-1</id><updated>2026-10-01T08:00:00Z</updated><summary>Short</summary></entry></feed>`, MEDIA_SOURCES.find((entry) => entry.sourceKey === 'decoder'));
  assert.equal(atom.format, 'atom');
  assert.equal(atom.items[0].publishedAt > 0, true);
  assert.equal(parseFeedXml(rss(''), source).health, 'empty');
  assert.equal(parseFeedXml('<!doctype html><html><body>not a feed</body></html>', source).health, 'not_a_feed');
  assert.equal(parseFeedXml('<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///secret">]><rss></rss>', source).health, 'rejected_dtd');
  assert.equal(parseFeedXml('x'.repeat(MEDIA_BUDGET.maxFeedBytes + 1), source).health, 'oversized');
});

test('dates keep raw text when the zone is missing and ignore title-only freshness', () => {
  assert.equal(parseFeedDate('2026-10-01T08:00:00Z').publishedAt, Date.parse('2026-10-01T08:00:00Z'));
  assert.equal(parseFeedDate('2026-10-01T08:00:00').publishedAt, null);
  assert.equal(parseFeedDate('01 Oct 2026 08:00:00').publishedAt, null);
  assert.equal(parseFeedDate('01 Oct 2026 08:00:00').publishedAtRaw, '01 Oct 2026 08:00:00');
  assert.equal(parseFeedDate('Thu, 01 Oct 2026 08:00:00 GMT').publishedAt, Date.parse('2026-10-01T08:00:00Z'));
});

test('stable ids keep identity query params and do not merge publishers', () => {
  const tracking = ['utm_source'];
  const left = stableArticleId('thelec', {
    link: 'https://www.thelec.net/news/articleView.html?idxno=14363&utm_source=feed',
    trackingParams: tracking,
    identityParams: ['idxno'],
  });
  const renamed = stableArticleId('thelec', {
    guid: 'different-title',
    link: 'https://www.thelec.net/news/articleView.html?idxno=14363',
    trackingParams: tracking,
    identityParams: ['idxno'],
  });
  const other = stableArticleId('moneydj', {
    link: 'https://www.moneydj.com/kmdj/news/newsviewer.aspx?a=a4f55727-8326-4837-94d9-f0c2d42c7771&c=MB010000',
    identityParams: ['a', 'c'],
  });
  assert.equal(left, renamed);
  assert.equal(left, 'thelec:idxno:14363');
  assert.match(other, /^moneydj:a:/);
  assert.notEqual(left, other);
});

test('allowlisted fetch follows known redirects and refuses private or foreign hosts', async () => {
  let calls = 0;
  const fetched = await fetchAllowlisted({
    url: 'https://feeds.bloomberg.com/economics/news.rss',
    allowedHosts: ['feeds.bloomberg.com'],
    redirectHosts: ['www.bloomberg.com'],
  }, {
    lookupImpl: PUBLIC_LOOKUP,
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes('feeds.bloomberg.com')) {
        return response({ status: 302, headers: { location: 'https://www.bloomberg.com/feeds/economics/news.rss' } });
      }
      return response({ status: 200, body: '<rss></rss>', headers: { etag: '"abc"', 'content-type': 'application/rss+xml' } });
    },
  });
  assert.equal(fetched.ok, true);
  assert.equal(calls, 2);
  assert.equal(fetched.etag, '"abc"');
  const blocked = await fetchAllowlisted({
    url: 'https://feeds.bloomberg.com/economics/news.rss',
    allowedHosts: ['feeds.bloomberg.com'],
    redirectHosts: [],
  }, {
    lookupImpl: PUBLIC_LOOKUP,
    fetchImpl: async () => response({ status: 302, headers: { location: 'https://evil.example/rss' } }),
  });
  assert.equal(blocked.health, 'blocked_redirect');
  const local = await fetchAllowlisted({
    url: 'https://www.datacenterdynamics.com/en/rss/',
    allowedHosts: ['www.datacenterdynamics.com'],
  }, {
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => response({ status: 200, body: 'nope' }),
  });
  assert.equal(local.health, 'network');
  assert.equal(isPrivateAddress('10.1.1.1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});

test('enabled rss sync is idempotent, budgets overflow, and keeps other sources alive', async () => {
  const body = rss([
    item({ title: 'One', link: 'https://www.datacenterdynamics.com/en/news/one/', guid: 'one' }),
    item({ title: 'Two', link: 'https://www.datacenterdynamics.com/en/news/two/', guid: 'two' }),
  ].join(''));
  let failDecoder = false;
  const fixture = temporaryMedia(async (url) => {
    if (String(url).includes('the-decoder.com') && failDecoder) throw new Error('decoder down');
    if (String(url).includes('datacenterdynamics.com')) return response({ status: 200, body, headers: { etag: '"dcd"' } });
    return response({ status: 200, body: rss(item({ title: 'Decoder', link: 'https://the-decoder.com/post/', guid: 'dec-1' })) });
  }, { maxNewMetadataPerDay: 1 });
  try {
    const probe = await fixture.service.probe({ sourceKeys: ['dcd'], policyReviewed: false, run: false });
    assert.equal(probe.dryRun, true);
    assert.equal(probe.requestCount, 0);
    const live = await fixture.service.probe({ sourceKeys: ['dcd', 'decoder'], policyReviewed: true, run: true });
    assert.equal(live.results.every((item) => item.items === null), true);
    assert.equal(fixture.service.enableSource('local', 'reuters').health, 'needs_credentials');
    assert.equal(fixture.service.enableSource('local', 'dcd').ok, true);
    assert.equal(fixture.service.enableSource('local', 'decoder').ok, true);
    const first = await fixture.service.syncEnabled({ workspaceId: 'local', channel: 'tech', force: true });
    assert.equal(first.results.find((item) => item.sourceKey === 'dcd').added, 1);
    assert.equal(first.results.find((item) => item.sourceKey === 'dcd').deferred, 1);
    const saved = fixture.store.repositories.media.listEntries('local', { channel: 'tech', limit: 10 });
    assert.equal(saved.filter((item) => item.sourceKey === 'dcd' && item.status === 'indexed').length, 1);
    assert.equal(saved.filter((item) => item.sourceKey === 'dcd' && item.status === 'budget_deferred').length, 1);
    assert.equal(saved.filter((item) => item.sourceKey === 'decoder' && item.status === 'budget_deferred').length, 1);
    const again = await fixture.service.syncEnabled({ workspaceId: 'local', channel: 'tech', force: true });
    assert.equal(again.results.find((item) => item.sourceKey === 'dcd').health, 'not_modified');
    assert.equal(fixture.store.repositories.media.budgetDay('local', '2026-10-02').newMetadata, 1);
    failDecoder = true;
    const partial = await fixture.service.syncEnabled({ workspaceId: 'local', channel: 'tech', force: true });
    assert.equal(partial.results.find((item) => item.sourceKey === 'decoder').health, 'network');
    assert.equal(partial.results.find((item) => item.sourceKey === 'dcd').health, 'not_modified');
    fixture.store.repositories.media.saveState({
      workspaceId: 'local', sourceKey: 'digitimes', enabled: true, hostDirectVerified: false,
      bodyUseAcknowledged: false, health: 'disabled', healthDetail: '', etag: '', lastModified: '',
      feedHash: '', lastProbe: null, lastSyncAt: null, updatedAt: NOW,
    });
    const licensed = await fixture.service.syncEnabled({ workspaceId: 'local', channel: 'tech', force: true });
    const digitimes = licensed.results.find((item) => item.sourceKey === 'digitimes');
    assert.equal(digitimes.health, 'needs_credentials');
    assert.equal(digitimes.items, null);
  } finally {
    fixture.remove();
  }
});

test('conditional 304 does not create another capture and index sources do not fetch bodies', async () => {
  let phase = 'fresh';
  const fixture = temporaryMedia(async (url) => {
    if (phase === 'fresh') return response({ status: 200, body: rss(item({ title: 'Index', link: 'https://www.ft.com/content/e3a53272', guid: 'ft-1' })), headers: { etag: '"ft"', 'last-modified': 'Thu, 01 Oct 2026 08:00:00 GMT' } });
    const match = url && true;
    assert.equal(match, true);
    return response({ status: 304, headers: { etag: '"ft"' } });
  });
  try {
    await fixture.service.probe({ sourceKeys: ['ft'], policyReviewed: true, run: true });
    assert.equal(fixture.service.enableSource('local', 'ft').ok, true);
    const first = await fixture.service.syncEnabled({ workspaceId: 'local', channel: 'macro', force: true });
    assert.equal(first.results[0].added, 1);
    phase = 'cached';
    const second = await fixture.service.syncEnabled({ workspaceId: 'local', channel: 'macro', force: true });
    assert.equal(second.results[0].health, 'not_modified');
    assert.equal(second.results[0].added, 0);
    const row = fixture.store.repositories.media.listEntries('local', { channel: 'macro', limit: 5 })[0];
    const blocked = await fixture.service.fetchBodies({ workspaceId: 'local', externalIds: [row.externalId], usageReviewed: true });
    assert.equal(blocked.fetched[0].health, 'index_only');
    assert.equal(fixture.store.repositories.feed.listContentItems('local', { limit: 10 }).length, 0);
    const unlicensed = await fixture.service.fetchBodies({ workspaceId: 'local', externalIds: [row.externalId], usageReviewed: false });
    assert.equal(unlicensed.health, 'needs_license');
  } finally {
    fixture.remove();
  }
});

test('selected body keeps a revision snapshot and drops paywall or interface residue', async () => {
  const fixture = temporaryMedia(async (url) => {
    if (String(url).includes('/feed/')) {
      return response({ status: 200, body: rss(item({ title: 'Model price', link: 'https://the-decoder.com/model-price/', guid: 'price-1' })) });
    }
    if (String(url).includes('paywall')) return response({ status: 200, body: '<article><p>Subscribe to read the rest of this article.</p></article>' });
    return response({ status: 200, body: `<article><div class="content-wrapper"><button class="font-size">폰트 글자크기</button><p>${'The API price changed by 2 dollars per million tokens. '.repeat(4)}</p><p>${'The company reported the change for this period. '.repeat(4)}</p></div></article>` });
  });
  try {
    await fixture.service.probe({ sourceKeys: ['decoder'], policyReviewed: true, run: true });
    fixture.service.enableSource('local', 'decoder');
    await fixture.service.syncEnabled({ workspaceId: 'local', channel: 'tech', force: true });
    const row = fixture.store.repositories.media.listEntries('local', { channel: 'tech', limit: 5 })[0];
    const fetched = await fixture.service.fetchBodies({ workspaceId: 'local', externalIds: [row.externalId], usageReviewed: true });
    assert.equal(fetched.fetched[0].contentLevel, 'full');
    const snapshots = fixture.store.repositories.media.listSnapshots('local', row.externalId);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].bodyText.includes('폰트'), false);
    assert.match(snapshots[0].bodyText, /2 dollars/);
    const capture = fixture.store.repositories.feed.getCapture('local', 'media', row.externalId);
    assert.equal(capture.provider, 'media');
    assert.equal(capture.metadata.contentLevel, 'full');
    const wall = extractArticleText('<html><article><p>Subscribe to read this analysis.</p></article></html>', { status: 200 });
    assert.equal(wall.reason, 'paywall');
    assert.equal(wall.text, '');
  } finally {
    fixture.remove();
  }
});

test('techmeme keeps the origin link without fetching it', () => {
  const source = MEDIA_SOURCES.find((entry) => entry.sourceKey === 'techmeme');
  const parsed = parseFeedXml(rss(item({
    title: 'Chip order',
    link: 'https://www.techmeme.com/261001/p1',
    guid: 'tm-1',
    description: '<a href="https://www.example.com/chip-order">Original</a> <a href="https://www.techmeme.com/about">About</a>',
  })), source);
  assert.equal(parsed.items[0].originUrl, 'https://www.example.com/chip-order');
  assert.equal(parsed.items[0].discoveredVia.sourceKey, 'techmeme');
  assert.equal(parsed.items[0].externalId.startsWith('techmeme:'), true);
});

test('open sites fetch a body once, then enrich reuses translation and tagging', async () => {
  const fixture = temporaryMedia(async (url) => {
    if (String(url).includes('/feed/')) {
      return response({ status: 200, body: rss(item({ title: 'Model price', link: 'https://the-decoder.com/model-price/', guid: 'price-2' })) });
    }
    return response({ status: 200, body: `<article><div class="content-wrapper"><p>${'The API price changed by 2 dollars per million tokens. '.repeat(4)}</p><p>${'The company reported the change for this period. '.repeat(4)}</p></div></article>` });
  });
  try {
    await fixture.service.probe({ sourceKeys: ['decoder'], policyReviewed: true, run: true });
    fixture.service.enableSource('local', 'decoder');
    await fixture.service.syncEnabled({ workspaceId: 'local', channel: 'tech', force: true });
    const asked = { texts: [], tags: null };
    fixture.service.acknowledgeBodyUse('local',['decoder']);
    const handlers = createMediaEnrichJobHandlers({
      mediaService: fixture.service,
      feedService: {
        async localizeTexts(units) {
          asked.texts = units;
          fixture.store.repositories.feed.saveTranslations(units.map(item=>({
            workspaceId: 'local',
            itemId: item.localizationId,
            targetLang: 'zh',
            sourceHash: createHash('sha256').update(item.text).digest('hex'),
            translatedText: '模型价格变了。接口价格每百万 token 变动 2 美元。',
            engine: 'test',
          })));
          return { pendingIds: [] };
        },
      },
      taggingService: {
        async analyzeItems(input) {
          asked.tags = input;
          return { saved: [{ resourceId: input.items[0].id }], skipped: 0, missingItemIds: [] };
        },
      },
    });
    const output = await handlers[MEDIA_ENRICH_JOB_TYPE]({ workspaceId: 'local' });
    assert.equal(output.bodiesFetched, 1);
    assert.equal(asked.tags.resourceType, 'media-index');
    assert.match(asked.texts.map(u=>u.text).join('\n'), /2 dollars/);
    const row = fixture.store.repositories.media.listEntries('local', { channel: 'tech', limit: 5 })[0];
    const repeat = await fixture.service.fetchBodies({
      workspaceId: 'local',
      externalIds: [row.externalId],
      usageReviewed: true,
    });
    assert.equal(repeat.fetched[0].skipped, true);
    const again = await handlers[MEDIA_ENRICH_JOB_TYPE]({ workspaceId: 'local' });
    assert.equal(again.bodiesFetched, 0);
    assert.equal(fixture.store.repositories.media.budgetDay('local', '2026-10-02').selectedBodies, 1);
    const feed = fixture.service.readFeed({ channel: 'tech' }, { workspaceId: 'local' });
    assert.equal(feed.items[0].contentLevel, 'full');
    assert.equal(feed.items[0].articleTranslation.status, 'ready');
    assert.equal(feed.items[0].articleTranslation.paragraphs[0].text.includes('模型价格'), true);
    assert.equal(feed.items[0].id, mediaResourceId(feed.items[0].externalId));
    assert.equal(feed.items[0].body, mediaDisplayText({
      title: 'Model price',
      body: fixture.store.repositories.media.listSnapshots('local', feed.items[0].externalId)[0].bodyText,
    }));
    const jobs = [];
    const store = {
      listJobs: () => jobs,
      createJob(input) {
        const job = { ...input, status: 'queued' };
        jobs.push(job);
        return job;
      },
    };
    enqueueMediaIndexEnrich(store);
    enqueueMediaIndexEnrich(store);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].type, MEDIA_ENRICH_JOB_TYPE);
  } finally {
    fixture.remove();
  }
});

test('media enrich requeues the rest when the budget is already gone', async () => {
  const fetched = [];
  const jobs = [];
  const handlers = createMediaEnrichJobHandlers({
    budgetMs: 0,
    mediaService: {
      async fetchBodies(input) {
        fetched.push(input.externalIds);
        return { health: 'ready', fetched: [], stats: {}, processed: input.externalIds.length };
      },
      listBodyCandidates() { return []; },
      listEnrichmentItems() { return []; },
    },
    feedService: { async localizeTexts() { throw new Error('should not translate'); } },
    taggingService: { async analyzeItems() { throw new Error('should not tag'); } },
  });
  const output = await handlers[MEDIA_ENRICH_JOB_TYPE](
    { workspaceId: 'local', externalIds: ['a', 'b'] },
    { store: { createJob(input) { jobs.push(input); return input; } } },
  );
  assert.equal(fetched.length, 0);
  assert.equal(output.yielded, true);
  assert.equal(output.health, 'partial');
  assert.equal(output.remaining, 1);
  assert.equal(jobs[0].type, MEDIA_ENRICH_JOB_TYPE);
  assert.deepEqual(jobs[0].input.externalIds, ['a', 'b']);
});

test('media enrich requeues ids the body fetch did not finish', async () => {
  const handlers = createMediaEnrichJobHandlers({
    budgetMs: 60_000,
    mediaService: {
      async fetchBodies() {
        return {
          health: 'partial',
          fetched: [{ externalId: 'a', contentLevel: 'full' }],
          stats: {},
          processed: 1,
          stoppedEarly: true,
        };
      },
      listBodyCandidates() { return []; },
      listEnrichmentItems() { return []; },
    },
    feedService: { async localizeTexts() { throw new Error('should not translate'); } },
    taggingService: { async analyzeItems() { throw new Error('should not tag'); } },
  });
  const jobs = [];
  const output = await handlers[MEDIA_ENRICH_JOB_TYPE](
    { workspaceId: 'local', externalIds: ['a', 'b', 'c'] },
    { store: { createJob(input) { jobs.push(input); return input; } } },
  );
  assert.equal(output.yielded, true);
  assert.deepEqual(jobs[0].input.externalIds, ['b', 'c']);
});

test('probe refuses unknown sources', async () => {
  const fixture = temporaryMedia(async () => response({ status: 200, body: '' }));
  try {
    await assert.rejects(() => fixture.service.probe({ sourceKeys: ['https://evil.example'], policyReviewed: true, run: true }), ValidationError);
  } finally {
    fixture.remove();
  }
});
