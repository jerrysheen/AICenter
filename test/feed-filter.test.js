import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStore } from '../packages/database/src/index.js';
import {
  buildFeedFilterQuestions,
  createFeedFilter,
  createFeedFilterFromEnv,
  decideFeedFilter,
  evaluateDeterministic,
  hasSubstantialText,
  parseFeedFilterAnswers,
  resolveFeedFilterConfig,
} from '../packages/domain/src/feed-filter.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';

const filterSource = readFileSync(new URL('../packages/domain/src/feed-filter.js', import.meta.url), 'utf8');

function temporaryStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-feed-filter-'));
  const databasePath = path.join(directory, 'test.db');
  return {
    directory,
    databasePath,
    store: createStore(databasePath),
    remove() { rmSync(directory, { recursive: true, force: true }); },
  };
}

function snapshotItem(overrides = {}) {
  return {
    externalId: 'tweet-1',
    title: '三星 NAND 报价上调 10%',
    body: '三星 NAND 报价上调 10%',
    summary: '三星 NAND 报价上调 10%',
    sourceUrl: 'https://x.com/user/status/tweet-1',
    authorName: 'user',
    publishedAt: 1,
    ...overrides,
  };
}

function feedSourcePort(items) {
  return {
    findByProvider(providerId) {
      return providerId === 'x' ? { id: 'content.x.test' } : null;
    },
    persistence() {
      return {
        providerId: 'x',
        sourceAccount: {
          externalId: 'x:home:for-you',
          displayName: 'X',
          profileUrl: 'https://x.com/home',
          authMode: 'browser-session',
        },
      };
    },
    async read() {
      return {
        data: {
          feed: 'for-you',
          mode: 'live',
          loggedIn: true,
          note: 'live',
          fetchedAt: Date.now(),
          items,
        },
      };
    },
  };
}

function ignoreAnswers() {
  return {
    is_information: { type: 'noul', noul: 0.05 },
    is_residue: { type: 'noul', noul: 0.95 },
    worth_keeping: { type: 'noul', noul: 0.04 },
  };
}

function keepAnswers() {
  return {
    is_information: { type: 'noul', noul: 0.92 },
    is_residue: { type: 'noul', noul: 0.08 },
    worth_keeping: { type: 'noul', noul: 0.88 },
  };
}

test('feed filter defaults to shadow and ignores Agent Quality disable', () => {
  assert.deepEqual(resolveFeedFilterConfig({}), { mode: 'shadow', version: 'feed-filter-v1' });
  assert.equal(resolveFeedFilterConfig({ AI_CENTER_FEED_FILTER: 'enforce' }).mode, 'enforce');
  assert.equal(resolveFeedFilterConfig({ AI_CENTER_FEED_FILTER: 'off' }).mode, 'off');
  assert.equal(resolveFeedFilterConfig({ AI_CENTER_JEV_DISABLED: '1' }).mode, 'shadow');
  assert.equal(createFeedFilterFromEnv({ env: { AI_CENTER_FEED_FILTER: 'off' } }), null);
  const filter = createFeedFilterFromEnv({
    env: { AI_CENTER_JEV_DISABLED: '1' },
    client: { available: () => false, evaluate: async () => { throw new Error('should not run'); } },
  });
  assert.equal(filter.config.mode, 'shadow');
});

test('deterministic filter drops empty, blank, and punctuation-only text without a length cutoff', () => {
  assert.equal(evaluateDeterministic({ item: snapshotItem({ title: '', body: '', summary: '' }) }).reason, 'empty');
  assert.equal(evaluateDeterministic({ item: snapshotItem({ title: '   ', body: '\n', summary: '\t' }) }).reason, 'empty');
  assert.equal(evaluateDeterministic({ item: snapshotItem({ title: '😂😂', body: '😂😂', summary: '…' }) }).reason, 'no-body');
  assert.equal(evaluateDeterministic({ item: snapshotItem({ title: '...', body: '!!!', summary: '—' }) }).reason, 'no-body');
  assert.equal(evaluateDeterministic({ item: snapshotItem({ title: 'NVDA +5%', body: 'NVDA +5%', summary: 'NVDA +5%' }) }), null);
  assert.equal(hasSubstantialText('NVDA +5%'), true);
  assert.equal(hasSubstantialText('三星 NAND 报价上调 10%'), true);
  assert.equal(hasSubstantialText('😂😂'), false);
  assert.equal(filterSource.includes('length < 20'), false);
  assert.equal(/char(acter)?s?\s*[<>=]=?\s*\d+/.test(filterSource), false);
  assert.equal(/trim\(\)\.length\s*[<>=]/.test(filterSource), false);
});

test('deterministic filter skips duplicate external id, content hash, and identity', () => {
  assert.equal(evaluateDeterministic({
    item: snapshotItem(),
    contentHash: 'hash-1',
    existingCapture: { id: 'cap-1', contentHash: 'hash-1', externalId: 'tweet-1' },
  }).reason, 'duplicate-external-id');
  assert.equal(evaluateDeterministic({
    item: snapshotItem({ externalId: 'tweet-2' }),
    contentHash: 'hash-1',
    existingByContentHash: { id: 'cap-1', contentHash: 'hash-1', externalId: 'tweet-1' },
  }).reason, 'duplicate-content-hash');
  assert.equal(evaluateDeterministic({
    item: snapshotItem({ externalId: 'tweet-3' }),
    contentHash: 'hash-3',
    hasIdentityFingerprint: true,
  }).reason, 'duplicate-identity');
  assert.equal(evaluateDeterministic({
    item: snapshotItem(),
    contentHash: 'hash-new',
    existingCapture: { id: 'cap-1', contentHash: 'hash-old', externalId: 'tweet-1' },
  }), null);
});

test('Jev only ignores high-confidence residue and fail-opens on missing scores', () => {
  assert.equal(decideFeedFilter(parseFeedFilterAnswers(ignoreAnswers())).keep, false);
  assert.equal(decideFeedFilter(parseFeedFilterAnswers(ignoreAnswers())).reason, 'high-confidence-residue');
  assert.equal(decideFeedFilter(parseFeedFilterAnswers(keepAnswers())).keep, true);
  assert.equal(decideFeedFilter({ is_information: 0.1, is_residue: 0.9 }).keep, true);
  assert.equal(decideFeedFilter({}).reason, 'scores-unavailable');
  assert.equal(decideFeedFilter(parseFeedFilterAnswers({
    is_information: { noul: 0.9 },
    is_residue: { noul: 0.1 },
    worth_keeping: { noul: 0.85 },
  })).keep, true);
  const questions = buildFeedFilterQuestions();
  assert.equal(questions.is_information.type, 'noul');
  assert.equal(questions.is_residue.type, 'noul');
  assert.equal(questions.worth_keeping.type, 'noul');
  assert.match(questions.worth_keeping.instructions, /Do not judge personal interest/);
});

test('emoji is deterministic residue and CTA ignore is a Jev decision', async () => {
  const calls = [];
  const filter = createFeedFilter({
    config: { mode: 'enforce', version: 'feed-filter-v1' },
    client: {
      available: () => true,
      async evaluate(payload) {
        calls.push(payload);
        return { model: 'jev-latest', answers: ignoreAnswers() };
      },
    },
  });
  const emoji = await filter.evaluate({ item: snapshotItem({ title: '😂😂', body: '😂😂', summary: '😂😂' }) });
  assert.equal(emoji.action, 'ignore');
  assert.equal(emoji.reason, 'no-body');
  assert.equal(emoji.stage, 'deterministic');
  assert.equal(calls.length, 0);

  const cta = await filter.evaluate({ item: snapshotItem({ title: '查看更多...', body: '查看更多...', summary: '查看更多...' }) });
  assert.equal(cta.action, 'ignore');
  assert.equal(cta.reason, 'high-confidence-residue');
  assert.equal(cta.stage, 'jev');
  assert.equal(calls.length, 1);
});

test('Jev timeout, bad JSON, and missing key fail open to KEEP', async () => {
  const timeoutFilter = createFeedFilter({
    config: { mode: 'enforce', version: 'feed-filter-v1' },
    client: {
      available: () => true,
      async evaluate() {
        const error = new Error('TypeSafe 请求超时（20ms）');
        error.code = 'TYPESAFE_TIMEOUT';
        throw error;
      },
    },
  });
  const timeout = await timeoutFilter.evaluate({ item: snapshotItem() });
  assert.equal(timeout.action, 'keep');
  assert.equal(timeout.failOpen, true);
  assert.equal(timeout.reason, 'TYPESAFE_TIMEOUT');

  const badJsonFilter = createFeedFilter({
    config: { mode: 'enforce', version: 'feed-filter-v1' },
    client: {
      available: () => true,
      async evaluate() {
        throw new Error('TypeSafe 没有返回 answers');
      },
    },
  });
  const badJson = await badJsonFilter.evaluate({ item: snapshotItem() });
  assert.equal(badJson.action, 'keep');
  assert.equal(badJson.failOpen, true);

  const missingKey = createFeedFilter({
    config: { mode: 'enforce', version: 'feed-filter-v1' },
    client: {
      available: () => false,
      async evaluate() { throw new Error('should not run'); },
    },
  });
  const unavailable = await missingKey.evaluate({ item: snapshotItem() });
  assert.equal(unavailable.action, 'keep');
  assert.equal(unavailable.reason, 'jev-unavailable');
  assert.equal(unavailable.createContentItem, true);
});

test('shadow still creates ContentItem when Jev would ignore', async () => {
  const temporary = temporaryStore();
  const items = [snapshotItem({
    externalId: 'cta-1',
    title: '查看更多...',
    body: '查看更多...',
    summary: '查看更多...',
    sourceUrl: 'https://x.com/user/status/cta-1',
  })];
  const service = createFeedService({
    legacyRepository: temporary.store,
    feedRepository: temporary.store.repositories.feed,
    sourcePort: feedSourcePort(items),
    feedFilter: createFeedFilter({
      config: { mode: 'shadow', version: 'feed-filter-v1' },
      client: {
        available: () => true,
        async evaluate() { return { model: 'jev-latest', answers: ignoreAnswers() }; },
      },
    }),
  });
  const feed = await service.getExternalFeed('x', { feed: 'for-you', refresh: true });
  assert.equal(feed.added, 1);
  assert.equal(feed.items.length, 1);
  const capture = temporary.store.repositories.feed.getCapture('local', 'x', 'cta-1');
  assert.equal(capture.status, 'ready');
  assert.equal(capture.metadata.wouldKeep, false);
  assert.equal(capture.metadata.wouldIgnore, true);
  assert.equal(capture.metadata.filterReason, 'high-confidence-residue');
  assert.equal(capture.metadata.filterVersion, 'feed-filter-v1');
  assert.equal(capture.metadata.evaluatorModel, 'jev-latest');
  assert.ok(temporary.store.repositories.feed.getContentItemByCapture('local', capture.id));
  temporary.store.close();
  temporary.remove();
});

test('enforce writes ignored Capture and does not create a ContentItem', async () => {
  const temporary = temporaryStore();
  const items = [snapshotItem({
    externalId: 'emoji-1',
    title: '😂😂',
    body: '😂😂',
    summary: '😂😂',
    sourceUrl: 'https://x.com/user/status/emoji-1',
  })];
  const service = createFeedService({
    legacyRepository: temporary.store,
    feedRepository: temporary.store.repositories.feed,
    sourcePort: feedSourcePort(items),
    feedFilter: createFeedFilter({
      config: { mode: 'enforce', version: 'feed-filter-v1' },
    }),
  });
  const feed = await service.getExternalFeed('x', { feed: 'for-you', refresh: true });
  assert.equal(feed.added, 0);
  assert.equal(feed.items.length, 0);
  const capture = temporary.store.repositories.feed.getCapture('local', 'x', 'emoji-1');
  assert.equal(capture.status, 'ignored');
  assert.equal(capture.externalId, 'emoji-1');
  assert.equal(capture.sourceUrl, 'https://x.com/user/status/emoji-1');
  assert.ok(capture.contentHash);
  assert.equal(capture.metadata.filterReason, 'no-body');
  assert.equal(temporary.store.repositories.feed.getContentItemByCapture('local', capture.id), null);
  assert.ok(temporary.store.repositories.feed.listCaptureExternalIds('local', 'x').includes('emoji-1'));
  temporary.store.close();
  temporary.remove();
});

test('short factual posts stay KEEP and repository can look up by content hash', async () => {
  const temporary = temporaryStore();
  const items = [snapshotItem({
    externalId: 'nvda-1',
    title: 'NVDA +5%',
    body: 'NVDA +5%',
    summary: 'NVDA +5%',
    sourceUrl: 'https://x.com/user/status/nvda-1',
  })];
  const service = createFeedService({
    legacyRepository: temporary.store,
    feedRepository: temporary.store.repositories.feed,
    sourcePort: feedSourcePort(items),
    feedFilter: createFeedFilter({
      config: { mode: 'enforce', version: 'feed-filter-v1' },
      client: {
        available: () => true,
        async evaluate() { return { model: 'jev-latest', answers: keepAnswers() }; },
      },
    }),
  });
  const feed = await service.getExternalFeed('x', { feed: 'for-you', refresh: true });
  assert.equal(feed.added, 1);
  assert.equal(feed.items[0].body, 'NVDA +5%');
  const capture = temporary.store.repositories.feed.getCapture('local', 'x', 'nvda-1');
  const hashed = createHash('sha256').update(`nvda-1\nNVDA +5%\nNVDA +5%`).digest('hex');
  assert.equal(capture.contentHash, hashed);
  assert.equal(temporary.store.repositories.feed.getCaptureByContentHash('local', 'x', hashed).id, capture.id);
  temporary.store.close();
  temporary.remove();
});

test('missing feedFilter keeps previous ingest behavior', async () => {
  const temporary = temporaryStore();
  const items = [snapshotItem({
    externalId: 'blank-1',
    title: '   ',
    body: '',
    summary: '',
    sourceUrl: 'https://x.com/user/status/blank-1',
  })];
  const service = createFeedService({
    legacyRepository: temporary.store,
    feedRepository: temporary.store.repositories.feed,
    sourcePort: feedSourcePort(items),
  });
  const feed = await service.getExternalFeed('x', { feed: 'for-you', refresh: true });
  assert.equal(feed.added, 1);
  assert.equal(feed.items.length, 1);
  temporary.store.close();
  temporary.remove();
});
